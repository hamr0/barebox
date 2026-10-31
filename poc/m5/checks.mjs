// poc/m5/checks.mjs: checks A..G of docs/logs/m5-poc-brief.md.
//   node checks.mjs [--only=A,B] [--mutB] [--leakC]
// --mutB / --leakC are harness-side injections for the two mutations that need no code change.
// Prints one `CHECK x PASS|FAIL <evidence>` line per check; exits 1 when any FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRig, SEARCH, sleep } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const mutB = argv.includes('--mutB');
const leakC = argv.includes('--leakC');
const results = [];
const hits = (out) => Number(/HITS=(\d+)/.exec(out)?.[1] ?? NaN);
const nfiles = (out) => /FILES=(\S+)/.exec(out)?.[1];

async function run(id, fn) {
  if (only.length && !only.includes(id)) return;
  const rig = await makeRig();
  let ok = false; let detail = '';
  try { ({ ok, detail } = await fn(rig)); } catch (e) { detail = `THREW ${e.stack}`; } finally { await rig.close(); }
  results.push(ok);
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
}
const stdinOf = (rig) => rig.needles.join('\n') + '\n';
const bash = (script, ...args) => ['/usr/bin/bash', '-c', script, 'x', ...args];
const hasReal = (rig, v) => JSON.stringify(v).includes(rig.reals.stripe) || JSON.stringify(v).includes(rig.reals.github);

// A. environment of every process inside
await run('A', async (rig) => {
  const r0 = await rig.sbx(bash('echo "$STRIPE_API_KEY|$GITHUB_TOKEN|${HOST_STRIPE_KEY-unset}"'));
  const [s, g, h] = r0.out.trim().split('|');
  const phOk = /^sbx-ph-[0-9a-f]{16}$/.test(s) && /^sbx-ph-[0-9a-f]{16}$/.test(g) && s !== g;
  const r = await rig.sbx(bash(SEARCH, 'environ'), { stdinText: stdinOf(rig) });
  return { ok: r.exit === 0 && hits(r.out) === 0 && phOk && h === 'unset',
    detail: `exit=${r.exit} real+b64 hits in /proc/*/environ=${hits(r.out)} of ${nfiles(r.out)} files; placeholders present+distinct=${phOk}; HOST_STRIPE_KEY inside=${h}` };
});

// B. command lines inside (mutation: --mutB passes the real value as an argument)
await run('B', async (rig) => {
  const r = await rig.sbx(bash(SEARCH, 'cmdline', ...(mutB ? [rig.reals.stripe] : [])), { stdinText: stdinOf(rig) });
  return { ok: r.exit === 0 && hits(r.out) === 0, detail: `exit=${r.exit} hits in /proc/*/cmdline=${hits(r.out)} of ${nfiles(r.out)} files${mutB ? ' [real passed as argument]' : ''}` };
});

// C. files inside (mutation: --leakC writes the real value to a file under $HOME on the host)
await run('C', async (rig) => {
  const leak = path.join(here, '.leak-C.txt');
  try {
    if (leakC) fs.writeFileSync(leak, `${rig.reals.stripe}\n`);
    const t0 = Date.now();
    const r = await rig.sbx(bash(SEARCH, 'files'), { stdinText: stdinOf(rig), timeoutMs: 600000 });
    return { ok: r.exit === 0 && hits(r.out) === 0, detail: `exit=${r.exit} files containing real or base64 (grep -rIlF over every top-level dir but /proc /sys)=${hits(r.out)} in ${((Date.now() - t0) / 1000).toFixed(0)}s${leakC ? ' [real written under $HOME]' : ''}` };
  } finally { fs.rmSync(leak, { force: true }); }
});

const curlBearer = (host, port, p) =>
  bash(`/usr/bin/curl -sS -m 20 -w ' status=%{http_code}' -H "Authorization: Bearer $STRIPE_API_KEY" http://${host}:${port}${p}`);

