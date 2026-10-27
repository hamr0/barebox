// holds.js — the ONLY writer of the hold queue.
//
// A held request parks with its client socket open until a human approves,
// denies, or the deadline / client / proxy goes away first. Approving a hold
// whose client is gone must be impossible: `abandon()` removes the entry, so
// a later `approve` answers `unknown <id>` and nothing is forwarded.
import net from 'node:net';
import fs from 'node:fs';

/**
 * A parked request, as returned by {@link pending}. Plain objects only —
 * the queue itself never leaves this module.
 *
 * @typedef {object} HeldRequest
 * @property {string} id hold id (`h<n>`)
 * @property {string} agent agent name (its socket), never `c<n>`
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {string} body request body so far (utf8)
 * @property {number} waitingSec seconds since the hold parked
 */

/**
 * Decide whether a request parks. Return a human-readable reason, or null
 * to forward. M3 plugs the rwxmap + bareguard classifier into this one seam.
 *
 * @typedef {(req: { agent: string, method: string, url: string, headers: Record<string, string | string[] | undefined> }) => string | null} ShouldHold
 */

/**
 * Create the hold queue.
 *
 * @param {object} opts
 * @param {(o: Record<string, unknown>) => void} opts.log audit-log writer
 * @param {ShouldHold} [opts.shouldHold] decision function (default: path-substring `match`)
 * @param {string} [opts.match] path substring that parks a request (default impl when `shouldHold` is absent)
 * @param {number|string} [opts.timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @param {number} [opts.maxBody] bodies over this are denied at the door, never queued (default 1048576)
 * @param {string|null} [opts.controlSocket] unix socket path for `pending | approve | deny`
 * @param {(entry: object) => void} opts.onApprove forward the parked request upstream
 * @param {(entry: object, reason: string) => void} opts.onDeny refuse the parked request
 * @returns {{ add: (entry: object) => string, decide: (req: { agent: string, method: string, url: string, headers: Record<string, string | string[] | undefined> }) => string | null, approve: (id: string) => string, deny: (id: string, reason: string) => string, abandon: (id: string) => void, abandonSocket: (sock: object) => void, pending: () => HeldRequest[], size: () => number, close: () => void }} queue handle
 */
export function createHolds({ log, shouldHold, match, timeoutMs = 120000,
  maxBody = 1048576, controlSocket = null, onApprove, onDeny }) {
  const decide = shouldHold
    ?? ((req) => (match && new URL(req.url).pathname.includes(match) ? `path matches ${match}` : null));
  /** @returns {number|null} */
  const deadlineMs = () => {
    if (timeoutMs === 'never') return null;
    const ms = timeoutMs ?? 120000;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 120000;
  };

  let n = 0;
  /** @type {Map<string, object>} */
  const queue = new Map();

  const pub = (h) => ({
    id: h.id, agent: h.agent, method: h.method, url: h.url,
    body: h.body.toString('utf8'), waitingSec: Math.round((Date.now() - h.t0) / 1000),
  });

  function settle(id, approve, reason) {
    const h = queue.get(id);
    if (!h) return `unknown ${id}`;
    queue.delete(id);
    if (h.timer) clearTimeout(h.timer);
    if (approve) {
      log({ ev: 'decide', id, agent: h.agent, decision: 'approve', reason: reason || undefined });
      onApprove(h);
      return `approved ${id}`;
    }
    log({ ev: 'decide', id, agent: h.agent, decision: 'deny', reason });
    onDeny(h, reason);
    return `denied ${id}`;
  }

  const holds = {
    add({ agent, method, url, headers, body, sock, cres, note }) {
      const id = `h${++n}`;
      const ms = deadlineMs();
      const entry = {
        id, agent, method, url, headers, body, sock, cres, t0: Date.now(),
        timer: ms === null ? null
          : setTimeout(() => settle(id, false, 'hold timeout'), ms),
      };
      // Unref: a parked `never` hold must not keep the process alive by itself.
      if (entry.timer?.unref) entry.timer.unref();
      queue.set(id, entry);
      log({ ev: 'hold', id, agent, method, url, reason: note ?? undefined,
        timeoutMs: ms, waiting: queue.size });
      return id;
    },

    approve(id) { return settle(id, true, ''); },
    deny(id, reason) { return settle(id, false, reason || 'denied by user'); },

    // The client went away: drop its holds so no later approve can forward
    // a request nobody is listening for.
    abandon(id) {
      const h = queue.get(id);
      if (!h) return;
      queue.delete(id);
      if (h.timer) clearTimeout(h.timer);
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
      for (const [id] of queue) settle(id, false, 'proxy closing');
      ctl?.close();
    },
  };

  let ctl = null;
  if (controlSocket) {
    try { fs.unlinkSync(controlSocket); } catch {}
    ctl = net.createServer((sock) => {
      let line = '';
      sock.on('data', (ch) => {
        line += ch.toString('latin1');
        const i = line.indexOf('\n');
        if (i < 0) return;
        const [cmd, arg, ...rest] = line.slice(0, i).trim().split(' ');
        let out = '';
        if (cmd === 'pending') out = JSON.stringify(holds.pending());
        else if (cmd === 'approve' && arg) out = holds.approve(arg);
        else if (cmd === 'deny' && arg) out = holds.deny(arg, rest.join(' '));
        else out = 'usage: pending | approve <id> | deny <id> [reason]';
        sock.end(out + '\n');
      });
      sock.on('error', () => {});
    });
    ctl.on('error', () => {});
    ctl.listen(controlSocket, () => {
      // Anyone who can connect can approve payments.
      try { fs.chmodSync(controlSocket, 0o600); } catch {}
    });
  }

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
