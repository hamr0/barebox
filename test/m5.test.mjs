// M5: keys the agent never holds, at the proxy. Real proxy, real policy gate,
// real sockets (no sandbox: the sandbox half is in launcher/run tests). Two
// loopback upstreams: 127.0.0.1 is where the secret is bound, 127.0.0.2 is not.
// Async clients only. Every client path the swap must cover is tested: the TCP
// door (plain requests), CONNECT through it (decrypted), and a proxy with no gate.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import v8 from 'node:v8';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../src/proxy.js';
import { gateFor as policyGate } from '../src/policy.js';
import { runtimePaths } from '../src/runtime.js';
import { loadSecrets } from '../src/secrets.js';
import { ensureCA, certFor } from '../src/certs.js';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await nap(25);
  }
}

const hex = (n) => crypto.randomBytes(n).toString('hex');
const REAL = `sk_test_REAL_${hex(12)}`;
/** The real value as it could appear: plain, and base64 at the three alignments. */
const NEEDLES = [REAL, ...[0, 1, 2].map((k) => {
  const b = Buffer.from(' '.repeat(k) + REAL).toString('base64').replace(/=+$/, '');
  return b.slice([0, 2, 3][k], b.length - 2);
})];
const hasReal = (text) => NEEDLES.some((n) => String(text).includes(n));

/** An upstream that records every request and answers a fixed body. */
function recorder(host, tlsKeyCert) {
  const seen = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.end('upstream-ok');
    });
  };
  const srv = tlsKeyCert ? https.createServer(tlsKeyCert, handler) : http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, host, () => resolve({
    seen, port: srv.address().port,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  })));
}

let up; // { bound, unbound, tlsBound, tlsUnbound }
let CA, certRoot;
before(async () => {
  certRoot = mkdtempSync(join(tmpdir(), 'bb-m5c-'));
  await ensureCA(join(certRoot, 'certs'));
  CA = join(certRoot, 'certs', 'ca.pem');
  up = {
    bound: await recorder('127.0.0.1'),
    unbound: await recorder('127.0.0.2'),
    tlsBound: await recorder('127.0.0.1', await certFor(join(certRoot, 'certs'), '127.0.0.1')),
    tlsUnbound: await recorder('127.0.0.2', await certFor(join(certRoot, 'certs'), '127.0.0.2')),
  };
});
after(async () => {
  for (const u of Object.values(up ?? {})) await u.close();
  if (certRoot) rmSync(certRoot, { recursive: true, force: true });
});

/** Every file under `dir` as text (latin1), the runtime's whole tree. */
function filesUnder(dir) {
  const acc = [];
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); }
    else { try { acc.push([p, readFileSync(p, 'latin1')]); } catch {} }
  };
  walk(dir);
  return acc;
}

/**
 * One proxy on its own runtime with the secret bound to 127.0.0.1 only.
 * `gated: false` builds no gate. `fn` gets the helpers; the proxy is closed
 * after, and `t.end()` closes it early and returns what the runtime holds.
 */
