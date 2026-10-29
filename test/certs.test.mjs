// certs.js directly: serials come from openssl -set_serial (no shared ca.srl)
// and at most 4 mints run at once. A bash shim first on PATH logs each
// openssl start/end so the overlap is measured, not assumed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCA, certFor } from '../src/certs.js';

const T = { timeout: 60_000 };
const hosts = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}.test`);

describe('certs: serials and mint cap', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 'sbx-certs-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('no shared ca.srl; 10 concurrent mints get distinct serials', T, async () => {
    const dir = join(root, 'serials');
    await ensureCA(dir);
    await Promise.all(hosts(10, 's').map((h) => certFor(dir, h)));
    assert.equal(existsSync(join(dir, 'ca.srl')), false, 'ca.srl must not exist');
    const serials = hosts(10, 's').map((h) =>
      execFileSync('openssl', ['x509', '-noout', '-serial', '-in', join(dir, `${h}.pem`)], { encoding: 'utf8' }).trim());
    assert.equal(new Set(serials).size, 10, `serials not distinct: ${serials.join(' ')}`);
  });

  it('at most 4 openssl runs overlap across 12 concurrent mints', T, async () => {
    const dir = join(root, 'cap');
    await ensureCA(dir);
    const real = execFileSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'shim');
    const log = join(root, 'shim.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'openssl'),
      `#!/bin/bash\necho "start $$ $(date +%s%N)" >> ${log}\n${real} "$@"\nrc=$?\necho "end $$ $(date +%s%N)" >> ${log}\nexit $rc\n`);
    chmodSync(join(bin, 'openssl'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      await Promise.all(hosts(12, 'c').map((h) => certFor(dir, h)));
    } finally {
      process.env.PATH = oldPath;
    }
    const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => {
      const [kind, pid, ns] = l.split(' ');
      return { kind, pid, ns: BigInt(ns) };
    });
    assert.ok(events.length >= 24, `shim saw only ${events.length} events`);
    // Sort by time; an end sorts before a start at the same instant.
    events.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.kind === 'end' ? -1 : 1));
    let live = 0, max = 0;
    for (const e of events) { live += e.kind === 'start' ? 1 : -1; max = Math.max(max, live); }
    assert.ok(max <= 4, `max overlapping openssl runs was ${max}`);
  });
});
