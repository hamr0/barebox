// Overlay (M4) tests: tracing paper over the real project.
//
// Two gates, loud like the rest of the suite:
// - bwrap mounts (agentWrite + every diff/commit over a non-empty upper):
//   needs /usr/bin/bwrap; green in a real shell and CI. This sandbox runs
//   them (bwrap works here; only unix sockets are blocked).
// - unix sockets (launch/run/sbx-run through the front door): skipped where
//   socket bind is blocked; green in a real shell and CI.
// Bwrap-free paths (validation, empty-sheet diff/commit/rollback, CLI usage)
// run everywhere — including with bwrap hidden from PATH, which proves the
// no-mount shortcut instead of merely assuming it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  lstatSync, readlinkSync, symlinkSync, chmodSync, rmSync, existsSync,
  copyFileSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import net from 'node:net';
import {
  setupOverlay, diffOverlay, commitOverlay, rollbackOverlay, undoJournal,
  finishFailedCommit, changedSince, fpNow, OverlayConflictError, DEFAULT_IGNORE,
} from '../src/overlay.js';
import { runtimePaths } from '../src/runtime.js';
import { launch } from '../src/launcher.js';
import { run } from '../src/run.js';

const execA = promisify(execFileCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/cli.js');

const BWRAP_OK = existsSync('/usr/bin/bwrap');
const BWRAP_SKIP = 'needs bwrap; run in a real shell or CI';
const SOCKET_OK = await new Promise((resolve) => {
  const p = join(tmpdir(), `bb-oprobe-${process.pid}.sock`);
  const s = net.createServer();
  s.on('error', () => resolve(false));
  s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
});
const SOCKET_SKIP = 'unix socket bind blocked here; run in a real shell or CI';

// --- helpers ---------------------------------------------------------------

/** One project fixture: edited, deleted, and kept files plus a subdir. */
function mkproj(dir) {
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'keep.txt'), 'keep\n');
  writeFileSync(join(dir, 'edit.txt'), 'orig\n');
  writeFileSync(join(dir, 'del.txt'), 'gone\n');
  writeFileSync(join(dir, 'sub', 'n.txt'), 'nested\n');
  return dir;
}

/** Independent oracle walk: content strings (not hashes), modes, targets. */
function readTree(dir) {
  /** @type {Map<string, object>} */
  const out = new Map();
  const walk = (/** @type {string} */ rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) {
        out.set(r, { type: 'd', mode: st.mode & 0o7777 });
        walk(r);
      } else if (st.isFile()) {
        out.set(r, { type: 'f', mode: st.mode & 0o7777, content: readFileSync(join(dir, r), 'utf8') });
      } else if (st.isSymbolicLink()) {
        out.set(r, { type: 'l', target: readlinkSync(join(dir, r)) });
      } else {
        out.set(r, { type: '?' });
      }
    }
  };
  walk('');
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Play the agent: mount (lower, upper) and run `script` against the merged
 * view — what `launch({overlay:true})` mounts, minus the front door (no
 * socket needed, so this runs wherever bwrap does).
 */
function agentWrite({ lower, upper, work, script }) {
  const merged = mkdtempSync(join(dirname(upper), 't-merged-'));
  try {
    const res = spawnSync('bwrap',
      ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib64', '/lib64',
        '--overlay-src', lower, '--overlay', upper, work, merged,
        '--', '/usr/bin/bash', '-c', `M=${sqTest(merged)}; ${script}`],
      { encoding: 'utf8', timeout: 60000 });
    if (res.error) throw res.error;
    assert.equal(res.status, 0, `agent phase failed: ${res.stderr}`);
  } finally {
    rmSync(merged, { recursive: true, force: true });
  }
}

/** Run a callback with bwrap hidden: proves the no-mount shortcut. */
function withoutBwrap(fn) {
  const binDir = mkdtempSync(join(tmpdir(), 'bb-nobin-'));
  symlinkSync(process.execPath, join(binDir, 'node'));
  const prev = process.env.PATH;
  process.env.PATH = binDir;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
    rmSync(binDir, { recursive: true, force: true });
  }
}

const sbx = (args, env = {}) => execA('node', [CLI, ...args],
  { encoding: 'latin1', timeout: 60000, env: { ...process.env, ...env } });

const sqTest = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Byte-for-byte project comparison: recursive hash of content, modes and
 * symlink targets. Every "unchanged" or "exact" claim below compares these.
 */
function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (/** @type {string} */ rel) => {
    const abs = join(dir, rel);
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      h.update(`d:${rel}:${(st.mode & 0o7777).toString(8)}\0`);
      for (const n of readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n);
    } else if (st.isFile()) {
      h.update(`f:${rel}:${(st.mode & 0o7777).toString(8)}:`);
      h.update(readFileSync(abs));
      h.update('\0');
    } else if (st.isSymbolicLink()) {
      h.update(`l:${rel}:${readlinkSync(abs)}\0`);
    } else {
      h.update(`?:${rel}\0`);
    }
  };
  walk('');
  return h.digest('hex');
}

describe('setupOverlay (no sandbox needed)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-os-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('validates its inputs', () => {
    assert.throws(() => setupOverlay({ runtime: '', agent: 'a', proj: '/p' }), /runtime/);
    assert.throws(() => setupOverlay({ runtime: '/r', agent: '../evil', proj: '/p' }), /bad agent name/);
    // Setup-independent: a temp runtime (not /r) so the missing project
    // reports ENOENT no matter who runs it — and leaves nothing behind.
    {
      const rt = mkdtempSync(join(root, 'rt-val-'));
      const missing = join(rt, 'no-such-proj');
      assert.throws(() => setupOverlay({ runtime: rt, agent: 'a', proj: missing }), /ENOENT/);
      assert.ok(!existsSync(join(rt, 'overlay')), 'a missing project leaves no overlay folders behind');
    }
  });

  it('ignores node_modules by default (Q3)', () => {
    assert.ok(DEFAULT_IGNORE.includes('node_modules'), 'default ignore covers node_modules');
  });

  it('snapshots the project as the conflict baseline', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper, work } = setupOverlay({ runtime: rt, agent: 'base', proj });
    assert.ok(existsSync(upper) && existsSync(work));
    const manifest = JSON.parse(readFileSync(join(rt, 'overlay', 'base', 'manifest.json'), 'utf8'));
    assert.equal(manifest.proj, proj);
    assert.ok(manifest.base['edit.txt'], 'base fingerprints project files');
    assert.ok(!Object.keys(manifest.base).some((k) => k.includes('upper') || k.includes('overlay')),
      'snapshot covers the project only, never the runtime');
  });

  it('re-snapshots when the upper is empty (failed spawns never wedge)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 're', proj });
    writeFileSync(join(proj, 'later.txt'), 'later\n');
    setupOverlay({ runtime: rt, agent: 're', proj }); // must not throw
    const manifest = JSON.parse(readFileSync(join(rt, 'overlay', 're', 'manifest.json'), 'utf8'));
    assert.ok(manifest.base['later.txt'], 'second setup re-snapshotted');
  });

  it('refuses leftover uncommitted changes and foreign projects', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const other = mkproj(mkdtempSync(join(root, 'q-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'left', proj });
    writeFileSync(join(rt, 'overlay', 'left', 'upper', 'stray.txt'), 'x');
    assert.throws(() => setupOverlay({ runtime: rt, agent: 'left', proj }), /uncommitted/);
    assert.throws(() => setupOverlay({ runtime: rt, agent: 'left', proj: other }), /belongs to/);
  });
});

describe('diff over hand-built uppers (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-od-'));
  });
  after(() => {
    for (const rt of readdirSync(root).filter((n) => n.startsWith('rt-'))) {
      try { rollbackOverlay({ runtime: join(root, rt), agent: 'd' }); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('an empty upper is no changes without mounting (bwrap hidden)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'd', proj });
    assert.deepEqual(withoutBwrap(() => diffOverlay({ runtime: rt, agent: 'd' })), []);
  });

  it('lists added/modified and drops identical rewrites', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'd', proj });
    writeFileSync(join(upper, 'new.txt'), 'new\n');
    writeFileSync(join(upper, 'edit.txt'), 'changed\n');
    writeFileSync(join(upper, 'keep.txt'), 'keep\n'); // identical copy-up: not a change
    const got = diffOverlay({ runtime: rt, agent: 'd' }).map((c) => [c.status, c.path, c.conflict]);
    assert.deepEqual(got, [['modified', 'edit.txt', false], ['added', 'new.txt', false]]);
    rollbackOverlay({ runtime: rt, agent: 'd' });
  });

  it('flags mid-run project changes without throwing', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'd', proj });
    writeFileSync(join(upper, 'edit.txt'), 'agent\n');
    writeFileSync(join(proj, 'edit.txt'), 'user\n'); // mid-run user edit
    const [change] = diffOverlay({ runtime: rt, agent: 'd' });
    assert.equal(change.status, 'modified');
    assert.equal(change.conflict, true);
    assert.match(change.reason ?? '', /during the run/);
    assert.throws(() => commitOverlay({ runtime: rt, agent: 'd' }), OverlayConflictError);
    rollbackOverlay({ runtime: rt, agent: 'd' });
  });

  it('throws when no overlay exists', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    assert.throws(() => diffOverlay({ runtime: rt, agent: 'ghost' }), /no overlay/);
  });
});

