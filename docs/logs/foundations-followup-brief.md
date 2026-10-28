# Foundations follow-up brief: CHANGELOG, one hang, rollback report, commit staging, CLI (2026-10-27)

**Branch:** `m4-undo-layer`, on top of the uncommitted foundations rework. Don't stage or commit.

**Where the rework stands (verified by the orchestrator in a real shell):**
- typecheck, `check:primitives` and every grep from sections 1, 5 and 6 are clean.
- The section 6 repros pass: 6.1 (plain and `--json`), 6.2 (file and folder), 6.3 (four read-only cases) and the 70,000-file driver.
  - The 70,000-file driver took 11 s / 8 s / 12 s for run / diff / commit, applied all 140 changes and left no commit folder.
- All seven mutations went red: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7 and 6.8.1. 6.6 has only a positive test (the brief allows this).
- **The full suite did not pass 3×.**
  - Runs 1 and 2 were 215/215, 0 skipped.
  - **Run 3 hung forever** in `test/overlay.test.mjs` (item 2 below).

This brief closes that and gives the code its last cleanup before the orchestrator takes it over. **Be ruthless:** delete code that doesn't earn its place, and redesign instead of patching. Every rule from `foundations-rework-brief.md` still applies:
- A skipped test did not run.
- No test-only code paths in `src/`.
- Reuse before you add.
- Every new test is shown red with its listed mutation, then green.

**Order and budget:**
- Items 1–3 are must-do.
- 4 and 5 are should-do.
- 6 is do-if-it-fits.
- If credit runs short, stop after any finished item and report. A half-finished item is worse than an untouched one.

---

## 1. CHANGELOG `[Unreleased]` records every break (must)

**Gap:**
- `### Removed` lists only the control socket.
- There's no `### Changed`.
- 0.2.0 is published, so all of the following broke public API without a record.
- The project rule: never list fixes to unreleased code under Fixed. Describe what ships under Added/Security/Removed/Changed.

**Write exactly these facts. Check each one against the code before you write it:**

`### Removed`
- Control socket: keep the existing entry.
- `createProxy`'s `certDir`. Certificates always live in `<runtime>/certs`, and `runtime` is now required.
- `createProxy`'s `allowUpstream`. There's no escape hatch around the upstream wall.
- `run()`'s `gate`, `match`, `shouldHold`, `pollMs`, `proxyPort` and `extraEnv`. Use `createProxy` + `launch` for low-level control.
- The hold queue's `approve(id)`, `deny(id)` and `size()`, and `body` on `pending()` entries (the ask payload carries `bodyPreview`).
- The library's `ASK OPEN <id>` write to stderr. The library never prints.

`### Changed`
- Test-only options moved under one key:
  - `createProxy({ unsafeTestOnly: { allowLoopback, resolveUpstream } })`
  - `run({ unsafeTestOnly: { allowLoopback } })`
  - The CLI variable is renamed from `SBX_ALLOW_LOOPBACK` to `SBX_UNSAFE_TEST_ALLOW_LOOPBACK`.
- `onEvent(e)` on `createHolds` / `createProxy`'s `hold` / `run()`:
  - `{ type: 'ask', ask }` when a hold parks
  - `{ type: 'decided', id, decision, reason }` when it settles
  - `run()`'s `asks` result is built from these events.
- Decisions are written as `allow` / `deny` everywhere, the audit log included. `approve` is still accepted, as an alias in answer files only.
- Anything item 4 changes in the `sbx` output streams.

Also:
- Leave the 0.2.0 section alone, including its now-stale `certDir` line: released sections are history.
- Add to `### Added` if not already there:
  - The commit works under read-only project folders (6.3).
  - Rollback always works whatever the agent left in the upper (6.2).
  - The walker has no output cap, and node is found wherever it's installed (6.5, 6.6).
  - These are new behaviour of unreleased code, so they go under Added, never Fixed.

**Verify:** each Removed/Changed name, grepped in `src/`, returns nothing for removed names and the new spelling for changed ones. Put the grep output in the report.

## 2. The 6.2 test hangs forever about 1 run in 3 (must)

**Bug:** `test/overlay.test.mjs:432` `nextLaunchAllowed`:
1. It `launch()`es, then immediately `child.kill('SIGKILL')`, then awaits `close`.
2. When the kill lands while bwrap is still setting up, the outer bwrap dies. Its inner pid-1 child is orphaned (reparented to `systemd --user`), blocked in `do_wait` and still holding the stdout/stderr pipes.
3. So `close` never fires, and the test has no timeout. The orchestrator saw it hang run 3 for more than 5 minutes.
4. Evidence: the orphan's `NSpid: <pid> 1`, PPid 1150 (`systemd --user`), fds 1–2 are the test's sockets, and its args are the `rb-file` fixture.

