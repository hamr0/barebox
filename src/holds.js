// holds.js — the ONLY writer of the hold queue.
//
// A held request parks with its client socket open until the ask channel
// answers. The seam is `onAsk(ask) -> Promise<{ decision, reason? }>`
// (bareguard's `humanChannel` shape): pass a loop's own callback and no
// files are involved; omit it and the default file checkpoint runs —
// `<runtime>/asks/<id>.json` is written on park, `<runtime>/answers/<id>.json`
// is consumed once (renamed away before reading), and the poll (default
// 250 ms, PRD Q9) waits until the hold deadline. Timeout — or any failure
// of the channel itself — is deny. An `ASK OPEN <id>` line goes to stderr
// on park so a human watching a terminal knows.
//
// An answer for an unknown or already-settled id is stale: ignored, logged
// (`stale-answer`), and removed by the sweeper, as in fwdloop. A malformed
// answer (bad JSON, missing/unknown decision) is likewise ignored, logged
// (`malformed-answer`), and removed; the poll keeps waiting until the
// deadline. The queue never throws on channel input: everything unexpected
// is loud in the log and eventually a deny.
//
// Approving a hold whose client is gone must be impossible: `abandon()`
// removes the entry and its ask file, so a later answer is stale and
// nothing is forwarded.
//
// Ask payload (`asks/<id>.json`): `id`, `agent`, `method`, `url`, `rule`
// (the hold-reason string), `letter`, `bodyPreview` + `truncated`,
// `waitingSec` (0 at park; readers use the file mtime for a live value),
// `expiresAt` (ISO-8601 UTC string, or null when `timeoutMs: 'never'`).
// `letter` is `'x'` for every parked ask: letters are M3's job (rwxmap +
// bareguard) — the queue only parks what the decision function flags, and
// everything flagged today is irreversible. Headers are excluded from the
// payload (they carry Authorization secrets); the body preview is capped at
// ASK_BODY_LIMIT bytes but otherwise verbatim — M3's bareguard `secrets`
// redaction takes over redaction there.
//
// Answer payload (`answers/<id>.json`): `{ decision: 'allow' | 'deny',
// reason? }`. `'approve'` is accepted as an alias of `'allow'`. Writers
// must write atomically (tmp file + rename); readers never see partials.
import fs from 'node:fs';
import path from 'node:path';

/** Body preview cap for `asks/<id>.json` (bytes). */
export const ASK_BODY_LIMIT = 4096;

/** Default answer poll interval in ms (PRD Q9). */
export const DEFAULT_POLL_MS = 250;

/**
 * A parked request, as returned by {@link pending}. Plain objects only —
 * the queue itself never leaves this module.
 *
 * @typedef {object} HeldRequest
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket), never `c<n>`
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {string} rule hold-reason string from the decision function
 * @property {string} body request body so far (utf8)
 * @property {number} waitingSec seconds since the hold parked
 */

/**
 * The decision-ready ask written to `asks/<id>.json`.
 *
 * @typedef {object} AskPayload
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket)
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {string} rule hold-reason string from the decision function
 * @property {string} letter always `'x'` until M3 owns letters
 * @property {string} bodyPreview request body preview, utf8, capped at ASK_BODY_LIMIT bytes
 * @property {boolean} truncated true when the body exceeded ASK_BODY_LIMIT
 * @property {number} waitingSec 0 at park; readers use the file mtime for a live value
 * @property {string|null} expiresAt ISO-8601 UTC deadline, or null when `timeoutMs: 'never'`
 */

/**
 * Decide a parked ask. Resolves `{ decision: 'allow' | 'deny', reason? }`.
 *
 * @typedef {(ask: AskPayload) => Promise<{ decision: string, reason?: string }>} OnAsk
 */

/**
 * Decide whether a request parks. Return a human-readable reason, or null
 * to forward. M3 plugs the rwxmap + bareguard classifier into this one seam.
 *
 * @typedef {(req: { agent: string, method: string, url: string, headers: Record<string, string | string[] | undefined> }) => string | null} ShouldHold
 */

