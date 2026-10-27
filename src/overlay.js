// overlay.js — M4 undo layer: per-run tracing paper over the real project.
// Writes land in a per-run upper (lower = project read-only); commit presses
// the merged view down, rollback drops the upper. Diff/commit walk the merged
// view with `/usr/bin/node` inside the mount (`overlay-walk.js`): the one
// walker reads project, upper and merged view alike — no shell here. Commit
// stages into a bound folder, then swaps by journaled rename (aside, rmdir,
// mkdir writable, move in, chmod last); failure undoes in reverse, reporting
// "nothing was applied" or the exact steps not undone (commit folder kept).
// Rollback reports diff's answer, or raw upper paths when the project is
// gone. Conflict rule (pinned): `(lower != base) && (merged != lower)`;
// Q3 ignores + `.sbx-commit-` are invisible to the whole layer.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, statSync,
  readFileSync, writeFileSync, rmSync, rmdirSync, chmodSync,
  readlinkSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentName } from './proxy.js';

/** One reviewed file change: what the sandbox did at `path`, and whether the project changed underneath it mid-run.
 *
 * @typedef {object} OverlayChange
 * @property {string} path project-relative path with `/` separators
 * @property {string} status `added` | `modified` | `deleted` (`unknown`: rollback's raw fallback, which infers nothing)
 * @property {boolean} conflict true when the project changed this path after the run started
 * @property {string|null} reason why `conflict` is set, or null when clean
 * @property {string} [type] merged-view kind: `f` file, `d` dir, `l` symlink (set unless deleted)
 * @property {number} [mode] merged-view permission bits (set unless deleted)
 * @property {string} [hash] sha256 of a merged-view regular file
 * @property {string} [target] symlink target of a merged-view symlink
 */

const MANIFEST_VERSION = 1;

/** Path segments invisible to the layer (Q3): never snapshotted, diffed, committed or deleted. */
export const DEFAULT_IGNORE = ['node_modules'];

/** First-segment prefix of one commit's staging folder: never walked; a leftover blocks the next operation. */
const COMMIT_PREFIX = '.sbx-commit-';

/** Refused commit: paths changed in the project mid-run. A conflict refusal is a phase-1 failure: nothing was applied — resolve and retry. */
export class OverlayConflictError extends Error {
  /** @param {{path: string, status: string, reason: string|null}[]} conflicts conflicting changes */
  constructor(conflicts) {
    super(`sbx commit refused: ${conflicts.length} file(s) changed in the project ` +
      `during the run: ${conflicts.map((c) => c.path).join(', ')} (nothing was applied)`);
    this.code = 'SBX_CONFLICT';
    /** @type {{path: string, status: string, reason: string|null}[]} */
    this.conflicts = conflicts;
  }
}

/** Reject a relpath that could escape the project (these strings feed host renames). */
function assertSafeRel(rel) {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new Error(`sbx: unsafe overlay path ${JSON.stringify(rel)}`);
  }
}

/** True when any `/`-separated segment of `rel` is ignored. */
function isIgnored(rel, ignore) {
  return rel.split('/').some((seg) => ignore.has(seg));
}

/** True when `rel` is inside one commit's staging folder (invisible, like ignored segments). */
function isCommitDir(rel) {
  const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
  return top.startsWith(COMMIT_PREFIX);
}

/** Fingerprint: type + content (hash/target) + mode. Equal iff the visible file is identical. */
function fpOf(e) {
  if (!e) return null;
  return `${e.type}:${e.hash ?? e.target ?? ''}:${e.mode.toString(8)}`;
}

function kindOf(st) {
  if (st.isFile()) return 'f';
  if (st.isDirectory()) return 'd';
  if (st.isSymbolicLink()) return 'l';
  if (st.isFIFO()) return 'p';
  if (st.isSocket()) return 's';
  if (st.isCharacterDevice()) return 'c';
  if (st.isBlockDevice()) return 'b';
  return '?';
}

/** The one walker: project, upper, merged view. Skips ignored/commit dirs (never descended); strict UTF-8 names (non-UTF-8 refused loudly); throws on unreadable entries.
 *
 * @param {string} root directory to walk
 * @param {Set<string>} ignore path segments invisible to the layer
 * @returns {Map<string, {type: string, mode: number, hash?: string, target?: string}>}
 */
