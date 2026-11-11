// M3 B1: bareguard decides every request. Real proxy, real sockets, the real
// policy gates (modes), plus plain check objects. Async clients only (a sync
// child client would deadlock the in-process proxy); everything rides the TCP
// door except the localLlm test, which needs a real sandbox.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { createProxy } from '../src/proxy.js';
import { run } from '../src/run.js';
import { gateFor as policyGate, MODES, modelTools, modelList, buildTools, toolFor, emptyMatcher } from '../src/policy.js';
import { runtimePaths } from '../src/runtime.js';
import { startHttp } from './fixtures/upstream.mjs';
import { bwrapUsable, hasBin } from './fixtures/probes.mjs';

const CARD = '4242 4242 4242 4242';
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

/** Deterministic letters-only filler: never card-shaped. */
function filler(n, seed = 1) {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 97 + (x >> 16) % 26;
  }
  return out;
}

let up;
before(async () => { up = await startHttp(); });
after(async () => { await up?.close(); });

/**
 * One proxy on its own runtime. `mode` builds the real policy gates; a
 * `gateFor` option replaces them with a test gate. Torn down after `fn`.
 */
async function withProxy({ mode = 'auto', gateFor, hold = {}, proxyOpts = {} }, fn) {
  const rt = mkdtempSync(join(tmpdir(), 'bb-gate-'));
  const paths = runtimePaths(rt);
  const proxy = createProxy({ port: 0, logFile: paths.audit, runtime: rt, clientIdleMs: 5000,
    unsafeTestOnly: { allowLoopback: true }, ...proxyOpts,
    gateFor: gateFor ?? ((agent, { humanChannel, tools }) =>
      policyGate({ agent, mode, auditPath: paths.audit, humanChannel, tools })),
    hold: { timeoutMs: 15000, pollMs: 25, ...hold } });
  const { port } = await proxy.ready;
  const t = {
    rt, proxy, port, paths,
    heldFiles: () => { try { return readdirSync(paths.heldDir); } catch { return []; } },
    askOf: (id) => JSON.parse(readFileSync(paths.askFile(id), 'utf8')),
    answer(id, obj) {
      mkdirSync(paths.answersDir, { recursive: true });
      const tmp = join(paths.answersDir, `.${id}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, paths.answerFile(id));
    },
    gateLines: () => {
      try { return readFileSync(paths.audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    },
    parked: (n = 1) => waitFor(() => (proxy.pending().length >= n ? proxy.pending() : null), `${n} hold(s) to park`),
    send(path, body, { method = 'POST', headers = {} } = {}) {
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
      if (body !== undefined) { req.setHeader('content-length', body.length); req.end(body); }
      else req.end();
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

describe('modes decide through the gate', () => {
  for (const mode of ['ask', 'auto']) {
    it(`${mode}: GET forwards, POST asks`, { timeout: 20000 }, async () => {
      await withProxy({ mode }, async (t) => {
        const g = await t.send('plain', undefined, { method: 'GET' }).done;
        assert.equal(g.status, 200);
        assert.equal(g.body.toString(), 'local-ok');
        assert.equal(t.proxy.pending().length, 0, 'GET never asks');
        const { done } = t.send('plain', Buffer.from('m=1'));
        const [h] = await t.parked();
        assert.equal(h.rule, 'rwx.ask');
        assert.equal(t.askOf(h.id).letter, 'x');
        t.answer(h.id, { decision: 'deny', reason: 'no' });
        assert.equal((await done).status, 403);
      });
    });
  }

  it('ask: a HEAD request is a read and forwards', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'ask' }, async (t) => {
      assert.equal((await t.send('plain', undefined, { method: 'HEAD' }).done).status, 200);
      assert.equal(t.proxy.pending().length, 0);
    });
  });

  it('trust: POST forwards without asking', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      const r = await t.send('plain', Buffer.from('m=TRUST')).done;
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), 'm=TRUST');
      assert.equal(t.proxy.pending().length, 0);
    });
  });

  for (const mode of MODES) {
    it(`${mode}: an OPTIONS request is denied as rwx.unlisted, never asked`, { timeout: 20000 }, async () => {
      await withProxy({ mode }, async (t) => {
        const r = await t.send('plain', undefined, { method: 'OPTIONS' }).done;
        assert.equal(r.status, 403);
        assert.match(r.body.toString(), /rwx\.unlisted/);
        assert.equal(t.proxy.pending().length, 0);
      });
    });
  }
});

describe('model calls skip the card floor', () => {
  const MODEL = 'v1/chat/completions';
  const opts = () => ({ allowLocal: [`127.0.0.1:${up.port}`] });
  for (const mode of MODES) {
    it(`${mode}: a card in the body of a local-model call forwards with no hold`, { timeout: 20000 }, async () => {
      await withProxy({ mode, proxyOpts: opts() }, async (t) => {
        const r = await t.send(MODEL, Buffer.from(`pay ${CARD} now`)).done;
        assert.equal(r.status, 200);
        assert.equal(r.body.toString(), `pay ${CARD} now`);
        assert.equal(t.proxy.pending().length, 0);
      });
    });
  }

  for (const mode of MODES) {
    it(`${mode}: control, the same body to a non-model path still asks flags.cardLike`, { timeout: 20000 }, async () => {
      await withProxy({ mode, proxyOpts: opts() }, async (t) => {
        const { done } = t.send('v1/other', Buffer.from(`pay ${CARD} now`));
        const [h] = await t.parked();
        assert.equal(h.rule, 'flags.cardLike');
        t.answer(h.id, { decision: 'deny' });
        assert.equal((await done).status, 403);
      });
    });
  }

  it('a payment path on a model host still asks (paymentPath unchanged)', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust', proxyOpts: opts() }, async (t) => {
      const { done } = t.send('v1/chat/completions/checkout', Buffer.from('m=1'));
      const [h] = await t.parked();
      assert.equal(h.rule, 'flags.paymentPath');
      t.answer(h.id, { decision: 'deny' });
      assert.equal((await done).status, 403);
    });
  });

  it('a label tool that shares a model key is not a model', () => {
    const key = [...modelTools({}, ['h:1'])].find((k) => k.startsWith('h:1.'));
    assert.ok(key);
    assert.ok(modelTools({}, ['h:1']).has(key));
    assert.ok(!modelTools({ [key]: { letter: 'x' } }, ['h:1']).has(key));
  });
});

describe('model endpoint names', () => {
  /** One gate decision through the real policy gate. @returns {Promise<{tool: string, outcome: string}>} */
  async function decideModel({ mode, localLlm = [], method, url }) {
    const tools = buildTools({}, localLlm);
    const tool = toolFor(emptyMatcher, tools, method, url, modelList(localLlm));
    const dir = mkdtempSync(join(tmpdir(), 'bb-mod-'));
    try {
      const asks = [];
      const gate = await policyGate({ agent: 'a', mode, tools, auditPath: join(dir, 'a.jsonl'),
        humanChannel: async (e) => { asks.push(e.rule); return { decision: 'deny' }; } });
      const d = await gate.check({ type: 'net', tool, url, method, agent: 'a' });
      return { tool, outcome: asks.length ? 'ask' : d.outcome };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('ask: a model URL with a trailing-dot host is the model tool and is allowed', async () => {
    const r = await decideModel({ mode: 'ask', method: 'POST', url: 'https://api.anthropic.com./v1/messages' });
    assert.deepEqual(r, { tool: 'api.anthropic.com.POST /v1/messages', outcome: 'allow' });
  });

  it('a local model server\'s paths are not models on another host (one sidecar per host)', async () => {
    const localLlm = ['127.0.0.1:11434'];
    const own = await decideModel({ mode: 'ask', localLlm, method: 'POST', url: 'http://127.0.0.1:11434/api/chat' });
    assert.equal(own.tool, '127.0.0.1:11434.POST /api/chat');
    const other = await decideModel({ mode: 'ask', localLlm, method: 'POST', url: 'https://api.anthropic.com/api/chat' });
    assert.equal(other.tool, 'http.POST');
    assert.equal(other.outcome, 'ask');
  });

  it('a localLlm host on a default port works: the port is dropped from the URL host', () => {
    for (const [hp, host, scheme] of [['localhost:80', 'localhost', 'http'], ['127.0.0.1:443', '127.0.0.1', 'https']]) {
      const list = modelList([hp]);
      const tools = buildTools({}, [hp]);
      const name = `${host}.POST /api/chat`;
      assert.equal(toolFor(emptyMatcher, tools, 'POST', `${scheme}://${hp}/api/chat`, list), name);
      assert.equal(toolFor(emptyMatcher, tools, 'POST', `${scheme}://${host}/api/chat`, list), name);
    }
  });

  it('toolFor without a model list throws instead of returning http.POST', () => {
    assert.throws(() => toolFor(emptyMatcher, buildTools(), 'POST', 'https://api.anthropic.com/v1/messages'));
  });

  it('no model tool name moved', () => {
    const expected = [
      'api.anthropic.com.POST /v1/messages',
      'api.anthropic.com.POST /v1/messages/count_tokens',
      'api.openai.com.POST /v1/chat/completions',
      'api.openai.com.POST /v1/responses',
      'api.openai.com.POST /v1/embeddings',
      '127.0.0.1:11434.POST /api/chat',
      '127.0.0.1:11434.POST /api/generate',
      '127.0.0.1:11434.POST /api/embed',
      '127.0.0.1:11434.POST /v1/chat/completions',
      '127.0.0.1:11434.POST /v1/completions',
    ];
    assert.deepEqual([...modelTools({}, ['127.0.0.1:11434'])].sort(), [...expected].sort());
    const tools = buildTools({}, ['127.0.0.1:11434']);
    const list = modelList(['127.0.0.1:11434']);
    for (const name of expected) {
      const i = name.indexOf('.POST ');
      const url = `${name.startsWith('127') ? 'http' : 'https'}://${name.slice(0, i)}${name.slice(i + 6)}`;
      assert.equal(toolFor(emptyMatcher, tools, 'POST', url, list), name);
    }
  });
});