// D. allowed request, bound host
await run('D', async (rig) => {
  const r = await rig.sbx(curlBearer('127.0.0.1', rig.bound.port, '/d'));
  const got = rig.bound.seen.find((q) => q.url === '/d')?.headers.authorization;
  const real = got === `Bearer ${rig.reals.stripe}`;
  const ph = got === `Bearer ${rig.placeholders.STRIPE_API_KEY}`;
  return { ok: r.exit === 0 && /status=200/.test(r.out) && real,
    detail: `exit=${r.exit} out=${JSON.stringify(r.out)} upstream authorization is: ${real ? 'Bearer <REAL value>' : ph ? 'Bearer <the PLACEHOLDER>' : JSON.stringify(got)}` };
});

// E. unbound host
await run('E', async (rig) => {
  const r = await rig.sbx(curlBearer('127.0.0.2', rig.unbound.port, '/e'));
  const n = rig.unbound.seen.length;
  const sawReal = hasReal(rig, rig.unbound.seen);
  const fin = await rig.close();
  const audit = fin.find(([p]) => p.endsWith('gate.jsonl'))[1].split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sec = audit.filter((l) => l.verdict === 'secret' || l.meta?.verdict === 'secret');
  return { ok: /denied: secret\.host/.test(r.out) && /status=403/.test(r.out) && n === 0 && !sawReal && sec.length >= 1,
    detail: `out=${JSON.stringify(r.out)} upstream requests=${n} upstream saw real=${sawReal}; audit secret lines=${sec.length} ${JSON.stringify(sec.map((l) => l.meta ?? l))}` };
});

// F. denied request: unlisted method (denied in every mode) and an ask answered "deny"; also the approve control
await run('F', async (rig) => {
  // (a) OPTIONS is not a listed tool: denied rwx.unlisted without asking
  const a = await rig.sbx(bash(`/usr/bin/curl -sS -m 20 -X OPTIONS -w ' status=%{http_code}' -H "Authorization: Bearer $STRIPE_API_KEY" http://127.0.0.1:${rig.bound.port}/f-denied`));
  // (b) POST in auto mode asks; answer deny through the file channel
  const asks = [];
  const ans = (async () => {
    const dir = rig.proxy ? path.join(rig.runtime, 'asks') : null;
    for (let i = 0; i < 400; i++) {
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        asks.push(txt);
        fs.writeFileSync(path.join(rig.runtime, 'answers', f), JSON.stringify({ decision: 'deny', reason: 'poc-deny' }));
        return;
      }
      await sleep(50);
    }
  })();
  const b = await rig.sbx(bash(`/usr/bin/curl -sS -m 30 -X POST -d hello -w ' status=%{http_code}' -H "Authorization: Bearer $STRIPE_API_KEY" http://127.0.0.1:${rig.bound.port}/f-asked`));
  await ans;
  const fin = await rig.close();
  const upstreamSaw = rig.bound.seen.length;
  const audit = fin.find(([p]) => p.endsWith('gate.jsonl'))[1].split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const swappedLines = audit.filter((l) => JSON.stringify(l).includes('"verdict":"secret"') && JSON.stringify(l).includes('"swapped":true'));
  // the real value (or base64) in any file the runtime held, and in the ask text
  const nd = rig.needles;
  const inRuntime = fin.filter(([, t]) => nd.some((n) => t.includes(n))).map(([p]) => path.basename(p));
  const inAsk = asks.filter((t) => nd.some((n) => t.includes(n))).length;
  return { ok: /status=403/.test(a.out) && /status=403/.test(b.out) && asks.length === 1 && upstreamSaw === 0
      && inRuntime.length === 0 && inAsk === 0 && swappedLines.length === 0,
    detail: `(a) unlisted-method out=${JSON.stringify(a.out)}; (b) asked+denied out=${JSON.stringify(b.out)} ask-files-seen=${asks.length}; upstream requests=${upstreamSaw}; runtime files holding real/b64=${JSON.stringify(inRuntime)}; ask files holding real=${inAsk}; audit "swapped":true lines for these denied requests=${swappedLines.length}` };
});

