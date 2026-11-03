// CLI tests: `sbx --help` / usage need no runtime; pending/approve/deny run
// against a live proxy through the file channel (`SBX_RUNTIME/asks` +
// `SBX_RUNTIME/answers`), no unix socket involved. All children are async —
// never a sync child against the in-process proxy. Same proxy-var scrub as
// proxy.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createProxy } from '../src/proxy.js';
import { claimRuntime } from '../src/runtime.js';
import { writeFileAtomic, createHolds } from '../src/holds.js';
import { ensureCA, certFor } from '../src/certs.js';
import { startHttps, startHttp } from './fixtures/upstream.mjs';
import { pathGate } from './fixtures/gates.mjs';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';

// test/setup-env.mjs (via --import) already dropped the sandbox's egress proxy
// vars before `node:http` snapshotted them; repeat here so curl children
// inherit a clean env on direct single-file runs too.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}

const execA = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/cli.js');

describe('sbx --name on a sandbox that never ran', () => {
  const root = mkdtempSync('/tmp/bb-nn-');
  after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
  for (const args of [['pending'], ['approve', 'h1'], ['diff']]) {
    it(`${args[0]} --name typo exits 1 with "no sandbox named", creates nothing`, async () => {
      const err = await execA('node', [CLI, ...args, '--name', 'typo'], { encoding: 'utf8', env }).then(() => null, (e) => e);
      assert.ok(err, 'must fail');
      assert.equal(err.code, 1, err.stderr);
      assert.match(err.stderr, /^no sandbox named typo \(start one with 'sbx run --name typo -- …'\)/);
      assert.equal(readdirSync(root).length, 0, 'a typo makes no dir');
    });
  }
});

