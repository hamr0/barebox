// certs.js — owns the CA and per-host certificates on disk.
//
// The proxy mints a certificate for every host the agent talks to, on first
// CONNECT. Nothing is pre-generated: a fresh runtime dir works on any host.
// Minting shells out to `openssl` (the PRD decision: no JS crypto for X.509).
import { execFile } from 'node:child_process';
import { mkdirSync, chmodSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Hostname/IP spelling both the mint cache and the proxy wall accept. Single definition (see proxy.js). */
export const HOST_RE = /^[A-Za-z0-9.-]+$/;

function sh(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// In-flight mints, so concurrent CONNECTs to a new host mint once.
const inflight = new Map();

/**
 * Create the CA in `dir` unless it already exists. Safe to call twice:
 * an existing `ca.pem` is reused, never regenerated.
 *
 * @param {string} dir directory that holds `ca.key` / `ca.pem`
 * @returns {Promise<{ keyPath: string, certPath: string }>} paths of the CA key and cert
 */
export async function ensureCA(dir) {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.pem');
  if (existsSync(certPath)) return { keyPath, certPath };
  await sh('openssl', ['genrsa', '-out', keyPath, '2048']);
  chmodSync(keyPath, 0o600);
  const ext = join(dir, 'ca.ext.tmp');
  writeFileSync(ext,
    'basicConstraints=critical,CA:true\n' +
    'keyUsage=critical,keyCertSign,cRLSign,digitalSignature\n' +
    'subjectKeyIdentifier=hash\n' +
    'authorityKeyIdentifier=keyid:always,issuer\n');
  try {
    await sh('openssl', ['req', '-new', '-key', keyPath, '-out', join(dir, 'ca.csr.tmp'),
      '-subj', '/CN=barebox-ca']);
    await sh('openssl', ['x509', '-req', '-in', join(dir, 'ca.csr.tmp'),
      '-signkey', keyPath, '-sha256', '-days', '825',
      '-out', certPath, '-extfile', ext]);
  } finally {
    rmSync(join(dir, 'ca.csr.tmp'), { force: true });
    rmSync(ext, { force: true });
  }
  return { keyPath, certPath };
}

/**
 * Return the key/cert for `host`, minting and caching on disk on first use.
 * Concurrent calls for the same host share one `openssl` run. Key files
 * are created with mode `0600`.
 *
 * @param {string} dir directory holding the CA (see {@link ensureCA})
 * @param {string} host hostname or IP from the CONNECT line
 * @returns {Promise<{ key: Buffer, cert: Buffer }>} PEM buffers for `tls.createSecureContext`
 */
export async function certFor(dir, host) {
  if (!HOST_RE.test(host || '')) throw new Error(`certFor: bad host ${JSON.stringify(host)}`);
  const { readFileSync } = await import('node:fs');
  const keyPath = join(dir, `${host}.key`);
  const certPath = join(dir, `${host}.pem`);
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }
  let p = inflight.get(host);
  if (!p) {
    p = mint(dir, host, keyPath, certPath).finally(() => { inflight.delete(host); });
    inflight.set(host, p);
  }
  return p;
}

async function mint(dir, host, keyPath, certPath) {
  const { readFileSync } = await import('node:fs');
  await ensureCA(dir);
  // A crashed mint must not leave half a pair behind that later reads as valid.
  rmSync(keyPath, { force: true });
  rmSync(certPath, { force: true });
  await sh('openssl', ['genrsa', '-out', keyPath, '2048']);
  chmodSync(keyPath, 0o600);
  const san = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  const ext = join(dir, `${host}.ext.tmp`);
  const csr = join(dir, `${host}.csr.tmp`);
  writeFileSync(ext,
    'basicConstraints=CA:false\n' +
    'keyUsage=digitalSignature,keyEncipherment\n' +
    'extendedKeyUsage=serverAuth\n' +
    `subjectAltName=${san}\n`);
  const { keyPath: caKey, certPath: caCert } = await ensureCA(dir);
  try {
    await sh('openssl', ['req', '-new', '-key', keyPath, '-out', csr, '-subj', `/CN=${host}`]);
    await sh('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey,
      '-CAcreateserial', '-days', '825', '-sha256', '-out', certPath, '-extfile', ext]);
  } finally {
    rmSync(csr, { force: true });
    rmSync(ext, { force: true });
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
