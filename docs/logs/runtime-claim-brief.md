# Runtime claim brief: one proxy owns a runtime, enforced (2026-10-27)

**Branch:** `m4-undo-layer` at the commit after `a6aa2d2` that adds this brief, with a clean tree. Don't stage or commit.

**Source:** `/self-review` round 2 of `44e7099..a6aa2d2`.
- Its Fix now item was **caused by the last fix**, so per the project rule this is a redesign, not a patch.
- This is the last allowed round. If round 3 finds a new must-fix caused by this work, the orchestrator stops and steps back.

**Rules (unchanged):**
- A skipped test did not run. List every test your sandbox couldn't run; the orchestrator runs them in a real shell.
- No test-only code paths in `src/`. Reuse before you add.
- Every new test: apply the listed mutation, show it red, revert, show it green. Paste the `# pass` / `# fail` lines.
- Never `git checkout` / `git restore` `src/` or `test/`. Back up to a scratch dir before fault isolation.
- The brief wins. Any deviation is named in the report with its reason.
- Leave no bwrap, socat or `node --test` processes running.

**Order:** item 1 (must), then item 2 (should).

---

## Why this is a redesign

- **The design:** the PRD says "one shared proxy, many thin sandboxes".
  - One proxy, which means one hold queue, owns a runtime folder.
  - Many agents join that one proxy through `addAgent`, and each sandbox is identified by its own socket.
  - The hold queue keeps its two answer channels (`onAsk` and the file checkpoint). This brief doesn't touch them.
- **The gap:** nothing enforces it.
  - Two `sbx run` with the same `SBX_RUNTIME` start two proxies on one folder.
  - `addAgent` (`src/proxy.js:659`) silently deletes the first one's socket and takes it over.
  - Since `a6aa2d2`, the second queue's clear at start (`src/holds.js:250-272`) also wipes the first queue's live `asks/` and `answers/`.
- **The reviewer's repro:**
  1. Two `sbx run --mode ask` in different projects, with the same `SBX_RUNTIME` and the default agent.
  2. Run A's POST is held as `h1`, then run B starts.
  3. `sbx pending` prints "nothing held", and `sbx approve h1` prints "unknown h1" (exit 1).
  4. A's hold can only time out.
- **The fix is to give the rule one enforcer**, in `src/runtime.js` (already the single writer of the runtime layout). The clear at start then becomes safe by construction: only a dead owner's leftovers can be there.

## 1. `claimRuntime`: one live proxy per runtime (must)

**Design (implement exactly this):**

1. **`src/runtime.js`** gets `claimRuntime(runtime)`, returning `release()`. The owner file is `<runtime>/owner`. Add it to `runtimePaths` as `owner`, so no other module names the path.
   - **Content:** `{"pid": <process.pid>, "start": <this process's start time>}`, written 0600.
   - **Start time:** field 22 (`starttime`) of `/proc/self/stat`, parsed after the last `)`. barebox is Linux-only (bwrap), so `/proc` is a given. Pid plus start time identifies a process even after its pid is reused.
   - **Claim:**
     1. `mkdirSync(runtime, { recursive: true })`, then `openSync(owner, 'wx')`, then write and close.
     2. On `EEXIST`, read the file:
        - If its pid is alive **and** that pid's current start time (from `/proc/<pid>/stat`) equals the recorded one, throw `runtime <path> is in use by pid <N> (one proxy per runtime: use another SBX_RUNTIME, or leave it unset for a fresh one)`.
        - This includes `pid === process.pid`, meaning a second proxy in the same process. One proxy per runtime holds in-process too.
     3. Otherwise the owner is stale (dead, reused pid, or unreadable/garbage file).
        - **Takeover:** `renameSync(owner, owner + '.stale-' + randomHex)`, delete the renamed file, then retry the `wx` open **once**.
        - If that retry hits `EEXIST`, another process won the takeover race: throw the same in-use error naming whatever pid is now in the file.
   - **`release()`:** delete `owner` only if it still holds our pid and start time. Never delete another process's claim. It's idempotent.
2. **`src/proxy.js` `createProxy`:**
   - Call `claimRuntime(runtime)` right after the `runtime is required` check, **before** `createHolds` (which clears `asks/` and `answers/`) and before any socket, log or cert work.
   - Release the claim:
     - in `close()`, last, after `holds.close()` and the servers close;
     - if `createProxy` throws after claiming (wrap the rest of setup so a throw releases, then rethrows);
     - if `ready` rejects (for example, a port already in use): release before the rejection reaches the caller.
3. **Don't claim anywhere else.**
   - `sbx pending` / `approve` / `deny` answer a live owner's queue; they never claim.
   - `run()` and `sbx run` get the claim through `createProxy`. A busy runtime surfaces as `run failed: runtime … is in use by pid N` on stderr with exit 1. Check that path; add no new CLI code unless it doesn't.
