// --name: namedRuntime (pure paths) and `sbx run|diff|rollback --name`.
// Every env is explicit: never the host's XDG_RUNTIME_DIR or TMPDIR.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { namedRuntime } from '../src/runtime.js';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/cli.js');
const UID = process.getuid();

describe('namedRuntime', () => {
  let root, savedTmp;
  before(() => { root = mkdtempSync('/tmp/bb-nr-'); savedTmp = process.env.TMPDIR; process.env.TMPDIR = root; });
  after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    rmSync(root, { recursive: true, force: true });
  });

  it('without XDG_RUNTIME_DIR: <tmpdir>/sbx-<uid>/<name>, and nothing is created by default', () => {
    const rt = namedRuntime('docs-bot', {});
    assert.equal(rt, join(root, `sbx-${UID}`, 'docs-bot'));
    assert.ok(!existsSync(rt), 'create is off by default');
  });

  it('create:true makes parent and runtime owner-only (0700)', () => {
    const rt = namedRuntime('made', {}, { create: true });
    assert.equal(statSync(rt).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(rt)).mode & 0o777, 0o700);
  });

  it('with XDG_RUNTIME_DIR that is an existing dir you own: <xdg>/barebox/<name>', () => {
    const xdg = mkdtempSync(join(root, 'xdg-'));
    assert.equal(namedRuntime('a1', { XDG_RUNTIME_DIR: xdg }), join(xdg, 'barebox', 'a1'));
  });

  it('an XDG_RUNTIME_DIR that is missing or relative is ignored', () => {
    assert.equal(namedRuntime('a1', { XDG_RUNTIME_DIR: join(root, 'nope') }), join(root, `sbx-${UID}`, 'a1'));
    assert.equal(namedRuntime('a1', { XDG_RUNTIME_DIR: 'rel' }), join(root, `sbx-${UID}`, 'a1'));
  });

  it('a parent we cannot own is refused when creating', { skip: UID === 0 ? 'root owns everything' : false }, () => {
    // /tmp-like dirs are not ours: point TMPDIR's sbx-<uid> parent at a root-owned dir via XDG.
    // /usr is root-owned, so <xdg>/barebox under it cannot be ours; XDG must itself be ours to be used,
    // so reach the foreign case through TMPDIR instead.
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = '/usr';
      assert.throws(() => namedRuntime('x', {}, { create: true }), /EACCES|owned by uid|permission/i);
    } finally { process.env.TMPDIR = saved; }
  });

  it('name rules: bad names throw', () => {
    for (const bad of ['', '../x', 'A', 'a/b', '-a', 'a'.repeat(33)]) {
      assert.throws(() => namedRuntime(bad, {}), /bad agent name/, bad);
    }
  });

  it('a 32-char name fits the 107-byte socket cap; a long TMPDIR is refused with a clear error', () => {
    assert.doesNotThrow(() => namedRuntime('a'.repeat(32), {}));
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = join(root, 'd'.repeat(60));
      assert.throws(() => namedRuntime('a'.repeat(32), {}), /socket path too long.*shorter name or a shorter TMPDIR/);
    } finally { process.env.TMPDIR = saved; }
  });
});

function canUnix() {
  return new Promise((resolve) => {
    const p = join('/tmp', `bb-nprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const CAN_RUN = bwrapUsable() && await canUnix() && hasBin('socat') && hasBin('curl');

describe('sbx --name (CLI)', () => {
  let root, proj, env;
  before(() => {
    root = mkdtempSync('/tmp/bb-nc-');
    proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(proj, 'a.txt'), 'x\n');
    env = { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: join(root, 'tmp') };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const sbx = (args, e = env) => new Promise((resolve) => {
    execFile('node', [CLI, ...args], { cwd: proj, env: e, encoding: 'utf8', timeout: 50000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });

  it('--name with SBX_RUNTIME is a usage error (exit 2), for run and for the others', async () => {
    for (const args of [['pending', '--name', 'n1'], ['run', '--name', 'n1', '--', 'true']]) {
      const r = await sbx(args, { ...env, SBX_RUNTIME: join(root, 'rt') });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /not both/);
    }
  });

  it('commands on a name that never ran create nothing (a typo makes no dir)', async () => {
    const r = await sbx(['pending', '--name', 'typo']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /no sandbox named typo/);
    assert.ok(!existsSync(join(root, 'tmp', `sbx-${UID}`, 'typo')));
  });

  it('a bad name is exit 2', async () => {
    const r = await sbx(['run', '--name', '../x', '--', 'true']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bad agent name/);
  });

  describe('sandboxed', { skip: CAN_RUN ? false : 'needs bwrap, unix sockets, socat, curl' }, () => {
    it('run --name t1 --overlay, a second run is refused naming rollback, then diff and rollback by name', { timeout: 120000 }, async () => {
      const r = await sbx(['run', '--name', 't1', '--overlay', '--', 'bash', '-c', 'echo agent > new.txt']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /sandbox t1 \(answer from another terminal: sbx approve --name t1 <id>\)/);
      assert.match(r.stderr, /sbx diff --name t1/);
      assert.ok(existsSync(join(root, 'tmp', `sbx-${UID}`, 't1')), 'a named runtime persists after the run');

      const again = await sbx(['run', '--name', 't1', '--overlay', '--', 'true']);
      assert.equal(again.code, 1);
      assert.match(again.stderr, /sandbox t1 has uncommitted changes.*sbx commit --name t1.*sbx rollback --name t1/);

      const d = await sbx(['diff', '--name', 't1']);
      assert.match(d.stdout, /A new\.txt/);
      const rb = await sbx(['rollback', '--name', 't1']);
      assert.equal(rb.code, 0, rb.stderr);
      assert.ok(!existsSync(join(proj, 'new.txt')));
      assert.equal((await sbx(['run', '--name', 't1', '--overlay', '--', 'true'])).code, 0, 'after rollback the name is free again');
    });

    it('a second run on a name that is running is refused, naming the sandbox', { timeout: 120000 }, async () => {
      const first = spawn('node', [CLI, 'run', '--name', 't2', '--', 'sleep', '30'], { cwd: proj, env, stdio: 'ignore' });
      try {
        let msg = '';
        const t0 = Date.now();
        while (!/already running/.test(msg) && Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 300));
          msg = (await sbx(['run', '--name', 't2', '--', 'true'])).stderr;
        }
        assert.match(msg, /sandbox t2 is already running \(pid \d+\)/);
      } finally { first.kill('SIGKILL'); }
    });
  });
});