describe('commit and rollback (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-oc-'));
  });
  after(() => {
    for (const rt of readdirSync(root).filter((n) => n.startsWith('rt-'))) {
      try { rollbackOverlay({ runtime: join(root, rt), agent: 'c' }); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('applies added and modified files and preserves modes', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    writeFileSync(join(upper, 'new.txt'), 'new\n');
    writeFileSync(join(upper, 'edit.txt'), 'changed\n');
    chmodSync(join(upper, 'new.txt'), 0o600);
    const res = commitOverlay({ runtime: rt, agent: 'c' });
    assert.deepEqual(res, { committed: ['edit.txt', 'new.txt'], skipped: [] });
    assert.equal(readFileSync(join(proj, 'new.txt'), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'changed\n');
    assert.equal(lstatSync(join(proj, 'new.txt')).mode & 0o7777, 0o600);
    assert.equal(readFileSync(join(proj, 'keep.txt'), 'utf8'), 'keep\n');
    // Fresh sheet: a second commit is a no-op, and diff is empty.
    assert.deepEqual(commitOverlay({ runtime: rt, agent: 'c' }), { committed: [], skipped: [] });
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'c' }), []);
  });

  it('recreates symlinks', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    symlinkSync('keep.txt', join(upper, 'link.txt'));
    const res = commitOverlay({ runtime: rt, agent: 'c' });
    assert.deepEqual(res.committed, ['link.txt']);
    assert.equal(readlinkSync(join(proj, 'link.txt')), 'keep.txt');
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  it('an empty upper commits nothing without mounting (bwrap hidden)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'c', proj });
    assert.deepEqual(
      withoutBwrap(() => commitOverlay({ runtime: rt, agent: 'c' })),
      { committed: [], skipped: [] });
  });

  it('refuses conflicts atomically: nothing is written', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    writeFileSync(join(upper, 'edit.txt'), 'agent\n');
    writeFileSync(join(upper, 'keep.txt'), 'agent-keep\n');
    writeFileSync(join(proj, 'edit.txt'), 'user\n'); // mid-run user edit
    let err = null;
    try {
      commitOverlay({ runtime: rt, agent: 'c' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof OverlayConflictError, `expected OverlayConflictError, got ${err}`);
    assert.deepEqual(err.conflicts.map((c) => c.path), ['edit.txt']);
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'user\n');
    assert.equal(readFileSync(join(proj, 'keep.txt'), 'utf8'), 'keep\n',
      'the clean file must not slip through a refused commit');
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  it('skip commits the rest and keeps the conflict on the paper', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    writeFileSync(join(upper, 'edit.txt'), 'agent\n');
    writeFileSync(join(upper, 'keep.txt'), 'agent-keep\n');
    writeFileSync(join(proj, 'edit.txt'), 'user\n');
    const res = commitOverlay({ runtime: rt, agent: 'c', onConflict: 'skip' });
    assert.deepEqual(res.committed, ['keep.txt']);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].path, 'edit.txt');
    assert.match(res.skipped[0].reason, /during the run/);
    assert.equal(readFileSync(join(proj, 'keep.txt'), 'utf8'), 'agent-keep\n');
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'user\n');
    // The conflict stays uncommitted: still listed, still refusing.
    assert.equal(diffOverlay({ runtime: rt, agent: 'c' }).length, 1);
    assert.throws(() => commitOverlay({ runtime: rt, agent: 'c' }), /refused/);
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  // (The old chmod-500 preflight test is gone with the preflight: cases 2 and
  // 6 of the 1E block below cover unwritable destinations through the journal.)

  it('commit strips setuid/setgid bits but keeps the low bits', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    writeFileSync(join(upper, 'suid.txt'), 's\n');
    chmodSync(join(upper, 'suid.txt'), 0o4755);
    mkdirSync(join(upper, 'sgiddir'));
    chmodSync(join(upper, 'sgiddir'), 0o2755);
    const res = commitOverlay({ runtime: rt, agent: 'c' });
    assert.deepEqual(res, { committed: ['sgiddir', 'suid.txt'], skipped: [] });
    assert.equal(lstatSync(join(proj, 'suid.txt')).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(proj, 'sgiddir')).mode & 0o7777, 0o755);
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  it('unchanged files and links are never staged: inodes survive the commit', () => {
    // Item 4: only upper paths are staged, so an untouched 0400 file keeps
    // its inode (no copy, no rename) and an untouched symlink keeps its target.
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    writeFileSync(join(proj, 'ro.txt'), 'read-only\n');
    chmodSync(join(proj, 'ro.txt'), 0o400);
    symlinkSync('keep.txt', join(proj, 'link.txt'));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'c', proj });
    const ino = lstatSync(join(proj, 'ro.txt')).ino;
    agentWrite({ ...ov, lower: proj, script: 'echo agent > "$M/edit.txt"' });
    const res = commitOverlay({ runtime: rt, agent: 'c' });
    assert.deepEqual(res, { committed: ['edit.txt'], skipped: [] });
    assert.equal(lstatSync(join(proj, 'ro.txt')).ino, ino, 'untouched file keeps its inode');
    assert.equal(lstatSync(join(proj, 'ro.txt')).mode & 0o7777, 0o400);
    assert.equal(readlinkSync(join(proj, 'link.txt')), 'keep.txt', 'untouched link keeps its target');
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'agent\n');
  });

  it('a user-created file colliding with an add is a conflict', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'c', proj });
    writeFileSync(join(upper, 'race.txt'), 'agent\n');
    writeFileSync(join(proj, 'race.txt'), 'user\n'); // created mid-run
    assert.throws(() => commitOverlay({ runtime: rt, agent: 'c' }), /race\.txt/);
    assert.equal(readFileSync(join(proj, 'race.txt'), 'utf8'), 'user\n');
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  it('rejects a bad onConflict', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'c', proj });
    assert.throws(() => commitOverlay({ runtime: rt, agent: 'c', onConflict: 'force' }), /onConflict/);
    rollbackOverlay({ runtime: rt, agent: 'c' });
  });

  it('rollback on an empty upper discards nothing without mounting (bwrap hidden)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'c', proj });
    assert.deepEqual(
      withoutBwrap(() => rollbackOverlay({ runtime: rt, agent: 'c' })),
      { discarded: [], exact: true, why: null });
  });

  it('rollback without an overlay throws', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    assert.throws(() => rollbackOverlay({ runtime: rt, agent: 'ghost' }), /no overlay/);
  });
});

describe('rollback over unreadable uppers, 6.2 (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // The agent leaves a mode-000 file or folder in the upper. Rollback is
  // the escape hatch: it must never depend on what is in the upper, so its
  // first step fixes permissions, then it reports and removes.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o62-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Fresh fixture with agent debris: a mode-000 file, or a mode-000 folder holding a file. */
  function mkDebris(kind, agent) {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent, proj });
    if (kind === 'file') {
      writeFileSync(join(upper, 'f'), 'x\n');
      chmodSync(join(upper, 'f'), 0);
    } else {
      mkdirSync(join(upper, 'd'));
      writeFileSync(join(upper, 'd', 'f'), 'x\n');
      chmodSync(join(upper, 'd'), 0);
    }
    return { proj, rt, before: treeHash(proj) };
  }

  /** The next overlay run must be allowed: `true` exits on its own; awaiting its natural close is the assertion. Never SIGKILL here: killing bwrap mid-setup orphans its inner child on our pipes and `close` never fires. */
  async function nextLaunchAllowed(rt, proj, agent) {
    const child = launch({ runtime: rt, agent, proj, command: ['true'], overlay: true });
    child.on('error', () => {});
    await new Promise((r) => child.on('close', r));
    rollbackOverlay({ runtime: rt, agent });
  }

  for (const kind of ['file', 'dir']) {
    it(`rollback succeeds over a mode-000 ${kind} left by the agent`, { timeout: 60000 }, async () => {
      const agent = `rb-${kind}`;
      const { proj, rt, before } = mkDebris(kind, agent);
      const res = rollbackOverlay({ runtime: rt, agent });
      assert.equal(res.exact, true, 'chmod-first makes the exact diff report available');
      assert.ok(!existsSync(join(rt, 'overlay', agent)), 'the overlay folder is gone');
      await nextLaunchAllowed(rt, proj, agent);
      assert.equal(treeHash(proj), before, 'the project is byte-for-byte unchanged');
    });

    it(`diff and commit refuse a mode-000 ${kind} loudly, naming it`, () => {
      const agent = `rc-${kind}`;
      const { proj, rt, before } = mkDebris(kind, agent);
      const want = kind === 'file' ? 'f' : 'd';
      for (const op of ['diff', 'commit']) {
        let err = null;
        try {
          if (op === 'diff') diffOverlay({ runtime: rt, agent });
          else commitOverlay({ runtime: rt, agent });
        } catch (e) { err = e; }
        assert.ok(err, `${op} must refuse the unreadable upper`);
        assert.match(err.message, new RegExp(`cannot read ${want}\\b`),
          `${op} names the path: ${err.message}`);
        assert.match(err.message, /rollback/, `${op} suggests rollback: ${err.message}`);
      }
      assert.equal(treeHash(proj), before, 'the project is byte-for-byte unchanged');
      assert.deepEqual(readdirSync(proj).filter((n) => n.startsWith('.sbx-commit-')), [],
        'a refused commit leaves no staging folder');
      rollbackOverlay({ runtime: rt, agent });
    });
  }
});

