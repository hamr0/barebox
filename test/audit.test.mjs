// M3 B2b: one audit file. Every line barebox writes is in bareguard's shape and
// goes through a bareguard Gate: the request's `check` and its `record` (the
// response status) share an aid; barebox's own facts are `annotate` lines.
// Real proxy, real sockets, async clients only (a sync child client would
// deadlock the in-process proxy). Every test has its own timeout.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Gate } from 'bareguard';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../src/proxy.js';
import { gateFor as policyGate } from '../src/policy.js';
import { runtimePaths } from '../src/runtime.js';
import { startHttp } from './fixtures/upstream.mjs';

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

let up;
before(async () => { up = await startHttp(); });
after(async () => { await up?.close(); });

/** The one helper that parses the audit file. */
const linesOf = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

/**
 * One proxy on its own runtime, torn down after `fn`. `mode` builds the real
 * policy gates unless `gateFor` is given; `gateFor: null` is forward-all.
 */
async function withProxy({ mode = 'auto', gateFor, hold = {}, unsafe = {} } = {}, fn) {
  const rt = mkdtempSync(join(tmpdir(), 'bb-audit-'));
  const paths = runtimePaths(rt);
  const proxy = createProxy({ port: 0, logFile: paths.audit, runtime: rt, clientIdleMs: 5000,
    unsafeTestOnly: { allowLoopback: true, ...unsafe },
    ...(gateFor === null ? {} : {
      gateFor: gateFor ?? ((agent, { humanChannel }) =>
        policyGate({ agent, mode, auditPath: paths.audit, humanChannel })) }),
    hold: { timeoutMs: 15000, pollMs: 25, ...hold } });
  const { port } = await proxy.ready;
  const t = {
    rt, proxy, port, paths,
    lines: () => linesOf(paths.audit),
    answer(id, obj) {
      mkdirSync(paths.answersDir, { recursive: true });
      const tmp = join(paths.answersDir, `.${id}.tmp`);
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, paths.answerFile(id));
    },
    parked: () => waitFor(() => (proxy.pending().length ? proxy.pending() : null), 'a hold to park'),
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
    /** A request with no Host: the proxy answers 400 `bad request target` and logs a deny. */
    badRequest() {
      return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        s.on('error', () => {});
        let got = '';
        s.on('data', (c) => { got += c; });
        s.on('close', () => resolve(got));
        s.write('GET /x HTTP/1.0\r\n\r\n');
      });
    },
  };
  try {
    return await fn(t);
  } finally {
    await Promise.race([proxy.close(), nap(5000)]);
    rmSync(rt, { recursive: true, force: true });
  }
}