export function walkLocal(root, ignore) {
  /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
  const out = new Map();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const stack = [''];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    const names = /** @type {Buffer[]} */ (/** @type {unknown} */ (readdirSync(join(root, dir), { encoding: 'buffer' })));
    for (const raw of names) {
      let name;
      try {
        name = utf8.decode(raw);
      } catch {
        throw new Error(`sbx: refusing non-UTF-8 filename in ${join(root, dir)} ` +
          `(bytes ${raw.toString('hex')}; rename it and retry)`);
      }
      const rel = dir ? `${dir}/${name}` : name;
      if (isIgnored(rel, ignore) || isCommitDir(rel)) continue;
      const st = lstatSync(join(root, rel));
      const type = kindOf(st);
      if (type === 'd') {
        out.set(rel, { type, mode: st.mode & 0o7777 });
        stack.push(rel);
      } else if (type === 'f') {
        out.set(rel, {
          type, mode: st.mode & 0o7777,
          hash: createHash('sha256').update(readFileSync(join(root, rel))).digest('hex'),
        });
      } else if (type === 'l') {
        out.set(rel, { type, mode: st.mode & 0o7777, target: readlinkSync(join(root, rel)) });
      } else {
        out.set(rel, { type, mode: st.mode & 0o7777 });
      }
    }
  }
  return out;
}

function conflictReason(status, inBase) {
  if (status === 'modified') return 'changed in the project during the run';
  if (status === 'added') return 'deleted in the project during the run';
  return inBase
    ? 'changed in the project during the run, deleted in the sandbox'
    : 'created in the project during the run, deleted in the sandbox';
}

/** Union-compare base snapshot, project, and merged view into sorted changes; `merged == lower` is no change. */
function computeChanges(base, lower, merged) {
  /** @type {OverlayChange[]} */
  const changes = [];
  const rels = new Set([...base.keys(), ...lower.keys(), ...merged.keys()]);
  for (const rel of rels) {
    const m = merged.get(rel);
    const l = lower.get(rel);
    if (fpOf(m) === fpOf(l)) continue;
    const status = !m ? 'deleted' : !l ? 'added' : 'modified';
    const conflict = fpOf(l) !== (base.get(rel) ?? null);
    changes.push({
      path: rel, status, conflict,
      reason: conflict ? conflictReason(status, base.has(rel)) : null,
      ...(m ? { type: m.type, mode: m.mode, hash: m.hash, target: m.target } : {}),
    });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

// --- overlay record (upper + work + run-start snapshot) ---------------------

function overlayPaths(runtime, agent) {
  const base = join(runtime, 'overlay', agent);
  return { base, upper: join(base, 'upper'), work: join(base, 'work'), manifest: join(base, 'manifest.json') };
}

/** One commit's staging folder, or null. A leftover blocks diff/commit/setup until removed. */
function findCommitDir(proj) {
  let names;
  try {
    names = readdirSync(proj);
  } catch {
    return null;
  }
  const hit = names.filter((n) => n.startsWith(COMMIT_PREFIX)).sort()[0];
  return hit ? join(proj, hit) : null;
}

/** Refuse when a killed commit's folder is still in the project; names its path. */
function refuseLeftover(proj, op) {
  const leftover = findCommitDir(proj);
  if (leftover) {
    throw new Error(`sbx: unfinished commit at ${leftover} blocks ${op} (a killed commit left it; remove it and retry)`);
  }
}

/** Empty a dir, tolerating mode-000 debris and whiteout orphans (chmod-then-rm, never following symlinks). */
function chmodTree(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
  if (st.isDirectory()) {
    for (const n of readdirSync(p)) chmodTree(join(p, n));
  }
}

function emptyDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') continue;
      chmodTree(p);
      rmSync(p, { recursive: true, force: true });
    }
  }
}

