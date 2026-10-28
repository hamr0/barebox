// runtime.js — the single writer of the runtime folder layout.
//
// Every path both sides agree on lives here: the proxy socket, the hold
// queue's ask/answer files, the certificates dir, the CA bundle, the audit
// log, and the overlay record. Import layout from here; no other module
// names these paths. (The sandbox launcher used to import them from the
// TLS proxy just to get a filename.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Linux sun_path: 108 bytes including the NUL.
const MAX_SOCK_PATH = 107;

/**
 * Check an agent name before it reaches the filesystem.
 *
 * @param {string} name agent name
 * @returns {void} throws on `../` and friends
 */
export function assertAgentName(name) {
  if (!AGENT_RE.test(name || '')) {
    throw new Error(`bad agent name ${JSON.stringify(name)}: must match ${AGENT_RE}`);
  }
}

/**
 * Resolve symlinks through the nearest existing ancestor: socket paths may
 * not exist yet, so `realpathSync` on the full path would throw. Walks up
 * to the first existing ancestor, resolves that, then re-attaches the rest.
 *
 * @param {string} p any path, existing or not
 * @returns {string} the real (symlink-free) spelling of `p`
 */
export function realPathOf(p) {
  const abs = path.resolve(p);
  let cur = abs;
  /** @type {string[]} */
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const real = fs.realpathSync(cur);
  return rest.length ? path.join(real, ...rest) : real;
}

/**
 * True when `p` is `base` or lives under it, compared as real (symlink-free)
 * paths, so a symlinked spelling cannot smuggle a path out.
 *
 * @param {string} base container path
 * @param {string} p path to test
 * @returns {boolean} containment on real paths
 */
export function isInside(base, p) {
  const realB = realPathOf(base);
  const realP = realPathOf(p);
  if (realP === realB) return true;
  const prefix = realB.endsWith(path.sep) ? realB : realB + path.sep;
  return realP.startsWith(prefix);
}

/**
 * Create a short-lived runtime dir: a short `sbx-` temp dir, keeping unix
 * socket paths under the ~108-char limit.
 *
 * @returns {string} the new runtime dir
 */
export function createRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
}

/**
 * Create a temp dir inside the runtime tree: `mkdtemp` is a runtime-layout
 * writer, so it lives here, not in `overlay.js`. Used for the merged-view
 * mount (`merged`) and the walker manifest dir (`walk`).
 *
 * @param {string} scratch overlay record dir (`overlay/<agent>`)
 * @param {string} prefix dir prefix (`merged`, `walk`)
 * @returns {string} the new dir
 */
export function runtimeTempDir(scratch, prefix) {
  return fs.mkdtempSync(path.join(scratch, `${prefix}-`));
}

/**
 * This process's start time: field 22 (`starttime`) of `/proc/<pid>/stat`,
 * parsed after the last `)` (the command name may itself hold parens and
 * spaces). Pid plus start time identifies a process even after its pid is
 * reused. Linux-only, like the rest of the sandbox.
 *
 * @param {number} pid process id to read
 * @returns {string|null} the start time, or null when the process is gone
 */
function procStart(pid) {
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  // Fields after the command run from field 3 (state): field 22 sits at 19.
  return afterComm.length >= 20 ? afterComm[19] : null;
}

