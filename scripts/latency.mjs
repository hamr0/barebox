// scripts/latency.mjs — what does `--max-semi-space-size=1` cost per request?
//
// `node scripts/latency.mjs`. NOT part of `npm test`. It only reports: no
// pass or fail. The proxy runs in a child process (once with the flag, once
// without); the parent sends 2000 allowed plain-HTTP requests through it,
// one at a time over one keep-alive connection, to a local upstream
// (`unsafeTestOnly.allowLoopback`). Prints p50/p95/p99 in ms per variant for
// each of 3 runs; variants alternate so drift hits both alike.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUESTS = 2000;
const WARMUP = 100;
const RUNS = 3;
const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === '--child') {
  // Child: the proxy alone; tells the parent its port, then waits to be killed.
  const { createProxy } = await import('../src/proxy.js');
  const runtime = process.argv[3];
  const proxy = createProxy({
    runtime, logFile: path.join(runtime, 'mitm.log'), port: 0,
    unsafeTestOnly: { allowLoopback: true },
  });
  const { port } = await proxy.ready;
  console.log(`port ${port}`);
  setInterval(() => {}, 1 << 30);
} else {
  await main();
}

/** @param {number[]} sorted ascending @param {number} p percentile @returns {number} */
function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** One GET through the proxy; resolves with its duration in ms. @returns {Promise<number>} */
function timedGet(agent, proxyPort, url) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: proxyPort, agent, path: url, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`status ${res.statusCode}`));
        else resolve(Number(process.hrtime.bigint() - t0) / 1e6);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** One run: spawn the proxy child with `flags`, time the requests, kill it. */
async function measure(flags, upstreamUrl) {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'bb-lat-'));
  const child = spawn(process.execPath, [...flags, SELF, '--child', runtime],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      child.on('error', reject);
      child.on('exit', (c) => reject(new Error(`proxy child exited ${c}`)));
      child.stdout.on('data', (c) => {
        buf += c;
        const m = buf.match(/^port (\d+)/m);
        if (m) resolve(Number(m[1]));
      });
    });
    for (let i = 0; i < WARMUP; i++) await timedGet(agent, port, upstreamUrl);
    const ms = [];
    for (let i = 0; i < REQUESTS; i++) ms.push(await timedGet(agent, port, upstreamUrl));
    ms.sort((a, b) => a - b);
    return { p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99) };
  } finally {
    agent.destroy();
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    rmSync(runtime, { recursive: true, force: true });
  }
}

async function main() {
  const upstream = http.createServer((req, res) => res.end('local-ok'));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (upstream.address()).port}/`;
  const variants = { 'with flag': ['--max-semi-space-size=1'], 'without flag': [] };
  console.log(`${REQUESTS} requests per run (after ${WARMUP} warmup), ${RUNS} runs, ms\n`);
  console.log('| variant | run | p50 | p95 | p99 |\n|---|---|---|---|---|');
  try {
    for (let run = 1; run <= RUNS; run++) {
      for (const [name, flags] of Object.entries(variants)) {
        const r = await measure(flags, url);
        console.log(`| ${name} | ${run} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} |`);
      }
    }
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
}
