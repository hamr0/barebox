// Proxy: the front door. Terminates agent TLS with per-host certificates
// minted on demand, sees every request through a private stdlib http.Server
// (so HEAD, 204/304, chunked, keep-alive and slow upstreams just work),
// forwards with https/http.request, and asks a gate about every request
// (bareguard, one gate per agent; see `gateFor`). When the gate asks, the
// hold queue is its human channel: the request parks for a human decision.
// Identity = socket: each agent has its own unix listener, and every log
// line and hold names the agent, never `c<n>`.
//
// Timeout shape: the client idle clock is the server's keep-alive timeout —
// by construction it only ticks when no request is in flight. The upstream
// response gets its own much longer clock.
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { ensureCA, certFor, HOST_RE } from './certs.js';
import { createCardScanner } from './cardscan.js';
import { ASK_BODY_LIMIT, DEFAULT_HOLD_MAX_BODY, bodyPreview, createHolds } from './holds.js';
import { claimRuntime, ensurePrivateDir, runtimePaths } from './runtime.js';
import { paymentPath, toolFor, buildTools, emptyMatcher } from './policy.js';
import { checkUpstream } from './wall.js';
import { Gate } from 'bareguard';

const AGENT = Symbol('agent');
const SECURE = Symbol('secure');
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
// Hop-by-hop headers must not be forwarded: node's HTTP stack re-frames.
const HOP_REQ = new Set(['proxy-connection', 'proxy-authorization']);
// Bodies up to this size are read whole (under the agent's working slot) so
// the card floor can scan them; a bigger body streams on, unchecked.
const WORK_BODY_LIMIT = 65536;
const EMPTY = Buffer.alloc(0);
const HOP_RESP = new Set(['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * Options for {@link createProxy}.
 *
 * @typedef {object} ProxyOptions
 * @property {string} logFile the runtime's one audit file (`runtimePaths(runtime).audit`), in bareguard's JSON-lines shape: every agent's gate and the runtime's own `sbx` gate append to it. barebox's own facts are `annotate` lines (`verdict` = `resp`, `deny`, `hold`, `decide`, `hold-abandoned`, ...); a response status is a `record` line joined to its request's `check` by `aid`.
 * @property {string} runtime runtime dir; required. Holds the CA + minted host certs (`certs/`, see `runtime.js`), the agent sockets, and the hold queue files.
 * @property {number} [port] opt-in TCP listener for tests, bound to 127.0.0.1 only (default: none)
 * @property {string} [upstreamCa] extra PEM the proxy trusts for upstream TLS, on top of system roots
 * @property {(agent: string, ctx: { humanChannel: (event: any) => Promise<{ decision: 'allow' | 'deny', reason?: string }>, tools: Record<string, any> }) => GateLike | Promise<GateLike>} [gateFor] builds the gate that decides one agent's requests (called once per agent, and once for the TCP door's `tcp` agent); `ctx.humanChannel` is the hold queue and `ctx.tools` the runtime's one tools table, both to hand to a bareguard `Gate`. Omit it to forward everything.
 * @property {{ matcher: { match: (method: string, url: string) => { key: string, source: string } }, tools: Record<string, any> }} [labels] the loaded label files (see `loadLabels`); omitted means no labels, only the built-in model endpoints
 * @property {string[]} [allowLocal] exact `host:port` pairs (the `localLlm` setting) that may pass the wall's private/loopback check; any other local destination is still denied
 * @property {HoldOptions} [hold] hold queue config (deadline, caps, ask seam)
 * @property {number} [upstreamTimeoutMs] give up on an upstream response after this (default 120000)
 * @property {object} [unsafeTestOnly] TEST-ONLY escape hatch: everything under
 *   it weakens the sandbox wall, so production omits it and tests name it loudly.
 * @property {boolean} [unsafeTestOnly.allowLoopback] let loopback and unspecified
 *   destinations through (default false). Fixture servers listen on 127.0.0.1,
 *   so tests pass this; production never should.
 * @property {(host: string) => Promise<string[] | string | null>} [unsafeTestOnly.resolveUpstream]
 *   DNS stub: replaces the wall's resolver so rebinding is testable. Production omits it.
 * @property {number} [clientIdleMs] kill a client tunnel idle this long; never fires mid-request (default 60000)
 * @property {(entry: Record<string, unknown>) => Record<string, unknown>} [redact] log redaction hook, applied after built-in secret scrubbing; its result becomes the `meta` of an `annotate` line (default: identity)
 */

/**
 * Anything with bareguard's `check`: a `Gate`, or a plain object for tests. An
 * `askHuman` outcome from a plain object goes to the same human channel.
 *
 * @typedef {{ check: (action: Record<string, unknown>) => Promise<{ outcome: string, rule?: string, reason?: string | null, aid?: string }>, record?: (action: Record<string, unknown>, result: Record<string, unknown>, opts?: { aid?: string }) => Promise<void>, annotate?: (fact: Record<string, unknown>) => Promise<void>, drainAnnotations?: () => unknown[] }} GateLike
 */

/**
 * Hold queue options (the queue lives in holds.js).
 *
 * @typedef {object} HoldOptions
 * @property {number|string} [timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @property {number} [maxBody] bodies over this are denied at the door, never queued; held bodies spool to `<runtime>/held` (default 52428800)
 * @property {import('./holds.js').OnAsk|null} [onAsk] ask seam (bareguard `humanChannel` shape).
 *   When present no files are involved; omit it for the default file checkpoint
 *   (`<runtime>/asks` + `<runtime>/answers`, `sbx pending/approve/deny`).
 * @property {number} [pollMs] answer poll interval in ms for the file checkpoint (default 250)
 * @property {import('./holds.js').OnEvent} [onEvent] event callback: `{ type: 'ask' }` on park, `{ type: 'decided' }` on settle
 */

/**
 * One upstream forwarding: buffered body (approve path) or live stream.
 *
 * @typedef {object} ForwardArgs
 * @property {string} agent agent name (its socket)
 * @property {string} method HTTP method
 * @property {string} url full URL
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Buffer} [body] buffered body
 * @property {Buffer} [prefix] bytes already read from `stream`, written upstream before it
 * @property {import('node:stream').Readable} [stream] live body: the request itself, or a held body's file
 * @property {import('node:http').ServerResponse} cres parked or live client response
 * @property {{ gate: GateLike, action: Record<string, unknown>, aid: string }} [rec] the deciding gate, the request's action and the decision's aid: the response status is recorded there (absent: it is logged as a `resp` fact)
 */

/**
 * Live proxy. Let `tsc` infer the shape; adopters import the name.
 *
 * @typedef {ReturnType<typeof createProxy>} Proxy
 */

/**
 * Start the front-door proxy. Every request is audited with its method and URL, and a request with a body also with its byte count and SHA-256 (never headers or body text); bytes go upstream untouched. Requests the hold rule
 * flags park for a human decision instead of forwarding.
 *
 * @param {ProxyOptions} opts
 * @returns live proxy: `ready` resolves when listeners + CA are up; the shape is inferred, see `Proxy`
 * @when Reach for this HARNESS-ONLY to run the front door: it terminates agent TLS, sees every request, and parks the ones a human must decide. It decides nothing itself; pair with the launcher for sandboxes and `sbx` for decisions.
 * @fails Throws synchronously on a missing or unopenable `logFile` or `runtime`. Throws when another live proxy owns the runtime; the claim dies with its process; nothing is ever taken over. At runtime, dead upstreams, malformed input, over-cap and timed-out holds all become loud logged HTTP errors, never silence and never a crash. A second proxy on the same port rejects `ready`, never crashes the process.
 * @example
 * import { createProxy } from "barebox";
 * const proxy = createProxy({ port: 0, runtime: "./sbx-runtime", logFile: "./mitm.log" });
 * const { port } = await proxy.ready;
 * await proxy.close();
 */
export function createProxy(opts) {
  const { logFile, runtime, port = null,
    upstreamCa = null, hold = null, gateFor = null, allowLocal = [], labels = null,
    upstreamTimeoutMs = 120000, clientIdleMs = 60000,
    unsafeTestOnly = null,
    redact = (e) => e } = opts ?? {};
  const { allowLoopback = false, resolveUpstream = null } = unsafeTestOnly ?? {};
  const gate = {
    allowLoopback, resolveUpstream: resolveUpstream ?? undefined,
    allowLocal: new Set(allowLocal.map((e) => String(e).toLowerCase())),
  };
  /** @param {URL} u @returns {number} */
  const portOf = (u) => (u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80));
  // One tools table and one matcher per runtime, shared by every gate.
  const matcher = labels?.matcher ?? emptyMatcher;
  const tools = buildTools(labels?.tools, [...allowLocal]);
  if (!logFile) throw new Error('createProxy: logFile is required');
  if (typeof runtime !== 'string' || !runtime) throw new Error('createProxy: runtime is required');
  // One live proxy per runtime, enforced here: claimed before the hold
  // queue clears `asks/` and `answers/`, so that clearing can never wipe a
  // live owner's files — only a dead owner's leftovers can be there.
  const releaseClaim = claimRuntime(runtime);
  // Always `<runtime>/certs`: one layout, owned by runtime.js, so there is
  // nothing to contain and no check to fail.
  const certDir = runtimePaths(runtime).certsDir;
  const holdMaxBody = hold?.maxBody ?? DEFAULT_HOLD_MAX_BODY;
  const heldFile = runtimePaths(runtime).heldFile;

  // Open the audit file synchronously: a bad `logFile` (a directory, a
  // missing parent, no permission) throws here, where the claim can still
  // be released — not later as an uncaught error. bareguard appends to it.
  try {
    fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    releaseClaim();
    throw new Error(`createProxy: cannot open logFile ${logFile}: ${msg}`);
  }
  // `openSync`'s mode is masked by the umask and doesn't apply to an
  // existing file: a 0644 log from an older run would stay world-readable
  // while new lines append, so fix it up on every start.
  try { fs.chmodSync(logFile, 0o600); } catch {}

  // The audit file has one shape: bareguard's. A response status is a
  // `gate.record` joined to its request's `check` by aid; every other fact is
  // an `annotate({ surface: false })` on the agent's gate when it is built, else
  // on the runtime's own `sbx` gate (which never runs `check()`).
  /** @type {GateLike} */
  let sbxGate;
  try {
    sbxGate = /** @type {GateLike} */ (/** @type {unknown} */ (new Gate({ audit: { path: logFile } })));
  } catch (e) {
    releaseClaim();
    throw e;
  }
  const sbxInit = /** @type {{ init: () => Promise<void> }} */ (/** @type {unknown} */ (sbxGate)).init();
  sbxInit.catch(() => {}); // reported by the first line that awaits it
  /** Gates by agent: the only place a gate is kept (see `gateOf`). @type {Map<string, { p: Promise<GateLike>, gate: GateLike|null }>} */
  const gates = new Map();
  /** @type {Set<Promise<void>>} */
  const pendingLog = new Set();
  let logClosing = false;
  let logFailed = false;
  /** @param {unknown} e */
  const logFail = (e) => {
    if (logFailed) return;
    logFailed = true;
    console.error(`sbx: audit log ${logFile} write failed: ${e instanceof Error ? e.message : String(e)}`);
  };
  /** Track one audit write; a failure is reported once, never thrown. @param {() => Promise<unknown>} fn */
  const track = (fn) => {
    // After close() ends the flush a late line (a socket torn down by close)
    // is dropped on purpose: a write nobody waits for would wedge close().
    if (logClosing) return;
    const p = fn().then(() => {}, logFail).then(() => { pendingLog.delete(p); });
    pendingLog.add(p);
  };
  /** Cut a string field. @param {unknown} v @param {number} n */
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);
  /**
   * barebox's fact as the `meta` of an annotate. The bound is an adapter for
   * bareguard (upstream ask pending).
   * @param {Record<string, unknown>} o
   * @returns {Record<string, unknown>}
   */
  const metaOf = (o) => {
    const { ev: _ev, ...meta } = redact(o);
    meta['url'] = cut(meta['url'], 400);
    meta['note'] = cut(meta['note'], 200);
    meta['reason'] = cut(meta['reason'], 200);
    if (Buffer.byteLength(JSON.stringify(meta)) <= 900) return meta;
    /** @type {Record<string, unknown>} */
    const small = {};
    for (const k of ['id', 'agent', 'method', 'code', 'decision']) if (meta[k] !== undefined) small[k] = meta[k];
    if (meta['url'] !== undefined) small['url'] = cut(meta['url'], 200);
    return small;
  };
  /** @param {Record<string, unknown>} o */
  async function writeLog(o) {
    const agent = typeof o['agent'] === 'string' ? o['agent'] : null;
    // Never build a gate from here: a built one, else the sbx gate.
    const entry = agent ? gates.get(agent) : undefined;
    const cand = entry?.gate ?? null;
    const g = cand && typeof cand.annotate === 'function' ? cand : sbxGate;
    if (g === sbxGate) await sbxInit;
    const where = [o['id'], o['agent'], o['code'], o['method'], o['url'] ?? o['note']]
      .filter((x) => x !== undefined && x !== null).join(' ');
    try {
      await /** @type {NonNullable<GateLike['annotate']>} */ (g.annotate)({
        surface: false, verdict: String(o['ev']), where, meta: metaOf(o) });
    } finally {
      // Adapter for bareguard (upstream ask pending): barebox has no turns, so nothing else drains the buffer.
      g.drainAnnotations?.();
    }
  }
  // Synchronous for callers (holds.js shares it); the write is tracked.
  /** @param {Record<string, unknown>} o */
  const log = (o) => { track(() => writeLog(o)); };
  let trust = null;
  if (upstreamCa) {
    let extra;
    try { extra = fs.readFileSync(upstreamCa, 'utf8'); }
    catch (e) {
      releaseClaim();
      throw new Error(`createProxy: cannot read upstreamCa: ${e.message}`);
    }
    trust = [...tls.rootCertificates, extra];
  }

  /** @type {Set<import('node:net').Socket>} */
  const clients = new Set();
  /** @type {Set<import('node:http').ClientRequest>} */
  const upstreams = new Set();
  const agentServers = new Map();
  /** @type {import('node:net').Server|null} */
  let tcp = null;
  let closed = false;

  const agentOf = (sock) => sock[AGENT] ?? 'tcp';

  // The one writer of a proxied HTTP error: logs it, answers it.
  function denyRes(cres, code, note) {
    const sock = cres.socket;
    log({ ev: 'deny', agent: agentOf(sock), code, note });
    try {
      if (!cres.headersSent && !sock.destroyed) {
        cres.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
      }
      if (!sock.destroyed) cres.end(`${note}\n`);
    } catch {}
  }

  // Pre-HTTP raw sockets only (CONNECT line, oversized head, walled CONNECT, cert failure).
  function denyRaw(sock, code, note) {
    log({ ev: 'deny', agent: agentOf(sock), code, note });
    if (sock.destroyed) return;
    try { sock.end(`HTTP/1.1 ${code} ${note}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${note}\n`); }
    catch {}
  }

  // Enforcement sits here (every forward, incl. the approve path) AND at
  // the door (request handler + CONNECT): a parked hold is re-checked on
  // approve, so a DNS change while parked cannot slip through.
  // A body stream nobody will pipe: a held file is closed (its owner then
  // deletes it); a live request is drained so its response can go out.
  /** @param {import('node:stream').Readable|undefined} stream */
  function discard(stream) {
    try {
      if (stream instanceof fs.ReadStream) stream.destroy();
      else stream?.resume();
    } catch {}
  }

  /** @param {ForwardArgs} args */
  async function forward({ agent, method, url, headers, body, prefix, stream, cres, rec }) {
    let u;
    try {
      u = new URL(url);
    } catch {
      discard(stream);
      denyRes(cres, 400, 'bad request target');
      return;
    }
    const verdict = await checkUpstream(u.hostname, gate, portOf(u));
    if (!verdict.ok) {
      discard(stream);
      denyRes(cres, 403, verdict.reason);
      return;
    }
    // Sync from here: forwardInner answers every failure itself, but a
    // throw before it can answer must still be loud, never a floating reject.
    // The dial is pinned to the checked IPs: no second DNS resolution.
    try {
      forwardInner({ agent, method, url, headers, body, prefix, stream, cres, rec, u, upstreamIps: verdict.ips });
    } catch (e) {
      // The live stream arrives paused (see handleRequest): unpause so no
      // paused stream leaks on this path.
      discard(stream);
      denyRes(cres, 502, `upstream failed: ${e.message}`);
    }
  }

  /** @param {ForwardArgs & { u: URL, upstreamIps: string[] }} args */
  function forwardInner({ agent, method, url, headers, body, prefix, stream, cres, rec, u, upstreamIps }) {
    const sock = cres.socket;
    if (!sock) { discard(stream); return; } // no transport left to answer on
    const secure = u.protocol === 'https:';
    /** @type {Record<string, string | string[] | undefined>} */
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_REQ.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    const pinned = (upstreamIps ?? []).filter((ip) => net.isIP(ip));
    const mod = secure ? https : http;
    const up = mod.request({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (secure ? 443 : 80),
      // Pinned dial: answer from the checked IPs, never DNS again. Node asks
      // with `{ all: true }` and attempts every address (Happy Eyeballs: a
      // refused address falls through to the next, each attempt short-timed);
      // otherwise the first pinned address answers alone. A custom socket
      // cannot serve here: the TLS stack will not handshake over one.
      ...(pinned.length ? { lookup: (h, o, cb) => {
        const done = /** @type {(err: unknown, ...rest: unknown[]) => void} */ (typeof o === 'function' ? o : cb);
        /** @param {string} ip */
        const fam = (ip) => net.isIP(ip);
        try {
          const opts = typeof o === 'function' ? {} : (o ?? {});
          if (opts && /** @type {{ all?: boolean }} */ (opts).all) {
            done(null, pinned.map((address) => ({ address, family: fam(address) })));
          } else {
            const first = /** @type {string} */ (pinned[0]);
            done(null, first, fam(first));
          }
        } catch (e) {
          done(e);
        }
      } } : {}),
      ...(secure && !IP_RE.test(u.hostname) ? { servername: u.hostname } : {}),
      ...(secure && trust ? { ca: trust } : {}),
      method, path: u.pathname + u.search, headers: fwdHeaders,
    });
    upstreams.add(up);
    let done = false;
    const fail = (note) => {
      if (done) return;
      done = true;
      upstreams.delete(up);
      denyRes(cres, 502, note);
    };
    up.setTimeout(upstreamTimeoutMs, () => { up.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs}ms`)); });
    up.on('response', (ures) => {
      /** @type {Record<string, string | string[] | undefined>} */
      const respHeaders = {};
      for (const [k, v] of Object.entries(ures.headers)) {
        if (!HOP_RESP.has(k.toLowerCase()) && v !== undefined) respHeaders[k] = v;
      }
      if (ures.statusCode === undefined) { fail('upstream sent no status'); up.destroy(); return; }
      const status = ures.statusCode;
      if (rec && typeof rec.gate.record === 'function') {
        const { gate: g, action, aid } = rec;
        track(() => /** @type {NonNullable<GateLike['record']>} */ (g.record)(action, { status }, { aid }));
      } else log({ ev: 'resp', agent, url, status });
      try {
        cres.writeHead(ures.statusCode, respHeaders);
      } catch (e) { fail(`cannot frame upstream response: ${e.message}`); up.destroy(); return; }
      ures.on('end', () => {
        if (done) return;
        done = true;
        upstreams.delete(up);
      });
      ures.on('error', (e) => fail(`upstream body failed: ${e.message}`));
      ures.pipe(cres);
    });
    up.on('error', (e) => fail(`upstream ${u.hostname} failed: ${e.message}`));
    // Client went away mid-flight: stop paying for the upstream.
    cres.on('close', () => {
      if (!done && !cres.writableEnded) { done = true; upstreams.delete(up); up.destroy(); }
    });
    if (body) up.end(body);
    else if (stream) {
      // A held body's file: closed when the request is done with it, and a
      // read failure (the file vanished) fails the request, never crashes.
      if (stream instanceof fs.ReadStream) {
        up.once('close', () => stream.destroy());
        stream.once('error', (e) => up.destroy(e));
      }
      if (prefix?.length) up.write(prefix);
      stream.pipe(up);
    } else up.end();
  }

  // The rest of setup is infallible synchronously except this call, so a
  // throw here releases the claim before it propagates (like upstreamCa
  // above); async failures release through `ready` and `close()` below.
  // The queue is the gate's human channel, so a gate means a queue.
  let holds = null;
  try {
    holds = (hold || gateFor) ? createHolds({
      log,
      timeoutMs: hold?.timeoutMs,
      maxBody: holdMaxBody,
      runtime,
      onAsk: hold?.onAsk,
      pollMs: hold?.pollMs,
      onEvent: hold?.onEvent,
      // A parked request's pending ask ends here: handleRequest, awaiting
      // its gate, then forwards or refuses.
      onApprove: (h) => h.finish({ decision: 'allow' }),
      onDeny: (h, reason) => h.finish({ decision: 'deny', reason }),
    }) : null;
  } catch (e) {
    releaseClaim();
    throw e;
  }

  const server = http.createServer((creq, cres) => {
    // Async only for the wall's DNS lookup; no body listener is attached
    // before the check, so nothing is lost while it resolves.
    reqDone.set(creq, handleRequest(creq, cres)
      .catch((e) => denyRes(cres, 500, `proxy failed: ${e.message}`)));
  });

  /** Each request's handler promise, so `close()` can wait for those inside a gate check. @type {WeakMap<object, Promise<void>>} */
  const reqDone = new WeakMap();

  /**
   * Gates by agent, built lazily (and at `addAgent`): one per agent, so the
   * grant is the agent's own. `gates` (declared with the log) is the only
   * place a gate is kept; `entry.gate` is set once the build settled.
   *
   * @param {string} agent
   * @returns {Promise<GateLike>}
   */
  function gateOf(agent) {
    let e = gates.get(agent);
    if (!e) {
      if (!gateFor) throw new Error('createProxy: no gateFor');
      const p = Promise.resolve().then(() => gateFor(agent, { humanChannel: askHuman, tools }));
      const entry = { p, gate: /** @type {GateLike|null} */ (null) };
      e = entry;
      gates.set(agent, entry);
      p.then((g) => { entry.gate = g; },
        // A failed build must not stick: the next request tries again, loudly.
        () => { if (gates.get(agent) === entry) gates.delete(agent); });
    }
    return e.p;
  }

  /**
   * Requests inside `gate.check()`, by `rid`: how the human channel finds
   * the request an ask is about. handleRequest sets and deletes each entry
   * (the one writer); the channel only reads it and sets the fields it owns
   * (`asked`, `status`, `heldId`, `endAsk`).
   *
   * @type {Map<string, RequestCtx>}
   */
  const inflightCtx = new Map();
  let ridN = 0;

  /**
   * @typedef {object} RequestCtx
   * @property {string} agent agent name
   * @property {string} method HTTP method
   * @property {string} url full URL
   * @property {Record<string, string | string[] | undefined>} headers request headers
   * @property {import('node:http').IncomingMessage} creq the request (paused)
   * @property {import('node:http').ServerResponse} cres the response
   * @property {ReturnType<typeof makeTee>} tee the body tee (masked preview, byte count)
   * @property {boolean} hasBody the request carries a body
   * @property {Buffer[]} chunks the body bytes read so far (up to ~64 KB)
   * @property {boolean} over more body follows `chunks`, unread in `creq`
   * @property {() => void} freeWork release the agent's working slot (idempotent)
   * @property {boolean} asked the human channel took this request
   * @property {number|null} status HTTP status the channel wants for a denial (null: 403)
   * @property {string|null} heldId id of the held body file, once spooled
   * @property {((reason: string) => void)|null} endAsk end a not-yet-parked ask as a denial
   */

  /**
   * The human channel (bareguard `humanChannel` shape): every gate's asks
   * come here. Finds the request by `event.action.rid`, then holds it.
   *
   * @param {{ action?: { rid?: unknown }, rule?: string, rwxLetter?: string }} event
   * @returns {Promise<{ decision: 'allow' | 'deny', reason?: string }>}
   */
  async function askHuman(event) {
    const ctx = inflightCtx.get(String(event?.action?.rid));
    if (!ctx) return { decision: 'deny', reason: 'request gone' };
    ctx.asked = true;
    return holdRequest(ctx, event);
  }

  /**
   * Hold one request for the human: reserve the agent's hold slot, spool the
   * body to `<runtime>/held/<id>` (the bytes already read plus the rest of
   * the stream, capped at `holdMaxBody`), free the working slot, park, and
   * wait. The promise settles once: on the queue's decision, on expiry, or
   * when the client or the proxy goes away first.
   *
   * @param {RequestCtx} ctx the request
   * @param {{ rule?: string, rwxLetter?: string }} event the gate's ask
   * @returns {Promise<{ decision: 'allow' | 'deny', reason?: string }>}
   */
  function holdRequest(ctx, event) {
    return new Promise((resolve) => {
      const queue = /** @type {NonNullable<typeof holds>} */ (holds);
      const { agent, cres, creq } = ctx;
      const sock = cres.socket;
      let settled = false;
      let parked = false;
      let dead = false;
      /** @type {import('node:fs').WriteStream|null} */
      let ws = null;
      /** @param {{ decision: 'allow' | 'deny', reason?: string }} d */
      const finish = (d) => {
        if (settled) return;
        settled = true;
        ctx.endAsk = null;
        resolve(d);
      };
      /** @param {string} reason @param {number} [status] */
      const refuse = (reason, status) => {
        if (status) ctx.status = status;
        finish({ decision: 'deny', reason });
      };
      const abort = () => {
        if (dead) return;
        dead = true;
        ws?.destroy();
        queue.dropBody(slot.id);
      };
      /** @param {string} why @param {number} [status] */
      const fail = (why, status) => {
        if (parked) return; // parked: the queue owns the end
        abort();
        slot.cancel();
        refuse(why, status);
      };
      if (closed) { refuse('proxy closing'); return; }
      if (!sock || sock.destroyed) { refuse('client gone'); return; }
      const slot = queue.reserve(agent, {
        onReady: () => stream(),
        onExpire: (why) => { abort(); refuse(why); },
      });
      if (slot.state === 'full') { ctx.freeWork(); refuse('hold queue full', 429); return; }
      ctx.endAsk = (why) => fail(why);
      cres.on('close', () => ctx.endAsk?.('client gone'));
      let size = 0;
      if (ctx.hasBody) {
        // The bytes already read go to the body file at once, so a request
        // waiting in line holds no body in memory.
        try {
          // Open synchronously: a later unlink can then never race the create.
          ws = fs.createWriteStream('', { fd: fs.openSync(heldFile(slot.id), 'wx', 0o600) });
        } catch (e) {
          fail(`cannot hold body: ${e instanceof Error ? e.message : String(e)}`, 500);
          ctx.freeWork();
          return;
        }
        ws.on('error', (e) => fail(`cannot hold body: ${e.message}`, 500));
        for (const c of ctx.chunks) {
          size += c.length;
          ws.write(c);
        }
        ctx.chunks = [];
        ctx.heldId = slot.id;
        if (size > holdMaxBody) fail('body too large to hold');
      }
      // The working slot is released: a queued hold must not stop the
      // agent's next body from being read.
      ctx.freeWork();
      if (slot.state === 'now') stream();

      // At the front of the line: take the rest of the body, then park.
      function stream() {
        if (settled || dead) return;
        const parkIt = () => {
          if (dead || settled) return;
          // Parked: the tunnel stays open until the ask channel decides.
          // null: the reservation already expired and onExpire refused.
          parked = queue.add({ agent, method: ctx.method, url: ctx.url,
            preview: bodyPreview(ctx.tee.head), bodyBytes: ctx.tee.bytes,
            sock, note: event.rule ?? 'ask', letter: event.rwxLetter, finish,
            slot, arrivedAt: slot.arrivedAt }) !== null;
        };
        const done = () => { if (ws) { ws.once('finish', parkIt); ws.end(); } else parkIt(); };
        if (!ctx.over) { done(); return; }
        creq.on('data', (c) => {
          if (dead) return;
          size += c.length;
          if (size > holdMaxBody) { fail('body too large to hold'); return; }
          if (ws && !ws.write(c)) {
            creq.pause();
            ws.once('drain', () => creq.resume());
          }
        });
        creq.on('error', () => { fail('client body failed', 502); });
        creq.on('end', () => { if (!dead) done(); });
        creq.resume();
      }
    });
  }

  /**
   * The one decision for a request: the gate's `check`, and, for a plain
   * check object that answers `askHuman`, the same human channel.
   *
   * @param {GateLike} g the agent's gate
   * @param {Record<string, unknown>} action the request as an action
   * @returns {Promise<{ outcome: string, rule?: string, reason?: string | null, aid?: string }>} terminal allow or deny
   */
  async function decideAction(g, action) {
    const d = await g.check(action);
    if (d.outcome !== 'askHuman') return d;
    const h = await askHuman({ action, rule: d.rule });
    return h.decision === 'allow'
      ? { outcome: 'allow', rule: 'humanChannel.allow', aid: d.aid }
      : { outcome: 'deny', rule: d.rule, reason: h.reason ?? 'denied', aid: d.aid };
  }

  async function handleRequest(creq, cres) {
    const sock = creq.socket;
    const agent = agentOf(sock);
    const secure = sock[SECURE] === true;
    const target = creq.url || '';
    let url;
    try {
      if (/^https?:\/\//i.test(target)) url = new URL(target);
      else {
        const host = creq.headers.host;
        if (!host) throw new Error('no host');
        url = new URL(`${secure ? 'https' : 'http'}://${host}${target}`);
      }
    } catch { denyRes(cres, 400, 'bad request target'); return; }
    const method = creq.method;
    if (!method) { denyRes(cres, 400, 'bad request method'); return; }
    const urlStr = url.toString();
    const verdict = await checkUpstream(url.hostname, gate, portOf(url));
    if (!verdict.ok) {
      try { creq.resume(); } catch {}
      denyRes(cres, 403, verdict.reason);
      return;
    }
    const cl = Number(creq.headers['content-length'] ?? 0);
    const hasBody = creq.headers['transfer-encoding'] !== undefined || cl > 0;

    // Pause before any body listener: a listener would put the stream in
    // flowing mode and starve whoever reads it next. The tee sees every body
    // byte once, whatever path reads it, and feeds the ask (a masked
    // 4 KB preview) and the audit's `body` fact (byte count and SHA-256).
    creq.pause();
    const tee = makeTee();
    creq.on('data', (c) => tee.push(c));
    // `end` fires once the whole body was read, whichever path read it (also
    // a streamed body past 64 KB), so the values cover all of it. A client
    // that aborts mid-body never reaches `end`: no line, as before.
    const rid = `r${++ridN}`;
    if (hasBody) {
      creq.on('end', () => log({ ev: 'body', agent, rid, bodyBytes: tee.bytes, bodySha256: tee.digest() }));
    }
    creq.on('error', () => {});

    // No gate: straight through. pipe() resumes the flow.
    if (!gateFor) {
      forward({ agent, method, url: urlStr, headers: { ...creq.headers }, stream: creq, cres });
      return;
    }

    // One decision path. A body is read first (one body at a time per agent,
    // up to 64 KB, so the card floor can scan it); then the agent's gate
    // decides; a gate that asks runs the human channel inside `check()`.
    let freed = false;
    /** @type {() => void} */
    let free = () => {};
    const freeWork = () => { if (!freed) { freed = true; free(); } };
    try {
      if (hasBody) {
        free = await takeWorkSlot(agent, cres);
      } else creq.resume();
      if (sock.destroyed) return;
      /** @type {RequestCtx} */
      const ctx = { agent, method, url: urlStr, headers: { ...creq.headers }, creq, cres, tee,
        hasBody, chunks: [], over: false, freeWork, asked: false, status: null, heldId: null,
        endAsk: null };
      let cardLike = false;
      if (hasBody) {
        const r = await readBounded(creq, WORK_BODY_LIMIT);
        if (r.aborted) return;
        ctx.chunks = r.chunks;
        ctx.over = r.over;
        // Past 64 KB the body streams on unscanned (known gap).
        if (!r.over) cardLike = createCardScanner().push(Buffer.concat(r.chunks));
      }
      // The body never goes in the action: bareguard writes the action to its audit file.
      const action = { type: 'net', tool: toolFor(matcher, tools, method, urlStr), url: urlStr, method, agent,
        cardLike, paymentPath: paymentPath(urlStr), rid };
      inflightCtx.set(rid, ctx);
      const g = await gateOf(agent);
      const d = await decideAction(g, action);
      if (d.outcome === 'allow') {
        const common = { agent, method, url: urlStr, headers: ctx.headers, cres,
          ...(d.aid ? { rec: { gate: g, action, aid: d.aid } } : {}) };
        if (ctx.heldId) {
          // The file is the exact body; the client's own framing (length or
          // chunked) still describes it. It is deleted once the upstream is done.
          const id = ctx.heldId;
          const rs = fs.createReadStream(heldFile(id));
          rs.on('close', () => holds?.dropBody(id));
          await forward({ ...common, stream: rs });
        } else if (!hasBody) {
          await forward({ ...common, body: EMPTY });
        } else if (ctx.over) {
          // Past 64 KB: send what was read, pipe the rest.
          await forward({ ...common, prefix: Buffer.concat(ctx.chunks), stream: creq });
        } else {
          await forward({ ...common, body: Buffer.concat(ctx.chunks) });
        }
      } else {
        discard(creq);
        const why = ctx.asked
          ? `denied: ${d.reason ?? 'denied'}`
          : `denied: ${d.rule ?? 'gate'}${d.reason ? `: ${d.reason}` : ''}`;
        denyRes(cres, ctx.status ?? 403, why);
      }
    } finally {
      inflightCtx.delete(rid);
      freeWork();
    }
  }

  /**
   * Constant-memory tee of a request body: the first ASK_BODY_LIMIT bytes,
   * the byte count and a running SHA-256.
   */
  function makeTee() {
    const hash = crypto.createHash('sha256');
    let head = EMPTY;
    let bytes = 0;
    return {
      push(/** @type {Buffer} */ c) {
        hash.update(c);
        bytes += c.length;
        if (head.length < ASK_BODY_LIMIT) head = Buffer.concat([head, c.subarray(0, ASK_BODY_LIMIT - head.length)]);
      },
      get head() { return head; },
      get bytes() { return bytes; },
      digest: () => hash.copy().digest('hex'),
    };
  }

  // One working slot per agent: a FIFO of body reads. A slot frees when its
  // holder calls the returned function, or when its response closes (a dead
  // client never wedges the line). Waiters stay paused and unread.
  /** @type {Map<string, Promise<void>>} */
  const workTail = new Map();
  /**
   * @param {string} agent agent name
   * @param {import('node:http').ServerResponse} cres the request's response
   * @returns {Promise<() => void>} resolves with `free` once the slot is ours
   */
  function takeWorkSlot(agent, cres) {
    const prev = workTail.get(agent) ?? Promise.resolve();
    /** @type {() => void} */
    let free = () => {};
    const mine = new Promise((resolve) => { free = () => resolve(undefined); });
    const tail = prev.then(() => mine);
    workTail.set(agent, tail);
    void tail.then(() => { if (workTail.get(agent) === tail) workTail.delete(agent); });
    cres.once('close', free);
    return prev.then(() => free);
  }

  /**
   * Read a paused request's body until it ends or passes `limit` bytes
   * (then pause again, keeping everything read so far in `chunks`).
   *
   * @param {import('node:http').IncomingMessage} creq paused request
   * @param {number} limit byte limit
   * @returns {Promise<{ chunks: Buffer[], over: boolean, aborted: boolean }>}
   */
  function readBounded(creq, limit) {
    return new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      /** @param {boolean} over @param {boolean} aborted */
      const done = (over, aborted) => {
        creq.off('data', onData);
        creq.off('end', onEnd);
        creq.off('close', onGone);
        creq.off('error', onGone);
        resolve({ chunks, over, aborted });
      };
      const onData = (/** @type {Buffer} */ c) => {
        chunks.push(c);
        size += c.length;
        if (size > limit) { creq.pause(); done(true, false); }
      };
      const onEnd = () => done(false, false);
      const onGone = () => done(false, true);
      creq.on('data', onData);
      creq.on('end', onEnd);
      creq.on('close', onGone);
      creq.on('error', onGone);
      creq.resume();
    });
  }
  // Idle tunnels die here; a request in flight is never idle by definition.
  server.keepAliveTimeout = clientIdleMs;
  server.on('clientError', (err, sock) => {
    try { sock.destroy(); } catch {}
  });

  // Dispatch: one CONNECT line, or plain HTTP straight into the same server.
  function admit(sock, agent) {
    sock[AGENT] = agent;
    clients.add(sock);
    sock.setTimeout(clientIdleMs, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('close', () => {
      clients.delete(sock);
      holds?.abandonSocket(sock);
    });
    let buf = Buffer.alloc(0);
    const onData = (ch) => {
      buf = Buffer.concat([buf, ch]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (buf.length > 65536) {
          sock.removeListener('data', onData);
          denyRaw(sock, 400, 'head too large');
        }
        return;
      }
      const line = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const [method, target] = line.split(' ');
      sock.removeListener('data', onData);
      sock.setTimeout(0); // the http.Server owns idle from here
      if (method === 'CONNECT') {
        handleConnect(sock, target, buf.subarray(i + 4), agent);
      } else {
        // Plain HTTP (absolute- or origin-form): same parser, same handler.
        // Push the bytes back so the http.Server sees the whole stream.
        sock.unshift(buf);
        server.emit('connection', sock);
      }
      buf = Buffer.alloc(0);
    };
    sock.on('data', onData);
  }

  async function handleConnect(sock, target, rest, agent) {
    const [host, portStr] = String(target || '').split(':');
    const portNum = portStr ? parseInt(portStr, 10) : 443;
    if (!HOST_RE.test(host || '') || !Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      denyRaw(sock, 400, 'bad connect line');
      return;
    }
    // Deny the tunnel itself: no cert is minted for a walled destination,
    // and the inner request is checked again on arrival anyway.
    const verdict = await checkUpstream(host, gate, portNum);
    if (!verdict.ok) {
      denyRaw(sock, 403, verdict.reason);
      return;
    }
    let creds;
    try {
      creds = await certFor(certDir, host);
    } catch (e) {
      denyRaw(sock, 502, `no cert for ${host}: ${e.message}`);
      return;
    }
    if (closed || sock.destroyed) return;
    try { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); }
    catch { return; }
    if (rest.length) sock.unshift(rest);
    const st = new tls.TLSSocket(sock, { isServer: true, key: creds.key, cert: creds.cert });
    st[AGENT] = agent;
    st[SECURE] = true;
    clients.add(st);
    st.on('error', () => {});
    st.on('close', () => {
      clients.delete(st);
      holds?.abandonSocket(st);
    });
    server.emit('connection', st);
  }

  // --- listeners -----------------------------------------------------------
  const ready = (async () => {
    await ensureCA(certDir);
    /** @type {number|null} */
    let bound = null;
    if (port !== null && port !== undefined) {
      /** @type {Promise<number|null>} */
      const boundP = new Promise((resolve, reject) => {
        tcp = net.createServer((sock) => {
          if (closed) { sock.destroy(); return; }
          admit(sock, 'tcp');
        });
        tcp.on('error', reject);
        tcp.listen(port, '127.0.0.1', () => {
          const a = tcp?.address();
          resolve(typeof a === 'object' && a !== null ? a.port : 0);
        });
      });
      bound = await boundP;
      if (gateFor) void gateOf('tcp').catch(() => {});
    }
    return { port: bound };
  })();
  // A rejected `ready` must never become an uncaught process crash, and it
  // releases the claim before the rejection reaches the caller (attached
  // first, so this runs before any caller reaction).
  ready.catch(() => { releaseClaim(); });

  function addAgent(name) {
    const sockPath = runtimePaths(runtime).socket(name);
    if (agentServers.has(name)) return sockPath;
    try { fs.unlinkSync(sockPath); } catch {}
    ensurePrivateDir(path.dirname(sockPath));
    const srv = net.createServer((sock) => {
      if (closed) { sock.destroy(); return; }
      admit(sock, name);
    });
    srv.on('error', (e) => log({ ev: 'deny', agent: name, code: 500, note: `agent listener failed: ${e.message}` }));
    srv.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch {}
    });
    agentServers.set(name, srv);
    if (gateFor) void gateOf(name).catch(() => {});
    return sockPath;
  }

  // Ends the agent's door AND its open connections: its parked holds end
  // synchronously as deny / client gone (no waiting on the socket's async
  // 'close'), then each socket is destroyed.
  function removeAgent(name) {
    const srv = agentServers.get(name);
    if (!srv) return;
    agentServers.delete(name);
    gates.delete(name);
    srv.close();
    for (const s of [...clients]) {
      if (s[AGENT] !== name) continue;
      holds?.abandonSocket(s);
      s.destroy();
    }
    // Asks still waiting in line (not parked) end now, as client gone, too.
    for (const c of inflightCtx.values()) if (c.agent === name) c.endAsk?.('client gone');
    try { fs.unlinkSync(runtimePaths(runtime).socket(name)); } catch {}
  }

  async function close() {
    closed = true;
    tcp?.close();
    for (const [, srv] of agentServers) srv.close();
    agentServers.clear();
    // Parked holds settle as denied (guarded writes), timers cleared,
    // ask files removed, sweeper stopped — all inside holds.close().
    holds?.close();
    // Requests inside a gate check now end on their own (holds.close() refused
    // their asks, parked or waiting): wait for their 403 and last log lines BEFORE the
    // sockets go, but never forever (a wedged gate must not wedge close).
    const checking = [...inflightCtx.values()].map((c) => reqDone.get(c.creq)).filter(Boolean);
    if (checking.length) {
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let cap;
      await Promise.race([
        Promise.allSettled(checking),
        new Promise((resolve) => { cap = setTimeout(resolve, 3000); }),
      ]);
      clearTimeout(cap);
    }
    for (const up of upstreams) { try { up.destroy(); } catch {} }
    upstreams.clear();
    for (const s of clients) { try { s.destroy(); } catch {} }
    clients.clear();
    server.close();
    // Lines logged from here on are dropped; the ones in flight are awaited,
    // but never forever (a wedged disk must not wedge close).
    logClosing = true;
    if (pendingLog.size) {
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let cap;
      await Promise.race([
        Promise.allSettled([...pendingLog]),
        new Promise((resolve) => { cap = setTimeout(resolve, 3000); }),
      ]);
      clearTimeout(cap);
    }
    releaseClaim();
  }

  return {
    ready,
    close,
    addAgent,
    removeAgent,
    pending: () => (holds ? holds.pending() : []),
    get caFile() { return path.join(certDir, 'ca.pem'); },
  };
}