describe('the failed-commit decision, 6.4', () => {
  // finishFailedCommit owns one decision: delete the staging folder only
  // when the undo left nothing behind, otherwise keep it (old/ holds the
  // only copy of the originals) and name it in the error.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o64-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('unit: a partial undo keeps the folder and names it with the steps', () => {
    const commitDir = join(root, '.sbx-commit-1-aaaa');
    mkdirSync(join(commitDir, 'old'), { recursive: true });
    const err = Object.assign(
      new Error(`sbx: commit failed at x (boom): not undone [aside y] ` +
        `(originals are in ${join(commitDir, 'old')}; commit folder kept: ${commitDir})`),
      { code: 'SBX_COMMIT_FAILED', notUndone: ['aside y'] });
    assert.strictEqual(finishFailedCommit(commitDir, err), err, 'returns the error to throw');
    assert.ok(existsSync(commitDir), 'the folder still exists');
    assert.match(err.message, new RegExp(commitDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the error names the folder');
    assert.match(err.message, /aside y/, 'the error lists the steps');
  });

  it('unit: a clean undo removes the folder', () => {
    const commitDir = join(root, '.sbx-commit-2-bbbb');
    mkdirSync(join(commitDir, 'old'), { recursive: true });
    const err = Object.assign(
      new Error('sbx: commit failed at x (boom; nothing was applied)'),
      { code: 'SBX_COMMIT_FAILED', notUndone: [] });
    assert.strictEqual(finishFailedCommit(commitDir, err), err);
    assert.ok(!existsSync(commitDir), 'the folder is gone');
  });

  it('unit: a phase-1 refusal (no notUndone) removes the folder', () => {
    const commitDir = join(root, '.sbx-commit-3-cccc');
    mkdirSync(join(commitDir, 'new'), { recursive: true });
    const err = new Error('sbx: commit refused: 1 file(s) changed in the project');
    assert.strictEqual(finishFailedCommit(commitDir, err), err);
    assert.ok(!existsSync(commitDir), 'the folder is gone');
  });

  it('through commitOverlay: a cleanly undone phase-2 failure leaves no staging folder',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
      // Replacing a folder that holds ignored content with a file is refused
      // in phase 2, after journaled steps: the undo is clean, so the folder
      // must be gone (deleting the decision would strand old/ instead).
      const proj = mkdtempSync(join(root, 'p-'));
      mkdirSync(join(proj, 'iw'), { recursive: true });
      writeFileSync(join(proj, 'iw', 'y'), 'why\n');
      mkdirSync(join(proj, 'iw', 'node_modules'), { recursive: true });
      writeFileSync(join(proj, 'iw', 'node_modules', 'keep.js'), 'v1\n');
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'fc', proj });
      agentWrite({ ...ov, lower: proj, script: 'rm -rf "$M/iw"; echo f > "$M/iw"' });
      let err = null;
      try {
        commitOverlay({ runtime: rt, agent: 'fc' });
      } catch (e) { err = e; }
      assert.ok(err, 'the commit must fail');
      assert.equal(err.code, 'SBX_COMMIT_FAILED');
      assert.match(err.message, /nothing was applied/);
      assert.deepEqual(readdirSync(proj).filter((n) => n.startsWith('.sbx-commit-')), [],
        'no staging folder left behind');
      rollbackOverlay({ runtime: rt, agent: 'fc' });
    });
});

describe('commit-folder exclusion, 6.8.1 (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // A `.sbx-commit-x` folder planted by the agent is invisible to the whole
  // layer: without the exclusion it would be committed into the project and
  // then block every later operation as a leftover.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o68-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a planted commit folder is invisible and does not block', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'cx', proj });
    mkdirSync(join(upper, '.sbx-commit-9-evil'), { recursive: true });
    writeFileSync(join(upper, '.sbx-commit-9-evil', 'f'), 'x\n');
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'cx' }), [], 'not listed');
    assert.deepEqual(commitOverlay({ runtime: rt, agent: 'cx' }),
      { committed: [], skipped: [] }, 'nothing to commit');
    assert.ok(!existsSync(join(proj, '.sbx-commit-9-evil')), 'not created in the project');
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'cx' }), [], 'the next diff is not blocked');
    rollbackOverlay({ runtime: rt, agent: 'cx' });
  });
});

describe('large trees, 6.5 (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // The walker manifest travels as a file, never stdout: no output cap,
  // however many files the project holds. 20,000 small files diff and
  // commit; a 1 MB stdout cap (the old shape) must fail this test.
  let root, proj;
  const DIRS = 20, PER = 1000;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o65-'));
    proj = join(root, 'p');
    for (let d = 0; d < DIRS; d++) {
      const sub = join(proj, 'big', String(d).padStart(2, '0'));
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < PER; i++) {
        writeFileSync(join(sub, `f${String(i).padStart(4, '0')}`), `v${i}\n`);
      }
    }
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('20,000 files diff and commit correctly', { timeout: 240000 }, () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'big', proj });
    agentWrite({ ...ov, lower: proj, script: 'for f in "$M/big/00"/*; do echo m >> "$f"; done' });
    const changes = diffOverlay({ runtime: rt, agent: 'big' });
    assert.equal(changes.length, PER, `one subdir of changes, got ${changes.length}`);
    assert.ok(changes.every((c) => c.status === 'modified' && c.path.startsWith('big/00/')),
      'every change is a modified file in big/00');
    const res = commitOverlay({ runtime: rt, agent: 'big' });
    assert.equal(res.committed.length, PER, 'all of them applied');
    assert.equal(readFileSync(join(proj, 'big', '00', 'f0000'), 'utf8'), 'v0\nm\n');
    assert.equal(readFileSync(join(proj, 'big', '19', 'f0999'), 'utf8'), 'v999\n',
      'untouched files are byte-identical');
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'big' }), [], 'clean after commit');
    rollbackOverlay({ runtime: rt, agent: 'big' });
  });
});

describe('node outside /usr, 6.6 (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // The walker runs on the node running barebox now, never a hardcoded
  // path: copy this node to a volta-style <prefix>/bin/node, run the diff
  // from that copy, and the mount must still walk (its prefix is bound in).
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o66-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a node outside /usr still walks the overlay', { timeout: 120000 }, () => {
    mkdirSync(join(root, 'n', 'bin'), { recursive: true });
    const nodeCopy = join(root, 'n', 'bin', 'node');
    copyFileSync(realpathSync(process.execPath), nodeCopy);
    chmodSync(nodeCopy, 0o755);
    assert.ok(!nodeCopy.startsWith('/usr/'), 'the copy really lives outside /usr');
    const proj = mkdtempSync(join(root, 'p-'));
    writeFileSync(join(proj, 'keep.txt'), 'keep\n');
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'n', proj });
    writeFileSync(join(upper, 'new.txt'), 'new\n');
    const script = join(root, 'list.mjs');
    writeFileSync(script,
      `import { diffOverlay } from ${JSON.stringify(join(ROOT, 'src', 'overlay.js'))};\n` +
      `const changes = diffOverlay({ runtime: ${JSON.stringify(rt)}, agent: 'n' });\n` +
      `process.stdout.write(JSON.stringify(changes.map((c) => [c.status, c.path])));\n`);
    const res = spawnSync(nodeCopy, [script], { encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, `the copy must walk (stderr: ${res.stderr})`);
    assert.deepEqual(JSON.parse(res.stdout), [['added', 'new.txt']]);
    rollbackOverlay({ runtime: rt, agent: 'n' });
  });
});

describe('the mid-commit project check, 6.7 (no sandbox needed)', () => {
  // changedSince returns the first path whose live fingerprint differs
  // from the snapshot, or null when nothing moved.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o67-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('unit: edits, deletions, creations report; stillness is null', () => {
    const proj = mkdtempSync(join(root, 'p-'));
    writeFileSync(join(proj, 'a.txt'), 'a\n');
    writeFileSync(join(proj, 'b.txt'), 'b\n');
    const fps = new Map([
      ['a.txt', fpNow(join(proj, 'a.txt'))],
      ['b.txt', fpNow(join(proj, 'b.txt'))],
      ['c.txt', fpNow(join(proj, 'c.txt'))], // absent reads as null
    ]);
    assert.equal(changedSince(proj, ['a.txt', 'b.txt'], fps), null, 'no edit reads null');
    writeFileSync(join(proj, 'a.txt'), 'a edited\n');
    assert.equal(changedSince(proj, ['a.txt', 'b.txt'], fps), 'a.txt', 'an edited file reports');
    rmSync(join(proj, 'b.txt'));
    assert.equal(changedSince(proj, ['b.txt'], fps), 'b.txt', 'a deleted file reports');
    writeFileSync(join(proj, 'c.txt'), 'c\n');
    assert.equal(changedSince(proj, ['c.txt'], fps), 'c.txt', 'a created file reports');
  });
});