/** @param {string} owner owner file path @returns {{pid?: unknown, start?: unknown}|null} the claim, or null when missing, empty or garbage */
function readClaim(owner) {
  try {
    return JSON.parse(fs.readFileSync(owner, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} runtime runtime dir @param {unknown} pid the holder @returns {Error} the one in-use error */
function inUseError(runtime, pid) {
  return new Error(
    `runtime ${runtime} is in use by pid ${String(pid)} (one proxy per runtime: use another SBX_RUNTIME, or leave it unset for a fresh one)`);
}

/**
 * Create `owner` holding `claim`, whole or not at all: write a temp file,
 * then hard-link it into place. `link` fails with EEXIST when `owner`
 * exists, and `owner` can never be seen empty by a second starter.
 *
 * @param {string} owner owner file path
 * @param {unknown} claim JSON-serializable claim
 * @returns {void} throws EEXIST when `owner` exists
 */
function createOwner(owner, claim) {
  const body = JSON.stringify(claim);
  const tmp = `${owner}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
    fs.linkSync(tmp, owner);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** @param {{pid?: unknown, start?: unknown}|null} claim a parsed claim @returns {boolean} true when its holder is still the same live process */
function isLive(claim) {
  const pid = claim?.pid;
  return typeof pid === 'number' && claim?.start !== undefined
    && procStart(pid) !== null && procStart(pid) === claim.start;
}

/** @param {string} owner owner file path @returns {string|null} the raw bytes, or null when absent */
function readRaw(owner) {
  try {
    return fs.readFileSync(owner, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/** @param {string} raw owner bytes @returns {unknown} the claim's pid, or 'unknown' */
function pidOf(raw) {
  try {
    return JSON.parse(raw)?.pid ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Replace an owner file judged stale, without ever removing it. One marker
 * `owner.takeover-<id>` (id = hash of the exact stale bytes) is taken
 * exclusively; its unique holder re-reads `owner` and, only if it still
 * holds those bytes, atomically renames our claim over it. Safe because the
 * only writer that replaces content S is the holder of marker-S, and a live
 * claim is never judged stale, so it has no taker. `owner` is never absent
 * during a takeover, so a fresh starter's `createOwner` always collides.
 * A marker whose holder died fails closed: removing it would reopen the
 * race. Exported for tests, the way `changedSince` is in `overlay.js`.
 *
 * @param {string} runtime runtime dir
 * @param {string} judgedRaw the exact owner bytes judged stale (may be empty)
 * @param {unknown} mine our claim
 * @returns {void} throws "in use by pid N" when someone else holds the runtime
 */
export function takeOverStale(runtime, judgedRaw, mine) {
  const owner = runtimePaths(runtime).owner;
  const id = crypto.createHash('sha256').update(judgedRaw).digest('hex').slice(0, 16);
  const marker = `${owner}.takeover-${id}`;
  try {
    createOwner(marker, mine);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
    const holder = readClaim(marker);
    if (isLive(holder)) throw inUseError(runtime, holder?.pid);
    throw new Error(`stale takeover marker ${marker} (pid ${String(holder?.pid ?? 'unknown')} is gone): delete it to reuse this runtime`);
  }
  try {
    const cur = readRaw(owner);
    if (cur === judgedRaw) {
      const tmp = `${owner}.tmp-${crypto.randomBytes(8).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, owner);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } else if (cur === null) {
      try {
        createOwner(owner, mine);
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
        throw inUseError(runtime, pidOf(readRaw(owner) ?? ''));
      }
    } else {
      throw inUseError(runtime, pidOf(cur));
    }
  } finally {
    try { fs.unlinkSync(marker); } catch {}
  }
}

/**
 * Claim one runtime for one live proxy: the single enforcer of "one proxy
 * owns a runtime". The owner file holds `{"pid","start"}` 0600; pid plus
 * start time survives pid reuse, and a second proxy in the same process is
 * refused like any other second owner. A stale owner is replaced by
 * `takeOverStale`, never removed.
 *
 * @param {string} runtime runtime dir to claim
 * @returns {() => void} `release()`: deletes the owner file only when it still holds our pid and start time, so another process's claim is never removed; idempotent
 */
export function claimRuntime(runtime) {
  const owner = runtimePaths(runtime).owner;
  fs.mkdirSync(runtime, { recursive: true });
  const mine = { pid: process.pid, start: procStart(process.pid) };
  try {
    createOwner(owner, mine);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
    const raw = readRaw(owner) ?? '';
    let cur = null;
    try { cur = JSON.parse(raw); } catch {}
    if (isLive(cur)) throw inUseError(runtime, cur.pid);
    takeOverStale(runtime, raw, mine);
  }
  return () => {
    const cur = readClaim(owner);
    if (cur?.pid === mine.pid && cur?.start === mine.start) {
      try { fs.unlinkSync(owner); } catch {}
    }
  };
}

/**
 * Strip terminal control before printing agent-controlled bytes (ask URLs,
 * rules, body previews, overlay paths): an escape sequence smuggled into a
 * preview could otherwise rewrite the approver's terminal line before
 * approval, and bidi controls in an agent-chosen filename could flip how a
 * reviewed path reads.
 *
 * @param {unknown} s value to print
 * @returns {string} printable text with no VT sequences, C0/C1 controls, or bidi controls
 */
export function safe(s) {
  return stripVTControlCharacters(String(s ?? ''))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * Every path in a runtime dir. The one place that names them.
 *
 * @param {string} runtime runtime dir
 * @returns {{ socket: (agent: string) => string, asksDir: string, answersDir: string, askFile: (id: string) => string, answerFile: (id: string) => string, certsDir: string, caBundle: string, audit: string, owner: string, overlay: (agent: string) => { base: string, upper: string, work: string, manifest: string } }} layout
 */
export function runtimePaths(runtime) {
  const asksDir = path.join(runtime, 'asks');
  const answersDir = path.join(runtime, 'answers');
  return {
    owner: path.join(runtime, 'owner'),
    asksDir,
    answersDir,
    askFile: (id) => path.join(asksDir, `${id}.json`),
    answerFile: (id) => path.join(answersDir, `${id}.json`),
    /**
     * The one path both sides agree on: the proxy listens here, the
     * launcher binds it into the sandbox.
     */
    socket: (agent) => {
      assertAgentName(agent);
      const p = path.join(runtime, 'socks', `${agent}.sock`);
      if (p.length > MAX_SOCK_PATH) {
        throw new Error(`agent socket path too long (${p.length} > ${MAX_SOCK_PATH}): ${p}`);
      }
      return p;
    },
    certsDir: path.join(runtime, 'certs'),
    caBundle: path.join(runtime, 'ca-bundle.pem'),
    audit: path.join(runtime, 'audit.jsonl'),
    overlay: (agent) => {
      const base = path.join(runtime, 'overlay', agent);
      return {
        base,
        upper: path.join(base, 'upper'),
        work: path.join(base, 'work'),
        manifest: path.join(base, 'manifest.json'),
      };
    },
  };
}