describe('sbx usage (no runtime needed)', () => {
  const run = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, ...env } });

  it('--help exits 0', async () => {
    const r = await run(['--help']);
    assert.match(r.stdout, /usage: sbx/);
  });

  it('no command is a usage error (exit 2)', async () => {
    const err = await run([]).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.match(err.stderr, /usage: sbx/);
    assert.equal(err.stdout, '', 'usage writes nothing on stdout');
  });

  it('unknown command is a usage error (exit 2)', async () => {
    const err = await run(['frobnicate']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });

  it('missing SBX_RUNTIME is a usage error (exit 2)', async () => {
    const env = { ...process.env };
    delete env.SBX_RUNTIME;
    const err = await execA('node', [CLI, 'pending'],
      { encoding: 'latin1', env }).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.match(err.stderr, /usage: sbx/);
    assert.equal(err.stdout, '', 'usage writes nothing on stdout');
  });

  it('pending on an empty runtime prints nothing held (exit 0)', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-c-empty-'));
    try {
      const env = { ...process.env };
      env.SBX_RUNTIME = rt;
      const r = await execA('node', [CLI, 'pending'],
        { encoding: 'latin1', env });
      assert.equal(r.stdout.trim(), 'nothing held');
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('ask/answer files are owner-only (0600)', () => {
    // Asks carry the audit trail and unredacted body previews; the default
    // 0644-minus-umask would expose them. Setup-independent: pure fs.
    const dir = mkdtempSync(join(tmpdir(), 'bb-mode-'));
    try {
      const f = join(dir, 'asks', 'h1.json');
      writeFileAtomic(f, '{"id":"h1"}');
      assert.equal(lstatSync(f).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sbx approve/deny id validation + pending sanitizing (no sandbox needed)', () => {
  const sbxCli = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, ...env } });

  it('approve/deny reject non-h<n> ids with exit 2 before touching any file', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-id-'));
    try {
      for (const bad of ['../asks/h9', '..', 'h', 'h1x', 'H1', 'h-1', 'h1.json', 'h1 h2']) {
        for (const cmd of ['approve', 'deny']) {
          const err = await sbxCli([cmd, bad], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
          assert.ok(err, `${cmd} ${bad} must fail`);
          assert.equal(err?.code, 2, `${cmd} ${bad}: want exit 2, got ${err?.code}`);
          assert.match(err.stderr, /bad hold id/);
          assert.equal(err.stdout, '', 'bad ids write nothing on stdout');
        }
      }
      assert.deepEqual(readdirSync(rt), [], 'no file written anywhere under the runtime');
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('a traversal id cannot overwrite the ask file it names', async () => {
    // Pre-fix the id went straight into a file path: with asks/h9.json
    // present, `approve ../asks/h9` overwrote it with an answer payload.
    const rt = mkdtempSync(join(tmpdir(), 'bb-idt-'));
    try {
      mkdirSync(join(rt, 'asks'), { recursive: true });
      writeFileSync(join(rt, 'asks', 'h9.json'), '{"id":"h9"}');
      const err = await sbxCli(['approve', '../asks/h9'], { SBX_RUNTIME: rt })
        .then(() => null, (e) => e);
      assert.equal(err?.code, 2);
      assert.equal(readFileSync(join(rt, 'asks', 'h9.json'), 'utf8'), '{"id":"h9"}',
        'the ask file must be untouched');
      assert.ok(!existsSync(join(rt, 'answers')), 'no answer dir created either');
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('approve of a path id writes nothing on stdout (exit 2)', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-c-ap-'));
    try {
      const err = await sbxCli(['approve', '../x'], { SBX_RUNTIME: rt })
        .then(() => null, (e) => e);
      assert.equal(err?.code, 2);
      assert.equal(err.stdout, '', 'bad ids write nothing on stdout');
      assert.match(err.stderr, /bad hold id/);
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('pending strips escape sequences from agent-controlled fields', async () => {
    // Body previews and URLs print raw to the approver's terminal: an
    // agent-controlled ESC could rewrite the line before approval.
    const rt = mkdtempSync(join(tmpdir(), 'bb-esc-'));
    const release = claimRuntime(rt);
    try {
      mkdirSync(join(rt, 'asks'), { recursive: true });
      writeFileSync(join(rt, 'asks', 'h1.json'), JSON.stringify({
        id: 'h1', agent: 'agent', method: 'POST',
        url: 'http://x/evil\x1b[2K\x1b[1A',
        rule: 'hold\x07me',
        bodyPreview: 'm=\x1b]0;pwned\x07done',
      }));
      const r = await sbxCli(['pending'], { SBX_RUNTIME: rt });
      assert.doesNotMatch(r.stdout, //);
      assert.doesNotMatch(r.stdout, //);
      assert.match(r.stdout, /http:\/\/x\/evil/, 'printable content survives');
      // The OSC sequence (`ESC ] 0 ; pwned BEL`) is consumed whole — only
      // the printable text around it remains.
      assert.match(r.stdout, /m=done/, 'printable content survives');
    } finally {
      release();
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('the first answer wins: a second approve/deny exits 1, "already answered", and writes nothing', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-first-'));
    const release = claimRuntime(rt);
    try {
      mkdirSync(join(rt, 'asks'), { recursive: true });
      writeFileSync(join(rt, 'asks', 'h1.json'), JSON.stringify({
        id: 'h1', agent: 'agent', method: 'POST', url: 'http://x/hold', rule: 'r', bodyPreview: 'b',
      }));
      const first = await sbxCli(['approve', 'h1'], { SBX_RUNTIME: rt });
      assert.equal(first.stdout.trim(), 'approved h1');
      for (const args of [['deny', 'h1', 'too', 'late'], ['approve', 'h1']]) {
        const e = await sbxCli(args, { SBX_RUNTIME: rt }).then(() => null, (x) => x);
        assert.equal(e?.code, 1, `${args[0]} after an answer must exit 1`);
        assert.match(e.stderr, /h1 already answered/);
        assert.equal(e.stdout, '', 'the loser prints no approved/denied line');
      }
      assert.deepEqual(JSON.parse(readFileSync(join(rt, 'answers', 'h1.json'), 'utf8')), { decision: 'allow' });
      assert.deepEqual(readdirSync(join(rt, 'answers')), ['h1.json'], 'no tmp file left behind');
    } finally {
      release();
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('a late approve/deny of a hold that was already settled says "already decided" (exit 1), not "approved"', { timeout: 30000 }, async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-late-'));
    const release = claimRuntime(rt);
    const logs = [];
    const events = [];
    const q = createHolds({ log: (o) => logs.push(o), runtime: rt, timeoutMs: 20000, pollMs: 10,
      onEvent: (e) => events.push(e), onApprove: () => {}, onDeny: () => {} });
    const until = async (cond, what) => {
      for (const t0 = Date.now(); !cond(); await new Promise((r) => setTimeout(r, 10))) {
        if (Date.now() - t0 > 5000) throw new Error(`timed out: ${what}`);
      }
    };
    try {
      for (const args of [['approve', 'h1'], ['deny', 'h2', 'nope']]) {
        const id = args[1];
        const held = q.add({ agent: 'a', method: 'POST', url: 'http://x/hold', headers: {}, preview: 'm=1', bodyBytes: 3, sock: {}, cres: {}, note: 'test hold' });
        assert.equal(held, id);
        await until(() => events.some((e) => e.type === 'ask' && e.ask.id === id), `ask ${id}`);
        const askText = readFileSync(join(rt, 'asks', `${id}.json`), 'utf8');
        // Settle it through the files API (another answer wins) ...
        writeFileSync(join(rt, 'answers', `${id}.tmp`), JSON.stringify({ decision: 'allow' }));
        renameSync(join(rt, 'answers', `${id}.tmp`), join(rt, 'answers', `${id}.json`));
        await until(() => events.some((e) => e.type === 'decided' && e.id === id), `decided ${id}`);
        // ... then the CLI's view is the instant before the settle: the ask file is still there.
        writeFileSync(join(rt, 'asks', `${id}.json`), askText);
        const e = await sbxCli(args, { SBX_RUNTIME: rt }).then(() => null, (x) => x);
        assert.ok(e, `${args[0]} of a settled hold must fail`);
        assert.equal(e.code, 1);
        assert.match(e.stderr, new RegExp(`${id} already decided`));
        assert.equal(e.stdout, '', 'no approved/denied line');
        assert.ok(logs.some((l) => l.ev === 'stale-answer' && l.id === id), 'the proxy saw the late answer as stale');
        assert.deepEqual(readdirSync(join(rt, 'answers')), [], 'no answer or marker left behind');
      }
    } finally {
      q.close();
      release();
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('a timely approve of a live hold still prints "approved" (exit 0)', { timeout: 30000 }, async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-live-'));
    const release = claimRuntime(rt);
    const events = [];
    const q = createHolds({ log: () => {}, runtime: rt, timeoutMs: 20000, pollMs: 10,
      onEvent: (e) => events.push(e), onApprove: () => {}, onDeny: () => {} });
    try {
      q.add({ agent: 'a', method: 'POST', url: 'http://x/hold', headers: {}, preview: 'm=1', bodyBytes: 3, sock: {}, cres: {}, note: 'test hold' });
      const r = await sbxCli(['approve', 'h1'], { SBX_RUNTIME: rt });
      assert.equal(r.stdout.trim(), 'approved h1');
      assert.equal(r.stderr, '');
      assert.ok(events.some((e) => e.type === 'decided' && e.decision === 'allow'));
    } finally {
      q.close();
      release();
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('pending and approve refuse stale asks with no live proxy', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-stale-'));
    try {
      mkdirSync(join(rt, 'asks'), { recursive: true });
      writeFileSync(join(rt, 'asks', 'h1.json'), JSON.stringify({
        id: 'h1', agent: 'agent', method: 'POST',
        url: 'http://x/hold', rule: 'r', bodyPreview: 'b',
      }));
      const pErr = await sbxCli(['pending'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
      assert.ok(pErr, 'pending must fail with no live proxy');
      assert.equal(pErr.code, 1);
      assert.match(pErr.stderr, /no live proxy/);
      const aErr = await sbxCli(['approve', 'h1'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
      assert.ok(aErr, 'approve must fail with no live proxy');
      assert.equal(aErr.code, 1);
      assert.match(aErr.stderr, /no live proxy/);
      assert.ok(!existsSync(join(rt, 'answers', 'h1.json')), 'no answer file written');
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });
});

describe('sbx cli over the file channel', () => {
  let RT, CA, tlsUp, proxy, PORT;
  const sbx = (...args) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, SBX_RUNTIME: RT } });

  async function waitFor(cond, what, timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  before(async () => {
    RT = mkdtempSync(join(tmpdir(), 'bb-c-'));
    await ensureCA(join(RT, 'certs'));
    const kc = await certFor(join(RT, 'certs'), '127.0.0.1');
    CA = join(RT, 'certs', 'ca.pem');
    tlsUp = await startHttps(kc);
    proxy = createProxy({ port: 0,
      logFile: join(RT, 'mitm.log'), upstreamCa: CA, runtime: RT,
      clientIdleMs: 500, unsafeTestOnly: { allowLoopback: true },
      gateFor: pathGate('/hold', 'path matches /hold'), hold: { timeoutMs: 30000, pollMs: 25 } });
    ({ port: PORT } = await proxy.ready);
  });
  after(async () => {
    try {
      await proxy?.close();
      await tlsUp?.close();
    } finally {
      if (RT) rmSync(RT, { recursive: true, force: true });
    }
  });

  it('pending lists a parked request with its agent, approve releases it', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    const p = execA('curl', ['-s', '--max-time', '30', '-x', PROXY,
      '--cacert', CA, '--data', 'm=CLITEST', `${tlsUp.url}hold`],
      { encoding: 'latin1' });
    await waitFor(async () => (await sbx('pending')).stdout.includes('CLITEST'),
      'sbx pending to list CLITEST');
    const out = (await sbx('pending')).stdout;
    const id = out.split(' ')[0];
    assert.match(out, new RegExp(`${id} tcp POST`));
    assert.equal((await sbx('approve', id)).stdout.trim(), `approved ${id}`);
    assert.match((await p).stdout, /CLITEST/);
    assert.equal((await sbx('pending')).stdout.trim(), 'nothing held');
  });

  it('deny carries the reason', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    const p = execA('curl', ['-s', '--max-time', '30', '-x', PROXY,
      '--cacert', CA, '--data', 'm=CLIDENY', `${tlsUp.url}hold`],
      { encoding: 'latin1' });
    await waitFor(async () => (await sbx('pending')).stdout.includes('CLIDENY'),
      'sbx pending to list CLIDENY');
    const id = (await sbx('pending')).stdout.split(' ')[0];
    assert.equal((await sbx('deny', id, 'nope')).stdout.trim(), `denied ${id}`);
    assert.match((await p).stdout, /denied: nope/);
  });

  it('approve of an unknown id exits 1', async () => {
    const err = await sbx('approve', 'h9999').then(() => null, (e) => e);
    assert.equal(err?.code, 1);
    assert.match(err.stderr, /unknown h9999/);
    assert.equal(err.stdout, '', 'unknown ids write nothing on stdout');
  });

  it('log lines name the agent', async () => {
    const PROXY = `http://127.0.0.1:${PORT}`;
    await execA('curl', ['-s', '--max-time', '5', '-x', PROXY,
      '--cacert', CA, `${tlsUp.url}?m=clilog`], { encoding: 'latin1' });
    const log = readFileSync(join(RT, 'mitm.log'), 'latin1');
    assert.match(log, /"agent":"tcp"/);
    assert.doesNotMatch(log, /"client":"c\d+"/);
  });
});

describe('sbx run usage (no sandbox needed)', () => {
  const runCli = (args, env = {}) => execA('node', [CLI, ...args],
    { encoding: 'latin1', env: { ...process.env, ...env } });

  it('run --help names the run form', async () => {
    const r = await runCli(['--help']);
    assert.match(r.stdout, /run \[--mode/);
  });

  it('run without -- is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--mode', 'auto']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
    assert.match(err.stderr, /usage: sbx/);
    assert.equal(err.stdout, '', 'usage writes nothing on stdout');
  });

  it('run with a bad mode is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--mode', 'nope', '--', 'true']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });

  it('run with no command after -- is a usage error (exit 2)', async () => {
    const err = await runCli(['run', '--']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
  });

  it('diff with no overlay writes nothing on stdout (exit 1)', async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-c-noov-'));
    try {
      const err = await runCli(['diff'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
      assert.equal(err?.code, 1);
      assert.equal(err.stdout, '', 'no-overlay writes nothing on stdout');
      assert.match(err.stderr, /no overlay/);
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });
});

describe('sbx run sandboxed (needs bwrap+unix+socat+curl)', () => {
  let root, home, proj, projB, rt, plainUp;
  let CAN_RUN = false;
  let SKIP_WHY = '';

  before(async () => {
    const p = join(tmpdir(), `bb-crprobe-${process.pid}.sock`);
    const unixOk = await new Promise((resolve) => {
      const s = net.createServer();
      s.on('error', () => resolve(false));
      s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
    });
    if (!bwrapUsable()) SKIP_WHY = 'needs bwrap';
    else if (!unixOk) SKIP_WHY = 'unix socket bind blocked here';
    else if (!hasBin('socat') || !hasBin('curl')) SKIP_WHY = 'needs socat and curl';
    else CAN_RUN = true;
    if (!CAN_RUN) return;
    root = mkdtempSync(join(tmpdir(), 'bb-cr-'));
    home = join(root, 'home'); proj = join(root, 'proj'); projB = join(root, 'projB'); rt = join(root, 'rt');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    mkdirSync(projB, { recursive: true });
    mkdirSync(rt, { recursive: true });
    writeFileSync(join(proj, 'agent.txt'), 'cli run project\n');
    writeFileSync(join(projB, 'agent.txt'), 'cli run second project\n');
    plainUp = await startHttp();
  });
  after(async () => {
    try {
      await plainUp?.close();
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  // t.skip() marks but does not abort: callers must `return` when this is true.
  const skipIfBlocked = (t) => {
    if (!CAN_RUN) {
      t.skip(`sbx run blocked here (${SKIP_WHY}); run in a real shell or CI`);
      return true;
    }
    return false;
  };

  async function waitFor(cond, what, timeoutMs = 20000) {
    const t0 = Date.now();
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Atomic answer write, exactly like `sbx approve`.
  const answer = (id, obj) => {
    const dir = join(rt, 'answers');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, join(dir, `${id}.json`));
  };

  // Spawn `sbx run` against the fixture; the sandbox's project is `proj`
  // unless the caller passes another cwd (the claim test runs the second
  // `sbx run` from a different project on the same SBX_RUNTIME).
  function spawnRun(extraArgs, command, cwd = proj) {
    const child = spawn('node', [CLI, 'run', ...extraArgs, '--', ...command], {
      cwd,
      env: { ...process.env, HOME: home, SBX_RUNTIME: rt, SBX_UNSAFE_TEST_ALLOW_LOOPBACK: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const closed = new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`sbx run timeout: out=${out} err=${err}`)); }, 45000);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    return { child, out: () => out, err: () => err, closed };
  }

  it('--json emits an ask line then a done line with the agent exit code', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'auto', '--json'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIJSON http://127.0.0.1:${plainUp.port}/hold >/dev/null; exit 3`]);
    const id = await waitFor(() => {
      const m = /"ev":"ask","id":"(h\d+)"/.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'allow' });
    const code = await r.closed;
    assert.equal(code, 3, `stderr: ${r.err()}`);
    const lines = r.out().trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, `stdout must carry exactly ask+decided+done: ${r.out()}`);
    assert.equal(lines[0].ev, 'ask');
    assert.match(lines[0].url, /\/hold/);
    assert.deepEqual(lines[1], { ev: 'decided', id, decision: 'allow' });
    assert.deepEqual(lines[2], { ev: 'done', exit: 3 });
  });

  it('--json --mode ask: a denied hold prints ask, decided for the same id, then done', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'ask', '--json'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIDENY http://127.0.0.1:${plainUp.port}/hold >/dev/null; exit 0`]);
    const id = await waitFor(() => {
      const m = /"ev":"ask","id":"(h\d+)"/.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'deny', reason: 'nope' });
    const code = await r.closed;
    assert.equal(code, 0, `stderr: ${r.err()}`);
    const lines = r.out().trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.ev), ['ask', 'decided', 'done'], r.out());
    assert.equal(lines[0].id, id);
    assert.deepEqual(lines[1], { ev: 'decided', id, decision: 'deny', reason: 'nope' });
  });

  it('human mode prints a decided line with its reason', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'ask'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIDECIDED http://127.0.0.1:${plainUp.port}/hold >/dev/null`]);
    const id = await waitFor(() => {
      const m = /ask (h\d+) /.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'deny', reason: 'no thanks' });
    await r.closed;
    assert.match(r.out(), new RegExp(`^decided ${id} deny \\(no thanks\\)$`, 'm'));
  });

  it('human mode prints ask and done lines and mirrors the exit code', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--mode', 'auto'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLIHUMAN http://127.0.0.1:${plainUp.port}/hold`]);
    const id = await waitFor(() => {
      const m = /ask (h\d+) /.exec(r.out());
      return m && m[1];
    }, 'ask line on stdout');
    answer(id, { decision: 'allow' });
    const code = await r.closed;
    assert.equal(code, 0, `stderr: ${r.err()}`);
    assert.match(r.out(), new RegExp(`ask ${id} .*POST.*/hold`));
    assert.match(r.out(), /done exit 0/);
  });

  // 6.1: every line `sbx` prints goes through one sanitizer. The agent
  // leaves an ESC + U+202E dir holding a non-UTF-8 file; the overlay
  // refusal names that dir, so the `run failed:` line would carry raw
  // terminal control without the `out`/`err` printers.
  const EVIL_SH = 'd=$(printf "ev\\033[2K\\033[1Ail\\xe2\\x80\\xaeX"); mkdir "$d"; ' +
    'touch "$d/$(printf "\\xff\\xfe")"';
  const assertClean = (combined, where) => {
    assert.match(combined, /run failed/, `the refusal surfaces (${where})`);
    assert.doesNotMatch(combined, /[ -	-]/,
      `no C0 control bytes incl. ESC reach the terminal (${where})`);
    assert.ok(!combined.includes('\u202e'), `no bidi override reaches the terminal (${where})`);
  };

  it('run --overlay sanitizes agent-chosen bytes on the failure line', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--overlay'], ['bash', '-c', EVIL_SH]);
    const code = await r.closed;
    assert.equal(code, 1, `out=${r.out()} err=${r.err()}`);
    assertClean(r.out() + r.err(), 'plain');
  });

  it('run --overlay --json sanitizes agent-chosen bytes on the failure line', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const r = spawnRun(['--overlay', '--json'], ['bash', '-c', EVIL_SH]);
    const code = await r.closed;
    assert.equal(code, 1, `out=${r.out()} err=${r.err()}`);
    assertClean(r.out() + r.err(), 'json');
    for (const line of r.out().trim().split('\n').filter(Boolean)) {
      JSON.parse(line); // stdout stays parseable JSON lines
    }
  });

  it('a second sbx run on one SBX_RUNTIME is refused; the first hold stays approvable', { timeout: 120000 }, async (t) => {
    if (skipIfBlocked(t)) return;
    const sbx = (args) => execA('node', [CLI, ...args],
      { encoding: 'latin1', env: { ...process.env, SBX_RUNTIME: rt } });
    const a = spawnRun(['--mode', 'ask'],
      ['bash', '-c', `curl -s --max-time 10 --data m=CLAIMCLI http://127.0.0.1:${plainUp.port}/hold`]);
    try {
      const id = await waitFor(() => {
        const m = /ask (h\d+) /.exec(a.out());
        return m && m[1];
      }, 'first run to park its hold');
      // A second run, from a different project on the same runtime, is refused.
      const b = spawnRun(['--mode', 'ask'], ['bash', '-c', 'exit 0'], projB);
      const bCode = await b.closed;
      assert.equal(bCode, 1, `second run must exit 1: out=${b.out()} err=${b.err()}`);
      assert.match(b.err(), new RegExp(`run failed: runtime .* is in use by pid ${a.child.pid}`),
        'refusal names the first run on stderr');
      // The first hold survived: still pending, still approvable through sbx.
      const p = await sbx(['pending']);
      assert.match(p.stdout, new RegExp(id), 'h1 still listed');
      await sbx(['approve', id]);
      const aCode = await a.closed;
      assert.equal(aCode, 0, `first run settles after approve: out=${a.out()} err=${a.err()}`);
      assert.match(a.out(), /done exit 0/);
    } finally {
      try { a.child.kill('SIGKILL'); } catch {}
      await a.closed.catch(() => {});
    }
  });
});

const SOCKET_OK = await new Promise((resolve) => {
  const p = join(tmpdir(), `bb-cprobe-${process.pid}.sock`);
  const s = net.createServer();
  s.on('error', () => resolve(false));
  s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
});

describe('sbx run process flags (needs bwrap + socket)', () => {
  const skip = !bwrapUsable() ? 'needs bwrap; run in a real shell or CI'
    : (!SOCKET_OK ? 'unix socket bind blocked here; run in a real shell or CI' : false);

  it('the shebang gives sbx --max-semi-space-size=1 (read from /proc cmdline while it runs)',
    { skip, timeout: 60000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), 'bb-c-flag-'));
      const home = join(root, 'h'); const proj = join(root, 'p');
      mkdirSync(home); mkdirSync(proj);
      // CLI is spawned directly: the kernel runs the shebang, `env -S` splits the flag.
      const child = spawn(CLI, ['run', '--', 'sleep', '2'],
        { cwd: proj, env: { ...process.env, HOME: home, SBX_RUNTIME: join(root, 'rt') } });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      const closed = new Promise((resolve) => child.on('close', resolve));
      try {
        await new Promise((r) => setTimeout(r, 700)); // sbx up, `sleep 2` still running
        const argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
        assert.ok(argv.includes('--max-semi-space-size=1'), `cmdline: ${JSON.stringify(argv)}`);
        assert.equal(await closed, 0, err);
      } finally {
        child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    });

  it('heldBodyMaxMB in the config file takes effect: a 100 KB POST is held, a 2 MB POST over a 1 MB cap is 403 body too large to hold',
    { skip: skip || (hasBin('curl') && hasBin('socat') ? false : 'needs curl and socat'), timeout: 90000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), 'bb-c-cap-'));
      const home = join(root, 'h'); const proj = join(root, 'p'); const xdg = join(root, 'xdg');
      mkdirSync(home); mkdirSync(proj); mkdirSync(join(xdg, 'barebox'), { recursive: true });
      writeFileSync(join(xdg, 'barebox', 'config.json'), '{"heldBodyMaxMB":1}\n');
      const up = await startHttp();
      let out = '', err = '';
      try {
        // A 100 KB body is under the 1 MB cap, so it is held (curl gives up, 000); only
        // the 2 MB body is refused. The small one is what fails if the key stops scaling MB to bytes.
        const post = (bytes, t) => `head -c ${bytes} /dev/zero | tr '\\0' a | curl -s -w '\\nHTTP:%{http_code}\\n' --max-time ${t} --data-binary @- http://127.0.0.1:${up.port}/hold`;
        const child = spawn('node', [CLI, 'run', '--', 'bash', '-c',
          `${post(102400, 3)}; ${post(2097152, 20)}; exit 0`],
        { cwd: proj, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg,
          SBX_RUNTIME: join(root, 'rt'), SBX_UNSAFE_TEST_ALLOW_LOOPBACK: '1' } });
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        const code = await new Promise((resolve, reject) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`sbx run timeout: ${out}${err}`)); }, 60000);
          child.on('error', (e) => { clearTimeout(t); reject(e); });
          child.on('close', (c) => { clearTimeout(t); resolve(c); });
        });
        assert.equal(code, 0, err);
        assert.deepEqual([...(err + out).matchAll(/HTTP:(\d+)/g)].map((m) => m[1]), ['000', '403'],
          'a 100 KB body is held, a 2 MB body is refused');
        assert.match(err + out, /body too large to hold/);
      } finally {
        await up.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
});