describe('commit under read-only folders, 6.3 (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // A rename needs write permission on the parent folder, so a change inside
  // a 0555 folder could never commit. Phase 2 journals a temporary u+w on
  // parents it owns and restores the final mode in step 5.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-o63-'));
  });
  after(() => {
    fixModes(root);
    rmSync(root, { recursive: true, force: true });
  });

  /** Add owner write everywhere under `dir`, so the fixture cleanup can unlink. */
  function fixModes(dir) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    const want = (st.mode & 0o7777) | (st.isDirectory() ? 0o700 : 0o600);
    if (want !== (st.mode & 0o7777)) chmodSync(dir, want);
    if (st.isDirectory()) {
      for (const n of readdirSync(dir)) fixModes(join(dir, n));
    }
  }

  const modeOf = (p) => lstatSync(p).mode & 0o7777;

  it('deleting inside a 0555 folder commits, and the folder stays 0555', () => {
    const proj = mkdtempSync(join(root, 'p-'));
    mkdirSync(join(proj, 'ro'), { recursive: true });
    writeFileSync(join(proj, 'ro', 'f'), 'x\n');
    chmodSync(join(proj, 'ro'), 0o555);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'ro1', proj });
    agentWrite({ ...ov, lower: proj, script: 'chmod u+w "$M/ro"; rm "$M/ro/f"; chmod 555 "$M/ro"' });
    const res = commitOverlay({ runtime: rt, agent: 'ro1' });
    assert.deepEqual(res, { committed: ['ro/f'], skipped: [] });
    assert.ok(!existsSync(join(proj, 'ro', 'f')), 'ro/f is gone');
    assert.equal(modeOf(join(proj, 'ro')), 0o555, 'ro/ is 0555 afterwards');
    rollbackOverlay({ runtime: rt, agent: 'ro1' });
  });

  it('rm -rf on a 0555 tree two levels deep commits, and the tree is gone', () => {
    const proj = mkdtempSync(join(root, 'p-'));
    mkdirSync(join(proj, 'ro', 'sub'), { recursive: true });
    writeFileSync(join(proj, 'ro', 'sub', 'f'), 'x\n');
    writeFileSync(join(proj, 'ro', 'top.txt'), 't\n');
    chmodSync(join(proj, 'ro', 'sub'), 0o555);
    chmodSync(join(proj, 'ro'), 0o555);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'ro2', proj });
    agentWrite({ ...ov, lower: proj, script: 'chmod -R u+w "$M/ro"; rm -rf "$M/ro"' });
    const res = commitOverlay({ runtime: rt, agent: 'ro2' });
    assert.ok(res.committed.includes('ro'), `ro itself committed: ${res.committed}`);
    assert.ok(!existsSync(join(proj, 'ro')), 'ro/ is gone');
    rollbackOverlay({ runtime: rt, agent: 'ro2' });
  });

  it('a changed file under an untouched 0555 folder commits, folder stays 0555', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    chmodSync(join(proj, 'sub'), 0o555);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'ro3', proj });
    agentWrite({ ...ov, lower: proj, script: 'echo changed > "$M/sub/n.txt"' });
    const res = commitOverlay({ runtime: rt, agent: 'ro3' });
    assert.deepEqual(res, { committed: ['sub/n.txt'], skipped: [] });
    assert.equal(readFileSync(join(proj, 'sub', 'n.txt'), 'utf8'), 'changed\n');
    assert.equal(modeOf(join(proj, 'sub')), 0o555, 'the folder is still 0555');
    rollbackOverlay({ runtime: rt, agent: 'ro3' });
  });

  it('a phase-2 failure after the temporary chmod undoes it exactly', () => {
    // Phase 1 and 2 run synchronously, so nothing external can interleave
    // after the temporary chmod: the failure comes from a second change in
    // the same commit (replacing a folder that holds ignored content with
    // a file is refused in step 2, after the aside of ro/f).
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    mkdirSync(join(proj, 'k', 'node_modules'), { recursive: true });
    writeFileSync(join(proj, 'k', 'node_modules', 'keep.js'), 'v1\n');
    mkdirSync(join(proj, 'ro'), { recursive: true });
    writeFileSync(join(proj, 'ro', 'f'), 'x\n');
    chmodSync(join(proj, 'ro'), 0o555);
    const before = treeHash(proj);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'ro4', proj });
    agentWrite({ ...ov, lower: proj,
      script: 'chmod u+w "$M/ro"; rm "$M/ro/f"; rm -rf "$M/k"; echo x > "$M/k"' });
    let err = null;
    try {
      commitOverlay({ runtime: rt, agent: 'ro4' });
    } catch (e) { err = e; }
    assert.ok(err, 'the commit must fail on the ignored-content replace');
    assert.match(err.message, /holds ignored content/, `names the cause: ${err?.message}`);
    assert.equal(modeOf(join(proj, 'ro')), 0o555, 'the temporary chmod is undone');
    assert.equal(readFileSync(join(proj, 'ro', 'f'), 'utf8'), 'x\n', 'the aside is back');
    assert.equal(treeHash(proj), before, 'the 0555 modes are back afterwards');
    rollbackOverlay({ runtime: rt, agent: 'ro4' });
  });

  it('an unowned unwritable parent is left alone, and the failure names it', () => {
    // Ownership is the uid check in step 0: stub getuid so every fixture
    // parent reads as foreign. The rename then fails and is undone, as
    // before, and the error names the case.
    const proj = mkdtempSync(join(root, 'p-'));
    mkdirSync(join(proj, 'ro'), { recursive: true });
    writeFileSync(join(proj, 'ro', 'f'), 'x\n');
    chmodSync(join(proj, 'ro'), 0o555);
    const before = treeHash(proj);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'ro5', proj });
    agentWrite({ ...ov, lower: proj, script: 'chmod u+w "$M/ro"; rm "$M/ro/f"; chmod 555 "$M/ro"' });
    const realGetuid = process.getuid;
    // A uid that owns nothing in the fixture, whatever user runs the suite.
    const foreign = lstatSync(join(proj, 'ro')).uid + 1;
    process.getuid = () => foreign;
    try {
      let err = null;
      try {
        commitOverlay({ runtime: rt, agent: 'ro5' });
      } catch (e) { err = e; }
      assert.ok(err, 'the commit must fail');
      assert.match(err.message, /not owned/, `names the unowned case: ${err?.message}`);
      assert.match(err.message, /nothing was applied/, 'nothing was applied');
    } finally {
      process.getuid = realGetuid;
    }
    assert.equal(treeHash(proj), before, 'the project is unchanged');
    assert.equal(modeOf(join(proj, 'ro')), 0o555);
    rollbackOverlay({ runtime: rt, agent: 'ro5' });
  });
});

