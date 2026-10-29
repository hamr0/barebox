// Wall unit tests: `denyReasonForIp` spellings and stubbed-DNS `checkUpstream`.
// Pure functions only: no sockets, no bwrap, green everywhere.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
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

describe("host-local: every spelling of the host's own address", () => {
  const realInterfaces = os.networkInterfaces;
  const stub = (ifs) => { os.networkInterfaces = () => ifs; };
  const restore = () => { os.networkInterfaces = realInterfaces; };

  const v6rows = [
    ['2001:db8::1', 'host-local'],
    ['2001:db8:0:0:0:0:0:1', 'host-local'],
    ['2001:0db8::1', 'host-local'],
    ['2001:DB8::0:1', 'host-local'],
    ['[2001:db8::1]', 'host-local'],
    ['2001:db8::2', null],
  ];
  for (const [addr, want] of v6rows) {
    it(`${addr} → ${want ?? 'allowed'}`, () => {
      stub({ eth0: [{ address: '2001:db8::1', family: 'IPv6', internal: false }] });
      try {
        assert.equal(denyReasonForIp(addr, false), want, addr);
      } finally {
        restore();
      }
    });
  }

  it('the IPv4 path is untouched', () => {
    stub({ eth0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }] });
    try {
      assert.equal(denyReasonForIp('203.0.113.7', false), 'host-local');
      assert.equal(denyReasonForIp('::ffff:203.0.113.7', false), 'host-local');
    } finally {
      restore();
    }
  });

  it('a throwing networkInterfaces loses host-local, nothing throws', () => {
    os.networkInterfaces = () => { throw new Error('hidden'); };
    try {
      assert.equal(denyReasonForIp('2001:db8::1', false), null);
    } finally {
      restore();
    }
  });
});
