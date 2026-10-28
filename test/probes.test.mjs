// probes tests: the bwrap/PATH helpers. No sockets, green everywhere.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';

describe('probes (no sandbox needed)', () => {
  it('hasBin sees PATH binaries and misses absent ones', () => {
    assert.equal(hasBin('node'), true);
    assert.equal(hasBin('bb-no-such-binary'), false);
  });

  it('bwrapUsable mirrors bwrap --version', () => {
    assert.equal(typeof bwrapUsable(), 'boolean');
  });

  it('a fake bwrap on PATH counts; an empty PATH does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-probe-'));
    const savedPath = process.env.PATH;
    try {
      writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\necho bubblewrap 0.12.0\n');
      chmodSync(join(dir, 'bwrap'), 0o755);
      process.env.PATH = `${dir}${delimiter}/usr/bin:/bin`;
      assert.equal(bwrapUsable(), true);
      process.env.PATH = '';
      assert.equal(bwrapUsable(), false);
      assert.equal(hasBin('bwrap'), false);
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
