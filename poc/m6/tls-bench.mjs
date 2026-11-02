// poc/m6/tls-bench.mjs — M6 go/no-go POC: proxy memory at 10..40 agents when
// every request rides a live MITM TLS tunnel. A copy of scripts/bench-agents.mjs
// with the original's measurement rules (fresh child per count, forced GC before
// each reading, VmRSS of the child pid, sandboxes in this parent).
// Changes: 10 https hosts h0..h9.test, one secret swapped on every allow, a
// keep-alive TLS tunnel per (agent, host) for the allows, and one CONNECT+TLS
// tunnel per worst-case request. `--plain` runs the original plain-HTTP path;
// `--counts=10,20` picks the counts. Exit 1 on a proxy reading > 175 MB or
// walls > 10 MB (POC FAIL), 77 when the shell cannot run it.
import { fork, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../src/launcher.js';
import { ensureCA, certFor } from '../../src/certs.js';
import { bwrapUsable, hasBin } from '../../test/fixtures/probes.mjs';
import { canUnix, pidChildren, rssKb, treeRss, waitFor, waitSteady } from '../../scripts/measure.mjs';

const TLS = !process.argv.includes('--plain');
const PROD_TRUST = process.argv.includes('--prod-trust'); // NODE_EXTRA_CA_CERTS, no upstreamCa
const CTX_CACHE = process.argv.includes('--ctx-cache'); // POC proxy copy with a per-host MITM context
const countsArg = process.argv.find((a) => a.startsWith('--counts='));
const COUNTS = countsArg ? countsArg.slice(9).split(',').map(Number) : [10, 20, 30, 40];
const HOSTS = Array.from({ length: 10 }, (_, i) => `h${i}.test`);
const SECRET = 'real-bench-secret-value-0123456789';
const DRIFT_AT = TLS ? -1 : 20; // the POC has no drift pass
const OPS = 170;
const ALLOWS = 3600;
const DRIFT_MORE = 7200;
const BODY = 65536;
const SENT = 61440; // "about 60 KB" of the working-slot POST
const PER_AGENT = 18; // 1 parked + 16 waiting + the 429
const MAX_SANDBOX_MB = 10;
const MAX_PROXY_MB = 175;
const DRIFT_FINDING_MB = 1;
const SKIP_EXIT = 77;

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
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
  const cli = path.join(repo, 'node_modules', 'rwxmap', 'src', 'cli.js');
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

let UP_PORT = 0;
/** Client TLS sockets that finished the handshake and are not closed. @type {Set<tls.TLSSocket>} */
const tunnels = new Set();

/**
 * CONNECT `host:UP_PORT` over the agent's unix socket, then a real TLS
 * handshake to it, trusting the proxy's CA. (The port is the upstream's:
 * 443 is privileged. The Host header carries the same port.)
 * @param {string} sockPath @param {string} host @param {string} caPem
 * @returns {Promise<tls.TLSSocket>}
 */
const tunnel = (sockPath, host, caPem) => new Promise((resolve, reject) => {
  const raw = net.connect(sockPath);
  raw.on('error', reject);
  let buf = '';
  const onData = (/** @type {Buffer} */ c) => {
    buf += c.toString('latin1');
    if (!buf.includes('\r\n\r\n')) return;
    raw.off('data', onData);
    if (!/^HTTP\/1\.1 200 /.test(buf)) { raw.destroy(); reject(new Error(`CONNECT ${host}: ${buf.split('\r\n')[0]}`)); return; }
    const t = tls.connect({ socket: raw, servername: host, ca: caPem });
    t.once('error', reject);
    t.once('secureConnect', () => {
      t.on('error', () => {});
      tunnels.add(t);
      t.once('close', () => tunnels.delete(t));
      resolve(t);
    });
  };
  raw.on('data', onData);
  raw.write(`CONNECT ${host}:${UP_PORT} HTTP/1.1\r\nHost: ${host}:${UP_PORT}\r\n\r\n`);
});

/** A raw POST head declaring `len` body bytes, for request number `k`. */
const head = (/** @type {number} */ k, /** @type {string} */ tag, /** @type {number} */ len) => TLS
  ? `POST /${tag} HTTP/1.1\r\nHost: ${HOSTS[k % 10]}:${UP_PORT}\r\nContent-Length: ${len}\r\n\r\n`
  : `POST http://127.0.0.1:1/${tag} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: ${len}\r\n\r\n`;

/** @param {number} n @param {string} labelsDir @param {number} upstreamPort */
async function runCount(n, labelsDir, upstreamPort, upstreamCa, upstreamStats) {
  const execArgv = ['--expose-gc', '--max-semi-space-size=1'];
  const host = fork(path.join(here, 'tls-child.mjs'), CTX_CACHE ? ['--ctx-cache'] : [],
    { execArgv, ...(PROD_TRUST ? { env: { ...process.env, NODE_EXTRA_CA_CERTS: upstreamCa } } : {}) });
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
    const init = /** @type {any} */ (await ask('init', { labelsDir, upstreamPort, upstreamCa: PROD_TRUST ? '' : upstreamCa, secretValue: SECRET, tls: TLS }));
    runtime = init.runtime;
    const pid = /** @type {number} */ (init.pid);
    if (pid !== host.pid) throw new Error('child pid mismatch');
    const audit = path.join(runtime, 'mitm.log');
    const caPem = readFileSync(init.caFile, 'utf8');
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

    /** @type {any} */
    let lastMem = null;
    const reading = async () => { lastMem = await ask('mem'); return mbOf(pid); };
    const stats = async () => /** @type {any} */ (await ask('stats'));
    const idle = await reading();

    // One keep-alive TLS tunnel per (agent, host), made on first use.
    const allowAgents = names.map(() => /** @type {Map<number, http.Agent>} */ (new Map()));
    const agentFor = async (/** @type {number} */ a, /** @type {number} */ h) => {
      let ag = allowAgents[a].get(h);
      if (!ag) {
        const t = await tunnel(sockOf[names[a]], HOSTS[h], caPem);
        ag = new http.Agent({ keepAlive: true, maxSockets: 1 });
        ag.createConnection = () => t;
        allowAgents[a].set(h, ag);
      }
      return ag;
    };
    /** One GET inside the agent's tunnel to host h, with the placeholder as a bearer token. */
    const getTlsVia = (/** @type {http.Agent} */ ag, /** @type {number} */ h, /** @type {string} */ p) => new Promise((resolve, reject) => {
      const req = http.request({ agent: ag, method: 'GET', path: p,
        headers: { host: `${HOSTS[h]}:${UP_PORT}`, authorization: `Bearer ${init.placeholder}` } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end();
    });
    const swapLines = () => readFileSync(audit, 'utf8').split('\n').filter((l) => l.includes('"secret"') && l.includes('"swapped":true')).length;

    // N labelled GETs spread over the agents, each agent sequential, agents in parallel.
    const allows = async (/** @type {number} */ total) => {
      const before = (await stats()).labelledAllows;
      const swapBefore = upstreamStats.swapped;
      const auditBefore = TLS ? swapLines() : 0;
      const each = total / n;
      let bad = 0;
      await Promise.all(names.map(async (name, a) => {
        for (let j = 0; j < each; j++) {
          const op = 3 * ((a + j) % 57); // a GET op (every third of 170)
          let st;
          if (TLS) {
            const h = (a + j) % 10;
            st = await getTlsVia(await agentFor(a, h), h, `/items/${a}-${j}/op${op}`);
          } else {
            st = await getVia(agents[a], sockOf[name], `http://127.0.0.1:${upstreamPort}/items/${a}-${j}/op${op}`);
          }
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
      if (TLS) {
        const swapped = upstreamStats.swapped - swapBefore;
        const audited = swapLines() - auditBefore;
        if (swapped !== total) throw new Error(`upstream saw ${swapped} swapped authorization headers, expected ${total}`);
        if (audited !== total) throw new Error(`audit has ${audited} secret swap lines, expected ${total}`);
        if (upstreamStats.unswapped) throw new Error(`${upstreamStats.unswapped} upstream requests carried an unswapped authorization`);
        swaps += swapped;
      }
    };
    let swaps = 0;

    await allows(ALLOWS);
    const after3600 = await reading();
    const tunnelsAfterAllows = tunnels.size;
    /** @type {{ more: number, after: number } | null} */
    let drift = null;
    if (n === DRIFT_AT) {
      await allows(DRIFT_MORE);
      drift = { more: DRIFT_MORE, after: await reading() };
    }

    // --- the worst case, all agents at once; every request in its OWN tunnel ---
    const body = Buffer.alloc(BODY, 0x61);
    const base = (await stats()).checks;
    const d429 = new Map(names.map((x) => [x, 0]));
    /** A fresh connection for request k: a CONNECT+TLS tunnel (TLS) or the raw unix socket. */
    const open = async (/** @type {string} */ name, /** @type {number} */ k, /** @type {(s: string) => void} */ onData) => {
      const s = TLS ? await tunnel(sockOf[name], HOSTS[k % 10], caPem) : net.connect(sockOf[name]);
      s.on('error', () => {});
      s.on('data', (c) => onData(c.toString('latin1')));
      socks.push(s);
      return s;
    };
    let rk = 0; // request counter: picks the host round-robin
    await Promise.all(Array.from({ length: n * PER_AGENT }, async (_, k) => {
      const name = names[k % n];
      const my = rk++;
      const s = await open(name, my, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) d429.set(name, (d429.get(name) ?? 0) + 1); });
      s.write(Buffer.concat([Buffer.from(head(my, `hold-${k}`, BODY)), body]));
    }));
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
    await Promise.all(names.map(async (name, a) => {
      const my = rk++;
      const s = await open(name, my, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) got429[a] = true; });
      s.write(head(my, `ctl-${a}`, 4) + 'ping');
    }));
    await waitFor(async () => got429.every(Boolean) && (await delta(afterHolds)).every((d) => d === 1),
      'the control probes to reach the gate and get 429 (slot free)', 30000);

    // Fill the working slot: declare 64 KB, send 60 KB, withhold the rest.
    const fillers = await Promise.all(names.map(async (name, a) => {
      let r429 = false;
      const my = rk++;
      const s = await open(name, my, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) r429 = true; });
      s.write(Buffer.concat([Buffer.from(head(my, `fill-${a}`, BODY)), body.subarray(0, SENT)]));
      return { s, got: () => r429 };
    }));
    await sleep(1500);
    const worst = await reading();
    const worstMem = lastMem;
    const tunnelsWorst = tunnels.size;
    if (TLS && tunnelsWorst < n * (PER_AGENT + 2)) throw new Error(`only ${tunnelsWorst} live TLS tunnels at the worst reading, expected at least ${n * (PER_AGENT + 2)}`);

    // Proof the slot is held: a further body-carrying POST per agent must NOT reach the gate
    // and must get no answer while the filler stalls.
    const afterCtl = (await stats()).checks;
    const probe429 = new Array(n).fill(false);
    await Promise.all(names.map(async (name, a) => {
      const my = rk++;
      const s = await open(name, my, (t) => { if (/^HTTP\/1\.1 429 /.test(t)) probe429[a] = true; });
      s.write(head(my, `probe-${a}`, 4) + 'ping');
    }));
    await sleep(2000);
    const blocked = (await delta(afterCtl)).every((d) => d === 0) && !probe429.some(Boolean)
      && !fillers.some((f) => f.got());
    if (!blocked) throw new Error(`working slot NOT held at ${n} agents: a probe reached the gate or got an answer`);
    // And it is the filler that held it: finish the body and both reach the gate.
    for (const f of fillers) f.s.write(body.subarray(SENT));
    await waitFor(async () => probe429.every(Boolean) && fillers.every((f) => f.got())
      && (await delta(afterCtl)).every((d) => d === 2),
    'the stalled filler and the probe to reach the gate once the body completes', 30000);

    return { n, idle, after3600, worst, drift, wallsMean, wallsMax, tools: init.tools,
      tunnelsAfterAllows, tunnelsWorst, swaps, worstMem };
  } finally {
    for (const s of socks) { try { s.destroy(); } catch {} }
    for (const a of agents) a.destroy();
    for (const t of [...tunnels]) { try { t.destroy(); } catch {} }
    for (const c of sandboxes) { try { c.kill('SIGKILL'); } catch {} }
    host.removeAllListeners('exit');
    host.kill('SIGKILL');
    await new Promise((r) => (host.exitCode === null ? host.once('exit', r) : r(null)));
    try { rmSync(proj, { recursive: true, force: true }); } catch {}
    try { if (runtime) rmSync(runtime, { recursive: true, force: true }); } catch {}
  }
}

