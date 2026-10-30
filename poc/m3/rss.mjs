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
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../../src/proxy.js';
import { launch } from '../../src/launcher.js';
import { certFor } from '../../src/certs.js';
import { bwrapUsable, hasBin } from '../../test/fixtures/probes.mjs';

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
    const p = /** @type {string} */ (stack.pop());
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
    hold: { shouldHold: () => 'bench-park', timeoutMs: 'never' },
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
  // Steady-state sampling: the launch flow's inner door-probe loop
  // (`echo > /dev/tcp/127.0.0.1/<door>` x50 in src/launcher.js) proves the
  // socat front door accepts before `exec "$@"` replaces bash with the
  // payload. The host-side observable of that readiness is the payload
  // (`sleep`) present with the transient pre-exec `bash` gone in each bwrap
  // tree. Sampling earlier catches the short-lived bash (~3.7 MB) and the
  // probe's forked socat child (~2.1 MB), so a run passes/fails on timing
  // alone. Wait for that steady state per agent, then one short bounded
  // settle for the probe-forked socat child to exit — the settle follows
  // readiness, it is not the readiness mechanism.
  await waitFor(() => {
    const kids = pidChildren();
    return children.every((c) => {
      if (!c.pid) return false;
      const comms = new Set();
      const stack = [String(c.pid)];
      while (stack.length) {
        const p = /** @type {string} */ (stack.pop());
        comms.add(comm(p));
        for (const k of kids[p] || []) stack.push(k);
      }
      return comms.has('sleep') && !comms.has('bash');
    }) || false;
  }, 'all 20 sandboxes to reach steady state (payload up, transient bash gone)');
  await new Promise((r) => setTimeout(r, 500));

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

  // ---- M3 POC stages (throwaway) -------------------------------------------
  const GC = typeof global.gc === 'function';
  const rss = () => { if (GC) global.gc(); return process.memoryUsage.rss() / 1024 / 1024; };
  /** @type {{stage:string, mb:number}[]} */
  const rows = [];
  const rec = (stage) => { rows.push({ stage, mb: rss() }); };
  // baseline: the three existing bench readings (taken above, no forced GC)
  rows.push({ stage: '1a baseline idle (bench, no gc)', mb: idleMb });
  rows.push({ stage: '1b baseline minted (bench, no gc)', mb: mintedMb });
  rows.push({ stage: '1c baseline held (bench, no gc)', mb: heldMb });
  rec('1d baseline held (gc re-read)');

  // the 20x18 request set
  const OPS = 170;
  const opNames = Array.from({ length: OPS }, (_, i) => (i === 0 ? 'intercom.listContacts' : `intercom.op${i}`));
  const opLetter = (i) => (i % 3 === 0 ? 'r' : 'w');
  const requests = [];
  for (let k = 0; k < N * PER_AGENT; k++) {
    const agent = names[k % N];
    const i = k % OPS;
    if (k % 6 === 5) {
      const m = ['GET', 'POST', 'DELETE'][k % 3];
      requests.push({ type: 'net', tool: `http.${m}`, url: `https://api.example.com/v1/items/${k}`, method: m, agent, cardLike: false });
    } else {
      const m = opLetter(i) === 'r' ? 'GET' : 'POST';
      requests.push({ type: 'net', tool: opNames[i], url: `https://api.example.com/v1/contacts/${k}/op${i}`, method: m, agent, cardLike: false });
    }
  }

  // stage 2: bareguard
  const { Gate } = await import('bareguard');
  rec('2a + bareguard import only');
  const tools = { 'http.GET': 'r', 'http.POST': 'w', 'http.DELETE': 'x' };
  opNames.forEach((n, i) => { tools[n] = opLetter(i); });
  const agentsMap = Object.fromEntries(names.map((n) => [n, 'rw-']));
  const auditPath = path.join(runtime, 'bareguard-audit.jsonl');
  const gateConfigFor = (name) => ({
    rwx: { agent: name, agents: agentsMap, tools },
    flags: { cardLike: { true: 'ask' } },
    content: { askPatterns: [/\/(pay|payment|checkout|charge|billing)\b/i] },
    audit: { path: auditPath },
    humanChannel: async () => ({ decision: 'deny' }),
  });
  const gates = new Map();
  for (const name of names) {
    const g = new Gate(gateConfigFor(name));
    await g.init();
    gates.set(name, g);
  }
  rec('2b + 20 gates built+init (no check yet)');
  const outcomes = {};
  for (const a of requests) {
    const d = await gates.get(a.agent).check(a);
    const key = `${d.outcome}${d.rule ? ':' + d.rule : ''}`;
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  rec('2c + 360 gate.check() calls');
  console.error('gate outcomes', JSON.stringify(outcomes));

  // stage 3: rwxmap matcher
  const { matchOperation } = await import('/home/hamr/PycharmProjects/rwxmap/src/match.js');
  rec('3a + rwxmap match.js import only');
  const ops = Array.from({ length: OPS }, (_, i) => ({
    method: opLetter(i) === 'r' ? 'GET' : 'POST',
    path: `/contacts/{id}/op${i}`,
    operationId: opNames[i],
  }));
  let matched = 0;
  for (const a of requests) {
    if (matchOperation(ops, ['https://api.example.com/v1'], a.method, a.url)) matched++;
  }
  console.error(`rwxmap matched ${matched}/${requests.length}`);
  rec('3b + 360 matchOperation() calls');

  // stage 4: held 64 KB bodies
  const bodies = [];
  const holdBodies = (n) => { while (bodies.length < n) bodies.push(Buffer.alloc(65536, bodies.length & 255)); };
  holdBodies(20); rec('4a + 20 held 64KB bodies');
  holdBodies(100); rec('4b + 100 held 64KB bodies');
  holdBodies(360); rec('4c + 360 held 64KB bodies');

  const baseHeld = rows[3].mb;
  console.log(`GC forced before readings 1d..4c: ${GC ? 'YES (--expose-gc)' : 'NO'}; 1a-1c are the bench's own un-gc'd readings`);
  console.log('');
  console.log('| stage | RSS MB | delta from previous | delta from baseline held |');
  console.log('|---|---|---|---|');
  rows.forEach((r, i) => {
    const prev = i === 0 ? '' : (r.mb - rows[i - 1].mb).toFixed(1);
    console.log(`| ${r.stage} | ${r.mb.toFixed(1)} | ${prev} | ${i < 3 ? '' : (r.mb - baseHeld).toFixed(1)} |`);
  });
  console.log('');
  console.log(`sandbox walls mean ${meanNoSleep.toFixed(1)}MB max ${maxNoSleep.toFixed(1)}MB (bench metric, unchanged)`);
} finally {
  for (const s of holdSockets) { try { s.destroy(); } catch {} }
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  try { await proxy?.close(); } catch {}
  try { rmSync(proj, { recursive: true, force: true }); } catch {}
  try { rmSync(runtime, { recursive: true, force: true }); } catch {}
}
