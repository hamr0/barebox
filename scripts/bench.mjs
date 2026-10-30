// scripts/bench.mjs — go/no-go (c) re-measurement on the rewritten code.
//
// `npm run bench`. NOT part of `npm test` or CI: it needs a real shell with
// bwrap + unix socket bind + socat. Anywhere else it prints a loud SKIP and
// exits 77 (skipped — neither pass nor fail). Never claim numbers from a run
// that skipped: there is no numbers table on that path.
//
// What it measures (thresholds from the PRD):
//   - 20 concurrent agents via proxy.addAgent + launch(), RSS per sandbox
//     from an exact /proc walk of each bwrap PID tree (scripts/measure.mjs,
//     shared with bench-agents.mjs; never pgrep -f). Gated metric is the walls overhead per
//     sandbox (whole tree minus the `sleep` payload, exactly the M0
//     "no-sleep" number the 10 MB target was set against); totals print too.
//   - proxy RSS (own process) at three points: idle, after minting certs for
//     10 hosts via certFor (the same path CONNECT uses), and with 20 parked
//     holds.
// Exit 1 when max walls RSS per sandbox exceeds 10 MB or any proxy reading
// exceeds 150 MB. On success prints a markdown numbers table to paste into
// the PRD.
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../src/proxy.js';
import { launch } from '../src/launcher.js';
import { certFor } from '../src/certs.js';
import { canUnix, pidChildren, treeRss, waitFor, waitSteady } from './measure.mjs';
import { bwrapUsable, hasBin } from '../test/fixtures/probes.mjs';

const N = 20;
const CERT_HOSTS = 10;
const MAX_SANDBOX_MB = 10;
const MAX_PROXY_MB = 150;
const SKIP_EXIT = 77;

const fail = (msg) => { console.error(`bench FATAL: ${msg}`); process.exit(1); };

// --- main ------------------------------------------------------------------
const unixOk = await canUnix();
const why = !bwrapUsable() ? 'needs bwrap on PATH'
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
    unsafeTestOnly: { allowLoopback: true },
    // A plain check object: every request asks, so every one parks.
    gateFor: () => ({ check: async () => ({ outcome: 'askHuman', rule: 'bench-park' }) }),
    hold: { timeoutMs: 'never' },
  });
  await proxy.ready;

  const proxyMb = () => process.memoryUsage.rss() / 1024 / 1024;
  const idleMb = proxyMb();

  const certDir = path.dirname(proxy.caFile);
  for (let i = 0; i < CERT_HOSTS; i++) {
    await certFor(certDir, `bench-host-${i}.example`);
  }
  const mintedMb = proxyMb();

  /** @type {Map<string, string>} */
  const sockPaths = new Map();
  const names = Array.from({ length: N }, (_, i) => `b${String(i).padStart(2, '0')}`);
  for (const name of names) {
    const sock = proxy.addAgent(name);
    sockPaths.set(name, sock);
    const child = launch({
      runtime, agent: name, proj, command: ['sleep', '120'], socket: sock, caFile: proxy.caFile,
    });
    child.on('error', () => {});
    children.push(child);
  }
  // Steady state (payload up, transient bash gone) — see waitSteady.
  await waitSteady(children);

  const kids = pidChildren();
  const trees = children.map((c) => treeRss(c.pid, kids));
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    console.log(`sandbox ${names[i]} procs=${t.procs} total=${t.totalMb.toFixed(1)}MB no-sleep=${t.noSleepMb.toFixed(1)}MB [${t.parts.join(' ')}]`);
  }
  const maxNoSleep = Math.max(...trees.map((t) => t.noSleepMb));
  const meanNoSleep = trees.reduce((a, t) => a + t.noSleepMb, 0) / trees.length;

  // Worst case for the hold queue: every agent parks 1 held POST and has 16
  // more waiting unread, and its 18th gets 429. Over each agent's own unix
  // socket (a TCP-door connection is always agent 'tcp'). Absolute-form POST
  // to 127.0.0.1 (allowLoopback) parks before any forward, so no upstream
  // fixture is needed. Sockets stay open — the holds stay parked.
  const PER_AGENT = 18;
  const full = new Map(names.map((n) => [n, 0]));
  await waitFor(() => {
    while (holdSockets.length < N * PER_AGENT) {
      const k = holdSockets.length;
      const name = names[k % N];
      const s = net.connect(/** @type {string} */ (sockPaths.get(name)));
      s.on('error', () => {});
      s.once('data', (c) => { if (/^HTTP\/1\.1 429 /.test(c.toString('latin1'))) full.set(name, (full.get(name) ?? 0) + 1); });
      s.write(`POST http://127.0.0.1:1/hold-${k} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 4\r\n\r\nx=${String(k % 100).padStart(2, '0')}`);
      holdSockets.push(s);
    }
    return (proxy.pending().length === N && [...full.values()].every((v) => v === 1)) || false;
  }, `${N} agents to park 1 and refuse the 18th`);
  const heldMb = proxyMb();

  console.log('');
  console.log('| metric | MB | budget |');
  console.log('|---|---|---|');
  console.log(`| proxy idle | ${idleMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
  console.log(`| proxy after minting ${CERT_HOSTS} certs | ${mintedMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
  console.log(`| proxy with ${N} agents × (1 parked + 16 waiting) | ${heldMb.toFixed(1)} | ≤ ${MAX_PROXY_MB} |`);
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