/**
 * File-checkpoint paths for a runtime dir. Both dirs are created on demand.
 *
 * @param {string} runtime runtime dir
 * @returns {{ asksDir: string, answersDir: string, askFile: (id: string) => string, answerFile: (id: string) => string }} dirs + per-id paths
 */
export function askPaths(runtime) {
  const asksDir = path.join(runtime, 'asks');
  const answersDir = path.join(runtime, 'answers');
  return {
    asksDir,
    answersDir,
    askFile: (id) => path.join(asksDir, `${id}.json`),
    answerFile: (id) => path.join(answersDir, `${id}.json`),
  };
}

/**
 * Atomic write: tmp file + rename, so readers never see a partial payload.
 *
 * @param {string} file destination path
 * @param {string} text content
 * @returns {void}
 */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

let consumeN = 0;

/**
 * Consume a file exactly once: rename it away, then read and unlink the
 * renamed copy. Returns null when there is nothing to consume.
 *
 * @param {string} file path to consume
 * @returns {string|null} content, `''` when the renamed copy is unreadable, null when absent
 */
function consumeFile(file) {
  const tmp = `${file}.consumed-${process.pid}-${++consumeN}`;
  try {
    fs.renameSync(file, tmp);
  } catch {
    return null;
  }
  let text = '';
  try {
    text = fs.readFileSync(tmp, 'utf8');
  } catch {}
  try {
    fs.unlinkSync(tmp);
  } catch {}
  return text;
}

/**
 * Validate an answer payload. Accepts `{ decision: 'allow' | 'deny' }`
 * (`'approve'` aliases `'allow'`); anything else is malformed.
 *
 * @param {string} text raw answer file content
 * @returns {{ decision: 'allow' | 'deny', reason?: string } | null} decision, or null when malformed
 */
function parseAnswer(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const decision = /** @type {{ decision?: unknown, reason?: unknown }} */ (obj).decision;
  if (decision === 'allow' || decision === 'approve') return { decision: 'allow' };
  if (decision === 'deny') {
    const reason = /** @type {{ reason?: unknown }} */ (obj).reason;
    return {
      decision: 'deny',
      reason: typeof reason === 'string' && reason ? reason : 'denied by user',
    };
  }
  return null;
}

/**
 * Sleep without keeping the process alive: a parked `'never'` hold must
 * not hold the event loop open by itself.
 *
 * @param {number} ms milliseconds
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Create the hold queue.
 *
 * @param {object} opts
 * @param {(o: Record<string, unknown>) => void} opts.log audit-log writer
 * @param {ShouldHold} [opts.shouldHold] decision function (default: path-substring `match`)
 * @param {string} [opts.match] path substring that parks a request (default impl when `shouldHold` is absent)
 * @param {number|string} [opts.timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @param {number} [opts.maxBody] bodies over this are denied at the door, never queued (default 1048576)
 * @param {string|null} [opts.runtime] runtime dir; required for the default file checkpoint (writes `asks/`, polls `answers/`)
 * @param {OnAsk|null} [opts.onAsk] ask seam (bareguard `humanChannel` shape); when present no files are involved
 * @param {number} [opts.pollMs] answer poll interval in ms for the default file checkpoint (default 250, PRD Q9)
 * @param {(entry: object) => void} opts.onApprove forward the parked request upstream
 * @param {(entry: object, reason: string) => void} opts.onDeny refuse the parked request
 * @returns {{ add: (entry: object) => string, decide: (req: { agent: string, method: string, url: string, headers: Record<string, string | string[] | undefined> }) => string | null, approve: (id: string) => string, deny: (id: string, reason: string) => string, abandon: (id: string) => void, abandonSocket: (sock: object) => void, pending: () => HeldRequest[], size: () => number, close: () => void }} queue handle
 */
