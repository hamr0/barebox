// scripts/bench-agents.mjs — proxy memory at 10, 20, 30 and 40 agents.
//
// `npm run bench:agents`. NOT part of `npm test` or CI: it needs a real shell
// with bwrap + unix socket bind + socat, and takes a few minutes. Anywhere
// else it prints a loud SKIP and exits 77 (neither pass nor fail); there are
// no numbers on that path.
//
// Method (PRD M3, "Memory", round 2): per agent count, one FRESH child
// process runs the proxy (`node --expose-gc --max-semi-space-size=1`, the
// CLI's flag; see bench-agents-child.mjs) with the real stack: policy.gateFor
// in auto mode, one gate per agent, the shared gate/audit file, and a real
// loadLabels over a generated folder of 170 operations. A reading is a forced
// GC in the child, then VmRSS of the child pid from /proc, read here.
// Sandboxes (one real `launch` of `sleep` per agent) and every client socket
// live in this parent.
//
// Per agent, all at once: 1 sandbox, 1 parked hold (unlabelled POST, 64 KB
// body), 16 waiting holds (the 18th gets 429, which proves the line is full),
// and the working slot filled (a POST declaring 64 KB with 60 KB sent, so the
// proxy keeps that buffer). Before the readings, 3600 labelled `allow` GETs
// go through the proxy, so gate, matcher, `record` and `annotate` have all run.
//
// Readings per count: idle (agents joined), after 3600 allows, worst case
// held. At 20 agents also a drift check: 7200 more allows, VmRSS again.
// Growth over 1 MB is printed as a FINDING (it does not change the exit code).
// The worst-case reading at 20 therefore comes after 10800 allows (conservative).
//
// Limits: barebox targets small teams. 40 agents per proxy is the maximum
// (enforced by addAgent); above that, run more proxies. The 150 MB proxy
// budget is for the full worst case at 40 agents. Exit 1 when any proxy
// reading at any count (up to 40) exceeds 150 MB, or any walls reading exceeds
// 10 MB. The straight-line fit over the four worst-case points is printed as
// an estimate, with the MB per agent slope; it is not a gate.
import { fork, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../src/launcher.js';
import { bwrapUsable, hasBin } from '../test/fixtures/probes.mjs';
import { canUnix, pidChildren, rssKb, treeRss, waitFor, waitSteady } from './measure.mjs';

const COUNTS = [10, 20, 30, 40];
const DRIFT_AT = 20;
const OPS = 170;
const ALLOWS = 3600;
const DRIFT_MORE = 7200;
const BODY = 65536;
const SENT = 61440; // "about 60 KB" of the working-slot POST
const PER_AGENT = 18; // 1 parked + 16 waiting + the 429
const MAX_SANDBOX_MB = 10;
const MAX_PROXY_MB = 150;
const DRIFT_FINDING_MB = 1;
const SKIP_EXIT = 77;

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const mbOf = (/** @type {number} */ pid) => rssKb(pid) / 1024;

const unixOk = await canUnix();
const why = !bwrapUsable() ? 'needs bwrap on PATH'
  : (!unixOk ? 'unix socket bind blocked here'
    : (!hasBin('socat') ? 'needs socat' : ''));
if (why) {
  console.error(`BENCH SKIPPED (${why}); run in a real shell (exit ${SKIP_EXIT}). No numbers measured, nothing passes.`);
  process.exit(SKIP_EXIT);
}

/** A label folder with OPS operations (every third is a GET), made by the real rwxmap CLI. */
function makeLabels(/** @type {string} */ root) {
  const paths = {};
  for (let i = 0; i < OPS; i++) {
    paths[`/items/{id}/op${i}`] = {
      [i % 3 === 0 ? 'get' : 'post']: {
        operationId: `op${i}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    };
  }
  const spec = path.join(root, 'spec.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'bench', version: '1' },
    servers: [{ url: 'https://api.example.com' }], paths }));
  const out = path.join(root, 'labels');
  mkdirSync(out);
  const cli = path.join(here, '..', 'node_modules', 'rwxmap', 'src', 'cli.js');
  const env = { ...process.env };
  delete env.JEV_KEY; delete env.RWXMAP_JEV_KEY;
  const r = spawnSync(process.execPath, [cli, spec, '-o', out, '--vendor', 'bench'],
    { cwd: root, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`rwxmap failed: ${r.stderr}`);
  if (!/Jev: off/.test(r.stdout + r.stderr)) throw new Error('rwxmap did not report "Jev: off"');
  return out;
}

/**
 * One GET through an agent's socket, absolute-form.
 * @param {http.Agent} agent keep-alive agent @param {string} sock @param {string} url
 * @returns {Promise<number>} status
 */
const getVia = (agent, sock, url) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ socketPath: sock, agent, method: 'GET', path: url, headers: { host: u.host } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
  req.on('error', reject);
  req.end();
});

/** A raw POST head declaring `len` body bytes. */
const head = (/** @type {string} */ tag, /** @type {number} */ len) =>
  `POST http://127.0.0.1:1/${tag} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: ${len}\r\n\r\n`;

/** @param {number} n @param {string} labelsDir @param {number} upstreamPort */
async function runCount(n, labelsDir, upstreamPort) {
  const execArgv = ['--expose-gc', '--max-semi-space-size=1'];
  const host = fork(path.join(here, 'bench-agents-child.mjs'), [], { execArgv });
  let seq = 0;
  const waiting = new Map();
  host.on('message', (/** @type {any} */ m) => { waiting.get(m.id)?.(m); waiting.delete(m.id); });
  host.on('exit', (code) => { if (waiting.size) { console.error(`proxy child exited (${code})`); process.exit(1); } });
  const ask = (/** @type {string} */ cmd, extra = {}) => new Promise((res, rej) => {
    const id = ++seq;
    waiting.set(id, (/** @type {any} */ m) => (m.ok ? res(m) : rej(new Error(m.error))));
    host.send({ id, cmd, ...extra });
  });

  const proj = mkdtempSync(path.join(os.tmpdir(), 'bb-ba-proj-'));
  /** @type {import('node:child_process').ChildProcess[]} */
  const sandboxes = [];
  /** @type {net.Socket[]} */
  const socks = [];
  const agents = [];
  let runtime = '';
  try {
    const init = /** @type {any} */ (await ask('init', { labelsDir, upstreamPort }));
    runtime = init.runtime;
    const pid = /** @type {number} */ (init.pid);
    if (pid !== host.pid) throw new Error('child pid mismatch');
    const audit = path.join(runtime, 'mitm.log');
    const names = Array.from({ length: n }, (_, i) => `b${String(i).padStart(2, '0')}`);
    const sockOf = /** @type {any} */ ((await ask('agents', { names }))).socks;
    for (const name of names) {
      const c = launch({ runtime, agent: name, proj, command: ['sleep', '120'], socket: sockOf[name], caFile: init.caFile });
      c.on('error', () => {});
      sandboxes.push(c);
      agents.push(new http.Agent({ keepAlive: true, maxSockets: 1 }));
    }
    await waitSteady(sandboxes);
    await sleep(1000); // each agent's gate is built by now
    const trees = sandboxes.map((c) => treeRss(c.pid, pidChildren()));
    const walls = trees.map((t) => t.noSleepMb);
    const wallsMax = Math.max(...walls);
    const wallsMean = walls.reduce((a, b) => a + b, 0) / n;

    const reading = async () => { await ask('mem'); return mbOf(pid); };
    const stats = async () => /** @type {any} */ (await ask('stats'));
    const idle = await reading();

    // N labelled GETs spread over the agents, each agent sequential, agents in parallel.
    const allows = async (/** @type {number} */ total) => {
      const before = (await stats()).labelledAllows;
      const each = total / n;
      let bad = 0;
      await Promise.all(names.map(async (name, a) => {
        for (let j = 0; j < each; j++) {
          const op = 3 * ((a + j) % 57); // a GET op (every third of 170)
          const st = await getVia(agents[a], sockOf[name], `http://127.0.0.1:${upstreamPort}/items/${a}-${j}/op${op}`);
          if (st !== 200) bad++;
        }
      }));
      if (bad) throw new Error(`${bad} of ${total} allow requests did not return 200`);
      const got = (await stats()).labelledAllows - before;
      if (got !== total) throw new Error(`gate saw ${got} labelled allows, expected ${total}`);
      // Let the audit writes drain: file size stable for ~0.6 s.
      let last = -1; let stable = 0;
      while (stable < 3) {
        const s = statSync(audit).size;
        stable = s === last ? stable + 1 : 0; last = s;
        await sleep(200);
      }
    };

    await allows(ALLOWS);
    const after3600 = await reading();
    /** @type {{ more: number, after: number } | null} */
    let drift = null;
    if (n === DRIFT_AT) {
      await allows(DRIFT_MORE);
      drift = { more: DRIFT_MORE, after: await reading() };
    }

    // --- the worst case, all agents at once ---
    const body = Buffer.alloc(BODY, 0x61);
    const base = (await stats()).checks;
    const d429 = new Map(names.map((x) => [x, 0]));
    const open = (/** @type {string} */ name, /** @type {(s: string) => void} */ onData) => {
      const s = net.connect(sockOf[name]);
      s.on('error', () => {});
      s.on('data', (c) => onData(c.toString('latin1')));
      socks.push(s);
      return s;
    };
    for (let k = 0; k < n * PER_AGENT; k++) {
      const name = names[k % n];
      const s = open(name, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) d429.set(name, (d429.get(name) ?? 0) + 1); });
      s.write(Buffer.concat([Buffer.from(head(`hold-${k}`, BODY)), body]));
    }
    const delta = async (/** @type {Record<string, number>} */ from) => {
      const now = (await stats()).checks;
      return names.map((x) => (now[x] ?? 0) - (from[x] ?? 0));
    };
    await waitFor(async () => {
      const st = await stats();
      return st.pending === n && [...d429.values()].every((v) => v === 1)
        && (await delta(base)).every((d) => d === PER_AGENT);
    }, `${n} agents to park 1, hold 16 and refuse the ${PER_AGENT}th`, 300000);
    await sleep(500); // every body read has freed its working slot

    // Control: with the slot free, a probe POST reaches the gate (and gets 429: the line is full).
    const afterHolds = (await stats()).checks;
    const got429 = new Array(n).fill(false);
    names.forEach((name, a) => {
      const s = open(name, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) got429[a] = true; });
      s.write(head(`ctl-${a}`, 4) + 'ping');
    });
    await waitFor(async () => got429.every(Boolean) && (await delta(afterHolds)).every((d) => d === 1),
      'the control probes to reach the gate and get 429 (slot free)', 30000);

    // Fill the working slot: declare 64 KB, send 60 KB, withhold the rest.
    const fillers = names.map((name, a) => {
      let r429 = false;
      const s = open(name, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) r429 = true; });
      s.write(Buffer.concat([Buffer.from(head(`fill-${a}`, BODY)), body.subarray(0, SENT)]));
      return { s, got: () => r429 };
    });
    await sleep(1500);
    const worst = await reading();

    // Proof the slot is held: a further body-carrying POST per agent must NOT reach the gate
    // and must get no answer while the filler stalls.
    const afterCtl = (await stats()).checks;
    const probe429 = new Array(n).fill(false);
    names.forEach((name, a) => {
      const s = open(name, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) probe429[a] = true; });
      s.write(head(`probe-${a}`, 4) + 'ping');
    });
    await sleep(2000);
    const blocked = (await delta(afterCtl)).every((d) => d === 0) && !probe429.some(Boolean)
      && !fillers.some((f) => f.got());
    if (!blocked) throw new Error(`working slot NOT held at ${n} agents: a probe reached the gate or got an answer`);
    // And it is the filler that held it: finish the body and both reach the gate.
    for (const f of fillers) f.s.write(body.subarray(SENT));
    await waitFor(async () => probe429.every(Boolean) && fillers.every((f) => f.got())
      && (await delta(afterCtl)).every((d) => d === 2),
    'the stalled filler and the probe to reach the gate once the body completes', 30000);

    return { n, idle, after3600, worst, drift, wallsMean, wallsMax, tools: init.tools };
  } finally {
    for (const s of socks) { try { s.destroy(); } catch {} }
    for (const a of agents) a.destroy();
    for (const c of sandboxes) { try { c.kill('SIGKILL'); } catch {} }
    host.removeAllListeners('exit');
    host.kill('SIGKILL');
    await new Promise((r) => (host.exitCode === null ? host.once('exit', r) : r(null)));
    try { rmSync(proj, { recursive: true, force: true }); } catch {}
    try { if (runtime) rmSync(runtime, { recursive: true, force: true }); } catch {}
  }
}

