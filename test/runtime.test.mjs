// One proxy owns a runtime, enforced: claimRuntime unit tests (no bwrap,
// no sockets — owner files and /proc only).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimRuntime, runtimePaths } from '../src/runtime.js';

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
