// overlay.js — M4 undo layer: per-run tracing paper over the real project.
//
// The agent sees the real project, but every write lands in a per-run upper
// layer (bwrap overlayfs: lower = the real project read-only, upper =
// `<runtime>/overlay/<agent>/`). The real folder stays untouched until
// `commitOverlay` copies the merged view down, or `rollbackOverlay` drops the
// upper. `launch` mounts it, `run` reports it, `sbx diff/commit/rollback`
// review it.
//
// Why diff/commit re-mount (lower, upper) instead of reading the upper
// directly: overlayfs records plain file deletions as whiteouts (a char 0:0
// node — easy to read), but a replaced directory (`rm -rf dir && mkdir dir`)
// as an OPAQUE upper dir whose marker lives in an xattr that is
// `user.overlay.opaque` on some kernels and `trusted.overlay.opaque`
// (unreadable unprivileged) on others — verified by POC on the dev box, where
// only the `user.*` form appeared. Parsing the upper therefore cannot
// portably reconstruct what the agent saw. Re-mounting and walking the merged
// view always shows exactly that, using only bwrap + coreutils — the same
// dependencies `launch` already needs. `sbx diff`/`commit` need userns for
// the same reason `launch` does; `rollback` never mounts (it only unlinks).
//
// Known limitation: host-side walks run as you, while the agent runs as
// in-namespace root past file modes — a mode-000 dir in the project reads
// fine inside but throws loudly here (never silently skipped).
//
// Conflict rule (the PRD's "refuse or flag", pinned): a change conflicts iff
// the project ALSO differs from the run-start snapshot at that path —
// `conflict = (lower != base) && (merged != lower)`. Untouched-by-agent
// paths are never conflicts (merged == lower there, whatever the user did).
// `commitOverlay` defaults to REFUSE: any conflict throws `SBX_CONFLICT`
// before a single byte is written — the commit is all-or-nothing, so a
// mid-run user edit is never half-overwritten. `onConflict: 'skip'` commits
// the rest and reports the skipped paths; there is deliberately no force
// flag. Resolve a conflict by editing the project to match (re-commit then
// sees no change), or by `rollbackOverlay`.
//
// Q3 (large untracked dirs): `ignore` path segments (default
// `['node_modules']`) are invisible to the whole layer — never snapshotted,
// never walked, never committed, never deleted. The agent still sees them
// (they merge through from the lower), but an `npm install` inside the
// sandbox is dropped at commit, and pruning keeps diff/commit fast on big
// trees. Pass more (`dist`, `build`, `.git`) per run when the project needs
// it; the default stays minimal so committed results surprise nobody.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, statSync,
  readFileSync, writeFileSync, rmSync, rmdirSync, copyFileSync, chmodSync,
  readlinkSync, symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { assertAgentName } from './proxy.js';

/**
 * One reviewed file change: what the sandbox did at `path`, and whether the
 * project changed underneath it mid-run.
 *
 * @typedef {object} OverlayChange
 * @property {string} path project-relative path with `/` separators
 * @property {string} status `added` | `modified` | `deleted`
 * @property {boolean} conflict true when the project changed this path after the run started
 * @property {string|null} reason why `conflict` is set, or null when clean
 * @property {string} [type] merged-view kind: `f` file, `d` dir, `l` symlink (set unless deleted)
 * @property {number} [mode] merged-view permission bits (set unless deleted)
 * @property {string} [hash] sha256 of a merged-view regular file
 * @property {string} [target] symlink target of a merged-view symlink
 */

const MANIFEST_VERSION = 1;
const MARKER = '\0\0SBX-HASHES\0\0';

/** Path segments invisible to the layer (Q3): never snapshotted, diffed, committed or deleted. */
export const DEFAULT_IGNORE = ['node_modules'];

/**
 * Refused commit: one or more paths changed in the project mid-run. Nothing
 * was written — inspect `conflicts`, resolve, and retry.
 */
export class OverlayConflictError extends Error {
  /**
   * @param {{path: string, status: string, reason: string|null}[]} conflicts conflicting changes
   */
  constructor(conflicts) {
    super(`sbx commit refused: ${conflicts.length} file(s) changed in the project ` +
      `during the run: ${conflicts.map((c) => c.path).join(', ')}`);
    this.code = 'SBX_CONFLICT';
    /** @type {{path: string, status: string, reason: string|null}[]} */
    this.conflicts = conflicts;
  }
}

