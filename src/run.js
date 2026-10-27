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
//     Known payment DOMAINS are likewise M3 (they need rwxmap's matcher).
//   - `ask`/`auto` additionally park every non-GET/HEAD request (the PRD's
//     "unsure? tag it x" default: GET/HEAD = r, anything else = x). The two
//     modes behave identically until M3's `askOn` letters separate them.
//   - `trust` forwards everything else, logged.
// An explicit `match`/`shouldHold` REPLACES the method default in `ask`/`auto`
// (the floor still always applies); in `trust` it is ignored and only the
// floor holds.
//
// `gate` is accepted for API stability but NOT consulted yet: pass a loop's
// bareguard `Gate` (or any object with the same `check(action)` contract) and
// M2.5 validates its shape and ignores it — M3 wires it to the letter rules.
// A passed `onAsk` answers parked requests with no files involved; when it is
// absent the file checkpoint runs (`<runtime>/asks` + `<runtime>/answers`,
// answered from a second terminal with `sbx pending/approve/deny`).
//
// `asks` is the collected ask records in park order: full payloads (plus the
// decision) when `onAsk` was used, reconstructed from the audit log's
// hold/decide lines otherwise. `audit` is the JSONL audit log path, kept
// after return — the caller owns the runtime dir (including temp-dir cleanup).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from './proxy.js';
import { launch } from './launcher.js';
import { matchPath } from './holds.js';

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
 * @param {object} [opts]
 * @param {string} [opts.match] path substring that additionally parks (ask/auto only)
 * @param {import('./holds.js').ShouldHold} [opts.shouldHold] decision function replacing the method default (ask/auto only)
 * @returns {import('./holds.js').ShouldHold} decision function for the hold queue
 */
export function shouldHoldForMode(mode, { match, shouldHold } = {}) {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'trust') {
    throw new Error(`run: mode must be ask|auto|trust, got ${JSON.stringify(mode)}`);
  }
  const explicit = shouldHold ?? (match ? matchPath(match) : null);
  return (req) => floorReason(req)
    ?? (mode === 'trust' ? null : (explicit ? explicit(req) : methodReason(req)));
}

/**
 * A collected ask record: the parked ask plus how it was decided.
 *
 * @typedef {object} AskRecord
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket)
 * @property {string} [method] HTTP method (absent when reconstructed from a bare decide line)
 * @property {string} [url] full URL (absent when reconstructed from a bare decide line)
 * @property {string} rule hold-reason string
 * @property {string} letter always `'x'` until M3 owns letters
 * @property {string} [bodyPreview] request body preview (onAsk path only)
 * @property {boolean} [truncated] body preview truncation flag (onAsk path only)
 * @property {string|null} [expiresAt] ISO-8601 UTC deadline, or null (onAsk path only)
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
 * @property {*} [gate] a loop's bareguard `Gate` (or any object with the same `check(action)` contract); shape-validated, consulted starting in M3
 * @property {import('./holds.js').OnAsk} [onAsk] ask seam; when present no files are involved, otherwise the file checkpoint runs
 * @property {string} [runtime] runtime dir (created when absent: a short `sbx-*` temp dir, keeping unix socket paths under the ~108-char limit)
 * @property {string} [agent] agent name (default `'agent'`)
 * @property {string} [match] path substring that additionally parks a request (ask/auto only)
 * @property {import('./holds.js').ShouldHold} [shouldHold] decision function replacing the method default (ask/auto only)
 * @property {number|string} [timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @property {number} [pollMs] answer poll interval in ms for the file checkpoint (default 250)
 * @property {boolean} [allowLoopback] TEST-ONLY opt-in: let loopback destinations through (default false; fixtures live on 127.0.0.1, production never passes this)
 * @property {object} [extraEnv] extra environment entries for the inside
 * @property {number} [proxyPort] front-door port inside the sandbox (default 3128)
 * @property {NodeJS.WritableStream} [stdout] where the agent's stdout goes (default process.stdout)
 * @property {NodeJS.WritableStream} [stderr] where the agent's stderr goes (default process.stderr)
 */

/**
 * Rebuild ask records from the audit log's hold/decide lines, layered over
 * the (richer) records the `onAsk` wrapper collected. The audit log is the
 * source of truth for the file channel, where no wrapper saw the asks.
 *
 * @param {string} auditFile JSONL audit log path
 * @param {Map<string, AskRecord>} seen records collected through `onAsk`
 * @returns {AskRecord[]} ask records in park order
 */
function collectAsks(auditFile, seen) {
  /** @type {Map<string, AskRecord>} */
  const byId = new Map(seen);
  let text = '';
  try {
    text = fs.readFileSync(auditFile, 'utf8');
  } catch {
    return [...byId.values()];
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ev === 'hold' && typeof e.id === 'string') {
      if (!byId.has(e.id)) {
        byId.set(e.id, {
          id: e.id, agent: e.agent, method: e.method, url: e.url,
          rule: typeof e.reason === 'string' ? e.reason : '', letter: 'x',
        });
      }
    } else if (e.ev === 'decide' && typeof e.id === 'string') {
      const decision = e.decision === 'approve' ? 'allow' : 'deny';
      const prev = byId.get(e.id);
      if (prev) byId.set(e.id, { ...prev, decision, reason: e.reason });
      else {
        byId.set(e.id, {
          id: e.id, agent: e.agent, rule: '', letter: 'x',
          decision, reason: e.reason,
        });
      }
    }
  }
  return [...byId.values()];
}

