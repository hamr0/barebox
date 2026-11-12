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
      '   Allow? [y/N] (hold h3)  — no answer in 120 s means No',
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
    const lines = ['y', 'YES', 'Yes ', '', 'n', 'maybe'];
    for (const [i, line] of lines.entries()) {
      p.ask(ask({ id: `h${i}` }));
      input.write(`${line}\n`);
      await tick();
      assert.ok(out().endsWith('→ sent '), 'the receipt is on screen before the decided');
      const yes = i < 3;
      p.decided({ id: `h${i}`, decision: yes ? 'allow' : 'deny', reason: yes ? undefined : 'denied at the terminal' });
      assert.ok(out().endsWith(yes ? '→ sent ✓ allowed\n' : '→ sent ✗ denied\n'), JSON.stringify(out()));
    }
    assert.deepEqual(answers, [
      ['h0', 'allow', undefined], ['h1', 'allow', undefined], ['h2', 'allow', undefined],
      ['h3', 'deny', 'denied at the terminal'], ['h4', 'deny', 'denied at the terminal'],
      ['h5', 'deny', 'denied at the terminal'],
    ]);
  });

  it('typing y writes "→ sent " at once, with no newline, before any decided', async () => {
    const { input, p, out } = setup();
    p.ask(ask({ id: 'h1' }));
    const before = out();
    input.write('y\n');
    await tick();
    assert.equal(out().slice(before.length), '→ sent ');
  });

  it('a y typed but decided as a hold timeout prints "→ sent ✗ timed out (denied)", never allowed', async () => {
    const { input, p, out } = setup();
    p.ask(ask({ id: 'h1' }));
    input.write('y\n');
    await tick();
    p.decided({ id: 'h1', decision: 'deny', reason: 'hold timeout' });
    assert.ok(out().endsWith('→ sent ✗ timed out (denied)\n'), JSON.stringify(out()));
    assert.ok(!out().includes('✓'), out());
  });

  it('a y typed then decided client gone / proxy closing prints the agent-gone and sandbox-closed lines', async () => {
    const { input, p, out } = setup();
    for (const [id, reason, line] of [['h1', 'client gone', '✗ agent gone (denied)'], ['h2', 'proxy closing', '✗ sandbox closed (denied)']]) {
      p.ask(ask({ id }));
      input.write('y\n');
      await tick();
      p.decided({ id, decision: 'deny', reason });
      assert.ok(out().endsWith(`→ sent ${line}\n`), JSON.stringify(out()));
    }
  });

  it('a n typed but decided allow elsewhere prints "→ sent ✓ answered elsewhere (allowed)", never denied', async () => {
    const { input, p, out } = setup();
    p.ask(ask({ id: 'h1' }));
    input.write('n\n');
    await tick();
    p.decided({ id: 'h1', decision: 'allow', reason: 'cli' });
    assert.ok(out().endsWith('→ sent ✓ answered elsewhere (allowed)\n'), JSON.stringify(out()));
    assert.ok(!/✗ denied/.test(out()), out());
  });

  it('a y typed but decided deny elsewhere prints "→ sent ✗ answered elsewhere (<reason>)", "(denied)" with no reason', async () => {
    const { input, p, out } = setup();
    for (const [id, reason, tail] of [['h1', 'denied by user', 'denied by user'], ['h2', undefined, 'denied']]) {
      p.ask(ask({ id }));
      input.write('y\n');
      await tick();
      p.decided({ id, decision: 'deny', reason });
      assert.ok(out().endsWith(`→ sent ✗ answered elsewhere (${tail})\n`), JSON.stringify(out()));
    }
  });

  it('CRLF is one line', async () => {
    const { input, p, answers } = setup();
    p.ask(ask({ id: 'h1' }));
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

  it('a half-typed line from a question that ended does not join the next answer', async () => {
    const { input, p, answers } = setup();
    p.ask(ask({ id: 'h1' }));
    input.write('ye'); // typed into h1, no newline
    await tick();
    p.decided({ id: 'h1', decision: 'deny', reason: 'hold timeout' });
    p.ask(ask({ id: 'h2' }));
    input.write('s\n');
    await tick();
    assert.deepEqual(answers, [['h2', 'deny', 'denied at the terminal']], '"s" is not yes: "ye" must be gone');
  });

  it('a second ask while one is open is refused (false) and never answered here', async () => {
    const { input, p, answers, out } = setup();
    assert.equal(p.ask(ask({ id: 'h1' })), true);
    assert.equal(p.ask(ask({ id: 'h2' })), false, 'the caller prints the plain ask line for h2');
    input.write('y\ny\n');
    await tick();
    assert.deepEqual(answers, [['h1', 'allow', undefined]]);
    assert.equal((out().match(/Allow\?/g) ?? []).length, 1, 'h2 was never printed as a question');
  });

  it('a lost write (answer returned false) prints no "→ sent"; its decided prints the elsewhere line', async () => {
    const input = new PassThrough();
    const chunks = [];
    const p = createTerminalPrompt({ input, output: { write: (s) => { chunks.push(s); } }, answer: () => false });
    p.ask(ask({ id: 'h1' }));
    input.write('y\n');
    await tick();
    const typedAt = chunks.join('');
    assert.ok(!typedAt.includes('→ sent'), typedAt);
    assert.ok(!/✓|✗/.test(typedAt), 'nothing is printed at typing time');
    p.decided({ id: 'h1', decision: 'deny', reason: 'denied by user' });
    const out = chunks.join('');
    assert.ok(out.endsWith('\n✗ answered elsewhere (denied by user)\n'), JSON.stringify(out));
    assert.ok(!out.includes('→ sent'), out);
  });

  it('a lost write then an allow decided elsewhere is "answered elsewhere", never "✓ allowed"', async () => {
    const input = new PassThrough();
    const chunks = [];
    const p = createTerminalPrompt({ input, output: { write: (s) => { chunks.push(s); } }, answer: () => false });
    p.ask(ask({ id: 'h1' }));
    input.write('y\n');
    await tick();
    p.decided({ id: 'h1', decision: 'allow' });
    const out = chunks.join('');
    assert.ok(out.endsWith('✓ answered elsewhere (allowed)\n'), JSON.stringify(out));
    assert.ok(!out.includes('✓ allowed'), out);
    assert.ok(!out.includes('→ sent'), out);
  });

  // Must hold 2
  it('a hold decided elsewhere closes the prompt with one line and writes no answer afterwards', async () => {
    const { input, p, answers, out } = setup();
    p.ask(ask({ id: 'h1' }));
    p.decided({ id: 'h1', decision: 'allow', reason: undefined });
    assert.ok(out().endsWith('\n✓ answered elsewhere (allowed)\n'), JSON.stringify(out()));
    input.write('y\n');
    await tick();
    assert.deepEqual(answers, [], 'a line after the elsewhere-decided event answers nothing');
    assert.equal((out().match(/Allow\?/g) ?? []).length, 1);
    p.ask(ask({ id: 'h2' }));
    p.decided({ id: 'h2', decision: 'deny', reason: 'hold timeout' });
    assert.ok(out().endsWith('\n✗ timed out (denied)\n'), JSON.stringify(out()));
    p.ask(ask({ id: 'h3' }));
    p.decided({ id: 'h3', decision: 'deny', reason: 'client gone' });
    assert.ok(out().endsWith('\n✗ agent gone (denied)\n'), JSON.stringify(out()));
    p.ask(ask({ id: 'h4' }));
    p.decided({ id: 'h4', decision: 'deny', reason: 'nope' });
    assert.ok(out().endsWith('\n✗ answered elsewhere (nope)\n'), JSON.stringify(out()));
    p.ask(ask({ id: 'h5' }));
    p.decided({ id: 'h5', decision: 'deny', reason: 'proxy closing' });
    assert.ok(out().endsWith('\n✗ sandbox closed (denied)\n'), JSON.stringify(out()));
  });

  it('the verdict for our own answer prints once; a repeated decided prints nothing', async () => {
    const { input, p, out } = setup();
    p.ask(ask({ id: 'h1' }));
    input.write('y\n');
    await tick();
    p.decided({ id: 'h1', decision: 'allow' });
    const before = out();
    assert.ok(before.endsWith('→ sent ✓ allowed\n'), JSON.stringify(before));
    p.decided({ id: 'h1', decision: 'allow' });
    p.decided({ id: 'h1', decision: 'deny', reason: 'hold timeout' });
    assert.equal(out(), before, 'a repeated decided for the same id adds nothing');
  });

  // Must hold 3
  it('an answer write that throws prints "✗ not sent (<code>)" and its later decided still words the outcome', async () => {
    const input = new PassThrough();
    const chunks = [];
    const p = createTerminalPrompt({
      input, output: { write: (s) => { chunks.push(s); } },
      answer: () => { const e = new Error('x'); e.code = 'ENOSPC'; throw e; },
    });
    const text = () => chunks.join('');
    p.ask(ask({ id: 'h1' }));
    const asked = text().length;
    input.write('y\n');
    await tick();
    assert.equal(text().slice(asked), '✗ not sent (ENOSPC)\n');
    p.decided({ id: 'h1', decision: 'deny', reason: 'hold timeout' });
    assert.ok(text().endsWith('\n✗ timed out (denied)\n'), JSON.stringify(text()));
    assert.ok(!text().includes('→ sent'), text());
  });

  it('an answer write that throws with no string code prints "✗ not sent (error)"', async () => {
    const input = new PassThrough();
    const chunks = [];
    const p = createTerminalPrompt({ input, output: { write: (s) => { chunks.push(s); } }, answer: () => { throw new Error('/secret/path'); } });
    p.ask(ask({ id: 'h1' }));
    const asked = chunks.join('').length;
    input.write('n\n');
    await tick();
    assert.equal(chunks.join('').slice(asked), '✗ not sent (error)\n');
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

describe('color', () => {
  const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
  const now = Date.parse('2026-11-02T10:00:00Z');
  const a = ask({ expiresAt: '2026-11-02T10:02:00Z' });

  it('color on: yellow header with a bold name, bold labels, cyan URL, dim data and id', () => {
    assert.deepEqual(questionLines(a, now, true), [
      `${Y}⏸  ${B}docs-bot\x1b[22m wants to SEND data to httpbin.org${X}`,
      `   ${B}Why:${X}  a change barebox can't undo`,
      `   ${B}URL:${X}  ${C}POST https://httpbin.org/post?step=7${X}`,
      `   ${B}Data:${X} ${D}step=7&stolen=ssh:${X}`,
      `   ${B}Allow? [y/N]${X} ${D}(hold h3)  — no answer in 120 s means No${X}`,
    ]);
  });

  it('color off (the default) is byte-for-byte the plain block', () => {
    assert.deepEqual(questionLines(a, now), questionLines(a, now, false));
    assert.ok(!questionLines(a, now).join('').includes('\x1b'));
  });

  it('an escape in the url, body, agent or id never reaches the output, color on', () => {
    const evil = '\x1b[31mRED';
    const lines = questionLines(ask({ url: `https://h.test/${evil}`, bodyPreview: evil, agent: evil, id: evil }), now, true).join('\n');
    const raw = lines.replace(/\x1b\[(?:0|1|2|22|31|32|33|36)m/g, (m, off) => `<${off}>`);
    assert.equal((lines.match(/\x1b\[31m/g) ?? []).length, 0, 'no red escape from agent bytes (red is never used in a question)');
    assert.ok(!/\x1b\[31mRED/.test(lines));
    assert.ok(!raw.includes('\x1b'), 'only the known paint sequences are present');
  });

  it('→ sent dim; allowed bold green, denied bold red; timed out / agent gone / sandbox closed red; elsewhere plain', async () => {
    const input = new PassThrough();
    const chunks = [];
    const p = createTerminalPrompt({ input, output: { write: (s) => { chunks.push(s); } }, answer: () => {}, color: true });
    const seen = () => chunks.join('');
    const S = `${D}→ sent${X} `;
    p.ask(ask({ id: 'h1' })); input.write('y\n'); await tick();
    p.decided({ id: 'h1', decision: 'allow' });
    assert.ok(seen().includes(`${S}${G}${B}✓ allowed${X}\n`), seen());
    p.ask(ask({ id: 'h2' })); input.write('n\n'); await tick();
    p.decided({ id: 'h2', decision: 'deny', reason: 'denied at the terminal' });
    assert.ok(seen().includes(`${S}${R}${B}✗ denied${X}\n`), seen());
    p.ask(ask({ id: 'h3' })); p.decided({ id: 'h3', decision: 'deny', reason: 'hold timeout' });
    assert.ok(seen().includes(`\n${R}✗ timed out (denied)${X}\n`), seen());
    p.ask(ask({ id: 'h4' })); p.decided({ id: 'h4', decision: 'deny', reason: 'client gone' });
    assert.ok(seen().includes(`\n${R}✗ agent gone (denied)${X}\n`), seen());
    p.ask(ask({ id: 'h5' })); p.decided({ id: 'h5', decision: 'deny', reason: 'proxy closing' });
    assert.ok(seen().includes(`\n${R}✗ sandbox closed (denied)${X}\n`), seen());
    p.ask(ask({ id: 'h6' })); p.decided({ id: 'h6', decision: 'allow', reason: 'cli' });
    assert.ok(seen().includes('\n✓ answered elsewhere (allowed)\n'), seen());
  });

  it('decided text from the agent is sanitized with color on', () => {
    const chunks = [];
    const p = createTerminalPrompt({ input: new PassThrough(), output: { write: (s) => { chunks.push(s); } }, answer: () => {}, color: true });
    p.ask(ask({ id: 'h1' }));
    p.decided({ id: 'h1', decision: 'allow', reason: '\x1b[31mevil' });
    assert.ok(!chunks.join('').includes('\x1b[31mevil'));
  });
});