// --- main ------------------------------------------------------------------
const root = mkdtempSync(path.join(os.tmpdir(), 'bb-m6-'));
// The allow target. TLS: one https server presenting a cert per SNI name, each
// signed by a CA of its own (passed to the proxy as upstreamCa); it records
// whether every authorization header carries the REAL secret (the swap).
// Plain: the original http server.
const upstreamStats = { swapped: 0, unswapped: 0, requests: 0 };
let srv;
let upstreamCa = '';
if (TLS) {
  const caDir = path.join(root, 'upca');
  await ensureCA(caDir);
  upstreamCa = path.join(caDir, 'ca.pem');
  const ctx = new Map();
  for (const h of HOSTS) ctx.set(h, tls.createSecureContext(await certFor(caDir, h)));
  srv = https.createServer({ SNICallback: (name, cb) => cb(null, ctx.get(name) ?? ctx.get(HOSTS[0])) }, (req, res) => {
    upstreamStats.requests++;
    if (req.headers.authorization === `Bearer ${SECRET}`) upstreamStats.swapped++; else upstreamStats.unswapped++;
    res.end('ok');
  });
} else {
  srv = http.createServer((_req, res) => { res.end('ok'); });
}
await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
UP_PORT = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
const upstream = { port: UP_PORT, close: () => new Promise((r) => srv.close(r)) };
let exit = 0;
try {
  const labelsDir = makeLabels(root);
  const results = [];
  for (const n of COUNTS) {
    const r = await runCount(n, labelsDir, upstream.port, upstreamCa, upstreamStats);
    console.error(`  ${n} agents done (worst ${r.worst.toFixed(1)} MB, ${r.tunnelsWorst} live TLS tunnels)`);
    results.push(r);
  }

  const f = (/** @type {number} */ v) => v.toFixed(1);
  const m = (/** @type {number} */ b) => f(b / 1048576);
  console.log('');
  console.log(`M6 POC (${TLS ? 'HTTPS: every request in a MITM TLS tunnel, secret swapped on each allow' : 'plain HTTP, the original path'}). Proxy VmRSS (MB) after forced GC, own process, \`--max-semi-space-size=1\`; real gates (auto), ${results[0].tools}-key tools table.`);
  console.log('');
  console.log('| agents | idle | after 3600 allows | worst case held | walls mean/sandbox | walls max/sandbox | live TLS (after allows / worst) | swaps | external MB (worst) | arrayBuffers MB (worst) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.n} | ${f(r.idle)} | ${f(r.after3600)} | ${f(r.worst)} | ${f(r.wallsMean)} | ${f(r.wallsMax)} | ${r.tunnelsAfterAllows} / ${r.tunnelsWorst} | ${r.swaps} | ${m(r.worstMem.usage.external)} | ${m(r.worstMem.usage.arrayBuffers)} |`);
  }
  const last = results[results.length - 1];
  const u = last.worstMem.usage;
  console.log('');
  console.log(`Breakdown at ${last.n} agents, worst case (child, after GC): rss ${m(u.rss)} MB, heapTotal ${m(u.heapTotal)}, heapUsed ${m(u.heapUsed)}, external ${m(u.external)}, arrayBuffers ${m(u.arrayBuffers)}; rss - heapTotal - external = ${m(u.rss - u.heapTotal - u.external)} MB (code, stacks, malloc/openssl not in external).`);
  console.log(`Minted certs held: ${last.worstMem.mintedCerts} (on disk in the proxy's certs dir; certFor keeps no in-memory cache). Live handles in the child: TLSWRAP ${last.worstMem.tlswrap}, TCPSocketWrap ${last.worstMem.tcpwrap}, PipeWrap ${last.worstMem.pipewrap}.`);
  if (TLS) console.log(`Upstream saw ${upstreamStats.requests} requests: ${upstreamStats.swapped} with the real secret, ${upstreamStats.unswapped} without.`);

  const over = [];
  for (const r of results) {
    const mx = Math.max(r.idle, r.after3600, r.worst, r.drift?.after ?? 0);
    if (mx > MAX_PROXY_MB) over.push(`proxy at ${r.n} agents ${f(mx)} MB > ${MAX_PROXY_MB} MB`);
  }
  for (const r of results) if (r.wallsMax > MAX_SANDBOX_MB) over.push(`walls max at ${r.n} agents ${f(r.wallsMax)} MB > ${MAX_SANDBOX_MB} MB`);
  console.log('');
  if (over.length) { console.error(`POC FAIL: ${over.join('; ')}`); exit = 1; }
  else console.log(`POC PASS: proxy under ${MAX_PROXY_MB} MB and walls under ${MAX_SANDBOX_MB} MB at every count up to ${COUNTS[COUNTS.length - 1]} agents.`);
} catch (e) {
  console.error(`POC FATAL: ${e instanceof Error ? e.stack : e}`);
  exit = 1;
} finally {
  await upstream.close().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
process.exit(exit);
