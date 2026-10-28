// wall.js — the upstream wall: the one place that decides where the proxy
// may dial.
//
// Default-deny for loopback, link-local (incl. cloud metadata 169.254/16),
// the host's own addresses, and private LAN ranges (RFC 1918, CGNAT
// 100.64/10, IPv6 ULA fc00::/7). An IPv4 embedded in IPv6 is checked too, in
// every spelling: mapped, compat, uncompressed, NAT64 (RFC 6052, RFC 8215)
// and 6to4 (RFC 3056). The check runs AFTER DNS resolution, so a
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

function v4Parts(ip) {
  return ip.split('.').map((p) => parseInt(p, 10));
}

/**
 * Parse IPv6 into its 8 groups, handling `::` anywhere and a trailing
 * dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
 *
 * @param {string} ip normalized IP spelling
 * @returns {number[]|null} 8 groups (0–0xffff), or null when not IPv6
 */
function v6Groups(ip) {
  if (net.isIP(ip) !== 6) return null;
  const dbl = ip.indexOf('::');
  if (dbl >= 0 && ip.indexOf('::', dbl + 2) >= 0) return null;
  const parts = (s) => s.split(':').filter((p) => p !== '');
  const head = dbl >= 0 ? parts(ip.slice(0, dbl)) : ip.split(':');
  const tail = dbl >= 0 ? parts(ip.slice(dbl + 2)) : [];
  const val = (s) => {
    if (s.includes('.')) {
      if (net.isIP(s) !== 4) return null;
      const p = s.split('.').map((x) => parseInt(x, 10));
      return [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    }
    if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
    return [parseInt(s, 16)];
  };
  /** @type {number[]} */
  const hGroups = [];
  /** @type {number[]} */
  const tGroups = [];
  for (const [list, out] of [[head, hGroups], [tail, tGroups]]) {
    for (const s of list) {
      const v = val(s);
      if (!v) return null;
      out.push(...v);
    }
  }
  if (dbl < 0) return hGroups.length === 8 ? hGroups : null;
  if (hGroups.length + tGroups.length > 8) return null;
  return [...hGroups, ...new Array(8 - hGroups.length - tGroups.length).fill(0), ...tGroups];
}

/** Dotted IPv4 from two groups. @param {number[]} g groups @param {number} i first group @returns {string} */
function v4Of(g, i) {
  return `${(g[i] >> 8) & 255}.${g[i] & 255}.${(g[i + 1] >> 8) & 255}.${g[i + 1] & 255}`;
}

/**
 * Why a dotted IPv4 is denied, or null when it may go through. The one IPv4
 * rule set: plain IPv4 and every embedded IPv4 use this function.
 *
 * @param {string} v4 dotted IPv4
 * @param {boolean} allowLoopback test-only opt-in for loopback + unspecified
 * @returns {string|null} `loopback` / `unspecified` / `link-local` / `host-local` / `private`, or null
 */
function v4Reason(v4, allowLoopback) {
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

/** This machine's own interface addresses: IPv6 keyed by parsed groups, IPv4 dotted (see `normIp`). */
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
      if (!a || !a.address) continue;
      const norm = normIp(a.address);
      const g = v6Groups(norm);
      out.add(g ? g.join(':') : norm);
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
  if (net.isIP(ip) === 4) return v4Reason(ip, allowLoopback);
  const g = v6Groups(ip);
  if (!g) return null;
  const zero = (a, b) => g.slice(a, b).every((x) => x === 0);
  if (zero(0, 8)) return allowLoopback ? null : 'unspecified';
  if (zero(0, 7) && g[7] === 1) return allowLoopback ? null : 'loopback';
  // IPv4-mapped ::ffff:0:0/96, then compat ::/96: the embedded IPv4 decides.
  if (zero(0, 5) && g[5] === 0xffff) return v4Reason(v4Of(g, 6), allowLoopback);
  if (zero(0, 6)) return v4Reason(v4Of(g, 6), allowLoopback);
  // NAT64 64:ff9b::/96: the embedded IPv4 decides. Local-use 64:ff9b:1::/48
  // is private outright: the IPv4 position depends on the prefix length,
  // which the wall can't know.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4Reason(v4Of(g, 6), allowLoopback);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private';
  // 6to4 2002::/16: the next 32 bits are the IPv4.
  if (g[0] === 0x2002) return v4Reason(v4Of(g, 1), allowLoopback);
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  if (localIps().has(g.join(':'))) return 'host-local';
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
