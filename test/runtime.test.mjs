// One proxy owns a runtime, enforced: claimRuntime unit tests (no bwrap,
// no sockets — owner files and /proc only).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimRuntime, takeOverStale, runtimePaths } from '../src/runtime.js';

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

  it('a new claim succeeds after release', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    claimRuntime(rt)();
    const release = claimRuntime(rt);
    release();
  });

  it('a dead pid is stale and taken over', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const dead = spawnSync('true').pid;
    assert.ok(dead, 'spawned a pid');
    writeFileSync(runtimePaths(rt).owner, JSON.stringify({ pid: dead, start: '12345' }));
    const release = claimRuntime(rt);
    try {
      const owner = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
      assert.equal(owner.pid, process.pid);
    } finally {
      release();
    }
  });

  it('a reused pid with a wrong start is stale and taken over', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, JSON.stringify({ pid: process.pid, start: 'wrong' }));
    const release = claimRuntime(rt);
    try {
      const owner = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.start, 'wrong');
    } finally {
      release();
    }
  });

  it('a garbage owner file is taken over', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, 'not json{{{');
    const release = claimRuntime(rt);
    try {
      const owner = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
      assert.equal(owner.pid, process.pid);
    } finally {
      release();
    }
  });

  it("release never deletes another process's claim", () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const release = claimRuntime(rt);
    const other = JSON.stringify({ pid: 1, start: 'elsewhere' });
    writeFileSync(runtimePaths(rt).owner, other);
    release();
    assert.equal(readFileSync(runtimePaths(rt).owner, 'utf8'), other, 'foreign claim untouched');
    release();
  });
});

describe('claimRuntime: startup races', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-claimrace-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const liveClaim = () => {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    return { pid: process.pid, start };
  };

  it('a claim leaves a whole owner and no temp file', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const release = claimRuntime(rt);
    try {
      const owner = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.start, liveClaim().start);
      assert.deepEqual(readdirSync(rt), ['owner']);
    } finally {
      release();
    }
  });

  const DEAD = JSON.stringify({ pid: 2 ** 22 + 7, start: '1' });
  const markerOf = (rt, raw) => `${runtimePaths(rt).owner}.takeover-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;

  it('a third starter at every step of a takeover never gets the runtime', () => {
    const names = ['renameSync', 'linkSync', 'unlinkSync', 'writeFileSync'];
    const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
    const run = (inject) => {
      const rt = mkdtempSync(join(root, 'rt-'));
      const a = liveClaim();
      writeFileSync(runtimePaths(rt).owner, JSON.stringify(a));
      const aBytes = readFileSync(runtimePaths(rt).owner, 'utf8');
      let calls = 0;
      let inside = false;
      let cErr = null;
      for (const n of names) {
        fs[n] = (...args) => {
          if (!inside) {
            calls++;
            if (calls === inject) {
              inside = true;
              try { claimRuntime(rt); } catch (e) { cErr = e; } finally { inside = false; }
            }
          }
          return orig[n](...args);
        };
      }
      let bErr = null;
      try {
        takeOverStale(rt, DEAD, { pid: 424242, start: '9' });
      } catch (e) {
        bErr = e;
      } finally {
        for (const n of names) fs[n] = orig[n];
      }
      return { calls, cErr, bErr, owner: readFileSync(runtimePaths(rt).owner, 'utf8'), aBytes };
    };
    const N = run(0).calls;
    assert.ok(N >= 1);
    for (let n = 1; n <= N; n++) {
      const r = run(n);
      assert.match(String(r.cErr?.message), /in use/, `C refused at call ${n}`);
      assert.match(String(r.bErr?.message), /in use/, `B refused at call ${n}`);
      assert.equal(r.owner, r.aBytes, `A's claim intact at call ${n}`);
    }
  });

  it('a stale claim is replaced, never removed or renamed away', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const owner = runtimePaths(rt).owner;
    writeFileSync(owner, DEAD);
    const seen = [];
    const { unlinkSync, renameSync } = fs;
    fs.unlinkSync = (p) => { if (p === owner) seen.push('unlink'); return unlinkSync(p); };
    fs.renameSync = (from, to) => { if (from === owner) seen.push('rename'); return renameSync(from, to); };
    let release;
    try {
      release = claimRuntime(rt);
    } finally {
      fs.unlinkSync = unlinkSync;
      fs.renameSync = renameSync;
    }
    try {
      assert.deepEqual(seen, []);
      assert.equal(JSON.parse(readFileSync(owner, 'utf8')).pid, process.pid);
    } finally {
      release();
    }
  });

  it('a dead takeover marker fails closed and is left untouched', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, DEAD);
    const marker = markerOf(rt, DEAD);
    const dead = JSON.stringify({ pid: 2 ** 22 + 9, start: '1' });
    writeFileSync(marker, dead);
    assert.throws(() => claimRuntime(rt), (e) => e.message.includes(marker) && /is gone/.test(e.message));
    assert.equal(readFileSync(marker, 'utf8'), dead);
    assert.equal(readFileSync(runtimePaths(rt).owner, 'utf8'), DEAD);
  });

  it('a live takeover marker means in use', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, DEAD);
    writeFileSync(markerOf(rt, DEAD), JSON.stringify(liveClaim()));
    assert.throws(() => claimRuntime(rt), new RegExp(`in use by pid ${process.pid}`));
  });

  it('a successful takeover leaves no marker and no temp file', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, DEAD);
    const release = claimRuntime(rt);
    try {
      assert.deepEqual(readdirSync(rt), ['owner']);
    } finally {
      release();
    }
  });

  it('a failed write leaves the stale owner in place and nothing else', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, DEAD);
    assert.throws(() => takeOverStale(rt, DEAD, { pid: 1n }), TypeError);
    assert.deepEqual(readdirSync(rt), ['owner'], 'no marker, no temp file');
    assert.equal(readFileSync(runtimePaths(rt).owner, 'utf8'), DEAD);
  });

  it('takeover refuses a fresh claim another starter just won and leaves it in place', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const fresh = liveClaim(); // what is on disk now: a live winner
    writeFileSync(runtimePaths(rt).owner, JSON.stringify(fresh));
    assert.throws(() => takeOverStale(rt, DEAD, { pid: 424242, start: '9' }),
      new RegExp(`in use by pid ${process.pid}`));
    assert.deepEqual(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')), fresh);
    assert.deepEqual(readdirSync(rt), ['owner'], 'no marker left');
  });

  it('takeover of the claim it judged stale succeeds, garbage and empty included', () => {
    for (const raw of ['', 'not json{', DEAD]) {
      const rt = mkdtempSync(join(root, 'rt-'));
      writeFileSync(runtimePaths(rt).owner, raw);
      const mine = liveClaim();
      takeOverStale(rt, raw, mine);
      assert.deepEqual(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')), mine);
      assert.deepEqual(readdirSync(rt), ['owner']);
    }
  });
});