describe('the floor asks in trust mode', () => {
  it('a small body with a card asks (flags.cardLike); the card is masked in the ask', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      const { done } = t.send('plain', Buffer.from(`pay ${CARD} now`));
      const [h] = await t.parked();
      assert.equal(h.rule, 'flags.cardLike');
      assert.ok(!t.askOf(h.id).bodyPreview.includes('4242 4242'));
      t.answer(h.id, { decision: 'deny' });
      assert.equal((await done).status, 403);
    });
  });

  it('a POST to /checkout asks (flags.paymentPath)', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      const { done } = t.send('checkout', Buffer.from('m=1'));
      const [h] = await t.parked();
      assert.equal(h.rule, 'flags.paymentPath');
      t.answer(h.id, { decision: 'deny' });
      assert.equal((await done).status, 403);
    });
  });

  it('a card past 64 KB streams through unchecked (the known gap)', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      const body = Buffer.concat([filler(70000), Buffer.from(` ${CARD} `)]);
      const r = await t.send('plain', body).done;
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(body));
    });
  });
});

describe('the card floor reads gzip and deflate bodies (M10)', () => {
  const GZ = { 'content-encoding': 'gzip' };
  const model = () => ({ allowLocal: [`127.0.0.1:${up.port}`] });
  const asksCard = async (t, body, headers) => {
    const { done } = t.send('plain', body, { headers });
    const [h] = await t.parked();
    assert.equal(h.rule, 'flags.cardLike');
    t.answer(h.id, { decision: 'deny' });
    assert.equal((await done).status, 403);
  };

  it('a gzip body with a card asks in trust mode', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => asksCard(t, zlib.gzipSync(Buffer.from(`pay ${CARD} now`)), GZ));
  });

  it('a deflate body with a card asks in trust mode', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => asksCard(t, zlib.deflateSync(Buffer.from(`pay ${CARD} now`)), { 'content-encoding': 'deflate' }));
  });

  it('a plain body with a card and a false Content-Encoding: gzip still asks', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => asksCard(t, Buffer.from(`pay ${CARD} now`), GZ));
  });

  it('a br-labelled plain body with a card asks (scanned as sent)', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => asksCard(t, Buffer.from(`pay ${CARD} now`), { 'content-encoding': 'br' }));
  });

  it('a 62 KB bomb is decided normally: a GET (r) in auto reaches the upstream', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const bomb = zlib.gzipSync(Buffer.alloc(64e6));
      assert.ok(bomb.length < 65536);
      const before = up.hits.get('/plain') ?? 0;
      const r = await t.send('plain', bomb, { method: 'GET', headers: GZ }).done;
      assert.equal(r.status, 200);
      assert.equal((up.hits.get('/plain') ?? 0), before + 1);
      assert.equal(t.proxy.pending().length, 0);
    });
  });

  it('the upstream gets the identical compressed bytes and content-encoding', { timeout: 20000 }, async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => { seen.push({ enc: req.headers['content-encoding'], body: Buffer.concat(parts) }); res.end('ok'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await withProxy({ mode: 'trust' }, async (t) => {
        const body = zlib.gzipSync(Buffer.from('{"hello":"world"}'));
        const r = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST',
            path: `http://127.0.0.1:${srv.address().port}/x`,
            headers: { host: `127.0.0.1:${srv.address().port}`, 'content-encoding': 'gzip',
              'content-type': 'application/json', 'content-length': body.length } });
          req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject);
          req.end(body);
        });
        assert.equal(r, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].enc, 'gzip');
        assert.ok(seen[0].body.equals(body));
      });
    } finally { await new Promise((r) => srv.close(r)); }
  });

  it('a held gzip JSON body previews decoded, card masked', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ note: 'hello', card: CARD })));
      const { done } = t.send('plain', body, { headers: { ...GZ, 'content-type': 'application/json' } });
      const [h] = await t.parked();
      const prev = t.askOf(h.id).bodyPreview;
      assert.ok(prev.startsWith('{"note":"hello","card":"'), prev);
      assert.ok(!prev.includes('4242 4242'), prev);
      t.answer(h.id, { decision: 'deny' });
      await done;
    });
  });

  it('a gzip body with a card to a built-in model endpoint is not card-asked', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust', proxyOpts: model() }, async (t) => {
      const r = await t.send('v1/chat/completions', zlib.gzipSync(Buffer.from(`pay ${CARD} now`)), { headers: GZ }).done;
      assert.equal(r.status, 200);
      assert.equal(t.proxy.pending().length, 0);
    });
  });
});