/**
 * Run one sandboxed agent start-to-finish in a single call.
 *
 * @param {object} opts
 * @param {string} opts.proj project directory, bound read-only inside the sandbox
 * @param {string[]} opts.command argv to run inside, for example `["bash", "-c", "echo hi"]`
 * @param {string} [opts.mode] `ask` | `auto` (default) | `trust`; see the mode comment at the top of this file
 * @param {*} [opts.gate] a loop's bareguard `Gate` (or any object with the same `check(action)` contract); shape-validated, consulted starting in M3
 * @param {import('./holds.js').OnAsk|null} [opts.onAsk] ask seam; when present no files are involved, otherwise the file checkpoint runs
 * @param {string|null} [opts.runtime] runtime dir (created when absent: a short `sbx-*` temp dir, keeping unix socket paths under the ~108-char limit)
 * @param {string} [opts.agent] agent name (default `'agent'`)
 * @param {string} [opts.match] path substring that additionally parks a request (ask/auto only)
 * @param {import('./holds.js').ShouldHold} [opts.shouldHold] decision function replacing the method default (ask/auto only)
 * @param {number|string} [opts.timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @param {number} [opts.pollMs] answer poll interval in ms for the file checkpoint (default 250)
 * @param {boolean} [opts.allowLoopback] TEST-ONLY opt-in: let loopback destinations through (default false; fixtures live on 127.0.0.1, production never passes this)
 * @param {object} [opts.extraEnv] extra environment entries for the inside
 * @param {number} [opts.proxyPort] front-door port inside the sandbox (default 3128)
 * @param {NodeJS.WritableStream|null} [opts.stdout] where the agent's stdout goes (default process.stdout)
 * @param {NodeJS.WritableStream|null} [opts.stderr] where the agent's stderr goes (default process.stderr)
 * @returns {Promise<{ exit: number, asks: AskRecord[], audit: string }>} the agent process exit code, the collected ask records, and the JSONL audit log path
 * @when Reach for this to HARNESS-ONLY run one sandboxed agent start-to-finish in a single call: it starts the proxy, sandboxes the command, answers holds, and returns the exit code with the ask and audit trail.
 * @fails Rejects on a missing/unreadable `proj`, an empty `command`, a bad `mode`, a misshapen `gate`/`onAsk`, or a proxy that never becomes ready. The agent's own nonzero exit is returned as `exit`, never thrown.
 * @example
 * import { run } from "barebox";
 * const { exit, asks, audit } = await run({ proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
 */
export async function run({ proj, command, mode = 'auto', gate = null, onAsk = null,
  runtime = null, agent = 'agent', match, shouldHold, timeoutMs, pollMs,
  allowLoopback = false, extraEnv = {}, proxyPort = 3128, stdout = null, stderr = null }) {
  if (typeof proj !== 'string' || !proj) throw new Error('run: proj must be a non-empty string');
  if (!fs.existsSync(proj)) throw new Error(`run: proj does not exist: ${proj}`);
  if (!Array.isArray(command) || !command.length) {
    throw new Error('run: command must be a non-empty argv array');
  }
  if (onAsk != null && typeof onAsk !== 'function') {
    throw new Error('run: onAsk must be a function');
  }
  if (gate != null) {
    const check = typeof gate === 'function' ? gate : gate.check;
    if (typeof check !== 'function') {
      throw new Error('run: gate must be a bareguard Gate (or any object with a check(action) function)');
    }
  }
  // Mode first: bad input throws before any runtime dir is created.
  const decide = shouldHoldForMode(mode, { match, shouldHold });
  // Short temp dir: agent socket paths inherit it and cap at ~108 chars.
  const rt = runtime ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const audit = path.join(rt, 'audit.jsonl');

  // The wrapper records every ask with its decision; the file channel (no
  // onAsk) is reconstructed from the audit log instead (see collectAsks).
  /** @type {Map<string, AskRecord>} */
  const seen = new Map();
  const wrappedOnAsk = onAsk
    ? async (/** @type {import('./holds.js').AskPayload} */ ask) => {
      seen.set(ask.id, { ...ask });
      /** @type {{ decision: string, reason?: string }} */
      let answered;
      try {
        answered = await onAsk(ask);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        answered = { decision: 'deny', reason: `onAsk failed: ${msg}` };
      }
      const allow = answered.decision === 'allow' || answered.decision === 'approve';
      seen.set(ask.id, {
        ...ask,
        decision: allow ? 'allow' : 'deny',
        reason: (typeof answered.reason === 'string' && answered.reason)
          ? answered.reason
          : (allow ? undefined : 'denied'),
      });
      return answered;
    }
    : undefined;

  const proxy = createProxy({
    runtime: rt, logFile: audit, allowLoopback,
    hold: { shouldHold: decide, onAsk: wrappedOnAsk, timeoutMs, pollMs },
  });
  try {
    await proxy.ready;
  } catch (e) {
    await proxy.close().catch(() => {});
    throw e;
  }
  const sock = proxy.addAgent(agent);
  const child = launch({
    runtime: rt, agent, proj, command,
    socket: sock, caFile: proxy.caFile, proxyPort, extraEnv,
  });
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  child.stdout?.on('data', (c) => { try { out.write(c); } catch {} });
  child.stderr?.on('data', (c) => { try { err.write(c); } catch {} });
  /** @type {number} */
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    await proxy.close();
  }
  return { exit, asks: collectAsks(audit, seen), audit };
}
