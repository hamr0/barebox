// M3 B2a: API labels and model endpoints. Label files come from the real
// rwxmap CLI (Jev off, no network) run in a temp dir. Gate decisions use the
// real policy gates; the socket test rides the real proxy with its own timeout.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabels } from '../src/labels.js';
import { buildTools, toolFor, gateFor as policyGate, emptyMatcher } from '../src/policy.js';
import { createProxy } from '../src/proxy.js';
import { runtimePaths } from '../src/runtime.js';
import { startHttp } from './fixtures/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, 'fixtures', 'jira-mini.json');
const RWXMAP = join(HERE, '..', 'node_modules', 'rwxmap', 'src', 'cli.js');
const ISSUE = 'https://acme.atlassian.net/rest/api/3/issue/ABC-1';
const TENANTS = { jira: ['https://acme.atlassian.net'] };

let root, base, n = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'bb-lbl-'));
  base = join(root, 'base');
  mkdirSync(base);
  const r = spawnSync(process.execPath, [RWXMAP, SPEC, '-o', base, '--vendor', 'jira'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, JEV_KEY: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /Jev: off/);
});
after(() => { rmSync(root, { recursive: true, force: true }); });

/** A fresh copy of the generated label folder. @returns {string} */
function copyLabels() {
  const d = join(root, `l${n++}`);
  cpSync(base, d, { recursive: true });
  return d;
}
const gateFile = (d) => join(d, 'jira.rwxmap.json');
const reviewFile = (d) => join(d, 'jira.rwxmap.review.json');
const editJson = (f, fn) => { const j = JSON.parse(readFileSync(f, 'utf8')); fn(j); writeFileSync(f, JSON.stringify(j)); };

/** One gate decision for a request, through the real policy gate. @returns {Promise<{tool: string, outcome: 'allow'|'deny'|'ask', rule?: string}>} `ask` means the gate asked the human */
async function decide({ mode, labels, localLlm = [], method, url }) {
  const tools = buildTools(labels?.tools, localLlm);
  const tool = toolFor(labels?.matcher ?? emptyMatcher, tools, method, url);
  const asks = [];
  const gate = await policyGate({ agent: 'a', mode,
    humanChannel: async (e) => { asks.push(e.rule); return { decision: 'deny', reason: 'asked' }; },
    auditPath: join(root, `audit-${n++}.jsonl`), tools });
  const d = await gate.check({ type: 'net', tool, url, method, agent: 'a' });
  return { tool, outcome: asks.length ? 'ask' : d.outcome, rule: asks[0] ?? d.rule };
}

describe('loadLabels', () => {
  it('throws on a missing gate file, a folder with no review file, and an unreadable folder', () => {
    const d = copyLabels();
    rmSync(gateFile(d));
    assert.throws(() => loadLabels({ labels: [d] }),
      (e) => e.message.includes(reviewFile(d)) && e.message.includes(gateFile(d)));
    const empty = join(root, 'empty'); mkdirSync(empty);
    assert.throws(() => loadLabels({ labels: [empty] }), (e) => e.message.includes(empty));
  });

  it('throws on a pre-0.8.0 sidecar, naming rwxmap\'s message and the path', () => {
    const d = copyLabels();
    editJson(reviewFile(d), (j) => { delete j.servers; });
    assert.throws(() => loadLabels({ labels: [d] }),
      (e) => e.message.includes(reviewFile(d)) && /0\.8\.0/.test(e.message));
  });

  it('throws on a duplicate key across vendors', () => {
    const a = copyLabels(); const b = copyLabels();
    editJson(reviewFile(b), (j) => { j.vendor = 'jira2'; });
    writeFileSync(join(b, 'jira2.rwxmap.review.json'), readFileSync(reviewFile(b)));
    writeFileSync(join(b, 'jira2.rwxmap.json'), readFileSync(gateFile(b)));
    rmSync(reviewFile(b)); rmSync(gateFile(b));
    assert.throws(() => loadLabels({ labels: [a, b] }), /is also defined in/);
  });

  it('throws on a tenants vendor that no folder defines', () => {
    assert.throws(() => loadLabels({ labels: [copyLabels()], tenants: { ghost: ['https://a.b'] } }),
      /ghost/);
  });

  it('keeps the gate file\'s tools and expands ~/', () => {
    const d = copyLabels();
    const l = loadLabels({ labels: [d], tenants: TENANTS });
    assert.equal(l.tools['jira.editIssue'].letter, 'w');
    assert.deepEqual(l.dirs, [d]);
    const home = join(root, 'home'); mkdirSync(home);
    cpSync(base, join(home, 'lab'), { recursive: true });
    assert.equal(loadLabels({ labels: ['~/lab'] }, { HOME: home }).dirs[0], join(home, 'lab'));
  });
});

