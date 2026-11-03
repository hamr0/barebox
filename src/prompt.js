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
 * The terminal prompt. One question open at a time. `ask()` opens a question
 * and returns true, or returns false when one is already open (or the prompt
 * is closed) so the caller prints the plain `ask` line instead; `decided()`
 * closes the question when the hold ended some other way, `close()` releases
 * `input`.
 *
 * @param {{ input: import('node:stream').Readable, output: { write: (s: string) => unknown }, color?: boolean, answer: (id: string, decision: 'allow'|'deny', reason?: string) => boolean|void }} opts streams and the answer writer
 * @returns {{ ask: (ask: AskRecord) => boolean, decided: (e: { id: string, decision: string, reason?: string }) => void, close: () => void }} the prompt
 */
export function createTerminalPrompt({ input, output, answer, color = false }) {
  /** @type {AskRecord|null} */
  let open = null;
  let buf = '';
  let closed = false;
  const say = (/** @type {string} */ s) => { output.write(`${s}\n`); };

  const onLine = (/** @type {string} */ line) => {
    if (!open) return; // unreachable at runtime (onData checks); narrows the type for tsc
    const { id } = open;
    open = null; // closed before the write: one answer per question
    const yes = YES.has(line.trim().toLowerCase());
    try {
      const written = answer(id, yes ? 'allow' : 'deny', yes ? undefined : 'denied at the terminal') !== false;
      say(!written ? 'answered elsewhere'
        : yes ? paint(color, ANSI.green + ANSI.bold, '✓ allowed') : paint(color, ANSI.red + ANSI.bold, '✗ denied'));
    } catch {
      // The hold ended (or the runtime went) before this write; the run goes on.
    }
  };

  const onData = (/** @type {string|Buffer} */ chunk) => {
    if (!open) return;
    buf += String(chunk);
    for (let m = EOL.exec(buf); m && open; m = EOL.exec(buf)) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      onLine(line);
    }
  };

  input.setEncoding?.('utf8');
  input.on('data', onData);

  return {
    ask(ask) {
      if (closed || open) return false;
      open = ask;
      buf = ''; // a half-typed line from before the question is stale
      for (const l of questionLines(open, Date.now(), color)) say(l);
      return true;
    },
    decided(e) {
      if (open?.id !== e.id) return;
      open = null; // closed before anything else: no answer can follow
      const why = safe(e.reason);
      say(why === 'hold timeout' ? paint(color, ANSI.red, `timed out: ${safe(e.decision)}`)
        : why === 'client gone' || why === 'proxy closing' ? paint(color, ANSI.red, `agent gone: ${safe(e.decision)}`)
          : `answered elsewhere: ${safe(e.decision)}${why ? ` (${why})` : ''}`);
    },
    close() {
      closed = true;
      open = null;
      input.removeListener('data', onData);
      input.pause();
    },
  };
}