4. **Docs:**
   - `createProxy`'s JSDoc `@fails`: add "Throws when another live proxy owns the runtime; a dead owner's claim is taken over."
   - Then `npm run build:primitives` and check that `check:primitives` passes.
   - `createHolds`' "one queue per runtime" line now says it's **enforced by `claimRuntime`** in `createProxy`.
   - CHANGELOG `[Unreleased]` `### Added`: "One proxy per runtime is enforced: a second live proxy on the same runtime throws naming the owner's pid; a dead owner's runtime is taken over."

**Tests:**
- `test/runtime.test.mjs` (new; unit, needs no bwrap):
  - A first claim succeeds. A second claim on the same runtime throws naming our pid.
  - After `release()`, a new claim succeeds.
  - **Stale, dead pid:** write an owner file holding a pid that isn't running. Find one: spawn `true`, wait for its exit, then use its pid. The claim succeeds.
  - **Stale, reused pid:** our own pid with a wrong `start` value. The claim succeeds.
  - A garbage owner file is taken over.
  - `release()` doesn't delete a claim it doesn't own: overwrite the file with another pid first, then release, and the file is still there.
- `test/proxy.test.mjs`:
  - Two `createProxy` on one runtime: the second throws `in use by pid`, and the first's parked ask file still exists, answerable by writing `answers/<id>.json` (the hold settles allow).
  - `close()` releases: a new proxy on the same runtime starts.
  - A `ready` rejected by a taken port releases: a later proxy on the same runtime (with a free port) starts.
- `test/cli.test.mjs` (needs bwrap; mark it so the real shell runs it):
  - The reviewer's repro, two `sbx run --mode ask` on one `SBX_RUNTIME`. The second exits 1 with `in use by pid` on stderr.
  - The first's `sbx pending` still lists `h1`, and `sbx approve h1` settles it.

**Mutations (each red, shown):**
1. `claimRuntime` returns a no-op release without writing anything: the two-proxy test and the CLI test go red.
2. Skip the start-time comparison (pid alive is enough): the reused-pid test goes red.
3. `release()` deletes unconditionally: the "doesn't delete another's claim" test goes red.

## 2. Doc test cleanup (should; the two round-2 nits)

1. **Leaked temp folders.** `test/context-doc.test.mjs:41-51`: each doc block `mkdtemp`s a runtime and a project under `tmpdir()`, and nothing removes them (measured: +3 folders in `/tmp` per run).
   - **Fix:** run each block with `env: { ...process.env, TMPDIR: dir }`, where `dir` is the test's own scratch folder (already removed in `finally`). The blocks' `mkdtemp`s land inside it and are removed with it.
   - Keep the doc examples unchanged. Socket paths stay short, since `dir` is a short `/tmp/bb-doc-*`.
   - **Test:** count the `sbx-*`/`proj-*` entries in `os.tmpdir()` before and after the block runs; they must be equal. **Mutation:** drop the `TMPDIR` override → red.
2. **Dead `no-run` branch.** `test/context-doc.test.mjs:21-23`: the regex captures only `js` from a ```` ```js no-run ```` fence, so the `'js no-run'` branch never matches.
   - **Fix:** capture the whole info string (`^```([^\n]*)`), split it on whitespace, and require the first token to be `js`. A `no-run` token among the rest marks the block skipped.
   - **Test:** a unit test of the extractor (export it from the test file's helper, or move it to a tiny `test/doc-blocks.mjs` helper both use). Feed it a string holding one ```` ```js ```` and one ```` ```js no-run ```` block, and assert run flags `[true, false]`. **Mutation:** restore the old regex → red.

---

## Report back

- `wc -l` before and after for every changed file.
- Red/green lines for each new test, with the exact mutation.
- Proof that `sbx run` on a busy runtime prints `run failed: runtime … in use by pid N` (or the deviation, if it needed CLI code).
- `npm run typecheck` and `npm run check:primitives` output.
- Every test your sandbox couldn't run.
- Every deviation, and why.

## How the orchestrator will verify

1. In a real shell, rerun the reviewer's two-`sbx run` repro: the second is refused with `in use by pid`, and the first's `h1` stays approvable.
2. `kill -9` an `sbx run` mid-hold, then start a new one on the same `SBX_RUNTIME`. It must take over the dead claim and clear the stale ask and answer.
3. Apply each mutation in a scratch copy; each test must go red.
4. Count `/tmp` folders before and after `npm test`: no growth from the doc test.
5. Run the full suite 3× in a real shell (0 fail, 0 skipped, no hang), plus `npm run bench` within budget.
6. You commit, then `/self-review` round 3.
