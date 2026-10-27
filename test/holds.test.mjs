// Holds unit tests: decision normalization and the event channel, with no
// proxy, sandbox, or sockets involved. The file channel works on a temp
// runtime dir; the `onAsk` channel needs no runtime at all.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHolds, normalizeDecision } from '../src/holds.js';

async function waitFor(cond, what, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('normalizeDecision (2.3)', () => {
  it('allows allow, denies deny with its reason', () => {
    assert.deepEqual(normalizeDecision({ decision: 'allow' }), { decision: 'allow' });
    assert.deepEqual(normalizeDecision({ decision: 'allow', reason: 'whatever' }),
      { decision: 'allow' });
    assert.deepEqual(normalizeDecision({ decision: 'deny', reason: 'no' }),
      { decision: 'deny', reason: 'no' });
  });

  it('defaults a missing reason to denied', () => {
    assert.deepEqual(normalizeDecision({ decision: 'deny' }), { decision: 'deny', reason: 'denied' });
    assert.deepEqual(normalizeDecision({ decision: 'deny', reason: '' }),
      { decision: 'deny', reason: 'denied' });
  });

  it('accepts approve as an alias in answer files only', () => {
    assert.deepEqual(normalizeDecision({ decision: 'approve' }, { approveAlias: true }),
      { decision: 'allow' });
    assert.equal(normalizeDecision({ decision: 'approve' }), null);
  });

  it('rejects everything else as not-a-decision', () => {
    assert.equal(normalizeDecision({ decision: 'maybe' }, { approveAlias: true }), null);
    assert.equal(normalizeDecision({}), null);
    assert.equal(normalizeDecision(null), null);
    assert.equal(normalizeDecision({ decision: 42 }), null);
  });
});

describe('hold queue events (2.1, 2.2, 2.4)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-hu-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A queue recording log lines and events, deciding nothing by itself. */
  function mkQueue(extra = {}) {
    const rt = mkdtempSync(join(root, 'rt-'));
    const logs = [];
    const events = [];
    const approved = [];
    const denied = [];
    const q = createHolds({
      log: (o) => logs.push(o),
      runtime: rt,
      timeoutMs: 5000,
      pollMs: 10,
      onEvent: (e) => events.push(e),
      onApprove: (h) => approved.push(h.id),
      onDeny: (h, reason) => denied.push([h.id, reason]),
      ...extra,
    });
    return { rt, logs, events, approved, denied, q };
  }

  const answer = (rt, id, obj) => {
    const dir = join(rt, 'answers');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(dir, `${id}.json`));
  };

  const park = (q, note = 'test hold') => q.add({
    agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
    body: Buffer.from('m=1'), sock: {}, cres: {}, note,
  });

  it('a file answer parks then settles, reported as ask + decided', async () => {
    const { rt, logs, events, approved, q } = mkQueue();
    try {
      const id = park(q);
      await waitFor(() => events.length >= 1, 'ask event');
      assert.equal(events[0].type, 'ask');
      assert.equal(events[0].ask.id, id);
      assert.equal(events[0].ask.rule, 'test hold');
      answer(rt, id, { decision: 'allow' });
      await waitFor(() => approved.length === 1, 'settle');
      assert.deepEqual(events.map((e) => e.type), ['ask', 'decided']);
      assert.deepEqual(events[1], { type: 'decided', id, decision: 'allow', reason: undefined });
      const decide = logs.find((l) => l.ev === 'decide');
      assert.equal(decide.decision, 'allow', 'the audit log speaks allow, never approve');
    } finally {
      q.close();
    }
  });

  it('approve in an answer file aliases allow', async () => {
    const { rt, events, approved, q } = mkQueue();
    try {
      const id = park(q);
      await waitFor(() => events.length >= 1, 'ask event');
      answer(rt, id, { decision: 'approve' });
      await waitFor(() => approved.length === 1, 'settle');
      assert.equal(events[1].decision, 'allow');
    } finally {
      q.close();
    }
  });

  it('the timer is the only deadline: no answer denies on time', async () => {
    const { events, denied, q } = mkQueue({ timeoutMs: 60 });
    try {
      const id = park(q);
      await waitFor(() => denied.length === 1, 'timeout deny');
      assert.deepEqual(denied, [[id, 'hold timeout']]);
      assert.deepEqual(events.map((e) => e.type), ['ask', 'decided']);
    } finally {
      q.close();
    }
  });

  it('an abandoned hold emits no decision; its late answer is stale', async () => {
    const { rt, logs, events, denied, q } = mkQueue();
    try {
      const id = park(q);
      await waitFor(() => events.length >= 1, 'ask event');
      q.abandon(id);
      assert.deepEqual(events.map((e) => e.type), ['ask'], 'no decided event for abandon');
      assert.deepEqual(denied, [[id, 'client gone']]);
      answer(rt, id, { decision: 'allow' });
      await waitFor(() => logs.some((l) => l.ev === 'stale-answer'), 'stale-answer');
      assert.deepEqual(events.map((e) => e.type), ['ask'], 'still no decision');
    } finally {
      q.close();
    }
  });

  it('pending() carries no bodies', async () => {
    const { events, q } = mkQueue();
    try {
      park(q);
      await waitFor(() => events.length >= 1, 'ask event');
      const [h] = q.pending();
      assert.ok(h.id && h.agent && h.method && h.url && h.rule);
      assert.ok(!('body' in h), 'no whole-body status payload');
    } finally {
      q.close();
    }
  });

  it('onAsk approve is not an alias: garbage and approve deny', async () => {
    for (const [raw, reason] of [
      [{ decision: 'approve' }, 'denied'],
      [{ decision: 'maybe' }, 'denied'],
    ]) {
      const seen = [];
      const q = createHolds({
        log: () => {},
        onAsk: async () => raw,
        onEvent: (e) => seen.push(e),
        onApprove: () => { throw new Error('must not approve'); },
        onDeny: () => {},
      });
      try {
        q.add({
          agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
          body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'r',
        });
        const decided = await waitFor(() => seen.find((e) => e.type === 'decided'), 'decide');
        assert.equal(decided.decision, 'deny');
        assert.equal(decided.reason, reason);
      } finally {
        q.close();
      }
    }
  });

  it('a throwing onAsk denies with the failure', async () => {
    const seen = [];
    const q = createHolds({
      log: () => {},
      onAsk: async () => { throw new Error('boom'); },
      onEvent: (e) => seen.push(e),
      onApprove: () => { throw new Error('must not approve'); },
      onDeny: () => {},
    });
    try {
      q.add({
        agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
        body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'r',
      });
      const decided = await waitFor(() => seen.find((e) => e.type === 'decided'), 'decide');
      assert.equal(decided.decision, 'deny');
      assert.match(decided.reason ?? '', /onAsk failed: boom/);
    } finally {
      q.close();
    }
  });

  it('a misshapen onEvent is rejected', () => {
    assert.throws(() => createHolds({
      log: () => {}, runtime: join(root, 'rt-x'), onEvent: 'yes',
      onApprove: () => {}, onDeny: () => {},
    }), /onEvent/);
  });
});

