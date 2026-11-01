// poc/m5/latency.mjs: added latency per request with the swap off, on with 1 secret, on with 10 secrets.
// Same method as scripts/latency.mjs: proxy in a child, 2000 sequential keep-alive GETs to a local upstream, 3 runs, variants interleaved.
// Every request carries `Authorization: Bearer <placeholder of secret 0>` (off: the same literal, nothing to swap).
// No gate (forward-only) so the number is the swap's own cost; run with --gate for the real auto-mode gate in the path.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUESTS = 2000; const WARMUP = 100; const RUNS = 3;
const SELF = fileURLToPath(import.meta.url);
const useGate = process.argv.includes('--gate');

if (process.argv[2] === '--child') {
  const { createProxy } = await import('./src/proxy.js');
  const { gateFor } = await import('./src/policy.js');
  const { loadSecrets } = await import('./swap.mjs');
  const runtime = process.argv[3]; const n = Number(process.argv[4]); const gate = process.argv[5] === 'gate';
  const logFile = path.join(runtime, 'gate.jsonl');
  const secrets = n ? loadSecrets(Object.fromEntries(Array.from({ length: n }, (_, i) => [`KEY_${i}`, { value: `real-${i}-${'x'.repeat(32)}`, hosts: ['127.0.0.1'] }]))) : null;
  const proxy = createProxy({ runtime, logFile, port: 0, ...(secrets ? { secrets } : {}), unsafeTestOnly: { allowLoopback: true },
    ...(gate ? { gateFor: (a, { humanChannel, tools }) => gateFor({ agent: a, mode: 'auto', auditPath: logFile, humanChannel, tools }) } : {}) });
  const { port } = await proxy.ready;
  console.log(`port ${port} ph ${secrets ? secrets[0].placeholder : 'sbx-ph-0000000000000000'}`);
  setInterval(() => {}, 1 << 30);
}

const pct = (s, p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
function timedGet(agent, port, url, auth) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, agent, path: url, method: 'GET', headers: { authorization: auth } }, (res) => {
      res.resume(); res.on('end', () => (res.statusCode !== 200 ? reject(new Error(`status ${res.statusCode}`)) : resolve(Number(process.hrtime.bigint() - t0) / 1e6)));
    });
    req.on('error', reject); req.end();
  });
}
async function measure(n, upstreamUrl) {
  const runtime = mkdtempSync('/tmp/bb5-');
  const child = spawn(process.execPath, [SELF, '--child', runtime, String(n), useGate ? 'gate' : 'nogate'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((res) => child.stdout.on('data', (d) => res(String(d))));
  const [, port, , ph] = line.trim().split(' ');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const auth = `Bearer ${ph}`;
  const t = [];
  for (let i = 0; i < WARMUP + REQUESTS; i++) { const ms = await timedGet(agent, Number(port), upstreamUrl, auth); if (i >= WARMUP) t.push(ms); }
  agent.destroy(); child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); rmSync(runtime, { recursive: true, force: true });
  t.sort((a, b) => a - b);
  return { p50: pct(t, 50), p95: pct(t, 95), p99: pct(t, 99), mean: t.reduce((a, b) => a + b, 0) / t.length };
}
async function main() {
  const seen = { n: 0, auth: new Set() };
  const srv = http.createServer((req, res) => { seen.n++; seen.auth.add(req.headers.authorization?.startsWith('Bearer real-') ? 'real' : 'placeholder'); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  const rows = { 0: [], 1: [], 10: [] };
  for (let r = 0; r < RUNS; r++) for (const n of [0, 1, 10]) rows[n].push(await measure(n, url));
  console.log(`load ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}; gate=${useGate}; upstream saw: ${[...seen.auth].join(',')}`);
  for (const n of [0, 1, 10]) {
    const m = (k) => rows[n].map((x) => x[k].toFixed(3)).join(' / ');
    console.log(`secrets=${n === 0 ? 'off' : n}  p50 ${m('p50')}  p95 ${m('p95')}  p99 ${m('p99')}  mean ${m('mean')}   (ms, runs 1/2/3)`);
  }
  srv.close(); process.exit(0);
}

if (process.argv[2] !== '--child') await main();
