// End-to-end: agent in bwrap → proxy → held POST → `sbx approve` → 200.
// Needs bwrap, unix sockets, socat and curl: loud skip elsewhere, green in
// a real shell and CI. This is the only test that proves the product.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { launch } from '../src/launcher.js';
import { createProxy } from '../src/proxy.js';
import { ensureCA, certFor } from '../src/certs.js';
import { startHttps } from './fixtures/upstream.mjs';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';

// test/setup-env.mjs (via --import) already dropped the sandbox's egress proxy
// vars before `node:http` snapshotted them; repeat here so curl children
// inherit a clean env on direct single-file runs too.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}

const execA = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-e2e-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();
const CAN_E2E = bwrapUsable() && UNIX_OK && hasBin('socat') && hasBin('curl');
const SKIP_WHY = !bwrapUsable() ? 'needs bwrap'
  : (!UNIX_OK ? 'unix socket bind blocked here'
    : (!hasBin('socat') || !hasBin('curl') ? 'needs socat and curl' : ''));
describe(`end-to-end (needs bwrap+unix+socat+curl${SKIP_WHY ? `: ${SKIP_WHY}` : ''})`,
  { skip: CAN_E2E ? false : `e2e blocked here (${SKIP_WHY}); run in a real shell or CI` }, () => {
  let root, home, proj, rt, tlsUp, proxy, sock;
  let savedHome;

  function run(child, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${out}${err}`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
  }
  async function waitFor(cond, what, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const log = () => readFileSync(join(rt, 'mitm.log'), 'latin1');
  const sbx = (...args) => execA('node', [join(ROOT, 'src/cli.js'), ...args],
    { encoding: 'latin1', env: { ...process.env, SBX_RUNTIME: rt } });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'agent.txt'), 'e2e project\n');
    savedHome = process.env.HOME;
    process.env.HOME = home;
    await ensureCA(join(rt, 'certs'));
    const kc = await certFor(join(rt, 'certs'), '127.0.0.1');
    tlsUp = await startHttps(kc);
    // allowLoopback is the explicit TEST-ONLY opt-in: the fixture lives on
    // 127.0.0.1, which the default wall denies. Production never passes this.
    proxy = createProxy({ runtime: rt,
      logFile: join(rt, 'mitm.log'), upstreamCa: join(rt, 'certs', 'ca.pem'),
      unsafeTestOnly: { allowLoopback: true },
      hold: { match: '/hold', timeoutMs: 15000, pollMs: 100 } });
    await proxy.ready;
    sock = proxy.addAgent('e2e');
  });
  after(async () => {
    try {
      await proxy?.close();
      await tlsUp?.close();
    } finally {
      process.env.HOME = savedHome;
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('agent curls the fixture through the proxy, logged under its name', async () => {
    const c = launch({ runtime: rt, agent: 'e2e', proj, socket: sock,
      caFile: proxy.caFile,
      command: ['bash', '-c', `curl -s --max-time 10 'https://127.0.0.1:${tlsUp.port}/?m=e2e'`] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'local-ok');
    await waitFor(() => /"agent":"e2e"/.test(log()), 'log line naming agent e2e');
    assert.match(log(), /m=e2e/);
  });

  it('held POST waits for `sbx approve`, then 200', async () => {
    const inner = `curl -s --max-time 12 --data m=E2EHOLD 'https://127.0.0.1:${tlsUp.port}/hold' ` +
      `> /tmp/h.out 2>/tmp/h.err & ` +
      `for i in $(seq 1 60); do [ -s /tmp/h.out ] && break; sleep 0.2; done; cat /tmp/h.out`;
    const c = launch({ runtime: rt, agent: 'e2e', proj, socket: sock,
      caFile: proxy.caFile, command: ['bash', '-c', inner] });
    const done = run(c);
    const held = await waitFor(
      () => proxy.pending().find((h) => {
        try {
          return /E2EHOLD/.test(JSON.parse(readFileSync(join(rt, 'asks', `${h.id}.json`), 'utf8')).bodyPreview);
        } catch { return false; }
      }),
      'E2EHOLD to park');
    assert.equal(held.agent, 'e2e');
    assert.equal((await sbx('approve', held.id)).stdout.trim(), `approved ${held.id}`);
    const r = await done;
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /E2EHOLD/);
  });
});
