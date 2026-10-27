// Primitives completeness: every public barrel export is manifested,
// or allow-listed here with the reason. Keeps exports and manifest in sync.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
});
