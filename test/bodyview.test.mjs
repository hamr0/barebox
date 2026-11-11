// M10: the body view. Unit tests: decoding, the 64 KB stop, the one-decoder
// queue and broken bodies.
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

describe('raw deflate is not decoded (known gap)', () => {
  it('a plain JSON body with a false deflate label is unread, text is the body', async () => {
    const body = Buffer.from('{\n  "card": "4111111111111111"\n}');
    const v = await viewBody(body, { 'content-encoding': 'deflate' });
    assert.equal(v.state, 'unread');
    assert.ok(v.text.equals(body));
  });

  it('a genuine raw deflate body sent as deflate is unread, text is the raw body', async () => {
    const body = zlib.deflateRawSync(Buffer.from('pay 4111111111111111 now'));
    const v = await viewBody(body, { 'content-encoding': 'deflate' });
    assert.equal(v.state, 'unread');
    assert.ok(v.text.equals(body));
  });
});

describe('broken gzip bodies are scanned, not dodged', () => {
  const h = { 'content-encoding': 'gzip' };
  const CARD = '4242 4242 4242 4242';

  it('output before an error is kept and the raw bytes follow', { timeout: 5000 }, async () => {
    const text = `pay ${CARD} now ${'x'.repeat(1000)}` + Array.from({ length: 30000 }, () => Math.random().toString(36)[2]).join('');
    const body = Buffer.concat([zlib.gzipSync(Buffer.from(text)), Buffer.from('garbage')]);
    const v = await viewBody(body, h);
    assert.equal(v.state, 'unread');
    assert.ok(v.text.includes(CARD), 'the card in the first 1 KB is in text');
  });

  it('a member followed by garbage with the card at the end stays unread, raw (known gap)', { timeout: 5000 }, async () => {
    const body = Buffer.concat([zlib.gzipSync(Buffer.from(`pay ${CARD} now ${'x'.repeat(200)}`)), Buffer.from('garbage')]);
    const v = await viewBody(body, h);
    assert.equal(v.state, 'unread');
    assert.ok(v.text.equals(body));
  });
});
