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
import os from 'node:os';
import path from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { ensureCA, certFor } from './certs.js';
import { createHolds } from './holds.js';

const AGENT = Symbol('agent');
const SECURE = Symbol('secure');
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Linux sun_path: 108 bytes including the NUL.
const MAX_SOCK_PATH = 107;
// Hop-by-hop headers must not be forwarded: node's HTTP stack re-frames.
const HOP_REQ = new Set(['proxy-connection', 'proxy-authorization']);
const HOP_RESP = new Set(['connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// --- upstream wall ---------------------------------------------------------
 // Default-deny for loopback, link-local (incl. cloud metadata 169.254/16),
 // the host's own addresses, and private LAN ranges (RFC 1918, CGNAT
 // 100.64/10, IPv6 ULA fc00::/7). The check runs AFTER DNS resolution, so a
 // hostname that resolves to 127.0.0.1 is denied exactly like the literal.
 // Unresolvable names are denied too (fail closed, never 502-then-dial).
// Only `allowLoopback` (loopback + unspecified) or `allowUpstream(host, ip)`
// lets a denied destination through; only tests pass those. There is no
// allowPrivate flag: a private destination passes only via `allowUpstream`.

/** Strip brackets/scope, lowercase: one spelling per address. */
function normIp(ip) {
  let s = String(ip || '').toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  return s;
}

/** Embedded IPv4 in `::ffff:1.2.3.4`, or null. */
function mappedV4(ip) {
  const m = ip.match(/^(?:.*:)?(\d+\.\d+\.\d+\.\d+)$/);
  return m && net.isIP(m[1]) === 4 ? m[1] : null;
}

function v4Parts(ip) {
  return ip.split('.').map((p) => parseInt(p, 10));
}

/** This machine's own interface addresses, one spelling (see `normIp`). */
function localIps() {
  const out = new Set();
  let ifs = {};
  // networkInterfaces() can throw where interfaces are hidden (a sandbox is
  // exactly where the wall matters most): lose host-local, keep the rest.
  try {
    ifs = os.networkInterfaces();
  } catch {
    return out;
  }
  for (const addrs of Object.values(ifs)) {
    for (const a of addrs ?? []) {
      if (a && a.address) out.add(normIp(a.address));
    }
  }
  return out;
}

/**
 * Why `ip` (already resolved) is denied, or null when it may go through.
 *
 * @param {string} rawIp resolved destination IP
 * @param {boolean} allowLoopback test-only opt-in for loopback + unspecified
 * @returns {string|null} `loopback` / `unspecified` / `link-local` / `host-local` / `private`, or null
 */
export function denyReasonForIp(rawIp, allowLoopback) {
  const ip = normIp(rawIp);
  const v4 = mappedV4(ip) ?? (net.isIP(ip) === 4 ? ip : null);
  if (v4) {
    const [a, b] = v4Parts(v4);
    if (a === 127) return allowLoopback ? null : 'loopback';
    if (a === 0) return allowLoopback ? null : 'unspecified';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    if (localIps().has(v4)) return 'host-local';
    return null;
  }
  if (net.isIP(ip) === 6) {
    if (ip === '::1') return allowLoopback ? null : 'loopback';
    if (ip === '::') return allowLoopback ? null : 'unspecified';
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if (first >= 0xfe80 && first <= 0xfebf) return 'link-local';
    if (first >= 0xfc00 && first <= 0xfdff) return 'private';
    if (localIps().has(ip)) return 'host-local';
    return null;
  }
  return null;
}

/**
 * Resolve `host` to every IP for the wall. Literals need no DNS.
 * Fail closed: anything that does not resolve is denied, never dialed.
 *
 * @param {string} host CONNECT/request hostname
 * @param {(host: string) => Promise<string[] | string | null>} [stub] test-only DNS stub
 * @returns {Promise<string[] | null>} all resolved IPs, or null when unresolvable
 */
async function resolveAllUpstream(host, stub) {
  if (net.isIP(host)) return [host];
  try {
    if (typeof stub === 'function') {
      const r = await stub(host);
      if (!r) return null;
      if (Array.isArray(r)) return r.length ? [...r] : null;
      if (typeof r === 'string') return [r];
      return null;
    }
    const all = await dnsLookup(host, { all: true });
    if (!all || !all.length) return null;
    return all.map((a) => a.address);
  } catch {
    return null;
  }
}

/**
 * The wall: resolve every answer, then default-deny loopback/link-local/
 * host-local/private unless the test-only opt-ins allow it. Denies when ANY
 * answer is walled, denies unresolvable names, and pins the first checked IP
 * so the dial below cannot resolve the name a second time (no rebinding).
 *
 * @param {string} host CONNECT/request hostname
 * @param {{ allowLoopback: boolean, allowUpstream: ((host: string, ip: string) => boolean) | null, resolveUpstream?: (host: string) => Promise<string[] | string | null> }} gate
 * @returns {Promise<{ ok: true, ip: string } | { ok: false, ip: string, reason: string }>}
 */
async function checkUpstream(host, gate) {
  const ips = await resolveAllUpstream(host, gate.resolveUpstream);
  if (!ips || !ips.length) {
    return { ok: false, ip: host, reason: `unresolvable upstream denied: ${host}` };
  }
  for (const ip of ips) {
    if (typeof gate.allowUpstream === 'function') {
      let pass = false;
      try { pass = gate.allowUpstream(host, ip) === true; } catch { pass = false; }
      if (pass) continue;
    }
    const kind = denyReasonForIp(ip, gate.allowLoopback);
    if (kind) {
      const where = ip === host ? host : `${host} (${ip})`;
      return { ok: false, ip, reason: `${kind} upstream denied: ${where}` };
    }
  }
  return { ok: true, ip: ips[0] };
}

/**
 * Check an agent name before it reaches the filesystem.
 *
 * @param {string} name agent name
 * @returns {void} throws on `../` and friends
 */
export function assertAgentName(name) {
  if (!AGENT_RE.test(name || '')) {
    throw new Error(`bad agent name ${JSON.stringify(name)}: must match ${AGENT_RE}`);
  }
}

/**
 * Resolve symlinks through the nearest existing ancestor: socket paths may
 * not exist yet, so `realpathSync` on the full path would throw. Walks up
 * to the first existing ancestor, resolves that, then re-attaches the rest.
 *
 * @param {string} p any path, existing or not
 * @returns {string} the real (symlink-free) spelling of `p`
 */
export function realPathOf(p) {
  const abs = path.resolve(p);
  let cur = abs;
  /** @type {string[]} */
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const real = fs.realpathSync(cur);
  return rest.length ? path.join(real, ...rest) : real;
}

/**
 * The one path both sides agree on: the proxy listens here, the launcher
 * binds it into the sandbox. This function is the single writer of the shape.
 *
 * @param {string} runtime runtime dir
 * @param {string} name agent name
 * @returns {string} `<runtime>/socks/<name>.sock`
 */
export function socketPathForAgent(runtime, name) {
  assertAgentName(name);
  const p = path.join(runtime, 'socks', `${name}.sock`);
  if (p.length > MAX_SOCK_PATH) {
    throw new Error(`agent socket path too long (${p.length} > ${MAX_SOCK_PATH}): ${p}`);
  }
  return p;
}

/**
 * Options for {@link createProxy}.
 *
 * @typedef {object} ProxyOptions
 * @property {string} logFile JSON-lines log path (`req`, `resp`, `deny`, `hold`, `decide`, `hold-abandoned`)
 * @property {string} [certDir] dir for the CA + minted host certs (default `<runtime>/certs`)
 * @property {string} [runtime] runtime dir; required for `addAgent`, default parent of `certDir`
 * @property {number} [port] opt-in TCP listener for tests, bound to 127.0.0.1 only (default: none)
 * @property {string} [upstreamCa] extra PEM the proxy trusts for upstream TLS, on top of system roots
 * @property {HoldOptions} [hold] hold queue config, or omit to forward everything
 * @property {string|null} [controlSocket] unix socket path for `pending | approve | deny`.
 *   Must live inside `runtime` (compared via {@link realPathOf}, so symlinks
 *   cannot smuggle it out): anything else throws before any side effect.
 *   No default — omit it when no CLI decisions are needed.
 * @property {number} [upstreamTimeoutMs] give up on an upstream response after this (default 120000)
 * @property {boolean} [allowLoopback] TEST-ONLY opt-in: let loopback and unspecified
 *   destinations through (default false). Fixture servers listen on 127.0.0.1,
 *   so tests pass this; production never should.
 * @property {(host: string, ip: string) => boolean} [allowUpstream] escape hatch,
 *   consulted after DNS with each resolved IP: return true to let through a
 *   destination the default wall would deny. Only tests use this.
 * @property {(host: string) => Promise<string[] | string | null>} [resolveUpstream] TEST-ONLY
 *   DNS stub: replaces the wall's resolver so rebinding is testable. Production omits it.
 * @property {number} [clientIdleMs] kill a client tunnel idle this long; never fires mid-request (default 60000)
 * @property {number} [maxLogBody] log at most this many request-body bytes, then `truncated: true` (default 1048576)
 * @property {(entry: Record<string, unknown>) => Record<string, unknown>} [redact] log redaction hook (default: identity)
 */

/**
 * Hold queue options (the decision seam lives in holds.js).
 *
 * @typedef {object} HoldOptions
 * @property {string} [match] path substring that parks a request (default decision)
 * @property {import('./holds.js').ShouldHold} [shouldHold] decision function; overrides `match`
 * @property {number|string} [timeoutMs] hold deadline in ms, or `'never'` (default 120000)
 * @property {number} [maxBody] bodies over this are denied at the door, never queued (default 1048576)
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
 * @fails Throws synchronously on a missing `logFile` (or neither `certDir` nor `runtime`). At runtime, dead upstreams, malformed input, over-cap and timed-out holds all become loud logged HTTP errors, never silence and never a crash. A second proxy on the same port rejects `ready`, never crashes the process.
 * @example
 * import { createProxy } from "barebox";
 * const proxy = createProxy({ port: 0, certDir: "./certs", logFile: "./mitm.log" });
 * const { port } = await proxy.ready;
 * await proxy.close();
 */
export function createProxy(opts) {
  const { logFile, certDir: certDirOpt, runtime: runtimeOpt, port = null,
    upstreamCa = null, hold = null, controlSocket = null,
    upstreamTimeoutMs = 120000, clientIdleMs = 60000,
    allowLoopback = false, allowUpstream = null, resolveUpstream = null,
    maxLogBody = 1048576, redact = (e) => e } = opts ?? {};
  const gate = { allowLoopback, allowUpstream, resolveUpstream: resolveUpstream ?? undefined };
  if (!logFile) throw new Error('createProxy: logFile is required');
  const runtime = runtimeOpt ?? (certDirOpt ? path.dirname(path.resolve(certDirOpt)) : null);
  const dirOpt = certDirOpt ?? (runtime ? path.join(runtime, 'certs') : null);
  if (!dirOpt) throw new Error('createProxy: certDir or runtime is required');
  // The control socket is the approve-payments capability: it must live
  // inside the runtime dir (the launcher masks exactly that dir), compared
  // on real paths so a symlink cannot smuggle it out. Fail closed here,
  // before the log stream, CA read, or any listener exists.
  if (controlSocket) {
    if (!runtime) {
      throw new Error(`createProxy: controlSocket must live inside the runtime, got ${controlSocket} with no runtime`);
    }
    const realRt = realPathOf(runtime);
    const realCtl = realPathOf(controlSocket);
    if (!realCtl.startsWith(realRt + path.sep)) {
      throw new Error(`createProxy: controlSocket must live inside the runtime: ${realCtl} not under ${realRt}`);
    }
  }
  const certDir = dirOpt;
  const holdMaxBody = hold?.maxBody ?? 1048576;

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (o) => { logStream.write(JSON.stringify(redact(o)) + '\n'); };
  let trust = null;
  if (upstreamCa) {
    let extra;
    try { extra = fs.readFileSync(upstreamCa, 'utf8'); }
    catch (e) { throw new Error(`createProxy: cannot read upstreamCa: ${e.message}`); }
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
    // The dial is pinned to the checked IP: no second DNS resolution.
    try {
      forwardInner({ agent, method, url, headers, body, stream, cres, u, upstreamIp: verdict.ip });
    } catch (e) {
      // The live stream arrives paused (see handleRequest): unpause so no
      // paused stream leaks on this path.
      try { stream?.resume(); } catch {}
      log({ ev: 'deny', agent, code: 502, note: `upstream failed: ${e.message}` });
      denyRes(cres, 502, `upstream failed: ${e.message}`);
    }
  }

  /** @param {ForwardArgs & { u: URL, upstreamIp?: string }} args */
  function forwardInner({ agent, method, url, headers, body, stream, cres, u, upstreamIp }) {
    const sock = cres.socket;
    if (!sock) return; // no transport left to answer on
    const secure = u.protocol === 'https:';
    /** @type {Record<string, string | string[] | undefined>} */
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_REQ.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    const pinned = upstreamIp && net.isIP(upstreamIp) ? upstreamIp : null;
    const mod = secure ? https : http;
    const up = mod.request({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (secure ? 443 : 80),
      // Pinned dial: answer from the checked IP, never DNS again. Node asks
      // with `{ all: true }`, which wants an array back (not the triple).
      ...(pinned ? { lookup: (h, o, cb) => {
        const fn = typeof o === 'function' ? o : cb;
        const opts = typeof o === 'function' ? {} : (o ?? {});
        const fam = net.isIP(pinned);
        try {
          if (opts && opts.all) fn(null, [{ address: pinned, family: fam }]);
          else fn(null, pinned, fam);
        } catch (e) { try { /** @type {(err: unknown) => void} */ (fn)(e); } catch {} }
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
      log({ ev: 'deny', agent, code: 502, note });
      try {
        if (!cres.headersSent && !sock.destroyed) {
          cres.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
        }
        if (!sock.destroyed) cres.end(`${note}\n`);
      } catch {}
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

  const holds = hold ? createHolds({
    log,
    shouldHold: hold.shouldHold,
    match: hold.match,
    timeoutMs: hold.timeoutMs,
    maxBody: holdMaxBody,
    controlSocket,
    onApprove: (h) => forward({ agent: h.agent, method: h.method, url: h.url,
      headers: h.headers, body: h.body, cres: h.cres }),
    onDeny: (h, reason) => denyRes(h.cres, 403, `denied: ${reason}`),
  }) : null;

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
    creq.on('data', (c) => {
      size += c.length;
      if (size > holdMaxBody) { over = true; return; }
      chunks.push(c);
    });
    creq.on('error', () => denyRes(cres, 502, 'client body failed'));
    creq.on('end', () => {
      if (over) { denyRes(cres, 403, 'body too large to hold'); return; }
      const body = finishLog();
      // Parked: the tunnel stays open until a human decides.
      queue.add({ agent, method, url: urlStr,
        headers: { ...creq.headers }, body, sock, cres });
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
  // A rejected `ready` must never become an uncaught process crash.
  ready.catch(() => {});

  function addAgent(name) {
    if (!runtime) throw new Error('createProxy: addAgent needs the runtime option');
    const sockPath = socketPathForAgent(runtime, name);
    if (agentServers.has(name)) return sockPath;
    try { fs.unlinkSync(sockPath); } catch {}
    fs.mkdirSync(path.join(runtime, 'socks'), { recursive: true });
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
    if (runtime) {
      try { fs.unlinkSync(socketPathForAgent(runtime, name)); } catch {}
    }
  }

  async function close() {
    closed = true;
    tcp?.close();
    for (const [, srv] of agentServers) srv.close();
    agentServers.clear();
    // Parked holds settle as denied (guarded writes), timers cleared,
    // control socket closed — all inside holds.close().
    holds?.close();
    for (const up of upstreams) { try { up.destroy(); } catch {} }
    upstreams.clear();
    for (const s of clients) { try { s.destroy(); } catch {} }
    clients.clear();
    server.close();
    logStream.end();
    /** @type {Promise<void>} */
    const flushed = new Promise((resolve) => {
      if (logStream.writableFinished) resolve();
      else logStream.once('finish', () => resolve());
    });
    await flushed;
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
