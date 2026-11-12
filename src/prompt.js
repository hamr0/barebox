// prompt.js — the same-terminal question for `sbx run`. Turns an ask record
// into a plain-language question on `output` and reads one answer line from
// `input`. It never writes answer files itself: it calls `answer(id,
// decision, reason)`, which the CLI binds to its one answer writer.
//
// Stale vs fresh: a line is an answer only if it arrives while a question is
// open, and it answers THAT question's id. Input that arrives with no
// question open is dropped (so a `y` typed during h1 never approves h2), and
// once a hold is decided elsewhere nothing is written for it.
import { safe } from './runtime.js';

const BODY_CHARS = 200;
const EOL = /\r\n|\r|\n/;
const YES = new Set(['y', 'yes']);

// Plain ANSI. Escapes are added only around text that already went through
// `safe()`, which strips every escape from agent bytes; never paint raw text.
export const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', unbold: '\x1b[22m', reset: '\x1b[0m' };

/**
 * Wrap already-sanitized text in escapes when `on`; plain text otherwise.
 *
 * @param {boolean} on whether color is enabled
 * @param {string} codes one or more ANSI.* escapes
 * @param {string} text sanitized text
 * @returns {string} the painted text
 */
export const paint = (on, codes, text) => (on ? `${codes}${text}${ANSI.reset}` : text);

/** @typedef {{ id: string, agent?: string, method: string, url: string, rule: string, letter: string, bodyPreview?: string, expiresAt?: string|null }} AskRecord */

/**
 * Plain-language lines for one ask record. Every agent-controlled byte goes
 * through `safe()`.
 *
 * @param {AskRecord} ask the parked request
 * @param {number} [now] clock for the countdown, injectable
 * @param {boolean} [color] paint with ANSI escapes (off by default)
 * @returns {string[]} the question, one string per line
 */
export function questionLines(ask, now = Date.now(), color = false) {
  const { bold, dim, red, green, yellow, cyan, unbold } = ANSI;
  const method = safe(ask.method).toUpperCase();
  let host;
  try { host = safe(new URL(ask.url).host); } catch { host = safe(ask.url); }
  const verb = method === 'POST' ? 'SEND data to'
    : method === 'PUT' || method === 'PATCH' ? 'CHANGE data on'
      : method === 'DELETE' ? 'DELETE data on'
        : `make a ${method} request to`;
  const rule = safe(ask.rule);
  const why = rule === 'flags.cardLike' ? 'it contains what looks like a card number'
    : rule === 'flags.paymentPath' ? 'the address looks like a payment'
      : ask.letter === 'w' ? 'a change (reversible: the vendor says it can be undone)'
        : ask.letter === 'x' ? "a change barebox can't undo"
          : rule;
  const left = ask.expiresAt ? Math.max(0, Math.round((Date.parse(ask.expiresAt) - now) / 1000)) : null;
  const name = safe(ask.agent) || 'agent';
  const head = color
    ? paint(true, yellow, `⏸  ${bold}${name}${unbold} wants to ${verb} ${host}`)
    : `⏸  ${name} wants to ${verb} ${host}`;
  const lines = [
    head,
    `   ${paint(color, bold, 'Why:')}  ${why}`,
    `   ${paint(color, bold, 'URL:')}  ${paint(color, cyan, `${method} ${safe(ask.url)}`)}`,
  ];
  const body = safe(ask.bodyPreview).slice(0, BODY_CHARS);
  if (body) lines.push(`   ${paint(color, bold, 'Data:')} ${paint(color, dim, body)}`);
  const tail = `(hold ${safe(ask.id)})${left === null || Number.isNaN(left) ? '' : `  — no answer in ${left} s means No`}`;
  lines.push(`   ${paint(color, bold, 'Allow? [y/N]')} ${paint(color, dim, tail)}`);
  return lines;
}

/**
 * The terminal prompt. It owns one hold from its question to the proxy's
 * verdict. `ask()` opens a question and returns true, or returns false when a
 * hold is still current (asking or awaiting its verdict) or the prompt is
 * closed, so the caller prints the plain `ask` line instead; `decided()`
 * ends the current hold with its outcome line, `close()` releases
 * `input`.
 *
 * @param {{ input: import('node:stream').Readable, output: { write: (s: string) => unknown }, color?: boolean, answer: (id: string, decision: 'allow'|'deny', reason?: string) => boolean|void }} opts streams and the answer writer
 * @returns {{ ask: (ask: AskRecord) => boolean, decided: (e: { id: string, decision: string, reason?: string }) => void, close: () => void }} the prompt
 */
export function createTerminalPrompt({ input, output, answer, color = false }) {
  /** The one hold this prompt owns, from its question to the proxy's verdict. `typedYes`: true/false once our answer was written, null when another answer won, undefined while still asking.
   * @type {{ ask: AskRecord, state: 'asking'|'sent', typedYes?: boolean|null }|null} */
  let current = null;
  let buf = '';
  let closed = false;
  const say = (/** @type {string} */ s) => { output.write(`${s}\n`); };

  // The one place that words an outcome. `typedYes` is true/false when our
  // typed answer was written (✓/✗ allowed/denied only when the proxy's verdict
  // matches it), undefined/null when nothing of ours was sent.
  const outcome = (/** @type {{ decision: string, reason?: string }} */ e, /** @type {boolean|null|undefined} */ typedYes) => {
    const why = safe(e.reason);
    return typedYes === true && e.decision === 'allow' ? paint(color, ANSI.green + ANSI.bold, '✓ allowed')
      : typedYes === false && e.decision === 'deny' && why === 'denied at the terminal' ? paint(color, ANSI.red + ANSI.bold, '✗ denied')
        : why === 'hold timeout' ? paint(color, ANSI.red, '✗ timed out (denied)')
          : why === 'client gone' ? paint(color, ANSI.red, '✗ agent gone (denied)')
            : why === 'proxy closing' ? paint(color, ANSI.red, '✗ sandbox closed (denied)')
              : e.decision === 'allow' ? '✓ answered elsewhere (allowed)'
                : `✗ answered elsewhere (${why || 'denied'})`;
  };

  const onLine = (/** @type {string} */ line) => {
    const hold = current;
    if (!hold || hold.state !== 'asking') return; // unreachable at runtime (onData checks); narrows the type for tsc
    const yes = YES.has(line.trim().toLowerCase());
    let written = false;
    try {
      written = answer(hold.ask.id, yes ? 'allow' : 'deny', yes ? undefined : 'denied at the terminal') !== false;
    } catch (e) {
      // The write failed (disk full, runtime gone, ...); the run goes on and the
      // hold stays open and asking: the next line retries. Say so at once:
      // nothing else would, and a hold with no timeout would wait on a blank
      // line. Never the message: it may hold a path.
      const code = e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : 'error';
      const question = questionLines(hold.ask, Date.now(), color).at(-1)?.trimStart();
      say(`${paint(color, ANSI.red, `✗ not sent (${safe(code)}), try again:`)} ${question}`);
      return;
    }
    // The receipt is instant; the verdict is appended by `decided` once the proxy
    // has read the file (it may still time the hold out first). A lost write
    // (another answer won) prints nothing now, but its `decided` still words the outcome.
    hold.state = 'sent';
    hold.typedYes = written ? yes : null;
    if (written) output.write(`${paint(color, ANSI.dim, '→ sent')} `);
  };

  const onData = (/** @type {string|Buffer} */ chunk) => {
    if (current?.state !== 'asking') return;
    buf += String(chunk);
    for (let m = EOL.exec(buf); m && current?.state === 'asking'; m = EOL.exec(buf)) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      onLine(line);
    }
  };

  input.setEncoding?.('utf8');
  input.on('data', onData);

  return {
    ask(ask) {
      if (closed || current) return false;
      current = { ask, state: 'asking' };
      buf = ''; // a half-typed line from before the question is stale
      for (const l of questionLines(ask, Date.now(), color)) say(l);
      return true;
    },
    decided(e) {
      if (current?.ask.id !== e.id) return;
      const typedYes = current.typedYes;
      current = null; // closed before anything else: no answer can follow
      say(outcome(e, typedYes));
    },
    close() {
      closed = true;
      current = null;
      input.removeListener('data', onData);
      input.pause();
    },
  };
}
