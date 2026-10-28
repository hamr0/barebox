// runtime.js — the single writer of the runtime folder layout.
//
// Every path both sides agree on lives here: the proxy socket, the hold
// queue's ask/answer files, the certificates dir, the CA bundle, the audit
// log, and the overlay record. Import layout from here; no other module
// names these paths. (The sandbox launcher used to import them from the
// TLS proxy just to get a filename.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
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

/** @param {string} owner owner file path @returns {unknown} the pid it names, or 'unknown' when missing, empty or garbage */
function pidOf(owner) {
  try {
    return JSON.parse(fs.readFileSync(owner, 'utf8'))?.pid ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** @param {string} runtime runtime dir @param {unknown} pid the holder @returns {Error} the one in-use error */
function inUseError(runtime, pid) {
  return new Error(
    `runtime ${runtime} is in use by pid ${String(pid)} (one proxy per runtime: use another SBX_RUNTIME, or leave it unset for a fresh one)`);
}

/**
 * Claim one runtime for one live proxy: the single enforcer of "one proxy
 * owns a runtime". The claim is an abstract unix socket the proxy binds for
 * as long as it lives (Linux). The kernel frees it when the process dies,
 * SIGKILL included, so a claim is never stale: nothing is judged, taken
 * over or deleted by hand. The name hashes the real path, device and inode,
 * so a symlinked path finds the same lock and a recreated dir gets a new one.
 * The bind result is synchronous (`server.listening` right after `listen`),
 * so a second claim, in this process or another, throws before the caller
 * touches the runtime. The lock is `unref`'d: it never keeps a process alive.
 * The owner file `{"pid"}` is written by the lock holder only, to name it in
 * the in-use message.
 *
 * @param {string} runtime runtime dir to claim
 * @returns {() => void} `release()`: unlinks the owner file only when it holds our pid, then closes the lock; idempotent
 */
export function claimRuntime(runtime) {
  fs.mkdirSync(runtime, { recursive: true });
  const real = fs.realpathSync(runtime);
  const st = fs.statSync(real);
  const owner = runtimePaths(real).owner;
  const name = '\0barebox-' + crypto.createHash('sha256')
    .update(`${real}\0${st.dev}\0${st.ino}`).digest('hex').slice(0, 32);
  const server = net.createServer((c) => c.destroy());
  server.on('error', () => {});
  server.listen(name);
  if (!server.listening) {
    throw inUseError(runtime, pidOf(owner));
  }
  server.unref();
  const tmp = `${owner}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, owner);
  } catch (e) {
    server.close();
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return () => {
    if (pidOf(owner) === process.pid) {
      try { fs.unlinkSync(owner); } catch {}
    }
    server.close();
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
