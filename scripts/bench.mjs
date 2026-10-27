// scripts/bench.mjs — go/no-go (c) re-measurement on the rewritten code.
//
// `npm run bench`. NOT part of `npm test` or CI: it needs a real shell with
// bwrap + unix socket bind + socat. Anywhere else it prints a loud SKIP and
// exits 77 (skipped — neither pass nor fail). Never claim numbers from a run
// that skipped: there is no numbers table on that path.
//
// What it measures (thresholds from the PRD):
//   - 20 concurrent agents via proxy.addAgent + launch(), RSS per sandbox
//     from an exact /proc walk of each bwrap PID tree (ppid map built from
//     /proc/*/stat, VmRSS summed from /proc/*/status — the M0 measure.cjs
//     approach; never pgrep -f). Gated metric is the walls overhead per
//     sandbox (whole tree minus the `sleep` payload, exactly the M0
//     "no-sleep" number the 10 MB target was set against); totals print too.
//   - proxy RSS (own process) at three points: idle, after minting certs for
//     10 hosts via certFor (the same path CONNECT uses), and with 20 parked
//     holds.
// Exit 1 when max walls RSS per sandbox exceeds 10 MB or any proxy reading
// exceeds 80 MB. On success prints a markdown numbers table to paste into
// the PRD.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProxy } from '../src/proxy.js';
import { launch } from '../src/launcher.js';
import { certFor } from '../src/certs.js';

const N = 20;
const CERT_HOSTS = 10;
const MAX_SANDBOX_MB = 10;
const MAX_PROXY_MB = 80;
const SKIP_EXIT = 77;

const fail = (msg) => { console.error(`bench FATAL: ${msg}`); process.exit(1); };

function canUnix() {
  return new Promise((resolve) => {
    const p = path.join(os.tmpdir(), `bb-bench-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}

function hasBin(n) {
  try { execFileSync('which', [n], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** Poll `cond` until truthy; throw naming the condition on timeout. */
async function waitFor(cond, what, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`bench: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- exact /proc RSS walk (port of poc/m0/measure.cjs, ESM) ----------------
function pidChildren() {
  /** @type {Record<string, string[]>} */
  const kids = {};
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const m = stat.match(/^\d+ \(.*\) \S+ (\d+)/);
      if (m) (kids[m[1]] = kids[m[1]] || []).push(d);
    } catch { /* raced exit */ }
  }
  return kids;
}

function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
    return m ? +m[1] : 0;
  } catch { return 0; }
}

function comm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?exited'; }
}

const mb = (kb) => kb / 1024;

function treeRss(rootPid, kids) {
  const members = [];
  const stack = [String(rootPid)];
  while (stack.length) {
    const p = stack.pop();
    members.push(p);
    for (const k of kids[p] || []) stack.push(k);
  }
  let total = 0;
  let noSleep = 0;
  const parts = [];
  for (const p of members) {
    const kb = rssKb(p);
    const c = comm(p);
    total += kb;
    if (c !== 'sleep') noSleep += kb;
    parts.push(`${c}=${mb(kb).toFixed(1)}MB`);
  }
  return { procs: members.length, totalMb: mb(total), noSleepMb: mb(noSleep), parts };
}

// --- main ------------------------------------------------------------------
const unixOk = await canUnix();
const why = !readdirSync('/usr/bin').includes('bwrap') ? 'needs bwrap (/usr/bin/bwrap missing)'
  : (!unixOk ? 'unix socket bind blocked here'
    : (!hasBin('socat') ? 'needs socat' : ''));
if (why) {
  console.error(`BENCH SKIPPED (${why}); run in a real shell or CI (exit ${SKIP_EXIT}). No numbers measured, nothing passes.`);
  process.exit(SKIP_EXIT);
}

const runtime = mkdtempSync(path.join(os.tmpdir(), 'bb-bench-rt-'));
const proj = mkdtempSync(path.join(os.tmpdir(), 'bb-bench-proj-'));
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
/** @type {net.Socket[]} */
const holdSockets = [];
let proxy = null;