/** Read and validate the overlay record: missing reads as no-overlay, garbage as corrupt. */
function readRecord(manifest, runtime, agent) {
  let text;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch {
    throw noOverlayError(runtime, agent);
  }
  let m = null;
  try {
    m = JSON.parse(text);
  } catch {
    m = null;
  }
  if (!m || m.version !== MANIFEST_VERSION || typeof m.proj !== 'string' || typeof m.base !== 'object' || !m.base) {
    throw new Error(`sbx: overlay record for agent '${agent}' is corrupt (${manifest}); remove it and retry`);
  }
  return m;
}

/** Prepare a fresh upper: refuse leftovers, snapshot the project as the conflict baseline. An empty upper re-snapshots. */
export function setupOverlay({ runtime, agent, proj, ignore = DEFAULT_IGNORE }) {
  for (const [k, v] of Object.entries({ runtime, agent, proj })) {
    if (typeof v !== 'string' || !v) throw new Error(`setupOverlay: ${k} must be a non-empty string`);
  }
  assertAgentName(agent);
  const ign = new Set(ignore ?? DEFAULT_IGNORE);
  statSync(proj); // missing project reports ENOENT here, leaving no overlay folders behind
  const { base: basedir, upper, work, manifest } = overlayPaths(runtime, agent);
  mkdirSync(upper, { recursive: true });
  mkdirSync(work, { recursive: true });
  for (const name of readdirSync(basedir)) {
    if (name.startsWith('merged-')) rmSync(join(basedir, name), { recursive: true, force: true });
  }
  if (existsSync(manifest)) {
    const prev = readRecord(manifest, runtime, agent);
    if (prev.proj !== proj) {
      throw new Error(`sbx: overlay for agent '${agent}' belongs to ${prev.proj}, not ${proj} (use a different agent or runtime)`);
    }
  }
  if (walkLocal(upper, ign).size > 0) {
    throw new Error(`sbx: agent '${agent}' has uncommitted overlay changes (review with 'sbx diff', then 'sbx commit' or 'sbx rollback')`);
  }
  refuseLeftover(proj, 'setup');
  emptyDir(work); // kernel scratch: safe to drop, never user data
  /** @type {Record<string, string|null>} */
  const base = {};
  for (const [rel, e] of walkLocal(proj, ign)) base[rel] = fpOf(e);
  writeFileSync(manifest, JSON.stringify({
    version: MANIFEST_VERSION, proj, ignore: [...ign], createdAt: new Date().toISOString(), base,
  }));
  return { upper, work };
}

function noOverlayError(runtime, agent) {
  return Object.assign(
    new Error(`sbx: no overlay for agent '${agent}' in ${runtime} ` +
      `(no overlay record: no run with overlay here, or its changes were rolled back)`),
    { code: 'SBX_NO_OVERLAY' });
}

function loadOverlay({ runtime, agent }) {
  assertAgentName(agent);
  const { base: scratch, upper, work, manifest } = overlayPaths(runtime, agent);
  const m = readRecord(manifest, runtime, agent);
  return {
    scratch, upper, work, proj: /** @type {string} */ (m.proj),
    ignore: new Set(/** @type {string[]} */ (m.ignore ?? [])),
    base: new Map(Object.entries(/** @type {Record<string, string|null>} */ (m.base))),
  };
}

// --- merged-view mount (the only reader of whiteouts/opaques) --------------

