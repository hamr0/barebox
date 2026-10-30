// Throwaway POC: the proxy alone in its own process. Driven by rss2.mjs over IPC.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../../src/proxy.js';
import { certFor } from '../../src/certs.js';

const N = 20, OPS = 170, PER_AGENT = 18;
const names = Array.from({ length: N }, (_, i) => `b${String(i).padStart(2, '0')}`);
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

let runtime, proxy, Gate, matchOperation, ops;
const gates = new Map();
const bodies = [];
const holdBodies = (n) => { while (bodies.length < n) bodies.push(Buffer.alloc(65536, bodies.length & 255)); };

const handlers = {
  async init() {
    runtime = mkdtempSync(path.join(os.tmpdir(), 'bb-rss2-rt-'));
    proxy = createProxy({
      runtime, logFile: path.join(runtime, 'mitm.log'), port: 0,
      unsafeTestOnly: { allowLoopback: true },
      hold: { shouldHold: () => 'bench-park', timeoutMs: 'never' },
    });
    await proxy.ready;
    return { runtime, caFile: proxy.caFile, pid: process.pid };
  },
  async mint() {
    const certDir = path.dirname(proxy.caFile);
    for (let i = 0; i < 10; i++) await certFor(certDir, `bench-host-${i}.example`);
  },
  async agents() {
    const socks = {};
    for (const n of names) socks[n] = proxy.addAgent(n);
    return { socks, names };
  },
  async pending() { return { pending: proxy.pending().length }; },
  async mem() {},
  async s2a() { ({ Gate } = await import('bareguard')); },
  async s2b() {
    const tools = { 'http.GET': 'r', 'http.POST': 'w', 'http.DELETE': 'x' };
    opNames.forEach((n, i) => { tools[n] = opLetter(i); });
    const agentsMap = Object.fromEntries(names.map((n) => [n, 'rw-']));
    const auditPath = path.join(runtime, 'bareguard-audit.jsonl');
    for (const name of names) {
      const g = new Gate({
        rwx: { agent: name, agents: agentsMap, tools },
        flags: { cardLike: { true: 'ask' } },
        content: { askPatterns: [/\/(pay|payment|checkout|charge|billing)\b/i] },
        audit: { path: auditPath },
        humanChannel: async () => ({ decision: 'deny' }),
      });
      await g.init();
      gates.set(name, g);
    }
  },
  async checkRound() {
    const outcomes = {};
    for (const a of requests) {
      const d = await gates.get(a.agent).check(a);
      const key = `${d.outcome}${d.rule ? ':' + d.rule : ''}`;
      outcomes[key] = (outcomes[key] || 0) + 1;
    }
    return { outcomes };
  },
  async s3a() { ({ matchOperation } = await import('/home/hamr/PycharmProjects/rwxmap/src/match.js')); },
  async matchRound() {
    ops ??= Array.from({ length: OPS }, (_, i) => ({
      method: opLetter(i) === 'r' ? 'GET' : 'POST', path: `/contacts/{id}/op${i}`, operationId: opNames[i],
    }));
    let matched = 0;
    for (const a of requests) if (matchOperation(ops, ['https://api.example.com/v1'], a.method, a.url)) matched++;
    return { matched, total: requests.length };
  },
  async bodies({ n }) { holdBodies(n); },
  async close() { await proxy?.close(); process.exit(0); },
};

process.on('message', async (m) => {
  try {
    const extra = (await handlers[m.cmd](m)) || {};
    if (m.cmd === 'close') return;
    global.gc();
    const mu = process.memoryUsage();
    process.send({ id: m.id, ok: true, mu: { rss: mu.rss, heapTotal: mu.heapTotal, heapUsed: mu.heapUsed, external: mu.external, arrayBuffers: mu.arrayBuffers }, ...extra });
  } catch (e) {
    process.send({ id: m.id, ok: false, error: String(e && e.stack || e) });
  }
});
