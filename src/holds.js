// holds.js — the ONLY writer of the hold queue.
//
// A held request parks with its client socket open until the ask channel
// answers. Two channels, one queue:
// - `onAsk(ask) -> Promise<{ decision, reason? }>` (bareguard's
//   `humanChannel` shape): one promise per hold, no files involved.
// - the default file checkpoint: `<runtime>/asks/<id>.json` is written on
//   park, and ONE interval per queue reads `<runtime>/answers/` once per
//   tick (default 250 ms, PRD Q9), consuming each answer file (renamed away
//   before reading). An answer for a held id settles it; anything else is
//   stale: ignored, logged (`stale-answer`), removed.
// The deadline timer in `add()` is the only deadline: nothing else looks
// at the clock. Timeout — or any failure of the channel itself — is deny.
// A malformed answer (bad JSON, missing/unknown decision) is ignored,
// logged (`malformed-answer`), and removed; the hold keeps waiting until
// the deadline. The queue never throws on channel input: everything
// unexpected is loud in the log and eventually a deny.
//
// Decisions enter through one `normalizeDecision` (`allow`/`deny`, with
// `'approve'` accepted as an alias of `'allow'` in answer files only) and
// are reported through one optional `onEvent` callback: `{ type: 'ask' }`
// when a hold parks, `{ type: 'decided' }` when it settles or is abandoned
// (`deny` / `client gone`). Outcomes are
// reported, never reconstructed: `run()` and `sbx run` build their ask
// records from these events. The library never writes to stdout or stderr.
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
// ASK_BODY_LIMIT bytes with card numbers masked (`bodyPreview`) — M3's
// bareguard `secrets` redaction takes over the rest.
//
// A held request's body lives on disk, never whole in memory: the proxy
// spools it to `<runtime>/held/<id>` and this queue only keeps the preview
// and byte count. The file ends with the hold: deny, timeout, abandon and
// close delete it here (`dropBody`); an approve hands it to the proxy, which
// deletes it once the upstream has read it.
//
// Answer payload (`answers/<id>.json`): `{ decision: 'allow' | 'deny',
// reason? }`. `'approve'` is accepted as an alias of `'allow'`. Writers
// must write atomically (tmp file + rename); readers never see partials.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, runtimePaths } from './runtime.js';
import { maskCards } from './cardscan.js';

/** Body preview cap for `asks/<id>.json` (bytes). */
export const ASK_BODY_LIMIT = 4096;

/** Default cap on a held body (bytes): over it the request is denied at the door. */
export const DEFAULT_HOLD_MAX_BODY = 52428800;

/**
 * The one body preview, for the ask file and the audit log alike: the first
 * ASK_BODY_LIMIT bytes as utf8, with card numbers masked.
 *
 * @param {Buffer} head the body's first bytes (anything past ASK_BODY_LIMIT is ignored)
 * @returns {string} masked preview
 */
export function bodyPreview(head) {
  return maskCards(head.subarray(0, ASK_BODY_LIMIT).toString('utf8'));
}

/** Default answer poll interval in ms (PRD Q9). */
export const DEFAULT_POLL_MS = 250;

/** At most this many held requests wait in line per agent; the next is refused. */
const MAX_WAITING_PER_AGENT = 16;

/**
 * A parked request, as returned by {@link pending}. Plain objects only —
 * the queue itself never leaves this module. No body: returning whole
 * bodies from a status call is never needed, and the ask payload in
 * `asks/<id>.json` carries the preview.
 *
 * @typedef {object} HeldRequest
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket), never `c<n>`
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {string} rule hold-reason string from the decision function
 * @property {number} waitingSec seconds since the hold parked
 */

/**
 * A queue event, as delivered to the `onEvent` callback: `{ type: 'ask' }`
 * when a hold parks, `{ type: 'decided' }` when it settles or its client
 * goes away (`deny` / `client gone`): every ask ends in exactly one.
 *
 * @typedef {{ type: 'ask', ask: AskPayload } | { type: 'decided', id: string, decision: 'allow' | 'deny', reason?: string }} HoldEvent
 */

