// M10: the body view. Unit tests: decoding, the 64 KB stop, the one-decoder
// queue and get(path).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { viewBody } from '../src/bodyview.js';

const gz = (s) => zlib.gzipSync(Buffer.from(s));
const bomb = () => zlib.gzipSync(Buffer.alloc(64e6));

describe('viewBody states', () => {
  it('no encoding and identity are plain, text is the same buffer', { timeout: 5000 }, async () => {
    const b = Buffer.from('hello');
    for (const h of [{}, { 'content-encoding': 'identity' }, { 'content-encoding': ' Identity ' }]) {
      const v = await viewBody(b, h);
      assert.equal(v.state, 'plain');
      assert.equal(v.text, b);
    }
  });

  it('gzip, x-gzip and deflate decode', { timeout: 5000 }, async () => {
    for (const [enc, buf] of [['gzip', gz('4111111111111111')], ['X-GZIP', gz('4111111111111111')],
      [' deflate ', zlib.deflateSync(Buffer.from('4111111111111111'))]]) {
      const v = await viewBody(buf, { 'content-encoding': enc });
      assert.equal(v.state, 'decoded', enc);
      assert.equal(v.text.toString(), '4111111111111111');
    }
  });

  it('br, zstd and lists are unread and not decoded', { timeout: 5000 }, async () => {
    const b = zlib.brotliCompressSync(Buffer.from('4111111111111111'));
    for (const enc of ['br', 'zstd', 'gzip, br', 'gzip, gzip']) {
      const v = await viewBody(b, { 'content-encoding': enc });
      assert.equal(v.state, 'unread', enc);
      assert.equal(v.text, b);
    }
  });

  it('a false gzip label is unread and keeps the raw bytes', { timeout: 5000 }, async () => {
    const b = Buffer.from('plain 4111111111111111');
    const v = await viewBody(b, { 'content-encoding': 'gzip' });
    assert.equal(v.state, 'unread');
    assert.equal(v.text, b);
  });

  it('a bomb stops at 65536 bytes, truncated, in under 1 s', { timeout: 5000 }, async () => {
    const b = bomb();
    assert.ok(b.length < 65536);
    const t0 = Date.now();
    const v = await viewBody(b, { 'content-encoding': 'gzip' });
    assert.equal(v.state, 'truncated');
    assert.equal(v.text.length, 65536);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  });
});

describe('the one-decoder queue', () => {
  // zlib's factories are read-only but configurable: wrap one to watch its decoders.
  async function watched(fn) {
    const orig = zlib.createGunzip;
    const st = { live: 0, peak: 0, emitted: 0 };
    Object.defineProperty(zlib, 'createGunzip', { configurable: true, writable: true, value: (...a) => {
      const z = orig(...a);
      st.live++;
      st.peak = Math.max(st.peak, st.live);
      z.on('data', (c) => { st.emitted += c.length; });
      z.on('close', () => { st.live--; });
      return z;
    } });
    try { await fn(st); } finally { Object.defineProperty(zlib, 'createGunzip', { configurable: true, writable: false, value: orig }); }
  }

  it('20 concurrent bombs never run more than one decoder', { timeout: 20000 }, async () => {
    await watched(async (st) => {
      const b = bomb();
      const views = await Promise.all(Array.from({ length: 20 }, () => viewBody(b, { 'content-encoding': 'gzip' })));
      assert.ok(views.every((v) => v.state === 'truncated'));
      assert.equal(st.peak, 1);
      assert.equal(st.live, 0);
    });
  });

  it('destroy() at the cap: a 64 MB bomb emits well under 1 MB from the decoder', { timeout: 10000 }, async () => {
    await watched(async (st) => {
      await viewBody(bomb(), { 'content-encoding': 'gzip' });
      assert.ok(st.emitted < 1e6, `decoder emitted ${st.emitted} bytes`);
    });
  });

  it('a decode error in the middle does not stall the queue', { timeout: 10000 }, async () => {
    const h = { 'content-encoding': 'gzip' };
    const [a, bad, c] = await Promise.all([viewBody(gz('one'), h), viewBody(Buffer.from('not gzip'), h), viewBody(gz('three'), h)]);
    assert.equal(a.text.toString(), 'one');
    assert.equal(bad.state, 'unread');
    assert.equal(c.text.toString(), 'three');
    assert.equal((await viewBody(gz('four'), h)).text.toString(), 'four');
  });
});

describe('get(path)', () => {
  const json = (o, ct = 'application/json') => viewBody(Buffer.from(JSON.stringify(o)), { 'content-type': ct });

  it('walks nested JSON and array indexes', { timeout: 5000 }, async () => {
    const v = await json({ personalizations: [{ to: [{ email: 'a@b.c' }] }], n: 0, x: null });
    assert.equal(v.get('personalizations.0.to.0.email'), 'a@b.c');
    assert.equal(v.get('n'), 0);
    assert.equal(v.get('x'), null);
    assert.equal(v.get('personalizations.1'), undefined);
    assert.equal(v.get('personalizations.length'), undefined);
    assert.equal(v.get('nope.deeper'), undefined);
  });

  it('+json with parameters', { timeout: 5000 }, async () => {
    const v = await json({ a: { b: 1 } }, 'application/vnd.api+json; charset=utf-8');
    assert.equal(v.get('a.b'), 1);
  });

  it('reads a decoded gzip JSON body', { timeout: 5000 }, async () => {
    const v = await viewBody(gz('{"a":{"b":2}}'), { 'content-encoding': 'gzip', 'content-type': 'application/json' });
    assert.equal(v.get('a.b'), 2);
  });

  it('form keys as sent, first value', { timeout: 5000 }, async () => {
    const v = await viewBody(Buffer.from('metadata[x]=1&metadata[x]=2&amount=5'), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(v.get('metadata[x]'), '1');
    assert.equal(v.get('amount'), '5');
    assert.equal(v.get('missing'), undefined);
  });

  it('truncated, invalid and unread bodies give undefined', { timeout: 10000 }, async () => {
    const big = { pad: 'a'.repeat(100000), a: 1 };
    const t = await viewBody(zlib.gzipSync(Buffer.from(JSON.stringify(big))), { 'content-encoding': 'gzip', 'content-type': 'application/json' });
    assert.equal(t.state, 'truncated');
    assert.equal(t.get('a'), undefined);
    const bad = await viewBody(Buffer.from('{"a":'), { 'content-type': 'application/json' });
    assert.equal(bad.get('a'), undefined);
    const un = await viewBody(Buffer.from('{"a":1}'), { 'content-type': 'application/json', 'content-encoding': 'br' });
    assert.equal(un.state, 'unread');
    assert.equal(un.get('a'), undefined);
  });

  it('prototype keys and unknown types give undefined, and nothing throws', { timeout: 5000 }, async () => {
    const v = await json({ a: 1 });
    for (const k of ['__proto__', 'constructor', 'a.__proto__', 'toString', 'a.constructor', '']) {
      assert.equal(v.get(k), undefined, k);
    }
    const f = await viewBody(Buffer.from('a=1'), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(f.get('__proto__'), undefined);
    assert.equal(f.get('constructor'), undefined);
    for (const ct of ['text/plain', 'multipart/form-data; boundary=x', undefined]) {
      const u = await viewBody(Buffer.from('{"a":1}'), ct ? { 'content-type': ct } : {});
      assert.equal(u.get('a'), undefined);
    }
    const bad = await viewBody(Buffer.from('{"a":'), { 'content-type': 'application/json' });
    assert.doesNotThrow(() => bad.get('a'));
  });
});
