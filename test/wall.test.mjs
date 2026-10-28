// Wall unit tests: `denyReasonForIp` spellings and stubbed-DNS `checkUpstream`.
// Pure functions only: no sockets, no bwrap, green everywhere.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpstream, denyReasonForIp } from '../src/wall.js';

describe('denyReasonForIp: every spelling', () => {
  /** [address, expected reason or null when allowed] */
  const rows = [
    // Embedded IPv4, every spelling.
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:a00:1', 'private'],
    ['::7f00:1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['0:0:0:0:0:0:0:0', 'unspecified'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:a9fe:a9fe::1', 'link-local'],
    // Must stay allowed.
    ['8.8.8.8', null],
    ['2001:4860:4860::8888', null],
    ['2606:4700::1111', null],
    ['64:ff9b::808:808', null],
    ['2002:808:808::1', null],
    ['::ffff:808:808', null],
  ];
  for (const [addr, want] of rows) {
    it(`${addr} → ${want ?? 'allowed'}`, () => {
      assert.equal(denyReasonForIp(addr, false), want, addr);
    });
  }

  it('allowLoopback lets loopback through, never link-local', () => {
    for (const addr of ['0:0:0:0:0:0:0:1', '::ffff:7f00:1', '64:ff9b::7f00:1']) {
      assert.equal(denyReasonForIp(addr, true), null, addr);
    }
    assert.equal(denyReasonForIp('::ffff:a9fe:a9fe', true), 'link-local');
  });
});

describe('checkUpstream: DNS answers in embedded forms', () => {
  const gate = (ips) => ({
    allowLoopback: false,
    resolveUpstream: async () => ips,
  });

  it('a NAT64 answer embedding private IPv4 is denied', async () => {
    const r = await checkUpstream('evil.test', gate(['64:ff9b::a00:1']));
    assert.equal(r.ok, false);
    assert.match(r.reason, /private upstream denied: evil\.test \(64:ff9b::a00:1\)/);
  });

  it('any walled answer denies, even after a public one', async () => {
    const r = await checkUpstream('evil.test', gate(['8.8.8.8', '2002:7f00:1::']));
    assert.equal(r.ok, false);
  });

  it('NAT64 of a public address stays allowed', async () => {
    const r = await checkUpstream('cdn.test', gate(['64:ff9b::808:808']));
    assert.equal(r.ok, true);
  });
});
