// CLI tests: `sbx --help` / usage need no runtime; pending/approve/deny run
// against a live proxy through the file channel (`SBX_RUNTIME/asks` +
// `SBX_RUNTIME/answers`), no unix socket involved. All children are async —
// never a sync child against the in-process proxy. Same proxy-var scrub as
// proxy.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createProxy } from '../src/proxy.js';
import { ensureCA, certFor } from '../src/certs.js';
import { startHttps, startHttp } from './fixtures/upstream.mjs';

// test/setup-env.mjs (via --import) already dropped the sandbox's egress proxy
// vars before `node:http` snapshotted them; repeat here so curl children
// inherit a clean env on direct single-file runs too.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}

const execA = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/cli.js');

describe('sbx usage (no runtime needed)', () => {
  const run = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, ...env } });

  it('--help exits 0', async () => {
    const r = await run(['--help']);
    assert.match(r.stdout, /usage: sbx/);
  });

  it('no command is a usage error (exit 2)', async () => {
    const err = await run([]).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.match(err.stdout, /usage: sbx/);
  });

  it('unknown command is a usage error (exit 2)', async () => {
    const err = await run(['frobnicate']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });

  it('SBX_SOCK is rejected (exit 2): the control socket is gone', async () => {
    const err = await run(['pending'],
      { SBX_SOCK: join(tmpdir(), 'bb-nowhere.sock') }).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.match(err.stdout, /no longer supported/);
  });

  it('missing SBX_RUNTIME is a usage error (exit 2)', async () => {
    const env = { ...process.env };
    delete env.SBX_SOCK;
    delete env.SBX_RUNTIME;
    const err = await execA('node', [CLI, 'pending'],
      { encoding: 'latin1', env }).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.match(err.stdout, /usage: sbx/);
  });

  it('pending on an empty runtime prints nothing held (exit 0)', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-c-empty-'));
    try {
      const env = { ...process.env };
      delete env.SBX_SOCK;
      env.SBX_RUNTIME = rt;
      const r = await execA('node', [CLI, 'pending'],
        { encoding: 'latin1', env });
      assert.equal(r.stdout.trim(), 'nothing held');
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });
});

describe('sbx cli over the file channel', () => {
  let RT, CA, tlsUp, proxy, PORT;
  const sbx = (...args) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, SBX_RUNTIME: RT } });

  async function waitFor(cond, what, timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  before(async () => {
    RT = mkdtempSync(join(tmpdir(), 'bb-c-'));
    await ensureCA(join(RT, 'certs'));
    const kc = await certFor(join(RT, 'certs'), '127.0.0.1');
    CA = join(RT, 'certs', 'ca.pem');
    tlsUp = await startHttps(kc);
    proxy = createProxy({ port: 0, certDir: join(RT, 'certs'),
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
      clientIdleMs: 500, allowLoopback: true,
      hold: { match: '/hold', timeoutMs: 30000, pollMs: 25 } });
    ({ port: PORT } = await proxy.ready);
  });
  after(async () => {
    try {
      await proxy?.close();
      await tlsUp?.close();
    } finally {
      if (RT) rmSync(RT, { recursive: true, force: true });
    }
  });

  it('pending lists a parked request with its agent, approve releases it', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    const p = execA('curl', ['-s', '--max-time', '30', '-x', PROXY,
      '--cacert', CA, '--data', 'm=CLITEST', `${tlsUp.url}hold`],
      { encoding: 'latin1' });
    await waitFor(async () => (await sbx('pending')).stdout.includes('CLITEST'),
      'sbx pending to list CLITEST');
    const out = (await sbx('pending')).stdout;
    const id = out.split(' ')[0];
    assert.match(out, new RegExp(`${id} tcp POST`));
    assert.equal((await sbx('approve', id)).stdout.trim(), `approved ${id}`);
    assert.match((await p).stdout, /CLITEST/);
    assert.equal((await sbx('pending')).stdout.trim(), 'nothing held');
  });

  it('deny carries the reason', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    const p = execA('curl', ['-s', '--max-time', '30', '-x', PROXY,
      '--cacert', CA, '--data', 'm=CLIDENY', `${tlsUp.url}hold`],
      { encoding: 'latin1' });
    await waitFor(async () => (await sbx('pending')).stdout.includes('CLIDENY'),
      'sbx pending to list CLIDENY');
    const id = (await sbx('pending')).stdout.split(' ')[0];
    assert.equal((await sbx('deny', id, 'nope')).stdout.trim(), `denied ${id}`);
    assert.match((await p).stdout, /denied: nope/);
  });

  it('approve of an unknown id exits 1', async () => {
    const err = await sbx('approve', 'h9999').then(() => null, (e) => e);
    assert.equal(err?.code, 1);
    assert.match(err.stdout, /unknown h9999/);
  });

  it('log lines name the agent', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    await execA('curl', ['-s', '--max-time', '5', '-x', PROXY,
      '--cacert', CA, `${tlsUp.url}?m=clilog`], { encoding: 'latin1' });
    const log = readFileSync(join(RT, 'mitm.log'), 'latin1');
    assert.match(log, /"agent":"tcp"/);
    assert.doesNotMatch(log, /"client":"c\d+"/);
  });
});