describe('answers', () => {
  it('approve forwards the exact bytes, a held body over 64 KB included', { timeout: 30000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      for (const n of [3000, 200000]) {
        const body = filler(n, n);
        const { done } = t.send('plain', body);
        const [h] = await t.parked();
        assert.equal(h.rule, 'rwx.ask');
        assert.ok(t.heldFiles().includes(h.id), 'the body is spooled to held/<id>');
        t.answer(h.id, { decision: 'allow' });
        const r = await done;
        assert.equal(r.status, 200);
        assert.equal(sha(r.body), sha(body), `${n} bytes arrive exactly`);
        await waitFor(() => t.heldFiles().length === 0, 'held file gone after approve');
      }
    });
  });

  it('deny gives 403 with the reason', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const { done } = t.send('plain', Buffer.from('m=1'));
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'deny', reason: 'nope' });
      const r = await done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /denied: nope/);
      await waitFor(() => t.heldFiles().length === 0, 'held file gone after deny');
    });
  });

  it('a timeout gives 403 "hold timeout"', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'auto', hold: { timeoutMs: 400 } }, async (t) => {
      const t0 = Date.now();
      const r = await t.send('plain', Buffer.from('m=1')).done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /hold timeout/);
      assert.ok(Date.now() - t0 < 3000);
      await waitFor(() => t.heldFiles().length === 0, 'held file gone after timeout');
    });
  });
});

