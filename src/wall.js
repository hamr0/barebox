// wall.js — the upstream wall: the one place that decides where the proxy
// may dial.
//
// Default-deny for loopback, link-local (incl. cloud metadata 169.254/16),
// the host's own addresses, and private LAN ranges (RFC 1918, CGNAT
// 100.64/10, IPv6 ULA fc00::/7). The check runs AFTER DNS resolution, so a
// hostname that resolves to 127.0.0.1 is denied exactly like the literal.
// Unresolvable names are denied too (fail closed, never 502-then-dial).
// Only the TEST-ONLY `unsafeTestOnly.allowLoopback` (loopback + unspecified)
// lets a denied destination through; only tests pass it. There is no
// allowPrivate flag and no per-host escape hatch: the wall is default-deny.
import net from 'node:net';
import os from 'node:os';
import { lookup as dnsLookup } from 'node:dns/promises';

/** Strip brackets/scope, lowercase: one spelling per address. */
function normIp(ip) {
  let s = String(ip || '').toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  return s;
}

/** Embedded IPv4 in `::ffff:1.2.3.4`, or null. */
function mappedV4(ip) {
  const m = ip.match(/^(?:.*:)?(\d+\.\d+\.\d+\.\d+)$/);
  return m && net.isIP(m[1]) === 4 ? m[1] : null;
}

function v4Parts(ip) {
  return ip.split('.').map((p) => parseInt(p, 10));
}

/** This machine's own interface addresses, one spelling (see `normIp`). */
function localIps() {
  const out = new Set();
  let ifs = {};
  // networkInterfaces() can throw where interfaces are hidden (a sandbox is
  // exactly where the wall matters most): lose host-local, keep the rest.
  try {
    ifs = os.networkInterfaces();
  } catch {
    return out;
  }
  for (const addrs of Object.values(ifs)) {
    for (const a of addrs ?? []) {
      if (a && a.address) out.add(normIp(a.address));
    }
  }
  return out;
}

/**
 * Why `ip` (already resolved) is denied, or null when it may go through.
 *
 * @param {string} rawIp resolved destination IP
 * @param {boolean} allowLoopback test-only opt-in for loopback + unspecified
 * @returns {string|null} `loopback` / `unspecified` / `link-local` / `host-local` / `private`, or null
 */
export function denyReasonForIp(rawIp, allowLoopback) {
  const ip = normIp(rawIp);
  const v4 = mappedV4(ip) ?? (net.isIP(ip) === 4 ? ip : null);
  if (v4) {
    const [a, b] = v4Parts(v4);
    if (a === 127) return allowLoopback ? null : 'loopback';
    if (a === 0) return allowLoopback ? null : 'unspecified';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    if (localIps().has(v4)) return 'host-local';
    return null;
  }
  if (net.isIP(ip) === 6) {
    if (ip === '::1') return allowLoopback ? null : 'loopback';
    if (ip === '::') return allowLoopback ? null : 'unspecified';
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if (first >= 0xfe80 && first <= 0xfebf) return 'link-local';
    if (first >= 0xfc00 && first <= 0xfdff) return 'private';
    if (localIps().has(ip)) return 'host-local';
    return null;
  }
  return null;
}

/**
 * Resolve `host` to every IP for the wall. Literals need no DNS.
 * Fail closed: anything that does not resolve is denied, never dialed.
 *
 * @param {string} host CONNECT/request hostname
 * @param {(host: string) => Promise<string[] | string | null>} [stub] test-only DNS stub
 * @returns {Promise<string[] | null>} all resolved IPs, or null when unresolvable
 */
async function resolveAllUpstream(host, stub) {
  if (net.isIP(host)) return [host];
  try {
    if (typeof stub === 'function') {
      const r = await stub(host);
      if (!r) return null;
      if (Array.isArray(r)) return r.length ? [...r] : null;
      if (typeof r === 'string') return [r];
      return null;
    }
    const all = await dnsLookup(host, { all: true });
    if (!all || !all.length) return null;
    return all.map((a) => a.address);
  } catch {
    return null;
  }
}

/**
 * Order resolved addresses with IPv4 and IPv6 interleaved, keeping DNS order within each family.
 *
 * @param {string[]} ips resolved addresses, already checked against the wall
 * @returns {string[]} dial order, starting with the family DNS listed first
 */
function interleaveIps(ips) {
  const v4 = ips.filter((ip) => net.isIP(ip) !== 6);
  const v6 = ips.filter((ip) => net.isIP(ip) === 6);
  const [first, second] = net.isIP(ips[0]) === 6 ? [v6, v4] : [v4, v6];
  const out = [];
  while (first.length || second.length) {
    if (first.length) out.push(/** @type {string} */ (first.shift()));
    if (second.length) out.push(/** @type {string} */ (second.shift()));
  }
  return out;
}

/**
 * The wall: resolve every answer, then default-deny loopback/link-local/
 * host-local/private unless the test-only opt-ins allow it. Denies when ANY
 * answer is walled, denies unresolvable names, and pins every checked IP so
 * the dial below tries them in order without resolving a second time (no
 * rebinding, with fallback when the first address refuses).
 *
 * @param {string} host CONNECT/request hostname
 * @param {{ allowLoopback: boolean, resolveUpstream?: (host: string) => Promise<string[] | string | null> }} gate
 * @returns {Promise<{ ok: true, ips: string[] } | { ok: false, ip: string, reason: string }>}
 */
export async function checkUpstream(host, gate) {
  const ips = await resolveAllUpstream(host, gate.resolveUpstream);
  if (!ips || !ips.length) {
    return { ok: false, ip: host, reason: `unresolvable upstream denied: ${host}` };
  }
  for (const ip of ips) {
    const kind = denyReasonForIp(ip, gate.allowLoopback);
    if (kind) {
      const where = ip === host ? host : `${host} (${ip})`;
      return { ok: false, ip, reason: `${kind} upstream denied: ${where}` };
    }
  }
  return { ok: true, ips: interleaveIps(ips) };
}
