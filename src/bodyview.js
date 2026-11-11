// The body view: the one owner of "what a request body says". It gives the
// proxy a view of a body that fits the 64 KB working slot, decoded when it is
// gzip or deflate. The card scan and the ask preview read the view; forwarding
// never does (the upstream keeps the original compressed bytes).
//
// The rule: decoding only adds to what is scanned. The raw bytes as sent are
// always scanned by the caller; any decoded output (full, truncated, partial
// before an error) is scanned as well, and the
// card floor fires if either scan finds a card. No decode outcome can then
// check a labelled body less than an unlabelled one.
//
// Decoding goes through ONE proxy-wide queue (one decoder at a time):
// compressed request bodies are rare, so the queue costs almost no wait and
// bounds a burst of bombs to one live decoder (PRD section 9, "M10
// decisions"). Output stops at 64 KB with destroy(): zlib's maxOutputLength
// throws instead of truncating, and without destroy() a bomb keeps inflating.
// A body that does not decode is viewed as sent (partial output first); a gzip
// member followed by garbage is not decoded by Node's zlib, a known gap (PRD
// section 10). Raw deflate (no zlib header) sent as `deflate` is not decoded
// either: it is viewed as sent, a known gap.
import zlib from 'node:zlib';

const CAP = 65536;
// Looked up by name at call time, so a test can wrap the factory and count decoders.
const MAKE = { gzip: 'createGunzip', 'x-gzip': 'createGunzip', deflate: 'createInflate' };

/**
 * @typedef {object} BodyView
 * @property {Buffer} text the decoded output when the body was decoded, else the body as sent;
 *   the caller must also scan the raw bytes
 * @property {'plain'|'decoded'|'truncated'|'unread'} state plain: sent as is; decoded: gzip/deflate fully
 *   decoded; truncated: decoding stopped at 64 KB of output; unread: not decoded or broken, `text` is the
 *   partial output decoded before the error, else the body as sent
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
    // on error: the partial output if any, else the body as sent
    const partial = () => (out.length ? Buffer.concat(out) : buf);
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
    z.on('error', () => { result ??= { text: partial(), state: 'unread' }; });
    z.on('close', () => resolve(result ?? { text: partial(), state: 'unread' }));
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
  return { text, state };
}