async function withProxy({ mode = 'auto', gated = true }, fn) {
  for (const u of Object.values(up)) u.seen.length = 0;
  const rt = mkdtempSync(join(tmpdir(), 'bb-m5-'));
  const paths = runtimePaths(rt);
  const secrets = loadSecrets({ STRIPE_API_KEY: { value: REAL, hosts: ['127.0.0.1'] } });
  const ph = secrets[0].placeholder;
  const proxy = createProxy({ port: 0, logFile: paths.audit, runtime: rt, clientIdleMs: 5000, secrets,
    upstreamCa: CA, unsafeTestOnly: { allowLoopback: true },
    ...(gated ? { gateFor: (agent, { humanChannel }) =>
      policyGate({ agent, mode, auditPath: paths.audit, humanChannel }) } : {}),
    hold: { timeoutMs: 15000, pollMs: 25 } });
  const { port } = await proxy.ready;
  const bodies = []; // every response body the client got
  /** One request over `agentOpts` (default: plain through the TCP door). */
  const request = (opts, body) => new Promise((resolve, reject) => {
    // A tunnel arrives already encrypted (createConnection): speak plain HTTP over it.
    const req = http.request(opts, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => { const b = Buffer.concat(parts).toString(); bodies.push(b); resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    if (body !== undefined) { req.setHeader('content-length', Buffer.byteLength(body)); req.end(body); } else req.end();
  });
  let ended = null;
  const t = {
    rt, paths, proxy, ph, bodies,
    /** A plain request through the TCP door with an absolute URI. */
    send: (host, port2, path, { method = 'GET', headers = {}, body } = {}) =>
      request({ host: '127.0.0.1', port, method, path: `http://${host}:${port2}${path}`,
        headers: { host: `${host}:${port2}`, ...headers } }, body),
    /** A request decrypted from a CONNECT tunnel through the TCP door. */
    async sendTls(host, port2, path, { method = 'GET', headers = {}, body } = {}) {
      const sock = net.connect(port, '127.0.0.1');
      await once(sock, 'connect');
      sock.write(`CONNECT ${host}:${port2} HTTP/1.1\r\nHost: ${host}:${port2}\r\n\r\n`);
      let head = '';
      await new Promise((resolve, reject) => {
        const onData = (c) => { head += c.toString('latin1'); if (head.includes('\r\n\r\n')) { sock.off('data', onData); resolve(); } };
        sock.on('data', onData);
        sock.on('error', reject);
      });
      assert.match(head, /200 Connection established/);
      // The tunnel is terminated with the PROXY's own CA; the upstream's cert is the fixture CA's (upstreamCa).
      const ts = tls.connect({ socket: sock, ca: [readFileSync(proxy.caFile, 'utf8')], servername: host });
      await once(ts, 'secureConnect');
      try {
        return await request({ host, port: port2, method, path, createConnection: () => ts,
          headers: { host: `${host}:${port2}`, ...headers } }, body);
      } finally { ts.destroy(); }
    },
    /** A clear-text request inside a CONNECT tunnel (what Node's fetch sends for http://). */
    async sendPlainTunnel(host, port2, path, { method = 'GET', headers = {}, body } = {}) {
      const sock = net.connect(port, '127.0.0.1');
      await once(sock, 'connect');
      sock.write(`CONNECT ${host}:${port2} HTTP/1.1\r\nHost: ${host}:${port2}\r\n\r\n`);
      let head = '';
      await new Promise((resolve, reject) => {
        const onData = (c) => { head += c.toString('latin1'); if (head.includes('\r\n\r\n')) { sock.off('data', onData); resolve(); } };
        sock.on('data', onData);
        sock.on('error', reject);
      });
      assert.match(head, /200 Connection established/);
      try {
        return await request({ host, port: port2, method, path, createConnection: () => sock,
          headers: { host: `${host}:${port2}`, ...headers } }, body);
      } finally { sock.destroy(); }
    },
    parked: (n = 1) => waitFor(() => (proxy.pending().length >= n ? proxy.pending() : null), `${n} hold(s) to park`),
    askText: (id) => readFileSync(paths.askFile(id), 'utf8'),
    answer(id, obj) {
      mkdirSync(paths.answersDir, { recursive: true });
      const tmp = join(paths.answersDir, `.${id}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, paths.answerFile(id));
    },
    /** Close the proxy (flushing the audit); returns the parsed audit and every runtime file. */
    async end() {
      if (!ended) {
        await Promise.race([proxy.close(), nap(5000)]);
        const lines = readFileSync(paths.audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        ended = { lines, secretLines: lines.filter((l) => l.verdict === 'secret').map((l) => l.meta), files: filesUnder(rt) };
      }
      return ended;
    },
  };
  try {
    return await fn(t);
  } finally {
    await Promise.race([proxy.close(), nap(5000)]);
    rmSync(rt, { recursive: true, force: true });
  }
}

/** The real value is nowhere the agent's side can see: audit, asks, answers, every runtime file, every response body. */
async function assertNoLeak(t) {
  const { lines, files } = await t.end();
  assert.ok(!hasReal(JSON.stringify(lines)), 'the real value is in the audit');
  const leaked = files.filter(([, text]) => hasReal(text)).map(([p]) => p);
  assert.deepEqual(leaked, [], 'the real value is in a runtime file');
  assert.ok(!t.bodies.some(hasReal), 'the real value came back in a response body');
}

const auth = (ph) => ({ authorization: `Bearer ${ph}` });

describe('allowed to the bound host: the real value goes in', () => {
  it('TCP door, auto mode, over TLS: a GET arrives with the real value, one swapped line, joined by rid', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendTls('127.0.0.1', up.tlsBound.port, '/ok', { headers: auth(t.ph) });
      assert.equal(r.status, 200);
      assert.equal(up.tlsBound.seen.length, 1);
      assert.equal(up.tlsBound.seen[0].headers.authorization, `Bearer ${REAL}`);
      const { secretLines, lines } = await t.end();
      assert.equal(secretLines.length, 1);
      assert.deepEqual({ ...secretLines[0], rid: undefined }, { agent: 'tcp', rid: undefined, name: 'STRIPE_API_KEY', host: '127.0.0.1', swapped: true });
      assert.match(secretLines[0].rid, /^r\d+$/);
      // the same rid is on the gate's check line
      assert.ok(lines.some((l) => l.phase === 'gate' && l.action?.rid === secretLines[0].rid),
        'a gate line carries the same rid');
      await assertNoLeak(t);
    });
  });

  it('x-api-key and Basic base64(<ph>:) arrive swapped too, over TLS', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      await t.sendTls('127.0.0.1', up.tlsBound.port, '/k', { headers: { 'x-api-key': t.ph } });
      await t.sendTls('127.0.0.1', up.tlsBound.port, '/b', { headers: { authorization: `Basic ${Buffer.from(`${t.ph}:`).toString('base64')}` } });
      assert.equal(up.tlsBound.seen[0].headers['x-api-key'], REAL);
      assert.equal(Buffer.from(up.tlsBound.seen[1].headers.authorization.slice(6), 'base64').toString(), `${REAL}:`);
      await assertNoLeak(t);
    });
  });

  it('CONNECT (decrypted): the same path', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendTls('127.0.0.1', up.tlsBound.port, '/tls', { headers: auth(t.ph) });
      assert.equal(r.status, 200);
      assert.equal(up.tlsBound.seen.length, 1);
      assert.equal(up.tlsBound.seen[0].headers.authorization, `Bearer ${REAL}`);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.map((l) => [l.name, l.host, l.swapped]), [['STRIPE_API_KEY', '127.0.0.1', true]]);
      await assertNoLeak(t);
    });
  });

  it('a proxy with no gate swaps too, over TLS', { timeout: 20000 }, async () => {
    await withProxy({ gated: false }, async (t) => {
      const r = await t.sendTls('127.0.0.1', up.tlsBound.port, '/nogate', { headers: auth(t.ph) });
      assert.equal(r.status, 200);
      assert.equal(up.tlsBound.seen[0].headers.authorization, `Bearer ${REAL}`);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.map((l) => l.swapped), [true]);
      await assertNoLeak(t);
    });
  });

  it('held, then approved, over TLS: arrives with the real value; the ask and the held request never show it', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const sent = t.sendTls('127.0.0.1', up.tlsBound.port, '/held', { method: 'POST', body: 'm=1', headers: auth(t.ph) });
      const [h] = await t.parked();
      assert.equal(h.rule, 'rwx.ask');
      assert.equal(up.tlsBound.seen.length, 0, 'nothing upstream while parked');
      assert.ok(!hasReal(t.askText(h.id)) && !hasReal(JSON.stringify(t.proxy.pending())), 'the real value is in the ask');
      t.answer(h.id, { decision: 'allow' });
      const r = await sent;
      assert.equal(r.status, 200);
      assert.equal(up.tlsBound.seen.length, 1);
      assert.equal(up.tlsBound.seen[0].headers.authorization, `Bearer ${REAL}`);
      assert.equal(up.tlsBound.seen[0].body, 'm=1');
      await assertNoLeak(t);
    });
  });

  it('while held, the real value is nowhere in the proxy heap; the probe can see such a string', { timeout: 60000 }, async () => {
    // The proxy runs in this process, so a heap snapshot sees what it holds.
    const snapshot = async () => {
      const parts = [];
      for await (const c of v8.getHeapSnapshot()) parts.push(c);
      return Buffer.concat(parts);
    };
    await withProxy({}, async (t) => {
      const sent = t.sendTls('127.0.0.1', up.tlsBound.port, '/heap', { method: 'POST', body: 'm=1', headers: auth(t.ph) });
      const [h] = await t.parked();
      assert.equal(h.rule, 'rwx.ask');
      const held = await snapshot();
      // Built after the snapshot, so the needle is not in it. split/join gives a flat string, as swapIn does.
      const needle = 'Bearer @'.split('@').join(REAL);
      assert.ok(held.includes(Buffer.from(t.ph)), 'the placeholder is in the heap while held (the probe reads the request)');
      assert.ok(!held.includes(Buffer.from(needle)), 'the real value is in the heap while the request is held');
      // Control: the same snapshot sees a flat string like the one swapIn makes.
      const probe = 'Bearer @'.split('@').join(REAL);
      assert.ok((await snapshot()).includes(Buffer.from(probe)), 'the probe cannot see a flat string');
      assert.equal(probe, needle);
      t.answer(h.id, { decision: 'deny', reason: 'test' });
      assert.equal((await sent).status, 403);
      assert.equal(up.tlsBound.seen.length, 0);
    });
  });

  it('held, then approved, over CONNECT', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const sent = t.sendTls('127.0.0.1', up.tlsBound.port, '/held-tls', { method: 'POST', body: 'm=2', headers: auth(t.ph) });
      const [h] = await t.parked();
      assert.equal(up.tlsBound.seen.length, 0);
      t.answer(h.id, { decision: 'allow' });
      assert.equal((await sent).status, 200);
      assert.equal(up.tlsBound.seen[0].headers.authorization, `Bearer ${REAL}`);
      await assertNoLeak(t);
    });
  });
});

describe('the bound host over plain http: 403 denied: secret.scheme, nothing sent', () => {
  for (const mode of ['ask', 'auto', 'trust']) {
    it(`${mode}: a placeholder to the bound host over http is refused before the gate`, { timeout: 20000 }, async () => {
      await withProxy({ mode }, async (t) => {
        const r = await t.send('127.0.0.1', up.bound.port, '/cleartext', { headers: auth(t.ph) });
        assert.equal(r.status, 403);
        assert.equal(r.body.trim(), 'denied: secret.scheme');
        assert.equal(up.bound.seen.length, 0, 'the upstream saw a request');
        assert.equal(t.proxy.pending().length, 0, 'never asks');
        const { secretLines } = await t.end();
        assert.deepEqual(secretLines.map((l) => [l.name, l.host, l.swapped]), [['STRIPE_API_KEY', '127.0.0.1', false]]);
        assert.match(secretLines[0].rid, /^r\d+$/);
        assert.deepEqual(secretLines.filter((l) => l.swapped), [], 'a swapped:true line');
        await assertNoLeak(t);
      });
    });
  }

  it('a POST with a body is refused at once and a proxy with no gate refuses it too', { timeout: 20000 }, async () => {
    for (const gated of [true, false]) {
      await withProxy({ gated }, async (t) => {
        const t0 = Date.now();
        const r = await t.send('127.0.0.1', up.bound.port, '/cleartext', { method: 'POST', body: 'x'.repeat(5000), headers: auth(t.ph) });
        assert.equal(r.status, 403);
        assert.equal(r.body.trim(), 'denied: secret.scheme');
        assert.ok(Date.now() - t0 < 3000, 'must be refused at once');
        assert.equal(t.proxy.pending().length, 0);
        assert.equal(up.bound.seen.length, 0);
        await assertNoLeak(t);
      });
    }
  });
});

describe('an unbound host: 403 denied: secret.host, nothing sent', () => {
  for (const mode of ['ask', 'auto', 'trust']) {
    it(`${mode}: the TCP door`, { timeout: 20000 }, async () => {
      await withProxy({ mode }, async (t) => {
        const r = await t.send('127.0.0.2', up.unbound.port, '/e', { headers: auth(t.ph) });
        assert.equal(r.status, 403);
        assert.equal(r.body.trim(), 'denied: secret.host');
        assert.equal(up.unbound.seen.length, 0, 'the upstream saw a request');
        assert.equal(t.proxy.pending().length, 0, 'never asks');
        const { secretLines } = await t.end();
        assert.deepEqual(secretLines.map((l) => [l.name, l.host, l.swapped]), [['STRIPE_API_KEY', '127.0.0.2', false]]);
        assert.match(secretLines[0].rid, /^r\d+$/);
        await assertNoLeak(t);
      });
    });
  }

  it('a POST with a body is refused and its body dropped', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const t0 = Date.now();
      const r = await t.send('127.0.0.2', up.unbound.port, '/e', { method: 'POST', body: 'x'.repeat(5000), headers: auth(t.ph) });
      assert.equal(r.status, 403);
      assert.equal(r.body.trim(), 'denied: secret.host', 'refused by the secret rule, not by a hold timing out');
      assert.ok(Date.now() - t0 < 3000, 'must be refused at once');
      assert.equal(t.proxy.pending().length, 0);
      assert.equal(up.unbound.seen.length, 0);
      await assertNoLeak(t);
    });
  });

  it('CONNECT (decrypted): the same refusal', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendTls('127.0.0.2', up.tlsUnbound.port, '/e-tls', { headers: auth(t.ph) });
      assert.equal(r.status, 403);
      assert.equal(r.body.trim(), 'denied: secret.host');
      assert.equal(up.tlsUnbound.seen.length, 0);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.map((l) => l.swapped), [false]);
      await assertNoLeak(t);
    });
  });

  it('a proxy with no gate refuses it too', { timeout: 20000 }, async () => {
    await withProxy({ gated: false }, async (t) => {
      const r = await t.send('127.0.0.2', up.unbound.port, '/e', { headers: auth(t.ph) });
      assert.equal(r.status, 403);
      assert.equal(up.unbound.seen.length, 0);
    });
  });
});

describe('denied by the gate: only the placeholder ever existed, nothing sent, no swapped line', () => {
  it('rwx.unlisted (OPTIONS) to the bound host, over TLS', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendTls('127.0.0.1', up.tlsBound.port, '/d', { method: 'OPTIONS', headers: auth(t.ph) });
      assert.equal(r.status, 403);
      assert.match(r.body, /rwx\.unlisted/);
      assert.equal(up.tlsBound.seen.length, 0);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.filter((l) => l.swapped), [], 'a swapped:true line for a denied request');
      await assertNoLeak(t);
    });
  });

  it('an ask answered deny, over TLS', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const sent = t.sendTls('127.0.0.1', up.tlsBound.port, '/d2', { method: 'POST', body: 'm=3', headers: auth(t.ph) });
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'deny', reason: 'no' });
      const r = await sent;
      assert.equal(r.status, 403);
      assert.equal(up.tlsBound.seen.length, 0);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.filter((l) => l.swapped), [], 'a swapped:true line for a denied request');
      await assertNoLeak(t);
    });
  });

  it('an ask answered deny, over CONNECT', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const sent = t.sendTls('127.0.0.1', up.tlsBound.port, '/d3', { method: 'POST', body: 'm=4', headers: auth(t.ph) });
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'deny' });
      assert.equal((await sent).status, 403);
      assert.equal(up.tlsBound.seen.length, 0);
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.filter((l) => l.swapped), []);
      await assertNoLeak(t);
    });
  });
});

describe('a request without a placeholder is untouched', () => {
  it('no secret lines, headers as sent', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      await t.send('127.0.0.1', up.bound.port, '/plain', { headers: { authorization: 'Bearer something-else' } });
      assert.equal(up.bound.seen[0].headers.authorization, 'Bearer something-else');
      assert.deepEqual((await t.end()).secretLines, []);
    });
  });
});

describe('plain http inside a CONNECT tunnel (what Node fetch sends for http://)', () => {
  it('is forwarded in clear: the upstream answers and saw the path', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendPlainTunnel('127.0.0.1', up.bound.port, '/x');
      assert.equal(r.status, 200);
      assert.equal(r.body, 'upstream-ok');
      assert.deepEqual(up.bound.seen.map((q) => q.url), ['/x']);
    });
  });

  it('a placeholder inside it is refused 403 denied: secret.scheme, nothing sent', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const r = await t.sendPlainTunnel('127.0.0.1', up.bound.port, '/x', { headers: auth(t.ph) });
      assert.equal(r.status, 403);
      assert.equal(r.body.trim(), 'denied: secret.scheme');
      assert.equal(up.bound.seen.length, 0, 'the upstream saw a request');
      const { secretLines } = await t.end();
      assert.deepEqual(secretLines.map((l) => [l.name, l.host, l.swapped]), [['STRIPE_API_KEY', '127.0.0.1', false]]);
      await assertNoLeak(t);
    });
  });
});

describe('a placeholder in the URL: 403 denied: secret.url, nothing sent', () => {
  for (const [what, path] of [['query', '/api?key=PH'], ['path', '/v1/PH/charges']]) {
    for (const mode of ['ask', 'auto', 'trust']) {
      it(`${what}, ${mode}, over TLS to the bound host`, { timeout: 20000 }, async () => {
        await withProxy({ mode }, async (t) => {
          const r = await t.sendTls('127.0.0.1', up.tlsBound.port, path.replace('PH', t.ph));
          assert.equal(r.status, 403);
          assert.equal(r.body.trim(), 'denied: secret.url');
          assert.equal(up.tlsBound.seen.length, 0, 'the upstream saw a request');
          assert.equal(t.proxy.pending().length, 0, 'never asks');
          const { secretLines } = await t.end();
          assert.deepEqual(secretLines.map((l) => [l.name, l.host, l.swapped]), [['STRIPE_API_KEY', '127.0.0.1', false]]);
          assert.match(secretLines[0].rid, /^r\d+$/);
          await assertNoLeak(t);
        });
      });
    }
  }
});
