// Primitives completeness: every public barrel export is manifested,
// or allow-listed here with the reason. Keeps exports and manifest in sync.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_LIST = {
  // name: reason (empty today: everything public is manifested)
};

describe('primitives completeness', () => {
  it('every export is manifested or allow-listed', () => {
    const barrel = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
    const exported = [...barrel.matchAll(/export\s*\{([^}]*)\}/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()))
      .filter(Boolean);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'primitives.json'), 'utf8'));
    const manifested = new Set(manifest.primitives.map((p) => p.name));
    for (const name of exported) {
      assert.ok(manifested.has(name) || name in ALLOW_LIST,
        `${name} is exported but neither manifested nor allow-listed`);
    }
  });

  it('loadLabels is a public export and returns { matcher, tools, dirs }', async () => {
    const { loadLabels } = await import('barebox');
    assert.equal(typeof loadLabels, 'function');
    const root = mkdtempSync(join(tmpdir(), 'bb-pc-lbl-'));
    try {
      const out = join(root, 'out');
      mkdirSync(out);
      const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/rwxmap/src/cli.js'),
        join(ROOT, 'test/fixtures/jira-mini.json'), '-o', out, '--vendor', 'jira'],
        { cwd: root, encoding: 'utf8', env: { ...process.env, JEV_KEY: '' } });
      assert.equal(r.status, 0, r.stderr);
      const got = loadLabels({ labels: [out] });
      assert.deepEqual(Object.keys(got).sort(), ['dirs', 'matcher', 'tools']);
      assert.deepEqual(got.dirs, [out]);
      assert.ok(Object.keys(got.tools).length > 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
