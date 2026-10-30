// Throwaway POC round 2: proxy in its own child process; parent hosts sandboxes + hold sockets.
// usage: node rss2.mjs [semi]   -> prints table + a JSON line (RESULT {...})
import { fork } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../src/launcher.js';
import { bwrapUsable, hasBin } from '../../test/fixtures/probes.mjs';

const semi = process.argv[2] === 'semi';
const execArgv = semi ? ['--expose-gc', '--max-semi-space-size=1'] : ['--expose-gc'];
if (!bwrapUsable() || !hasBin('socat')) { console.error('SKIPPED: needs bwrap+socat'); process.exit(77); }

const here = path.dirname(fileURLToPath(import.meta.url));
const host = fork(path.join(here, 'proxy-host.mjs'), [], { execArgv });
let seq = 0; const waiting = new Map();
host.on('message', (m) => { waiting.get(m.id)?.(m); waiting.delete(m.id); });
host.on('exit', (c) => { if (waiting.size) { console.error('child exited', c); process.exit(1); } });
const ask = (cmd, extra = {}) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.ok ? res(m) : rej(new Error(m.error))));
  host.send({ id, cmd, ...extra });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await cond(); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error('timeout ' + what); await sleep(50); }
}
const comm = (p) => { try { return readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch { return '?'; } };
function kidsMap() {
  const k = {};
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const m = readFileSync(`/proc/${d}/stat`, 'utf8').match(/^\d+ \(.*\) \S+ (\d+)/); if (m) (k[m[1]] ||= []).push(d); } catch {}
  }
  return k;
}
const vmrssMb = (pid) => +readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m)[1] / 1024;

const rows = [];
let childPid;
const MB = 1024 * 1024;
async function reading(stage, cmd, extra) {
  const r = await ask(cmd, extra);
  const vm = vmrssMb(childPid);
  rows.push({ stage, vm, heapUsed: r.mu.heapUsed / MB, heapTotal: r.mu.heapTotal / MB, ext: (r.mu.external + r.mu.arrayBuffers) / MB, external: r.mu.external / MB, ab: r.mu.arrayBuffers / MB, rss: r.mu.rss / MB });
  return r;
}

const proj = mkdtempSync(path.join(os.tmpdir(), 'bb-rss2-proj-'));
const children = []; const holdSockets = []; let runtimeDir;
try {
  const init = await ask('init');
  childPid = init.pid; runtimeDir = init.runtime;
  if (childPid !== host.pid) throw new Error('pid mismatch');
  await reading('1a baseline idle (gc)', 'mem');
  await reading('1b minted 10 certs (gc)', 'mint');
  const { socks, names } = await ask('agents');
  for (const n of names) {
    const c = launch({ runtime: init.runtime, agent: n, proj, command: ['sleep', '120'], socket: socks[n], caFile: init.caFile });
    c.on('error', () => {}); children.push(c);
  }
  await waitFor(() => {
    const k = kidsMap();
    return children.every((c) => {
      if (!c.pid) return false;
      const set = new Set(); const st = [String(c.pid)];
      while (st.length) { const p = st.pop(); set.add(comm(p)); for (const x of k[p] || []) st.push(x); }
      return set.has('sleep') && !set.has('bash');
    });
  }, 'sandboxes steady');
  await sleep(500);
  const full = new Map(names.map((n) => [n, 0]));
  await waitFor(async () => {
    while (holdSockets.length < 20 * 18) {
      const k = holdSockets.length; const name = names[k % 20];
      const s = net.connect(socks[name]); s.on('error', () => {});
      s.once('data', (c) => { if (/^HTTP\/1\.1 429 /.test(c.toString('latin1'))) full.set(name, full.get(name) + 1); });
      s.write(`POST http://127.0.0.1:1/hold-${k} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 4\r\n\r\nx=${String(k % 100).padStart(2, '0')}`);
      holdSockets.push(s);
    }
    return (await ask('pending')).pending === 20 && [...full.values()].every((v) => v === 1);
  }, '20 parked + 429');
  await reading('1c baseline held (gc)', 'mem');

  await reading('2a + bareguard import', 's2a');
  await reading('2b + 20 gates init', 's2b');
  const o = await reading('2c + 360 check()', 'checkRound');
  console.error('outcomes', JSON.stringify(o.outcomes));
  for (let r = 2; r <= 9; r++) await ask('checkRound');
  await reading('2d + 3600 check() total', 'checkRound');
  await reading('3a + rwxmap import', 's3a');
  const m1 = await reading('3b + 360 matchOperation()', 'matchRound');
  console.error('matched', m1.matched, '/', m1.total);
  for (let r = 2; r <= 9; r++) await ask('matchRound');
  await reading('3c + 3600 match total', 'matchRound');
  await reading('4a + 20 held 64KB bodies', 'bodies', { n: 20 });
  await reading('4b + 100 bodies', 'bodies', { n: 100 });
  await reading('4c + 360 bodies', 'bodies', { n: 360 });
  console.log(`variant: ${semi ? 'node --expose-gc --max-semi-space-size=1' : 'node --expose-gc'}`);
  console.log('| stage | VmRSS MB | delta prev | heapUsed MB | external+arrayBuffers MB |');
  console.log('|---|---|---|---|---|');
  rows.forEach((r, i) => console.log(`| ${r.stage} | ${r.vm.toFixed(1)} | ${i ? (r.vm - rows[i - 1].vm).toFixed(1) : ''} | ${r.heapUsed.toFixed(1)} | ${r.ext.toFixed(1)} |`));
  console.log('RESULT ' + JSON.stringify(rows));
} catch (e) { console.error('FAIL', e); process.exitCode = 1; }
finally {
  for (const s of holdSockets) { try { s.destroy(); } catch {} }
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  host.removeAllListeners('exit'); host.kill('SIGKILL');
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  try { rmSync(proj, { recursive: true, force: true }); } catch {}
}
