// The packaged quickstart runs as written: every ```js block in
// barebox.context.md is extracted and executed. Only ```js no-run blocks
// are skipped (none: both examples are self-contained). The `launch`
// block needs bwrap and an agent socket, so it runs in a real shell or
// CI, not in a socket-blocked sandbox.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { jsBlocks } from './doc-blocks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run one extracted block inside `dir`. Scratch files live outside the package, where self-reference does not resolve, so the one allowed rewrite points `"barebox"` at `src/index.js`. `TMPDIR` points at `dir` (a short `/tmp/bb-doc-*`, so socket paths stay short): the block's own `mkdtemp` calls land inside it and vanish with it. */
function runBlock(i, b, dir) {
  const file = join(dir, `block-${i}.mjs`);
  const code = b.code.replace(/from (["'])barebox\1/g, `from ${JSON.stringify(join(ROOT, 'src', 'index.js'))}`);
  writeFileSync(file, code);
  return spawnSync(process.execPath, [file],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: dir } });
}

/** With `dir` removed, run one block and assert it exits 0. */
function runBlockClean(i, b) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-doc-'));
  try {
    const res = runBlock(i, b, dir);
    if (res.error) throw res.error;
    assert.equal(res.status, 0, `block ${i} exits 0 (stderr: ${res.stderr})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('context doc quickstarts run as written', () => {
  const found = jsBlocks(readFileSync(join(ROOT, 'barebox.context.md'), 'utf8'));

  it('has runnable js blocks', () => {
    assert.ok(found.filter((b) => b.run).length >= 2, `want both quickstarts runnable, got ${found.length}`);
  });

  for (const [i, b] of found.entries()) {
    if (!b.run) continue;
    it(`block ${i} exits 0`, () => {
      runBlockClean(i, b);
    });
  }

  it('blocks leak no sbx-*/proj-* folders into the shared tmpdir', () => {
    const entries = () => new Set(readdirSync(tmpdir())
      .filter((n) => n.startsWith('sbx-') || n.startsWith('proj-')));
    const before = entries();
    for (const [i, b] of found.entries()) {
      if (!b.run) continue;
      runBlockClean(i, b);
    }
    assert.deepEqual([...entries()].filter((n) => !before.has(n)), [],
      'every block-owned folder stays under TMPDIR');
  });
});

describe('jsBlocks extractor', () => {
  it('marks plain js runnable and js no-run skipped', () => {
    const blocks = jsBlocks('run this\n```js\nconst a = 1;\n```\nskip this\n```js no-run\nconst b = 2;\n```\n');
    assert.deepEqual(blocks.map((b) => b.run), [true, false]);
  });
});