export function createHolds({ log, shouldHold, match, timeoutMs = 120000,
  maxBody = 1048576, runtime = null, onAsk = null, pollMs = DEFAULT_POLL_MS,
  onApprove, onDeny }) {
  const decide = shouldHold
    ?? ((req) => (match && new URL(req.url).pathname.includes(match) ? `path matches ${match}` : null));
  /** @returns {number|null} */
  const deadlineMs = () => {
    if (timeoutMs === 'never') return null;
    const ms = timeoutMs ?? 120000;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 120000;
  };
  if (onAsk != null && typeof onAsk !== 'function') {
    throw new Error('createHolds: onAsk must be a function');
  }
  const poll = typeof pollMs === 'number' && Number.isFinite(pollMs) && pollMs > 0
    ? pollMs
    : DEFAULT_POLL_MS;
  // Custom onAsk owns decisions with no files involved; the default IS the
  // file checkpoint and needs a runtime dir for asks/ + answers/.
  const useFiles = onAsk == null;
  if (useFiles && !runtime) {
    throw new Error('createHolds: runtime is required for the default file checkpoint (or pass onAsk)');
  }
  const paths = runtime ? askPaths(runtime) : null;
  if (paths) {
    fs.mkdirSync(paths.asksDir, { recursive: true });
    fs.mkdirSync(paths.answersDir, { recursive: true });
  }

  let n = 0;
  /** @type {Map<string, object>} */
  const queue = new Map();

  const pub = (h) => ({
    id: h.id, agent: h.agent, method: h.method, url: h.url, rule: h.note,
    body: h.body.toString('utf8'), waitingSec: Math.round((Date.now() - h.t0) / 1000),
  });

  /**
   * Build the decision-ready ask payload for a parked entry.
   *
   * @param {object} entry queue entry
   * @param {number|null} ms hold deadline in ms, or null for never
   * @param {string} rule hold-reason string
   * @returns {AskPayload}
   */
  function askPayload(entry, ms, rule) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(String(entry.body ?? ''));
    return {
      id: entry.id,
      agent: entry.agent,
      method: entry.method,
      url: entry.url,
      rule,
      // M3 owns letters; everything the queue parks today is irreversible.
      letter: 'x',
      bodyPreview: body.subarray(0, ASK_BODY_LIMIT).toString('utf8'),
      truncated: body.length > ASK_BODY_LIMIT,
      waitingSec: 0,
      // ISO-8601 UTC (not epoch ms): readable in `sbx pending` and logs.
      expiresAt: ms === null ? null : new Date(entry.t0 + ms).toISOString(),
    };
  }

  function removeAskFile(id) {
    if (!paths) return;
    try {
      fs.unlinkSync(paths.askFile(id));
    } catch {}
  }

  function settle(id, approve, reason) {
    const h = queue.get(id);
    if (!h) return `unknown ${id}`;
    queue.delete(id);
    if (h.timer) clearTimeout(h.timer);
    removeAskFile(id);
    if (approve) {
      log({ ev: 'decide', id, agent: h.agent, decision: 'approve', reason: reason || undefined });
      onApprove(h);
      return `approved ${id}`;
    }
    log({ ev: 'decide', id, agent: h.agent, decision: 'deny', reason });
    onDeny(h, reason);
    return `denied ${id}`;
  }

  /**
   * Default `onAsk`: the file checkpoint. Polls this ask's answer file;
   * timeout (or a vanished queue entry) is deny. Malformed answers are
   * ignored with a log line and the wait continues until the deadline.
   *
   * @param {AskPayload} ask decision-ready ask
   * @returns {Promise<{ decision: 'allow' | 'deny', reason?: string }>} decision
   */
  async function defaultFileAsk(ask) {
    if (!paths) return { decision: 'deny', reason: 'ask channel failed' };
    const ansPath = paths.answerFile(ask.id);
    const deadline = ask.expiresAt ? Date.parse(ask.expiresAt) : Infinity;
    for (;;) {
      if (!queue.has(ask.id)) return { decision: 'deny', reason: 'settled elsewhere' };
      const text = consumeFile(ansPath);
      if (text !== null) {
        const parsed = parseAnswer(text);
        if (parsed) return parsed;
        log({ ev: 'malformed-answer', id: ask.id, note: 'ignored; still waiting' });
      }
      if (Date.now() >= deadline) return { decision: 'deny', reason: 'hold timeout' };
      await sleepMs(poll);
    }
  }

  const askFn = onAsk ?? defaultFileAsk;

  /**
   * Park an entry: write the ask file + stderr line (file channel only),
   * then resolve the decision through `onAsk`. Double-settle is safe:
   * the deadline timer and the answer race, and the loser finds no entry.
   *
   * @param {object} entry queue entry
   * @param {number|null} ms hold deadline in ms, or null for never
   * @param {string} rule hold-reason string
   * @returns {Promise<void>}
   */
  async function park(entry, ms, rule) {
    const ask = askPayload(entry, ms, rule);
    if (paths) {
      try {
        writeFileAtomic(paths.askFile(entry.id), JSON.stringify(ask));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log({ ev: 'deny', agent: entry.agent, code: 500, note: `ask channel failed: ${msg}` });
        settle(entry.id, false, 'ask channel failed');
        return;
      }
      try {
        process.stderr.write(`ASK OPEN ${entry.id}\n`);
      } catch {}
    }
    /** @type {{ decision: string, reason?: string } | null} */
    let decision = null;
    try {
      decision = await askFn(ask);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      decision = { decision: 'deny', reason: `onAsk failed: ${msg}` };
    }
    if (decision && (decision.decision === 'allow' || decision.decision === 'approve')) {
      settle(entry.id, true, '');
    } else {
      const reason = decision && typeof decision.reason === 'string' && decision.reason
        ? decision.reason
        : 'denied';
      settle(entry.id, false, reason);
    }
  }

  /**
   * Sweep answers for unknown or already-settled ids: stale, ignored,
   * logged, removed. Runs only for the file channel; a custom `onAsk`
   * owns its own late answers.
   *
   * @returns {void}
   */
  function sweepStaleAnswers() {
    if (!paths) return;
    let names;
    try {
      names = fs.readdirSync(paths.answersDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (queue.has(id)) continue;
      const consumed = consumeFile(paths.answerFile(id));
      if (consumed === null) continue;
      log({ ev: 'stale-answer', id, note: 'unknown or already-settled id; ignored' });
    }
  }

  const sweepTimer = paths
    ? setInterval(sweepStaleAnswers, poll)
    : null;
  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();

  const holds = {
    add({ agent, method, url, headers, body, sock, cres, note }) {
      const id = `h${++n}`;
      const ms = deadlineMs();
      const entry = {
        id, agent, method, url, headers, body, sock, cres, note, t0: Date.now(),
        timer: ms === null ? null
          : setTimeout(() => settle(id, false, 'hold timeout'), ms),
      };
      // Unref: a parked `never` hold must not keep the process alive by itself.
      if (entry.timer?.unref) entry.timer.unref();
      queue.set(id, entry);
      log({ ev: 'hold', id, agent, method, url, reason: note ?? undefined,
        timeoutMs: ms, waiting: queue.size });
      void park(entry, ms, note ?? '');
      return id;
    },

    approve(id) { return settle(id, true, ''); },
    deny(id, reason) { return settle(id, false, reason || 'denied by user'); },

    // The client went away: drop its holds so no later answer can forward
    // a request nobody is listening for.
    abandon(id) {
      const h = queue.get(id);
      if (!h) return;
      queue.delete(id);
      if (h.timer) clearTimeout(h.timer);
      removeAskFile(id);
      log({ ev: 'hold-abandoned', id, agent: h.agent, method: h.method, url: h.url });
      onDeny(h, 'client gone');
    },

    abandonSocket(sock) {
      for (const [id, h] of queue) {
        if (h.sock === sock) holds.abandon(id);
      }
    },

    decide(req) { return decide(req); },

    pending() { return [...queue.values()].map(pub); },
    size() { return queue.size; },

    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      for (const [id] of [...queue]) settle(id, false, 'proxy closing');
    },
  };

  return holds;
}

/**
 * Default decision: park requests whose path contains `match`.
 *
 * @param {string} match path substring
 * @returns {ShouldHold} decision function
 */
export function matchPath(match) {
  return (req) => (new URL(req.url).pathname.includes(match) ? `path matches ${match}` : null);
}
