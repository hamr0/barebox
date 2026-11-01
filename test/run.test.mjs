// run() tests: mode mapping pure (no sandbox), validation, and sandboxed
// runs through onAsk (no files) and through the file channel (answers file).
// Sandboxed runs need bwrap, unix sockets, socat and curl: loud skip
// elsewhere, green in a real shell and CI.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { run } from '../src/run.js';
import { ensureCA, certFor } from '../src/certs.js';
import { claimRuntime, runtimePaths } from '../src/runtime.js';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';
import { setupOverlay } from '../src/overlay.js';
import { startHttp } from './fixtures/upstream.mjs';

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-rprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();
const CAN_RUN = bwrapUsable() && UNIX_OK && hasBin('socat') && hasBin('curl');
const SKIP_WHY = !bwrapUsable() ? 'needs bwrap'
  : (!UNIX_OK ? 'unix socket bind blocked here'
    : (!hasBin('socat') || !hasBin('curl') ? 'needs socat and curl' : ''));

function capture() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { stream, text: () => chunks.join('') };
}

async function waitFor(cond, what, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('run validation (no sandbox needed)', () => {
  it('rejects a missing proj, an empty command, and a bad mode', async () => {
    await assert.rejects(run({}), /proj/);
    await assert.rejects(run({ proj: tmpdir(), command: [] }), /command/);
    await assert.rejects(run({ proj: tmpdir(), command: ['true'], mode: 'nope' }),
      /mode must be ask\|auto\|trust/);
  });

  it('rejects a misshapen onAsk', async () => {
    await assert.rejects(run({ proj: tmpdir(), command: ['true'], onAsk: 'yes' }), /onAsk/);
  });
});

describe('run() closes the proxy when launch throws (no sandbox needed)', () => {
  // The repro: uncommitted overlay changes make launch() throw AFTER the
  // proxy is listening. Pre-fix the throw skipped proxy.close(), and the
  // listening sockets kept the process alive forever (the 6.5h orphan).
  // Setup-independent: the child runs under fixtures/unix-to-tcp.mjs, which
  // redirects unix listens to 127.0.0.1 TCP — the same live-listener shape
  // where unix bind is blocked (this sandbox) as where it works. No
  // process.exit in the child: it ends only when the event loop drains, so
  // a leaked proxy hangs the child and trips the parent timeout.
  it('uncommitted overlay changes reject AND the process exits', { timeout: 60000 }, async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const root = mkdtempSync(join(tmpdir(), 'bb-runleak-'));
    try {
      const proj = join(root, 'proj');
      const rt = join(root, 'rt');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, 'f.txt'), 'x\n');
      setupOverlay({ runtime: rt, agent: 'a', proj });
      writeFileSync(join(rt, 'overlay', 'a', 'upper', 'stray.txt'), 'agent\n');
      const childPath = join(root, 'child.mjs');
      writeFileSync(childPath, [
        `import { run } from ${JSON.stringify(join(testDir, '..', 'src', 'run.js'))};`,
        `await run({ proj: ${JSON.stringify(proj)}, command: ['true'],`,
        `  runtime: ${JSON.stringify(rt)}, agent: 'a', overlay: true }).then(`,
        `  () => { console.log('RESOLVED-UNEXPECTED'); process.exitCode = 1; },`,
        `  (e) => { console.log('REJECTED:' + (e && e.message)); process.exitCode = 2; });`,
        '',
      ].join('\n'));
      const child = spawn(process.execPath,
        ['--import', join(testDir, 'fixtures', 'unix-to-tcp.mjs'), childPath],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const code = await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`run() hung after launch failure (proxy left open): out=${out} err=${err}`));
        }, 20000);
        child.on('error', (e) => { clearTimeout(t); reject(e); });
        child.on('close', (c) => { clearTimeout(t); resolve(c); });
      });
      assert.equal(code, 2, `expected the launch rejection (exit 2), got ${code}: out=${out} err=${err}`);
      assert.match(out, /REJECTED:.*uncommitted/, `the rejection must name the cause: ${out} ${err}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

describe('run() releases the runtime when addAgent throws (no sandbox needed)', () => {
  // No child process: the damage is a leaked runtime claim in-process, not
  // a hung event loop (addAgent throws before any listener exists). The
  // socket folder is a plain file, so ensurePrivateDir throws EEXIST inside
  // addAgent AFTER the proxy claimed the runtime.
  it('a throwing addAgent rejects AND releases the runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-runadd-'));
    try {
      const proj = join(root, 'proj');
      const rt = join(root, 'rt');
      mkdirSync(proj, { recursive: true });
      mkdirSync(rt, { recursive: true });
      writeFileSync(dirname(runtimePaths(rt).socket('a')), 'x');
      await assert.rejects(run({ proj, command: ['true'], runtime: rt, agent: 'a' }), /EEXIST/);
      const release = claimRuntime(rt);
      release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe(`run sandboxed (needs bwrap+unix+socat+curl${SKIP_WHY ? `: ${SKIP_WHY}` : ''})`,
  { skip: CAN_RUN ? false : `run blocked here (${SKIP_WHY}); run in a real shell or CI` }, () => {
  let root, home, proj, plainUp;
  let savedHome;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'bb-r-'));
    home = join(root, 'home'); proj = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'agent.txt'), 'run project\n');
    savedHome = process.env.HOME;
    process.env.HOME = home;
    plainUp = await startHttp();
  });
  after(async () => {
    try {
      await plainUp?.close();
    } finally {
      process.env.HOME = savedHome;
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  // Atomic answer write, exactly like `sbx approve`.
  const answer = (rt, id, obj) => {
    const dir = join(rt, 'answers');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(dir, `${id}.json`));
  };
  const curlHold = (marker) => ['bash', '-c',
    `curl -s --max-time 10 --data m=${marker} http://127.0.0.1:${plainUp.port}/hold`];

  it('a loop answers a parked request through onAsk with no files involved', async () => {
    const rt = join(root, 'rt-onask');
    const out = capture();
    const err = capture();
    let seenAsk = null;
    const res = await run({
      proj, command: curlHold('RUNONASK'), runtime: rt,
      unsafeTestOnly: { allowLoopback: true }, stdout: out.stream, stderr: err.stream,
      onAsk: async (ask) => {
        // Slow on purpose: while parked, no answer file may appear — the
        // decision below must arrive with the answers dir still empty.
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(readdirSync(join(rt, 'answers')).length, 0,
          'onAsk must not need answer files');
        seenAsk = ask;
        return { decision: 'allow' };
      },
    });
    assert.equal(res.exit, 0, err.text());
    assert.match(out.text(), /RUNONASK/);
    assert.ok(seenAsk, 'onAsk saw the ask');
    assert.equal(seenAsk.letter, 'x');
    assert.equal(seenAsk.rule, 'rwx.ask');
    assert.equal(res.asks.length, 1);
    assert.equal(res.asks[0].decision, 'allow');
    assert.match(res.asks[0].url, /\/hold/);
    assert.match(res.asks[0].bodyPreview, /RUNONASK/);
    // Nothing lingered: ask file removed on settle, answers never used.
    assert.deepEqual(readdirSync(join(rt, 'asks')), []);
    assert.deepEqual(readdirSync(join(rt, 'answers')), []);
    assert.ok(existsSync(res.audit), 'audit log path is returned and kept');
  });

  it('without onAsk the file channel decides and asks arrive through events', async () => {
    const rt = join(root, 'rt-file');
    const out = capture();
    const err = capture();
    const pending = run({
      proj, command: curlHold('RUNFILE'), runtime: rt,
      unsafeTestOnly: { allowLoopback: true }, timeoutMs: 15000,
      stdout: out.stream, stderr: err.stream,
    });
    const id = await waitFor(() => {
      let names = [];
      try { names = readdirSync(join(rt, 'asks')); } catch { return null; }
      const f = names.find((n) => n.endsWith('.json'));
      return f ? f.slice(0, -'.json'.length) : null;
    }, 'ask file to appear');
    answer(rt, id, { decision: 'allow' });
    const res = await pending;
    assert.equal(res.exit, 0, err.text());
    assert.match(out.text(), /RUNFILE/);
    assert.equal(res.asks.length, 1);
    assert.equal(res.asks[0].id, id);
    assert.equal(res.asks[0].decision, 'allow');
    assert.match(res.audit && readFileSync(res.audit, 'utf8'), /"verdict":"decide"/);
  });

  it('a held request whose client disconnects ends as deny / client gone in asks', async () => {
    const rt = join(root, 'rt-gone');
    const out = capture();
    const err = capture();
    // curl gives up after 1s while the ask is still unanswered.
    const res = await run({
      proj, runtime: rt, unsafeTestOnly: { allowLoopback: true }, timeoutMs: 15000,
      stdout: out.stream, stderr: err.stream,
      command: ['bash', '-c',
        `curl -s --max-time 1 --data m=RUNGONE http://127.0.0.1:${plainUp.port}/hold; exit 0`],
    });
    assert.equal(res.exit, 0, err.text());
    assert.equal(res.asks.length, 1);
    assert.equal(res.asks[0].decision, 'deny');
    assert.equal(res.asks[0].reason, 'client gone');
    assert.deepEqual(readdirSync(join(rt, 'asks')), []);
  });

  it('heldBodyMaxBytes takes effect: a 64-byte held POST over a 16-byte cap is 403 body too large to hold', { timeout: 60000 }, async () => {
    const rt = join(root, 'rt-bodycap');
    const out = capture();
    const err = capture();
    let asked = 0;
    const res = await run({
      proj, runtime: rt, heldBodyMaxBytes: 16, unsafeTestOnly: { allowLoopback: true }, timeoutMs: 15000,
      stdout: out.stream, stderr: err.stream,
      command: ['bash', '-c',
        `curl -s -w '\\nHTTP:%{http_code}' --max-time 10 --data "$(head -c 64 /dev/zero | tr '\\0' a)" http://127.0.0.1:${plainUp.port}/hold; exit 0`],
      onAsk: async () => { asked++; return { decision: 'allow' }; },
    });
    assert.equal(res.exit, 0, err.text());
    assert.match(out.text(), /body too large to hold/);
    assert.match(out.text(), /HTTP:403/);
    assert.equal(asked, 0, 'an over-cap body is denied at the door, never asked');
  });

  it('a command with no network creates a temp runtime and returns exit 0', async () => {
    const res = await run({ proj, command: ['true'] });
    assert.equal(res.exit, 0);
    assert.deepEqual(res.asks, []);
    assert.ok(existsSync(res.audit), 'audit log exists');
    assert.match(dirname(res.audit), /sbx-/);
    rmSync(dirname(res.audit), { recursive: true, force: true });
  });

  it('the agent process exit code is returned as exit', async () => {
    const res = await run({ proj, command: ['bash', '-c', 'exit 3'] });
    assert.equal(res.exit, 3);
    rmSync(dirname(res.audit), { recursive: true, force: true });
  });
  // M5: keys the agent never holds. The upstream records the headers it gets.
  describe('secrets (M5)', () => {
    const REAL = `sk_test_REAL_${Math.random().toString(36).slice(2)}${Date.now()}`;
    // A real value is swapped only over TLS: the recording upstream is https
    // with a cert from a fixture CA. The proxy under test trusts that CA
    // through the host process (run() in-process: the default CA list; the CLI
    // child: NODE_EXTRA_CA_CERTS); the sandbox trusts the proxy's own CA as always.
    let recUp, seen, fixtureCa, certDir, savedCas;
    before(async () => {
      seen = [];
      certDir = mkdtempSync(join(tmpdir(), 'bb-m5r-'));
      await ensureCA(certDir);
      fixtureCa = join(certDir, 'ca.pem');
      const { key, cert } = await certFor(certDir, '127.0.0.1');
      recUp = https.createServer({ key, cert }, (req, res) => { seen.push({ url: req.url, headers: req.headers }); req.resume(); res.end('upstream-ok'); });
      await new Promise((r) => recUp.listen(0, '127.0.0.1', r));
      savedCas = tls.getCACertificates('default');
      tls.setDefaultCACertificates([...savedCas, readFileSync(fixtureCa, 'utf8')]);
    });
    after(async () => {
      tls.setDefaultCACertificates(savedCas);
      recUp.closeAllConnections?.(); await new Promise((r) => recUp.close(r));
      rmSync(certDir, { recursive: true, force: true });
    });
    const upPort = () => recUp.address().port;
    const curlBearer = (p) => `curl -s --max-time 10 -H "Authorization: Bearer $STRIPE_API_KEY" https://127.0.0.1:${upPort()}${p}`;

    it('run({ secrets, env }): the upstream gets the real value; the inside holds a placeholder and no host variable', async () => {
      seen.length = 0;
      process.env.BB_M5_HOST = `bbhost-${Math.random().toString(36).slice(2)}`;
      const out = capture();
      const err = capture();
      let res;
      try {
        res = await run({
          proj, runtime: join(root, 'rt-secrets'), unsafeTestOnly: { allowLoopback: true },
          secrets: { STRIPE_API_KEY: { value: REAL, hosts: ['127.0.0.1'] } },
          env: { set: { BB_M5_SET: 'set-v' } },
          stdout: out.stream, stderr: err.stream,
          command: ['bash', '-c', `${curlBearer('/lib')}; echo; echo "key=$STRIPE_API_KEY set=$BB_M5_SET host=\${BB_M5_HOST-unset}"`],
        });
      } finally { delete process.env.BB_M5_HOST; }
      assert.equal(res.exit, 0, err.text());
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.authorization, `Bearer ${REAL}`);
      const o = out.text();
      assert.match(o, /upstream-ok/);
      assert.match(o, /key=sbx-ph-[0-9a-f]{16} set=set-v host=unset/);
      assert.ok(!o.includes(REAL) && !err.text().includes(REAL), 'the real value reached the agent');
      const audit = readFileSync(res.audit, 'utf8');
      assert.ok(!audit.includes(REAL), 'the real value is in the audit');
      assert.match(audit, /"verdict":"secret"/);
      assert.match(audit, /"swapped":true/);
    });

    it('run({ secrets }): a secret whose fromEnv variable is missing rejects naming the secret', async () => {
      await assert.rejects(() => run({ proj, command: ['true'], secrets: { NOPE_KEY: { fromEnv: 'BB_M5_NOT_SET', hosts: ['a.test'] } } }),
        (e) => e.message === 'secret NOPE_KEY: no value');
    });

    it('sbx run with a config secret: curl -H "Authorization: Bearer $NAME" inside reaches the bound upstream with the real value', { timeout: 60000 }, async () => {
      seen.length = 0;
      const xdg = join(root, 'xdg-cli');
      mkdirSync(join(xdg, 'barebox'), { recursive: true });
      writeFileSync(join(xdg, 'barebox', 'config.json'), JSON.stringify({
        secrets: { STRIPE_API_KEY: { fromEnv: 'BB_M5_FROM', hosts: ['127.0.0.1'] } },
        env: { pass: ['BB_M5_PASSED'] },
      }));
      const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/cli.js');
      const r = await new Promise((resolve) => {
        execFile('node', [cli, 'run', '--', 'bash', '-c',
          `${curlBearer('/cli')}; echo; echo "key=$STRIPE_API_KEY from=\${BB_M5_FROM-unset} passed=$BB_M5_PASSED"`],
        { cwd: proj, encoding: 'utf8', timeout: 50000,
          env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdg, BB_M5_FROM: REAL, BB_M5_PASSED: 'pass-v',
            SBX_UNSAFE_TEST_ALLOW_LOOPBACK: '1', NODE_EXTRA_CA_CERTS: fixtureCa } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.length, 1, r.stdout + r.stderr);
      assert.equal(seen[0].headers.authorization, `Bearer ${REAL}`);
      assert.match(r.stdout, /key=sbx-ph-[0-9a-f]{16} from=unset passed=pass-v/);
      assert.ok(!r.stdout.includes(REAL) && !r.stderr.includes(REAL), 'the real value reached the terminal');
    });
  });
});
