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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import net from 'node:net';
import {
  setupOverlay, diffOverlay, commitOverlay, rollbackOverlay, undoJournal,
  OverlayConflictError, DEFAULT_IGNORE,
} from '../src/overlay.js';
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
      { discarded: [], exact: true });
  });

  it('rollback without an overlay throws', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    assert.throws(() => rollbackOverlay({ runtime: rt, agent: 'ghost' }), /no overlay/);
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
      { discarded: [], exact: true });
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
    { skip: SOCKET_OK ? false : SOCKET_SKIP }, async () => {
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
        assert.ok(child.overlay?.upper, 'child carries its upper address');
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.equal(code, 0);
        assert.equal(readFileSync(join(child.overlay.upper, 'new.txt'), 'utf8'), 'agent\n');
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
    { skip: SOCKET_OK ? false : SOCKET_SKIP }, async () => {
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
      delete env.SBX_SOCK;
      const err = await execA('node', [CLI, cmd], { encoding: 'latin1', env })
        .then(() => null, (e) => e);
      assert.equal(err?.code, 2, cmd);
      assert.match(err.stdout, /usage: sbx/);
    }
  });

  it('bad flags and bad agent names are usage errors (exit 2)', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    const err1 = await sbx(['diff', '--bogus'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err1?.code, 2);
    const err2 = await sbx(['diff', '--agent', '../evil'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err2?.code, 2);
    const err3 = await sbx(['commit', '--agent'], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
    assert.equal(err3?.code, 2);
  });

  it('an unknown agent exits 1, never 0', async () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    for (const cmd of ['diff', 'commit', 'rollback']) {
      const err = await sbx([cmd], { SBX_RUNTIME: rt }).then(() => null, (e) => e);
      assert.equal(err?.code, 1, cmd);
      assert.match(err.stdout, /no overlay/);
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
    assert.match(err.stdout, /usage: sbx/);
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
      assert.match(refused.stdout, /conflict: edit\.txt/);
      assert.match(refused.stdout, /commit refused/);
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

  it('sbx run --overlay end to end (needs socket)',
    { skip: SOCKET_OK ? false : SOCKET_SKIP }, async () => {
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
