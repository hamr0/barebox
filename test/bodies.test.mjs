// M3 bodies: the agent's working slot, the card floor on small bodies, held
// bodies spooled to <runtime>/held, and one masked preview for log and ask.
// Real proxy, real sockets, async clients only (a sync child client would
// deadlock the in-process proxy). Everything rides the TCP door ('tcp' agent)
// so no unix socket is needed; agents are named only where a test removes one.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../src/proxy.js';
import { startHttp } from './fixtures/upstream.mjs';

const CARD = '4242 4242 4242 4242';
const CARD_RULE = 'card number in body (floor)';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await nap(25);
  }
}

/** Deterministic non-text-looking filler of exactly n bytes, free of card-shaped digit runs. */
function filler(n, seed = 1) {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 97 + (x >> 16) % 26; // letters only: no digits, so never a card
  }
  return out;
}

let up;
before(async () => { up = await startHttp(); });
after(async () => { await up?.close(); });

/**
 * One proxy on its own runtime, torn down after `fn`. The decision seam is
 * trust-like: only paths containing /hold park (reason 'test hold').
 */
async function withProxy(holdExtra, fn) {
  const rt = mkdtempSync(join(tmpdir(), 'bb-bodies-'));
  const logFile = join(rt, 'mitm.log');
  const proxy = createProxy({ port: 0, logFile, runtime: rt, clientIdleMs: 5000,
    unsafeTestOnly: { allowLoopback: true },
    hold: { shouldHold: (r) => (new URL(r.url).pathname.includes('/hold') ? 'test hold' : null),
      timeoutMs: 15000, pollMs: 25, ...holdExtra } });
  const { port } = await proxy.ready;
  const t = {
    rt, proxy, port,
    heldDir: join(rt, 'held'),
    heldFiles: () => { try { return readdirSync(join(rt, 'held')); } catch { return []; } },
    askOf: (id) => JSON.parse(readFileSync(join(rt, 'asks', `${id}.json`), 'utf8')),
    answer(id, obj) {
      const dir = join(rt, 'answers');
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${id}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, join(dir, `${id}.json`));
    },
    logLines: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    parked: (n = 1) => waitFor(() => (proxy.pending().length >= n ? proxy.pending() : null), `${n} hold(s) to park`),
    /** Send through the proxy; `done` resolves { status, body: Buffer }. */
    send(path, body, { method = 'POST', chunked = false, headers = {} } = {}) {
      const req = http.request({ host: '127.0.0.1', port, method,
        path: `${up.url}${path}`, headers: { host: `127.0.0.1:${up.port}`, ...headers } });
      const done = new Promise((resolve, reject) => {
        req.on('response', (res) => {
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
        });
        req.on('error', reject);
      });
      done.catch(() => {});
      if (body !== undefined) {
        if (chunked) { for (let i = 0; i < body.length; i += 1000) req.write(body.subarray(i, i + 1000)); req.end(); }
        else { req.setHeader('content-length', body.length); req.end(body); }
      } else req.end();
      return { req, done };
    },
  };
  try {
    return await fn(t);
  } finally {
    await Promise.race([proxy.close(), nap(5000)]);
    rmSync(rt, { recursive: true, force: true });
  }
}

describe('card floor on small allowed bodies', () => {
  it('a 2 KB body with a card parks in any mode; approve forwards exact bytes', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const body = Buffer.concat([filler(1000), Buffer.from(` card ${CARD} end `), filler(1000, 2)]);
      const { done } = t.send('ok', body);
      const [h] = await t.parked();
      assert.equal(h.rule, CARD_RULE);
      const ask = t.askOf(h.id);
      assert.equal(ask.rule, CARD_RULE);
      assert.match(ask.bodyPreview, /\*{4} \*{4} \*{4} 4242/);
      assert.ok(!ask.bodyPreview.includes('4242 4242'), 'the card is masked in the ask');
      t.answer(h.id, { decision: 'allow' });
      const r = await done;
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(body), 'upstream received the exact bytes');
      await waitFor(() => t.heldFiles().length === 0, 'held file gone after approve');
    });
  });

  it('deny answers 403', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('ok', Buffer.from(`pay ${CARD}`));
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'deny', reason: 'no cards' });
      const r = await done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /denied: no cards/);
      await waitFor(() => t.heldFiles().length === 0, 'held file gone after deny');
    });
  });

  it('no card, small body: forwarded at once, no ask, exact bytes', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const body = filler(2048, 3);
      const r = await t.send('ok', body).done;
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(body));
      assert.equal(t.proxy.pending().length, 0);
      assert.deepEqual(t.heldFiles(), []);
    });
  });

  it('a 200 KB body with a card near its end is forwarded unchecked (known gap)', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const body = Buffer.concat([filler(200 * 1024), Buffer.from(` ${CARD} `)]);
      const r = await t.send('ok', body).done;
      assert.equal(r.status, 200);
      assert.equal(sha(r.body), sha(body), 'upstream received the exact bytes');
      assert.equal(t.proxy.pending().length, 0, 'no ask');
    });
  });
});

