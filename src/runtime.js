// runtime.js — the single writer of the runtime folder layout.
//
// Every path both sides agree on lives here: the proxy socket, the hold
// queue's ask/answer files, the certificates dir, the CA bundle, the audit
// log, and the overlay record. Import layout from here; no other module
// names these paths. (The sandbox launcher used to import them from the
// TLS proxy just to get a filename.)
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
 * @returns {{ socket: (agent: string) => string, asksDir: string, answersDir: string, askFile: (id: string) => string, answerFile: (id: string) => string, certsDir: string, caBundle: string, audit: string, overlay: (agent: string) => { base: string, upper: string, work: string, manifest: string } }} layout
 */
export function runtimePaths(runtime) {
  const asksDir = path.join(runtime, 'asks');
  const answersDir = path.join(runtime, 'answers');
  return {
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
