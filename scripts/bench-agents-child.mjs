// scripts/bench-agents-child.mjs — the proxy alone in its own process, for
// bench-agents.mjs. Started with `node --expose-gc --max-semi-space-size=1`
// (the CLI's flag). The parent drives it over IPC; every reply follows a
// forced GC, so the parent's VmRSS read of this pid is a settled number.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../src/proxy.js';
import { loadLabels } from '../src/labels.js';
import { gateFor } from '../src/policy.js';

/** @type {any} */
let proxy;
let runtime = '';
/** Gate checks per agent, and `allow` verdicts on a label-file tool. @type {Record<string, number>} */
const checks = {};
let labelledAllows = 0;
const VENDOR = 'bench';

/** @type {Record<string, (m: any) => Promise<any>>} */
const handlers = {
  async init({ labelsDir, upstreamPort }) {
    runtime = mkdtempSync(path.join(os.tmpdir(), 'bb-ba-rt-'));
    const logFile = path.join(runtime, 'mitm.log');
    const labels = loadLabels({
      labels: [labelsDir], tenants: { [VENDOR]: [`http://127.0.0.1:${upstreamPort}`] },
    });
    proxy = createProxy({
      runtime, logFile, port: 0, labels,
      unsafeTestOnly: { allowLoopback: true },
      // The real policy in auto mode, one gate per agent, the runtime's one
      // tools table and audit file. Only `check` is wrapped, to count.
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
    return { runtime, caFile: proxy.caFile, pid: process.pid, tools: Object.keys(labels.tools).length };
  },
  async agents({ names }) {
    const socks = {};
    for (const n of names) socks[n] = proxy.addAgent(n);
    return { socks };
  },
  async stats() { return { checks: { ...checks }, labelledAllows, pending: proxy.pending().length }; },
  async mem() { return {}; },
  async close() { await proxy?.close(); process.exit(0); },
};

process.on('message', async (/** @type {any} */ m) => {
  try {
    const extra = (await handlers[m.cmd](m)) ?? {};
    global.gc?.();
    process.send?.({ id: m.id, ok: true, ...extra });
  } catch (e) {
    process.send?.({ id: m.id, ok: false, error: String((e && /** @type {Error} */ (e).stack) || e) });
  }
});