**Fix:**
1. Don't kill. The command is `true`: await its natural `close`.
2. Give every test in this file that awaits a child's `close` a hard per-test `{ timeout }`, so a hang fails loudly instead of hanging the suite. Then grep the other test files for `kill('SIGKILL')` followed by `await` of `close`/`exit` and apply the same rule.
3. **Library check:** `grep -n "kill(" src/` is empty today, so the product never kills a bwrap mid-setup. Say so in the report; don't add code.

**Proof:**
- Run `node --test --test-name-pattern='mode-000' test/overlay.test.mjs` 30 times in a loop: 0 hangs and 0 fails.
- Restore the immediate SIGKILL: within those 30 runs it must fail by the new timeout, not hang. Show the count.

## 3. Rollback reports why it is inexact, never as a fake path (must)

**Bug:**
- `src/overlay.js:870` puts an error message into a change's `path` (`"(could not list: …)"`, status `unknown`).
- `src/overlay.js:879` swallows diff's reason.
- `src/cli.js:317` then always prints `project gone or no userns: exact list unavailable`.
- Real output from the 6.1 repro, where the project and userns are both fine:
  ```
  discarded 1 entries (project gone or no userns: exact list unavailable)
  discarded (could not list: sbx: refusing non-UTF-8 filename in …/upper/evilX (bytes fffe; rename it and retry))
  ```
- That's two lines that contradict each other, a wrong reason, and an error counted as an entry.

**Fix:**
1. `rollbackOverlay` returns `{ discarded: OverlayChange[], exact: boolean, why: string|null }`.
   - `why` is null when exact.
   - Otherwise it's the actual reason: diff's error message, or `project <proj> is gone`.
   - When the raw listing also fails, `discarded` is `[]` and `why` carries both reasons.
   - No fake entries. Delete the `unknown`-status placeholder construction.
2. The CLI prints one line when inexact, `discarded <n> entries, exact list unavailable: <why>`, and nothing else contradictory. With an empty list plus a `why`, it says `discarded (could not list: <why>)`.
3. Removal never depends on listing **or on chmod**:
   - If `chmodTree` or `rmSync(basedir)` throws partway, retry `rmSync` once after a fresh `chmodTree` on the remainder.
   - If that still fails, throw one error naming the folder.
   - Today a partial `chmodTree` failure is swallowed and the `rmSync` can throw a raw `EACCES`.
4. Update the JSDoc `@returns` / `@fails` and regenerate `primitives.json` (`npm run build:primitives`) for the new field.

**Tests** (`test/overlay.test.mjs` / `test/cli.test.mjs`, needs bwrap):
- Non-UTF-8 name in the upper:
  - `exact` is false.
  - `why` contains `non-UTF-8`.
  - No entry's `path` starts with `(`.
  - The overlay folder is gone.
  - CLI output has no `project gone or no userns`.
- Project deleted after the run: `why` contains `is gone`, and the raw list is exact paths.
- Mutation: restore the placeholder entry, and the first test goes red.

## 4. Commit copies only what it applies (should; measure first)

**Problem:**
- `src/overlay-walk.js` stages **every** regular file and symlink of the merged view into `<commitDir>/new`, but `swapIn` renames in only the changed ones.
- A commit of one changed file in a 5 GB project copies 5 GB into the project folder first. That's a disk-full failure waiting to happen, and most of the 70,000-file commit time.
- Separately:
  - The walker hashes every merged file, though every merged path absent from the upper is the lower file unchanged.
  - `commitOverlay` and `snapLower` each `walkLocal(upper)` (hashing every upper file) just to ask "is it empty?".

**Fix:**
1. **Empty check:** one `upperIsEmpty(upper, ignore)` that stops at the first visible entry and hashes nothing. It replaces all three `walkLocal(…).size === 0` uses (`setupOverlay`, `commitOverlay`, `snapLower`).
2. **Stage and hash only upper paths:**
   - The host already knows the upper's relative paths (one cheap walk, no hashing).
   - Pass that list to the walker as a file in `/sbx-out`.
   - The walker `lstat`s every merged path (deletions need the full set), but hashes and stages only paths in the list.
   - The host fills entries for the other merged paths from `lower`.
   - Overlay facts this relies on (state them in a code comment and a test): a merged path that is not in the upper is the lower entry unchanged.
     - Opaque folders and copy-up both land the path in the upper.
     - bwrap's overlay has no `metacopy` / `redirect_dir`, and with them a path would still be in the upper.
3. Keep one walker, `walkLocal`. Add an optional "hash only these" set rather than a second walker.