describe('the hold line', () => {
  it('the 18th held request of one agent gets 429', { timeout: 30000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const reqs = [];
      for (let i = 0; i < 18; i++) reqs.push(t.send('plain', Buffer.from(`m=${i}`)));
      // One is refused at once; 17 stay (1 parked + 16 waiting).
      const first = await Promise.race(reqs.map((r, i) => r.done.then((x) => ({ i, x }))));
      assert.equal(first.x.status, 429);
      assert.match(first.x.body.toString(), /hold queue full/);
      await waitFor(() => t.proxy.pending().length === 1, 'one parked');
      for (const r of reqs) r.req.destroy();
    });
  });
});

describe('audit', () => {
  it('gate.jsonl has the ask and its answer under one aid, and never the body', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const marker = `MARK-${crypto.randomBytes(8).toString('hex')}`;
      const { done } = t.send('plain', Buffer.from(`secret=${marker}`));
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'allow' });
      assert.equal((await done).status, 200);
      const lines = await waitFor(() => {
        const l = t.gateLines();
        return l.some((x) => x.phase === 'approval') ? l : null;
      }, 'the approval line');
      const ask = lines.find((l) => l.phase === 'gate' && l.rule === 'rwx.ask');
      assert.ok(ask, 'a gate line for the ask');
      assert.equal(ask.rwxLetter, 'x');
      const reply = lines.find((l) => l.phase === 'approval');
      assert.equal(reply.aid, ask.aid);
      assert.ok(lines.indexOf(reply) > lines.indexOf(ask));
      assert.ok(!readFileSync(t.paths.audit, 'utf8').includes(marker), 'no body bytes in gate.jsonl');
    });
  });
});

