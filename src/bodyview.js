// The body view: the one owner of "what a request body says". It gives the
// proxy a view of a body that fits the 64 KB working slot, decoded when it is
// gzip or deflate, plus `get(path)` over JSON and form fields. The card scan
// and the ask preview read the view; forwarding never does (the upstream keeps
// the original compressed bytes).
//
// Decoding goes through ONE proxy-wide queue (one decoder at a time): compressed
// request bodies are rare, so the queue costs almost no wait and bounds a burst
// of bombs to one live decoder (PRD section 9, "M10 decisions"). Output stops at
// 64 KB with destroy(): zlib's maxOutputLength throws instead of truncating, and
// without destroy() a bomb keeps inflating.
import zlib from 'node:zlib';

const CAP = 65536;
// Looked up by name at call time, so a test can wrap the factory and count decoders.
const MAKE = { gzip: 'createGunzip', 'x-gzip': 'createGunzip', deflate: 'createInflate' };

/**
 * @typedef {object} BodyView
 * @property {Buffer} text the body as the proxy reads it (decoded when `state` is decoded or truncated)
 * @property {'plain'|'decoded'|'truncated'|'unread'} state plain: sent as is; decoded: gzip/deflate fully
 *   decoded; truncated: decoding stopped at 64 KB of output; unread: not decoded, `text` is the raw bytes
 * @property {(path: string) => unknown} get a JSON value by dotted path (array indexes as numbers) or the
 *   first value of a form key; undefined when absent or the body is not a readable JSON or form body
 */

/**
 * Decode up to 64 KB of a gzip/deflate body. Resolves on the stream's close,
 * so the queue never starts the next decoder while this one is still alive.
 *
 * @param {Buffer} buf compressed body
 * @param {string} factory zlib factory name
 * @returns {Promise<{ text: Buffer, state: 'decoded'|'truncated'|'unread' }>} decode result
 */
function decodeRaw(buf, factory) {
  return new Promise((resolve) => {
    const z = /** @type {import('node:zlib').Gunzip} */ (zlib[/** @type {'createGunzip'} */ (factory)]());
    /** @type {Buffer[]} */
    const out = [];
    let n = 0;
    /** @type {{ text: Buffer, state: 'decoded'|'truncated'|'unread' }|null} */
    let result = null;
    z.on('data', (/** @type {Buffer} */ c) => {
      if (result) return;
      out.push(c);
      n += c.length;
      if (n >= CAP) {
        result = { text: Buffer.concat(out, CAP), state: 'truncated' };
        z.destroy();
      }
    });
    z.on('end', () => { result ??= { text: Buffer.concat(out), state: 'decoded' }; });
    z.on('error', () => { result ??= { text: buf, state: 'unread' }; });
    z.on('close', () => resolve(result ?? { text: buf, state: 'unread' }));
    z.end(buf);
  });
}

// One decoder at a time for the whole proxy; the tail never rejects.
let tail = Promise.resolve();

/**
 * @param {Buffer} buf the body (at most 64 KB as sent)
 * @param {Record<string, string | string[] | undefined>} headers request headers
 * @returns {Promise<BodyView>} the view
 */
export async function viewBody(buf, headers) {
  const enc = String(headers['content-encoding'] ?? '').trim().toLowerCase();
  let text = buf;
  /** @type {BodyView['state']} */
  let state = 'plain';
  if (enc !== '' && enc !== 'identity') {
    const factory = Object.hasOwn(MAKE, enc) ? MAKE[/** @type {keyof typeof MAKE} */ (enc)] : null;
    if (factory) {
      const p = tail.then(() => decodeRaw(buf, factory));
      tail = p.then(() => {}, () => {});
      ({ text, state } = await p);
    } else state = 'unread';
  }
  return { text, state, get: fieldGetter(text, state, headers) };
}

/**
 * @param {Buffer} text body text
 * @param {BodyView['state']} state view state
 * @param {Record<string, string | string[] | undefined>} headers request headers
 * @returns {(path: string) => unknown} lazy field reader; never throws
 */
function fieldGetter(text, state, headers) {
  const ct = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const readable = state === 'plain' || state === 'decoded';
  let tried = false;
  /** @type {unknown} */
  let parsed;
  const load = () => {
    tried = true;
    try {
      if (!readable) return;
      if (ct === 'application/json' || ct.endsWith('+json')) parsed = JSON.parse(text.toString('utf8'));
      else if (ct === 'application/x-www-form-urlencoded') parsed = new URLSearchParams(text.toString('utf8'));
    } catch { parsed = undefined; }
  };
  return (path) => {
    try {
      if (!tried) load();
      if (parsed === undefined) return undefined;
      if (parsed instanceof URLSearchParams) return parsed.get(path) ?? undefined;
      let cur = /** @type {any} */ (parsed);
      for (const k of String(path).split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        if (Array.isArray(cur) && !/^\d+$/.test(k)) return undefined;
        if (!Object.hasOwn(cur, k)) return undefined;
        cur = cur[k];
      }
      return cur;
    } catch { return undefined; }
  };
}
