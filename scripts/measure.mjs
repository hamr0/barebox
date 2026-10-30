// scripts/measure.mjs — the /proc measurement helpers shared by the benches
// (bench.mjs, bench-agents.mjs). An exact /proc walk of each bwrap PID tree
// (ppid map built from /proc/*/stat, VmRSS summed from /proc/*/status — the M0
// measure.cjs approach; never pgrep -f).
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function canUnix() {
  return new Promise((resolve) => {
    const p = path.join(os.tmpdir(), `bb-bench-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}

/** Poll `cond` until truthy; throw naming the condition on timeout. */
export async function waitFor(cond, what, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`bench: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function pidChildren() {
  /** @type {Record<string, string[]>} */
  const kids = {};
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const m = stat.match(/^\d+ \(.*\) \S+ (\d+)/);
      if (m) (kids[m[1]] = kids[m[1]] || []).push(d);
    } catch { /* raced exit */ }
  }
  return kids;
}

export function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
    return m ? +m[1] : 0;
  } catch { return 0; }
}

export function comm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?exited'; }
}

export const mb = (kb) => kb / 1024;

export function treeRss(rootPid, kids) {
  const members = [];
  const stack = [String(rootPid)];
  while (stack.length) {
    const p = /** @type {string} */ (stack.pop());
    members.push(p);
    for (const k of kids[p] || []) stack.push(k);
  }
  let total = 0;
  let noSleep = 0;
  const parts = [];
  for (const p of members) {
    const kb = rssKb(p);
    const c = comm(p);
    total += kb;
    if (c !== 'sleep') noSleep += kb;
    parts.push(`${c}=${mb(kb).toFixed(1)}MB`);
  }
  return { procs: members.length, totalMb: mb(total), noSleepMb: mb(noSleep), parts };
}

/**
 * Wait until every sandbox is at steady state: the payload (`sleep`) up and
 * the transient pre-exec `bash` gone in each bwrap tree (the launch flow's
 * door-probe loop proves the socat front door accepts before `exec "$@"`
 * replaces bash). Sampling earlier catches the short-lived bash and the
 * probe's forked socat child. Then one short bounded settle for the
 * probe-forked socat child to exit — the settle follows readiness, it is not
 * the readiness mechanism.
 *
 * @param {import('node:child_process').ChildProcess[]} children
 */
export async function waitSteady(children) {
  await waitFor(() => {
    const kids = pidChildren();
    return children.every((c) => {
      if (!c.pid) return false;
      const comms = new Set();
      const stack = [String(c.pid)];
      while (stack.length) {
        const p = /** @type {string} */ (stack.pop());
        comms.add(comm(p));
        for (const k of kids[p] || []) stack.push(k);
      }
      return comms.has('sleep') && !comms.has('bash');
    }) || false;
  }, `all ${children.length} sandboxes to reach steady state (payload up, transient bash gone)`, 30000);
  await new Promise((r) => setTimeout(r, 500));
}