describe('the working slot', () => {
  it('no freeze: a card ask parked does not block the same agent\'s next POST', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      t.send('ok', Buffer.from(`pay ${CARD}`));
      await t.parked();
      const body = filler(500, 4);
      const r = await Promise.race([t.send('ok', body).done, nap(5000).then(() => 'FROZEN')]);
      assert.notEqual(r, 'FROZEN', 'second POST must complete while the ask is parked');
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(body));
      assert.equal(t.proxy.pending().length, 1, 'the card ask is still parked');
    });
  });

  it('two concurrent POSTs from one agent both complete with exact bytes', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const bodies = [filler(3000, 5), filler(40000, 6), filler(200000, 7), filler(10, 8)];
      const rs = await Promise.all(bodies.map((b) => t.send('ok', b).done));
      rs.forEach((r, i) => {
        assert.equal(r.status, 200);
        assert.equal(sha(r.body), sha(bodies[i]), `body ${i} exact`);
      });
    });
  });

  it('a client that dies mid-body frees the slot for the next request', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      // Promise 100 bytes, send 10, then drop the socket.
      const s = net.connect(t.port, '127.0.0.1');
      await once(s, 'connect');
      s.on('error', () => {});
      s.write(`POST ${up.url}ok HTTP/1.1\r\nHost: 127.0.0.1:${up.port}\r\nContent-Length: 100\r\n\r\n0123456789`);
      await nap(200);
      s.destroy();
      const body = filler(100, 9);
      const r = await Promise.race([t.send('ok', body).done, nap(5000).then(() => 'WEDGED')]);
      assert.notEqual(r, 'WEDGED');
      assert.ok(r.body.equals(body));
    });
  });
});

describe('held bodies live on disk', () => {
  const big = filler(2 * 1024 * 1024, 10);

  it('approve: the file holds all 2 MB while parked, upstream gets exact bytes, file gone', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('hold', big);
      const [h] = await t.parked();
      const file = join(t.heldDir, h.id);
      assert.equal(statSync(file).size, big.length);
      assert.equal(sha(readFileSync(file)), sha(big));
      t.answer(h.id, { decision: 'allow' });
      const r = await done;
      assert.equal(sha(r.body), sha(big));
      await waitFor(() => !existsSync(file), 'file gone after approve');
    });
  });

  it('deny: file gone', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('hold', big);
      const [h] = await t.parked();
      assert.ok(existsSync(join(t.heldDir, h.id)));
      t.answer(h.id, { decision: 'deny', reason: 'no' });
      assert.equal((await done).status, 403);
      assert.deepEqual(t.heldFiles(), []);
    });
  });

  it('timeout: file gone', { timeout: 30000 }, async () => {
    await withProxy({ timeoutMs: 700 }, async (t) => {
      const { done } = t.send('hold', big);
      const [h] = await t.parked();
      assert.ok(existsSync(join(t.heldDir, h.id)));
      const r = await done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /hold timeout/);
      assert.deepEqual(t.heldFiles(), []);
    });
  });

  it('client gone: file gone, and a late approve forwards nothing', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const before = up.hits.get('/hold') ?? 0;
      const { req } = t.send('hold', big);
      const [h] = await t.parked();
      assert.ok(existsSync(join(t.heldDir, h.id)));
      req.destroy();
      await waitFor(() => t.heldFiles().length === 0, 'file gone after the client left');
      t.answer(h.id, { decision: 'allow' });
      await nap(200);
      assert.equal(up.hits.get('/hold') ?? 0, before);
    });
  });

  it('proxy close with a parked hold: file gone', { timeout: 30000 }, async () => {
    const rt = await withProxy({}, async (t) => {
      const { done } = t.send('hold', big);
      done.catch(() => {});
      await t.parked();
      assert.equal(t.heldFiles().length, 1);
      await t.proxy.close();
      assert.deepEqual(t.heldFiles(), []);
      return t.rt;
    });
    assert.ok(rt);
  });

  it('removeAgent with a parked hold: file gone', { timeout: 30000 }, async (tc) => {
    const probe = join(tmpdir(), `bb-bodies-probe-${process.pid}.sock`);
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.on('error', () => resolve(false));
      s.listen(probe, () => s.close(() => { try { rmSync(probe); } catch {} resolve(true); }));
    });
    if (!ok) { tc.skip('unix socket bind blocked here'); return; }
    await withProxy({}, async (t) => {
      const sockPath = t.proxy.addAgent('ba');
      const s = net.connect(sockPath);
      s.on('error', () => {});
      await once(s, 'connect');
      s.write(`POST http://127.0.0.1:${up.port}/hold HTTP/1.1\r\nHost: 127.0.0.1:${up.port}\r\nContent-Length: 5\r\n\r\nm=RA1`);
      await t.parked();
      assert.equal(t.heldFiles().length, 1);
      t.proxy.removeAgent('ba');
      assert.deepEqual(t.heldFiles(), []);
      s.destroy();
    });
  });

  it('over the cap: 403 body too large to hold, no file left, upstream never hit', { timeout: 30000 }, async () => {
    await withProxy({ maxBody: 1000 }, async (t) => {
      const before = up.hits.get('/hold') ?? 0;
      const r = await t.send('hold', filler(5000, 11)).done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /body too large to hold/);
      assert.deepEqual(t.heldFiles(), []);
      assert.equal(t.proxy.pending().length, 0);
      assert.equal(up.hits.get('/hold') ?? 0, before);
    });
  });

  it('chunked (no content-length): forwarded on approve with exact bytes', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const body = filler(30000, 12);
      const { done } = t.send('hold', body, { chunked: true });
      const [h] = await t.parked();
      assert.equal(statSync(join(t.heldDir, h.id)).size, body.length);
      t.answer(h.id, { decision: 'allow' });
      const r = await done;
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(body));
    });
  });

  it('a held GET with no body parks and forwards with no file', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('hold', undefined, { method: 'GET' });
      const [h] = await t.parked();
      assert.ok(!existsSync(join(t.heldDir, h.id)));
      t.answer(h.id, { decision: 'allow' });
      assert.equal((await done).status, 200);
    });
  });

  it('a stale file from a dead queue is cleared at start', { timeout: 20000 }, async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-bodies-stale-'));
    try {
      mkdirSync(join(rt, 'held'), { recursive: true });
      writeFileSync(join(rt, 'held', 'h1'), 'orphan');
      const p = createProxy({ port: 0, logFile: join(rt, 'mitm.log'), runtime: rt, hold: { match: '/x' } });
      await p.ready;
      assert.deepEqual(readdirSync(join(rt, 'held')), []);
      await p.close();
    } finally { rmSync(rt, { recursive: true, force: true }); }
  });
});