describe('the tool for a request', () => {
  it('a tenant URL gives jira.editIssue; without the tenant it is http.PUT', async () => {
    const d = copyLabels();
    const withT = loadLabels({ labels: [d], tenants: TENANTS });
    const tools = buildTools(withT.tools);
    assert.equal(toolFor(withT.matcher, tools, 'PUT', ISSUE), 'jira.editIssue');
    const noT = loadLabels({ labels: [d] });
    assert.equal(toolFor(noT.matcher, buildTools(noT.tools), 'PUT', ISSUE), 'http.PUT');
    assert.equal(toolFor(noT.matcher, tools, 'PUT', 'ftp://x/y'), 'http.PUT');
  });

  it('the gate file wins: a letter edited to "x" asks in auto, the original w passes', async () => {
    const d = copyLabels();
    const orig = await decide({ mode: 'auto', labels: loadLabels({ labels: [d], tenants: TENANTS }),
      method: 'PUT', url: ISSUE });
    assert.deepEqual([orig.tool, orig.outcome], ['jira.editIssue', 'allow']);
    editJson(gateFile(d), (j) => { j.bareguard.tools['jira.editIssue'] = 'x'; });
    const edited = await decide({ mode: 'auto', labels: loadLabels({ labels: [d], tenants: TENANTS }),
      method: 'PUT', url: ISSUE });
    assert.deepEqual([edited.tool, edited.outcome], ['jira.editIssue', 'ask']);
  });

  it('model endpoints are r: pass in ask mode; an unknown path on the same host asks', async () => {
    const q = (method, url) => decide({ mode: 'ask', localLlm: ['localhost:11434'], method, url });
    for (const [m, u] of [['POST', 'https://api.anthropic.com/v1/messages'],
      ['POST', 'https://api.openai.com/v1/chat/completions?x=1'],
      ['POST', 'http://localhost:11434/api/chat']]) {
      const d = await q(m, u);
      assert.equal(d.outcome, 'allow', `${u}: ${d.tool}`);
    }
    const other = await q('POST', 'https://api.anthropic.com/v1/other');
    assert.deepEqual([other.tool, other.outcome], ['http.POST', 'ask']);
  });

  it('a deleted gate row is denied as rwx.unlisted, even in trust mode', async () => {
    const d = copyLabels();
    editJson(gateFile(d), (j) => { delete j.bareguard.tools['jira.deleteIssue']; });
    const r = await decide({ mode: 'trust', labels: loadLabels({ labels: [d], tenants: TENANTS }),
      method: 'DELETE', url: ISSUE });
    assert.deepEqual([r.tool, r.outcome, r.rule], ['jira.deleteIssue', 'deny', 'rwx.unlisted']);
  });
});

describe('through the proxy', () => {
  let up;
  before(async () => { up = await startHttp(); });
  after(async () => { await up?.close(); });

  it('a matched PUT is logged in gate.jsonl as jira.editIssue', { timeout: 20000 }, async () => {
    const labels = loadLabels({ labels: [copyLabels()], tenants: { jira: [`http://127.0.0.1:${up.port}`] } });
    const rt = mkdtempSync(join(tmpdir(), 'bb-lblp-'));
    const paths = runtimePaths(rt);
    const proxy = createProxy({ port: 0, logFile: paths.audit, runtime: rt, clientIdleMs: 5000,
      unsafeTestOnly: { allowLoopback: true }, labels,
      gateFor: (agent, { humanChannel, tools }) =>
        policyGate({ agent, mode: 'trust', auditPath: paths.audit, humanChannel, tools }),
      hold: { timeoutMs: 15000, pollMs: 25 } });
    try {
      const { port } = await proxy.ready;
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'PUT',
          path: `${up.url}/rest/api/3/issue/ABC-1`, headers: { host: `127.0.0.1:${up.port}` } });
        req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 200);
      const lines = readFileSync(paths.audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.some((l) => l.action?.tool === 'jira.editIssue'), JSON.stringify(lines));
    } finally {
      await Promise.race([proxy.close(), new Promise((r) => setTimeout(r, 5000))]);
      rmSync(rt, { recursive: true, force: true });
    }
  });
});
