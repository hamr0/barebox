// One proxy owns a runtime, enforced: claimRuntime tests. The claim is a
// kernel-held abstract unix socket, so the races and death cases use real
// child processes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { claimRuntime, runtimePaths, shellQuote } from '../src/runtime.js';

const RUNTIME_URL = new URL('../src/runtime.js', import.meta.url).href;

/**
 * Run a script in a child node process.
 *
 * @param {string} body module code; `claimRuntime` is imported, args are `process.argv.slice(1)`
 * @param {string[]} args argv for the script
 * @param {number} timeoutMs kill after this long
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>} how it ended
 */
function spawnChild(body, args) {
  return spawn(process.execPath, ['--input-type=module', '-e',
    `import { claimRuntime } from ${JSON.stringify(RUNTIME_URL)};\n${body}`, '--', ...args]);
}

function runChild(body, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnChild(body, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

describe('claimRuntime: one live proxy per runtime', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-claim-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a first claim succeeds; a second names our pid', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const release = claimRuntime(rt);
    try {
      const owner = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.throws(() => claimRuntime(rt), new RegExp(`in use by pid ${process.pid}`));
    } finally {
      release();
    }
  });

  it('a bind that fails with no live owner is not reported as in use', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const orig = net.Server.prototype.listen;
    // @ts-expect-error stub the bind so `server.listening` stays false
    net.Server.prototype.listen = function () { return this; };
    try {
      assert.throws(() => claimRuntime(rt), /could not be locked/);
      try {
        claimRuntime(rt);
        assert.fail('must throw');
      } catch (e) {
        assert.doesNotMatch(String((e instanceof Error ? e.message : String(e))), /in use/);
      }
    } finally {
      net.Server.prototype.listen = orig;
    }
  });

  it('a new claim succeeds after release', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    claimRuntime(rt)();
    const release = claimRuntime(rt);
    release();
  });

  it('a stale release never removes a newer claim from this process', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const r1 = claimRuntime(rt);
    r1();
    const r2 = claimRuntime(rt);
    r1();
    assert.equal(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')).pid, process.pid);
    r2();
  });

  it("release is idempotent and never deletes another process's owner file", () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const release = claimRuntime(rt);
    const other = JSON.stringify({ pid: 1 });
    writeFileSync(runtimePaths(rt).owner, other);
    release();
    assert.equal(readFileSync(runtimePaths(rt).owner, 'utf8'), other, 'foreign owner file untouched');
    release();
    assert.equal(readFileSync(runtimePaths(rt).owner, 'utf8'), other, 'second release still leaves it');
    claimRuntime(rt)();
  });

  it('a stale owner file is no obstacle: dead pid, garbage, or empty', () => {
    for (const raw of [JSON.stringify({ pid: 2 ** 22 + 7 }), 'not json{{{', '']) {
      const rt = mkdtempSync(join(root, 'rt-'));
      writeFileSync(runtimePaths(rt).owner, raw);
      const release = claimRuntime(rt);
      try {
        assert.equal(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')).pid, process.pid, JSON.stringify(raw));
      } finally {
        release();
      }
    }
  });

  it('one lock per real dir: a symlinked path is in use too', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const link = join(root, 'link-to-rt');
    symlinkSync(rt, link);
    const release = claimRuntime(rt);
    try {
      assert.throws(() => claimRuntime(link), new RegExp(`in use by pid ${process.pid}`));
    } finally {
      release();
    }
  });

  it('a recreated dir at the same path gets its own lock', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const r1 = claimRuntime(rt);
    renameSync(rt, rt + '.old');
    mkdirSync(rt);
    const r2 = claimRuntime(rt);
    r1();
    r2();
  });

  it('the runtime root is 0700 whatever the umask', () => {
    const prev = process.umask(0);
    try {
      const rt = join(root, `rt-${process.pid}-${Date.now()}`);
      const release = claimRuntime(rt);
      try {
        assert.equal(statSync(rt).mode & 0o777, 0o700);
      } finally {
        release();
      }
    } finally {
      process.umask(prev);
    }
  });

  it('the owner file is 0600', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const release = claimRuntime(rt);
    try {
      assert.equal(statSync(runtimePaths(rt).owner).mode & 0o777, 0o600);
    } finally {
      release();
    }
  });

  it('shellQuote leaves safe paths alone and quotes the rest', () => {
    assert.equal(shellQuote('/tmp/sbx-a1'), '/tmp/sbx-a1');
    assert.equal(shellQuote('/tmp/my dir'), `'/tmp/my dir'`);
    assert.equal(shellQuote(`/tmp/it's`), `'/tmp/it'\\''s'`);
    for (const orig of ['/tmp/sbx-a1', '/tmp/my dir', `/tmp/it's`]) {
      const q = shellQuote(orig);
      assert.equal(execFileSync('bash', ['-c', `printf %s ${q}`], { encoding: 'utf8' }), orig);
    }
  });
});

describe('claimRuntime: kernel lock across processes', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-claimk-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stampede: 8 processes claim at one instant, exactly one wins each round', async () => {
    const body = `
      const [rt, at] = process.argv.slice(1);
      while (Date.now() < Number(at)) {}
      try {
        const release = claimRuntime(rt);
        console.log('WON');
        await new Promise((r) => setTimeout(r, 1000));
        release();
      } catch (e) {
        console.log('ERR ' + e.message);
      }`;
    for (let round = 0; round < 20; round++) {
      const rt = mkdtempSync(join(root, 'rt-'));
      const at = String(Date.now() + 1500);
      const outs = await Promise.all(Array.from({ length: 8 }, () => runChild(body, [rt, at], 15000)));
      let won = 0;
      let refused = 0;
      const other = [];
      for (const o of outs) {
        const line = o.stdout.trim();
        if (line === 'WON') won++;
        else if (/^ERR runtime .* (is in use by pid \d+ \(|could not be locked: no live owner is recorded \()/.test(line)) refused++;
        else other.push(`${line} | ${o.stderr.trim()}`);
      }
      assert.deepEqual(other, [], `round ${round}: unexpected outcomes`);
      assert.equal(won, 1, `round ${round}: winners (refused ${refused})`);
      assert.equal(refused, 7, `round ${round}: refused`);
    }
  });

  it('SIGKILL frees the runtime at once, with no manual step', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const body = `
      claimRuntime(process.argv[1]);
      console.log('ready');
      setInterval(() => {}, 1000);`;
    const child = spawnChild(body, [rt]);
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
        child.on('error', reject);
        child.on('close', () => reject(new Error('child died before ready')));
      });
      assert.throws(() => claimRuntime(rt), new RegExp(`in use by pid ${child.pid}`));
      const closed = new Promise((r) => child.on('close', r));
      child.kill('SIGKILL');
      await closed;
      const release = claimRuntime(rt);
      try {
        assert.equal(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')).pid, process.pid);
      } finally {
        release();
      }
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('the refusal is synchronous and the process still exits by itself', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const body = `
      import assert from 'node:assert/strict';
      const release = claimRuntime(process.argv[1]);
      assert.throws(() => claimRuntime(process.argv[1]), new RegExp('in use by pid ' + process.pid));
      release();`;
    const r = await runChild(body, [rt], 5000);
    assert.equal(r.timedOut, false, `hung: the refusing process hung (${r.stderr.trim()})`);
    assert.equal(r.code, 0, r.stderr);
  });

  it('unref: a held lock never keeps a process alive', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const r = await runChild('claimRuntime(process.argv[1]);', [rt], 5000);
    assert.equal(r.timedOut, false, 'a held lock kept the process alive');
    assert.equal(r.code, 0, r.stderr);
  });
});