/** Run the walker inside one overlay mount; return its manifest. `src/` is bound read-only at its own path (same `walkLocal`, never shell); with `stageDir` (bound at `/sbx-new`) the walker also stages every file/symlink. Scratch lives under the runtime dir, never /tmp. */
function bwrapWalk({ lower, upper, work, ignore, scratch, stageDir = null }) {
  mkdirSync(scratch, { recursive: true });
  const merged = mkdtempSync(join(scratch, 'merged-'));
  const srcDir = dirname(fileURLToPath(import.meta.url));
  try {
    const res = spawnSync('bwrap',
      ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib64', '/lib64',
        '--overlay-src', lower, '--overlay', upper, work, merged,
        '--ro-bind', srcDir, srcDir,
        ...(stageDir ? ['--bind', stageDir, '/sbx-new'] : []),
        '--', '/usr/bin/node', join(srcDir, 'overlay-walk.js'),
        merged, JSON.stringify([...ignore]),
        ...(stageDir ? ['/sbx-new'] : [])],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    if (res.error) {
      throw new Error(`sbx: overlay view failed (${res.error.message}; diff/commit need bwrap)`);
    }
    if (res.status !== 0) {
      throw new Error(`sbx: overlay view failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
    }
    /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
    let out;
    try {
      out = new Map(JSON.parse(res.stdout));
    } catch {
      throw new Error('sbx: overlay view returned malformed output (retry)');
    }
    for (const rel of out.keys()) assertSafeRel(rel);
    return out;
  } finally {
    rmSync(merged, { recursive: true, force: true });
  }
}

/** Walk the project and fingerprint it; mount the merged view unless the upper is empty (then merged IS the project). With `stageDir` the mount also stages every file/symlink there. */
function snapLower(ov, stageDir = null) {
  const lower = walkLocal(ov.proj, ov.ignore);
  /** @type {Map<string, string|null>} */
  const lowerFps = new Map([...lower].map(([rel, e]) => [rel, fpOf(e)]));
  const merged = walkLocal(ov.upper, ov.ignore).size === 0 ? lower
    : bwrapWalk({
      lower: ov.proj, upper: ov.upper, work: ov.work, ignore: ov.ignore, scratch: ov.scratch, stageDir,
    });
  return { lower, lowerFps, merged };
}

/**
 * Review one run's tracing paper: every file the sandbox added, modified or deleted, each flagging a project change made after the run started.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to read
 * @returns {OverlayChange[]} one entry per added/modified/deleted path, each flagging a mid-run project change
 * @when Reach for this to review one run's tracing paper: it lists every file the sandboxed run added, modified or deleted, flagging the ones the project changed meanwhile.
 * @fails Throws when no overlay exists for the agent, when the project is gone, when a leftover commit folder blocks, or when the overlay view cannot be mounted; never writes anything.
 * @example
 * import { diffOverlay } from "barebox";
 * const changes = diffOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * for (const c of changes) console.log(c.status, c.path, c.conflict ? "(CONFLICT)" : "");
 */
export function diffOverlay({ runtime, agent }) {
  const ov = loadOverlay({ runtime, agent });
  refuseLeftover(ov.proj, 'diff');
  if (!existsSync(ov.proj)) {
    throw new Error(`sbx: project ${ov.proj} is gone (cannot diff an overlay without its lower)`);
  }
  const { lower, merged } = snapLower(ov);
  return computeChanges(ov.base, lower, merged);
}

// --- commit: stage, then swap by rename, with a journal ---------------------

const depthOf = (p) => p.split('/').length;

/** Merged-view mode minus setuid/setgid: a sandboxed setuid plant must never become host privilege. */
function stripCommitMode(mode) {
  return mode & 0o1777;
}

function exoticName(type) {
  if (type === 'p') return 'a fifo';
  if (type === 's') return 'a socket';
  if (type === 'c' || type === 'b') return 'a device node';
  if (type === '?') return 'an unknown file kind';
  return `kind '${type}'`;
}

/** Fingerprint one project path now, or null when absent. ENOTDIR also reads as absent: a non-dir prefix (a file becoming a folder) cannot hold the path. */
function fpNow(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
  const type = kindOf(st);
  if (type === 'f') {
    return fpOf({ type, mode: st.mode & 0o7777, hash: createHash('sha256').update(readFileSync(abs)).digest('hex') });
  }
  if (type === 'l') return fpOf({ type, mode: st.mode & 0o7777, target: readlinkSync(abs) });
  return fpOf({ type, mode: st.mode & 0o7777 });
}

/** One journal entry (the single shape): a phase-2 step actually taken; undo runs these in reverse.
 *
 * @typedef {object} JournalEntry
 * @property {string} op `aside` (original to `slot`) | `in` (staged content to dest) | `rmdir` | `mkdir` | `chmod` (restore `mode`)
 * @property {string} path project-relative path the step touched
 * @property {string} [slot] `aside`: backup path under `old/`
 * @property {number} [mode] `rmdir`/`chmod`: the original mode to restore
 */

/** Undo a journal in reverse, best effort: a failed step is recorded and the rest still runs. Returns exactly the steps left un-undone.
 *
 * @param {JournalEntry[]} journal steps taken, in order
 * @param {string} proj project directory the steps were applied to
 * @returns {string[]} `"<op> <path>"` for every step left un-undone, in undo order
 */
export function undoJournal(journal, proj) {
  /** @type {string[]} */
  const notUndone = [];
  for (let i = journal.length - 1; i >= 0; i--) {
    const e = /** @type {JournalEntry} */ (journal[i]);
    try {
      const dest = join(proj, e.path);
      if (e.op === 'in') {
        rmSync(dest, { force: true });
      } else if (e.op === 'aside') {
        rmSync(dest, { recursive: true, force: true });
        renameSync(/** @type {string} */ (e.slot), dest);
      } else if (e.op === 'rmdir') {
        try {
          mkdirSync(dest);
        } catch (err) {
          // Already there (its removal never landed): restore the mode, count it undone.
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST' || !lstatSync(dest).isDirectory()) throw err;
        }
        chmodSync(dest, /** @type {number} */ (e.mode));
      } else if (e.op === 'mkdir') {
        rmdirSync(dest);
      } else {
        chmodSync(dest, /** @type {number} */ (e.mode));
      }
    } catch {
      notUndone.push(`${e.op} ${e.path}`);
    }
  }
  return notUndone;
}

/**
 * Press one run's tracing paper down: stage the merged view, then swap it into the project by rename. Applies everything or undoes it: a full undo reports "nothing was applied"; a partial one lists exactly the steps not undone, keeps the commit folder (originals in `old/`), and names its path.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to commit
 * @param {string} [opts.onConflict] `refuse` (default) throws before writing anything; `skip` commits the rest and reports the skipped paths
 * @returns {{committed: string[], skipped: {path: string, reason: string}[]}} committed project-relative paths, plus conflicts left uncommitted under `skip`
 * @when Reach for this to press one run's tracing paper down: it stages the sandbox's changes and swaps them into the project by rename, refusing loudly on mid-run conflicts.
 * @fails Throws (writing nothing) when any changed file was also changed in the project mid-run, unless onConflict is `skip`; throws on unsupported file kinds and on a project that moved mid-commit. A phase-2 failure undoes every journaled step: a full undo reports `nothing was applied`, a partial one throws `SBX_COMMIT_FAILED` listing exactly the steps not undone and keeping the commit folder (originals in `old/`) named in the error. Setuid/setgid bits are stripped from committed modes; mtimes are not preserved. A killed commit leaves a folder that blocks the next diff/commit/setup until removed.
 * @example
 * import { commitOverlay } from "barebox";
 * const { committed, skipped } = commitOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * console.log(`committed ${committed.length} file(s), skipped ${skipped.length}`);
 */
export function commitOverlay({ runtime, agent, onConflict = 'refuse' }) {
  if (onConflict !== 'refuse' && onConflict !== 'skip') {
    throw new Error(`commitOverlay: onConflict must be 'refuse'|'skip', got ${JSON.stringify(onConflict)}`);
  }
  const ov = loadOverlay({ runtime, agent });
  refuseLeftover(ov.proj, 'commit');
  if (walkLocal(ov.upper, ov.ignore).size === 0) return { committed: [], skipped: [] };
  const commitDir = join(ov.proj, `${COMMIT_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
  const newDir = join(commitDir, 'new');
  const oldDir = join(commitDir, 'old');
  mkdirSync(newDir, { recursive: true });
  mkdirSync(oldDir, { recursive: true });
  try {
    const res = commitInDir(ov, newDir, oldDir, commitDir, onConflict);
    rmSync(commitDir, { recursive: true, force: true });
    return res;
  } catch (e) {
    if (!(e instanceof Error) || !(/** @type {{keepCommitDir?: boolean}} */ (e).keepCommitDir)) {
      rmSync(commitDir, { recursive: true, force: true });
    }
    throw e;
  }
}

/** Phase 1 (no project writes) then phase 2 (journaled renames). */
function commitInDir(ov, newDir, oldDir, commitDir, onConflict) {
  // One mount: the manifest for the diff, plus every file/symlink staged.
  const { lower, lowerFps, merged } = snapLower(ov, newDir);
  const changes = computeChanges(ov.base, lower, merged);
  const conflicts = changes.filter((c) => c.conflict);
  if (conflicts.length && onConflict !== 'skip') throw new OverlayConflictError(conflicts);
  const apply = onConflict === 'skip' ? changes.filter((c) => !c.conflict) : changes;
  const skipped = onConflict === 'skip'
    ? conflicts.map((c) => ({ path: c.path, reason: /** @type {string} */ (c.reason) }))
    : [];
  for (const c of apply) {
    if (c.status !== 'deleted' && c.type !== 'f' && c.type !== 'd' && c.type !== 'l') {
      throw new Error(`sbx: cannot commit ${c.path}: ${exoticName(/** @type {string} */ (c.type))} ` +
        'created inside the sandbox (remove it there and retry)');
    }
  }
  // Re-check exactly the paths about to change, while nothing is (absent fingerprints as null both sides).
  for (const c of apply) {
    if (fpNow(join(ov.proj, c.path)) !== (lowerFps.get(c.path) ?? null)) {
      throw new Error(`sbx: project changed during commit at ${c.path} (nothing was applied; retry)`);
    }
  }
  /** @type {JournalEntry[]} */
  const journal = [];
  try {
    swapIn(ov, apply, lower, newDir, oldDir, journal);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    const at = e instanceof Error && /** @type {{commitPath?: string}} */ (e).commitPath
      ? /** @type {string} */ (/** @type {{commitPath?: string}} */ (e).commitPath) : apply.map((c) => c.path).join(', ');
    const notUndone = undoJournal(journal, ov.proj);
    if (notUndone.length) {
      throw Object.assign(
        new Error(`sbx: commit failed at ${at} (${cause}): ` +
          `not undone [${notUndone.join(', ')}] (originals are in ${oldDir}; commit folder kept: ${commitDir})`),
        { code: 'SBX_COMMIT_FAILED', notUndone, keepCommitDir: true });
    }
    throw Object.assign(
      new Error(`sbx: commit failed at ${at} (${cause}; nothing was applied)`),
      { code: 'SBX_COMMIT_FAILED', notUndone });
  }
  // A skipped conflict stays on the paper; a full commit starts a fresh sheet, no-op included.
  if (!skipped.length) {
    emptyDir(ov.upper);
    emptyDir(ov.work);
  }
  return { committed: apply.map((c) => c.path), skipped };
}

/** Fail with the path attached, so the phase-2 catcher can name it. */
function swapFail(rel, cause) {
  throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { commitPath: rel });
}

/** Phase 2: every step is one rename/mkdir/rmdir/chmod, journaled before the next runs. */
function swapIn(ov, apply, lower, newDir, oldDir, journal) {
  let slots = 0;
  const slotFor = () => join(oldDir, `s${slots++}`);
  const deepFirst = [...apply].sort((a, b) => depthOf(b.path) - depthOf(a.path));
  // 1. Move aside every file/symlink about to be deleted or replaced, deepest first (dirs go in step 2).
  for (const c of deepFirst) {
    const l = lower.get(c.path);
    if (!l || l.type === 'd') continue;
    try {
      const slot = slotFor();
      renameSync(join(ov.proj, c.path), slot);
      journal.push({ op: 'aside', path: c.path, slot });
    } catch (e) {
      swapFail(c.path, e);
    }
  }
  // 2. Remove deleted folders, deepest first. Only ignored content left is kept (Q3); replacing a
  // folder that holds ignored content with a file/symlink is refused loudly.
  for (const c of deepFirst) {
    const l = lower.get(c.path);
    if (l?.type !== 'd') continue;
    if (c.status !== 'deleted' && c.type === 'd') continue;
    try {
      rmdirSync(join(ov.proj, c.path));
      journal.push({ op: 'rmdir', path: c.path, mode: /** @type {number} */ (l.mode) });
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (code === 'ENOENT') continue;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        if (c.status !== 'deleted') {
          throw Object.assign(
            new Error(`sbx: ${c.path} holds ignored content; cannot replace it ` +
              `with a ${c.type === 'l' ? 'symlink' : 'file'}`),
            { commitPath: c.path });
        }
        continue;
      }
      swapFail(c.path, e);
    }
  }
  // 3. Create new folders, shallowest first, writable (final modes land in step 5).
  /** @type {Set<string>} */
  const needDirs = new Set();
  for (const c of apply) {
    if (c.status === 'deleted') continue;
    const top = c.type === 'd' ? c.path : dirname(c.path);
    if (top === '.' || !top) continue;
    const segs = top.split('/');
    for (let i = 1; i <= segs.length; i++) needDirs.add(segs.slice(0, i).join('/'));
  }
  for (const rel of [...needDirs].sort((a, b) => depthOf(a) - depthOf(b))) {
    const dest = join(ov.proj, rel);
    try {
      if (existsSync(dest)) {
        if (!lstatSync(dest).isDirectory()) throw new Error(`${rel} is not a directory`);
        continue;
      }
      mkdirSync(dest);
      chmodSync(dest, 0o700);
      journal.push({ op: 'mkdir', path: rel });
    } catch (e) {
      swapFail(rel, e);
    }
  }
  // 4. Move the staged files and symlinks in.
  for (const c of apply) {
    if (c.status === 'deleted' || c.type === 'd') continue;
    try {
      renameSync(join(newDir, c.path), join(ov.proj, c.path));
      journal.push({ op: 'in', path: c.path });
    } catch (e) {
      swapFail(c.path, e);
    }
  }
  // 5. Permissions last, deepest first: new folders, folder mode changes, file modes (setuid/setgid
  // stripped). Symlinks are never chmodded — it would hit the target.
  for (const c of deepFirst) {
    if (c.status === 'deleted' || (c.type !== 'd' && c.type !== 'f')) continue;
    const dest = join(ov.proj, c.path);
    try {
      const oldMode = lstatSync(dest).mode & 0o7777;
      const want = stripCommitMode(/** @type {number} */ (c.mode));
      if (oldMode === want) continue;
      chmodSync(dest, want);
      journal.push({ op: 'chmod', path: c.path, mode: oldMode });
    } catch (e) {
      swapFail(c.path, e);
    }
  }
}

// --- rollback ---------------------------------------------------------------

/** Raw fallback: relative upper paths, no added/modified/deleted inference. Same walker, statuses discarded; a missing upper is nothing to discard. */
function rawUpper(upper, ignore) {
  /** @type {Map<string, unknown>} */
  let entries;
  try {
    entries = walkLocal(upper, ignore);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  return [...entries.keys()].sort().map((rel) => ({ path: rel, status: 'unknown', conflict: false, reason: null }));
}

/**
 * Throw one run's tracing paper away: drop every sandboxed change and leave the project exactly as it was. Reports exactly what `diffOverlay` returns, taken before removal, so rollback and diff can never disagree; when the project is gone (or the view cannot be mounted) the report is the raw relative paths found in the upper, with no added/modified/deleted inference. Then the overlay dir is removed completely (permissions fixed first: the work folder can be mode 000), so the next run starts fresh. Never touches the project.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to discard
 * @returns {{discarded: OverlayChange[], exact: boolean}} the changes that were dropped; `exact` is false for the raw fallback
 * @when Reach for this to throw one run's tracing paper away: it drops every sandboxed change and leaves the project exactly as it was.
 * @fails Throws when no overlay exists for the agent; dropping the upper never touches the project.
 * @example
 * import { rollbackOverlay } from "barebox";
 * const { discarded } = rollbackOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * console.log(`discarded ${discarded.length} change(s)`);
 */
export function rollbackOverlay({ runtime, agent }) {
  assertAgentName(agent);
  const { base: basedir, upper, work, manifest } = overlayPaths(runtime, agent);
  const m = readRecord(manifest, runtime, agent);
  const ignore = new Set(/** @type {string[]} */ (m.ignore ?? []));
  /** @type {OverlayChange[]} */
  let discarded;
  let exact = true;
  if (existsSync(m.proj)) {
    try {
      discarded = diffOverlay({ runtime, agent });
    } catch {
      discarded = rawUpper(upper, ignore);
      exact = false;
    }
  } else {
    discarded = rawUpper(upper, ignore);
    exact = false;
  }
  for (const d of [upper, work]) {
    try {
      chmodTree(d);
    } catch {
      // Missing already: the rm below still runs.
    }
  }
  rmSync(basedir, { recursive: true, force: true });
  return { discarded, exact };
}