describe('a plain check object', () => {
  it('askHuman parks and asks through the same channel', { timeout: 20000 }, async () => {
    const gateFor = () => ({ check: async () => ({ outcome: 'askHuman', rule: 'test.rule' }) });
    await withProxy({ gateFor }, async (t) => {
      const { done } = t.send('plain', Buffer.from('m=PLAIN'));
      const [h] = await t.parked();
      assert.equal(h.rule, 'test.rule');
      assert.equal(t.askOf(h.id).rule, 'test.rule');
      t.answer(h.id, { decision: 'allow' });
      const r = await done;
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), 'm=PLAIN');
    });
  });

  it('a deny outcome gives 403 with its rule', { timeout: 20000 }, async () => {
    const gateFor = () => ({ check: async () => ({ outcome: 'deny', rule: 'test.nope', reason: 'because' }) });
    await withProxy({ gateFor }, async (t) => {
      const r = await t.send('plain', Buffer.from('m=1')).done;
      assert.equal(r.status, 403);
      assert.match(r.body.toString(), /test\.nope/);
      assert.match(r.body.toString(), /because/);
    });
  });
});

describe('close and removeAgent with requests inside a gate check', () => {
  it('close() returns with requests waiting in the line, which end 403 proxy closing', { timeout: 30000 }, async () => {
    await withProxy({ mode: 'auto' }, async (t) => {
      const first = t.send('plain', Buffer.from('m=0'));
      await t.parked();
      const waiting = [t.send('plain', Buffer.from('m=1')), t.send('plain', Buffer.from('m=2'))];
      await waitFor(() => t.heldFiles().length === 3, 'waiting bodies spooled');
      const t0 = Date.now();
      await Promise.race([t.proxy.close(), nap(8000).then(() => { throw new Error('close() wedged'); })]);
      assert.ok(Date.now() - t0 < 5000, `close took ${Date.now() - t0} ms`);
      for (const r of [first, ...waiting]) {
        const out = await Promise.race([r.done, nap(3000).then(() => ({ status: 'none' }))]);
        assert.equal(out.status, 403, 'each request got its 403 before the sockets went');
        assert.match(out.body.toString(), /proxy closing/);
      }
      assert.deepEqual(t.heldFiles(), []);
    });
  });

  it('close() returns while a gate check never answers', { timeout: 30000 }, async () => {
    const gateFor = () => ({ check: () => new Promise(() => {}) });
    await withProxy({ gateFor }, async (t) => {
      const r = t.send('plain', Buffer.from('m=1'));
      await nap(200);
      const t0 = Date.now();
      await Promise.race([t.proxy.close(), nap(8000).then(() => { throw new Error('close() wedged'); })]);
      assert.ok(Date.now() - t0 < 6000, `close took ${Date.now() - t0} ms`);
      await Promise.race([r.done.catch(() => {}), nap(3000)]);
    });
  });

  it('removeAgent ends a waiting ask as client gone and drops its body file', { timeout: 30000 }, async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-gate-ra-'));
    const paths = runtimePaths(rt);
    const events = [];
    const proxy = createProxy({ port: 0, logFile: paths.audit, runtime: rt, clientIdleMs: 5000,
      unsafeTestOnly: { allowLoopback: true },
      gateFor: (agent, { humanChannel }) => policyGate({ agent, mode: 'auto', auditPath: paths.audit, humanChannel }),
      hold: { timeoutMs: 15000, pollMs: 25, onEvent: (e) => events.push(e) } });
    try {
      await proxy.ready;
      const sockPath = proxy.addAgent('ga');
      const raw = [];
      for (const m of ['A1', 'B2']) {
        const s = net.connect(sockPath);
        raw.push(s);
        s.on('error', () => {});
        await new Promise((r) => s.once('connect', r));
        const hostp = `127.0.0.1:${up.port}`;
        s.write(`POST http://${hostp}/p HTTP/1.1\r\nHost: ${hostp}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nm=${m}`);
        await waitFor(() => events.length >= 1 || m === 'B2', 'first ask');
      }
      await waitFor(() => readdirSync(paths.heldDir).length === 2, 'both bodies spooled');
      const gone = raw.map((s) => new Promise((r) => s.once('close', r)));
      proxy.removeAgent('ga');
      assert.deepEqual(readdirSync(paths.heldDir), [], 'the waiting body file is gone when removeAgent returns');
      assert.equal(proxy.pending().length, 0);
      assert.deepEqual(events.filter((e) => e.type === 'decided').map((e) => e.reason), ['client gone']);
      await Promise.race([Promise.all(gone), nap(3000)]);
    } finally {
      await Promise.race([proxy.close(), nap(5000)]);
      rmSync(rt, { recursive: true, force: true });
    }
  });
});