describe('one audit file', () => {
  it('a GET, an approved POST and a 403 deny leave gate.jsonl and no audit.jsonl; check and record share an aid', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const g = await t.send('plain', undefined, { method: 'GET' }).done;
      assert.equal(g.status, 200);
      const { done } = t.send('plain', Buffer.from('m=ONE'));
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'allow' });
      assert.equal((await done).status, 200);
      // PURGE is no tool's method: denied in every mode.
      assert.equal((await t.send('plain', undefined, { method: 'PURGE' }).done).status, 403);

      assert.ok(t.paths.audit.endsWith('gate.jsonl'));
      assert.deepEqual(readdirSync(t.rt).filter((n) => /^(gate|audit)\.jsonl$/.test(n)), ['gate.jsonl']);
      assert.ok(!existsSync(join(t.rt, 'audit.jsonl')), 'no audit.jsonl');
      const rec = await waitFor(() => t.lines().find((l) => l.phase === 'record' && l.result?.status === 200
        && l.action?.method === 'GET'), 'the GET record line');
      const check = t.lines().find((l) => l.phase === 'gate' && l.action?.method === 'GET');
      assert.ok(check, 'the GET check line');
      assert.ok(rec.aid && rec.aid === check.aid, 'check and record share one aid');
      assert.equal(rec.result.status, 200);
    });
  });

  it('a hold joins: the ask id is in a hold and a decide annotate, both with meta.id', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send('plain', Buffer.from('m=JOIN'));
      const [h] = await t.parked();
      assert.equal(h.id, 'h1');
      t.answer(h.id, { decision: 'allow' });
      await done;
      const ann = (v) => t.lines().find((l) => l.phase === 'annotate' && l.verdict === v && l.meta?.id === 'h1');
      await waitFor(() => ann('hold') && ann('decide'), 'hold and decide annotate lines');
      assert.equal(ann('hold').meta.id, 'h1');
      assert.equal(ann('decide').meta.id, 'h1');
      assert.equal(ann('hold').surface, false);
    });
  });

  it('bounded meta: a hold with a 5 KB URL still writes meta.id and meta.agent, no _truncated', { timeout: 20000 }, async () => {
    await withProxy({}, async (t) => {
      const { done } = t.send(`plain?q=${'a'.repeat(5000)}`, Buffer.from('m=BIG'));
      const [h] = await t.parked();
      t.answer(h.id, { decision: 'deny' });
      await done;
      const hold = await waitFor(() => t.lines().find((l) => l.phase === 'annotate' && l.verdict === 'hold'), 'hold annotate');
      assert.equal(hold.meta.id, h.id);
      assert.equal(hold.meta.agent, 'tcp');
      assert.ok(!hold.meta._truncated, 'meta not replaced whole');
      assert.ok(hold.meta.url.length <= 400);
    });
  });

  it('drain: after 200 denied requests no gate holds a buffered annotation', { timeout: 30000 }, async () => {
    const seen = new Set();
    const origAnnotate = Gate.prototype.annotate;
    Gate.prototype.annotate = function annotate(...a) { seen.add(this); return origAnnotate.apply(this, a); };
    try {
      await withProxy({}, async (t) => {
        for (let i = 0; i < 200; i++) assert.match(await t.badRequest(), /^HTTP\/1\.1 400/);
        await waitFor(() => t.lines().filter((l) => l.phase === 'annotate' && l.verdict === 'deny').length >= 200,
          '200 deny annotate lines');
      });
      // Forward-all: every line goes through the sbx gate.
      await withProxy({ gateFor: null }, async (t) => {
        for (let i = 0; i < 20; i++) await t.badRequest();
        await waitFor(() => t.lines().filter((l) => l.verdict === 'deny').length >= 20, 'sbx deny lines');
      });
    } finally { Gate.prototype.annotate = origAnnotate; }
    assert.ok(seen.size >= 2, `the agent gate and an sbx gate wrote annotations (saw ${seen.size})`);
    for (const g of seen) assert.equal(g._annotations.length, 0, 'drained');
  });

  it('no gate is built from log: a deny for an agent without a built gate goes to the sbx gate', { timeout: 20000 }, async () => {
    let calls = 0;
    await withProxy({ gateFor: () => { calls++; return new Promise(() => {}); } }, async (t) => {
      assert.equal(calls, 1, 'the tcp agent gate is requested once, at start');
      assert.match(await t.badRequest(), /^HTTP\/1\.1 400/);
      const line = await waitFor(() => t.lines().find((l) => l.phase === 'annotate' && l.verdict === 'deny'), 'deny annotate');
      assert.equal(line.meta.agent, 'tcp');
      assert.equal(calls, 1, 'log did not call gateFor');
    });
  });

  it('forward-all (no gateFor): lines still land in gate.jsonl, through the sbx gate', { timeout: 20000 }, async () => {
    await withProxy({ gateFor: null }, async (t) => {
      assert.equal((await t.send('plain?m=FWDALL', undefined, { method: 'GET' }).done).status, 200);
      await t.badRequest();
      const resp = await waitFor(() => t.lines().find((l) => l.phase === 'annotate' && l.verdict === 'resp'), 'resp annotate');
      assert.equal(resp.meta.status, 200);
      assert.match(resp.meta.url, /m=FWDALL/);
      await waitFor(() => t.lines().find((l) => l.verdict === 'deny'), 'deny annotate');
      assert.ok(t.lines().every((l) => l.run_id && l.seq), 'bareguard-stamped lines');
    });
  });
});

describe('the body fact', () => {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const bodyOf = async (t, tag) => {
    const line = await waitFor(() => t.lines().find((l) => l.phase === 'annotate' && l.verdict === 'body'
      && t.lines().some((g) => g.phase === 'gate' && g.action?.rid === l.meta?.rid && g.action.url.includes(tag))),
      'a body annotate joined to the gate line');
    return { line, gate: t.lines().find((g) => g.phase === 'gate' && g.action?.rid === line.meta.rid) };
  };
  for (const [name, size] of [['small', 100], ['streamed past 64 KB', 300000]]) {
    it(`a ${name} POST writes one body annotate: rid, bodyBytes, bodySha256`, { timeout: 30000 }, async () => {
      await withProxy({ mode: 'trust' }, async (t) => {
        const body = Buffer.alloc(size, 'abcdefghij');
        assert.equal((await t.send(`plain?m=BODY${size}`, body).done).status, 200);
        const { line, gate } = await bodyOf(t, `BODY${size}`);
        assert.equal(line.meta.rid, gate.action.rid);
        assert.equal(line.meta.bodyBytes, size);
        assert.equal(line.meta.bodySha256, sha(body));
        assert.equal(t.lines().filter((l) => l.verdict === 'body').length, 1);
        assert.ok(!('bodyPreview' in line.meta));
        assert.ok(!readFileSync(t.paths.audit, 'utf8').includes('abcdefghij'), 'no body text');
      });
    });
  }

  it('a GET writes no body line', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      await t.send('plain?m=NOBODY', undefined, { method: 'GET' }).done;
      await waitFor(() => t.lines().some((l) => l.phase === 'record'), 'the record line');
      assert.ok(!t.lines().some((l) => l.verdict === 'body'));
    });
  });
});

