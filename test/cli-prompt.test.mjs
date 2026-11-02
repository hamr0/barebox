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
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

    const viaPty = (typed, marker, name) => new Promise((resolve, reject) => {
            const curl = `curl -s -w '\\nHTTP:%{http_code}\\n' --max-time 20 --data m=${marker} http://127.0.0.1:${up.port}/hold`;
      const child = spawn('python3', ['-I', '-c', DRIVER, typed, process.execPath, CLI, 'run', '--name', name, '--', 'bash', '-c', curl], {
        cwd: proj,
        env: { PATH: process.env.PATH, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'),
          TMPDIR: join(root, 'tmp'), SBX_UNSAFE_TEST_ALLOW_LOOPBACK: '1', TERM: 'xterm' },
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
      assert.match(r.out, /Allow\? \[y\/N\] \(h\d+\)  — no answer in 1\d\d s means No/);
      assert.match(r.out, /✓ allowed/);
      assert.match(r.out, /HTTP:200/);
      assert.ok(!/ask h\d/.test(r.out), 'the question replaces the ask line');
      assert.match(r.out, /decided h\d+ allow/);
    });

    it('typing n denies it (403, "denied at the terminal")', { timeout: 60000 }, async () => {
      const r = await viaPty('n\n', 'PTYNO', 'pty-no');
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /✗ denied/);
      assert.match(r.out, /HTTP:403/);
      assert.match(r.out, /denied at the terminal/);
    });
  });
