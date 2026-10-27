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
  setupOverlay, diffOverlay, commitOverlay, rollbackOverlay,
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
      { discarded: [] });
  });

  it('rollback without an overlay throws', () => {
    const rt = mkdtempSync(join(root, 'rt-'));
    assert.throws(() => rollbackOverlay({ runtime: rt, agent: 'ghost' }), /no overlay/);
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
    assert.deepEqual(withoutBwrap(() => rollbackOverlay({ runtime: rt, agent: 'g' })), { discarded: [] });
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
    assert.deepEqual(diffOverlay({ runtime: rt, agent: 'e' }), []);
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