// --- main ------------------------------------------------------------------
const root = mkdtempSync(path.join(os.tmpdir(), 'bb-ba-'));
// The allow target: a local server that answers every GET (the test fixture is not typechecked).
const srv = http.createServer((_req, res) => { res.end('ok'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
const upstream = { port: /** @type {import('node:net').AddressInfo} */ (srv.address()).port,
  close: () => new Promise((r) => srv.close(r)) };
let exit = 0;
try {
  const labelsDir = makeLabels(root);
  const results = [];
  for (const n of COUNTS) {
    const r = await runCount(n, labelsDir, upstream.port);
    console.error(`  ${n} agents done (worst ${r.worst.toFixed(1)} MB)`);
    results.push(r);
  }

  const f = (/** @type {number} */ v) => v.toFixed(1);
  console.log('');
  console.log(`Proxy VmRSS (MB) after forced GC, own process, \`--max-semi-space-size=1\`; real gates (auto), ${results[0].tools}-key tools table (${OPS} labelled operations).`);
  console.log('');
  console.log('| agents | idle | after 3600 allows | worst case held | walls mean/sandbox | walls max/sandbox |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.n} | ${f(r.idle)} | ${f(r.after3600)} | ${f(r.worst)} | ${f(r.wallsMean)} | ${f(r.wallsMax)} |`);
  }
  const d = results.find((r) => r.drift);
  if (d?.drift) {
    const g = d.drift.after - d.after3600;
    console.log('');
    console.log(`Drift at ${d.n} agents: after 3600 allows ${f(d.after3600)} MB, after ${d.drift.more} more ${f(d.drift.after)} MB (${g >= 0 ? '+' : ''}${f(g)} MB).`);
    if (g > DRIFT_FINDING_MB) console.log(`FINDING: growth ${f(g)} MB over ${d.drift.more} requests exceeds ${DRIFT_FINDING_MB} MB.`);
  }

  // Straight-line least-squares fit of the worst-case reading against the agent count.
  const xs = results.map((r) => r.n); const ys = results.map((r) => r.worst);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const icpt = my - slope * mx;
  console.log('');
  console.log(`Fit (straight line over the four worst-case points, an estimate, not a measurement): ${f(slope)} MB per agent + ${f(icpt)} MB.`);
  const over = [];
  for (const r of results) {
    const m = Math.max(r.idle, r.after3600, r.worst, r.drift?.after ?? 0);
    if (m > MAX_PROXY_MB) over.push(`proxy at ${r.n} agents ${f(m)} MB > ${MAX_PROXY_MB} MB`);
  }
  for (const r of results) if (r.wallsMax > MAX_SANDBOX_MB) over.push(`walls max at ${r.n} agents ${f(r.wallsMax)} MB > ${MAX_SANDBOX_MB} MB`);
  console.log('');
  if (over.length) { console.error(`bench-agents FAIL: ${over.join('; ')}`); exit = 1; }
  else console.log(`bench-agents PASS: proxy under ${MAX_PROXY_MB} MB and walls under ${MAX_SANDBOX_MB} MB at every count up to ${COUNTS[COUNTS.length - 1]} agents.`);
} catch (e) {
  console.error(`bench-agents FATAL: ${e instanceof Error ? e.stack : e}`);
  exit = 1;
} finally {
  await upstream.close().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
process.exit(exit);
