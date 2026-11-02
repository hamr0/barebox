// prompt.js: the question text (pure) and the same-terminal prompt driven by
// PassThrough streams. No sandbox needed. The end-to-end pty test lives in
// cli-prompt.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { questionLines, createTerminalPrompt } from '../src/prompt.js';

const ask = (o = {}) => ({
  id: 'h3', agent: 'docs-bot', method: 'POST', url: 'https://httpbin.org/post?step=7', rule: 'rwx.ask', letter: 'x',
  bodyPreview: 'step=7&stolen=ssh:', expiresAt: null, ...o,
});
const text = (a, now) => questionLines(a, now).join('\n');
const tick = () => new Promise((r) => setImmediate(r));

describe('questionLines', () => {
  it('prints the documented block for an x POST', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    assert.deepEqual(questionLines(ask({ expiresAt: '2026-11-02T10:02:00Z' }), now), [
      '⏸  docs-bot wants to SEND data to httpbin.org',
      "   Why:  a change barebox can't undo",
      '   URL:  POST https://httpbin.org/post?step=7',
      '   Data: step=7&stolen=ssh:',
      '   Allow? [y/N] (h3)  — no answer in 120 s means No',
    ]);
  });

  it('picks the verb by method', () => {
    assert.match(text(ask()), /wants to SEND data to httpbin.org/);
    assert.match(text(ask({ method: 'PUT' })), /wants to CHANGE data on httpbin.org/);
    assert.match(text(ask({ method: 'PATCH' })), /wants to CHANGE data on httpbin.org/);
    assert.match(text(ask({ method: 'DELETE' })), /wants to DELETE data on httpbin.org/);
    assert.match(text(ask({ method: 'OPTIONS' })), /wants to make a OPTIONS request to httpbin.org/);
  });

  it('picks the reason by rule, then letter; an unknown rule prints as is', () => {
    assert.match(text(ask({ rule: 'flags.cardLike' })), /Why: {2}it contains what looks like a card number/);
    assert.match(text(ask({ rule: 'flags.paymentPath' })), /Why: {2}the address looks like a payment/);
    assert.match(text(ask({ letter: 'w' })), /Why: {2}a change \(reversible: the vendor says it can be undone\)/);
    assert.match(text(ask({ letter: 'x' })), /Why: {2}a change barebox can't undo/);
    assert.match(text(ask({ rule: 'weird.rule', letter: '?' })), /Why: {2}weird\.rule/);
  });

  it('omits Data when empty, caps it at 200 chars, and drops the countdown when there is no deadline', () => {
    assert.ok(!/Data:/.test(text(ask({ bodyPreview: '' }))));
    const long = text(ask({ bodyPreview: 'a'.repeat(500) }));
    assert.equal(long.split('\n').find((l) => l.startsWith('   Data:')), `   Data: ${'a'.repeat(200)}`);
    assert.ok(!/no answer in/.test(text(ask())));
  });

  it('strips terminal control from every agent-controlled field', () => {
    const evil = '\x1b[2J\x1b]0;pwn\x07‮X\x00';
    const t = text(ask({ id: `h1${evil}`, method: `PO${evil}ST`, url: `https://ho${evil}st.test/p${evil}`, rule: `r${evil}`, letter: '?', bodyPreview: `b${evil}` }));
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f‮]/.test(t), JSON.stringify(t));
    assert.ok(!t.includes('\x1b'));
  });
});

