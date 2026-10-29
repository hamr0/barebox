// run.js — one-call sandboxed run (M2.5 integration seam).
//
// `run()` wraps the low-level parts (`createProxy` + `addAgent` + `launch`,
// which stay public): one agent, one sandbox, one audit log, exit code out.
// The caller never touches sockets, ask files, or the hold queue.
//
// What `mode` does TODAY (letters are M3's job): the proxy sees requests,
// not intent, so until the rwxmap + bareguard letter pipeline lands there is
// no per-letter policy — only this interim hold rule:
//   - the card/payment FLOOR holds in every mode, including `trust`: a
//     request whose path names a payment destination (`/checkout`,
//     `/payment`, `/orders`, `/purchase`). The card-in-body half of the
//     floor is NOT enforced here: the decide seam sees method/URL/headers
//     but never the body, so body inspection waits for M3's in-proxy rules.
//     Known payment DOMAINS are likewise M3 (they need rwxmap).
//   - `ask`/`auto` additionally park every non-GET/HEAD request (the PRD's
//     "unsure? tag it x" default: GET/HEAD = r, anything else = x). The two
//     modes behave identically until M3's `askOn` letters separate them.
//   - `trust` forwards everything else, logged.
//
// A passed `onAsk` answers parked requests with no files involved; when it is
// absent the file checkpoint runs (`<runtime>/asks` + `<runtime>/answers`,
// answered from a second terminal with `sbx pending/approve/deny`).
//
// `asks` is the collected ask records in park order: the queue reports
// every park and decision through `onEvent`, so no log is re-parsed and no
// wrapper re-collects. `audit` is the JSONL audit log path, kept after
// return — the caller owns the runtime dir (including temp-dir cleanup).
import fs from 'node:fs';
import { createProxy } from './proxy.js';
import { createRuntime, runtimePaths } from './runtime.js';
import { launch } from './launcher.js';
import { diffOverlay } from './overlay.js';

/** Payment-destination path fragments: the URL-visible half of the floor (PRD section 2). */
const FLOOR_PATHS = ['/checkout', '/payment', '/orders', '/purchase'];

/**
 * The card/payment floor, URL-visible half: park payment destinations in
 * every mode. Returns the hold reason, or null to leave the mode rule alone.
 *
 * @param {{ url: string }} req request, as seen by the decide seam
 * @returns {string|null} hold reason, or null
 */
function floorReason(req) {
  let pathname;
  try {
    pathname = new URL(req.url).pathname.toLowerCase();
  } catch {
    return null;
  }
  for (const fp of FLOOR_PATHS) {
    if (pathname.includes(fp)) return `payment destination (floor): ${fp}`;
  }
  return null;
}

/**
 * The interim x-rule (PRD "everything else"): GET/HEAD forward, any other
 * method parks. Stands in for M3's letters.
 *
 * @param {{ method: string }} req request, as seen by the decide seam
 * @returns {string|null} hold reason, or null
 */
function methodReason(req) {
  const m = String(req.method || '').toUpperCase();
  return (m === 'GET' || m === 'HEAD') ? null : `method ${m || '?'} is not GET/HEAD (interim x-rule)`;
}

/**
 * Build the hold decision for a mode. Pure: unit-testable without a sandbox.
 *
 * @param {string} mode `ask` | `auto` | `trust`
 * @returns {import('./holds.js').ShouldHold} decision function for the hold queue
 */
export function shouldHoldForMode(mode) {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'trust') {
    throw new Error(`run: mode must be ask|auto|trust, got ${JSON.stringify(mode)}`);
  }
  return (req) => floorReason(req)
    ?? (mode === 'trust' ? null : methodReason(req));
}

/**
 * A collected ask record: the parked ask plus how it was decided.
 *
 * @typedef {object} AskRecord
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket)
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {string} rule hold-reason string
 * @property {string} letter always `'x'` until M3 owns letters
 * @property {string} [bodyPreview] request body preview
 * @property {boolean} [truncated] body preview truncation flag
 * @property {string|null} [expiresAt] ISO-8601 UTC deadline, or null
 * @property {string} [decision] `'allow'` | `'deny'`, once decided
 * @property {string} [reason] decision reason, once decided
 */