describe('no answer outlives its queue (r1 item 2)', () => {
  // One queue per runtime: ids restart at h1, so a dead queue's leftover
  // answer must never decide the next queue's hold.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-hstale-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const freshAnswer = (rt, id, obj) => {
    const tmp = join(rt, 'answers', `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(rt, 'answers', `${id}.json`));
  };

  it('a leftover answer never decides the next hold', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    // The previous queue died after `sbx approve h1` landed its answer.
    mkdirSync(join(rt, 'answers'), { recursive: true });
    writeFileSync(join(rt, 'answers', 'h1.json'), JSON.stringify({ decision: 'allow' }));
    const logs = [];
    const approved = [];
    const q = createHolds({
      log: (o) => logs.push(o), runtime: rt, timeoutMs: 5000, pollMs: 10,
      onApprove: (h) => approved.push(h.id), onDeny: () => {},
    });
    try {
      const stale = logs.filter((l) => l.ev === 'stale-answer' && l.id === 'h1');
      assert.equal(stale.length, 1, 'the leftover answer is logged once');
      const id = q.add({
        agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
        body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'test hold',
      });
      assert.equal(id, 'h1');
      await new Promise((r) => setTimeout(r, 700));
      assert.deepEqual(approved, [], 'no forwarding on the dead answer');
      // The hold stayed parked: a fresh answer still decides it.
      freshAnswer(rt, 'h1', { decision: 'allow' });
      await waitFor(() => approved.length === 1, 'fresh answer settles');
      assert.deepEqual(approved, ['h1']);
    } finally {
      q.close();
    }
  });

  it('close removes its parked asks', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const q = createHolds({
      log: () => {}, runtime: rt, timeoutMs: 5000, pollMs: 10,
      onApprove: () => {}, onDeny: () => {},
    });
    q.add({
      agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
      body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'test hold',
    });
    await waitFor(() => readdirSync(join(rt, 'asks')).length >= 1, 'ask file parked');
    q.close();
    assert.deepEqual(readdirSync(join(rt, 'asks')), [], 'no ask files survive close');
  });
});