describe('one preview for the log and the ask', () => {
  it('a 1 MB allowed POST logs bytes, sha256 and a preview of at most 4096 bytes', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const body = filler(1024 * 1024, 13);
      const r = await t.send('ok?m=BIG1', body).done;
      assert.equal(sha(r.body), sha(body));
      const line = await waitFor(() => t.logLines().find((l) => l.ev === 'req' && /m=BIG1/.test(l.url)), 'req line');
      assert.equal(line.bodyBytes, 1048576);
      assert.equal(line.bodySha256, sha(body));
      assert.ok(Buffer.byteLength(line.bodyPreview) <= 4096);
      assert.equal(line.bodyPreview, body.subarray(0, 4096).toString('utf8'));
      assert.ok(!('body' in line) && !('truncated' in line));
    });
  });

  it('a card in a small allowed body is masked in the log preview', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('ok?m=CARDLOG', Buffer.from(`order ${CARD} please`));
      const [h] = await t.parked();
      const line = await waitFor(() => t.logLines().find((l) => l.ev === 'req' && /m=CARDLOG/.test(l.url)), 'req line');
      assert.equal(line.bodyPreview, 'order **** **** **** 4242 please');
      assert.ok(!JSON.stringify(t.logLines()).includes(CARD), 'the raw card never reaches the log');
      t.answer(h.id, { decision: 'deny' });
      await done;
    });
  });

  it('a held body: the ask preview is the same masked 4 KB, truncated flagged', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      const body = Buffer.concat([Buffer.from(`${CARD} `), filler(10000, 14)]);
      const { done } = t.send('hold', body);
      const [h] = await t.parked();
      const ask = t.askOf(h.id);
      assert.equal(ask.truncated, true);
      assert.ok(Buffer.byteLength(ask.bodyPreview) <= 4096);
      assert.match(ask.bodyPreview, /^\*{4} \*{4} \*{4} 4242 /);
      const line = t.logLines().find((l) => l.ev === 'req' && l.bodySha256 === sha(body));
      assert.ok(line, 'req line with the full-body hash');
      assert.equal(line.bodyPreview, ask.bodyPreview, 'log and ask carry one preview');
      t.answer(h.id, { decision: 'deny' });
      await done;
    });
  });

  it('no req line ever carries more than 4 KB of body', { timeout: 30000 }, async () => {
    await withProxy({}, async (t) => {
      await t.send('ok', filler(300000, 15)).done;
      await t.send('ok', filler(50000, 16)).done;
      await waitFor(() => t.logLines().filter((l) => l.ev === 'req').length >= 2, 'req lines');
      for (const l of t.logLines().filter((x) => x.ev === 'req')) {
        assert.ok(Buffer.byteLength(l.bodyPreview) <= 4096);
        assert.ok(!('body' in l));
      }
    });
  });
});
