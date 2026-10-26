// M0 POC: sum RSS per sandbox process tree (bwrap roots) + proxy RSS. Node stdlib only.
// Usage: node measure.js <pidfile> <proxy-pid>
'use strict';
const fs = require('fs');
const [, , pidfile, proxyPid] = process.argv;
const kids = {};
for (const d of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(d)) continue;
  try {
    const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
    const m = stat.match(/^\d+ \(.*\) \S+ (\d+)/);
    if (m) (kids[m[1]] = kids[m[1]] || []).push(d);
  } catch { /* raced exit */ }
}
const rssKb = (pid) => {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
    return m ? +m[1] : 0;
  } catch { return 0; }
};
const comm = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?exited'; }
};
const tree = (root) => {
  const out = [];
  const stack = [String(root)];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    for (const k of kids[p] || []) stack.push(k);
  }
  return out;
};
const mb = (kb) => (kb / 1024).toFixed(1);
const roots = fs.readFileSync(pidfile, 'utf8').trim().split('\n').filter(Boolean);
let total = 0, totalNoSleep = 0, maxNoSleep = 0;
for (const r of roots) {
  const members = tree(r);
  let sum = 0, noSleep = 0;
  const parts = [];
  for (const p of members) {
    const kb = rssKb(p), c = comm(p);
    sum += kb;
    if (c !== 'sleep') noSleep += kb;
    parts.push(`${c}=${mb(kb)}MB`);
  }
  total += sum; totalNoSleep += noSleep;
  if (noSleep > maxNoSleep) maxNoSleep = noSleep;
  console.log(`sandbox root=${r} procs=${members.length} total=${mb(sum)}MB no-sleep=${mb(noSleep)}MB [${parts.join(' ')}]`);
}
console.log(`count=${roots.length} sum-total=${mb(total)}MB mean-total=${mb(total / roots.length)}MB`);
console.log(`sum-no-sleep=${mb(totalNoSleep)}MB mean-no-sleep=${mb(totalNoSleep / roots.length)}MB max-no-sleep=${mb(maxNoSleep)}MB`);
console.log(`proxy pid=${proxyPid} rss=${mb(rssKb(proxyPid))}MB`);