/**
 * Queue event callback.
 *
 * @typedef {(e: HoldEvent) => void} OnEvent
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
 * @property {string} bodyPreview request body preview, utf8, capped at ASK_BODY_LIMIT bytes, card numbers masked
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
 * Atomic write: tmp file + rename, so readers never see a partial payload.
 *
 * @param {string} file destination path
 * @param {string} text content
 * @returns {void}
 */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // 0600, not the 0644 default: asks carry the audit trail and unredacted
  // body previews, and answers carry the decision. (Umask can only remove
  // bits from 0600, never add group/other access.)
  fs.writeFileSync(tmp, text, { mode: 0o600 });
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
 * Validate an answer payload's shape. Returns the raw decision pair;
 * normalization (including the `'approve'` alias) is `normalizeDecision`'s
 * job. Anything unparsable, or with a missing decision, is malformed.
 *
 * @param {string} text raw answer file content
 * @returns {{ decision: unknown, reason?: unknown } | null} raw pair, or null when malformed
 */
function parseAnswer(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { decision, reason } = /** @type {{ decision?: unknown, reason?: unknown }} */ (obj);
  if (typeof decision !== 'string' || !decision) return null;
  return { decision, reason };
}

/**
 * The one normalization of decisions, applied once wherever a decision
 * enters (an answer file, or an `onAsk` result). The audit log speaks
 * `allow`/`deny`, which is bareguard's vocabulary.
 *
 * @param {{ decision?: unknown, reason?: unknown } | null} input raw decision pair
 * @param {object} [opts]
 * @param {boolean} [opts.approveAlias] accept `'approve'` as an alias of `'allow'` (answer files only)
 * @returns {{ decision: 'allow' | 'deny', reason?: string } | null} normalized, or null when not a decision at all
 */
export function normalizeDecision(input, { approveAlias = false } = {}) {
  const decision = input?.decision;
  if (decision === 'allow' || (approveAlias && decision === 'approve')) {
    return { decision: 'allow' };
  }
  if (decision === 'deny') {
    const reason = input?.reason;
    return {
      decision: 'deny',
      reason: typeof reason === 'string' && reason ? reason : 'denied',
    };
  }
  return null;
}

/**
 * Create the hold queue. One queue per runtime, enforced by `claimRuntime`
 * in `createProxy` (a second live proxy on the same runtime never starts):
 * on the file channel the queue owns `asks/` and `answers/` for its
 * runtime, clearing both at start and removing its asks on close, so no
 * answer outlives its queue. One parked request per agent: `reserve` hands
 * out the agent's hold slot before a held body is read, and the slot passes
 * to the next waiter when the parked entry leaves by any path.
 *
 * @param {object} opts
 * @param {(o: Record<string, unknown>) => void} opts.log audit-log writer
 * @param {ShouldHold} [opts.shouldHold] decision function (default: path-substring `match`)
 * @param {string} [opts.match] path substring that parks a request (default impl when `shouldHold` is absent)
 * @param {number|string} [opts.timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @param {number} [opts.maxBody] bodies over this are denied at the door, never queued (default 52428800)
 * @param {string|null} [opts.runtime] runtime dir; required for the default file checkpoint (writes `asks/`, polls `answers/`)
 * @param {OnAsk|null} [opts.onAsk] ask seam (bareguard `humanChannel` shape); when present no files are involved
 * @param {number} [opts.pollMs] answer poll interval in ms for the default file checkpoint (default 250, PRD Q9)
 * @param {OnEvent|null} [opts.onEvent] event callback: `{ type: 'ask' }` on park, `{ type: 'decided' }` on settle or abandon
 * @param {(entry: object) => void} opts.onApprove forward the parked request upstream
 * @param {(entry: object, reason: string) => void} opts.onDeny refuse the parked request
 * @returns {{ add: (entry: object) => string|null, dropBody: (id: string) => void, reserve: (agent: string, cbs: { onReady: () => void, onExpire: (reason: string) => void }) => { state: 'now'|'queued'|'full', id: string, arrivedAt: number, cancel: () => void }, decide: (req: { agent: string, method: string, url: string, headers: Record<string, string | string[] | undefined> }) => string | null, abandon: (id: string) => void, abandonSocket: (sock: object) => void, pending: () => HeldRequest[], close: () => void }} queue handle
 */
