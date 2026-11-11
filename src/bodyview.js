// The body view: the one owner of "what a request body says". It gives the
// proxy a view of a body that fits the 64 KB working slot, decoded when it is
// gzip or deflate. The card scan and the ask preview read the view; forwarding never does (the upstream keeps
// the original compressed bytes).
//
// Decoding goes through ONE proxy-wide queue (one decoder at a time): compressed
// request bodies are rare, so the queue costs almost no wait and bounds a burst
// of bombs to one live decoder (PRD section 9, "M10 decisions"). Output stops at
// 64 KB with destroy(): zlib's maxOutputLength throws instead of truncating, and
// without destroy() a bomb keeps inflating. A body that does not decode
// is scanned as sent (partial output first); a gzip member followed by garbage
// is not decoded by Node's zlib, a known gap (PRD section 10).
import zlib from 'node:zlib';

const CAP = 65536;
// Looked up by name at call time, so a test can wrap the factory and count decoders.
const MAKE = { gzip: 'createGunzip', 'x-gzip': 'createGunzip', deflate: 'createInflate' };

/**
 * @typedef {object} BodyView
 * @property {Buffer} text the body as the proxy reads it (decoded when `state` is decoded or truncated)
 * @property {'plain'|'decoded'|'truncated'|'unread'} state plain: sent as is; decoded: gzip/deflate fully
 *   decoded; truncated: decoding stopped at 64 KB of output; unread: not decoded or broken, `text` is the
 *   raw bytes (after any output decoded before the error)
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
  const run = (/** @type {string} */ make) => new Promise((resolve) => {
    const z = /** @type {import('node:zlib').Gunzip} */ (zlib[/** @type {'createGunzip'} */ (make)]());
    /** @type {Buffer[]} */
    const out = [];
    let n = 0;
    // nothing decoded: the raw buffer itself; else the partial output, then the raw bytes
    const raw = () => (out.length ? Buffer.concat([...out, buf]) : buf);
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
    z.on('error', () => { result ??= { text: raw(), state: 'unread' }; });
    z.on('close', () => resolve(result ?? { text: raw(), state: 'unread' }));
    z.end(buf);
  });
  return run(factory).then((r) => (
    // raw deflate has no zlib header: when inflate emitted nothing, try it once as raw
    factory === 'createInflate' && r.state === 'unread' && r.text === buf ? run('createInflateRaw') : r));
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
  return { text, state };
}