/**
 * Options for {@link run}.
 *
 * @typedef {object} RunOptions
 * @property {string} proj project directory, bound read-only inside the sandbox
 * @property {string[]} command argv to run inside, for example `["bash", "-c", "echo hi"]`
 * @property {string} [mode] `ask` | `auto` (default) | `trust`; see the mode comment at the top of this file
 * @property {import('./holds.js').OnAsk} [onAsk] ask seam; when present no files are involved, otherwise the file checkpoint runs
 * @property {import('./holds.js').OnEvent} [onEvent] event callback: `{ type: 'ask' }` on park, `{ type: 'decided' }` on settle or abandon (also feeds `asks`)
 * @property {string} [runtime] runtime dir (created when absent: a short `sbx-*` temp dir, keeping unix socket paths under the ~108-char limit)
 * @property {string} [agent] agent name (default `'agent'`)
 * @property {number|string} [timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @property {object} [unsafeTestOnly] TEST-ONLY escape hatch, forwarded to the proxy (see `createProxy`): everything under it weakens the sandbox wall
 * @property {NodeJS.WritableStream} [stdout] where the agent's stdout goes (default process.stdout)
 * @property {NodeJS.WritableStream} [stderr] where the agent's stderr goes (default process.stderr)
 * @property {boolean} [overlay] when true, mount a per-run overlay upper over the project (M4 tracing paper) instead of binding it read-only; the result's `diff` lists the run's changes for commit/rollback
 * @property {string[]} [overlayIgnore] path segments invisible to the overlay (default `node_modules`; see overlay.js Q3)
 */

/**
 * Run one sandboxed agent start-to-finish in a single call.
 *
 * @param {object} opts
 * @param {string} opts.proj project directory, bound read-only inside the sandbox
 * @param {string[]} opts.command argv to run inside, for example `["bash", "-c", "echo hi"]`
 * @param {string} [opts.mode] `ask` | `auto` (default) | `trust`; see the mode comment at the top of this file
 * @param {import('./holds.js').OnAsk|null} [opts.onAsk] ask seam; when present no files are involved, otherwise the file checkpoint runs
 * @param {import('./holds.js').OnEvent|null} [opts.onEvent] event callback: `{ type: 'ask' }` on park, `{ type: 'decided' }` on settle or abandon (also feeds `asks`)
 * @param {string|null} [opts.runtime] runtime dir (created when absent: a short `sbx-*` temp dir, keeping unix socket paths under the ~108-char limit)
 * @param {string} [opts.agent] agent name (default `'agent'`)
 * @param {number|string} [opts.timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @param {object|null} [opts.unsafeTestOnly] TEST-ONLY escape hatch, forwarded to the proxy (see `createProxy`)
 * @param {NodeJS.WritableStream|null} [opts.stdout] where the agent's stdout goes (default process.stdout)
 * @param {NodeJS.WritableStream|null} [opts.stderr] where the agent's stderr goes (default process.stderr)
 * @param {boolean} [opts.overlay] when true, mount a per-run overlay upper over the project instead of binding it read-only; the result's `diff` lists the run's changes for commit/rollback
 * @param {string[]} [opts.overlayIgnore] path segments invisible to the overlay (default `node_modules`; see overlay.js Q3)
 * @returns {Promise<{ exit: number, asks: AskRecord[], audit: string, diff: import('./overlay.js').OverlayChange[], runtime: string }>} the agent process exit code, the collected ask records, the JSONL audit log path, the run's overlay diff (M4), and the runtime dir addressing it
 * @when Reach for this to HARNESS-ONLY run one sandboxed agent start-to-finish in a single call: it starts the proxy, sandboxes the command, answers holds, and returns the exit code with the ask and audit trail (plus the overlay diff once M4 exists).
 * @fails Rejects on a missing/unreadable `proj`, an empty `command`, a bad `mode`, a misshapen `onAsk`, a proxy that never becomes ready, a `launch` that throws (uncommitted overlay changes, a runtime inside the project — the proxy is closed first), or an overlay diff that cannot be read. The agent's own nonzero exit is returned as `exit`, never thrown.
 * @example
 * import { run } from "barebox";
 * const { exit, asks, audit } = await run({ proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
 */
