// Secrets (M5): keys the agent never holds. The sandbox gets one random
// placeholder per secret; the proxy, outside it, swaps the real value into a
// request's headers only after the gate allowed it and only for a bound host.
// Pure: no I/O, no proxy state. Detect and apply are separate on purpose, so
// the real value is never in a request's headers while it waits for a decision.
import crypto from 'node:crypto';

/**
 * One loaded secret.
 *
 * @typedef {object} Secret
 * @property {string} name the variable name the sandbox sees the placeholder under
 * @property {string} value the real value; never leaves the proxy except in an allowed request's header
 * @property {string[]} hosts hostnames (no port) the real value may be sent to
 * @property {string} placeholder `sbx-ph-<16 hex>`, fresh per call
 */

/** Request headers as node reads them: lowercase names, string or string[] values. @typedef {Record<string, string | string[] | undefined>} Headers */

const BASIC = /^(Basic\s+)([A-Za-z0-9+/=_-]+)$/i;

/** @param {string} h @returns {string} */
const bare = (h) => h.toLowerCase();

/**
 * Read the secrets from the config shape and give each a fresh placeholder.
 *
 * @param {Record<string, { fromEnv?: string, value?: string, hosts: string[] }>} [config] the config `secrets` object
 * @param {NodeJS.ProcessEnv} [env] where `fromEnv` is read (default `process.env`)
 * @returns {Secret[]} one entry per secret, new placeholders on every call (so per run)
 * @throws {Error} naming the secret (never a value) when it has no value or no hosts
 */
export function loadSecrets(config = {}, env = process.env) {
  return Object.entries(config).map(([name, c]) => {
    const value = c.fromEnv !== undefined ? env[c.fromEnv] : c.value;
    if (typeof value !== 'string' || !value) throw new Error(`secret ${name}: no value`);
    if (!Array.isArray(c.hosts) || !c.hosts.length) throw new Error(`secret ${name}: hosts required`);
    return { name, value, hosts: c.hosts.map(bare), placeholder: `sbx-ph-${crypto.randomBytes(8).toString('hex')}` };
  });
}

/**
 * Does `v` hold the secret's placeholder, plainly or inside `Basic <base64>`?
 * @param {string} v @param {Secret} s @returns {'plain'|'basic'|null}
 */
function kindIn(v, s) {
  if (v.includes(s.placeholder)) return 'plain';
  const m = BASIC.exec(v);
  if (m && Buffer.from(m[2], 'base64').toString('latin1').includes(s.placeholder)) return 'basic';
  return null;
}

/**
 * @param {string} v one header value @param {Secret} s @returns {string} `v` with the real value in place
 */
function swapIn(v, s) {
  const kind = kindIn(v, s);
  if (kind === 'plain') return v.split(s.placeholder).join(s.value);
  if (kind === 'basic') {
    const m = /** @type {RegExpExecArray} */ (BASIC.exec(v));
    const dec = Buffer.from(m[2], 'base64').toString('latin1');
    // latin1 keeps every byte; the value goes in as its UTF-8 bytes.
    const real = Buffer.from(s.value, 'utf8').toString('latin1');
    return m[1] + Buffer.from(dec.split(s.placeholder).join(real), 'latin1').toString('base64');
  }
  return v;
}

/**
 * Which secrets' placeholders sit in a request URL (path and query). Keys are swapped in headers only.
 * @param {string} pathAndQuery @param {Secret[]} secrets @returns {string[]} the secrets' names
 */
export function urlPlaceholders(pathAndQuery, secrets) {
  return secrets.filter((s) => pathAndQuery.includes(s.placeholder)).map((s) => s.name);
}

/**
 * Which placeholders a request carries, and whether each is headed for a host its secret is bound to.
 * Each header value is searched as a substring and, for `Basic <base64>`, decoded.
 *
 * @param {Headers} headers the request headers
 * @param {string} host the request's hostname (no port)
 * @param {Secret[]} secrets from {@link loadSecrets}
 * @returns {{ name: string, header: string, bound: boolean }[]} one entry per (secret, header)
 */
export function findPlaceholders(headers, host, secrets) {
  const h = bare(host);
  const found = [];
  for (const [header, v] of Object.entries(headers)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const s of secrets) {
      if (vals.some((x) => typeof x === 'string' && kindIn(x, s))) {
        found.push({ name: s.name, header, bound: s.hosts.includes(h) });
      }
    }
  }
  return found;
}

/**
 * The headers with every bound placeholder replaced by its real value. A new
 * object; the input (which the agent's request owns) is never changed.
 * Placeholders of a secret not bound to `host` stay as they are.
 *
 * @param {Headers} headers the request headers
 * @param {string} host the request's hostname (no port)
 * @param {Secret[]} secrets from {@link loadSecrets}
 * @returns {Headers} new headers
 */
export function applySecrets(headers, host, secrets) {
  const h = bare(host);
  const bound = secrets.filter((s) => s.hosts.includes(h));
  /** @type {Headers} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    /** @param {string} x @returns {string} */
    const one = (x) => bound.reduce((acc, s) => swapIn(acc, s), x);
    out[k] = Array.isArray(v) ? v.map(one) : (typeof v === 'string' ? one(v) : v);
  }
  return out;
}
