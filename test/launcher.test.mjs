// Launcher tests: validation pure, walls need bwrap (real shell/CI, not sandbox).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { launch, buildCaBundle } from '../src/launcher.js';

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-lprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();
const NEED_SANDBOX = !existsSync('/usr/bin/bwrap') ? 'needs bwrap; run in a real shell or CI'
  : (!UNIX_OK ? 'unix socket bind blocked here; run in a real shell or CI' : false);


function run(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${out}${err}`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('launch validation (no sandbox needed)', () => {
  it('throws on missing inputs', () => {
    assert.throws(() => launch({}), /runtime/);
    assert.throws(() => launch({ runtime: '/x', agent: 'a', proj: '/y', command: [] }), /command/);
  });

  it('rejects bad agent names before touching the filesystem', () => {
    for (const bad of ['../evil', 'UPPER', 'has space', 'a'.repeat(40)]) {
      assert.throws(() => launch({ runtime: '/x', agent: bad, proj: '/y', command: ['true'] }),
        /bad agent name/, JSON.stringify(bad));
    }
  });

  it('refuses a socket that disagrees with <runtime>/socks/<agent>.sock', () => {
    assert.throws(() => launch({ runtime: '/x', agent: 'a', proj: '/y',
      command: ['true'], socket: '/elsewhere.sock' }), /disagrees/);
  });

  it('fails loudly past the ~108-char socket path limit', () => {
    const rt = join(tmpdir(), `bb-long-${'d'.repeat(90)}`);
    assert.throws(() => launch({ runtime: rt, agent: 'agent', proj: '/y', command: ['true'] }),
      /too long \(\d+ > 107\)/);
  });
});

describe('buildCaBundle (no sandbox needed)', () => {
  it('combines system roots with the barebox CA, key never involved', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-ca-'));
    try {
      const caKey = join(root, 'ca.key');
      const caPem = join(root, 'ca.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', caKey, '-out', caPem, '-days', '1', '-subj', '/CN=bb-test-ca'],
        { stdio: 'ignore' });
      const out = buildCaBundle(join(root, 'rt'), caPem);
      const bundle = readFileSync(out, 'utf8');
      const ca = readFileSync(caPem, 'utf8');
      assert.ok(bundle.includes(ca.trim()), 'bundle carries the barebox CA');
      assert.ok(!bundle.includes('PRIVATE KEY'), 'no key material in the bundle');
      if (existsSync('/etc/ssl/certs/ca-certificates.crt')) {
        assert.ok(bundle.length > ca.length, 'system roots are in the bundle too');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('launch walls (needs bwrap)', { skip: NEED_SANDBOX }, () => {
  let root, home, proj, rt;
  let savedHome;
  const servers = [];
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-l-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'secret.txt'), 'x');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'ro.txt'), 'x');
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(async () => {
    for (const s of servers) { s.closeAllConnections?.(); s.close();
      await new Promise((r) => { s.on('close', r); setTimeout(r, 3000); }); }
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  // The agent socket must be listening before launch (documented prerequisite,
  // same as the M0 harness). Returns the collected bytes when asked.
  async function listenSock(agent, collect) {
    const sock = join(rt, 'socks', `${agent}.sock`);
    mkdirSync(join(rt, 'socks'), { recursive: true });
    try { rmSync(sock); } catch {}
    const got = collect ? [] : null;
    // Resume every accepted socket: the door-readiness probes open unix
    // connections that never send data. An accepted-but-paused socket sits
    // in CLOSE_WAIT after the sandbox dies and blocks server 'close' forever.
    const srv = net.createServer((s) => {
      if (got) s.on('data', (c) => got.push(c.toString()));
      else s.resume();
    });
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
    return got;
  }

  it('spawns and exits 0', async () => {
    await listenSock('t0');
    const c = launch({ runtime: rt, agent: 't0', proj, command: ['true'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
  });

  it('masks locked drawers', async () => {
    await listenSock('t1');
    const c = launch({ runtime: rt, agent: 't1', proj,
      command: ['bash', '-c', 'test ! -e "$HOME/.ssh/secret.txt"'] });
    assert.equal((await run(c)).code, 0);
  });

  it('binds project read-only', async () => {
    await listenSock('t2');
    const c = launch({ runtime: rt, agent: 't2', proj,
      command: ['bash', '-c', 'cat "$0/ro.txt" >/dev/null && ! touch "$0/nope" 2>/dev/null', proj] });
    assert.equal((await run(c)).code, 0);
  });

  it('sets the front-door env', async () => {
    await listenSock('t3');
    const c = launch({ runtime: rt, agent: 't3', proj,
      command: ['bash', '-c', '[ "$HTTP_PROXY" = http://127.0.0.1:3128 ]'] });
    assert.equal((await run(c)).code, 0);
  });

  it('has no route out', async () => {
    await listenSock('t4');
    const c = launch({ runtime: rt, agent: 't4', proj,
      command: ['bash', '-c', '! echo > /dev/tcp/192.0.2.1/9 2>/dev/null'] });
    assert.equal((await run(c)).code, 0);
  });

  it('bridges localhost:3128 to the agent socket', async () => {
    const got = await listenSock('t5', true);
    const c = launch({ runtime: rt, agent: 't5', proj,
      command: ['bash', '-c', 'echo marker > /dev/tcp/127.0.0.1/3128'] });
    assert.equal((await run(c)).code, 0);
    const t0 = Date.now();
    while (!/marker/.test(got.join(''))) {
      if (Date.now() - t0 > 10000) throw new Error('timed out waiting for socat bridge delivery');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('sets CA trust env pointing at a readable combined bundle', async () => {
    await listenSock('t6');
    const caDir = join(root, 'ca');
    mkdirSync(caDir, { recursive: true });
    const caPem = join(caDir, 'ca.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(caDir, 'ca.key'), '-out', caPem, '-days', '1',
      '-subj', '/CN=bb-test-ca'], { stdio: 'ignore' });
    const c = launch({ runtime: rt, agent: 't6', proj, caFile: caPem,
      command: ['bash', '-c',
        '[ "$SSL_CERT_FILE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$NODE_EXTRA_CA_CERTS" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$REQUESTS_CA_BUNDLE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$CURL_CA_BUNDLE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$GIT_SSL_CAINFO" = /run/sbx/ca-bundle.pem ] && ' +
        'grep -q "BEGIN CERTIFICATE" "$SSL_CERT_FILE"'] });
    assert.equal((await run(c)).code, 0);
  });

  it('without caFile, no CA trust vars leak in', async () => {
    await listenSock('t7');
    const c = launch({ runtime: rt, agent: 't7', proj,
      command: ['bash', '-c', '[ -z "$SSL_CERT_FILE" ] && [ -z "$CURL_CA_BUNDLE" ]'] });
    assert.equal((await run(c)).code, 0);
  });
});

describe('M0 bypass set: no way out but the front door (needs bwrap)', { skip: NEED_SANDBOX }, () => {
  let root, home, proj, rt;
  let savedHome;
  const servers = [];
  function run(child, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${out}${err}`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
  }
  // Slow negatives are the bug: in a netns without routes curl fails with
  // exit 7 (connect refused/unreachable) or 6 (DNS) in ~15 ms. Exit 28
  // (timeout) means the test waited on something else and must FAIL.
  // Every bypass test below captures `rc=$?` and asserts rc + elapsed.
  function wallReport(out, allowed = [7]) {
    const rc = /rc=(\d+)/.exec(out)?.[1];
    assert.ok(rc !== undefined, `no rc captured in: ${out}`);
    assert.ok(allowed.includes(parseInt(rc, 10)),
      `expected curl exit ${allowed}, got ${rc} (28 = timeout: passing for the wrong reason)`);
    const ms = parseInt(/ms=(\d+)/.exec(out)?.[1] ?? 'NaN', 10);
    assert.ok(ms < 1000, `wall must fail fast, took ${ms}ms: ${out}`);
  }
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-b-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(rt, 'socks'), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(async () => {
    for (const s of servers) { s.closeAllConnections?.(); s.close();
      await new Promise((r) => { s.on('close', r); setTimeout(r, 3000); }); }
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });
  async function listenSock(agent) {
    const sock = join(rt, 'socks', `${agent}.sock`);
    // Resume: probe connections never send data; paused sockets block close.
    const srv = net.createServer((s) => s.resume());
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
  }

  it('direct IP with proxy env unset fails fast with exit 7', async () => {
    await listenSock('b0');
    const c = launch({ runtime: rt, agent: 'b0', proj,
      command: ['bash', '-c',
        'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; ' +
        't0=$(date +%s%N); curl -s --max-time 3 http://192.0.2.1/ -o /dev/null; rc=$?; ' +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('--noproxy * still fails fast with exit 7', async () => {
    await listenSock('b1');
    const c = launch({ runtime: rt, agent: 'b1', proj,
      command: ['bash', '-c',
        't0=$(date +%s%N); curl -s --max-time 3 --noproxy "*" http://192.0.2.1/ -o /dev/null; rc=$?; ' +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('direct to the host loopback fails fast with exit 7 (no proxy env involved)', async () => {
    const hostOnly = net.createServer((s) => s.end('host'));
    await new Promise((r) => hostOnly.listen(0, '127.0.0.1', r));
    servers.push(hostOnly);
    const hp = hostOnly.address().port;
    await listenSock('b2');
    // Direct: unset the front-door env so curl cannot wander into the dummy
    // agent socket (which never answers — that is a timeout, not a wall).
    const c = launch({ runtime: rt, agent: 'b2', proj,
      command: ['bash', '-c',
        'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; ' +
        `t0=$(date +%s%N); curl -s --max-time 3 http://127.0.0.1:${hp}/ -o /dev/null; rc=$?; ` +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('raw TCP out fails too', async () => {
    await listenSock('b3');
    const c = launch({ runtime: rt, agent: 'b3', proj,
      command: ['bash', '-c', '! echo > /dev/tcp/192.0.2.1/9 2>/dev/null'] });
    assert.equal((await run(c)).code, 0);
  });
});
