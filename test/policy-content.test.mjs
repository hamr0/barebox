// B1 correction: bareguard's default content patterns scan the whole action
// (URL and method included) and fire before rwx. The mode letters plus the
// card/payment floor are the whole policy, so gateFor turns them off.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