// G. real tools: curl -H, node fetch, and the tools that move or encode the header
await run('G', async (rig) => {
  const P = rig.bound.port; const T = rig.tls.port;
  const tools = {
    'curl -H Authorization': `curl -sS -m 20 -o /dev/null -H "Authorization: Bearer $STRIPE_API_KEY" http://127.0.0.1:${P}/g1`,
    'node fetch (Authorization)': `/usr/bin/node -e 'fetch("http://127.0.0.1:${P}/g2",{headers:{Authorization:"Bearer "+process.env.STRIPE_API_KEY}}).then(r=>r.text()).then(t=>console.log("node-body:"+t),e=>{console.error(String(e.cause||e));process.exit(1)})'`,
    'curl -H x-api-key': `curl -sS -m 20 -o /dev/null -H "x-api-key: $STRIPE_API_KEY" http://127.0.0.1:${P}/g3`,
    'curl -u KEY: (Basic)': `curl -sS -m 20 -o /dev/null -u "$STRIPE_API_KEY:" http://127.0.0.1:${P}/g4`,
    'wget --header': `wget -q -O /dev/null --header="Authorization: Bearer $STRIPE_API_KEY" http://127.0.0.1:${P}/g5`,
    'python urllib': `python3 -c 'import os,urllib.request as u;r=u.Request("http://127.0.0.1:${P}/g6",headers={"Authorization":"Bearer "+os.environ["STRIPE_API_KEY"]});print(u.urlopen(r).status)'`,
    'curl --oauth2-bearer': `curl -sS -m 20 -o /dev/null --oauth2-bearer "$STRIPE_API_KEY" http://127.0.0.1:${P}/g7`,
    'curl https -H Authorization': `curl -sS -m 20 -o /dev/null -H "Authorization: Bearer $STRIPE_API_KEY" https://127.0.0.1:${T}/g8`,
    'node fetch https (Authorization)': `/usr/bin/node -e 'fetch("https://127.0.0.1:${T}/g9",{headers:{Authorization:"Bearer "+process.env.STRIPE_API_KEY}}).then(r=>r.text()).then(t=>console.log("node-body:"+t),e=>{console.error(String(e.cause||e));process.exit(1)})'`,
    'curl -H github token': `curl -sS -m 20 -o /dev/null -H "Authorization: token $GITHUB_TOKEN" http://127.0.0.1:${P}/g10`,
  };
  const lines = []; const okOf = {};
  let i = 0;
  for (const [name, cmd] of Object.entries(tools)) {
    i++;
    const r = await rig.sbx(bash(cmd));
    const q = [...rig.bound.seen, ...rig.tls.seen].find((x) => x.url === `/g${i}`);
    const hdrs = q ? JSON.stringify(Object.fromEntries(Object.entries(q.headers).filter(([k]) => ['authorization', 'x-api-key'].includes(k)))) : 'NO REQUEST';
    const realStripe = q && JSON.stringify(q.headers).includes(rig.reals.stripe);
    const realGh = q && JSON.stringify(q.headers).includes(rig.reals.github);
    const b64 = q && (() => { const a = (q.headers.authorization ?? '').replace(/^Basic /i, ''); try { return Buffer.from(a, 'base64').toString().includes(rig.reals.stripe); } catch { return false; } })();
    const sawPh = q && Object.values(q.headers).some((v) => String(v).includes('sbx-ph-'));
    okOf[name] = !!(realStripe || realGh || b64);
    lines.push(`  ${name}: exit=${r.exit} real-at-upstream=${okOf[name]}${b64 ? '(inside base64)' : ''} placeholder-at-upstream=${!!sawPh} ${hdrs.replace(rig.reals.stripe, '<REAL>').replace(rig.reals.github, '<REALGH>')}${r.exit ? ' stderr=' + r.err.slice(0, 100) : ''}`);
  }
  console.log(lines.join('\n'));
  return { ok: okOf['curl -H Authorization'] && okOf['node fetch https (Authorization)'],
    detail: `required: curl -H=${okOf['curl -H Authorization']} node-fetch=${okOf['node fetch https (Authorization)']}; extras above` };
});

process.exit(results.every(Boolean) && results.length ? 0 : 1);
