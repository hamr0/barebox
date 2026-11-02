// poc/m6/tls-child.mjs — the proxy alone in its own process (copy of
// scripts/bench-agents-child.mjs). Changes for M6: tenants are the ten https
// hosts h0..h9.test (or the plain loopback host with tls=false), one secret
// BENCH_KEY bound to those hosts, resolveUpstream maps *.test to 127.0.0.1,
// upstreamCa trusts the upstream's CA, and `mem` reports memoryUsage.
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CACHE = process.argv.includes('--ctx-cache');
const { createProxy } = await import(CACHE ? './proxy-ctxcache.mjs' : '../../src/proxy.js');
import { loadLabels } from '../../src/labels.js';
import { gateFor } from '../../src/policy.js';
import { loadSecrets } from '../../src/secrets.js';

/** @type {any} */
let proxy;
let runtime = '';
/** @type {Record<string, number>} */
const checks = {};
let labelledAllows = 0;
const VENDOR = 'bench';
const HOSTS = Array.from({ length: 10 }, (_, i) => `h${i}.test`);

/** @type {Record<string, (m: any) => Promise<any>>} */
const handlers = {
  async init({ labelsDir, upstreamPort, upstreamCa, secretValue, tls }) {
    runtime = mkdtempSync(path.join(os.tmpdir(), 'bb-m6-rt-'));
    const logFile = path.join(runtime, 'mitm.log');
    const tenants = tls ? HOSTS.map((h) => `https://${h}:${upstreamPort}`) : [`http://127.0.0.1:${upstreamPort}`];
    const labels = loadLabels({ labels: [labelsDir], tenants: { [VENDOR]: tenants } });
    const secrets = tls ? loadSecrets({ BENCH_KEY: { value: secretValue, hosts: HOSTS } }) : [];
    proxy = createProxy({
      runtime, logFile, port: 0, labels, secrets,
      ...(tls && upstreamCa ? { upstreamCa } : {}),
      unsafeTestOnly: {
        allowLoopback: true,
        ...(tls ? { resolveUpstream: async (h) => (/^h\d\.test$/.test(h) ? '127.0.0.1' : null) } : {}),
      },
      gateFor: async (agent, { humanChannel, tools }) => {
        const g = await gateFor({ agent, mode: 'auto', auditPath: logFile, humanChannel, tools });
        const check = g.check.bind(g);
        g.check = async (action) => {
          checks[agent] = (checks[agent] ?? 0) + 1;
          const d = await check(action);
          if (d.outcome === 'allow' && String(action.tool).startsWith(`${VENDOR}.`)) labelledAllows++;
          return d;
        };
        return g;
      },
      hold: { timeoutMs: 'never' },
    });
    await proxy.ready;
    return { runtime, caFile: proxy.caFile, pid: process.pid, tools: Object.keys(labels.tools).length,
      placeholder: secrets[0]?.placeholder ?? '' };
  },
  async agents({ names }) {
    const socks = {};
    for (const n of names) socks[n] = proxy.addAgent(n);
    return { socks };
  },
  async stats() { return { checks: { ...checks }, labelledAllows, pending: proxy.pending().length }; },
  async mem() { return {}; }, // the details are read after the GC, below
  async close() { await proxy?.close(); process.exit(0); },
};

function details() {
  const certs = readdirSync(path.dirname(proxy.caFile)).filter((f) => f.endsWith('.pem') && f !== 'ca.pem');
  const res = process.getActiveResourcesInfo();
  const count = (/** @type {string} */ k) => res.filter((r) => r === k).length;
  return { usage: process.memoryUsage(), mintedCerts: certs.length,
    tlswrap: count('TLSWRAP'), tcpwrap: count('TCPSocketWrap'), pipewrap: count('PipeWrap') };
}

process.on('message', async (/** @type {any} */ m) => {
  try {
    const extra = (await handlers[m.cmd](m)) ?? {};
    global.gc?.();
    // `mem` is read after the GC so the numbers are settled.
    const after = m.cmd === 'mem' ? details() : {};
    process.send?.({ id: m.id, ok: true, ...extra, ...after });
  } catch (e) {
    process.send?.({ id: m.id, ok: false, error: String((e && /** @type {Error} */ (e).stack) || e) });
  }
});
