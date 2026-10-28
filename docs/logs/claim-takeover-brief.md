# Claim takeover brief: the owner file is never absent (2026-10-28)

**Branch:** `m4-undo-layer` at `17675e5`; the tree is clean except this brief (uncommitted). Don't stage or commit.

**Source:** `/self-review` of `a6aa2d2..17675e5`, Fix now 1.
- The must-fix was **caused by the last fix** (17675e5's takeover). This is the redesign the loop guard calls for, not a third patch.
- If the next `/self-review` finds a new must-fix caused by this work, the orchestrator stops and steps back.

**Rules:**
- A skipped test did not run. List every test your sandbox couldn't run; the orchestrator runs them in a real shell.
- No test-only code paths in `src/`. Reuse before you add (`createOwner`, `readClaim`, `inUseError`, `procStart` exist).
- Every new test: apply the listed mutation, show it red, revert, show it green. Paste the `# pass` / `# fail` lines.
- Never `git checkout` / `git restore` `src/` or `test/`. Back up to a scratch dir before fault isolation.
- The brief wins. Any deviation is named in the report with its reason.
- Touch only `src/runtime.js` and `test/runtime.test.mjs` (plus the one-line nit in item 3).

---

## The bug (reproduced)

`takeOverStale` (`src/runtime.js:150-190`) renames `owner` away, then checks what it moved. If another starter (A) won the takeover first, B has just moved **A's live claim** away, so `owner` is absent until B links it back. A third starter C that arrives in that gap succeeds at `createOwner` (nothing to collide with). B's put-back then fails `EEXIST`, which is swallowed. A and C both run as live owners.

The root cause is the design: any step that removes `owner` while a live claim may be in it opens a gap. Re-ordering the steps doesn't remove it.

## Item 1 (must): takeover never removes `owner`

**Invariant:** after the first claim, `owner` only ever goes from one whole claim to another (atomic `rename` over it) or is unlinked by `release()` of its own live holder. A takeover never unlinks or renames `owner` away.

**Design:** one marker per stale claim decides who replaces it.
1. `claimRuntime`: `createOwner` as today. On `EEXIST`, read the **raw bytes** of `owner`. Parse them with the existing logic; a live holder → `inUseError` as today.
2. Stale (dead pid, wrong start, garbage, empty): `takeOverStale(runtime, judgedRaw, mine)`. `judgedRaw` is the exact string read. `id` = first 16 hex chars of sha256(judgedRaw).
3. Take the marker `owner.takeover-<id>` exclusively, reusing `createOwner(markerPath, mine)` (temp + `linkSync`, `EEXIST` if taken).
   - **`EEXIST`:** another starter is taking over the same stale claim. Read the marker's claim. If its holder is live → `inUseError(runtime, holder pid)`. If the holder is dead → throw a fail-closed error naming the marker path: "stale takeover marker <path> (pid N is gone): delete it to reuse this runtime". Don't try to remove or replace the marker. A holder can only die in the gap between two syscalls, and removing a marker would reopen this same race.
4. Holding the marker, re-read `owner` raw bytes:
   - **`=== judgedRaw`:** write `mine` to a temp file (`wx`, `0o600`, same naming as `createOwner`), then `renameSync(temp, owner)`. That's an atomic replace; `owner` is never absent.
   - **Absent** (`ENOENT`, the previous winner already released): `createOwner(owner, mine)`. `EEXIST` there → `inUseError` with the current pid.
   - **Anything else** (someone already replaced it) → `inUseError` with the current claim's pid (or `'unknown'`).
5. Always unlink our marker in a `finally`, and only the marker we created (we hold it). Unlink the temp in a `finally` if the rename didn't happen.

**Why it is safe (put a short version in the JSDoc):** the only writer that replaces content S is the unique holder of marker-S, and it replaces only after re-reading S. A live claim is never judged stale, so its content has no taker. `owner` is never absent during a takeover, so `createOwner` from a fresh starter always collides.

- Delete the rename-away, put-back and `.stale-*` code. Nothing else in `src/` reads the owner file (grep `runtimePaths(...).owner`, `claimRuntime`, `takeOverStale` to confirm).
- Keep `takeOverStale` exported for tests, with the new `judgedRaw` signature. Update its JSDoc and `claimRuntime`'s.

**Tests (`test/runtime.test.mjs`, `claimRuntime: startup races`).** Rewrite the two takeover tests for the new signature. Keep their intent: "refuses a fresh claim another starter just won and leaves it in place", "takes over the claim it judged, garbage and empty included". Then add:

a. **Third starter at every step (the riskiest case; write it first).** Setup: `owner` = A's live claim (`liveClaim()`, written directly). B judged a stale S, a dead pid like `2 ** 22 + 7`. Wrap `fs.renameSync`, `fs.linkSync`, `fs.unlinkSync` and `fs.writeFileSync` on the default `node:fs` export, which `runtime.js` uses. On the n-th call during B's `takeOverStale(rt, S_raw, B)`, run C = `claimRuntime(rt)` once. Repeat for n = 1..N (N = the number of calls B makes, measured in the test, at least 1). Each run: fresh runtime, wrappers restored in `finally`.
   - **Assert in every run:** C threw `in use`, B threw `in use`, and `owner` still holds A's claim byte for byte.
   - **Mutation:** check this test against the OLD code first. Take `src/runtime.js` from `17675e5` (`git show 17675e5:src/runtime.js` into a scratch copy of the repo) and adapt the call to the old `(runtime, judged, mine)` signature. It must go red: C claims while A holds. Paste that red output too.
b. **A stale claim is replaced, never removed.** Setup: `owner` = stale S. Wrap `fs.unlinkSync` and `fs.renameSync`; record any call whose source is `owner`. Run `claimRuntime`. Assert `owner` was never the source of an unlink or a rename-away, and it ends holding our claim. **Mutation:** replace the atomic replace with `unlinkSync(owner); createOwner(owner, mine)` → red.
c. **A dead marker fails closed.** Setup: `owner` = stale S, and marker `owner.takeover-<id(S)>` holds a dead-pid claim. `claimRuntime` throws naming the marker path, and both files are left untouched. **Mutation:** treat a dead marker holder as takeable (unlink it and retry) → red.
d. **Live marker → in use.** Same setup, with the marker holding `liveClaim()` → throws `in use by pid <process.pid>`. **Mutation:** skip the marker's liveness check, always fail closed → red, because of the message.
e. **No leftovers:** after a successful takeover, `readdirSync(rt)` is `['owner']` (no marker, no temp). **Mutation:** drop the marker unlink → red.

Existing tests stay green: second claim refused, release-after-claim, dead pid, reused pid, garbage, foreign claim never released, failed write leaves nothing.

## Item 2 (should): ledger nits

- `src/holds.js:218`: fix "on settle or abandon or abandon" (duplicated phrase in the `onEvent` JSDoc). No test.
- `src/launcher.js`: `kind` in `LOCKED_PATHS` is never read. Leave it; it goes to the user's ledger round.

## Done when

- `node --test --import ./test/setup-env.mjs test/runtime.test.mjs`: all pass, 0 skipped. Every mutation in a–e shown red, then green.
- `npm run typecheck` and `npm run check:primitives` are clean. If the `takeOverStale` signature reaches `primitives.json`, regenerate it and say so.
- `grep -n "stale-\|renameSync(owner" src/runtime.js` → no hits.
- `npm test` once if your sandbox allows it; the orchestrator runs it 3× in a real shell regardless.
- Report: the diff summary, each mutation's red and green lines, and every deviation.

**Orchestrator verification:** the full suite 3× (0 fail, 0 skip), typecheck and primitives; the old-code red for test a, re-run independently; the self-review's `/tmp/claude-1000/sr-q/race.mjs` adapted to the new signature, which must show C refused; then `/self-review` on the range.