// --- small pure helpers (no bwrap, no filesystem writes) -------------------

/** Single-quote a shell word. */
function sq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape a `-name` glob so an ignore segment matches literally. */
function escName(s) {
  return s.replace(/([\\*?[\]])/g, '\\$1');
}

/**
 * Reject a manifest relpath that could escape the project (paranoia: these
 * strings come from our own mount walks, but they feed host `rm`/`cp`).
 */
function assertSafeRel(rel) {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new Error(`sbx: unsafe overlay path ${JSON.stringify(rel)}`);
  }
}

/** True when any `/`-separated segment of `rel` is ignored. */
function isIgnored(rel, ignore) {
  return rel.split('/').some((seg) => ignore.has(seg));
}

/**
 * Fingerprint comparing: type + content (hash/target) + mode. Two entries
 * match iff the agent-visible file is identical — so a rewrite with
 * identical bytes is not a change at all.
 */
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

/**
 * Walk a host tree into `rel -> {type, mode, hash?, target?}`, skipping
 * ignored segments entirely (a pruned dir is never descended). Throws loudly
 * on unreadable entries — a half-read tree must never feed a commit.
 */
function walkLocal(root, ignore) {
  /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
  const out = new Map();
  const stack = [''];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    for (const name of readdirSync(join(root, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (isIgnored(rel, ignore)) continue;
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

/**
 * Union-compare base snapshot, current project, and merged view into sorted
 * changes. A path with `merged == lower` is no change (covers no-op rewrites
 * and user-only edits alike); the rest is added/modified/deleted, each with
 * the conflict flag from the pinned rule in the header comment.
 */
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

/**
 * Empty a dir, tolerating kernel and odd-permission debris: overlay workdirs
 * collect mode-000 subdirs and whiteout orphans a plain rm cannot take
 * (observed on the dev box: `work/work` mode 000 with a char-0:0 orphan).
 * Retries each entry after forcing owner rwx — never following symlinks, so
 * an agent-planted link can never redirect the chmod into the project.
 */
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

/**
 * Prepare a fresh upper for one run: create the layout, refuse leftover
 * uncommitted changes (a second run must not silently mix into another run's
 * paper — commit or roll back first), and snapshot the project as the
 * conflict baseline. An empty upper re-snapshots (failed spawns leave no
 * trace, so they never wedge the next run).
 */
export function setupOverlay({ runtime, agent, proj, ignore = DEFAULT_IGNORE }) {
  for (const [k, v] of Object.entries({ runtime, agent, proj })) {
    if (typeof v !== 'string' || !v) throw new Error(`setupOverlay: ${k} must be a non-empty string`);
  }
  assertAgentName(agent);
  const ign = new Set(ignore ?? DEFAULT_IGNORE);
  // Validate before writing anything: a missing project must report ENOENT,
  // never the mkdir EACCES of an unwritable runtime — and must leave no
  // empty overlay folders behind.
  statSync(proj);
  const { base: basedir, upper, work, manifest } = overlayPaths(runtime, agent);
  mkdirSync(upper, { recursive: true });
  mkdirSync(work, { recursive: true });
  // Crash leftovers from interrupted diffs/commits (inert — nothing reads
  // them — but they waste space and confuse): sweep only our own prefixes.
  // Plain staging copies, so plain rm suffices (unlike upper/work debris).
  for (const name of readdirSync(basedir)) {
    if (name.startsWith('stage-') || name.startsWith('merged-')) {
      rmSync(join(basedir, name), { recursive: true, force: true });
    }
  }
  if (existsSync(manifest)) {
    let prev;
    try {
      prev = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      throw new Error(`sbx: overlay record for agent '${agent}' is corrupt (${manifest}); remove it and retry`);
    }
    if (prev.proj !== proj) {
      throw new Error(`sbx: overlay for agent '${agent}' belongs to ${prev.proj}, not ${proj} (use a different agent or runtime)`);
    }
  }
  if (walkLocal(upper, ign).size > 0) {
    throw new Error(`sbx: agent '${agent}' has uncommitted overlay changes (review with 'sbx diff', then 'sbx commit' or 'sbx rollback')`);
  }
  emptyDir(work); // kernel scratch: safe to drop, never user data
  /** @type {Record<string, string|null>} */
  const base = {};
  for (const [rel, e] of walkLocal(proj, ign)) base[rel] = fpOf(e);
  writeFileSync(manifest, JSON.stringify({
    version: MANIFEST_VERSION, proj, ignore: [...ign], createdAt: new Date().toISOString(), base,
  }));
  return { upper, work };
}

function loadOverlay({ runtime, agent }) {
  assertAgentName(agent);
  const { base: scratch, upper, work, manifest } = overlayPaths(runtime, agent);
  let m;
  try {
    m = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    throw Object.assign(
      new Error(`sbx: no overlay for agent '${agent}' in ${runtime} (nothing was launched with overlay here)`),
      { code: 'SBX_NO_OVERLAY' });
  }
  if (!m || m.version !== MANIFEST_VERSION || typeof m.proj !== 'string' || typeof m.base !== 'object' || !m.base) {
    throw new Error(`sbx: overlay record for agent '${agent}' is corrupt (${manifest}); remove it and retry`);
  }
  return {
    scratch, upper, work, proj: /** @type {string} */ (m.proj),
    ignore: new Set(/** @type {string[]} */ (m.ignore ?? [])),
    base: new Map(Object.entries(/** @type {Record<string, string|null>} */ (m.base))),
  };
}

// --- merged-view mounts (the only reader of whiteouts/opaques) --------------

// Proven minimal prefix: the launcher's own `/usr` bind plus the lib64
// symlink every dynamic binary needs (M0 gotcha), and nothing else — no agent
// code ever runs in these mounts, only our fixed find/cp commands.
const BWRAP_PREFIX = ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib64', '/lib64'];

/**
 * `find` over the merged view, pruning ignored dir segments (Q3: big trees
 * stay cheap). `target` is a shell expression (always `'$M'` here), hence the
 * double quotes — it must expand, unlike `sq()`-quoted literals.
 */
function findCmd(target, ignore, action) {
  let cmd = `/usr/bin/find "${target}" -mindepth 1`;
  if (ignore.size) {
    const alts = [...ignore].map((n) => `-name ${sq(escName(n))}`).join(' -o ');
    cmd += ` \\( -type d \\( ${alts} \\) -prune \\) -o`;
  }
  return `${cmd} ${action}`;
}

/**
 * Run one bwrap overlay mount with a fixed inner command, returning its
 * stdout. `script` is built from the fresh merged-view dir (unknown until
 * the mount dir exists). The mount is private to the child and vanishes when
 * it exits; the staging dir is removed here. Throws loudly on any failure —
 * a missing or partial view must never feed a diff or commit.
 */
/**
 * @param {object} o
 * @param {string} o.lower real project dir (read-only source)
 * @param {string} o.upper per-run upper dir
 * @param {string} o.work overlay work dir (empty at mount)
 * @param {(merged: string) => string} o.script inner `sh -c` program built from the fresh merged-view dir
 * @param {string} o.scratch runtime-side dir for mount scratch (merged view, staging)
 * @param {string} [o.input] stdin for the inner program
 * @returns {string} the inner program's stdout
 */
function bwrapOverlay({ lower, upper, work, script, scratch, input }) {
  // All mount scratch (merged view, staging) lives under the runtime dir —
  // never /tmp: some sandboxes mask or snapshot /tmp, and same-fs staging
  // keeps the copies cheap.
  mkdirSync(scratch, { recursive: true });
  const merged = mkdtempSync(join(scratch, 'merged-'));
  try {
    const res = spawnSync('bwrap',
      [...BWRAP_PREFIX, '--overlay-src', lower, '--overlay', upper, work, merged,
        '--', '/usr/bin/sh', '-c', script(merged), 'sh'],
      {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
        ...(input !== undefined ? { input } : {}),
      });
    if (res.error) {
      throw new Error(`sbx: overlay view failed (${res.error.message}; diff/commit need bwrap)`);
    }
    if (res.status !== 0) {
      throw new Error(`sbx: overlay view failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
    }
    return res.stdout ?? '';
  } finally {
    rmSync(merged, { recursive: true, force: true });
  }
}

/**
 * Read the agent-visible tree: structure (kind, mode, symlink target) plus
 * sha256 per regular file, NUL-delimited throughout so hostile names
 * (spaces, newlines) parse exactly. One mount, so structure and hashes are a
 * single atomic snapshot — a mid-run `sbx diff` peek cannot mix two moments.
 */
function readMergedManifest({ lower, upper, work, ignore, scratch }) {
  // Hash records carry merged-view absolute paths; the struct side is
  // already relative (%P). Both reduce to the same relpath.
  let mergedDir = '';
  const script = (merged) => {
    mergedDir = merged;
    return [
      `M=${sq(merged)}`,
      `${findCmd('$M', ignore, `-printf '%y\\0%m\\0%P\\0%l\\0'`)}`,
      `/usr/bin/printf '\\000\\000SBX-HASHES\\000\\000'`,
      `${findCmd('$M', ignore, `-type f -exec /usr/bin/sha256sum -z {} +`)}`,
    ].join('\n');
  };
  const out = bwrapOverlay({ lower, upper, work, script, scratch });
  const mi = out.indexOf(MARKER);
  if (mi < 0 || out.indexOf(MARKER, mi + 1) >= 0) {
    throw new Error('sbx: overlay view returned no manifest (agent storage changed mid-read; retry)');
  }
  /** @type {Map<string, {type: string, mode: number, hash?: string, target?: string}>} */
  const merged = new Map();
  const struct = out.slice(0, mi).split('\0');
  if (struct.length && struct[struct.length - 1] === '') struct.pop();
  if (struct.length % 4 !== 0) throw new Error('sbx: overlay view returned a truncated file list (retry)');
  for (let i = 0; i < struct.length; i += 4) {
    const [type, modeOct, rel, target] = [struct[i], struct[i + 1], struct[i + 2], struct[i + 3]];
    assertSafeRel(rel);
    const mode = parseInt(modeOct, 8);
    if (!type || Number.isNaN(mode)) throw new Error('sbx: overlay view returned a malformed file list (retry)');
    merged.set(rel, { type, mode, ...(type === 'l' ? { target } : {}) });
  }
  for (const rec of out.slice(mi + MARKER.length).split('\0')) {
    if (!rec) continue;
    const hash = rec.slice(0, 64);
    const p = rec.slice(66);
    if (!/^[0-9a-f]{64}$/.test(hash) || !p.startsWith(`${mergedDir}/`)) {
      throw new Error('sbx: overlay view returned a malformed hash list (retry)');
    }
    const rel = p.slice(mergedDir.length + 1);
    assertSafeRel(rel);
    const e = merged.get(rel);
    if (!e || e.type !== 'f') throw new Error('sbx: overlay view is inconsistent (retry)');
    e.hash = hash;
  }
  for (const [rel, e] of merged) {
    if (e.type === 'f' && !e.hash) throw new Error('sbx: overlay view dropped a file hash (retry)');
  }
  return merged;
}

/**
 * Copy the merged view's changed regular files to a host staging dir: a
 * dot-dir inside the upper, addressed through the merged view (one mount;
 * the file list travels on stdin, argv-safe for any name). Through-the-merge
 * addressing is deliberate: only the fresh merged mount is guaranteed
 * visible on both sides everywhere (session-created host paths are not, in
 * some sandboxes). Symlinks and dirs need no extraction: targets come from
 * the manifest, dirs from mkdir. The staging dir vanishes with the
 * post-commit upper clear (or the `finally` below); a crash mid-extract
 * leaves it shouting in the upper until `rollbackOverlay`.
 */
function extractToStage({ lower, upper, work, files, scratch }) {
  const stageName = `.sbx-stage-${process.pid}-${randomBytes(4).toString('hex')}`;
  const stage = join(upper, stageName);
  if (!files.length) return stage;
  const script = (merged) => [
    `M=${sq(merged)}`,
    `T="$M/${stageName}"`,
    'while IFS= read -r -d \'\' r; do',
    '  case "$r" in \'\'|/*|../*|*/../*|*/..) exit 10;; esac',
    '  d=${r%/*}; [ "$d" = "$r" ] && d=.',
    '  /usr/bin/mkdir -p "$T/$d" || exit 11',
    '  /usr/bin/cp -a "$M/$r" "$T/$r" || exit 12',
    'done',
  ].join('\n');
  try {
    bwrapOverlay({ lower, upper, work, script, scratch, input: `${files.join('\0')}\0` });
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return stage;
}

// --- applying the merged view to the project (host side, no mount) ---------

/** Recursive delete that never touches ignored segments (Q3 invisibility is total). */
function rmLowerRecursive(abs, rel, ignore) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isDirectory() || isIgnored(rel, ignore)) {
    // A file/symlink/whiteout — or an ignored subtree, which the layer
    // never sees: leave it (an ignored dir under a deleted parent stays).
    if (!st.isDirectory()) rmSync(abs, { force: true });
    return;
  }
  for (const name of readdirSync(abs)) rmLowerRecursive(join(abs, name), `${rel}/${name}`, ignore);
  // rmdir, not rm: a recursive rm here would take the ignored subtrees the
  // loop just spared. Leftover ignored content keeps the dir alive
  // (ENOTEMPTY) — that is the point of ignoring it, not a failure.
  try {
    rmdirSync(abs);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(code)) throw e;
  }
}

/** Fingerprint one project path right now (re-verify step), or null when absent. */
function fpNow(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  const type = kindOf(st);
  if (type === 'f') {
    return fpOf({ type, mode: st.mode & 0o7777, hash: createHash('sha256').update(readFileSync(abs)).digest('hex') });
  }
  if (type === 'l') return fpOf({ type, mode: st.mode & 0o7777, target: readlinkSync(abs) });
  return fpOf({ type, mode: st.mode & 0o7777 });
}

function removeExisting(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return;
    throw e;
  }
  // copyFileSync follows symlinks and rmdir refuses files: clear first so a
  // file/dir/symlink swap lands exactly, never merged into what was there.
  rmSync(abs, { recursive: true, force: true });
}

function exoticName(type) {
  if (type === 'p') return 'a fifo';
  if (type === 's') return 'a socket';
  if (type === 'c' || type === 'b') return 'a device node';
  if (type === '?') return 'an unknown file kind';
  return `kind '${type}'`;
}

/** Shared core: load, walk project + merged view, compare against the snapshot. */
function diffLoaded(ov) {
  if (!existsSync(ov.proj)) {
    throw new Error(`sbx: project ${ov.proj} is gone (cannot diff an overlay without its lower)`);
  }
  if (walkLocal(ov.upper, ov.ignore).size === 0) {
    return { changes: /** @type {OverlayChange[]} */ ([]), lowerFps: null };
  }
  const merged = readMergedManifest({
    lower: ov.proj, upper: ov.upper, work: ov.work, ignore: ov.ignore, scratch: ov.scratch,
  });
  const lower = walkLocal(ov.proj, ov.ignore);
  /** @type {Map<string, string|null>} */
  const lowerFps = new Map([...lower].map(([rel, e]) => [rel, fpOf(e)]));
  return { changes: computeChanges(ov.base, lower, merged), lowerFps };
}

/**
 * Review one run's tracing paper: every file the sandbox added, modified or
 * deleted, each flagging a project change made after the run started.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to read
 * @returns {OverlayChange[]} one entry per added/modified/deleted path, each flagging a mid-run project change
 * @when Reach for this to review one run's tracing paper: it lists every file the sandboxed run added, modified or deleted, flagging the ones the project changed meanwhile.
 * @fails Throws when no overlay exists for the agent, when the project is gone, or when the overlay view cannot be mounted; never writes anything.
 * @example
 * import { diffOverlay } from "barebox";
 * const changes = diffOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * for (const c of changes) console.log(c.status, c.path, c.conflict ? "(CONFLICT)" : "");
 */
export function diffOverlay({ runtime, agent }) {
  return diffLoaded(loadOverlay({ runtime, agent })).changes;
}

/**
 * Press one run's tracing paper down: copy the sandbox's added and modified
 * files into the project and apply its deletions, then start a fresh sheet.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to commit
 * @param {string} [opts.onConflict] `refuse` (default) throws before writing anything; `skip` commits the rest and reports the skipped paths
 * @returns {{committed: string[], skipped: {path: string, reason: string}[]}} committed project-relative paths, plus conflicts left uncommitted under `skip`
 * @when Reach for this to press one run's tracing paper down: it copies the sandbox's added and modified files into the project and applies its deletions, refusing loudly on mid-run conflicts.
 * @fails Throws (writing nothing) when any changed file was also changed in the project mid-run, unless onConflict is `skip`; throws on unsupported file kinds and on a project that moved mid-commit.
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
  const { changes, lowerFps } = diffLoaded(ov);
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
  let stage = null;
  try {
    const needFiles = apply.filter((c) => c.status !== 'deleted' && c.type === 'f').map((c) => c.path);
    stage = extractToStage({
      lower: ov.proj, upper: ov.upper, work: ov.work, files: needFiles, scratch: ov.scratch,
    });
    // The project may have moved under us between the diff walk and now:
    // re-check exactly the paths about to be written, while nothing is.
    if (lowerFps) {
      for (const c of apply) {
        // Absent paths fingerprint as null on both sides (`?? null`: the
        // map holds no key where fpNow reads ENOENT).
        if (fpNow(join(ov.proj, c.path)) !== (lowerFps.get(c.path) ?? null)) {
          throw new Error(`sbx: project changed during commit at ${c.path} (nothing was applied; retry)`);
        }
      }
    }
    /** @type {string[]} */
    const goneDirs = [];
    for (const c of apply) {
      if (goneDirs.some((d) => c.path.startsWith(`${d}/`))) continue; // removed with its parent
      const dest = join(ov.proj, c.path);
      if (c.status === 'deleted') {
        rmLowerRecursive(dest, c.path, ov.ignore);
        goneDirs.push(c.path);
      } else if (c.type === 'd') {
        // Same-kind dir: take the mode, keep the contents — an rm + mkdir
        // would wipe ignored subtrees (Q3) the layer must never touch. Only
        // a genuine type change clears the path (see removeExisting).
        let st = null;
        try {
          st = lstatSync(dest);
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }
        if (!st) {
          mkdirSync(dest, { recursive: true });
        } else if (!st.isDirectory()) {
          removeExisting(dest);
          mkdirSync(dest, { recursive: true });
        }
        chmodSync(dest, /** @type {number} */ (c.mode));
      } else if (c.type === 'l') {
        removeExisting(dest);
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(/** @type {string} */ (c.target), dest);
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        removeExisting(dest);
        copyFileSync(join(/** @type {string} */ (stage), c.path), dest);
        chmodSync(dest, /** @type {number} */ (c.mode));
      }
    }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
  // A skipped conflict stays on the paper (clearing it would drop work
  // silently); a full commit starts a fresh sheet, including the no-op case.
  if (!skipped.length) {
    emptyDir(ov.upper);
    emptyDir(ov.work);
  }
  return { committed: apply.map((c) => c.path), skipped };
}

/**
 * Throw one run's tracing paper away: drop every sandboxed change and leave the project exactly as it was.
 *
 * @param {object} opts
 * @param {string} opts.runtime runtime dir holding the run's overlay (`<runtime>/overlay/<agent>`)
 * @param {string} opts.agent agent name whose upper to discard
 * @returns {{discarded: OverlayChange[]}} the changes that were dropped
 * @when Reach for this to throw one run's tracing paper away: it drops every sandboxed change and leaves the project exactly as it was.
 * @fails Throws when no overlay exists for the agent; dropping the upper never touches the project.
 * @example
 * import { rollbackOverlay } from "barebox";
 * const { discarded } = rollbackOverlay({ runtime: "/tmp/sbx-abc", agent: "agent" });
 * console.log(`discarded ${discarded.length} change(s)`);
 */
export function rollbackOverlay({ runtime, agent }) {
  const ov = loadOverlay({ runtime, agent });
  const { changes } = diffLoaded(ov);
  emptyDir(ov.upper);
  emptyDir(ov.work);
  return { discarded: changes };
}
