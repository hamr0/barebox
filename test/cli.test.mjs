// CLI tests: `sbx --help` / usage need no socket; pending/approve/deny run
// against a live proxy and need a unix control socket (loud skip where
// binds are blocked). All children are async — never a sync child against
// the in-process proxy. Same proxy-var scrub as proxy.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createProxy } from '../src/proxy.js';
import { ensureCA, certFor } from '../src/certs.js';
import { startHttps } from './fixtures/upstream.mjs';

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

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-cli-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();

describe('sbx usage (no socket needed)', () => {
  const run = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, SBX_SOCK: join(tmpdir(), 'bb-nowhere.sock'), ...env } });

  it('--help exits 0 without touching the socket', async () => {
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

  it('missing socket fails loud (exit 1), never hangs', async () => {
    const t0 = Date.now();
    const err = await run(['pending']).then(() => null, (e) => e);
    assert.equal(err?.code, 1);
    assert.match(err.stdout, /ctl failed/);
    assert.ok(Date.now() - t0 < 10000, 'must fail fast');
  });
});

describe('sbx cli (needs unix control socket)',
  { skip: UNIX_OK ? false : 'unix socket bind blocked here; run in a real shell or CI' }, () => {
  let RT, CA, tlsUp, proxy, PORT;
  const CTL = join(tmpdir(), `bb-ctl-cli-${process.pid}.sock`);
  const sbx = (...args) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, SBX_SOCK: CTL } });

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
      hold: { match: '/hold', timeoutMs: 5000 }, controlSocket: CTL });
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
    const p = execA('curl', ['-s', '--max-time', '5', '-x', PROXY,
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
    const p = execA('curl', ['-s', '--max-time', '5', '-x', PROXY,
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
