// poc/m5/lib.mjs: the rig. One fresh runtime, proxy, two local upstreams and one sandbox runner per check.
// Imports ./src (a scratch copy of the library with the M5 patch), never ../../src.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from './src/proxy.js';
import { launch } from './src/launcher.js';
import { gateFor } from './src/policy.js';
import { loadSecrets } from './swap.mjs';

for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[v];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');

/** Fake real values, held only in this process's env (fromEnv). Never printed in full, never written to a file. */
export function makeReals() {
  return { stripe: `sk_test_REAL_${hex(16)}`, github: `ghp_REAL_${hex(16)}` };
}

/** The needles to search for: each value as a fixed string and its base64 at the three alignments. */
export function needlesOf(values) {
  const out = [];
  for (const v of values) {
    out.push(v);
    for (const k of [0, 1, 2]) {
      const b = Buffer.from(' '.repeat(k) + v).toString('base64').replace(/=+$/, '');
      out.push(b.slice([0, 2, 3][k], b.length - 2));
    }
  }
  return out;
}

function upstream(host) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.end('upstream-ok'); });
  });
  return new Promise((resolve) => srv.listen(0, host, () => resolve({
    seen, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  })));
}

/**
 * @param {object} o
 * @param {object} [o.cfg] the `secrets` config; default two secrets, both bound to 127.0.0.1
 * @param {string} [o.mode]
 */
export async function makeRig({ mode = 'auto', cfg = null, envMore = {} } = {}) {
  const reals = makeReals();
  process.env.HOST_STRIPE_KEY = reals.stripe;     // different name than inside: a host var the user exported
  process.env.GITHUB_TOKEN = reals.github;        // same name inside and out (the --setenv placeholder shadows it)
  const secretsCfg = cfg ?? {
    STRIPE_API_KEY: { fromEnv: 'HOST_STRIPE_KEY', hosts: ['127.0.0.1'] },
    GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN', hosts: ['127.0.0.1'] },
  };
  const secrets = loadSecrets(secretsCfg);
  const runtime = fs.mkdtempSync('/tmp/bb5-');
  const projRoot = fs.mkdtempSync('/tmp/bb5-');
  const proj = path.join(projRoot, 'proj');
  fs.mkdirSync(proj);
  const audit = path.join(runtime, 'gate.jsonl');
  const bound = await upstream('127.0.0.1');
  const unbound = await upstream('127.0.0.2');
  // A TLS upstream on 127.0.0.1 (self-signed; the proxy trusts it through upstreamCa) for the https path.
  const kp = path.join(runtime, 'up-key.pem'); const cp = path.join(runtime, 'up-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', kp, '-out', cp,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const tlsSeen = [];
  const tlsSrv = https.createServer({ key: fs.readFileSync(kp), cert: fs.readFileSync(cp) }, (req, res) => {
    req.resume(); req.on('end', () => { tlsSeen.push({ method: req.method, url: req.url, headers: req.headers }); res.end('tls-upstream-ok'); });
  });
  await new Promise((r) => tlsSrv.listen(0, '127.0.0.1', r));
  const tls = { seen: tlsSeen, port: tlsSrv.address().port };
  const proxy = createProxy({
    runtime, logFile: audit, port: 0, secrets, upstreamCa: cp,
    unsafeTestOnly: { allowLoopback: true },
    gateFor: (name, { humanChannel, tools }) => gateFor({ agent: name, mode, auditPath: audit, humanChannel, tools }),
    hold: { timeoutMs: 20000, pollMs: 50 },
  });
  await proxy.ready;
  const sock = proxy.addAgent('a1');
  const placeholders = Object.fromEntries(secrets.map((s) => [s.name, s.placeholder]));
  /** Run a command in the sandbox; stdinText goes to its stdin (a pipe). */
  function sbx(command, { stdinText = null, timeoutMs = 60000, env = !process.env.POC_LEGACY_ENV } = {}) {
    const child = launch({ runtime, agent: 'a1', proj, command, socket: sock, caFile: proxy.caFile,
      env: env ? { set: { NODE_USE_ENV_PROXY: '1', ...envMore }, placeholders,
        clearenv: !process.env.POC_NO_CLEARENV, spawnClean: !process.env.POC_NO_SPAWNCLEAN } : null,
      stdin: stdinText === null ? 'ignore' : 'pipe' });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    if (stdinText !== null) child.stdin.end(stdinText);
    return new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.on('close', (code, signal) => { clearTimeout(t); resolve({ exit: code, signal, out, err }); });
    });
  }
  /** Every file under dir, as [path, text]. */
  const filesUnder = (d) => {
    const acc = [];
    const walk = (p) => {
      let st; try { st = fs.lstatSync(p); } catch { return; }
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
      else if (st.isFile()) { try { acc.push([p, fs.readFileSync(p, 'latin1')]); } catch {} }
    };
    walk(d);
    return acc;
  };
  const auditLines = () => fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let closed = null;
  /** Idempotent. Returns every file the runtime held at the end, as [path, text] (the audit is flushed by proxy.close). */
  function close() { return (closed ??= doClose()); }
  async function doClose() {
    await proxy.close().catch(() => {});
    await bound.close(); await unbound.close(); tlsSrv.closeAllConnections?.(); await new Promise((r) => tlsSrv.close(r));
    const final = filesUnder(runtime); // after close: audit flushed
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(projRoot, { recursive: true, force: true });
    return final;
  }
  return { reals, secrets, runtime, proj, audit, bound, unbound, tls, proxy, sbx, filesUnder, auditLines, close,
    needles: needlesOf(Object.values(reals)), placeholders };
}

/** The in-sandbox search: needles on stdin, one per line; prints "<hits> <files-searched>" per kind. */
export const SEARCH = String.raw`
mapfile -t N
n() { printf '%s\n' "\${N[@]}"; }
case "$1" in
  environ) h=$(grep -alF -f <(n) /proc/[0-9]*/environ 2>/dev/null | wc -l); f=$(ls /proc/[0-9]*/environ 2>/dev/null | wc -l);;
  cmdline) h=$(grep -alF -f <(n) /proc/[0-9]*/cmdline 2>/dev/null | wc -l); f=$(ls /proc/[0-9]*/cmdline 2>/dev/null | wc -l);;
  files) h=0; for d in /*; do case "$d" in /proc|/sys) continue;; esac; k=$(grep -rIlF -f <(n) "$d" 2>/dev/null | wc -l); h=$((h+k)); done; f=-;;
esac
echo "HITS=$h FILES=$f"
`.replace(/\\\$/g, '$');
