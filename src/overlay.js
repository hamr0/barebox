// overlay.js — M4 undo layer: per-run tracing paper over the real project.
// Writes land in a per-run upper (lower = project read-only); commit presses
// the merged view down, rollback drops the upper. Diff/commit walk the merged
// view with node inside the mount (`overlay-walk.js`): the one
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
  existsSync, mkdirSync, readdirSync, lstatSync, statSync, accessSync, constants,
  readFileSync, writeFileSync, rmSync, rmdirSync, chmodSync,
  readlinkSync, renameSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentName, runtimeTempDir, runtimePaths, safe } from './runtime.js';

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

/**
 * Build one manifest entry: the single definition of the fingerprint
 * (type + content + mode), shared by the walker and by live re-checks.
 *
 * @param {string} abs absolute path to read
 * @param {import('node:fs').Stats} st `lstat` of `abs`
 * @param {boolean} [full] read content (hash file bytes, read link targets); false records type + mode only, for paths whose entry the host fills from elsewhere
 * @returns {{ type: string, mode: number, hash?: string, target?: string }} the entry
 */
function entryOf(abs, st, full = true) {
  const type = kindOf(st);
  if (type === 'f') {
    return full
      ? {
        type, mode: st.mode & 0o7777,
        hash: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      }
      : { type, mode: st.mode & 0o7777 };
  }
  if (type === 'l') {
    return full
      ? { type, mode: st.mode & 0o7777, target: readlinkSync(abs) }
      : { type, mode: st.mode & 0o7777 };
  }
  return { type, mode: st.mode & 0o7777 };
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

/** True for permission errors: the entry exists but cannot be read. */
function isPermErr(e) {
  const code = /** @type {NodeJS.ErrnoException} */ (e).code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Refuse an unreadable entry loudly: name the path (sanitized — it may be
 * agent-chosen) and say how to proceed. Never `chmod` to make it readable:
 * that would change the modes a commit applies.
 *
 * @param {string} root directory being walked
 * @param {string} rel project-relative path of the unreadable entry
 * @param {unknown} cause the filesystem error
 * @returns {never} always throws
 */
function refuseUnreadable(root, rel, cause) {
  const code = cause instanceof Error && /** @type {NodeJS.ErrnoException} */ (cause).code
    ? /** @type {NodeJS.ErrnoException} */ (cause).code
    : 'error';
  throw new Error(`sbx: cannot read ${safe(rel)} in ${root} (${code}; ` +
    `fix its permissions or run 'sbx rollback' to discard the run)`);
}

/** The one walker: project, upper, merged view. Skips ignored/commit dirs (never descended); strict UTF-8 names (non-UTF-8 refused loudly); unreadable entries are refused loudly (never chmodded readable).
 *
 * @param {string} root directory to walk
 * @param {Set<string>} ignore path segments invisible to the layer
 * @param {Set<string>|null} [hashOnly] when set, only these relative paths get full entries (hashes, link targets); every other path is still `lstat`ed but records type + mode only
 * @returns {Map<string, {type: string, mode: number, hash?: string, target?: string}>}
 */
export function walkLocal(root, ignore, hashOnly = null) {
  /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
  const out = new Map();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const stack = [''];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {Buffer[]} */
    let names;
    try {
      names = /** @type {Buffer[]} */ (/** @type {unknown} */ (readdirSync(join(root, dir), { encoding: 'buffer' })));
    } catch (e) {
      if (isPermErr(e)) refuseUnreadable(root, dir || '.', e);
      throw e;
    }
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
      let st;
      try {
        st = lstatSync(join(root, rel));
      } catch (e) {
        if (isPermErr(e)) refuseUnreadable(root, rel, e);
        throw e;
      }
      if (kindOf(st) === 'd') {
        out.set(rel, { type: 'd', mode: st.mode & 0o7777 });
        stack.push(rel);
        continue;
      }
      try {
        out.set(rel, entryOf(join(root, rel), st, hashOnly === null || hashOnly.has(rel)));
      } catch (e) {
        if (isPermErr(e)) refuseUnreadable(root, rel, e);
        throw e;
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

/** True when the upper holds no visible entry: one shallow `readdir`, no recursion, no hashing. Any top-level name that is neither ignored nor a commit folder counts. Throws when the upper itself cannot be read, like the walk it replaces. */
function upperIsEmpty(upper, ignore) {
  for (const name of readdirSync(upper)) {
    if (isIgnored(name, ignore) || isCommitDir(name)) continue;
    return false;
  }
  return true;
}

/**
 * Make a tree listable and removable without changing what a report says:
 * add owner read (files) or rwx (dirs), keeping every other bit, so a diff
 * taken afterwards still reports the original modes on everything that was
 * already readable. Never follows symlinks.
 */
function chmodTree(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  const want = (st.mode & 0o7777) | (st.isDirectory() ? 0o700 : 0o600);
  if (want !== (st.mode & 0o7777)) chmodSync(p, want);
  if (st.isDirectory()) {
    for (const n of readdirSync(p)) chmodTree(join(p, n));
  }
}

/** Empty a dir, tolerating mode-000 debris and whiteout orphans (chmod-then-rm, never following symlinks). */

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
  const { base: basedir, upper, work, manifest } = runtimePaths(runtime).overlay(agent);
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
  if (!upperIsEmpty(upper, ign)) {
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
  const { base: scratch, upper, work, manifest } = runtimePaths(runtime).overlay(agent);
  const m = readRecord(manifest, runtime, agent);
  return {
    scratch, upper, work, proj: /** @type {string} */ (m.proj),
    ignore: new Set(/** @type {string[]} */ (m.ignore ?? [])),
    base: new Map(Object.entries(/** @type {Record<string, string|null>} */ (m.base))),
  };
}

// --- merged-view mount (the only reader of whiteouts/opaques) --------------

/** Run the walker inside one overlay mount; return its manifest. `src/` is bound read-only at its own path (same `walkLocal`, never shell); with `stageDir` (bound at `/sbx-new`) the walker also stages the listed files/symlinks. With `upperPaths` the walker hashes and stages only those relative paths and records the rest as type + mode stubs for the host to fill from the lower. The manifest and the path list travel as files in a folder bound read-write at `/sbx-out`: stdout carries no data, so there is no output cap, however many files the project holds. Scratch lives under the runtime dir, never /tmp.
 *
 * @param {object} opts
 * @param {string} opts.lower project directory (overlay lower)
 * @param {string} opts.upper overlay upper directory
 * @param {string} opts.work overlay work directory
 * @param {Set<string>} opts.ignore invisible path segments
 * @param {string} opts.scratch scratch dir for mount points and walker output
 * @param {string|null} [opts.stageDir] bound at `/sbx-new` for staging, or null
 * @param {Set<string>|null} [opts.upperPaths] upper relative paths to hash and stage, or null for all
 */
function bwrapWalk({ lower, upper, work, ignore, scratch, stageDir = null, upperPaths = null }) {
  mkdirSync(scratch, { recursive: true });
  const merged = runtimeTempDir(scratch, 'merged');
  const outDir = runtimeTempDir(scratch, 'walk');
  const manifestFile = join(outDir, 'manifest.json');
  if (upperPaths) writeFileSync(join(outDir, 'upper-paths.json'), JSON.stringify([...upperPaths]));
  const srcDir = dirname(fileURLToPath(import.meta.url));
  // The interpreter inside the mount is the node running barebox now —
  // never a hardcoded path (nvm, volta and Linuxbrew keep node outside
  // /usr). Its prefix is bound read-only when /usr does not already show it.
  const node = realpathSync(process.execPath);
  const underUsr = node === '/usr' || node.startsWith('/usr/');
  const nodeParent = dirname(node);
  const nodePrefix = nodeParent.endsWith('/bin') ? dirname(nodeParent) : nodeParent;
  try {
    // No output cap (stdout carries no data) and no time limit: the walk
    // is finite (`lstat`, never following symlinks), and killing a commit's
    // extraction halfway helps nobody.
    const res = spawnSync('bwrap',
      ['--die-with-parent', '--unshare-all', '--new-session',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib64', '/lib64',
        '--overlay-src', lower, '--overlay', upper, work, merged,
        '--ro-bind', srcDir, srcDir,
        '--bind', outDir, '/sbx-out',
        ...(stageDir ? ['--bind', stageDir, '/sbx-new'] : []),
        ...(underUsr ? [] : ['--ro-bind', nodePrefix, nodePrefix]),
        '--', node, join(srcDir, 'overlay-walk.js'),
        merged, JSON.stringify([...ignore]),
        join('/sbx-out', 'manifest.json'),
        stageDir ? '/sbx-new' : '',
        upperPaths ? join('/sbx-out', 'upper-paths.json') : ''],
      { encoding: 'utf8' });
    if (res.error) {
      throw new Error(`sbx: could not start ${node} inside bwrap for the overlay walk: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`sbx: overlay walk failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
    }
    /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
    let out;
    try {
      out = new Map(JSON.parse(readFileSync(manifestFile, 'utf8')));
    } catch {
      throw new Error('sbx: overlay walk wrote no readable manifest (retry)');
    }
    // No relpath check: the keys come from our own walker's `readdir`
    // names, which can never be `..` or absolute.
    return out;
  } finally {
    rmSync(merged, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Walk the project and fingerprint it; mount the merged view unless the upper is empty (then merged IS the project). With `stageDir` the mount also stages the upper's files/symlinks there. The mount hashes only the upper's paths; every other merged entry is filled from the lower below. */
function snapLower(ov, stageDir = null) {
  const lower = walkLocal(ov.proj, ov.ignore);
  /** @type {Map<string, string|null>} */
  const lowerFps = new Map([...lower].map(([rel, e]) => [rel, fpOf(e)]));
  // One cheap upper walk, no hashing: an empty set reads as the project.
  const upperPaths = new Set(walkLocal(ov.upper, ov.ignore, new Set()).keys());
  const merged = upperPaths.size === 0 ? lower
    : bwrapWalk({
      lower: ov.proj, upper: ov.upper, work: ov.work, ignore: ov.ignore, scratch: ov.scratch, stageDir, upperPaths,
    });
  if (merged !== lower) {
    // A merged path outside the upper IS the lower entry unchanged, so its
    // fingerprint comes from the already-hashed lower instead of a second
    // hash inside the mount. This holds because opaque folders and copy-up
    // both land the path in the upper, and this overlay has no metacopy or
    // redirect_dir (with them, the path would still be in the upper).
    for (const [rel] of merged) {
      if (!upperPaths.has(rel)) {
        const le = lower.get(rel);
        if (le) merged.set(rel, le);
      }
    }
  }
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
  return 'an unknown file kind';
}

/** Fingerprint one project path now, or null when absent. ENOTDIR also reads as absent: a non-dir prefix (a file becoming a folder) cannot hold the path. */
export function fpNow(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
  return fpOf(entryOf(abs, st));
}

/**
 * First path in `paths` whose live fingerprint differs from the snapshot
 * (absent reads as null both sides), or null when nothing moved. A project
 * edit landing between the diff and the swap would otherwise be silently
 * overwritten, so `commitOverlay` refuses when this returns a path.
 *
 * @param {string} proj project directory
 * @param {string[]} paths project-relative paths about to change
 * @param {Map<string, string|null>} lowerFps snapshot fingerprints from the diff
 * @returns {string|null} the first changed path, or null
 */
export function changedSince(proj, paths, lowerFps) {
  for (const p of paths) {
    if (fpNow(join(proj, p)) !== (lowerFps.get(p) ?? null)) return p;
  }
  return null;
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
  if (upperIsEmpty(ov.upper, ov.ignore)) return { committed: [], skipped: [] };
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
    throw finishFailedCommit(commitDir, e);
  }
}

/**
 * Decide what survives a failed commit: the staging folder is deleted only
 * when the undo left nothing behind (`notUndone` empty — nothing was
 * applied); otherwise it is kept, because `old/` holds the only copy of
 * the originals, and the error names the folder. Returns the error to throw.
 *
 * @param {string} commitDir the run's staging folder in the project
 * @param {unknown} failure whatever the commit threw (phase-1 refusals carry no `notUndone`)
 * @returns {unknown} the failure, to throw
 */
export function finishFailedCommit(commitDir, failure) {
  const notUndone = failure instanceof Error && Array.isArray(
    /** @type {{ notUndone?: unknown }} */ (failure).notUndone)
    ? /** @type {unknown[]} */ (/** @type {{ notUndone?: unknown }} */ (failure).notUndone)
    : [];
  if (!notUndone.length) {
    rmSync(commitDir, { recursive: true, force: true });
  }
  return failure;
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
  const moved = changedSince(ov.proj, apply.map((c) => c.path), lowerFps);
  if (moved !== null) {
    throw new Error(`sbx: project changed during commit at ${moved} (nothing was applied; retry)`);
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
        { code: 'SBX_COMMIT_FAILED', notUndone });
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

/**
 * Fail with the path attached, so the phase-2 catcher can name it. A
 * permission failure under a parent step 0 deliberately left alone names
 * that parent and its foreign ownership.
 *
 * @returns {never} always throws
 */
function swapFail(rel, cause, unowned) {
  let msg = cause instanceof Error ? cause.message : String(cause);
  const code = cause instanceof Error
    ? /** @type {{ code?: string }} */ (cause).code
    : undefined;
  if ((code === 'EACCES' || code === 'EPERM') && unowned && unowned.size) {
    for (let d = dirname(rel); ; d = dirname(d)) {
      const key = d === '' ? '.' : d;
      if (unowned.has(key)) {
        msg += ` (parent '${key}' is not writable and not owned by you, so it was left alone)`;
        break;
      }
      if (d === '.' || d === '' || d === '/') break;
    }
  }
  throw Object.assign(new Error(msg), { commitPath: rel });
}

/** Phase 2: every step is one rename/mkdir/rmdir/chmod, journaled before the next runs. */
function swapIn(ov, apply, lower, newDir, oldDir, journal) {
  let slots = 0;
  const slotFor = () => join(oldDir, `s${slots++}`);
  const deepFirst = [...apply].sort((a, b) => depthOf(b.path) - depthOf(a.path));
  // 0. Read-only parents: a rename needs write permission on the parent
  // folder, so a change inside a 0555 folder could never commit. Collect
  // every parent a step renames into or out of, or mkdir/rmdirs in; for
  // each one this process cannot write to but owns, journal the current
  // mode and add u+w (step 5 sets the final mode). Parents it does not own
  // are left alone: the op fails and is undone, naming them (see swapFail).
  /** @type {Map<string, number>} */
  const tempChmods = new Map();
  /** @type {Set<string>} */
  const unownedParents = new Set();
  {
    /** @type {Set<string>} */
    const parents = new Set();
    for (const c of apply) {
      for (let d = dirname(c.path); ; d = dirname(d)) {
        parents.add(d === '' ? '.' : d);
        if (d === '.' || d === '' || d === '/') break;
      }
    }
    const writable = (abs) => {
      try {
        accessSync(abs, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    for (const rel of parents) {
      const abs = join(ov.proj, rel);
      let st;
      try {
        st = statSync(abs); // follows links: the mode chmodded below is the target's
      } catch {
        continue; // missing: a later step fails loudly, as today
      }
      if (!st.isDirectory() || writable(abs)) continue;
      const owned = typeof process.getuid === 'function' ? st.uid === process.getuid() : true;
      if (!owned) {
        unownedParents.add(rel);
        continue;
      }
      const orig = st.mode & 0o7777;
      try {
        chmodSync(abs, orig | 0o200);
        journal.push({ op: 'chmod', path: rel, mode: orig });
        tempChmods.set(rel, orig);
      } catch (e) {
        swapFail(rel, e, unownedParents);
      }
    }
  }
  // 1. Move aside every file/symlink about to be deleted or replaced, deepest first (dirs go in step 2).
  for (const c of deepFirst) {
    const l = lower.get(c.path);
    if (!l || l.type === 'd') continue;
    try {
      const slot = slotFor();
      renameSync(join(ov.proj, c.path), slot);
      journal.push({ op: 'aside', path: c.path, slot });
    } catch (e) {
      swapFail(c.path, e, unownedParents);
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
      swapFail(c.path, e, unownedParents);
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
      swapFail(rel, e, unownedParents);
    }
  }
  // 4. Move the staged files and symlinks in.
  for (const c of apply) {
    if (c.status === 'deleted' || c.type === 'd') continue;
    try {
      renameSync(join(newDir, c.path), join(ov.proj, c.path));
      journal.push({ op: 'in', path: c.path });
    } catch (e) {
      swapFail(c.path, e, unownedParents);
    }
  }
  // 5. Permissions last, deepest first: new folders, folder mode changes, file modes (setuid/setgid
  // stripped). Symlinks are never chmodded — it would hit the target.
  /** @type {Set<string>} */
  const modeSet = new Set();
  for (const c of deepFirst) {
    if (c.status === 'deleted' || (c.type !== 'd' && c.type !== 'f')) continue;
    const dest = join(ov.proj, c.path);
    try {
      const oldMode = lstatSync(dest).mode & 0o7777;
      const want = stripCommitMode(/** @type {number} */ (c.mode));
      modeSet.add(c.path);
      if (oldMode === want) continue;
      chmodSync(dest, want);
      journal.push({ op: 'chmod', path: c.path, mode: oldMode });
    } catch (e) {
      swapFail(c.path, e, unownedParents);
    }
  }
  // 5b. Temporary u+w back out: a step-0 parent the changeset does not set
  // keeps its original mode. A parent the commit removed is gone: nothing
  // to restore.
  for (const [rel, orig] of tempChmods) {
    if (modeSet.has(rel)) continue;
    const dest = join(ov.proj, rel);
    let cur;
    try {
      cur = statSync(dest).mode & 0o7777;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') continue;
      swapFail(rel, e, unownedParents);
    }
    if (cur === orig) continue;
    try {
      chmodSync(dest, orig);
    } catch (e) {
      swapFail(rel, e, unownedParents);
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
 * Throw one run's tracing paper away: drop every sandboxed change and leave the project exactly as it was. Reports exactly what `diffOverlay` returns, taken before removal, so rollback and diff can never disagree; when the project is gone (or the view cannot be mounted) the report is the raw relative paths found in the upper, with no added/modified/deleted inference. Then the overlay dir is removed completely, so the next run starts fresh. Never touches the project.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to discard
 * @returns {{discarded: OverlayChange[], exact: boolean, why: string|null}} the changes that were dropped; `exact` is false for the raw fallback, and then `why` names the actual reason (diff's error, or `project <proj> is gone`, plus the raw-listing reason when that failed too). `why` is null when exact.
 * @when Reach for this to throw one run's tracing paper away: it drops every sandboxed change and leaves the project exactly as it was.
 * @fails Throws when no overlay exists for the agent or its record is corrupt, or when the overlay folder cannot be removed even after a permission repair (the error names the folder). Listing the changes never throws and never invents entries: an unlistable upper reports `discarded: []` with the reasons in `why`. Removal depends on neither listing nor the first permission pass: a partial failure retries removal once after a fresh permission pass. Dropping the upper never touches the project.
 * @example
 * import { rollbackOverlay } from "barebox";
 * const { discarded } = rollbackOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * console.log(`discarded ${discarded.length} change(s)`);
 */
export function rollbackOverlay({ runtime, agent }) {
  assertAgentName(agent);
  const { base: basedir, upper, work, manifest } = runtimePaths(runtime).overlay(agent);
  const m = readRecord(manifest, runtime, agent);
  const ignore = new Set(/** @type {string[]} */ (m.ignore ?? []));
  // The escape hatch first: fix permissions before reading anything, so
  // mode-000 debris the agent left can wedge neither the report nor the
  // removal. Removal never depends on listing.
  for (const d of [upper, work]) {
    try {
      chmodTree(d);
    } catch {
      // Missing already: the rm below still runs.
    }
  }
  /** @type {OverlayChange[]} */
  let discarded = [];
  let exact = true;
  /** @type {string|null} */
  let why = null;
  /** @type {string|null} */
  let primary = null;
  if (!existsSync(m.proj)) {
    primary = `project ${m.proj} is gone`;
  } else {
    try {
      discarded = diffOverlay({ runtime, agent });
    } catch (e) {
      primary = e instanceof Error ? e.message : String(e);
    }
  }
  if (primary !== null) {
    exact = false;
    /** @type {string|null} */
    let rawReason = null;
    try {
      discarded = rawUpper(upper, ignore);
    } catch (e) {
      rawReason = e instanceof Error ? e.message : String(e);
      discarded = [];
    }
    why = rawReason === null || rawReason === primary
      ? primary
      : `${primary} (raw listing also failed: ${rawReason})`;
  }
  // Removal depends on neither listing nor the first permission pass: a
  // partial chmodTree/rmSync failure retries removal once after a fresh
  // permission pass over what is left; only that names the folder in a throw.
  try {
    rmSync(basedir, { recursive: true, force: true });
  } catch (e) {
    const first = e instanceof Error ? e.message : String(e);
    for (const d of [upper, work]) {
      try {
        chmodTree(d);
      } catch {
        // The remainder is chmodded as far as it goes; rmSync reports below.
      }
    }
    try {
      rmSync(basedir, { recursive: true, force: true });
    } catch {
      throw new Error(`sbx: cannot remove overlay for agent '${agent}' (${basedir}): ${first}`);
    }
  }
  return { discarded, exact, why };
}
