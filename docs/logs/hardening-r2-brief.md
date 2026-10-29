# Hardening round 2: one regression, two nits, two crash paths (2026-10-28)

**For:** the build agent. **Branch:** `hardening`, on top of your round-1 work (uncommitted;
leave it so). **Don't stage or commit**; the user commits.

**Why:** the orchestrator verified round 1 in a real shell. The suite ran 3× at 272/273: one
real regression from H3 (R1 below). Every H1–H4 mutation went red independently, plus three extra
(settle-no-release, close-no-expire, H2 call sites reverted to plain `mkdirSync`). Good work.

## Rules

Same nine rules as `docs/logs/hardening-brief.md` (read them there): red before green, a skip is
not a pass, mutations only in `/tmp/bb-hmut`, surgical, doc comments stay with their function,
no git writes, the brief wins, no processes left. Skip step 0 (your sandbox is unchanged).

**Order:** R1 → R4. R1 is a must. Stop only after a **finished** item.

---

## R1 (must): `hashFile` keeps the error's `code`

**Bug.** `hashFile` (`src/overlay.js:117`) wraps every error in `new Error('hash failed for …')`
with no `code`. The walker decides "unreadable entry, refuse loudly" with `isPermErr(e)`
(`src/overlay.js:184`), which reads `e.code`. So a mode-000 file in an upper no longer gets
`sbx: cannot read f in … run 'sbx rollback'`; the walk crashes with a raw stack instead.
Failing in a real shell, 3/3 runs: `test/overlay.test.mjs:470` "diff and commit refuse a mode-000
file loudly, naming it" (needs bwrap; it's on your rule-2 list, not your fault: the round-1 brief
asked for the wrapping).

**Fix.** Keep the message, and carry the original over: `new Error(msg, { cause: e })` plus
`code` copied from `e` when it has one. Both wrap sites (open and read). Nothing else changes;
`refuseUnreadable` already names the path itself.

**Test** (in `describe('hashFile (no sandbox needed)')`): a file chmod 000 → `hashFile` throws
with `code === 'EACCES'` and the message still names the path. If `process.getuid() === 0`
in your sandbox (root reads mode-000 files), say so and skip **only that assertion's setup**,
reporting it on the rule-2 list. Red today, green after.

**Mutation:** drop the `code` copy → your new test red.

## R2 (should): two dead writes in `src/holds.js`

Behaviour-neutral cleanups of round-1 code. No new test; proof is `test/holds.test.mjs`
23/23 plus `npm run typecheck`.

1. `close()` (`holds.js:589`) sets `w.handle.done = true` on the **public** handle. The state
   the timers and `cancel()` read lives in `handleState`. Set `handleState.get(w.handle).done`
   instead (guard the `get`).
2. `releaseSlot` (`holds.js:314`) writes `next.handle.state = 'holding'`: a second writer of
   `state`, with a value outside its declared type `'now'|'queued'|'full'`, and nothing reads it.
   Delete the line. `state` stays what `reserve` returned.

## R3 (should): `run()` closes the proxy when `addAgent` throws

**Bug.** `src/run.js:189` calls `proxy.addAgent(agent)` **before** the `try { … } finally {
await proxy.close(); }`. `addAgent` throws synchronously when `ensurePrivateDir` fails (e.g. the
socket folder is a plain file), and then the listening proxy keeps the process alive forever.
The same class as the 6.5 h orphan the existing test at `test/run.test.mjs:101` covers.

**Fix.** Move `const sock = proxy.addAgent(agent);` inside that `try` (declare `sock` so
`launch` still sees it). Nothing else.

**Test** (in the `describe` at `test/run.test.mjs:101`, same child-process shape as the existing
test): before `run()`, create the folder that `runtimePaths(rt).socket('a')` lives in **as a
plain file** (`writeFileSync(dirname(runtimePaths(rt).socket('a')), 'x')`). `run()` must
reject, and the child must **exit** within the parent timeout. No overlay needed. Your
sandbox probably can't run it (runtime lock); if not, put it on the rule-2 list with its error.

**Mutation:** move the line back out → the child hangs → the parent timeout makes it red
(orchestrator runs it if you can't).

## R4 (should): an unwritable audit log fails loudly, never as an uncaught crash

**Bug.** `src/proxy.js:148` `fs.createWriteStream(logFile, …)` has no `'error'` listener. If
`logFile` can't be opened (a directory, a missing parent, no permission), the stream emits
`'error'` asynchronously, and with no listener that's an uncaught exception: the whole host
process dies, and the claim and sockets are left behind.

**Fix.**
1. Open it synchronously first: `const logFd = fs.openSync(logFile, 'a', 0o600)`. On a
   throw: `releaseClaim()` and throw `createProxy: cannot open logFile <path>: <message>`, the
   same shape as the `upstreamCa` failure 10 lines below. Then
   `fs.createWriteStream(null, { fd: logFd })` (keep the existing `chmodSync` fix-up after it).
2. Add `logStream.on('error', …)`, which writes **one** line to stderr,
   `sbx: audit log <path> write failed: <message>`, the first time only (a flag), so a full disk
   can't crash the proxy or flood stderr.

**Tests** (`test/proxy.test.mjs`, near the `runtime is required` test at `:675`):
- (a) `logFile` is a directory → `createProxy` throws `/cannot open logFile/` synchronously, and
  a second `createProxy` on the same runtime then succeeds (the claim was released). Close it.
- (b) is the error listener: no test needed, but say where it is.

Your sandbox likely can't run (a) (runtime lock): rule-2 list.

**Mutation:** remove the `openSync` pre-check (back to the stream alone) → (a) red (async
crash, or no synchronous throw).

---

## Not yours

The H1 proxy wiring (`reserve` in `src/proxy.js`), its socket tests, and the stampede run. The
orchestrator does these afterwards.

## Done when (tick each with evidence)

- [ ] R1: red, green, mutation red. The root-or-not note.
- [ ] R2: holds 23/23, typecheck clean.
- [ ] R3: test written; red/green/mutation, or on the rule-2 list with its error.
- [ ] R4: open-first + error listener (file:line); test (a); mutation, or rule-2 list.
- [ ] `npm run typecheck` clean; `npm run check:primitives` current (regenerate `primitives.json`
      if `createProxy`'s `@fails` should now name the logFile throw, and say so).
- [ ] `npm test` totals, with every failing or skipped test listed with its error.
- [ ] `git status`: round-1 files, plus `src/run.js`, `test/run.test.mjs`, maybe
      `primitives.json`, and this brief. Nothing else.
- [ ] No processes left; `/tmp/bb-hmut` removed.

**Report format:** one section per item: what changed (file:line), red/green/mutation lines,
deviations. Then the rule-2 list. Then the Done-when checklist.
