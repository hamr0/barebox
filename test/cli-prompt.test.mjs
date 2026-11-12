// End to end through a real pty: `sbx run` with a terminal asks in place and
// the typed line decides the held request. python3's pty module plays the
// terminal (util-linux `script` is not on every box; python3 is on CI's
// ubuntu image). Needs bwrap, unix sockets, socat, curl.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';
import { startHttp } from './fixtures/upstream.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/cli.js');

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-pprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();
const CAN_RUN = bwrapUsable() && UNIX_OK && hasBin('socat') && hasBin('curl') && hasBin('python3');

// argv: <line to type once "Allow?" shows> <cmd...>. Prints everything the
// terminal showed; exits with the child's status.
const DRIVER = `
import os, pty, sys, select, time
line = sys.argv[1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
buf = b''; sent = False; end = time.time() + 40
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 4096)
        except OSError: break
        if not d: break
        buf += d
        if not sent and b'Allow?' in buf:
            time.sleep(0.2); os.write(fd, line); sent = True
sys.stdout.write(buf.decode('utf8', 'replace'))
try:
    _, st = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(st))
except ChildProcessError:
    sys.exit(1)
`;

describe(`sbx run asks in the same terminal (needs bwrap+unix+socat+curl+python3${CAN_RUN ? '' : ': not here'})`,
  { skip: CAN_RUN ? false : 'run blocked here; run in a real shell or CI' }, () => {
    let root, proj, up;
    before(async () => {
      root = mkdtempSync(join(tmpdir(), 'bb-pty-'));
      proj = join(root, 'proj');
      mkdirSync(proj, { recursive: true });
      mkdirSync(join(root, 'home'), { recursive: true });
      mkdirSync(join(root, 'xdg'), { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      writeFileSync(join(proj, 'a.txt'), 'x\n');
      up = await startHttp();
    });
    after(async () => {
      await up?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const viaPty = (typed, marker, name, flags = [], extraEnv = { NO_COLOR: '1' }) => new Promise((resolve, reject) => {
      const curl = `curl -s -w '\\nHTTP:%{http_code}\\n' --max-time 20 --data m=${marker} http://127.0.0.1:${up.port}/hold`;
      const child = spawn('python3', ['-I', '-c', DRIVER, typed, process.execPath, CLI, 'run', ...flags, '--name', name, '--', 'bash', '-c', curl], {
        cwd: proj,
        env: { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'),
          TMPDIR: join(root, 'tmp'), SBX_UNSAFE_TEST_ALLOW_LOOPBACK: '1', TERM: 'xterm', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty run hung: ${out}${err}`)); }, 45000);
      child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });

    it('typing y approves the held POST (200) and the process exits', { timeout: 60000 }, async () => {
      const r = await viaPty('y\n', 'PTYYES', 'pty-yes');
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /pty-yes wants to SEND data to 127\.0\.0\.1:\d+/);
      assert.match(r.out, /Data: m=PTYYES/);
      assert.match(r.out, /Allow\? \[y\/N\] \(hold h\d+\)$/m);
      assert.ok(!/means No/.test(r.out), 'the default waits: no countdown');
      assert.match(r.out, /^→ sent ✓ allowed\r?$/m, 'receipt and verdict on one line');
      assert.match(r.out, /HTTP:200/);
      assert.ok(!/ask h\d/.test(r.out), 'the question replaces the ask line');
      assert.ok(!/decided h\d+/.test(r.out), 'the prompt already showed the answer: no plain decided line');
    });

    it('on a terminal with NO_COLOR unset the question is colored; with NO_COLOR=1 there is no escape', { timeout: 120000 }, async () => {
      const on = await viaPty('y\n', 'PTYCOL', 'pty-col', [], {});
      assert.equal(on.code, 0, on.out + on.err);
      assert.ok(on.out.includes('\x1b[1mpty-col\x1b[22m wants to SEND data to'), on.out);
      assert.ok(on.out.includes('\x1b[2m→ sent\x1b[0m \x1b[32m\x1b[1m✓ allowed\x1b[0m'), on.out);
      const off = await viaPty('y\n', 'PTYNOCOL', 'pty-nocol', [], { NO_COLOR: '1' });
      assert.equal(off.code, 0, off.out + off.err);
      assert.ok(!off.out.includes('\x1b'), JSON.stringify(off.out));
    });

    it('typing n denies it (403, "denied at the terminal")', { timeout: 60000 }, async () => {
      const r = await viaPty('n\n', 'PTYNO', 'pty-no');
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /^→ sent ✗ denied\r?$/m, 'receipt and verdict on one line');
      assert.match(r.out, /HTTP:403/);
      assert.match(r.out, /denied at the terminal/);
      assert.ok(!/decided h\d+/.test(r.out), 'the prompt already showed the answer: no plain decided line');
    });

    it('--json never prompts: the ask is a JSON event, and `sbx approve --name` answers it', { timeout: 60000 }, async () => {
      const name = 'pty-json';
      const env = { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), TMPDIR: join(root, 'tmp') };
      const ask = join(root, 'tmp', `sbx-${process.getuid()}`, name, 'asks', 'h1.json');
      const run = viaPty('', 'PTYJSON', name, ['--json']);
      const approver = (async () => {
        const end = Date.now() + 40000;
        while (!existsSync(ask)) {
          if (Date.now() > end) throw new Error('the ask file never appeared');
          await new Promise((r) => setTimeout(r, 100));
        }
        return new Promise((resolve, reject) => {
          execFile(process.execPath, [CLI, 'approve', 'h1', '--name', name], { cwd: proj, env, timeout: 20000 },
            (e, stdout, stderr) => (e ? reject(new Error(`approve failed: ${stderr}`)) : resolve(stdout)));
        });
      })();
      // Settle both so a failed approve cannot leave the run unreaped.
      const [r, a] = await Promise.allSettled([run, approver]);
      assert.equal(a.status, 'fulfilled', String(a.reason));
      assert.equal(r.status, 'fulfilled', String(r.reason));
      const { code, out, err } = r.value;
      assert.equal(code, 0, out + err);
      assert.match(out, /\{"ev":"ask","id":"h1"/);
      assert.ok(!/Allow\?/.test(out), `--json must not prompt: ${out}`);
      assert.match(out, /\{"ev":"decided","id":"h1","decision":"allow"/);
      assert.match(out, /HTTP:200/);
    });

    // Run --json, read the ask file's expiresAt while the hold is open, then deny it.
    const expiryOf = async (name, flags, xdgJson) => {
      const xdg = join(root, 'xdg');
      const cfg = join(xdg, 'barebox', 'config.json');
      if (xdgJson) { mkdirSync(join(xdg, 'barebox'), { recursive: true }); writeFileSync(cfg, xdgJson); }
      try {
        const ask = join(root, 'tmp', `sbx-${process.getuid()}`, name, 'asks', 'h1.json');
        const env = { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: xdg, TMPDIR: join(root, 'tmp') };
        const run = viaPty('', `EXP${name}`, name, ['--json', ...flags]);
        const end = Date.now() + 30000;
        while (!existsSync(ask)) {
          if (Date.now() > end) throw new Error('the ask file never appeared');
          await new Promise((r) => setTimeout(r, 100));
        }
        const rec = JSON.parse(readFileSync(ask, 'utf8'));
        await new Promise((resolve) => execFile(process.execPath, [CLI, 'deny', 'h1', 'test', '--name', name], { cwd: proj, env, timeout: 20000 }, () => resolve()));
        await run;
        return rec.expiresAt;
      } finally {
        rmSync(cfg, { force: true });
      }
    };

    it('--hold 1 denies the held request "hold timeout" in about a second', { timeout: 60000 }, async () => {
      const t0 = Date.now();
      const r = await viaPty('', 'HOLD1', 'pty-hold1', ['--json', '--hold', '1']);
      assert.ok(Date.now() - t0 < 15000, 'fast');
      assert.match(r.out, /\{"ev":"decided","id":"h1","decision":"deny"[^\n]*hold timeout/);
      assert.match(r.out, /HTTP:403/);
    });

    it('no flag and no config key: the hold has no deadline (expiresAt null)', { timeout: 60000 }, async () => {
      assert.equal(await expiryOf('pty-hnone', []), null);
    });

    it('--hold 5 beats a config holdTimeoutSec of 60 (expiresAt about 5 s out)', { timeout: 60000 }, async () => {
      const exp = await expiryOf('pty-h5', ['--hold', '5'], '{"holdTimeoutSec":60}');
      assert.ok(exp, 'has a deadline');
      const left = (Date.parse(exp) - Date.now()) / 1000;
      assert.ok(left < 10, `deadline ${left}s out, not the config 60`);
    });
  });

  describe('sbx run --hold validation (no sandbox needed)', () => {
    it('--hold soon exits 2 and names --hold', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bb-holdbad-'));
      try {
        for (const bad of ['soon', '0', '1.5']) {
          const r = await new Promise((resolve) => execFile(process.execPath, [CLI, 'run', '--hold', bad, '--', 'true'],
            { env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, TMPDIR: dir } }, (e, stdout, stderr) => resolve({ code: e?.code, stderr })));
          assert.equal(r.code, 2, bad);
          assert.match(r.stderr, /--hold/, bad);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