describe('M4 rework cases 1E (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // Behavioral cases from the rework brief: every "unchanged" claim compares
  // treeHash (content, modes, symlink targets). Failures are injected with
  // filesystem permissions, never hooks — except case 7, which atomic
  // renames make unreachable through commit (see the test).
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-1e-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Project fixture for the commit cases: a deletable file, a subdir, a type-change pair. */
  function mkcase(dir) {
    writeFileSync(join(dir, 'a_del'), 'doomed\n');
    writeFileSync(join(dir, 'keep.txt'), 'keep\n');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'victim.txt'), 'victim\n');
    writeFileSync(join(dir, 'asfile'), 'file-now\n');
    mkdirSync(join(dir, 'asdir'), { recursive: true });
    writeFileSync(join(dir, 'asdir', 'y'), 'dir-now\n');
    return dir;
  }

  it('1: delete + mkdir q + chmod 555 q commits with the mode applied last', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e1', proj });
    agentWrite({ ...ov, lower: proj, script: 'rm "$M/a_del"; mkdir "$M/q"; echo x > "$M/q/f"; chmod 555 "$M/q"' });
    try {
      const res = commitOverlay({ runtime: rt, agent: 'e1' });
      assert.deepEqual(res, { committed: ['a_del', 'q', 'q/f'], skipped: [] });
      assert.equal(lstatSync(join(proj, 'q')).mode & 0o7777, 0o555, 'q carries 555');
      assert.equal(readFileSync(join(proj, 'q', 'f'), 'utf8'), 'x\n', 'q/f landed before the chmod');
      assert.ok(!existsSync(join(proj, 'a_del')));
    } finally {
      chmodSync(join(proj, 'q'), 0o700); // else the root cleanup cannot unlink q/f
      rollbackOverlay({ runtime: rt, agent: 'e1' });
    }
  });

  it('2: deleted file under an unwritable parent fails with the project byte-identical', () => {
    // Why a conflict, not a phase-2 failure: deleting through the mount copies
    // `sub` up at its old mode, so chmodding the project parent puts `sub`
    // itself in the changeset — and the pinned rule refuses before phase 2.
    // Any chmod-based parent lock ends here by construction.
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e2', proj });
    agentWrite({ ...ov, lower: proj, script: 'rm "$M/a_del"; rm "$M/sub/victim.txt"' });
    chmodSync(join(proj, 'sub'), 0o555);
    const before = treeHash(proj);
    try {
      let err = null;
      try {
        commitOverlay({ runtime: rt, agent: 'e2' });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof OverlayConflictError, `expected a conflict refusal, got ${err}`);
      assert.deepEqual(err.conflicts.map((c) => c.path), ['sub']);
      assert.match(err.message, /nothing was applied/);
      assert.deepEqual(treeHash(proj), before, 'project byte-for-byte unchanged');
      assert.equal(readFileSync(join(proj, 'sub', 'victim.txt'), 'utf8'), 'victim\n');
      assert.equal(readFileSync(join(proj, 'a_del'), 'utf8'), 'doomed\n');
    } finally {
      chmodSync(join(proj, 'sub'), 0o700);
      rollbackOverlay({ runtime: rt, agent: 'e2' });
    }
  });

  it('3: file becomes a folder', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e3', proj });
    agentWrite({ ...ov, lower: proj, script: 'rm "$M/asfile"; mkdir "$M/asfile"; echo z > "$M/asfile/z"' });
    const res = commitOverlay({ runtime: rt, agent: 'e3' });
    assert.deepEqual(res, { committed: ['asfile', 'asfile/z'], skipped: [] });
    assert.ok(lstatSync(join(proj, 'asfile')).isDirectory());
    assert.equal(readFileSync(join(proj, 'asfile', 'z'), 'utf8'), 'z\n');
    rollbackOverlay({ runtime: rt, agent: 'e3' });
  });

  it('4: folder becomes a file', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e4', proj });
    agentWrite({ ...ov, lower: proj, script: 'rm -rf "$M/asdir"; echo f > "$M/asdir"' });
    const res = commitOverlay({ runtime: rt, agent: 'e4' });
    assert.deepEqual(res, { committed: ['asdir', 'asdir/y'], skipped: [] });
    assert.equal(readFileSync(join(proj, 'asdir'), 'utf8'), 'f\n');
    rollbackOverlay({ runtime: rt, agent: 'e4' });
  });

  it('5: folder holding node_modules cannot become a file', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    mkdirSync(join(proj, 'asdir', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(proj, 'asdir', 'node_modules', 'pkg', 'lib.js'), 'v1\n');
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e5', proj });
    agentWrite({ ...ov, lower: proj, script: 'rm -rf "$M/asdir"; echo f > "$M/asdir"' });
    const before = treeHash(proj);
    let err = null;
    try {
      commitOverlay({ runtime: rt, agent: 'e5' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'commit must refuse');
    assert.match(err.message, /holds ignored content; cannot replace it with a file/);
    assert.deepEqual(treeHash(proj), before, 'project byte-for-byte unchanged');
    assert.ok(lstatSync(join(proj, 'asdir')).isDirectory(), 'the folder is still a folder');
    rollbackOverlay({ runtime: rt, agent: 'e5' });
  });

  it('6: a mid-swap refusal undoes asides and rmdirs exactly', () => {
    // The brief's literal shape (an unwritable destination parent) cannot
    // reach phase 2: chmodding any changeset ancestor puts it in the
    // changeset itself (copy-up mode residue), so the pinned rule refuses in
    // phase 1 — see case 2. This is the richest journal a real refusal can
    // leave: asides plus a landed rmdir, all undone, byte for byte.
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    mkdirSync(join(proj, 'd1'), { recursive: true });
    writeFileSync(join(proj, 'd1', 'f1'), 'f1\n');
    mkdirSync(join(proj, 'iw', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(proj, 'iw', 'y'), 'why\n');
    writeFileSync(join(proj, 'iw', 'node_modules', 'pkg', 'lib.js'), 'v1\n');
    symlinkSync('keep.txt', join(proj, 'link.txt'));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e6', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'rm "$M/d1/f1"; rm -rf "$M/d1"; rm "$M/iw/y"; rm -rf "$M/iw"; echo f > "$M/iw"; rm "$M/link.txt"',
    });
    const before = treeHash(proj);
    let err = null;
    try {
      commitOverlay({ runtime: rt, agent: 'e6' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'commit must refuse the ignored-content replace');
    assert.equal(err.code, 'SBX_COMMIT_FAILED');
    assert.match(err.message, /iw holds ignored content; cannot replace it with a file/);
    assert.match(err.message, /nothing was applied/);
    assert.deepEqual(treeHash(proj), before, 'content, modes, symlinks and deleted files all back');
    assert.equal(readFileSync(join(proj, 'd1', 'f1'), 'utf8'), 'f1\n', 'asided file back');
    assert.equal(readFileSync(join(proj, 'iw', 'y'), 'utf8'), 'why\n', 'asided file back');
    assert.equal(readlinkSync(join(proj, 'link.txt')), 'keep.txt', 'asided symlink back');
    assert.ok(lstatSync(join(proj, 'd1')).isDirectory(), 'removed dir recreated');
    assert.ok(lstatSync(join(proj, 'iw')).isDirectory(), 'replace target still a folder');
    rollbackOverlay({ runtime: rt, agent: 'e6' });
  });

  it('7: undoJournal lists exactly the steps it cannot undo', () => {
    // Unreachable through commit on purpose: every phase-2 op is an atomic
    // rename/mkdir/rmdir/chmod, so a failed op leaves no partial state and an
    // undo step can only fail when the tree moved underneath it — which the
    // phase-1 re-fingerprint refuses first. chmod alone cannot produce it, so
    // this drives the real undo with a sabotaged tree instead of a hook.
    const proj = mkdtempSync(join(root, 'p-'));
    mkdirSync(join(proj, 'ok'));
    writeFileSync(join(proj, 'ok', 'a.txt'), 'new-content\n');
    mkdirSync(join(proj, 'q'));
    writeFileSync(join(proj, 'q', 'pinned.txt'), 'pins the rmdir\n');
    const notUndone = undoJournal([
      { op: 'in', path: 'ok/a.txt' },
      { op: 'mkdir', path: 'q' },
    ], proj);
    assert.deepEqual(notUndone, ['mkdir q'], 'exactly the failed step is listed');
    assert.ok(!existsSync(join(proj, 'ok', 'a.txt')), 'the rest still undoes');
    assert.equal(readFileSync(join(proj, 'q', 'pinned.txt'), 'utf8'), 'pins the rmdir\n');
  });

  it('8: a leftover commit folder blocks diff, commit and run-setup, naming it', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'e8', proj });
    const leftover = join(proj, '.sbx-commit-1-deadbeef');
    mkdirSync(join(leftover, 'new'), { recursive: true });
    mkdirSync(join(leftover, 'old'), { recursive: true });
    try {
      assert.throws(() => diffOverlay({ runtime: rt, agent: 'e8' }), new RegExp(leftover.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.throws(() => commitOverlay({ runtime: rt, agent: 'e8' }), /\.sbx-commit-/);
      assert.throws(() => setupOverlay({ runtime: rt, agent: 'e8', proj }), /\.sbx-commit-/);
    } finally {
      rmSync(leftover, { recursive: true, force: true });
      rollbackOverlay({ runtime: rt, agent: 'e8' });
    }
  });

  it('9: rollback reports exactly what diff returns, then the overlay is gone', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e9', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'echo hacked > "$M/keep.txt"; rm "$M/a_del"; echo evil > "$M/evil.txt"; rm -rf "$M/asdir"; mkdir "$M/n"; echo x > "$M/n/y"',
    });
    const diffed = diffOverlay({ runtime: rt, agent: 'e9' });
    assert.ok(diffed.length >= 5, `expected the chaos listed, got ${JSON.stringify(diffed)}`);
    const { discarded, exact } = rollbackOverlay({ runtime: rt, agent: 'e9' });
    assert.equal(exact, true);
    assert.deepEqual(discarded, diffed, 'rollback output equals diff output');
    assert.ok(!existsSync(join(rt, 'overlay', 'e9')), 'overlay folder gone');
    assert.throws(() => diffOverlay({ runtime: rt, agent: 'e9' }), /no overlay/);
  });

  it('10: rollback with the project gone lists raw paths and allows the next run', async () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e10', proj });
    agentWrite({ ...ov, lower: proj, script: 'echo agent > "$M/edit.txt"; rm "$M/a_del"' });
    rmSync(proj, { recursive: true, force: true });
    const { discarded, exact } = rollbackOverlay({ runtime: rt, agent: 'e10' });
    assert.equal(exact, false);
    const paths = discarded.map((c) => c.path).sort();
    assert.ok(paths.includes('edit.txt'), `raw list carries agent paths, got ${JSON.stringify(paths)}`);
    for (const c of discarded) assert.equal(c.status, 'unknown', 'no inference without the project');
    assert.ok(!existsSync(join(rt, 'overlay', 'e10')), 'overlay folder gone');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'keep.txt'), 'keep\n');
    setupOverlay({ runtime: rt, agent: 'e10', proj }); // the next run is allowed
    rollbackOverlay({ runtime: rt, agent: 'e10' });
  });

  it('11: control bytes and bidi controls in names never reach the terminal', async () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e11', proj });
    // Built from char codes so the source carries no invisible bytes: CR +
    // ESC[2K + ESC[1A tries to rewrite the reviewer's line; U+202E flips it.
    const CR = String.fromCharCode(13);
    const ESC = String.fromCharCode(27);
    const BIDI = String.fromCharCode(0x202e);
    // The CLI child prints UTF-8 but sbx() reads latin1: the unsanitized
    // character would arrive as these three bytes, never as U+202E itself.
    const BIDI_BYTES = String.fromCharCode(0xe2, 0x80, 0xae);
    const evilCtl = 'x' + CR + ESC + '[2K' + ESC + '[1Aevil';
    const evilBidi = 'a' + BIDI + 'cript.js';
    agentWrite({
      ...ov, lower: proj,
      script: 'touch "$M/' + evilCtl + '" && echo bidi > "$M/' + evilBidi + '"',
    });
    const env = { SBX_RUNTIME: rt };
    for (const cmd of [['diff', '--agent', 'e11'], ['commit', '--agent', 'e11']]) {
      const out = (await sbx(cmd, env)).stdout;
      assert.ok(!out.includes(ESC), cmd + ' prints no escape bytes');
      assert.ok(!out.includes(CR), cmd + ' prints no carriage returns');
      assert.ok(!out.includes(BIDI_BYTES), cmd + ' prints no bidi controls');
    }
    // The commit above pressed the evil names down; a fresh one checks rollback too.
    agentWrite({ ...ov, lower: proj, script: 'echo again > "$M/' + evilBidi + '.2"' });
    const rb = (await sbx(['rollback', '--agent', 'e11'], env)).stdout;
    assert.ok(!rb.includes(ESC) && !rb.includes(CR) && !rb.includes(BIDI_BYTES), 'rollback prints sanitized');
  });

  it('12: a non-UTF-8 filename is refused loudly, named', () => {
    const proj = mkcase(mkdtempSync(join(root, 'p-')));
    // join() rejects Buffers: build the raw path for the refusal fixture.
    writeFileSync(Buffer.concat([Buffer.from(`${proj}/`), Buffer.from([0xff, 0xfe])]), 'bad\n');
    const rt = mkdtempSync(join(root, 'rt-'));
    assert.throws(() => setupOverlay({ runtime: rt, agent: 'e12', proj }), /non-UTF-8 filename/);
    try {
      setupOverlay({ runtime: rt, agent: 'e12', proj });
    } catch (e) {
      assert.match(/** @type {Error} */ (e).message, /fffe/, 'the hex names the file');
    }
  });
  // Case 13 (project under $HOME) is the existing mount-order block below, kept as-is.
});

