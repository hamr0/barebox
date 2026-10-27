// The packaged quickstart runs as written: every ```js block in
// barebox.context.md is extracted and executed. Only ```js no-run blocks
// are skipped (none: both examples are self-contained). The `launch`
// block needs bwrap and an agent socket, so it runs in a real shell or
// CI, not in a socket-blocked sandbox.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every fenced js block: `{ code, run }`. Scratch files live outside the package, where self-reference does not resolve, so the one allowed rewrite points `"barebox"` at `src/index.js`. */
function jsBlocks() {
  const text = readFileSync(join(ROOT, 'barebox.context.md'), 'utf8');
  const out = [];
  const re = /^```(\S*)[^\n]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === 'js') out.push({ code: m[2], run: true });
    else if (m[1] === 'js no-run') out.push({ code: m[2], run: false });
  }
  return out;
}

describe('context doc quickstarts run as written', () => {
  const found = jsBlocks();

  it('has runnable js blocks', () => {
    assert.ok(found.filter((b) => b.run).length >= 2, `want both quickstarts runnable, got ${found.length}`);
  });

  for (const [i, b] of found.entries()) {
    if (!b.run) continue;
    it(`block ${i} exits 0`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bb-doc-'));
      try {
        const file = join(dir, `block-${i}.mjs`);
        const code = b.code.replace(/from (["'])barebox\1/g, `from ${JSON.stringify(join(ROOT, 'src', 'index.js'))}`);
        writeFileSync(file, code);
        const res = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000 });
        if (res.error) throw res.error;
        assert.equal(res.status, 0, `block ${i} exits 0 (stderr: ${res.stderr})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
