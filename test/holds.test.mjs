// Holds unit tests: decision normalization and the event channel, with no
// proxy, sandbox, or sockets involved. The file channel works on a temp
// runtime dir; the `onAsk` channel needs no runtime at all.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs';
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

  it('an abandoned hold reports decided / deny / client gone once; its late answer is stale', async () => {
    const { rt, logs, events, denied, q } = mkQueue();
    try {
      const id = park(q);
      await waitFor(() => events.length >= 1, 'ask event');
      assert.deepEqual(readdirSync(join(rt, 'asks')), [`${id}.json`], 'parked: ask file present');
      q.abandon(id);
      assert.deepEqual(events.slice(1),
        [{ type: 'decided', id, decision: 'deny', reason: 'client gone' }]);
      assert.deepEqual(denied, [[id, 'client gone']]);
      assert.deepEqual(readdirSync(join(rt, 'asks')), [], 'ask file removed');
      answer(rt, id, { decision: 'allow' });
      await waitFor(() => logs.some((l) => l.ev === 'stale-answer'), 'stale-answer');
      assert.equal(events.filter((e) => e.type === 'decided').length, 1, 'still exactly one decided');
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

describe('one held request per agent', () => {
  function mkQ(extra = {}) {
    const logs = [];
    const events = [];
    const approved = [];
    const denied = [];
    const q = createHolds({
      log: (o) => logs.push(o),
      onAsk: () => new Promise(() => {}),
      timeoutMs: 5000,
      onEvent: (e) => events.push(e),
      onApprove: (h) => approved.push(h.id),
      onDeny: (h, reason) => denied.push([h.id, reason]),
      ...extra,
    });
    return { logs, events, approved, denied, q };
  }

  const entry = (agent, slot, arrivedAt) => ({
    agent, method: 'POST', url: 'http://x/hold', headers: {},
    body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'r',
    ...(slot ? { slot, arrivedAt } : {}),
  });

  const noop = () => {};

  it('first is now, second queues, decision hands over', async () => {
    const { q } = mkQ({ timeoutMs: 150 });
    try {
      const rA = q.reserve('a', { onReady: noop, onExpire: noop });
      assert.equal(rA.state, 'now');
      q.add(entry('a', rA, rA.arrivedAt));
      let ready = 0;
      const expired = [];
      const rB = q.reserve('a', {
        onReady: () => { ready++; },
        onExpire: (reason) => expired.push(reason),
      });
      assert.equal(rB.state, 'queued');
      await waitFor(() => ready === 1, 'handover to B');
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(ready, 1, 'onReady exactly once');
      assert.deepEqual(expired, [], 'no expiry after handover (waiter timer cleared)');
      rB.cancel();
    } finally {
      q.close();
    }
  });

  it('agents are independent', () => {
    const { q } = mkQ();
    try {
      const rA = q.reserve('a', { onReady: noop, onExpire: noop });
      const rB = q.reserve('b', { onReady: noop, onExpire: noop });
      assert.equal(rA.state, 'now');
      assert.equal(rB.state, 'now');
      rA.cancel();
      rB.cancel();
    } finally {
      q.close();
    }
  });

  it('a waiter still in line at its deadline expires unread', async () => {
    // A holds the slot through its reservation (body still being read, so
    // nothing settles): the only way a waiter can still be in line when its
    // own deadline passes.
    const { q } = mkQ({ timeoutMs: 200 });
    try {
      const rA = q.reserve('a', { onReady: noop, onExpire: noop });
      assert.equal(rA.state, 'now');
      let ready = 0;
      const expired = [];
      const rB = q.reserve('a', {
        onReady: () => { ready++; },
        onExpire: (reason) => expired.push(reason),
      });
      assert.equal(rB.state, 'queued');
      await waitFor(() => expired.length === 1, 'B expires in line');
      assert.deepEqual(expired, ['hold timeout']);
      assert.equal(ready, 0, 'onReady never fires for an expired waiter');
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(ready, 0);
      rA.cancel();
      rB.cancel();
    } finally {
      q.close();
    }
  });

  it('a handed-over ask keeps its arrival deadline', async () => {
    const { denied, q } = mkQ({ timeoutMs: 300 });
    const t0 = Date.now();
    try {
      const rA = q.reserve('a', { onReady: noop, onExpire: noop });
      const idA = q.add(entry('a', rA, rA.arrivedAt));
      let ready = 0;
      const rB = q.reserve('a', {
        onReady: () => { ready++; },
        onExpire: noop,
      });
      assert.equal(rB.state, 'queued');
      const tB = rB.arrivedAt;
      await new Promise((r) => setTimeout(r, 200));
      q.abandon(idA);
      await waitFor(() => ready === 1, 'handover to B');
      const idB = q.add(entry('a', rB, rB.arrivedAt));
      await waitFor(() => denied.some(([id]) => id === idB), 'B denied on its arrival deadline');
      assert.deepEqual(denied.find(([id]) => id === idB), [idB, 'hold timeout']);
      assert.ok(Date.now() - tB < 450, `B denied ~300ms after arrival, not 500ms (${Date.now() - tB}ms)`);
      assert.ok(Date.now() - t0 < 600, 'sanity: whole test inside one window');
    } finally {
      q.close();
    }
  });

  it('the 17th waiter is refused and logged', () => {
    const { logs, q } = mkQ({ timeoutMs: 'never' });
    try {
      const rA = q.reserve('a', { onReady: noop, onExpire: noop });
      q.add(entry('a', rA, rA.arrivedAt));
      const waiters = [];
      for (let i = 0; i < 16; i++) {
        const r = q.reserve('a', { onReady: noop, onExpire: noop });
        assert.equal(r.state, 'queued', `waiter ${i}`);
        waiters.push(r);
      }
      const full = q.reserve('a', { onReady: noop, onExpire: noop });
      assert.equal(full.state, 'full');
      assert.ok(logs.some((l) => l.ev === 'hold-queue-full' && l.agent === 'a'),
        'a hold-queue-full line is logged');
      for (const w of waiters) w.cancel();
      full.cancel();
    } finally {
      q.close();
    }
  });

  it('cancel paths release or skip exactly once', async () => {
    // A cancelled waiter is skipped; the next waiter gets the slot.
    {
      const { q } = mkQ();
      try {
        const rA = q.reserve('a', { onReady: noop, onExpire: noop });
        q.add(entry('a', rA, rA.arrivedAt));
        let readyB = 0;
        let readyC = 0;
        const rB = q.reserve('a', { onReady: () => { readyB++; }, onExpire: noop });
        const rC = q.reserve('a', { onReady: () => { readyC++; }, onExpire: noop });
        rB.cancel();
        rB.cancel();
        q.abandon(q.pending()[0].id);
        await waitFor(() => readyC === 1, 'handover skips cancelled B');
        assert.equal(readyB, 0, 'cancelled waiter never gets onReady');
        rC.cancel();
      } finally {
        q.close();
      }
    }
    // Cancelling a held 'now' reservation passes the slot on.
    {
      const { q } = mkQ();
      try {
        const r1 = q.reserve('a', { onReady: noop, onExpire: noop });
        assert.equal(r1.state, 'now');
        let ready = 0;
        const r2 = q.reserve('a', { onReady: () => { ready++; }, onExpire: noop });
        assert.equal(r2.state, 'queued');
        r1.cancel();
        r1.cancel();
        await waitFor(() => ready === 1, 'cancel hands the slot over');
        r2.cancel();
      } finally {
        q.close();
      }
    }
    // Cancelling after add does nothing: the parked entry owns the slot.
    {
      const { denied, q } = mkQ({ timeoutMs: 120 });
      try {
        const r = q.reserve('a', { onReady: noop, onExpire: noop });
        const id = q.add(entry('a', r, r.arrivedAt));
        r.cancel();
        r.cancel();
        assert.equal(q.pending().length, 1, 'still parked after cancel');
        await waitFor(() => denied.length === 1, 'entry times out on its own clock');
        assert.deepEqual(denied, [[id, 'hold timeout']]);
      } finally {
        q.close();
      }
    }
  });

  it('abandon and close release the slot', async () => {
    // abandon hands over.
    {
      const { q } = mkQ();
      try {
        const rA = q.reserve('a', { onReady: noop, onExpire: noop });
        const idA = q.add(entry('a', rA, rA.arrivedAt));
        let ready = 0;
        const rB = q.reserve('a', { onReady: () => { ready++; }, onExpire: noop });
        q.abandon(idA);
        await waitFor(() => ready === 1, 'abandon hands over');
        rB.cancel();
      } finally {
        q.close();
      }
    }
    // close expires every waiter.
    {
      const { q } = mkQ();
      const expired = [];
      try {
        const rA = q.reserve('a', { onReady: noop, onExpire: noop });
        q.add(entry('a', rA, rA.arrivedAt));
        const rB = q.reserve('b', { onReady: noop, onExpire: noop });
        assert.equal(rB.state, 'now', 'b holds its slot without parking');
        q.reserve('a', { onReady: noop, onExpire: (reason) => expired.push(['a', reason]) });
        q.reserve('b', { onReady: noop, onExpire: (reason) => expired.push(['b', reason]) });
        q.close();
        assert.deepEqual(expired.sort(), [['a', 'proxy closing'], ['b', 'proxy closing']]);
      } finally {
        q.close();
      }
    }
  });

  it('asks/ and answers/ are 0700 under umask 0, even pre-existing', () => {
    const prev = process.umask(0);
    try {
      const rt = mkdtempSync(join(tmpdir(), 'bb-hmode-'));
      try {
        mkdirSync(join(rt, 'answers'), { recursive: true });
        chmodSync(join(rt, 'answers'), 0o777);
        const q = createHolds({
          log: () => {}, runtime: rt, timeoutMs: 5000, pollMs: 10,
          onApprove: () => {}, onDeny: () => {},
        });
        try {
          assert.equal(statSync(join(rt, 'asks')).mode & 0o777, 0o700);
          assert.equal(statSync(join(rt, 'answers')).mode & 0o777, 0o700);
        } finally {
          q.close();
        }
      } finally {
        rmSync(rt, { recursive: true, force: true });
      }
    } finally {
      process.umask(prev);
    }
  });

  it('add without a slot still parks without limit', () => {
    const { q } = mkQ();
    try {
      const park = () => q.add({
        agent: 'a', method: 'POST', url: 'http://x/hold', headers: {},
        body: Buffer.from('m=1'), sock: {}, cres: {}, note: 'r',
      });
      park();
      park();
      park();
      assert.equal(q.pending().length, 3, 'all three parked, as today');
    } finally {
      q.close();
    }
  });
});
