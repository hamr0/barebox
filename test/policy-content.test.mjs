// B1 correction: bareguard's default content patterns scan the whole action
// (URL and method included) and fire before rwx. The mode letters plus the
// card/payment floor are the whole policy, so gateFor turns them off.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFor, MODES } from '../src/policy.js';

const dir = mkdtempSync(join(tmpdir(), 'bb-pc-'));
let n = 0;

/** One decision; `asks` holds the rules the human channel was asked about. */
async function decide(mode, method, url) {
  const asks = [];
  const gate = await gateFor({ agent: 'a', mode, auditPath: join(dir, `a${n++}.jsonl`),
    humanChannel: async (e) => { asks.push(e.rule); return { decision: 'deny', reason: 'asked' }; } });
  const d = await gate.check({ type: 'net', tool: `http.${method}`, url, method, agent: 'a' });
  return { outcome: asks.length ? 'ask' : d.outcome, rule: asks[0] ?? d.rule };
}

describe('gateFor: default content patterns are off', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`trust: ${method} is allowed by rwx.allow`, async () => {
      assert.deepEqual(await decide('trust', method, 'https://example.com/a'),
        { outcome: 'allow', rule: 'rwx.allow' });
    });
  }

  for (const mode of MODES) {
    for (const url of ['https://example.com/api/remove-item', 'https://example.com/search?q=drop+shipping']) {
      it(`${mode}: GET ${url} is allowed`, async () => {
        assert.equal((await decide(mode, 'GET', url)).outcome, 'allow');
      });
    }
  }

  it('trust: GET with TRUNCATE TABLE in the URL is allowed (was content.denyPatterns)', async () => {
    assert.equal((await decide('trust', 'GET', 'https://example.com/q?s=TRUNCATE TABLE t')).outcome, 'allow');
  });

  it('auto: an unlabelled http.PUT still asks with rwx.ask (writes stay closed)', async () => {
    assert.deepEqual(await decide('auto', 'PUT', 'https://example.com/a'), { outcome: 'ask', rule: 'rwx.ask' });
  });
});

/** Run `fn` with `env` set on process.env, restoring every key afterwards. */
async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('gateFor: the host environment does not change the policy', () => {
  it('BAREGUARD_RWX_LETTERS=rwx does not widen ask mode: a POST still asks (1 ask)', async () => {
    const asks = [];
    const d = await withEnv({ BAREGUARD_RWX_LETTERS: 'rwx' }, async () => {
      const gate = await gateFor({ agent: 'a', mode: 'ask', auditPath: join(dir, `a${n++}.jsonl`),
        humanChannel: async (e) => { asks.push(e.rule); return { decision: 'deny', reason: 'asked' }; } });
      return gate.check({ type: 'net', tool: 'http.POST', url: 'https://example.com/a', method: 'POST', agent: 'a' });
    });
    assert.equal(d.outcome, 'deny');
    assert.equal(d.rule, 'rwx.ask');
    assert.equal(asks.length, 1);
  });

  it('BAREGUARD_RWX_LETTERS=bogus does not break trust mode: a POST is allowed', async () => {
    const r = await withEnv({ BAREGUARD_RWX_LETTERS: 'bogus' }, () => decide('trust', 'POST', 'https://example.com/a'));
    assert.equal(r.outcome, 'allow');
  });

  it('BAREGUARD_BUDGET_FILE over its cap does not deny, and the file is not touched', async () => {
    const f = join(dir, `budget${n++}.json`);
    writeFileSync(f, JSON.stringify({ version: 2, spent_usd: 5, cap_usd: 1 }));
    const before = readFileSync(f);
    const r = await withEnv({ BAREGUARD_BUDGET_FILE: f }, () => decide('trust', 'GET', 'https://example.com/a'));
    assert.equal(r.outcome, 'allow');
    assert.ok(readFileSync(f).equals(before), 'budget file changed');
  });

  it('BAREGUARD_BUDGET_FILE without a version does not make gateFor throw', async () => {
    const f = join(dir, `budget${n++}.json`);
    writeFileSync(f, JSON.stringify({ spent_usd: 0 }));
    const r = await withEnv({ BAREGUARD_BUDGET_FILE: f }, () => decide('trust', 'GET', 'https://example.com/a'));
    assert.equal(r.outcome, 'allow');
  });
});
