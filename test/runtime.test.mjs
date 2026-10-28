// One proxy owns a runtime, enforced: claimRuntime unit tests (no bwrap,
// no sockets — owner files and /proc only).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

  it('a failed write leaves no owner behind (created via link, never partial)', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, JSON.stringify({ pid: 2 ** 22 + 7, start: '1' }));
    const stale = JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8'));
    assert.throws(() => takeOverStale(rt, stale, { pid: 1n }), TypeError);
    assert.deepEqual(readdirSync(rt), [], 'no owner, no temp file');
  });

  it('takeover refuses a fresh claim another starter just won, and puts it back', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const judged = { pid: 2 ** 22 + 7, start: '1' }; // what we judged stale
    const fresh = liveClaim(); // what is on disk now: a live winner
    writeFileSync(runtimePaths(rt).owner, JSON.stringify(fresh));
    assert.throws(() => takeOverStale(rt, judged, { pid: 424242, start: '9' }),
      new RegExp(`in use by pid ${process.pid}`));
    assert.deepEqual(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')), fresh);
    assert.deepEqual(readdirSync(rt), ['owner'], 'no stale file left');
  });

  it('takeover of the claim it judged stale succeeds, garbage included', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    writeFileSync(runtimePaths(rt).owner, '');
    const mine = liveClaim();
    takeOverStale(rt, null, mine);
    assert.deepEqual(JSON.parse(readFileSync(runtimePaths(rt).owner, 'utf8')), mine);
  });
});
