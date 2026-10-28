# Kernel lock brief: the runtime claim is a lock the kernel holds (2026-10-28)

**Branch:** `m4-undo-layer` at `1c3c98e`; the tree is clean except this brief (uncommitted). Don't stage or commit.

**Source:** `/self-review` round 3 of the runtime claim (`17675e5..1c3c98e`).
- Its Fix now was caused by the previous fix. The user chose to step back and redesign (option B1), not patch.
- Three rounds of file-based claims each moved the same gap somewhere new. A file can't say that its holder died, so "judge dead, then act" is always two steps that two starters can both take. This design removes the judging.

**Rules:**
- A skipped test did not run. List every test your sandbox couldn't run; the orchestrator runs them in a real shell.
- No test-only code paths in `src/`. Reuse before you add.
- Every new test: apply the listed mutation, show it red, revert, show it green. Paste the `# pass` / `# fail` lines.
- Never `git checkout` / `git restore` `src/` or `test/`. Do mutations in a scratch copy of the repo.
- The brief wins. Any deviation is named in the report with its reason.
- Leave no node, bwrap or socat processes running.

---

## The design

The claim is an **abstract unix socket** bound by the proxy for as long as it lives (Linux, stdlib `node:net`). The kernel releases it when the process dies, SIGKILL included. Nothing is ever stale, so there's no takeover, no marker, no pid judging and nothing to delete by hand.

Facts measured by the orchestrator on Node v22.22.2 (scratch probes, not shipped):
- A second bind of the same name fails with EADDRINUSE; after a SIGKILL of the holder, the next bind succeeds at once.
- **The result is synchronous:** right after `server.listen(name)`, `server.listening` is `true` when the bind won and `false` when it lost. The `'error'` event fires later. So `createProxy` stays synchronous and still throws "in use" before it touches sockets, `asks/` or `answers/`. Test 3 pins this. A future Node that changes it must fail loudly.
- `server.unref()` lets the process exit while the lock is held.

## Item 1 (must): `claimRuntime` on a kernel lock

In `src/runtime.js`, `claimRuntime(runtime)` keeps its name, signature and return value (`release()`), so `src/proxy.js` doesn't change except for docs.
1. `fs.mkdirSync(runtime, { recursive: true })`, then `real = fs.realpathSync(runtime)` and `st = fs.statSync(real)`.
2. Lock name: `'\0barebox-' + sha256(`${real}\0${st.dev}\0${st.ino}`).hex.slice(0, 32)`. The real path means a symlinked path finds the same lock. Dev and inode make the name hard to guess and tie it to the dir itself, so a deleted-and-recreated dir gets a new lock.
3. `server = net.createServer((c) => c.destroy())`. The lock accepts no data; it destroys anything that connects. Attach `server.on('error', () => {})`, because the async EADDRINUSE must never become an uncaught crash. Then `server.listen(name)`.
4. `if (!server.listening)`: `server.close()`, then throw `inUseError(runtime, <pid from the owner file, or 'unknown'>)`.
5. Otherwise `server.unref()`. Write the owner file `{"pid": process.pid}` 0600 with a temp file plus `renameSync` (`wx`, unique temp name, unlink the temp in a `finally`). Now one writer exists, the lock holder, so no exclusivity is needed. The file exists only so the in-use message can name a pid.
6. `release()`: idempotent. Unlink the owner file only if it holds our pid, then `server.close()`.

**Delete** what no longer has a job: `takeOverStale`, `createOwner`, `isLive`, `readClaim` (unless the pid read reuses it), `readRaw`/`pidOf` (keep one small pid reader for the message), `procStart`, and the marker and `.tmp` logic. Grep every symbol repo-wide first; `procStart` must have no other caller. Drop `crypto` only if nothing else in the file uses it.

**JSDoc:**
- `claimRuntime`: state the lock, the sync result, and that death releases it.
- `src/proxy.js:122` `@fails`: replace "a dead owner's claim is taken over" with "the claim dies with its process; nothing is ever taken over".
- `CHANGELOG.md:17`: replace "a dead owner's runtime is taken over" with the same idea.

Grep `taken over|takeover|take over` in `src/`, `README.md`, `barebox.context.md`, `docs/product/`, `CHANGELOG.md`, and fix every claim-related hit.

## Tests

Replace the `claimRuntime: startup races` takeover tests (a–e and the two `takeOverStale` tests) in `test/runtime.test.mjs`. Keep the intent of the basic ones: first claim wins and a second names our pid; a new claim works after release; release is idempotent and never deletes another process's owner file. Riskiest first:

1. **Stampede of real processes.** 8 child processes claim one runtime at the same instant (busy-wait to a shared start time), 20 rounds. Exactly one winner per round. Every loser's error message matches `/in use by pid/` **exactly**, and any other message fails the test. Count other errors separately; never fold them into "refused". Winners hold about 300 ms, then release. **Mutation:** use a per-process lock name, e.g. append `process.pid` → red (8 winners).
2. **SIGKILL frees the runtime at once.** A child claims and signals ready, then the parent `kill -9`s it. The next `claimRuntime` in the parent succeeds with no manual step, and the owner file holds our pid. **Mutation:** make the claim also require that no owner file exists (`wx` on the owner) → red.
3. **The refusal is synchronous and leaves nothing behind.** In one process, claim A, then `assert.throws(() => claimRuntime(rt), /in use by pid <process.pid>/)`. Run this in a child process that must then exit by itself within 5 s after releasing A. That proves the refused server doesn't leak a handle. **Mutation:** drop the `server.close()` on the refused path → the child hangs → red by timeout. Assert the timeout outcome explicitly, not a bare non-zero exit.
4. **`unref`: a held lock never keeps a process alive.** A child claims, never releases, and must exit by itself within 5 s. **Mutation:** drop `server.unref()` → red.
5. **One lock per real dir.** Claim via the real path, then claim via a symlink to it → in use. **Mutation:** name from the raw path argument → red.
6. **A stale owner file is no obstacle.** Write `{"pid": <dead pid>}` (and separately garbage, and an empty file) to `owner`; `claimRuntime` succeeds and rewrites it. No mutation needed beyond item 1's.

`test/proxy.test.mjs` `one proxy owns a runtime (claim)` (around :991) stays as it is and must stay green: the second live proxy throws, the first hold stays answerable and its ask file survives; close releases; a rejected `ready` releases. Update only the messages, if they change.

## Item 2: ledger

Every ledger item for the old takeover becomes moot once its anchor is deleted: the three-starter race, the vanished marker, the dead marker, the dead-pid message, the temp-write duplicate. Don't edit the ledger; `/refactor` revalidation drops them.

## Done when

- `node --test --import ./test/setup-env.mjs test/runtime.test.mjs test/proxy.test.mjs`: all pass, 0 skipped. Every mutation in 1–5 shown red, then green.
- `grep -n "takeOverStale\|takeover\|procStart\|createOwner" src/` → no hits.
- `npm run typecheck` and `npm run check:primitives` clean. Regenerate `primitives.json` if an export changed, and say so.
- `npm test` once, full suite, totals reported.
- Report: diff stat, the new `claimRuntime`, each mutation's red and green lines, and every deviation.

**Orchestrator verification:** full suite 3× (0 fail, 0 skip); bench (proxy ≤ 80 MB); its own stampede counting exact messages; a real `sbx run` while another holds the same `SBX_RUNTIME` → refused at once; `kill -9` of a running `sbx run`, then a new one on the same runtime starts; then `/self-review`.
