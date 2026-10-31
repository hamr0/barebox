// poc/m5/swap.mjs: the proxy-side swap. Pure: no I/O, no proxy state.
//
// swap(headers, host, secrets) -> { headers, found }
//   headers  node's IncomingMessage.headers shape (lowercase names; a value is a string or, for set-cookie, an array)
//   host     the request's hostname (no port)
//   secrets  [{ name, placeholder, value, hosts }]
//   headers  a NEW object; the input is never mutated
//   found    one entry per (secret, header) hit: { name, header, bound, swapped }
//            bound=false means the placeholder is headed for a host the secret is not bound to
//
// A value is searched as a substring (`Bearer <ph>`). A `Basic <base64>` value is also decoded and
// searched, since `curl -u KEY:` and most SDKs send the key base64-encoded (found in this POC).
const BASIC = /^(Basic\s+)([A-Za-z0-9+/=_-]+)$/i;

/** @param {string} v @param {{placeholder: string, value: string}} s @param {boolean} doIt */
function inValue(v, s, doIt) {
  if (v.includes(s.placeholder)) return { hit: true, out: doIt ? v.split(s.placeholder).join(s.value) : v };
  const m = BASIC.exec(v);
  if (m) {
    const dec = Buffer.from(m[2], 'base64').toString('latin1');
    if (dec.includes(s.placeholder)) {
      const out = doIt ? m[1] + Buffer.from(dec.split(s.placeholder).join(s.value), 'latin1').toString('base64') : v;
      return { hit: true, out };
    }
  }
  return { hit: false, out: v };
}

export function swap(headers, host, secrets) {
  const out = {};
  const found = [];
  for (const [k, v] of Object.entries(headers)) {
    let cur = v;
    for (const s of secrets) {
      const bound = s.hosts.includes(host);
      const one = (str) => {
        const r = inValue(str, s, bound);
        if (r.hit) found.push({ name: s.name, header: k, bound, swapped: bound });
        return r.out;
      };
      cur = Array.isArray(cur) ? cur.map(one) : (typeof cur === 'string' ? one(cur) : cur);
    }
    out[k] = cur;
  }
  return { headers: out, found };
}

/** One random placeholder per secret; the real value from the host env (fromEnv) or inline. */
export function loadSecrets(config, env = process.env) {
  const crypto = globalThis.crypto;
  return Object.entries(config).map(([name, c]) => {
    const value = c.fromEnv !== undefined ? env[c.fromEnv] : c.value;
    if (typeof value !== 'string' || !value) throw new Error(`secret ${name}: no value (fromEnv ${c.fromEnv})`);
    if (!Array.isArray(c.hosts) || !c.hosts.length) throw new Error(`secret ${name}: hosts required`);
    const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
    return { name, value, hosts: c.hosts, placeholder: `sbx-ph-${hex}` };
  });
}