describe('createTerminalPrompt', () => {
  const setup = () => {
    const input = new PassThrough();
    const chunks = [];
    const output = { write: (s) => { chunks.push(s); } };
    const answers = [];
    const p = createTerminalPrompt({ input, output, answer: (...a) => { answers.push(a); } });
    return { input, p, answers, out: () => chunks.join('') };
  };

  it('y / yes in any case approves; Enter alone or anything else denies with the reason', async () => {
    const { input, p, answers, out } = setup();
    for (const [i, line] of ['y', 'YES', 'Yes ', '', 'n', 'maybe'].entries()) {
      p.ask(ask({ id: `h${i}` }));
      input.write(`${line}\n`);
      await tick();
    }
    assert.deepEqual(answers, [
      ['h0', 'allow', undefined], ['h1', 'allow', undefined], ['h2', 'allow', undefined],
      ['h3', 'deny', 'denied at the terminal'], ['h4', 'deny', 'denied at the terminal'],
      ['h5', 'deny', 'denied at the terminal'],
    ]);
    assert.equal((out().match(/✓ allowed/g) ?? []).length, 3);
    assert.equal((out().match(/✗ denied/g) ?? []).length, 3);
  });

  it('CRLF is one line', async () => {
    const { input, p, answers } = setup();
    p.ask(ask({ id: 'h1' }));
    p.ask(ask({ id: 'h2' }));
    input.write('y\r\n');
    await tick();
    assert.deepEqual(answers, [['h1', 'allow', undefined]]);
  });

  // Must hold 1
  it('input typed before a question never answers it', async () => {
    const { input, p, answers } = setup();
    input.write('y\n'); // nothing asked yet
    await tick();
    p.ask(ask({ id: 'h2' }));
    await tick();
    assert.deepEqual(answers, [], 'the early y must not approve h2');
    input.write('n\n');
    await tick();
    assert.deepEqual(answers, [['h2', 'deny', 'denied at the terminal']]);
  });

  it('a half-typed line from before the question does not join the answer', async () => {
    const { input, p, answers } = setup();
    input.write('ye'); // no newline, nothing open
    await tick();
    p.ask(ask({ id: 'h1' }));
    input.write('s\n');
    await tick();
    assert.deepEqual(answers, [['h1', 'deny', 'denied at the terminal']], '"s" is not yes');
  });

  it('a y typed for h1 does not approve a queued h2', async () => {
    const { input, p, answers } = setup();
    p.ask(ask({ id: 'h1' }));
    p.ask(ask({ id: 'h2' }));
    input.write('y\ny\n'); // second y was typed before h2 was printed
    await tick();
    assert.deepEqual(answers, [['h1', 'allow', undefined]]);
  });

  // Must hold 2
  it('a hold decided elsewhere closes the prompt with one line and writes no answer afterwards', async () => {
    const { input, p, answers, out } = setup();
    p.ask(ask({ id: 'h1' }));
    p.decided({ id: 'h1', decision: 'allow', reason: undefined });
    assert.match(out(), /answered elsewhere: allow\n$/);
    input.write('y\n');
    await tick();
    assert.deepEqual(answers, [], 'a line after the elsewhere-decided event answers nothing');
    assert.equal((out().match(/Allow\?/g) ?? []).length, 1);
    p.ask(ask({ id: 'h2' }));
    p.decided({ id: 'h2', decision: 'deny', reason: 'hold timeout' });
    assert.match(out(), /timed out: deny\n$/);
    p.ask(ask({ id: 'h3' }));
    p.decided({ id: 'h3', decision: 'deny', reason: 'client gone' });
    assert.match(out(), /agent gone: deny\n$/);
    p.ask(ask({ id: 'h4' }));
    p.decided({ id: 'h4', decision: 'deny', reason: 'nope' });
    assert.match(out(), /answered elsewhere: deny \(nope\)\n$/);
  });

  it('a decided event for our own answer prints nothing more', async () => {
    const { input, p, out } = setup();
    p.ask(ask({ id: 'h1' }));
    input.write('y\n');
    await tick();
    const before = out();
    p.decided({ id: 'h1', decision: 'allow' });
    assert.equal(out(), before);
  });

  // Must hold 3
  it('an answer write that fails (hold already gone) does not throw', async () => {
    const input = new PassThrough();
    const output = { write: () => {} };
    const p = createTerminalPrompt({ input, output, answer: () => { throw new Error('ENOENT'); } });
    p.ask(ask({ id: 'h1' }));
    p.ask(ask({ id: 'h2' }));
    input.write('y\n');
    await tick();
    input.write('n\n');
    await tick();
    // A throw from the answer writer would surface as an uncaught exception and fail this file.
  });

  // Must hold 5
  it('close() releases the input: no listener left, stream paused', () => {
    const { input, p } = setup();
    assert.equal(input.listenerCount('data'), 1);
    p.close();
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.isPaused(), true);
    p.ask(ask()); // after close: ignored, no throw
  });
});