describe('sbx run usage (no sandbox needed)', () => {
  const runCli = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, ...env } });

  it('run --help names the run form', async () => {
    const r = await runCli(['--help']);
    assert.match(r.stdout, /run \[--mode/);
  });

  it('run without -- is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--mode', 'auto']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
    assert.match(err.stdout, /usage: sbx/);
  });

  it('run with a bad mode is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--mode', 'nope', '--', 'true']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });

  it('run with no command after -- is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });
});

describe('sbx run sandboxed (needs bwrap+unix+socat+curl)', () => {
  let root, home, proj, rt, plainUp;
  let CAN_RUN = false;
  let SKIP_WHY = '';

  function hasBin(n) {
    try { execFileSync('which', [n], { stdio: 'ignore' }); return true; }
    catch { return false; }
  }

  before(async () => {
    const p = join(tmpdir(), `bb-crprobe-${process.pid}.sock`);
    const unixOk = await new Promise((resolve) => {
      const s = net.createServer();
      s.on('error', () => resolve(false));
      s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
    });
    if (!existsSync('/usr/bin/bwrap')) SKIP_WHY = 'needs bwrap';
    else if (!unixOk) SKIP_WHY = 'unix socket bind blocked here';
    else if (!hasBin('socat') || !hasBin('curl')) SKIP_WHY = 'needs socat and curl';
    else CAN_RUN = true;
    if (!CAN_RUN) return;
    root = mkdtempSync(join(tmpdir(), 'bb-cr-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    mkdirSync(rt, { recursive: true });
    writeFileSync(join(proj, 'agent.txt'), 'cli run project\n');
    plainUp = await startHttp();
  });
  after(async () => {
    try {
      await plainUp?.close();
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  // t.skip() marks but does not abort: callers must `return` when this is true.
  const skipIfBlocked = (t) => {
    if (!CAN_RUN) {
      t.skip(`sbx run blocked here (${SKIP_WHY}); run in a real shell or CI`);
      return true;
    }
    return false;
  };

  async function waitFor(cond, what, timeoutMs = 20000) {
    const t0 = Date.now();
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Atomic answer write, exactly like `sbx approve`.
  const answer = (id, obj) => {
    const dir = join(rt, 'answers');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(dir, `${id}.json`));
  };

  // Spawn `sbx run` against the fixture; the sandbox's project is `proj`.
  function spawnRun(extraArgs, command) {
    const child = spawn('node', [CLI, 'run', ...extraArgs, '--', ...command], {
      cwd: proj,
      env: { ...process.env, HOME: home, SBX_RUNTIME: rt, SBX_ALLOW_LOOPBACK: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const closed = new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`sbx run timeout: out=${out} err=${err}`)); }, 45000);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    return { child, out: () => out, err: () => err, closed };
  }

  it('--json emits an ask line then a done line with the agent exit code', async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'auto', '--json'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIJSON http://127.0.0.1:${plainUp.port}/hold >/dev/null; exit 3`]);
    const id = await waitFor(() => {
      const m = /"ev":"ask","id":"(h\d+)"/.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'allow' });
    const code = await r.closed;
    assert.equal(code, 3, `stderr: ${r.err()}`);
    const lines = r.out().trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, `stdout must carry exactly ask+done: ${r.out()}`);
    assert.equal(lines[0].ev, 'ask');
    assert.match(lines[0].url, /\/hold/);
    assert.deepEqual(lines[1], { ev: 'done', exit: 3 });
  });

  it('human mode prints ask and done lines and mirrors the exit code', async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'auto'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIHUMAN http://127.0.0.1:${plainUp.port}/hold`]);
    const id = await waitFor(() => {
      const m = /ask (h\d+) /.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'allow' });
    const code = await r.closed;
    assert.equal(code, 0, `stderr: ${r.err()}`);
    assert.match(r.out(), new RegExp(`ask ${id} .*POST.*/hold`));
    assert.match(r.out(), /done exit 0/);
  });
});
