// Proxy tests: the M1 matrix (positives + negatives) and M2 holds, against
// createProxy(). Fixtures are in-process (test/fixtures/): nothing imports
// poc/, no fixed ports, no sleeps for readiness — every client is async, so
// the in-process proxy can always answer.
//
// test/setup-env.mjs (via --import) already dropped the sandbox's egress proxy
// vars before `node:http` snapshotted them; repeat here so curl children
// inherit a clean env on direct single-file runs too.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import { createProxy, denyReasonForIp } from '../src/proxy.js';
import { ensureCA, certFor } from '../src/certs.js';
import { startHttps, startHttp } from './fixtures/upstream.mjs';

const execA = promisify(execFileCb);

let RT, CA_PEM, CA, tlsUp, plainUp, proxy, PORT, PROXY;
const kids = [];

function curl(...args) {
  return execA('curl', ['-s', '--max-time', '8', '-x', PROXY, ...args],
    { encoding: 'latin1' });
}
function log() { return readFileSync(join(RT, 'mitm.log'), 'latin1'); }

// The audit log is a write stream: poll until the line lands, never assume.
async function waitLog(re, what) {
  await waitFor(() => re.test(log()), `log to show ${what}`);
}

// Poll until cond() is truthy; the timeout message says what was awaited.
async function waitFor(cond, what, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-probe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();

// CONNECT through the proxy, then wrap the tunnel in TLS. In-process, so no
// sync-child deadlock is possible.
async function connectTunnel(target) {
  const sock = net.connect(PORT, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let head = '';
  await new Promise((resolve, reject) => {
    const onData = (c) => {
      head += c.toString('latin1');
      if (head.includes('\r\n\r\n')) { sock.removeListener('data', onData); resolve(); }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
  assert.match(head, /200 Connection established/);
  const host = target.split(':')[0];
  const t = tls.connect({ socket: sock, ca: [CA_PEM], servername: host });
  await once(t, 'secureConnect');
  return t;
}

// Read exactly one framed response (content-length), or to EOF when the
// server closes (close-delimited). Leaves the socket open for reuse.
function readOneResponse(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.subarray(0, i).toString('latin1');
      const status = parseInt(head.split(' ')[1], 10);
      const m = head.toLowerCase().match(/content-length:\s*(\d+)/);
      if (m) {
        const n = i + 4 + parseInt(m[1], 10);
        if (buf.length < n) return;
        sock.removeListener('data', onData);
        resolve({ status, head, body: buf.subarray(i + 4, n).toString('latin1') });
      } else if (/connection:\s*close/i.test(head)) {
        // Close-delimited: keep reading until EOF.
        const saved = buf.subarray(i + 4);
        const parts = [saved];
        sock.removeListener('data', onData);
        sock.on('data', (c2) => parts.push(c2));
        sock.once('close', () => resolve({ status, head, body: Buffer.concat(parts).toString('latin1') }));
      } else {
        sock.removeListener('data', onData);
        reject(new Error(`unframed head without close: ${head.split('\r\n')[0]}`));
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

before(async () => {
  RT = mkdtempSync(join(tmpdir(), 'bb-p-'));
  await ensureCA(join(RT, 'certs'));
  const kc = await certFor(join(RT, 'certs'), '127.0.0.1');
  CA = join(RT, 'certs', 'ca.pem');
  CA_PEM = readFileSync(CA, 'utf8');
  tlsUp = await startHttps(kc);
  plainUp = await startHttp();
  // allowLoopback is the TEST-ONLY opt-in: fixtures listen on 127.0.0.1,
  // which the default wall denies (see 'loopback wall' below).
  proxy = createProxy({ port: 0, certDir: join(RT, 'certs'),
    logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
    clientIdleMs: 1000, allowLoopback: true });
  ({ port: PORT } = await proxy.ready);
  PROXY = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  try {
    for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
    await proxy?.close();
    await tlsUp?.close();
    await plainUp?.close();
  } finally {
    if (RT) rmSync(RT, { recursive: true, force: true });
  }
});

describe('positives', () => {
  it('curl GET+POST with wire bodies', async () => {
    const g = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      `${tlsUp.url}?m=curl`);
    assert.equal(g.stdout, '200');
    const p = await curl('--cacert', CA, '--data', 'client=curl&marker=M1CURL',
      `${tlsUp.url}?m=curl`);
    assert.match(p.stdout, /M1CURL/);
    await waitLog(/m=curl/, 'm=curl');
  });

  it('node client through the CONNECT tunnel', async () => {
    const t = await connectTunnel(`127.0.0.1:${tlsUp.port}`);
    try {
      const body = 'marker=M1NODE';
      t.write(`POST /?m=node HTTP/1.1\r\nHost: 127.0.0.1:${tlsUp.port}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      const r = await readOneResponse(t);
      assert.equal(r.status, 200);
      assert.match(r.body, /M1NODE/);
    } finally {
      t.destroy();
    }
    await waitLog(/m=node/, 'm=node');
  });

  it('HEAD answers from headers, no 6s body wait', async () => {
    const t0 = Date.now();
    const r = await curl('--cacert', CA, '-I', `${tlsUp.url}?m=head`);
    const ms = Date.now() - t0;
    assert.match(r.stdout, /^HTTP\/1\.1 200/m);
    assert.ok(ms < 5000, `HEAD took ${ms}ms`);
  });

  it('204 and 304 pass through with no body', async () => {
    const n4 = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      `${tlsUp.url}204`);
    assert.equal(n4.stdout, '204');
    const n3 = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      `${tlsUp.url}304`);
    assert.equal(n3.stdout, '304');
  });

  it('chunked response arrives intact', async () => {
    const body = await curl('--cacert', CA, `${tlsUp.url}chunked`);
    assert.equal(body.stdout, 'chunk-one-chunk-two');
  });

  it('close-delimited response passes through (stdlib reads to EOF)', async () => {
    const body = await curl('--cacert', CA, `${tlsUp.url}close`);
    assert.equal(body.stdout, 'close-delimited');
  });

  it('slow upstream (2.5s) is not killed by the 1s client-idle timer', async () => {
    const t0 = Date.now();
    const r = await execA('curl', ['-s', '--max-time', '10', '-x', PROXY,
      '--cacert', CA, `${tlsUp.url}slow?ms=2500`], { encoding: 'latin1' });
    assert.equal(r.stdout, 'slow-ok');
    assert.ok(Date.now() - t0 >= 2500, 'upstream must actually have been slow');
  });

  it('TLS tunnel stays up for a second request', async () => {
    const t = await connectTunnel(`127.0.0.1:${tlsUp.port}`);
    try {
      for (const m of ['keep1', 'keep2']) {
        t.write(`GET /?m=${m} HTTP/1.1\r\nHost: 127.0.0.1:${tlsUp.port}\r\nContent-Length: 0\r\n\r\n`);
        const r = await readOneResponse(t);
        assert.equal(r.status, 200);
        assert.equal(r.body, 'local-ok');
      }
    } finally {
      t.destroy();
    }
    await waitLog(/m=keep2/, 'm=keep2');
  });

  it('plain HTTP GET+POST through the same handler', async () => {
    const g = await curl(`${plainUp.url}?m=plain`);
    assert.equal(g.stdout, 'local-ok');
    const p = await curl('--data', 'marker=M1PLAIN', `${plainUp.url}?m=plain`);
    assert.match(p.stdout, /M1PLAIN/);
  });

  it('plain-HTTP keep-alive: second request on one connection is answered', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (const m of ['pk1', 'pk2']) {
        const r = await new Promise((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1', port: PORT, agent,
            path: `${plainUp.url}?m=${m}`, method: 'GET',
          }, (res) => {
            let out = '';
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: out }));
          });
          req.on('error', reject);
          req.end();
        });
        assert.equal(r.status, 200);
        assert.equal(r.body, 'local-ok');
      }
    } finally {
      agent.destroy();
    }
    await waitLog(/m=pk2/, 'm=pk2');
  });
});

describe('negatives', () => {
  it('unresolvable names fail closed at the door (403, never dialed)', async () => {
    const head = await new Promise((resolve, reject) => {
      const s = net.connect(PORT, '127.0.0.1');
      let out = '';
      s.on('connect', () => s.write('CONNECT minted.invalid:443 HTTP/1.1\r\nHost: minted.invalid\r\n\r\n'));
      s.on('data', (c) => {
        out += c.toString('latin1');
        if (out.includes('\r\n\r\n')) { s.destroy(); resolve(out); }
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('unresolvable deny took too long')); }, 5000);
    });
    assert.match(head, /^HTTP\/1\.1 403 /m);
    assert.match(head, /unresolvable upstream denied: minted\.invalid/);
  });

  it('certs are minted on demand (no pre-made certs needed)', async () => {
    const kc = await certFor(join(RT, 'certs'), 'minted.invalid');
    assert.ok(kc.key.length > 0 && kc.cert.length > 0);
  });

  it('upstream with an unknown-CA cert is 502 and never forwarded', async () => {
    // The proxy re-encrypts toward the real server, so it must verify like
    // a client: default trust (system roots + upstreamCa) only. This locks
    // in that no `rejectUnauthorized: false` ever sneaks in for a fixture.
    const dir = mkdtempSync(join(tmpdir(), 'bb-rogue-'));
    let rogue = null;
    try {
      await execA('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        '-days', '1', '-subj', '/CN=rogue', '-addext', 'subjectAltName=IP:127.0.0.1']);
      rogue = await startHttps({ key: readFileSync(join(dir, 'key.pem')),
        cert: readFileSync(join(dir, 'cert.pem')) });
      const before = rogue.hits.get('/') ?? 0;
      const r = await curl('--cacert', CA, `${rogue.url}?m=rogue`);
      assert.match(r.stdout, /upstream 127\.0\.0\.1 failed/);
      assert.equal(rogue.hits.get('/') ?? 0, before, 'rejected TLS must never reach the upstream handler');
    } finally {
      await rogue?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed inputs are loud 400s, never silence', async () => {
    const connectHead = await new Promise((resolve, reject) => {
      const s = net.connect(PORT, '127.0.0.1');
      let out = '';
      s.on('connect', () => s.write('CONNECT !!bad!! HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (c) => {
        out += c.toString('latin1');
        if (out.includes('\r\n\r\n')) { s.destroy(); resolve(out); }
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('bad CONNECT line took too long')); }, 3000);
    });
    assert.match(connectHead, /^HTTP\/1\.1 400 /m);
    assert.match(connectHead, /bad connect line/);
    const badTarget = await new Promise((resolve, reject) => {
      const s = net.connect(PORT, '127.0.0.1');
      let buf = Buffer.alloc(0);
      s.on('connect', () => s.write('GET http:// HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      s.on('data', (c) => { buf = Buffer.concat([buf, c]); });
      s.on('close', () => resolve(buf.toString('latin1')));
      s.on('error', reject);
      setTimeout(() => reject(new Error('bad target took too long')), 3000);
    });
    assert.match(badTarget, /^HTTP\/1\.1 400 /m);
    assert.match(badTarget, /bad request target/);
  });

  it('dead upstream is 502 with reason', async () => {
    const code = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      'https://127.0.0.1:9/');
    assert.equal(code.stdout, '502');
    await waitLog(/upstream 127\.0\.0\.1 failed/, 'dead-upstream 502');
  });

  it('client without CA fails with exit 60, not silence', async () => {
    const err = await curl(`${tlsUp.url}?m=nocA`).then(
      () => null, (e) => e);
    assert.ok(err, 'curl without --cacert must fail');
    assert.equal(err.code, 60, `expected curl exit 60, got ${err.code}: ${err.stderr}`);
    // And the proxy is still up — the failure was verification, not outage.
    const g = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      `${tlsUp.url}?m=after-noca`);
    assert.equal(g.stdout, '200');
  });

  it('second proxy on the same port rejects ready, never crashes', async () => {
    const dup = createProxy({ port: PORT, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA });
    await assert.rejects(dup.ready, /EADDRINUSE/);
    await dup.close();
    // Original still serves.
    const g = await curl('--cacert', CA, '-o', '/dev/null', '-w', '%{http_code}',
      `${tlsUp.url}?m=after-dup`);
    assert.equal(g.stdout, '200');
  });

  it('binds 127.0.0.1 only', async (t) => {
    let ifs = [];
    try { ifs = Object.values(os.networkInterfaces()).flat(); }
    catch { t.skip('interface list blocked here; binding is 127.0.0.1 by construction'); return; }
    const ext = ifs.find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (!ext) {
      t.skip('no external interface in this netns; binding is 127.0.0.1 by construction');
      return;
    }
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = net.connect(PORT, ext);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.on('error', reject);
      }),
      /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/);
  });

  it('per-agent unix socket carries identity, via socat bridge',
    { skip: UNIX_OK ? false : 'unix socket bind blocked here; run in a real shell or CI' }, async () => {
    const sockPath = proxy.addAgent('a1');
    assert.equal(sockPath, join(RT, 'socks', 'a1.sock'));
    // Free-port probe, then bridge TCP -> unix exactly like the launcher does.
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const bridgePort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const bridge = spawn('socat',
      [`TCP-LISTEN:${bridgePort},bind=127.0.0.1,reuseaddr,fork`, `UNIX-CONNECT:${sockPath}`],
      { stdio: 'ignore' });
    kids.push(bridge);
    try {
      // Readiness: a CONNECT through the bridge gets a (502) answer.
      await waitFor(async () => {
        try {
          const p = await execA('curl', ['-s', '--max-time', '3', '-x',
            `http://127.0.0.1:${bridgePort}`, '--cacert', CA,
            'https://127.0.0.1:9/'], { encoding: 'latin1' });
          return /upstream 127\.0\.0\.1 failed/.test(p.stdout);
        } catch { return false; }
      }, 'socat bridge to answer');
      const r = await execA('curl', ['-s', '--max-time', '8', '-x',
        `http://127.0.0.1:${bridgePort}`, '--cacert', CA, `${tlsUp.url}?m=agent`],
        { encoding: 'latin1' });
      assert.equal(r.stdout, 'local-ok');
      await waitLog(/"agent":"a1"/, 'log line naming agent a1');
    } finally {
      bridge.kill('SIGKILL');
      kids.splice(kids.indexOf(bridge), 1);
      proxy.removeAgent('a1');
    }
  });
});

describe('loopback wall: default deny after DNS resolution', () => {
  let dp = null;
  let dport = 0;
  let DPROXY = '';

  before(async () => {
    // No allowLoopback: this is the production shape.
    dp = createProxy({ port: 0, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT });
    ({ port: dport } = await dp.ready);
    DPROXY = `http://127.0.0.1:${dport}`;
  });

  after(async () => {
    await dp?.close();
    dp = null;
  });

  it('plain HTTP to 127.0.0.1 is 403 with reason, never forwarded', async () => {
    const before = plainUp.hits.get('/') ?? 0;
    const t0 = Date.now();
    const r = await execA('curl', ['-s', '--max-time', '3', '-x', DPROXY,
      '-o', '/dev/null', '-w', '%{http_code}', `${plainUp.url}?m=wall`],
      { encoding: 'latin1' });
    const ms = Date.now() - t0;
    assert.equal(r.stdout, '403', `expected 403, got ${r.stdout}`);
    assert.ok(ms < 1000, `wall must answer fast, took ${ms}ms`);
    assert.equal(plainUp.hits.get('/') ?? 0, before, 'denied request must never reach upstream');
    await waitLog(/loopback upstream denied: 127\.0\.0\.1/, 'deny line with reason');
  });

  it('CONNECT to 127.0.0.1 is refused 403 at the door, no cert minted', async () => {
    const t0 = Date.now();
    const head = await new Promise((resolve, reject) => {
      const s = net.connect(dport, '127.0.0.1');
      let out = '';
      s.on('connect', () => s.write(`CONNECT 127.0.0.1:${plainUp.port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
      s.on('data', (c) => {
        out += c.toString('latin1');
        if (out.includes('\r\n\r\n')) { s.destroy(); resolve(out); }
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('CONNECT deny took too long')); }, 3000);
    });
    const ms = Date.now() - t0;
    assert.match(head, /^HTTP\/1\.1 403 /m);
    assert.match(head, /loopback upstream denied/);
    assert.ok(ms < 1000, `CONNECT wall must answer fast, took ${ms}ms`);
  });

  it('a hostname resolving to loopback is denied too (localhost, not just the literal)', async () => {
    const t0 = Date.now();
    const r = await execA('curl', ['-s', '--max-time', '3', '-x', DPROXY,
      `http://localhost:${plainUp.port}/?m=wallname`], { encoding: 'latin1' });
    const ms = Date.now() - t0;
    assert.match(r.stdout, /loopback upstream denied: localhost /);
    assert.ok(ms < 1000, `hostname wall must answer fast, took ${ms}ms`);
  });

  it('cloud metadata (169.254.169.254) is denied pre-connect', async () => {
    const t0 = Date.now();
    const r = await execA('curl', ['-s', '--max-time', '3', '-x', DPROXY,
      'http://169.254.169.254/latest/meta-data/'], { encoding: 'latin1' });
    const ms = Date.now() - t0;
    assert.match(r.stdout, /link-local upstream denied: 169\.254\.169\.254/);
    assert.ok(ms < 1000, `metadata wall must answer fast, took ${ms}ms`);
  });

  it('private LAN literals are denied by default (no allow-list)', async () => {
    for (const host of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '100.64.0.1']) {
      const r = await execA('curl', ['-s', '--max-time', '3', '-x', DPROXY,
        `http://${host}/`], { encoding: 'latin1' });
      assert.match(r.stdout, new RegExp(`private upstream denied: ${host.replace(/\./g, '\\.')}`));
    }
    assert.equal(denyReasonForIp('10.1.2.3', false), 'private');
    assert.equal(denyReasonForIp('172.16.0.1', false), 'private');
    assert.equal(denyReasonForIp('172.31.9.9', false), 'private');
    assert.equal(denyReasonForIp('172.32.0.1', false), null);
    assert.equal(denyReasonForIp('192.168.0.1', false), 'private');
    assert.equal(denyReasonForIp('100.64.0.1', false), 'private');
    assert.equal(denyReasonForIp('100.127.255.255', false), 'private');
    assert.equal(denyReasonForIp('100.128.0.1', false), null);
    assert.equal(denyReasonForIp('8.8.8.8', false), null);
    assert.equal(denyReasonForIp('fc00::1', false), 'private');
    assert.equal(denyReasonForIp('fd00::1', false), 'private');
    assert.equal(denyReasonForIp('::ffff:10.0.0.1', false), 'private');
    assert.equal(denyReasonForIp('2001:db8::1', false), null);
  });
});

describe('dns rebinding wall (stubbed resolver)', () => {
  async function stubProxy(stub, extra = {}) {
    const p = createProxy({ port: 0, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
      resolveUpstream: stub, ...extra });
    const { port } = await p.ready;
    return { p, url: `http://127.0.0.1:${port}` };
  }

  it('denies when ANY answer is walled (check-first-only would pass)', async () => {
    const seen = [];
    const { p, url } = await stubProxy(async (host) => {
      seen.push(host);
      assert.equal(host, 'rebind.test');
      return ['93.184.216.34', '127.0.0.1'];
    });
    try {
      const r = await execA('curl', ['-s', '--max-time', '3', '-x', url,
        'http://rebind.test/'], { encoding: 'latin1' });
      assert.match(r.stdout, /loopback upstream denied: rebind\.test \(127\.0\.0\.1\)/);
      assert.ok(seen.length >= 1, 'wall must consult DNS');
    } finally {
      await p.close();
    }
  });

  it('unresolvable names fail closed (NXDOMAIN is 403, never dialed)', async () => {
    const { p, url } = await stubProxy(async () => null);
    try {
      const r = await execA('curl', ['-s', '--max-time', '3', '-x', url,
        'http://gone.invalid/'], { encoding: 'latin1' });
      assert.match(r.stdout, /unresolvable upstream denied: gone\.invalid/);
    } finally {
      await p.close();
    }
  });

  it('POST body survives slow DNS: delayed stub still forwards the whole body', async () => {
    // Race: the direct-forward path tees the body, then forward() awaits a
    // second wall check. With a slow resolver the body arrives during that
    // wait; it must still reach upstream whole, not just the log tee.
    const marker = `marker=BODYRACE-${Date.now()}`;
    const { p, url } = await stubProxy(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return ['127.0.0.1'];
    }, { allowLoopback: true, upstreamTimeoutMs: 3000 });
    try {
      const target = `${plainUp.url}?m=bodyrace`.replace('http://127.0.0.1', 'http://slowdns.test');
      const r = await execA('curl', ['-s', '--max-time', '10', '-x', url,
        '--data', marker, target], { encoding: 'latin1' });
      assert.equal(r.stdout, marker);
    } finally {
      await p.close();
    }
  });

  it('the dial is pinned to the checked IP: later DNS answers are never used', async () => {
    let calls = 0;
    const before = plainUp.hits.get('/') ?? 0;
    const { p, url } = await stubProxy(async () => {
      calls += 1;
      // Door + forward checks see the fixture; anything after would be a re-dial.
      if (calls <= 2) return ['127.0.0.1'];
      return ['93.184.216.34'];
    }, { allowLoopback: true });
    try {
      const r = await execA('curl', ['-s', '--max-time', '5', '-x', url,
        `${plainUp.url}?m=pin`.replace('http://127.0.0.1', 'http://pinned.test')],
        { encoding: 'latin1' });
      assert.equal(r.stdout, 'local-ok');
      assert.equal(calls, 2, `dial must not re-resolve (saw ${calls} lookups)`);
      assert.ok((plainUp.hits.get('/') ?? 0) > before, 'pinned dial reached the fixture');
    } finally {
      await p.close();
    }
  });
});

describe('holds', () => {
  // The control socket lives inside the runtime dir (createProxy enforces
  // this: the launcher masks exactly that dir from sandboxed agents).
  const ctlPath = () => join(RT, 'ctl.sock');
  const NEED_UNIX = UNIX_OK ? false : 'unix socket bind blocked here; run in a real shell or CI';
  let hp = null;
  let hport = 0;
  const ctl = (cmd) => new Promise((resolve, reject) => {
    const s = net.connect(ctlPath(), () => s.write(cmd + '\n'));
    let out = '';
    s.on('data', (c) => { out += c; });
    s.on('end', () => resolve(out.trim()));
    s.on('error', reject);
  });

  // Fast by design: 500 ms client-idle, ~1.5 s hold deadline. A parked
  // request must outlive the idle timer (it is in flight, never idle), so
  // the approve test sleeps past idle and finds the hold still parked.
  async function holdProxy(holdExtra = {}) {
    hp = createProxy({ port: 0, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
      clientIdleMs: 500, allowLoopback: true,
      hold: { match: '/hold', timeoutMs: 1500, ...holdExtra },
      ...(UNIX_OK ? { controlSocket: ctlPath() } : {}) });
    ({ port: hport } = await hp.ready);
    return `http://127.0.0.1:${hport}`;
  }

  after(async () => {
    try {
      await hp?.close();
    } finally {
      hp = null;
      try { if (RT) rmSync(join(RT, 'ctl.sock'), { force: true }); } catch {}
    }
  });

  it('controlSocket outside the runtime throws, before any side effect', async () => {
    // No unix bind needed: createProxy must refuse synchronously.
    const outside = join(tmpdir(), `bb-outside-${process.pid}.sock`);
    assert.throws(() => createProxy({ port: 0, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
      controlSocket: outside }), /inside the runtime/);
    assert.ok(!existsSync(outside), 'refused socket must not be created');
  });

  it('approve forwards, deny refuses with reason', { skip: NEED_UNIX }, async () => {
    const P2 = await holdProxy();
    try {
      const p1 = execA('curl', ['-s', '--max-time', '5', '-x', P2,
        '--cacert', CA, '--data', 'm=HOLD1', `${tlsUp.url}hold`], { encoding: 'latin1' });
      const held = await waitFor(() => hp.pending().find((h) => /HOLD1/.test(h.body)),
        'hold on m=HOLD1 to park');
      assert.equal(held.agent, 'tcp');
      // Parked past the 500 ms idle timer: still held, not reaped.
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(hp.pending().some((h) => h.id === held.id), 'parked hold outlives the idle timer');
      assert.equal(await ctl(`approve ${held.id}`), `approved ${held.id}`);
      assert.match((await p1).stdout, /HOLD1/);
      assert.equal(hp.pending().length, 0);

      const p2 = execA('curl', ['-s', '--max-time', '5', '-x', P2,
        '--cacert', CA, '--data', 'm=HOLD2', `${tlsUp.url}hold`], { encoding: 'latin1' });
      const held2 = await waitFor(() => hp.pending().find((h) => /HOLD2/.test(h.body)),
        'hold on m=HOLD2 to park');
      assert.equal(await ctl(`deny ${held2.id} nope`), `denied ${held2.id}`);
      assert.match((await p2).stdout, /denied: nope/);
    } finally {
      await hp.close();
      hp = null;
    }
  });

  it('timeout denies and frees the queue', async () => {
    const P2 = await holdProxy({ timeoutMs: 1500 });
    try {
      const body = await execA('curl', ['-s', '--max-time', '5', '-x', P2,
        '--cacert', CA, '--data', 'm=HOLDT', `${tlsUp.url}hold`], { encoding: 'latin1' });
      assert.match(body.stdout, /hold timeout/);
      assert.equal(hp.pending().length, 0);
    } finally {
      await hp.close();
      hp = null;
    }
  });

  it('plain HTTP parks too (no hold bypass)', async () => {
    const P2 = await holdProxy();
    try {
      const p = execA('curl', ['-s', '--max-time', '5', '-x', P2,
        '--data', 'm=PLAINHOLD', `${plainUp.url}hold`], { encoding: 'latin1' });
      const held = await waitFor(() => hp.pending().find((h) => /PLAINHOLD/.test(h.body)),
        'plain-HTTP hold to park');
      assert.equal(held.agent, 'tcp');
      if (!UNIX_OK) { p.catch(() => {}); return; } // parked is proven; approve needs the control socket
      assert.equal(await ctl(`approve ${held.id}`), `approved ${held.id}`);
      assert.match((await p).stdout, /PLAINHOLD/);
    } finally {
      await hp.close();
      hp = null;
    }
  });

  it('over-cap bodies never queue (403 at the door)', async () => {
    const P2 = await holdProxy({ maxBody: 16 });
    try {
      const before = tlsUp.hits.get('/hold') ?? 0;
      const big = 'm=' + 'x'.repeat(1024);
      const r = await execA('curl', ['-s', '--max-time', '5', '-x', P2,
        '--cacert', CA, '--data', big, `${tlsUp.url}hold`], { encoding: 'latin1' });
      assert.match(r.stdout, /body too large to hold/);
      assert.equal(hp.pending().length, 0);
      assert.equal(tlsUp.hits.get('/hold') ?? 0, before, 'over-cap body must never reach upstream');
    } finally {
      await hp.close();
      hp = null;
    }
  });

  it('a disconnected hold can never be approved', async () => {
    const P2 = await holdProxy();
    try {
      const before = tlsUp.hits.get('/hold') ?? 0;
      const t = await connectTunnelVia(P2, `127.0.0.1:${tlsUp.port}`);
      const body = 'm=ABANDON';
      t.write(`POST /hold HTTP/1.1\r\nHost: 127.0.0.1:${tlsUp.port}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      const held = await waitFor(() => hp.pending().find((h) => /ABANDON/.test(h.body)),
        'hold on m=ABANDON to park');
      t.destroy(); // agent disconnects / gives up
      await waitFor(() => hp.pending().length === 0, 'abandoned hold to drop');
      await waitLog(/hold-abandoned/, 'hold-abandoned');
      if (UNIX_OK) assert.equal(await ctl(`approve ${held.id}`), `unknown ${held.id}`);
      assert.equal(tlsUp.hits.get('/hold') ?? 0, before, 'abandoned hold must never reach upstream');
    } finally {
      await hp.close();
      hp = null;
    }
  });

  it('close() settles parked holds and open tunnels, then resolves', async () => {
    const P2 = await holdProxy();
    const p = execA('curl', ['-s', '--max-time', '5', '-x', P2,
      '--cacert', CA, '--data', 'm=PARKED', `${tlsUp.url}hold`], { encoding: 'latin1' });
    await waitFor(() => hp.pending().length > 0, 'hold to park before close');
    // An idle keep-alive tunnel, held open past close().
    const idle = net.connect(hport, '127.0.0.1');
    await once(idle, 'connect');
    await hp.close();
    hp = null;
    // Parked client got an answer (deny), the queue is empty, the port is shut.
    const out = await p.then((r) => r.stdout, (e) => `CURL-FAILED:${e.code}`);
    assert.match(out, /denied: proxy closing/);
    await assert.rejects(netReady(hport), /ECONNREFUSED/, 'port must refuse after close');
    idle.destroy();
  });

  it('other requests complete while one is parked (go/no-go b)', { skip: NEED_UNIX }, async () => {
    const P2 = await holdProxy();
    try {
      const held = execA('curl', ['-s', '--max-time', '8', '-x', P2,
        '--cacert', CA, '--data', 'm=BUSY1', `${tlsUp.url}hold`], { encoding: 'latin1' });
      const parked = await waitFor(() => hp.pending().find((h) => /BUSY1/.test(h.body)),
        'hold on m=BUSY1 to park');
      // Same agent, separate connection, non-matching path: answers while
      // the first request is still parked — holds never gate the agent.
      const free = await execA('curl', ['-s', '--max-time', '8', '-x', P2,
        '--cacert', CA, `${tlsUp.url}?m=free`], { encoding: 'latin1' });
      assert.equal(free.stdout, 'local-ok');
      assert.ok(hp.pending().some((h) => h.id === parked.id), 'first request still parked');
      assert.equal(await ctl(`approve ${parked.id}`), `approved ${parked.id}`);
      assert.match((await held).stdout, /BUSY1/);
      assert.equal(hp.pending().length, 0);
    } finally {
      await hp.close();
      hp = null;
    }
  });

  // CONNECT to an arbitrary proxy base (used by the abandon test).
  async function connectTunnelVia(base, target) {
    const { port: bp } = new URL(base);
    const sock = net.connect(parseInt(bp, 10), '127.0.0.1');
    await once(sock, 'connect');
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    let head = '';
    await new Promise((resolve, reject) => {
      const onData = (c) => {
        head += c.toString('latin1');
        if (head.includes('\r\n\r\n')) { sock.removeListener('data', onData); resolve(); }
      };
      sock.on('data', onData);
      sock.on('error', reject);
    });
    assert.match(head, /200 Connection established/);
    const t = tls.connect({ socket: sock, ca: [CA_PEM], servername: target.split(':')[0] });
    await once(t, 'secureConnect');
    return t;
  }

  function netReady(port) {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', reject);
    });
  }
});

describe('two agents keep identity under interleave', () => {
  const ctl2Path = () => join(RT, 'ctl2.sock');
  const NEED_UNIX2 = UNIX_OK ? false : 'unix socket bind blocked here; run in a real shell or CI';
  const ctl2 = (cmd) => new Promise((resolve, reject) => {
    const s = net.connect(ctl2Path(), () => s.write(cmd + '\n'));
    let out = '';
    s.on('data', (c) => { out += c; });
    s.on('end', () => resolve(out.trim()));
    s.on('error', reject);
  });

  it('holds, responses and log lines name the right agent',
    { skip: NEED_UNIX2 }, async () => {
      const tp = createProxy({ port: 0, certDir: join(RT, 'certs'),
        logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
        clientIdleMs: 1000, allowLoopback: true,
        hold: { match: '/hold', timeoutMs: 15000 }, controlSocket: ctl2Path() });
      await tp.ready;
      const sa = [];
      try {
        const fa = tp.addAgent('fa');
        const fb = tp.addAgent('fb');
        const upHost = `127.0.0.1:${plainUp.port}`;
        const open = async (sockPath, raw) => {
          const s = net.connect(sockPath);
          sa.push(s);
          await once(s, 'connect');
          s.write(raw);
          return s;
        };
        // Both agents park a POST; neither response may arrive yet.
        const sA = await open(fa,
          `POST http://${upHost}/hold HTTP/1.1\r\nHost: ${upHost}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nm=FA1`);
        const rAP = readOneResponse(sA);
        const sB = await open(fb,
          `POST http://${upHost}/hold HTTP/1.1\r\nHost: ${upHost}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nm=FB1`);
        const rBP = readOneResponse(sB);
        const both = await waitFor(() => {
          const p = tp.pending();
          return p.length === 2 ? p : null;
        }, 'both agents to park');
        const gotA = both.find((h) => h.agent === 'fa');
        const gotB = both.find((h) => h.agent === 'fb');
        assert.ok(gotA && /FA1/.test(gotA.body), 'fa hold carries fa');
        assert.ok(gotB && /FB1/.test(gotB.body), 'fb hold carries fb');
        // A free request on fa's door answers while both holds are parked.
        const sF = await open(fa,
          `GET http://${upHost}/?m=free HTTP/1.1\r\nHost: ${upHost}\r\nConnection: close\r\n\r\n`);
        const free = await readOneResponse(sF);
        assert.equal(free.status, 200);
        assert.equal(free.body, 'local-ok');
        assert.equal(tp.pending().length, 2, 'holds still parked');
        assert.equal(await ctl2(`approve ${gotA.id}`), `approved ${gotA.id}`);
        assert.equal(await ctl2(`approve ${gotB.id}`), `approved ${gotB.id}`);
        const rA = await rAP;
        const rB = await rBP;
        assert.equal(rA.status, 200);
        assert.match(rA.body, /FA1/);
        assert.equal(rB.status, 200);
        assert.match(rB.body, /FB1/);
        await waitFor(() => /"agent":"fb"/.test(log()) && /m=FB1/.test(log()),
          'log to name fb');
        assert.match(log(), /"agent":"fa"/);
      } finally {
        for (const s of sa) { try { s.destroy(); } catch {} }
        try { tp.removeAgent('fa'); } catch {}
        try { tp.removeAgent('fb'); } catch {}
        await tp.close();
        try { rmSync(ctl2Path(), { force: true }); } catch {}
      }
    });
});