describe('localLlm: the wall lets exactly the named host:port through', () => {
  const NEED = !bwrapUsable() ? 'needs bwrap'
    : (!hasBin('socat') || !hasBin('curl') ? 'needs socat and curl' : '');
  let llm, other, root, proj;
  before(async () => {
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer((req, res) => res.end('LLM-OK'));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    llm = await mk();
    other = await mk();
    root = mkdtempSync(join(tmpdir(), 'bb-llm-'));
    proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
  });
  after(async () => {
    await new Promise((r) => llm.close(r));
    await new Promise((r) => other.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  /** curl a loopback URL from INSIDE a real sandbox, no allowLoopback. */
  async function inside(allowLocal, port, rtName) {
    let out = '';
    const sink = { write: (c) => { out += c; return true; } };
    const res = await run({ proj, runtime: join(root, rtName), mode: 'trust', allowLocal,
      command: ['bash', '-c', `curl -s --max-time 10 http://127.0.0.1:${port}/`],
      stdout: sink, stderr: sink });
    return { out, res };
  }

  it('the listed host:port is reached from inside a sandbox', { skip: NEED || false, timeout: 40000 }, async () => {
    const { out, res } = await inside([`127.0.0.1:${llm.address().port}`], llm.address().port, 'rt-a');
    assert.equal(res.exit, 0, out);
    assert.match(out, /LLM-OK/);
  });

  it('another loopback port is still denied by the wall', { skip: NEED || false, timeout: 40000 }, async () => {
    const { out } = await inside([`127.0.0.1:${llm.address().port}`], other.address().port, 'rt-b');
    assert.match(out, /loopback upstream denied: 127\.0\.0\.1/);
    assert.ok(!out.includes('LLM-OK'));
  });

  it('with no allowLocal the same port is denied', { skip: NEED || false, timeout: 40000 }, async () => {
    const { out } = await inside([], llm.address().port, 'rt-c');
    assert.match(out, /loopback upstream denied/);
  });
});