try {
  proxy = createProxy({
    runtime,
    logFile: path.join(runtime, 'mitm.log'),
    port: 0,
    allowLoopback: true,
    hold: { shouldHold: () => 'bench-park', timeoutMs: 'never' },
  });
  const { port: tcpPort } = await proxy.ready;

  const proxyMb = () => process.memoryUsage().rss() / 1024 / 1024;
  const idleMb = proxyMb();

  const certDir = path.dirname(proxy.caFile);
  for (let i = 0; i < CERT_HOSTS; i++) {
    await certFor(certDir, `bench-host-${i}.example`);
  }
  const mintedMb = proxyMb();

  const names = Array.from({ length: N }, (_, i) => `b${String(i).padStart(2, '0')}`);
  for (const name of names) {
    const sock = proxy.addAgent(name);
    const child = launch({
      runtime, agent: name, proj, command: ['sleep', '120'], socket: sock, caFile: proxy.caFile,
    });
    child.on('error', () => {});
    children.push(child);
  }
  // Every tree settled: bwrap + bash + socat + sleep visible in /proc.
  await waitFor(() => {
    const kids = pidChildren();
    return children.every((c) => c.pid && (kids[String(c.pid)] || []).length > 0) || false;
  }, 'all 20 sandbox trees to fork socat');

  const kids = pidChildren();
  const trees = children.map((c) => treeRss(c.pid, kids));
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    console.log(`sandbox ${names[i]} procs=${t.procs} total=${t.totalMb.toFixed(1)}MB no-sleep=${t.noSleepMb.toFixed(1)}MB [${t.parts.join(' ')}]`);
  }
  const maxNoSleep = Math.max(...trees.map((t) => t.noSleepMb));
  const meanNoSleep = trees.reduce((a, t) => a + t.noSleepMb, 0) / trees.length;

  // 20 parked holds through the TCP door (127.0.0.1 loopback, allowed via
  // allowLoopback): absolute-form POST parks before any forward, so no
  // upstream fixture is needed. Sockets stay open — the holds stay parked.
  await waitFor(() => {
    while (holdSockets.length < N) {
      const i = holdSockets.length;
      const s = net.connect(tcpPort, '127.0.0.1');
      s.on('error', () => {});
      s.write(`POST http://127.0.0.1:1/hold-${i} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 4\r\n\r\nx=${String(i).padStart(2, '0')}`);
      holdSockets.push(s);
    }
    return proxy.pending().length >= N || false;
  }, '20 holds to park');
  const heldMb = proxyMb();

  console.log('');
  console.log('| metric | MB | budget |');
  console.log('|---|---|---|');
  console.log(`| proxy idle | ${idleMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
  console.log(`| proxy after minting ${CERT_HOSTS} certs | ${mintedMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
  console.log(`| proxy with ${N} parked holds | ${heldMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
  console.log(`| per-sandbox walls mean (no \`sleep\`) | ${meanNoSleep.toFixed(1)} | ≤ ${MAX_SANDBOX_MB} |`);
  console.log(`| per-sandbox walls max (no \`sleep\`) | ${maxNoSleep.toFixed(1)} | ≤ ${MAX_SANDBOX_MB} |`);
  console.log('');

  const over = [
    maxNoSleep > MAX_SANDBOX_MB ? `sandbox walls max ${maxNoSleep.toFixed(1)}MB > ${MAX_SANDBOX_MB}MB` : '',
    Math.max(idleMb, mintedMb, heldMb) > MAX_PROXY_MB
      ? `proxy max ${Math.max(idleMb, mintedMb, heldMb).toFixed(1)}MB > ${MAX_PROXY_MB}MB` : '',
  ].filter(Boolean);
  if (over.length) fail(`over budget: ${over.join('; ')}`);
  console.log(`bench PASS: ${N} agents, walls max ${maxNoSleep.toFixed(1)}MB, proxy max ${Math.max(idleMb, mintedMb, heldMb).toFixed(1)}MB`);
} finally {
  for (const s of holdSockets) { try { s.destroy(); } catch {} }
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  try { await proxy?.close(); } catch {}
  try { rmSync(proj, { recursive: true, force: true }); } catch {}
  try { rmSync(runtime, { recursive: true, force: true }); } catch {}
}
