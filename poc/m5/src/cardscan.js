// cardscan.js — card-number detection on a byte stream, pure (no I/O).
//
// A candidate is 13-19 digits, optionally grouped by single spaces or dashes
// between digits, touching no other digit, first digit 2-6 (card networks;
// this excludes millisecond timestamps, which start with 1), Luhn-valid.
// The scanner keeps a TAIL-byte tail between chunks so a number split across
// chunks is found; memory is constant whatever the body size. A candidate
// that ends exactly at the end of the data seen so far counts at once: the
// next chunk may continue the digit run, but an over-detect only asks more.

const TAIL = 40; // longest candidate: 19 digits + 18 separators = 37 bytes
const START = /(?<!\d)[2-6]/g; // a candidate starts on a digit 2-6 with no digit before it

/** @param {string} digits */
function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Every Luhn-valid candidate in `text`, as `{ index, text }`. At each start,
 * the candidates are the 13-19 digit prefixes (single space/dash between
 * digits allowed) whose next char is not a digit; the longest valid one wins.
 */
function candidates(text) {
  const out = [];
  START.lastIndex = 0;
  for (let m; (m = START.exec(text));) {
    let best = null;
    let digits = '';
    let i = m.index;
    for (;;) {
      digits += text[i++];
      if (digits.length >= 13 && !/\d/.test(text[i] ?? '') && luhn(digits)) best = i;
      if (digits.length === 19) break;
      if (/\d/.test(text[i] ?? '')) continue;
      if ((text[i] === ' ' || text[i] === '-') && /\d/.test(text[i + 1] ?? '')) i++;
      else break;
    }
    if (best) {
      out.push({ index: m.index, text: text.slice(m.index, best) });
      START.lastIndex = best;
    }
  }
  return out;
}

/**
 * Create a streaming card-number scanner.
 * @returns {{ push(chunk: Buffer): boolean, readonly found: boolean, readonly tailLength: number }}
 *   `push` returns `found`; `tailLength` is the retained byte count (<= 40).
 */
export function createCardScanner() {
  let found = false;
  let tail = '';
  let prevDigit = false; // was the byte just before `tail` a digit?
  return {
    push(chunk) {
      if (found) return true;
      const text = (prevDigit ? '0' : ' ') + tail + chunk.toString('latin1');
      if (candidates(text).length) found = true;
      const cut = Math.max(1, text.length - TAIL);
      tail = text.slice(cut);
      prevDigit = /\d/.test(text[cut - 1]);
      return found;
    },
    get found() { return found; },
    get tailLength() { return tail.length; },
  };
}

/**
 * Replace every card candidate's digits with `*` except the last 4,
 * keeping the separators.
 * @param {string} text
 * @returns {string}
 */
export function maskCards(text) {
  const found = candidates(text);
  let out = '';
  let at = 0;
  for (const c of found) {
    out += text.slice(at, c.index);
    let left = c.text.replace(/[ -]/g, '').length - 4;
    out += c.text.replace(/\d/g, (d) => (left-- > 0 ? '*' : d));
    at = c.index + c.text.length;
  }
  return out + text.slice(at);
}
