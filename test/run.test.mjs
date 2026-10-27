// run() tests: mode mapping pure (no sandbox), validation, and sandboxed
// runs through onAsk (no files) and through the file channel (answers file).
// Sandboxed runs need bwrap, unix sockets, socat and curl: loud skip
// elsewhere, green in a real shell and CI.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import net from 'node:net';
import { run, shouldHoldForMode } from '../src/run.js';
import { startHttp } from './fixtures/upstream.mjs';

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-rprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
function hasBin(n) {
  try { execFileSync('which', [n], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const UNIX_OK = await canUnix();
const CAN_RUN = existsSync('/usr/bin/bwrap') && UNIX_OK && hasBin('socat') && hasBin('curl');
const SKIP_WHY = !existsSync('/usr/bin/bwrap') ? 'needs bwrap'
  : (!UNIX_OK ? 'unix socket bind blocked here'
    : (!hasBin('socat') || !hasBin('curl') ? 'needs socat and curl' : ''));

function capture() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  return { stream, text: () => chunks.join('') };
}

async function waitFor(cond, what, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('shouldHoldForMode (no sandbox needed)', () => {
  const get = (url = 'http://x/') => ({ agent: 'a', method: 'GET', url, headers: {} });
  const post = (url = 'http://x/') => ({ agent: 'a', method: 'POST', url, headers: {} });

  it('rejects an unknown mode', () => {
    assert.throws(() => shouldHoldForMode('nope'), /mode must be ask\|auto\|trust/);
  });

  it('auto parks non-GET/HEAD, forwards GET/HEAD', () => {
    const decide = shouldHoldForMode('auto');
    assert.equal(decide(get()), null);
    assert.equal(decide({ ...get(), method: 'HEAD' }), null);
    assert.match(decide(post()) ?? '', /not GET\/HEAD/);
  });

  it('ask behaves like auto until M3 owns letters', () => {
    const decide = shouldHoldForMode('ask');
    assert.equal(decide(get()), null);
    assert.ok(decide(post()));
  });

  it('trust forwards everything but the payment floor', () => {
    const decide = shouldHoldForMode('trust');
    assert.equal(decide(get()), null);
    assert.equal(decide(post()), null);
    assert.match(decide(post('http://x/checkout')) ?? '', /floor/);
    assert.match(decide(get('http://x/payment')) ?? '', /floor/);
  });

  it('an explicit match replaces the method default, and the floor still holds', () => {
    const decide = shouldHoldForMode('auto', { match: '/hold' });
    assert.match(decide(get('http://x/hold')) ?? '', /path matches \/hold/);
    assert.equal(decide(post('http://x/other')), null);
    assert.match(decide(post('http://x/orders')) ?? '', /floor/);
  });

  it('trust ignores an explicit match but keeps the floor', () => {
    const decide = shouldHoldForMode('trust', { match: '/hold' });
    assert.equal(decide(get('http://x/hold')), null);
    assert.equal(decide(post('http://x/hold')), null);
    assert.ok(decide(post('http://x/purchase')));
  });

  it('an explicit shouldHold replaces the method default, never the floor', () => {
    const decide = shouldHoldForMode('auto', { shouldHold: () => null });
    assert.equal(decide(post('http://x/')), null);
    assert.ok(decide(post('http://x/checkout')));
  });
});

describe('run validation (no sandbox needed)', () => {
  it('rejects a missing proj, an empty command, and a bad mode', async () => {
    await assert.rejects(run({}), /proj/);
    await assert.rejects(run({ proj: tmpdir(), command: [] }), /command/);
    await assert.rejects(run({ proj: tmpdir(), command: ['true'], mode: 'nope' }),
      /mode must be ask\|auto\|trust/);
  });

  it('rejects a misshapen onAsk and gate', async () => {
    await assert.rejects(run({ proj: tmpdir(), command: ['true'], onAsk: 'yes' }), /onAsk/);
    await assert.rejects(run({ proj: tmpdir(), command: ['true'], gate: {} }), /gate/);
  });
});

describe(`run sandboxed (needs bwrap+unix+socat+curl${SKIP_WHY ? `: ${SKIP_WHY}` : ''})`,
  { skip: CAN_RUN ? false : `run blocked here (${SKIP_WHY}); run in a real shell or CI` }, () => {
  let root, home, proj, plainUp;
  let savedHome;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'bb-r-'));
    home = join(root, 'home'); proj = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'agent.txt'), 'run project\n');
    savedHome = process.env.HOME;
    process.env.HOME = home;
    plainUp = await startHttp();
  });
  after(async () => {
    try {
      await plainUp?.close();
    } finally {
      process.env.HOME = savedHome;
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  // Atomic answer write, exactly like `sbx approve`.
  const answer = (rt, id, obj) => {
    const dir = join(rt, 'answers');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(dir, `${id}.json`));
  };
  const curlHold = (marker) => ['bash', '-c',
    `curl -s --max-time 10 --data m=${marker} http://127.0.0.1:${plainUp.port}/hold`];

  it('a loop answers a parked request through onAsk with no files involved', async () => {
    const rt = join(root, 'rt-onask');
    const out = capture();
    const err = capture();
    let seenAsk = null;
    const res = await run({
      proj, command: curlHold('RUNONASK'), runtime: rt,
      allowLoopback: true, pollMs: 25, stdout: out.stream, stderr: err.stream,
      onAsk: async (ask) => {
        // Slow on purpose: while parked, no answer file may appear — the
        // decision below must arrive with the answers dir still empty.
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(readdirSync(join(rt, 'answers')).length, 0,
          'onAsk must not need answer files');
        seenAsk = ask;
        return { decision: 'allow' };
      },
    });
    assert.equal(res.exit, 0, err.text());
    assert.match(out.text(), /RUNONASK/);
    assert.ok(seenAsk, 'onAsk saw the ask');
    assert.equal(seenAsk.letter, 'x');
    assert.match(seenAsk.rule, /not GET\/HEAD/);
    assert.equal(res.asks.length, 1);
    assert.equal(res.asks[0].decision, 'allow');
    assert.match(res.asks[0].url, /\/hold/);
    assert.match(res.asks[0].bodyPreview, /RUNONASK/);
    // Nothing lingered: ask file removed on settle, answers never used.
    assert.deepEqual(readdirSync(join(rt, 'asks')), []);
    assert.deepEqual(readdirSync(join(rt, 'answers')), []);
    assert.ok(existsSync(res.audit), 'audit log path is returned and kept');
  });

  it('without onAsk the file channel decides and asks rebuild from the audit log', async () => {
    const rt = join(root, 'rt-file');
    const out = capture();
    const err = capture();
    const pending = run({
      proj, command: curlHold('RUNFILE'), runtime: rt,
      allowLoopback: true, pollMs: 25, timeoutMs: 15000,
      stdout: out.stream, stderr: err.stream,
    });
    const id = await waitFor(() => {
      let names = [];
      try { names = readdirSync(join(rt, 'asks')); } catch { return null; }
      const f = names.find((n) => n.endsWith('.json'));
      return f ? f.slice(0, -'.json'.length) : null;
    }, 'ask file to appear');
    answer(rt, id, { decision: 'allow' });
    const res = await pending;
    assert.equal(res.exit, 0, err.text());
    assert.match(out.text(), /RUNFILE/);
    assert.equal(res.asks.length, 1);
    assert.equal(res.asks[0].id, id);
    assert.equal(res.asks[0].decision, 'allow');
    assert.match(res.audit && readFileSync(res.audit, 'utf8'), /"ev":"decide"/);
  });

  it('a gate-shaped object is accepted (M3 wires it; M2.5 mode still decides)', async () => {
    const rt = join(root, 'rt-gate');
    const out = capture();
    const err = capture();
    const res = await run({
      proj, command: curlHold('RUNGATE'), runtime: rt,
      allowLoopback: true, pollMs: 25,
      gate: { check: async () => 'allow' },
      stdout: out.stream, stderr: err.stream,
      onAsk: async () => ({ decision: 'allow' }),
    });
    assert.equal(res.exit, 0, err.text());
    assert.equal(res.asks.length, 1, 'mode default still parked (gate not consulted yet)');
  });

  it('a command with no network creates a temp runtime and returns exit 0', async () => {
    const res = await run({ proj, command: ['true'] });
    assert.equal(res.exit, 0);
    assert.deepEqual(res.asks, []);
    assert.ok(existsSync(res.audit), 'audit log exists');
    assert.match(dirname(res.audit), /sbx-/);
    rmSync(dirname(res.audit), { recursive: true, force: true });
  });

  it('the agent process exit code is returned as exit', async () => {
    const res = await run({ proj, command: ['bash', '-c', 'exit 3'] });
    assert.equal(res.exit, 3);
    rmSync(dirname(res.audit), { recursive: true, force: true });
  });
});
