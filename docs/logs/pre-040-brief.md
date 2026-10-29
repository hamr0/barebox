# Brief: three fixes before 0.4.0 — runtime dir ownership, cert serials, client-gone on agent exit

Branch `fix/pre-040`, cut from `hardening` at 8ed6443. Every mechanism below was
checked in a real shell on 2026-10-29. Owner decisions are quoted; don't reopen them.

## F1 — a runtime dir you don't own is refused clearly (ledger: `"fs.chmodSync(dir, 0o700);"`)
**Now** (`src/runtime.js:100-103`): `ensurePrivateDir` does `mkdirSync(dir, {recursive, mode: 0o700})`
then `chmodSync(dir, 0o700)`. Verified:
- `claimRuntime('/tmp')` → `EPERM: operation not permitted, chmod '/tmp'` (same for `/var/tmp`);
  `/tmp` is uid 0, we are uid 1000. 0.3.0 did not throw here (it only `mkdirSync`'d).
- an existing dir we own at 0755 is silently tightened to 0700.

**Decided**: "a dir you own is tightened to 0700 and that is documented; a dir you do not
own (/tmp, root-owned, shared) is refused with an error naming the dir and its owner and
suggesting a subdir such as /tmp/sbx".

**Fix**: in `ensurePrivateDir`, after `mkdirSync`, `fs.statSync(dir)`; if its `uid` is not
`process.getuid()`, throw an `Error` whose message names the dir, its owner uid and ours,
and suggests `path.join(dir, 'sbx')` (e.g. `runtime dir /tmp is owned by uid 0, not you
(uid 1000): use a dir of your own, e.g. /tmp/sbx`). Then `chmodSync` as now. One check in
the one function; the callers (`claimRuntime`, proxy `socks/`, holds `asks/`/`answers/`)
inherit it. Update the function's doc comment and its `@fails`-style docs where they exist.
**Docs**: `barebox.context.md:137` (the 0700 sentence): add that an existing runtime dir you
own is tightened to 0700 and one you don't own is refused with that message. Check README
for any SBX_RUNTIME guidance that says otherwise.
**Tests** (`test/runtime.test.mjs`):
- `claimRuntime` on a dir owned by another uid throws a message matching
  `/owned by uid \d+, not you/` and containing a suggested subdir. Use `/tmp` only if it
  is not ours (skip-free: pick the first of `/`, `/tmp`, `/usr` whose uid differs from
  `process.getuid()`; if the suite runs as root, assert that with a clear `assert.fail`
  message rather than skipping — CI runs as a normal user).
- nothing is created or changed in that dir (its mode before = after).
- the existing "an existing runtime root is tightened to 0700" test stays green.
**Red**: run the new test against HEAD's `src/runtime.js` (temp copy outside the repo):
it must fail on the message (HEAD throws bare `EPERM`).

## F2 — cert serials don't share a file; at most 4 mints at once (ledger: `"creds = await certFor(certDir, host);"`)
**Now** (`src/certs.js:102-103`): every mint runs `openssl x509 ... -CAcreateserial`, which
reads, increments and rewrites `<certsDir>/ca.srl`. Verified with the CA made first (as the
proxy does: `ready` awaits `ensureCA` at `src/proxy.js:536` before listening):
0 failures in 480 mints at 60 concurrent hosts, but 2 failures in ~1200 at 100–150
concurrent (`Unable to load number from .../ca.srl`) — real but rare. A 40-host stress
cannot reliably go red, so it is not the proof.

**Decided**: "random 128-bit serial per cert via openssl -set_serial (no shared ca.srl)
plus a cap of 4 concurrent mints".

**Fix**: replace `'-CAcreateserial'` with `'-set_serial', '0x' + randomBytes(16).toString('hex')`
(import `randomBytes` from `node:crypto`). Add a cap of 4 concurrent `mint()` calls inside
`certs.js` (a tiny private queue; no new export; the per-host `inflight` dedupe stays as is).
**Tests** (new file `test/certs.test.mjs`: no test file covers certs.js directly today —
only `e2e` and `proxy` import it; follow the other files' imports and `setup-env` usage):
- structural: in a fresh dir, `await ensureCA(dir)`, then mint 10 hosts concurrently →
  no `ca.srl` file exists in `dir`, and the 10 serials (`openssl x509 -noout -serial -in
  <host>.pem`) are pairwise distinct.
- cap: put a shim named `openssl` first on `PATH` (a bash script that appends
  `start <pid> <ns>` / `end <pid> <ns>` to a log, `exec`-free so it can log the end, around
  the real openssl found with `command -v openssl` before the shim is installed); mint 12
  hosts concurrently; from the log, the maximum number of overlapping openssl runs is ≤ 4.
  Restore `PATH` in `finally`.
**Red**: both tests against HEAD's `src/certs.js` in a temp copy (ca.srl exists; overlap > 4).
**Also**: after the fix, run the scratch stress (`ensureCA` then 150 concurrent `certFor`)
4 times: 0 failures. Report it as supporting evidence, not as the red.
**Not in scope**: concurrent `ensureCA` on a fresh dir also corrupts the CA (verified), but
it is unreachable: `certs.js` is not exported (package `exports` is `.` only), the cert dir
is per runtime, the runtime is locked, and the proxy awaits `ensureCA` before listening.
Mention it in the report only.

## F3 — an agent's exit ends its holds as client gone, deterministically (ledger: `"assert.equal(res.asks[0].reason, 'client gone');"`)
**Now**: `run()` awaits `proxy.close()` in its `finally` (`src/run.js:213`) as soon as the
child closes. `close()` settles every hold as `'proxy closing'` (`src/holds.js:615,620`).
`'client gone'` only comes from each agent socket's async `'close'` →
`holds.abandonSocket(sock)` (`src/proxy.js:465-468`, TLS at `:527-530`), and the agent's
connection dies via socat, killed with the sandbox's pid namespace — so the order is a race.
Proven: a 300 ms delay on that `abandonSocket` call fails `test/run.test.mjs:265` every time;
it failed naturally in 2 of ~8 full-suite runs. `removeAgent(name)` (`src/proxy.js:578`)
today only closes the agent's listener and unlinks its socket.

**Decided**: "removeAgent ends the agent's holds": `proxy.removeAgent(name)` also ends that
agent's open connections, and its held requests end deny/'client gone' synchronously;
`run()` calls `removeAgent(agent)` when the sandbox exits, before `close()`.

**Fix**:
- `removeAgent(name)`: after closing the listener, for every socket in `clients` whose
  `[AGENT]` is `name` (raw and TLS sockets both carry it): `holds?.abandonSocket(s)` then
  `s.destroy()`. Synchronous; no timers.
- `run()`: in the `finally`, before `await proxy.close()`, `if (sock) proxy.removeAgent(agent)`
  (read the code for the right variable; `sock` is set by `addAgent`). Errors still close.
- Update `removeAgent`'s doc comment, `types/proxy.d.ts` only if the generated types change
  (they are generated: run the project's type generation the way `npm run typecheck` / prepack
  expects, don't hand-edit), and `barebox.context.md` where the proxy handle is described
  (add one line: `removeAgent(name)` ends that agent's open connections; its held requests
  end as deny / client gone). Check `test/proxy.test.mjs:429` and `:1443` still mean what
  they meant.
**Tests**:
- `test/proxy.test.mjs`: with a parked hold for agent `a` and one for agent `b`,
  `removeAgent('a')` → `a`'s hold is denied with reason `'client gone'` before
  `removeAgent` returns (check `pending()` / the onDeny-equivalent the file already uses),
  `b`'s hold is still pending. Per-test timeout as the file does.
- `test/run.test.mjs:265` unchanged.
**Red**: (1) the new proxy test against HEAD's `src/proxy.js`; (2) in a temp copy, put the
300 ms delay on the `abandonSocket` call in the raw socket `'close'` handler: with HEAD's
`run.js`/`proxy.js` the run test fails (`'proxy closing'`); with the fix it passes 5/5.

## Required proofs (each with command and output)
- Each red above, in temp copies outside the repo (never mutate the repo tree).
- Per changed test file, 5 loops green.
- `npm test` 3x in a real shell: exit code, pass/fail/skip, `uptime` per run. 0 fail, 0 skip.
  A failure in a test you did not change → STOP, report name, file:line, output.
- `npm run typecheck`, `npm run check:primitives` exit 0 (if primitives change because a
  doc comment changed, regenerate the way the project does and say so).
- `npm run bench` PASS (proxy ≤ 80 MB, walls ≤ 10 MB) — F2 and F3 touch the proxy path.

## How Claude will verify
Reruns F1's red against HEAD, the F2 structural test against HEAD, and the F3 300 ms delay
run against the fix, in its own temp copies; reads the full diff.