**Proof:**
- Before any code, record the 70,000-file driver (generator in the orchestrator's note below) with `/usr/bin/time -f '%e s %M KB'` for run, diff and commit, plus `du -s` of the commit folder captured mid-commit if you can.
- After: the same numbers. Report both.
  - If commit isn't clearly faster, keep only fix 1 and say why.
- The existing commit and type-change suite must stay green. That's the correctness proof for fix 2.
- Add one test: a project with an unchanged 0400 file and an unchanged symlink, plus one changed file, commits. The unchanged file keeps its inode (`statSync(...).ino` before and after).
- Mutation: make the host take `lower` entries for upper paths too. The type-change tests must go red. Show which.

70,000-file generator (run in a scratch dir, then `sbx run --overlay` with `for d in dir_*; do echo b > "$d/newfile"; done; find . -name "f_*_7" -delete`):
```
node -e 'const fs=require("fs");const L="x".repeat(120);for(let d=0;d<70;d++){const dir=`dir_${L}_${d}`;fs.mkdirSync(dir);for(let i=0;i<1000;i++)fs.writeFileSync(`${dir}/f_${L}_${i}`,"a")}'
```
Use a short `SBX_RUNTIME` (for example `/tmp/v/r`): socket paths cap at 107 bytes.

## 5. `sbx` CLI: one dispatch, errors on stderr (should)

**Problems in `src/cli.js`:**
- **Double dispatch.**
  - Six one-line wrappers (`diff`, `commit`, `rollback`, `pending`, `approve`, `deny`) forward a string to `cliOverlay` / `cliDecide`.
  - Those then branch on the same string with `if (overlayCmd === …)`.
- **`say` is `out` under another name.** Its JSDoc claims it sanitizes "here, once", which is stale since 6.1 moved that into `out`.
- **`fail` throws `'unreachable'`** after `process.exit`, which already returns `never`.
- **Errors go to stdout:**
  - every overlay refusal (`fail` → `say` → `out`)
  - conflicts
  - `bad hold id`
  - `unknown <id>`
  - bad agent names
  - `sbx run` already uses stderr for `run failed`, so the CLI is inconsistent with itself.

**Fix:**
1. `COMMANDS` maps each name straight to the function that does the work: `diff`, `commit`, `rollback`, `pending`, `approve`, `deny`, `run`.
   - Shared steps become two small helpers: `needRuntime()` and `overlayArgs(rest, { skipConflicts })` returning `{ runtime, agent, skipConflicts }`.
   - Delete `cliOverlay`, `cliDecide`, `say` and the wrappers.
2. Results go to stdout. Every error, refusal and usage-on-error goes to stderr through `err`. `--help` stays on stdout, exit 0.
3. Exit codes don't change. Record the stream change under `### Changed` in the CHANGELOG.
4. Report `wc -l src/cli.js` before and after. It should shrink.

**Tests:** update the CLI tests that read refusals from stdout, then add the following, each red on today's code:
- `sbx diff` with no overlay writes nothing on stdout, writes the message on stderr, and exits 1.
- `sbx approve ../x` writes nothing on stdout and exits 2.

## 6. Harden the walker's bwrap call (do if it fits)

`bwrapWalk` (`src/overlay.js:359`) runs our node over agent-written files with:
- no `--die-with-parent`, so a killed `sbx commit` leaves the walker still copying into the project
- no `--unshare-net` (it needs no network)
- no `--new-session`

**Fix:** add `--die-with-parent`, `--unshare-all` and `--new-session`. Keep `--overlay` working: check it still mounts with `--unshare-all`; if it doesn't, say why and use `--unshare-net --unshare-pid --unshare-ipc --unshare-uts`.

**Test:** the existing diff/commit suite is the proof. Add no new test unless you can show `--die-with-parent` working without a sleep-based race. If you can't, say so.

---

## Report back

- `wc -l` before and after for every `src/` file. "Before" is today's tree, not HEAD.
- Deleted functions and removed options or fields.
- Red/green proof for every new test, with the exact mutation.
- Item 2's 30-run loop counts, both ways.
- Item 4's before/after timings, or why only fix 1 landed.
- `npm run typecheck`, `npm run check:primitives` and the CHANGELOG greps.
- Every deviation, and why.
- Do not run `git checkout` / `git restore` on `src/` or `test/`. Last round that destroyed work. Back up to a scratch dir before fault isolation, or use a copy of the tree.

## How the orchestrator will verify

1. Rerun item 3's repro (6.1's non-UTF-8 run, then `sbx rollback`) and item 5's error streams in a real shell. `cat -v` shows no escape bytes.
2. Apply each listed mutation in a scratch copy; its test must go red.
3. The 30-run `mode-000` loop.
4. The 70,000-file driver with timings.
5. The full suite 3× in a real shell: 0 fail, 0 skipped, no hang. Then the user commits and runs `/self-review`.