describe('close and the audit file', () => {
  it('close() waits for pending writes; a log after close is dropped without throwing', { timeout: 30000 }, async () => {
    // Part 1: a line logged just before close() is in the file once close() resolves.
    {
      const rt = mkdtempSync(join(tmpdir(), 'bb-audit-c-'));
      const file = runtimePaths(rt).audit;
      const p = createProxy({ port: 0, logFile: file, runtime: rt });
      // A slow disk: the write is still in flight when close() is called.
      const origAnnotate = Gate.prototype.annotate;
      Gate.prototype.annotate = async function annotate(...a) { await nap(400); return origAnnotate.apply(this, a); };
      try {
        const { port } = await p.ready;
        await new Promise((resolve) => {
          const s = net.connect(port, '127.0.0.1');
          s.on('error', () => {});
          s.resume();
          s.on('close', resolve);
          s.write('GET /x HTTP/1.0\r\n\r\n');
        });
        await p.close();
        assert.ok(linesOf(file).some((l) => l.phase === 'annotate' && l.verdict === 'deny'),
          'the deny is in the file when close() resolves');
      } finally { Gate.prototype.annotate = origAnnotate; rmSync(rt, { recursive: true, force: true }); }
    }
    // Part 2: a request still resolving its host when close() runs logs its deny after.
    {
      const rt = mkdtempSync(join(tmpdir(), 'bb-audit-d-'));
      const file = runtimePaths(rt).audit;
      let release;
      const gate = new Promise((r) => { release = r; });
      const p = createProxy({ port: 0, logFile: file, runtime: rt,
        unsafeTestOnly: { resolveUpstream: () => gate } });
      const errs = [];
      const orig = console.error;
      console.error = (...a) => { errs.push(a.join(' ')); };
      const crashes = [];
      const onCrash = (e) => crashes.push(e);
      process.on('uncaughtException', onCrash);
      process.on('unhandledRejection', onCrash);
      try {
        const { port } = await p.ready;
        const s = net.connect(port, '127.0.0.1');
        s.on('error', () => {});
        s.write('GET http://late.test/x HTTP/1.1\r\nHost: late.test\r\nConnection: close\r\n\r\n');
        await nap(200);
        await p.close();
        release(null); // unresolvable: the request now denies and logs, after close
        await nap(300);
        s.destroy();
        assert.ok(!linesOf(file).some((l) => /unresolvable/.test(l.where ?? '') || /unresolvable/.test(JSON.stringify(l.meta ?? ''))),
          'the late line was dropped');
        assert.deepEqual(errs, []);
        assert.deepEqual(crashes, []);
      } finally {
        console.error = orig;
        process.off('uncaughtException', onCrash);
        process.off('unhandledRejection', onCrash);
        rmSync(rt, { recursive: true, force: true });
      }
    }
  });

  it('a logFile that is a directory still throws from createProxy and releases the claim', { timeout: 20000 }, async () => {
    const rt = mkdtempSync(join(tmpdir(), 'bb-audit-b-'));
    try {
      const dirLog = join(rt, 'logdir');
      mkdirSync(dirLog, { recursive: true });
      assert.throws(() => createProxy({ port: 0, logFile: dirLog, runtime: rt }), /cannot open logFile/);
      const p2 = createProxy({ port: 0, logFile: runtimePaths(rt).audit, runtime: rt });
      try { await p2.ready; } finally { await p2.close(); }
    } finally { rmSync(rt, { recursive: true, force: true }); }
  });
});

describe('no secrets in the audit file', () => {
  it('an Authorization header value is in no line', { timeout: 20000 }, async () => {
    await withProxy({ mode: 'trust' }, async (t) => {
      const headers = { authorization: 'Bearer test-secret-xyz', cookie: 'sid=test-secret-xyz' };
      assert.equal((await t.send('plain?m=AUTHZ', undefined, { method: 'GET', headers }).done).status, 200);
      assert.equal((await t.send('plain?m=AUTHZ2', Buffer.from('m=1'), { headers }).done).status, 200);
      await waitFor(() => t.lines().filter((l) => l.phase === 'record').length >= 2, 'both record lines');
      const text = readFileSync(t.paths.audit, 'utf8');
      assert.ok(text.includes('m=AUTHZ'), 'the requests are in the file');
      assert.ok(!text.includes('test-secret-xyz'), 'no header value on disk');
    });
  });
});