export async function run({ proj, command, mode = 'auto', onAsk = null,
  onEvent = null, runtime = null, agent = 'agent', timeoutMs,
  unsafeTestOnly = null, stdout = null, stderr = null,
  overlay = false, overlayIgnore }) {
  if (typeof proj !== 'string' || !proj) throw new Error('run: proj must be a non-empty string');
  if (!fs.existsSync(proj)) throw new Error(`run: proj does not exist: ${proj}`);
  if (!Array.isArray(command) || !command.length) {
    throw new Error('run: command must be a non-empty argv array');
  }
  if (onAsk != null && typeof onAsk !== 'function') {
    throw new Error('run: onAsk must be a function');
  }
  // Mode first: bad input throws before any runtime dir is created.
  const decide = shouldHoldForMode(mode);
  // Short temp dir: agent socket paths inherit it and cap at ~108 chars.
  const rt = runtime ?? createRuntime();
  const audit = runtimePaths(rt).audit;

  // Outcomes are reported, never reconstructed: the queue's `onEvent`
  // builds the ask records in park order, for both channels alike.
  /** @type {Map<string, AskRecord>} */
  const seen = new Map();
  /** @param {import('./holds.js').HoldEvent} e */
  const recordEvent = (e) => {
    if (e.type === 'ask') {
      seen.set(e.ask.id, { ...e.ask });
    } else if (e.type === 'decided') {
      const prev = seen.get(e.id);
      if (prev) seen.set(e.id, { ...prev, decision: e.decision, reason: e.reason });
    }
  };
  const holdOnEvent = onEvent
    ? (/** @type {import('./holds.js').HoldEvent} */ e) => { recordEvent(e); onEvent(e); }
    : recordEvent;

  const proxy = createProxy({
    runtime: rt, logFile: audit, unsafeTestOnly,
    hold: { shouldHold: decide, onAsk, timeoutMs, onEvent: holdOnEvent },
  });
  try {
    await proxy.ready;
  } catch (e) {
    await proxy.close().catch(() => {});
    throw e;
  }
  /** @type {string|undefined} */
  let sock;
  // `addAgent` and `launch` run INSIDE the try: a synchronous throw there
  // (a broken socket folder, uncommitted overlay changes, a runtime inside
  // the project) must still close the proxy — otherwise its listening
  // sockets keep this process alive forever.
  /** @type {number} */
  let exit;
  try {
    sock = proxy.addAgent(agent);
    const child = launch({
      runtime: rt, agent, proj, command,
      socket: sock, caFile: proxy.caFile,
      overlay, overlayIgnore,
    });
    const out = stdout ?? process.stdout;
    const err = stderr ?? process.stderr;
    child.stdout?.on('data', (c) => { try { out.write(c); } catch {} });
    child.stderr?.on('data', (c) => { try { err.write(c); } catch {} });
    exit = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    // The sandbox is gone: end the agent's holds as client gone now, not
    // as 'proxy closing' if close() beats the sockets' async 'close'.
    if (sock) proxy.removeAgent(agent);
    await proxy.close();
  }
  // M2.5 item 4: the result carries the M4 diff. Without overlay there is no
  // upper, so nothing to review — an empty diff, never null.
  /** @type {import('./overlay.js').OverlayChange[]} */
  let diff = [];
  if (overlay) {
    try {
      diff = diffOverlay({ runtime: rt, agent });
    } catch (e) {
      const err = /** @type {Error & {exit?: number}} */ (e instanceof Error ? e : new Error(String(e)));
      err.exit = exit;
      throw new Error(`run: overlay diff failed after exit ${exit}: ${err.message}`);
    }
  }
  return { exit, asks: [...seen.values()], audit, diff, runtime: rt };
}