describe('rollback without the project (no sandbox needed)', () => {
  // Setup-independent: hand-built uppers, no mounts, no sockets — rollback
  // only lists the upper dir and unlinks it, so it must work with the
  // project gone (and with bwrap hidden, proving no mount is involved).
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-or-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rollback with the project missing succeeds, empties the overlay, next run allowed', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'gone', proj });
    mkdirSync(join(rt, 'overlay', 'gone', 'upper', 'sub'), { recursive: true });
    writeFileSync(join(rt, 'overlay', 'gone', 'upper', 'sub', 'x.txt'), 'agent\n');
    writeFileSync(join(rt, 'overlay', 'gone', 'upper', 'edit.txt'), 'agent-edit\n');
    symlinkSync('keep.txt', join(rt, 'overlay', 'gone', 'upper', 'link.txt'));
    rmSync(proj, { recursive: true, force: true }); // the project is gone
    const { discarded, exact } = withoutBwrap(() => rollbackOverlay({ runtime: rt, agent: 'gone' }));
    assert.equal(exact, false, 'no project: statuses are not inferred');
    const byPath = new Map(discarded.map((c) => [c.path, c]));
    assert.ok(byPath.has('sub/x.txt'), `agent file reported, got ${JSON.stringify(discarded)}`);
    assert.ok(byPath.has('edit.txt'));
    assert.ok(byPath.has('link.txt'));
    for (const c of discarded) {
      assert.equal(c.status, 'unknown', `${c.path}: raw fallback infers nothing`);
    }
    // The overlay record is fully gone: upper, work and manifest.
    assert.ok(!existsSync(join(rt, 'overlay', 'gone', 'manifest.json')));
    assert.ok(!existsSync(join(rt, 'overlay', 'gone', 'upper', 'edit.txt')));
    // The next run starts fresh on a re-created project.
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'keep.txt'), 'keep\n');
    setupOverlay({ runtime: rt, agent: 'gone', proj }); // must not throw
    rollbackOverlay({ runtime: rt, agent: 'gone' });
  });

  it('rollback with the project present but no userns falls back to raw paths (bwrap hidden)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'still', proj });
    writeFileSync(join(rt, 'overlay', 'still', 'upper', 'new.txt'), 'agent\n');
    const { discarded, exact } = withoutBwrap(() => rollbackOverlay({ runtime: rt, agent: 'still' }));
    assert.equal(exact, false, 'the mount failed: statuses are not inferred');
    assert.deepEqual(discarded.map((c) => [c.status, c.path]), [['unknown', 'new.txt']]);
    assert.ok(!existsSync(join(rt, 'overlay', 'still', 'manifest.json')));
    assert.equal(readFileSync(join(proj, 'keep.txt'), 'utf8'), 'keep\n', 'project untouched');
  });

  it('rollback lists a real whiteout path without inferring its status (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'white', proj });
      agentWrite({ ...ov, lower: proj, script: 'rm "$M/del.txt"; echo agent > "$M/edit.txt"' });
      rmSync(proj, { recursive: true, force: true });
      const { discarded, exact } = rollbackOverlay({ runtime: rt, agent: 'white' });
      assert.equal(exact, false, 'no project: statuses are not inferred');
      const byPath = new Map(discarded.map((c) => [c.path, c.status]));
      assert.equal(byPath.get('del.txt'), 'unknown', `whiteout listed raw, got ${JSON.stringify(discarded)}`);
      assert.equal(byPath.get('edit.txt'), 'unknown');
    });
});

describe('rollback inexact reports why (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  // Item 3: no fake `(could not list: …)` entries in `discarded`, no
  // swallowed reasons. `why` carries diff's message (or `project <proj>
  // is gone`), plus the raw-listing reason when that failed too.
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-orwhy-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a non-UTF-8 name in the upper reports why and invents no paths', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'why-nonutf', proj });
    writeFileSync(Buffer.concat([Buffer.from(`${rt}/overlay/why-nonutf/upper/`), Buffer.from([0xff, 0xfe])]), 'bad\n');
    const { discarded, exact, why } = rollbackOverlay({ runtime: rt, agent: 'why-nonutf' });
    assert.equal(exact, false);
    assert.match(why, /non-UTF-8/, `why names the real reason, got ${why}`);
    assert.ok(!discarded.some((c) => c.path.startsWith('(')), `no fake entries, got ${JSON.stringify(discarded)}`);
    assert.ok(!existsSync(join(rt, 'overlay', 'why-nonutf')), 'the overlay folder is gone');
  });

  it('a deleted project reports why with the raw paths', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'why-gone', proj });
    agentWrite({ ...ov, lower: proj, script: 'echo agent > "$M/edit.txt"; rm "$M/del.txt"' });
    rmSync(proj, { recursive: true, force: true });
    const { discarded, exact, why } = rollbackOverlay({ runtime: rt, agent: 'why-gone' });
    assert.equal(exact, false);
    assert.match(why, /is gone/, `why names the project, got ${why}`);
    assert.deepEqual(discarded.map((c) => c.path).sort(), ['del.txt', 'edit.txt']);
    for (const c of discarded) assert.equal(c.status, 'unknown', 'raw list infers nothing');
    assert.ok(!existsSync(join(rt, 'overlay', 'why-gone')), 'the overlay folder is gone');
  });
});

describe('ignored dirs are invisible (Q3)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-oi-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('node_modules-only changes are nothing, without mounting (bwrap hidden)', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(proj, 'node_modules', 'pkg', 'index.js'), 'v1\n');
    const rt = mkdtempSync(join(root, 'rt-'));
    const { upper } = setupOverlay({ runtime: rt, agent: 'g', proj });
    const manifest = JSON.parse(readFileSync(join(rt, 'overlay', 'g', 'manifest.json'), 'utf8'));
    assert.ok(!Object.keys(manifest.base).some((k) => k.includes('node_modules')),
      'the snapshot never walks ignored dirs');
    // An install-sized upper that is ONLY ignored content: no changes.
    mkdirSync(join(upper, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(upper, 'node_modules', 'pkg', 'index.js'), 'v2\n');
    assert.deepEqual(withoutBwrap(() => diffOverlay({ runtime: rt, agent: 'g' })), []);
    assert.deepEqual(
      withoutBwrap(() => commitOverlay({ runtime: rt, agent: 'g' })),
      { committed: [], skipped: [] });
    assert.equal(readFileSync(join(proj, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v1\n');
    assert.deepEqual(withoutBwrap(() => rollbackOverlay({ runtime: rt, agent: 'g' })),
      { discarded: [], exact: true, why: null });
  });

  it('a custom ignore list prunes several dirs through a real mount (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(proj, 'node_modules', 'pkg', 'index.js'), 'v1\n');
      mkdirSync(join(proj, 'dist'), { recursive: true });
      writeFileSync(join(proj, 'dist', 'out.js'), 'old\n');
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'g', proj, ignore: ['node_modules', 'dist'] });
      agentWrite({
        ...ov, lower: proj,
        script: 'echo agent > "$M/real.txt"; echo v2 > "$M/node_modules/pkg/index.js"; echo new > "$M/dist/out.js"',
      });
      const got = diffOverlay({ runtime: rt, agent: 'g' }).map((c) => [c.status, c.path]);
      assert.deepEqual(got, [['added', 'real.txt']]);
      const res = commitOverlay({ runtime: rt, agent: 'g' });
      assert.deepEqual(res.committed, ['real.txt']);
      assert.equal(readFileSync(join(proj, 'real.txt'), 'utf8'), 'agent\n');
      assert.equal(readFileSync(join(proj, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'v1\n');
      assert.equal(readFileSync(join(proj, 'dist', 'out.js'), 'utf8'), 'old\n');
    });
});