export function createHolds({ log, shouldHold, match, timeoutMs = 120000,
  maxBody = DEFAULT_HOLD_MAX_BODY, runtime = null, onAsk = null, pollMs = DEFAULT_POLL_MS,
  onEvent = null, onApprove, onDeny }) {
  // The default IS matchPath: one definition of the path-substring rule (see below).
  const decide = shouldHold ?? (match ? matchPath(match) : () => null);
  /** @returns {number|null} */
  const deadlineMs = () => {
    if (timeoutMs === 'never') return null;
    const ms = timeoutMs ?? 120000;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 120000;
  };
  if (onAsk != null && typeof onAsk !== 'function') {
    throw new Error('createHolds: onAsk must be a function');
  }
  if (onEvent != null && typeof onEvent !== 'function') {
    throw new Error('createHolds: onEvent must be a function');
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
  const paths = runtime ? runtimePaths(runtime) : null;
  if (paths) {
    ensurePrivateDir(paths.asksDir);
    ensurePrivateDir(paths.answersDir);
    ensurePrivateDir(paths.heldDir);
    // Held bodies of a dead queue are orphans (ids restart at h1).
    try {
      for (const name of fs.readdirSync(paths.heldDir)) {
        try { fs.unlinkSync(path.join(paths.heldDir, name)); } catch {}
      }
    } catch {}
  }
  // A dead queue's leftovers must never decide the next queue's holds
  // (ids restart at h1): clear both folders at start, logging one audit
  // line per removed answer.
  if (useFiles && paths) {
    for (const [dir, isAnswers] of /** @type {[string, boolean][]} */ ([[paths.asksDir, false], [paths.answersDir, true]])) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          continue;
        }
        if (isAnswers) {
          log({ ev: 'stale-answer', id: name.endsWith('.json') ? name.slice(0, -'.json'.length) : name, note: 'leftover from a dead queue; removed at start' });
        }
      }
    }
  }

  let n = 0;
  /** @type {Map<string, object>} */
  const queue = new Map();
  /**
   * One hold slot per agent: `holder` is the reservation holding it (or the
   * parked entry's marker), `line` the FIFO of waiting reservation handles.
   *
   * @type {Map<string, { holder: object|null, line: Array<object> }>}
   */
  const slots = new Map();
  /** Internal reserve state by returned handle identity. @type {WeakMap<object, { agent: string, onReady: () => void, onExpire: (reason: string) => void, timer: ReturnType<typeof setTimeout>|null, consumed: boolean, done: boolean, id: string }>} */
  const handleState = new WeakMap();

  /**
   * The one expiry path for every reservation timer: mark it done, take it
   * out of the line or hand its slot to the next waiter (whose own timer
   * keeps running from its arrival), then expire it. Once.
   *
   * @param {string} agent agent name
   * @param {object} handle the reservation's handle
   * @param {string} reason expiry reason
   * @returns {void}
   */
  function expireReservation(agent, handle, reason) {
    const st = handleState.get(handle);
    if (!st || st.done) return;
    st.done = true;
    st.timer = null;
    const s = slots.get(agent);
    if (s) {
      if (s.holder === handle) {
        releaseSlot(agent);
      } else {
        const i = s.line.indexOf(handle);
        if (i >= 0) s.line.splice(i, 1);
        if (!s.holder && s.line.length === 0) slots.delete(agent);
      }
    }
    st.onExpire(reason);
  }

  /**
   * Drop the current holder and hand the slot to the next waiter in line,
   * or forget the agent when nobody waits. A promoted waiter keeps its own
   * arrival timer: nothing here arms, clears or resets one.
   *
   * @param {string} agent agent name
   * @returns {void}
   */
  function releaseSlot(agent) {
    const s = slots.get(agent);
    if (!s) return;
    s.holder = null;
    const next = s.line.shift();
    if (!next) {
      slots.delete(agent);
      return;
    }
    s.holder = next;
    const hst = handleState.get(next);
    if (hst) hst.onReady();
  }

  const pub = (h) => ({
    id: h.id, agent: h.agent, method: h.method, url: h.url, rule: h.note,
    waitingSec: Math.round((Date.now() - h.t0) / 1000),
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
    return {
      id: entry.id,
      agent: entry.agent,
      method: entry.method,
      url: entry.url,
      rule,
      // M3 owns letters; everything the queue parks today is irreversible.
      letter: 'x',
      bodyPreview: entry.preview,
      truncated: entry.bodyBytes > ASK_BODY_LIMIT,
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

  /**
   * The one deleter of a held body file (the proxy calls it too, after an
   * approved upstream has read it, or when a reservation never parks).
   *
   * @param {string} id hold id
   * @returns {void}
   */
  function dropBody(id) {
    if (!paths) return;
    try { fs.unlinkSync(paths.heldFile(id)); } catch {}
  }

  function settle(id, approved, reason) {
    const h = queue.get(id);
    if (!h) return `unknown ${id}`;
    queue.delete(id);
    if (h.timer) clearTimeout(h.timer);
    if (h.slot) releaseSlot(h.agent);
    removeAskFile(id);
    const decision = approved ? 'allow' : 'deny';
    if (approved) {
      log({ ev: 'decide', id, agent: h.agent, decision, reason: reason || undefined });
      onApprove(h);
    } else {
      dropBody(id);
      log({ ev: 'decide', id, agent: h.agent, decision, reason });
      onDeny(h, reason);
    }
    onEvent?.({ type: 'decided', id, decision, reason: reason || undefined });
    return approved ? `approved ${id}` : `denied ${id}`;
  }

  /**
   * Park an entry: write the ask file (file channel only) and report the
   * ask. Double-settle is safe: the deadline timer and the answer race,
   * and the loser finds no entry. The file channel never waits here: the
   * single interval settles on answer, the timer denies on deadline.
   * The `onAsk` channel stays a promise per hold.
   *
   * @param {object} entry queue entry
   * @param {number|null} ms hold deadline in ms, or null for never
   * @param {string} rule hold-reason string
   * @returns {Promise<void>}
   */
  async function park(entry, ms, rule) {
    const ask = askPayload(entry, ms, rule);
    if (useFiles && paths) {
      try {
        writeFileAtomic(paths.askFile(entry.id), JSON.stringify(ask));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log({ ev: 'deny', agent: entry.agent, code: 500, note: `ask channel failed: ${msg}` });
        settle(entry.id, false, 'ask channel failed');
        return;
      }
    }
    onEvent?.({ type: 'ask', ask });
    if (!useFiles) {
      /** @type {{ decision?: unknown, reason?: unknown } | null} */
      let raw = null;
      try {
        raw = await onAsk(ask);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        raw = { decision: 'deny', reason: `onAsk failed: ${msg}` };
      }
      const norm = normalizeDecision(raw);
      if (norm && norm.decision === 'allow') settle(entry.id, true, '');
      else settle(entry.id, false, norm?.reason ?? 'denied');
    }
  }

  /**
   * The one answer reader (file channel only): each tick reads `answers/`
   * once, consuming every answer file. A held id settles; anything else is
   * stale (ignored, logged, removed). Malformed answers are ignored and
   * logged; the hold keeps waiting until its deadline.
   *
   * @returns {void}
   */
  function pollAnswers() {
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
      const text = consumeFile(paths.answerFile(id));
      if (text === null) continue;
      const norm = normalizeDecision(parseAnswer(text), { approveAlias: true });
      if (!norm) {
        log({ ev: 'malformed-answer', id, note: 'ignored; still waiting' });
        continue;
      }
      if (!queue.has(id)) {
        log({ ev: 'stale-answer', id, note: 'unknown or already-settled id; ignored' });
        continue;
      }
      settle(id, norm.decision === 'allow', norm.reason ?? '');
    }
  }

  const pollTimer = useFiles && paths
    ? setInterval(pollAnswers, poll)
    : null;
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();

  const holds = {
    /**
     * Park a held request. With `slot` (from `reserve`) the parked entry
     * takes over that slot, clearing the reservation's timer; with
     * `arrivedAt` the deadline counts from arrival, not from now. A
     * finished slot (expired, cancelled, closed, or no longer the holder)
     * parks nothing and returns `null`. Without `slot`, parks exactly as
     * before, without limit.
     *
     * The entry carries the masked `preview`, the full `bodyBytes` and, when
     * the body was spooled, its `bodyFile`; never the body itself.
     *
     * @param {object} entry queue entry
     * @returns {string|null} hold id, or null for a finished slot
     */
    add({ agent, method, url, headers, preview = '', bodyBytes = 0, bodyFile = null, sock, cres, note, slot, arrivedAt }) {
      const hst = typeof slot === 'object' && slot !== null ? handleState.get(slot) : undefined;
      const s = slots.get(agent);
      if (slot && (!hst || hst.done || !s || s.holder !== slot)) return null;
      const id = hst?.id ?? `h${++n}`;
      const ms = deadlineMs();
      const t0 = typeof arrivedAt === 'number' ? arrivedAt : Date.now();
      const entry = {
        id, agent, method, url, headers, preview, bodyBytes, bodyFile, sock, cres, note, t0,
        slot: null,
        timer: ms === null ? null
          : setTimeout(() => settle(id, false, 'hold timeout'), Math.max(0, ms - (Date.now() - t0))),
      };
      // Unref: a parked `never` hold must not keep the process alive by itself.
      if (entry.timer?.unref) entry.timer.unref();
      if (slot && hst && s && s.holder === slot) {
        if (hst.timer) clearTimeout(hst.timer);
        hst.timer = null;
        hst.consumed = true;
        s.holder = { parked: id };
        entry.slot = slot;
      }
      queue.set(id, entry);
      log({ ev: 'hold', id, agent, method, url, reason: note ?? undefined,
        timeoutMs: ms, waiting: queue.size, queued: s ? s.line.length : 0 });
      void park(entry, ms, note ?? '');
      return id;
    },

    /**
     * Ask for this agent's hold slot before reading a held request's body.
     * @param {string} agent
     * @param {{ onReady: () => void, onExpire: (reason: string) => void }} cbs
     * The handle's `id` is the id its hold will have (empty when `full`), so
     * the body file can be named before the hold parks.
     * @returns {{ state: 'now'|'queued'|'full', id: string, arrivedAt: number, cancel: () => void }}
     */
    reserve(agent, { onReady, onExpire }) {
      const arrivedAt = Date.now();
      // Internal slot state, keyed by the returned handle's identity: `add`
      // receives that same object as `slot`, so holder comparisons use it.
      // The one deadline timer lives here, armed below for 'now' and
      // 'queued' alike; expiry runs through `expireReservation` only.
      /** @type {{ agent: string, onReady: () => void, onExpire: (reason: string) => void, timer: ReturnType<typeof setTimeout>|null, consumed: boolean, done: boolean, id: string }} */
      const st = { agent, onReady, onExpire, timer: null, consumed: false, done: false, id: '' };
      const s0 = slots.get(agent);
      /** @type {'now'|'queued'|'full'} */
      const state = !s0 ? 'now' : (s0.line.length >= MAX_WAITING_PER_AGENT ? 'full' : 'queued');
      if (state !== 'full') st.id = `h${++n}`;
      const handle = {
        state,
        id: st.id,
        arrivedAt,
        cancel() {
          if (st.done) return;
          st.done = true;
          if (st.timer) clearTimeout(st.timer);
          st.timer = null;
          if (st.consumed) return;
          const s = slots.get(agent);
          if (!s) return;
          if (s.holder === handle) {
            releaseSlot(agent);
            return;
          }
          const i = s.line.indexOf(handle);
          if (i >= 0) {
            s.line.splice(i, 1);
            if (!s.holder && s.line.length === 0) slots.delete(agent);
          }
        },
      };
      handleState.set(handle, st);
      if (state === 'now') {
        slots.set(agent, { holder: handle, line: [] });
      } else if (state === 'full') {
        log({ ev: 'hold-queue-full', agent });
        return handle;
      } else {
        if (!s0) throw new Error(`reserve: no slot record for ${agent}`);
        s0.line.push(handle);
      }
      const ms = deadlineMs();
      if (ms !== null) {
        st.timer = setTimeout(() => expireReservation(agent, handle, 'hold timeout'), ms);
        if (st.timer.unref) st.timer.unref();
      }
      return handle;
    },

    // The client went away: drop its holds so no later answer can forward
    // a request nobody is listening for.
    abandon(id) {
      const h = queue.get(id);
      if (!h) return;
      queue.delete(id);
      if (h.timer) clearTimeout(h.timer);
      if (h.slot) releaseSlot(h.agent);
      removeAskFile(id);
      dropBody(id);
      log({ ev: 'hold-abandoned', id, agent: h.agent, method: h.method, url: h.url });
      onDeny(h, 'client gone');
      onEvent?.({ type: 'decided', id, decision: 'deny', reason: 'client gone' });
    },

    abandonSocket(sock) {
      for (const [id, h] of queue) {
        if (h.sock === sock) holds.abandon(id);
      }
    },

    decide(req) { return decide(req); },

    dropBody,

    pending() { return [...queue.values()].map(pub); },

    close() {
      if (pollTimer) clearInterval(pollTimer);
      for (const s of [...slots.values()]) {
        const handles = [...s.line];
        if (s.holder && !('parked' in s.holder)) handles.push(s.holder);
        for (const handle of handles) {
          const hst = handleState.get(handle);
          if (!hst) continue;
          if (hst.timer) clearTimeout(hst.timer);
          hst.timer = null;
          hst.done = true;
          hst.onExpire('proxy closing');
        }
      }
      slots.clear();
      // settle() removes each ask file: `sbx pending` never lists a dead queue's holds.
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
