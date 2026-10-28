// Proxy: the front door. Terminates agent TLS with per-host certificates
// minted on demand, sees every request through a private stdlib http.Server
// (so HEAD, 204/304, chunked, keep-alive and slow upstreams just work),
// forwards with https/http.request, and optionally parks matching requests
// for a human decision. Identity = socket: each agent has its own unix
// listener, and every log line and hold names the agent, never `c<n>`.
//
// Timeout shape: the client idle clock is the server's keep-alive timeout —
// by construction it only ticks when no request is in flight. The upstream
// response gets its own much longer clock.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { ensureCA, certFor, HOST_RE } from './certs.js';
import { createHolds } from './holds.js';
import { claimRuntime, ensurePrivateDir, runtimePaths } from './runtime.js';
import { checkUpstream } from './wall.js';

const AGENT = Symbol('agent');
const SECURE = Symbol('secure');
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
// Hop-by-hop headers must not be forwarded: node's HTTP stack re-frames.
const HOP_REQ = new Set(['proxy-connection', 'proxy-authorization']);
const HOP_RESP = new Set(['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// Secrets never land in the audit log verbatim: Authorization-style header
// values are replaced with a fixed marker before an entry is written. The
// user's `redact` hook runs after this scrubbing, so it sees (and further
// shapes) an already-safe entry. Bodies stay logged as-is.
const REDACTED = '[redacted]';
// Interim set (M3 replaces this with bareguard's `secrets` redaction): header names whose values never land verbatim.
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization',
  'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'api-key']);

/**
 * Copy a log entry with sensitive header values replaced by `[redacted]`.
 * The caller's headers object is never mutated.
 *
 * @param {Record<string, unknown>} entry log entry about to be written
 * @returns {Record<string, unknown>} entry with secrets scrubbed
 */
function scrubSecrets(entry) {
  const h = entry['headers'];
  if (!h || typeof h !== 'object') return entry;
  const src = /** @type {Record<string, unknown>} */ (h);
  if (!Object.keys(src).some((k) => SENSITIVE_HEADERS.has(k.toLowerCase()))) return entry;
  const headers = { ...src };
  for (const k of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) headers[k] = REDACTED;
  }
  return { ...entry, headers };
}

/**
 * Options for {@link createProxy}.
 *
 * @typedef {object} ProxyOptions
 * @property {string} logFile JSON-lines log path (`req`, `resp`, `deny`, `hold`, `decide`, `hold-abandoned`)
 * @property {string} runtime runtime dir; required. Holds the CA + minted host certs (`certs/`, see `runtime.js`), the agent sockets, and the hold queue files.
 * @property {number} [port] opt-in TCP listener for tests, bound to 127.0.0.1 only (default: none)
 * @property {string} [upstreamCa] extra PEM the proxy trusts for upstream TLS, on top of system roots
 * @property {HoldOptions} [hold] hold queue config, or omit to forward everything
 * @property {number} [upstreamTimeoutMs] give up on an upstream response after this (default 120000)
 * @property {object} [unsafeTestOnly] TEST-ONLY escape hatch: everything under
 *   it weakens the sandbox wall, so production omits it and tests name it loudly.
 * @property {boolean} [unsafeTestOnly.allowLoopback] let loopback and unspecified
 *   destinations through (default false). Fixture servers listen on 127.0.0.1,
 *   so tests pass this; production never should.
 * @property {(host: string) => Promise<string[] | string | null>} [unsafeTestOnly.resolveUpstream]
 *   DNS stub: replaces the wall's resolver so rebinding is testable. Production omits it.
 * @property {number} [clientIdleMs] kill a client tunnel idle this long; never fires mid-request (default 60000)
 * @property {number} [maxLogBody] log at most this many request-body bytes, then `truncated: true` (default 1048576)
 * @property {(entry: Record<string, unknown>) => Record<string, unknown>} [redact] log redaction hook, applied after built-in secret scrubbing (default: identity)
 */

/**
 * Hold queue options (the decision seam lives in holds.js).
 *
 * @typedef {object} HoldOptions
 * @property {string} [match] path substring that parks a request (default decision)
 * @property {import('./holds.js').ShouldHold} [shouldHold] decision function; overrides `match`
 * @property {number|string} [timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @property {number} [maxBody] bodies over this are denied at the door, never queued (default 1048576)
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
 * @property {Buffer} [body] buffered body (approve path)
 * @property {import('node:http').IncomingMessage} [stream] live body (direct path)
 * @property {import('node:http').ServerResponse} cres parked or live client response
 */

/**
 * Live proxy. Let `tsc` infer the shape; adopters import the name.
 *
 * @typedef {ReturnType<typeof createProxy>} Proxy
 */

/**
 * Start the front-door proxy. Every request is logged with its method, URL,
 * headers and body; bytes go upstream untouched. Requests the hold rule
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
    upstreamCa = null, hold = null,
    upstreamTimeoutMs = 120000, clientIdleMs = 60000,
    unsafeTestOnly = null,
    maxLogBody = 1048576, redact = (e) => e } = opts ?? {};
  const { allowLoopback = false, resolveUpstream = null } = unsafeTestOnly ?? {};
  const gate = { allowLoopback, resolveUpstream: resolveUpstream ?? undefined };
  if (!logFile) throw new Error('createProxy: logFile is required');
  if (typeof runtime !== 'string' || !runtime) throw new Error('createProxy: runtime is required');
  // One live proxy per runtime, enforced here: claimed before the hold
  // queue clears `asks/` and `answers/`, so that clearing can never wipe a
  // live owner's files — only a dead owner's leftovers can be there.
  const releaseClaim = claimRuntime(runtime);
  // Always `<runtime>/certs`: one layout, owned by runtime.js, so there is
  // nothing to contain and no check to fail.
  const certDir = runtimePaths(runtime).certsDir;
  const holdMaxBody = hold?.maxBody ?? 1048576;

  // Open the audit log synchronously: a bad `logFile` (a directory, a
  // missing parent, no permission) throws here, where the claim can still
  // be released — not later as an uncaught stream error.
  let logFd;
  try {
    logFd = fs.openSync(logFile, 'a', 0o600);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    releaseClaim();
    throw new Error(`createProxy: cannot open logFile ${logFile}: ${msg}`);
  }
  const logStream = fs.createWriteStream(logFile, { fd: logFd });
  // `openSync`'s mode is masked by the umask and doesn't apply to an
  // existing file: a 0644 log from an older run would stay world-readable
  // while new lines append, so fix it up on every start.
  try { fs.chmodSync(logFile, 0o600); } catch {}
  let logFailed = false;
  logStream.on('error', (e) => {
    if (logFailed) return;
    logFailed = true;
    console.error(`sbx: audit log ${logFile} write failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  // After close() ends the stream a late line (a socket torn down by close)
  // is dropped on purpose: a write after end() would destroy the stream.
  const log = (o) => {
    if (logStream.writableEnded) return;
    logStream.write(JSON.stringify(redact(scrubSecrets(o))) + '\n');
  };
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
  /** @param {ForwardArgs} args */
  async function forward({ agent, method, url, headers, body, stream, cres }) {
    let u;
    try {
      u = new URL(url);
    } catch {
      denyRes(cres, 400, 'bad request target');
      return;
    }
    const verdict = await checkUpstream(u.hostname, gate);
    if (!verdict.ok) {
      try { stream?.resume(); } catch {}
      denyRes(cres, 403, verdict.reason);
      return;
    }
    // Sync from here: forwardInner answers every failure itself, but a
    // throw before it can answer must still be loud, never a floating reject.
    // The dial is pinned to the checked IPs: no second DNS resolution.
    try {
      forwardInner({ agent, method, url, headers, body, stream, cres, u, upstreamIps: verdict.ips });
    } catch (e) {
      // The live stream arrives paused (see handleRequest): unpause so no
      // paused stream leaks on this path.
      try { stream?.resume(); } catch {}
      denyRes(cres, 502, `upstream failed: ${e.message}`);
    }
  }

  /** @param {ForwardArgs & { u: URL, upstreamIps: string[] }} args */
  function forwardInner({ agent, method, url, headers, body, stream, cres, u, upstreamIps }) {
    const sock = cres.socket;
    if (!sock) return; // no transport left to answer on
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
      log({ ev: 'resp', agent, url, status: ures.statusCode });
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
    else if (stream) stream.pipe(up);
    else up.end();
  }

  // The rest of setup is infallible synchronously except this call, so a
  // throw here releases the claim before it propagates (like upstreamCa
  // above); async failures release through `ready` and `close()` below.
  let holds = null;
  try {
    holds = hold ? createHolds({
      log,
      shouldHold: hold.shouldHold,
      match: hold.match,
      timeoutMs: hold.timeoutMs,
      maxBody: holdMaxBody,
      runtime,
      onAsk: hold.onAsk,
      pollMs: hold.pollMs,
      onEvent: hold.onEvent,
      onApprove: (h) => forward({ agent: h.agent, method: h.method, url: h.url,
        headers: h.headers, body: h.body, cres: h.cres }),
      onDeny: (h, reason) => denyRes(h.cres, 403, `denied: ${reason}`),
    }) : null;
  } catch (e) {
    releaseClaim();
    throw e;
  }

  const server = http.createServer((creq, cres) => {
    // Async only for the wall's DNS lookup; no body listener is attached
    // before the check, so nothing is lost while it resolves.
    handleRequest(creq, cres).catch((e) => denyRes(cres, 500, `proxy failed: ${e.message}`));
  });

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
    const verdict = await checkUpstream(url.hostname, gate);
    if (!verdict.ok) {
      try { creq.resume(); } catch {}
      denyRes(cres, 403, verdict.reason);
      return;
    }
    const queue = holds;
    const reason = queue ? queue.decide({ agent, method, url: urlStr, headers: creq.headers }) : null;

    // Tee the body for the log (capped). A held request buffers it whole —
    // bounded by maxBody — so approve can forward it after the human decides.
    // Anything else streams straight through; the tee only feeds the log.
    const chunks = [];
    let size = 0;
    let over = false;
    const finishLog = () => {
      const body = Buffer.concat(chunks);
      log({ ev: 'req', agent, method: creq.method, url: urlStr,
        headers: creq.headers, body: body.toString('utf8'),
        ...(over ? { truncated: true, bodyBytes: size } : {}) });
      return body;
    };
    if (!reason || !queue) {
      // Pause before any body listener: the tee below would otherwise put
      // the stream in flowing mode, and forward() awaits a second wall
      // check before forwardInner pipes to upstream — body bytes arriving
      // during that wait would go to the tee only, starving upstream
      // against Content-Length. Buffered here, pipe() resumes the flow,
      // so both the tee and upstream see the whole body.
      creq.pause();
      creq.on('data', (c) => {
        size += c.length;
        if (size > maxLogBody || over) { over = true; return; }
        chunks.push(c);
      });
      creq.on('end', finishLog);
      creq.on('error', () => {});
      forward({ agent, method, url: urlStr,
        headers: { ...creq.headers }, stream: creq, cres });
      return;
    }
    // One held request per agent reads its body at a time; the rest wait
    // unread in line. No body listener (it would resume the stream) until
    // `onReady`. A request that never parks frees its slot when `cres` closes.
    creq.pause();
    const readHeld = () => {
      creq.on('data', (c) => {
        size += c.length;
        if (size > holdMaxBody) { over = true; return; }
        chunks.push(c);
      });
      creq.on('error', () => { denyRes(cres, 502, 'client body failed'); });
      creq.on('end', () => {
        if (over) { denyRes(cres, 403, 'body too large to hold'); return; }
        const body = finishLog();
        // Parked: the tunnel stays open until the ask channel decides. The
        // hold reason travels as `note` so the ask file carries its `rule`.
        queue.add({ agent, method, url: urlStr,
          headers: { ...creq.headers }, body, sock, cres, note: reason,
          slot, arrivedAt: slot.arrivedAt });
      });
      creq.resume();
    };
    const slot = queue.reserve(agent, {
      onReady: readHeld,
      onExpire: (why) => { denyRes(cres, 403, `denied: ${why}`); creq.resume(); },
    });
    if (slot.state === 'full') {
      denyRes(cres, 429, 'hold queue full');
      creq.resume();
      return;
    }
    cres.on('close', () => slot.cancel());
    if (slot.state === 'now') readHeld();
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
    const verdict = await checkUpstream(host, gate);
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
    return sockPath;
  }

  function removeAgent(name) {
    const srv = agentServers.get(name);
    if (!srv) return;
    agentServers.delete(name);
    srv.close();
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
    for (const up of upstreams) { try { up.destroy(); } catch {} }
    upstreams.clear();
    for (const s of clients) { try { s.destroy(); } catch {} }
    clients.clear();
    server.close();
    logStream.end();
    /** @type {Promise<void>} */
    const flushed = new Promise((resolve) => {
      if (logStream.writableFinished || logStream.destroyed) resolve();
      else {
        // A destroyed stream emits 'close', never 'finish'.
        logStream.once('finish', () => resolve());
        logStream.once('close', () => resolve());
      }
    });
    await flushed;
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