describe('end-to-end through a real mount (needs bwrap)', { skip: BWRAP_OK ? false : BWRAP_SKIP }, () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-oe-'));
  });
  after(() => {
    for (const rt of readdirSync(root).filter((n) => n.startsWith('rt-'))) {
      try { rollbackOverlay({ runtime: join(root, rt), agent: 'e' }); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('edit + create + delete commit to the correct result', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'echo new > "$M/edit.txt"; echo hi > "$M/created.txt"; rm "$M/del.txt"; rm "$M/sub/n.txt"',
    });
    assert.deepEqual(
      diffOverlay({ runtime: rt, agent: 'e' }).map((c) => [c.status, c.path, c.conflict]),
      [['added', 'created.txt', false], ['deleted', 'del.txt', false],
        ['modified', 'edit.txt', false], ['deleted', 'sub/n.txt', false]]);
    const res = commitOverlay({ runtime: rt, agent: 'e' });
    assert.deepEqual(res, {
      committed: ['created.txt', 'del.txt', 'edit.txt', 'sub/n.txt'], skipped: [],
    });
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(proj, 'created.txt'), 'utf8'), 'hi\n');
    assert.ok(!existsSync(join(proj, 'del.txt')));
    assert.ok(!existsSync(join(proj, 'sub', 'n.txt')));
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'e' }), []);
  });

  it('a replaced directory (opaque) commits to empty, not resurrected', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'rm -rf "$M/sub" && mkdir "$M/sub" && echo n > "$M/sub/n2.txt"',
    });
    assert.deepEqual(
      diffOverlay({ runtime: rt, agent: 'e' }).map((c) => [c.status, c.path]),
      [['deleted', 'sub/n.txt'], ['added', 'sub/n2.txt']]);
    commitOverlay({ runtime: rt, agent: 'e' });
    assert.deepEqual(readdirSync(join(proj, 'sub')), ['n2.txt']);
  });

  it('rollback leaves the folder exactly as it was', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    symlinkSync('keep.txt', join(proj, 'link.txt'));
    chmodSync(join(proj, 'edit.txt'), 0o600);
    const before = readTree(proj);
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'echo hacked > "$M/edit.txt"; rm "$M/del.txt"; rm "$M/link.txt"; ' +
        'rm -rf "$M/sub" && mkdir "$M/sub2" && echo x > "$M/sub2/y.txt"; ' +
        'chmod 644 "$M/keep.txt"; echo evil > "$M/evil.txt"',
    });
    const { discarded } = rollbackOverlay({ runtime: rt, agent: 'e' });
    assert.ok(discarded.length >= 5, `expected the chaos listed, got ${JSON.stringify(discarded)}`);
    assert.deepEqual(readTree(proj), before, 'rollback must restore content, modes and links exactly');
    // The record is gone with the paper: nothing left to diff.
    assert.throws(() => diffOverlay({ runtime: rt, agent: 'e' }), /no overlay/);
  });

  it('mid-run user changes are flagged, never overwritten', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'echo agent > "$M/edit.txt"; rm "$M/del.txt"; echo clean > "$M/clean.txt"',
    });
    writeFileSync(join(proj, 'edit.txt'), 'user\n'); // user edits what the agent edited
    writeFileSync(join(proj, 'del.txt'), 'user\n'); // user edits what the agent deleted
    let err = null;
    try {
      commitOverlay({ runtime: rt, agent: 'e' });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof OverlayConflictError);
    assert.deepEqual(err.conflicts.map((c) => c.path).sort(), ['del.txt', 'edit.txt']);
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'user\n');
    assert.equal(readFileSync(join(proj, 'del.txt'), 'utf8'), 'user\n');
    assert.ok(!existsSync(join(proj, 'clean.txt')), 'refusal is all-or-nothing');
    rollbackOverlay({ runtime: rt, agent: 'e' });
  });

  it('deleting a dir keeps ignored subtrees; a mode-only dir change keeps contents', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    mkdirSync(join(proj, 'pkg', 'node_modules'), { recursive: true });
    writeFileSync(join(proj, 'pkg', 'keep.txt'), 'keep\n');
    writeFileSync(join(proj, 'pkg', 'node_modules', 'lib.js'), 'v1\n');
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({
      ...ov, lower: proj,
      script: 'rm -rf "$M/pkg"; chmod 700 "$M/sub"',
    });
    commitOverlay({ runtime: rt, agent: 'e' });
    assert.equal(readFileSync(join(proj, 'pkg', 'node_modules', 'lib.js'), 'utf8'), 'v1\n');
    assert.ok(!existsSync(join(proj, 'pkg', 'keep.txt')));
    assert.equal(lstatSync(join(proj, 'sub')).mode & 0o7777, 0o700);
    assert.equal(readFileSync(join(proj, 'sub', 'n.txt'), 'utf8'), 'nested\n');
  });

  it('an identical rewrite is no change through a real mount', () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    const ov = setupOverlay({ runtime: rt, agent: 'e', proj });
    agentWrite({ ...ov, lower: proj, script: 'printf \'orig\\n\' > "$M/edit.txt"' });
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'e' }), []);
    assert.deepEqual(commitOverlay({ runtime: rt, agent: 'e' }), { committed: [], skipped: [] });
  });
});

describe('launch overlay wiring', () => {
  let root, home, proj, savedHome;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-ol-'));
    home = join(root, 'home');
    proj = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkproj(proj);
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a runtime inside the project before spawning (no sandbox needed)', () => {
    assert.throws(
      () => launch({ runtime: join(proj, 'rt'), agent: 'w', proj, command: ['true'], overlay: true }),
      /inside the project/);
  });

  it('refuses leftover uncommitted changes before spawning (no sandbox needed)', () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-olrt-'));
    try {
      setupOverlay({ runtime: rt, agent: 'w', proj });
      writeFileSync(join(rt, 'overlay', 'w', 'upper', 'stray.txt'), 'x');
      assert.throws(
        () => launch({ runtime: rt, agent: 'w', proj, command: ['true'], overlay: true }),
        /uncommitted/);
    } finally {
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('writes land in the upper while the project stays untouched (needs socket)',
    { skip: SOCKET_OK ? false : SOCKET_SKIP, timeout: 60000 }, async () => {
      const rt = join(root, 'rt-wire');
      mkdirSync(join(rt, 'socks'), { recursive: true });
      const sock = join(rt, 'socks', 'w.sock');
      const srv = net.createServer((s) => s.resume());
      await new Promise((resolve, reject) => {
        srv.on('error', reject);
        srv.listen(sock, resolve);
      });
      try {
        const child = launch({
          runtime: rt, agent: 'w', proj, socket: sock, overlay: true,
          command: ['bash', '-c', 'echo agent > "$0/new.txt" && echo agent > "$0/edit.txt"', proj],
        });
        const upper = runtimePaths(rt).overlay('w').upper;
        assert.ok(upper, 'the overlay record addresses the upper');
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.equal(code, 0);
        assert.equal(readFileSync(join(upper, 'new.txt'), 'utf8'), 'agent\n');
        assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'orig\n',
          'the project is untouched until commit');
        assert.deepEqual(
          diffOverlay({ runtime: rt, agent: 'w' }).map((c) => [c.status, c.path]),
          [['modified', 'edit.txt'], ['added', 'new.txt']]);
        rollbackOverlay({ runtime: rt, agent: 'w' });
      } finally {
        srv.closeAllConnections?.();
        srv.close();
      }
    });

  it('the agent starts in the project dir, from a foreign cwd, with and without the overlay (needs socket)',
    { skip: SOCKET_OK ? false : SOCKET_SKIP, timeout: 60000 }, async () => {
      // Setup-independent: the caller starts at / (never the project), so a
      // missing --chdir shows up as the wrong pwd instead of passing by luck.
      const prevCwd = process.cwd();
      process.chdir('/');
      try {
        for (const [agent, overlay] of [['pwd-plain', false], ['pwd-ov', true]]) {
          const rt = join(root, `rt-pwd-${agent}`);
          mkdirSync(join(rt, 'socks'), { recursive: true });
          const sock = join(rt, 'socks', `${agent}.sock`);
          const srv = net.createServer((s) => s.resume());
          await new Promise((resolve, reject) => {
            srv.on('error', reject);
            srv.listen(sock, resolve);
          });
          try {
            const child = launch({
              runtime: rt, agent, proj, socket: sock, overlay,
              command: ['bash', '-c', 'pwd'],
            });
            let out = '';
            child.stdout.on('data', (c) => { out += c; });
            const code = await new Promise((resolve, reject) => {
              child.on('error', reject);
              child.on('close', resolve);
            });
            assert.equal(code, 0);
            assert.equal(out.trim(), proj, `agent cwd with overlay:${overlay}`);
            if (overlay) rollbackOverlay({ runtime: rt, agent });
          } finally {
            srv.closeAllConnections?.();
            srv.close();
          }
        }
      } finally {
        process.chdir(prevCwd);
      }
    });
});

describe('run overlay (needs socket)', { skip: SOCKET_OK ? false : SOCKET_SKIP }, () => {
  let root, home, proj, savedHome;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-or-'));
    home = join(root, 'home');
    proj = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkproj(proj);
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  const devnull = () => new Writable({ write(_c, _e, cb) { cb(); } });

  it('returns the diff, leaves the project untouched, then commits', async () => {
    const rt = join(root, 'rt-run');
    const res = await run({
      proj, command: ['bash', '-c', 'echo agent > new.txt && echo agent > edit.txt'],
      runtime: rt, agent: 'ro', overlay: true, stdout: devnull(), stderr: devnull(),
    });
    assert.equal(res.exit, 0);
    assert.equal(res.runtime, rt);
    assert.deepEqual(res.diff.map((c) => [c.status, c.path]),
      [['modified', 'edit.txt'], ['added', 'new.txt']]);
    assert.deepEqual(res.asks, []);
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'orig\n');
    const out = commitOverlay({ runtime: rt, agent: 'ro' });
    assert.deepEqual(out.committed, ['edit.txt', 'new.txt']);
    assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'agent\n');
  });

  it('without overlay the diff is empty', async () => {
    const res = await run({
      proj, command: ['true'], runtime: join(root, 'rt-plain'),
      agent: 'rp', stdout: devnull(), stderr: devnull(),
    });
    assert.equal(res.exit, 0);
    assert.deepEqual(res.diff, []);
  });
});

describe('sbx diff/commit/rollback CLI', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-ox-'));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // CLI env with bwrap hidden but node present: proves the no-mount paths.
  function cloakedEnv(/** @type {Record<string, string>} */ extra) {
    const binDir = mkdtempSync(join(tmpdir(), 'bb-xbin-'));
    symlinkSync(process.execPath, join(binDir, 'node'));
    return { ...process.env, PATH: binDir, ...extra, __bbxbin: binDir };
  }
  function uncloak(/** @type {Record<string, string>} */ env) {
    rmSync(env.__bbxbin, { recursive: true, force: true });
  }

  it('needs SBX_RUNTIME (exit 2)', async () => {
    for (const cmd of ['diff', 'commit', 'rollback']) {
      const env = { ...process.env };
      delete env.SBX_RUNTIME;
      const err = await execA('node', [CLI, cmd], { encoding: 'latin1', env })
        .then(() => null, (e) => e);
      assert.equal(err?.code, 2, cmd);
      assert.match(err.stderr, /usage: sbx/);
      assert.equal(err.stdout, '', `${cmd}: usage writes nothing on stdout`);
    }
  });

  it('bad flags and bad agent names are usage errors (exit 2)', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const err1 = await sbx(['diff', '--bogus'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err1?.code, 2);
    assert.match(err1.stderr, /usage: sbx/);
    assert.equal(err1.stdout, '', 'usage writes nothing on stdout');
    const err2 = await sbx(['diff', '--agent', '../evil'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err2?.code, 2);
    assert.match(err2.stderr, /evil/, 'bad agent name on stderr');
    assert.equal(err2.stdout, '', 'bad agent name writes nothing on stdout');
    const err3 = await sbx(['commit', '--agent'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err3?.code, 2);
    assert.match(err3.stderr, /usage: sbx/);
  });

  it('an unknown agent exits 1, never 0', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    for (const cmd of ['diff', 'commit', 'rollback']) {
      const err = await sbx([cmd], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
      assert.equal(err?.code, 1, cmd);
      assert.match(err.stderr, /no overlay/);
      assert.equal(err.stdout, '', `${cmd}: errors write nothing on stdout`);
    }
  });

  it('an empty sheet is clean no-ops, without mounting (bwrap hidden)', async () => {
    const proj = mkproj(mkdtempSync(join(root, 'p-')));
    const rt = mkdtempSync(join(root, 'rt-'));
    setupOverlay({ runtime: rt, agent: 'agent', proj });
    const env = cloakedEnv({ SBX_RUNTIME: rt });
    try {
      assert.equal((await sbx(['diff'], env)).stdout.trim(), 'no changes');
      assert.equal((await sbx(['commit'], env)).stdout.trim(), 'nothing to commit');
      assert.equal((await sbx(['rollback'], env)).stdout.trim(), 'nothing to discard');
    } finally {
      uncloak(env);
    }
  });

  it('run --overlay without -- is a usage error (exit 2)', async () => {
    const err = await sbx(['run', '--overlay']).then(() => null, (e) => e);
    assert.equal(err?.code, 2);
    assert.match(err.stderr, /usage: sbx/);
    assert.equal(err.stdout, '', 'usage writes nothing on stdout');
  });

  it('diff lists, commit applies, diff is clean after (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'agent', proj });
      agentWrite({
        ...ov, lower: proj,
        script: 'echo new > "$M/edit.txt"; echo hi > "$M/created.txt"; rm "$M/del.txt"',
      });
      const env = { SBX_RUNTIME: rt };
      const diff = (await sbx(['diff'], env)).stdout;
      assert.match(diff, /^M edit\.txt$/m);
      assert.match(diff, /^A created\.txt$/m);
      assert.match(diff, /^D del\.txt$/m);
      const done = (await sbx(['commit'], env)).stdout;
      assert.match(done, /committed edit\.txt/);
      assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'new\n');
      assert.ok(!existsSync(join(proj, 'del.txt')));
      assert.equal((await sbx(['diff'], env)).stdout.trim(), 'no changes');
    });

  it('commit refuses conflicts with exit 1, then skip-commits the rest (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'agent', proj });
      agentWrite({
        ...ov, lower: proj,
        script: 'echo agent > "$M/edit.txt"; echo clean > "$M/clean.txt"',
      });
      writeFileSync(join(proj, 'edit.txt'), 'user\n');
      const env = { SBX_RUNTIME: rt };
      assert.match((await sbx(['diff'], env)).stdout, /CONFLICT/);
      const refused = await sbx(['commit'], env).then(() => null, (e) => e);
      assert.equal(refused?.code, 1);
      assert.match(refused.stderr, /conflict: edit\.txt/);
      assert.match(refused.stderr, /commit refused/);
      assert.equal(refused.stdout, '', 'refusals write nothing on stdout');
      assert.equal(readFileSync(join(proj, 'edit.txt'), 'utf8'), 'user\n');
      assert.ok(!existsSync(join(proj, 'clean.txt')), 'refusal wrote nothing');
      const skipped = (await sbx(['commit', '--skip-conflicts'], env)).stdout;
      assert.match(skipped, /committed clean\.txt/);
      assert.match(skipped, /skipped \(conflict\): edit\.txt/);
      assert.equal(readFileSync(join(proj, 'clean.txt'), 'utf8'), 'clean\n');
    });

  it('rollback discards and the folder is exact (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const before = readTree(proj);
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'agent', proj });
      agentWrite({
        ...ov, lower: proj,
        script: 'echo hacked > "$M/edit.txt"; rm "$M/del.txt"; echo evil > "$M/evil.txt"',
      });
      const env = { SBX_RUNTIME: rt };
      const out = (await sbx(['rollback'], env)).stdout;
      assert.match(out, /discarded M edit\.txt/);
      assert.match(out, /discarded D del\.txt/);
      assert.match(out, /discarded A evil\.txt/);
      assert.deepEqual(readTree(proj), before);
    });

  it('rollback over an unlistable upper says why, never a fake path (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      setupOverlay({ runtime: rt, agent: 'agent', proj });
      writeFileSync(Buffer.concat([Buffer.from(`${rt}/overlay/agent/upper/`), Buffer.from([0xff, 0xfe])]), 'bad\n');
      const out = (await sbx(['rollback'], { SBX_RUNTIME: rt })).stdout;
      assert.match(out, /discarded \(could not list: .*non-UTF-8/, `why on one line, got ${out}`);
      assert.ok(!out.includes('no userns'), `no wrong reason, got ${out}`);
      assert.ok(!out.includes('project gone or'), `no wrong reason, got ${out}`);
      assert.ok(!existsSync(join(rt, 'overlay', 'agent')), 'the overlay folder is gone');
    });

  it('rollback with the project gone names why on one line (needs bwrap)',
    { skip: BWRAP_OK ? false : BWRAP_SKIP }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      const ov = setupOverlay({ runtime: rt, agent: 'agent', proj });
      agentWrite({ ...ov, lower: proj, script: 'echo agent > "$M/edit.txt"' });
      rmSync(proj, { recursive: true, force: true });
      const out = (await sbx(['rollback'], { SBX_RUNTIME: rt })).stdout;
      assert.match(out, /discarded 1 entries, exact list unavailable: .*is gone/, `why on one line, got ${out}`);
      assert.ok(!out.includes('no userns'), `no wrong reason, got ${out}`);
    });

  it('sbx run --overlay end to end (needs socket)',
    { skip: SOCKET_OK ? false : SOCKET_SKIP, timeout: 120000 }, async () => {
      const proj = mkproj(mkdtempSync(join(root, 'p-')));
      const rt = mkdtempSync(join(root, 'rt-'));
      const home = mkdtempSync(join(root, 'h-'));
      const child = spawn('node', [CLI, 'run', '--overlay', '--', 'bash', '-c', 'echo agent > new.txt'],
        { cwd: proj, env: { ...process.env, HOME: home, SBX_RUNTIME: rt } });
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const code = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`sbx run timeout: ${out}${err}`)); }, 60000);
        child.on('error', (e) => { clearTimeout(t); reject(e); });
        child.on('close', (c) => { clearTimeout(t); resolve(c); });
      });
      assert.equal(code, 0, `stderr: ${err}`);
      assert.match(err, /overlay: 1 change/);
      assert.match((await sbx(['diff'], { SBX_RUNTIME: rt })).stdout, /^A new\.txt$/m);
      assert.match((await sbx(['commit'], { SBX_RUNTIME: rt })).stdout, /committed new\.txt/);
      assert.equal(readFileSync(join(proj, 'new.txt'), 'utf8'), 'agent\n');
    });
});
