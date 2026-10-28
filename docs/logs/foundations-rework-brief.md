# Foundations rework brief: M0–M2.5 core (2026-10-27)

> **For:** the build agent, after the M4 rework (`docs/logs/m4-rework-brief.md`) is committed and its `/self-review` has no must-fix items left.
> **Scope:** `src/proxy.js`, `src/holds.js`, `src/run.js`, `src/cli.js`, `src/launcher.js` and `src/certs.js`, plus their tests. `src/overlay.js` where a shared helper moves (section 1), and for the M4 round-3 fixes (section 6).
> **From:** a design read of every line of those files, as they stood with the M4 rework uncommitted (suite 188/188, 0 skipped, in a real shell).
> **Mandate:** clean, simple foundations before M3 builds on them. Rewriting a file from scratch is allowed. Behaviour that the tests pin stays; structure, API surface and duplication are fair game. barebox is pre-1.0 with no known users, so breaking the 0.2.0 API is fine: record it in the CHANGELOG.

## How to work this brief

The working rules from the M4 brief still apply:
- A skipped test did not run.
- Show every new test red, then green.
- Stage by explicit path; commit only when the user says so.
- Report `wc -l` before and after for every `src/` file, plus the list of deleted functions and options.

**Order:** 1, then 6, then 2, 3 and 4 in that order. Do 5 alongside (5.2 together with 6.1). Run the full suite after each section, not only at the end.

**Why this brief exists:** the code works, but the same problems keep recurring:
- runtime-folder paths are defined in four files
- one decision has two writers
- a value is normalized in four places
- some state is read back from the log or the filesystem when it's already in memory
- the public API is full of test-only and placeholder options

Every one of these is a place where M3 would have to change several files to change one rule. That's how M4 got two review rounds of bugs.

---

## 1. One module owns the runtime folder (`src/runtime.js`, new)

**Problem:** the runtime folder's layout is spread over five files, and the "is this path inside that one" check exists four times.

| What | Where today |
|---|---|
| socket path, agent-name check, real-path helper | `proxy.js` (`socketPathForAgent`, `assertAgentName`, `realPathOf`) |
| ask and answer paths | `holds.js` (`askPaths`) |
| overlay paths | `overlay.js` (`overlayPaths`) |
| certificates folder default + containment check | `proxy.js` (`createProxy`) |
| CA bundle path | `launcher.js` (`buildCaBundle`) |
| audit log path | `run.js` (`audit.jsonl`) |
| creating a short temp runtime | `run.js` and `cli.js` (the same `mkdtempSync(... 'sbx-')`, twice) |
| containment checks | `launcher.js` (`under`, `realInside`, two runtime-is-HOME checks), `proxy.js` (`startsWith`) |

`launcher.js`, `overlay.js` and `cli.js` import their path helpers from `proxy.js`, so the sandbox launcher depends on the TLS proxy just to get a filename.

**Do:**
1. Create `src/runtime.js` as the single writer of the layout. It holds:
   - `createRuntime()`, the short `mkdtemp`
   - `runtimePaths(runtime)`, returning `{ socket(agent), asksDir, answersDir, askFile(id), answerFile(id), certsDir, caBundle, audit, overlay(agent) }`
   - `assertAgentName`, `realPathOf`, and one `isInside(base, p)` that compares real paths
2. Every module imports layout from there. Delete `socketPathForAgent`, `askPaths` and `overlayPaths` from their current files. `launcher.js` no longer imports `proxy.js`.
3. **Delete `createProxy`'s `certDir` option.** It's always `<runtime>/certs`, and `runtime` becomes required. The containment check goes away because there's nothing left to contain. Update the tests that pass `certDir` (`proxy.test.mjs` ×12, plus `e2e` and `cli`).
4. **Launcher:** replace the overlay "runtime inside the project" check (`under`, lexical and real), the two "runtime is HOME or the project" checks, and `realInside` with `isInside` and one real-path comparison. Keep the behaviour exactly as the tests pin it, including the symlinked-runtime case.

**Done when:** `grep -n "mkdtempSync\|'socks'\|'asks'\|'answers'\|'certs'\|audit.jsonl" src/` matches only `runtime.js`, and nothing outside `proxy.js` imports from it except `index.js`.

---

## 2. The hold queue: one deadline, one answer reader, one way to report outcomes (`src/holds.js`)

### 2.1 One deadline

**Problem:** a file-channel hold has two writers of the timeout decision:
- the `setTimeout` in `add()` settles it with `'hold timeout'`
- `defaultFileAsk` checks the same deadline in its own loop

Whichever runs second finds no entry. It works, but nobody can tell which one decided.

**Do:** the timer in `add()` is the only deadline. The answer reader never looks at the clock.

### 2.2 One answer reader for all holds

**Problem:** every parked hold runs its own poll loop (`defaultFileAsk`: one rename attempt every 250 ms per hold). A separate `sweepStaleAnswers` interval also reads the same folder to find stale answers. With 20 parked holds, that's 21 readers of `answers/`.

**Do:**
1. Use one interval per queue, file channel only. Each tick it reads `answers/` once. For each answer file, it consumes the file (rename, then read, as now) and:
   - if the queue holds that id, settles it
   - otherwise logs `stale-answer`
2. Delete `defaultFileAsk`, `sweepStaleAnswers`, `sleepMs`, and the "settled elsewhere" path.
3. The `onAsk` channel stays a promise per hold. The file channel is no longer pretending to be an `onAsk`.

### 2.3 One normalization of decisions

**Problem:** `'approve'` vs `'allow'` is handled in four places:
- `parseAnswer` accepts the alias
- `park()` re-checks `allow || approve` on `onAsk` results
- `run.js`'s `wrappedOnAsk` checks it a third time
- `collectAsks` maps it a fourth time

The audit log also writes `decision: 'approve'` while the API speaks `'allow'`.

**Do:** one `normalizeDecision(x)` in `holds.js`, returning `{ decision: 'allow' | 'deny', reason }`, applied once wherever a decision enters (an answer file, or an `onAsk` result). The audit log writes `'allow'`/`'deny'`, which is bareguard's vocabulary. Keep `'approve'` as an accepted input alias in answer files only.

### 2.4 Outcomes are reported, never reconstructed

**Problem:**
- `run.js` rebuilds its `asks` result by re-parsing its own audit log (`collectAsks`), and on the `onAsk` path it also collects them through a wrapper (`seen`, `wrappedOnAsk`). That's two sources for one record, merged.
- `sbx run` runs in the same process as the queue, yet it learns about asks by polling `asks/` every 100 ms (`sweepOnce`, `seen`), including a catch-up sweep for "an ask parked after the last poll".
- The library writes `ASK OPEN <id>` straight to `process.stderr`.

**Do:**
1. `createHolds` (and `createProxy`'s `hold` option) takes one optional `onEvent(e)` callback. It's called with `{ type: 'ask', ask }` when a hold parks and `{ type: 'decided', id, decision, reason }` when it settles.
2. The library never writes to stdout or stderr. Delete the `ASK OPEN` write.
3. `run()` builds `asks` from those events. Delete `collectAsks`, `seen` and `wrappedOnAsk`.
4. `sbx run` prints asks from the same events (it can pass a callback through `run()`). Delete `sweepOnce`, the 100 ms poll, `seen`, and the catch-up sweep. Keep the `ASK OPEN` hint on stderr in the CLI, if you keep it at all.
5. `pending()` stays on the queue, because `sbx` doesn't use it but tests do. Drop `body` from `HeldRequest`: returning whole 1 MB bodies from a status call is never needed, and the ask payload has the preview.

### 2.5 Dead queue API

`approve(id)`, `deny(id)` and `size()` on the queue handle have no callers in `src/` or `test/`. Delete them.

---

## 3. A small public API (`src/run.js`, `src/proxy.js`, `src/launcher.js`)

### 3.1 Test-only options go behind one clearly unsafe key

**Problem:** `createProxy` exposes `allowLoopback`, `allowUpstream` and `resolveUpstream` next to production options, and `run()` passes `allowLoopback`. The CLI reads `SBX_ALLOW_LOOPBACK=1` from the environment. `allowUpstream` has no caller in `test/` at all.

**Do:**
1. **Delete `allowUpstream`.** It has no caller, and an escape hatch around the wall is exactly what adopters should not find.
2. **Move the rest** to `createProxy({ ..., unsafeTestOnly: { allowLoopback, resolveUpstream } })` and `run({ ..., unsafeTestOnly: { allowLoopback } })`. One key that reads as what it is, documented once.
3. **Rename the CLI variable** to `SBX_UNSAFE_TEST_ALLOW_LOOPBACK`.
4. The TCP test listener (`port`) stays, documented as test-only, because the CLI and proxy tests use it.

### 3.2 `run()` takes only what a harness needs

**Problem:** `run()` forwards almost every low-level option (`match`, `shouldHold`, `pollMs`, `proxyPort`, `extraEnv`, `allowLoopback`), so every change to `createProxy` or `launch` becomes a `run()` API change.

**Do:**
1. **Keep:** `proj`, `command`, `mode`, `onAsk`, `onEvent` (from 2.4), `runtime`, `agent`, `overlay`, `overlayIgnore`, `timeoutMs`, `stdout`, `stderr` and `unsafeTestOnly`.
2. **Remove from `run()`:** `match`, `shouldHold`, `pollMs`, `proxyPort` and `extraEnv`. Tests that need them use `createProxy` + `launch` directly, which stay public, or `unsafeTestOnly` if it's truly test-only.
3. **Delete `gate`.** It's validated, then ignored: speculative code until M3, which adds it back wired to something. Remove its tests (`run.test.mjs`, the two `gate:` cases) and the JSDoc and comments saying "accepted for API stability".
4. `shouldHoldForMode` keeps the interim rule, unexported if no test needs it. If tests need it, keep it exported, but no `match`/`shouldHold` override parameters.

### 3.3 Remove the migration guards for the 0.2.0 control socket

**Problem:** three guards remain for something that no longer exists, plus their prose in the file headers:
- `createProxy` throws on `opts.controlSocket`
- `createProxy` throws on `hold.controlSocket`
- the CLI rejects `SBX_SOCK`

0.2.0 shipped today and has no known users.

**Do:** delete all three. Record the break once in the CHANGELOG under `[Unreleased]`, in a `### Removed` section: "control socket (`controlSocket`, `SBX_SOCK`): use the file channel or `onAsk`".

### 3.4 `launch()` returns what it creates

**Problem:** `launch()` attaches `.overlay` onto the `ChildProcess` object through a cast (`anyChild.overlay = ...`). Only two tests read it.

**Do:** either return `{ child, overlay }`, or drop the property and let callers use `runtimePaths(runtime).overlay(agent)` from section 1. Pick the one that leaves fewer lines, and update the two tests.

---

## 4. The proxy: split the pure wall out, one error responder (`src/proxy.js`)

**Problem:** `createProxy` is one closure of about 450 lines holding the wall, forwarding, request handling, CONNECT, listeners and agent registry. Error answers are written three ways:
- `denyRes` (log, then write the response)
- `denyRaw` (log, then write raw bytes)
- `fail` inside `forwardInner` (log, then write the response again: a copy of `denyRes`)

Also, the `catch` in `forward()` logs a `deny` and then calls `denyRes`, which logs it again. **Every upstream 502 from that path writes two audit lines.**

**Do:**
1. **Move the upstream wall into `src/wall.js`:** `normIp`, `mappedV4`, `v4Parts`, `localIps`, `denyReasonForIp`, `resolveAllUpstream`, `interleaveIps` and `checkUpstream`. These are pure and already unit-tested through `denyReasonForIp`. M3 replaces the private-IP part with bareguard's `isPrivateIp` in that file only.
2. **One response writer.** `denyRes(cres, code, note)` is the only place a proxied HTTP error is logged and written. `fail` in `forwardInner` calls it, guarded by its own `done` flag. `denyRaw` stays only for pre-HTTP raw sockets (the CONNECT line and an oversized request head), and logs the same way.
3. **Fix the double log in `forward()`'s `catch`.** Add a test that counts `deny` lines for one failed upstream: it must be exactly 1.
4. **No size target, but report it.** The test is whether a reader can find "where is a request decided" in one place.

---

## 5. Smaller, independent items

1. **`--new-session`: DONE by the orchestrator, decided by the user (always on).** Leave it alone.
   - The conditional version kept the agent's access to `/dev/tty` "for TUI agents". But `launch()` spawns with stdin ignored, so no agent ever had an interactive terminal.
   - `src/launcher.js` now adds `--new-session` unconditionally, and the JSDoc says so.
   - Tests in `test/launcher.test.mjs`:
     - "always detaches the terminal (--new-session), even when stdin is a TTY" checks the arguments with `isTTY` set to true.
     - "runs the agent in its own session, detached from our terminal" checks that the session id inside the sandbox isn't 0.
   - Interactive agents, if wanted later, are a separate design: a real stdin passed through a pty.
2. **CLI argument parsing is hand-rolled three times** (`run` flags, overlay flags, decide args), with `console.log(USAGE); process.exit(2)` repeated about 10 times. Use `node:util` `parseArgs` (stdlib) and write one `usage()` that prints and exits 2.
3. **`buildCaBundle` rewrites `<runtime>/ca-bundle.pem` on every `launch()`.** That's correct but wasteful with 20 agents. Write it once if it's missing; the CA doesn't change during a runtime's life. Keep a test that a missing bundle is created.
4. **`HOST_RE` lives in `certs.js` and is imported by `proxy.js`.** That's correct after the M4 rework. Confirm nothing else redefines it.

---

## 6. M4 review round 3: fixes and test gaps (`src/overlay.js`, `src/cli.js`)

**Source:** the third `/self-review` of the M4 rework (`6c4b353`). It ran on a scratch copy with real bwrap, and every reproduction below was run there.

**What held** (keep it working, and don't redesign it): the journaled rename commit and its undo; type changes in every direction; refusing leftover commit folders; the EXDEV refusal; the dial fallback; rollback output matching diff.

**Order:** do section 6 after section 1, since `runtime.js` moves some of these paths. Do 6.1 together with 5.2, since both are CLI output.

**Rule for every item:** reproduce it first, using the command given, and show the failure. Then fix it, add the test, and show the test red with the fix reverted.

### 6.1 Every line `sbx` prints goes through one sanitizer (must fix)

**Bug:** `src/cli.js:185`, `` console.error(`run failed: ${e instanceof Error ? e.message : String(e)}`); ``. `sbx run` prints error messages raw, and since the rework those messages can contain agent-chosen paths (the non-UTF-8 refusal names the folder).

**Repro:**
```
SBX_RUNTIME=/tmp/r-x sbx run --overlay -- bash -c 'd=$(printf "ev\033[2K\033[1Ail\xe2\x80\xaeX"); mkdir "$d"; touch "$d/$(printf "\xff\xfe")"' 2>&1 | cat -v
```
It prints `^[[2K^[[1A` and `M-bM-^@M-.` (the ESC and U+202E bytes) on the `refusing non-UTF-8 filename` line.

**Fix:**
1. Structural, not one more `safe()` call. `cli.js` gets two printers: `out(line)` for stdout and `err(line)` for stderr. Both apply `safe()`.
2. Replace every `console.log` and `console.error` in `cli.js` with them, including usage lines, `run failed:`, the `runtime …` hint, the `overlay:` summary, `emitAsk` and the `pending` lines.
3. `--json` output also goes through `out()`, but sanitize the values before `JSON.stringify`, as `emitAsk` does now, so the JSON stays valid.
4. Afterwards, `grep -n "console\.\(log\|error\)" src/cli.js` matches only inside `out` and `err`.

**Tests** (in `test/cli.test.mjs`, needs bwrap):
- Run the repro through `sbx run --overlay` (plain and `--json`). Assert that the combined stdout and stderr contain no `\x1b`, no `‮`, and no byte below 0x20 other than `\n`.
- Revert proof: put the raw `console.error` back at the `run failed` site, and the test must go red.

### 6.2 Rollback always works, whatever the agent left in the upper (must fix)

**Bug:** `src/overlay.js:635`, `entries = walkLocal(upper, ignore);`. Rollback's raw fallback walks the upper before `chmodTree` fixes permissions, against brief 1C. An agent that leaves an unreadable file or folder in the upper wedges diff, commit, setup and rollback for good: they throw `EACCES` repeatedly, and `<runtime>/overlay/<agent>` is never removed. The file case regressed from `82cb719`; the folder case already failed there.

**Repro:** `sbx run --overlay -- bash -c 'echo x > f; chmod 000 f'`, then `sbx rollback` → `EACCES … open '…/upper/f'`, every time. The same happens with `mkdir d; echo x > d/f; chmod 000 d`.

**Fix:**
1. Rollback is the escape hatch, so it must never depend on what's in the upper. Its first step is `chmodTree` on the overlay folder.
2. Then it takes the report: the diff when the overlay mounts, otherwise the raw list. If even the report fails, it still removes the overlay folder and says `discarded (could not list: <reason>)`. **Removal never depends on listing.**
3. **diff and commit:** an unreadable entry in the agent's view is refused loudly, naming the path (through `safe()`) and suggesting `sbx rollback`. Don't `chmod` the upper to make it readable: that would change the modes the commit applies.
4. Fix the `@fails` line for `rollbackOverlay` in the JSDoc and in `primitives.json`, so it says exactly what can still throw.

**Tests** (`test/overlay.test.mjs`, needs bwrap):
- For each of a mode-000 file and a mode-000 folder (with a file inside), left by the agent:
  - `rollbackOverlay` succeeds, and the overlay folder no longer exists.
  - The next `launch({ overlay: true })` is allowed.
  - The project is byte-for-byte unchanged.
- The same upper with `diffOverlay` and `commitOverlay`: each throws a message that names the path and mentions rollback, and the project is unchanged.
- Revert proof: move `chmodTree` back after the walk, and the rollback tests must go red.

### 6.3 Commits work under read-only project folders

**Bug:** `src/overlay.js:547`, `renameSync(join(ov.proj, c.path), slot);`. This predates the rework. A rename needs write permission on the parent folder, so any change inside a 0555 folder in the project can never commit. Undo is exact, but the commit is blocked forever. This is the reachable version of the brief's cases 2 and 6, which the agent called unreachable. Real examples: Go module caches, vendored read-only trees, and checkouts that set 0555 folders.

**Repro:** the project has `ro/` at 0555 holding `ro/f`. The agent runs `chmod u+w ro; rm ro/f; chmod 555 ro`. `sbx commit` fails with `EACCES rename …`.

**Fix (stays inside the journal design):**
1. In phase 2, before step 1, collect every parent folder that a step will rename into or out of, or `mkdir`/`rmdir` in. For each one you can't write to but own, journal `{ op: 'chmod', path, mode: <current> }` and add `u+w`.
2. Step 5 sets each folder's final mode: the merged-view mode if the folder is in the changeset, otherwise its original mode.
3. Undo reverses these entries like any other step.
4. Folders you don't own are left alone; the rename fails and is undone, as today. Name that case in the error.

**Tests** (`test/overlay.test.mjs`, needs bwrap):
- The repro above commits: `ro/f` is gone, and `ro/` is 0555 afterwards.
- `rm -rf ro` on a 0555 tree two levels deep, after `chmod -R u+w ro` inside the sandbox, commits, and `ro/` is gone.
- An unchanged 0555 folder that only contains a changed file (the agent didn't touch its mode) commits, and the folder is still 0555 afterwards.
- Undo exactness: trigger a failure after the temporary `chmod`, for example a second change whose destination's parent is owned by root (`/` paths aren't usable; use a folder made unwritable by `chmod 000` on its own parent after phase 1 if you can, or explain why not). The 0555 modes must be back afterwards.
- Revert proof: remove the temporary `chmod`, and the first two tests must go red.

### 6.4 The "undo failed, keep the commit folder" path is tested through the code that decides it

**Gap:** `src/overlay.js:517`, `{ code: 'SBX_COMMIT_FAILED', notUndone, keepCommitDir: true });`. Deleting `keepCommitDir: true` leaves all 57 overlay tests passing. A regression there would delete `old/`, which holds the only copy of the originals, after a failed undo. Test 7 only exercises `undoJournal`.

**Fix:** put the decision in one small function, for example `finishFailedCommit(commitDir, undoResult)`. It deletes the commit folder only when `notUndone` is empty, and otherwise returns or throws the error that names the folder. `commitOverlay` calls it. That's a real refactor that puts the decision in one place, not a test-only hook.

**Tests:**
- Unit: with `notUndone` non-empty, the folder still exists, and the error names it and lists the steps. With `notUndone` empty, the folder is gone.
- Through `commitOverlay`: a phase-2 failure that undoes cleanly (the repro from 6.3 with the 6.3 fix reverted is one way) leaves no `.sbx-commit-*` folder.
- Revert proof: make the function always delete, and the first test must go red.

### 6.5 No fixed output cap on the walker; errors say what failed

**Gap:** `src/overlay.js:303`, `{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });`. A project with about 70,000 files and long paths produced a 72 MB manifest, and `sbx diff` threw `overlay view failed (spawnSync bwrap ENOBUFS; diff/commit need bwrap)`. That blames bwrap, and nothing tells the user how to recover. Commit has the same cap and the same 120 s timeout.

**Fix:**
1. The walker writes its manifest as JSON to a file in a folder bound read-write into the bwrap call: `--bind <scratch>/walk-<rand> /sbx-out`. The host reads that file. stdout is no longer used for data, so there's no `maxBuffer`.
2. Remove the 120 s timeout. The walk is finite (`lstat`, never following symlinks), and killing a commit's extraction halfway helps nobody.
3. Every bwrap failure message says what step failed, for example `overlay walk failed (exit N): <stderr>` or `could not start node inside bwrap: <error>`, instead of a generic "need bwrap".

**Tests:**
- A project with 20,000 small files (generated in `before`, under tmpdir) diffs and commits correctly. Assert the count and that commit applied them.
- Mutate the code back to reading stdout with a 1 MB `maxBuffer` in a scratch copy: the test must go red.
- I'll also run the reviewer's 70,000-file driver by hand.

### 6.6 Don't hardcode the node path

**Gap:** `src/overlay.js:300`, `'--', '/usr/bin/node', join(srcDir, 'overlay-walk.js'),`. On a host where node isn't `/usr/bin/node` (nvm, volta, Linuxbrew), bwrap fails with `execvp /usr/bin/node: No such file or directory`, every diff and commit with changes fails, and the message never mentions node.

**Fix:**
1. Use `realpathSync(process.execPath)`, the node running barebox now. On this host that's `/usr/bin/node-22`.
2. If it isn't under `/usr`, add `--ro-bind <prefix> <prefix>`, where the prefix is the folder above its `bin/` (nvm, volta and Linuxbrew all lay node out as `<prefix>/bin/node`).
3. Name the interpreter in the start-failure message from 6.5.

**Test:**
- Copy the node binary to `<tmpdir>/n/bin/node`. Spawn a child with that copy that runs a small script calling `diffOverlay` on a prepared overlay with one change, and assert it lists the change. This is real, with no seam needed, because `process.execPath` is the copy in that child.
- Revert proof: hardcode `/usr/bin/node` and point the copy's run at a mount where `/usr/bin/node` is absent. If that can't be arranged here, say so, and keep only the positive test.

### 6.7 Test the check for a project changed mid-commit

**Gap:** `src/overlay.js:500`, `if (fpNow(join(ov.proj, c.path)) !== (lowerFps.get(c.path) ?? null)) {`. Replacing the condition with `if (false)` keeps the suite passing, so a project edit landing between the diff and the swap would be silently overwritten.

**Fix:** move the check into one function, for example `changedSince(proj, paths, lowerFps)`, which returns the first changed path or null. `commitOverlay` calls it and refuses with "project changed during commit; nothing was applied" when it returns a path.

**Tests:**
- Unit: snapshot the fingerprints, edit one file, and the function returns that path. Delete a file and it returns that path; create a file where none existed and it returns that path; with no edit it returns null.
- Revert proof: make it always return null, and the unit test must go red.

### 6.8 Cleanup (no behaviour change)

1. **Test the commit-folder exclusion.** `src/overlay.js:114`, `if (isIgnored(rel, ignore) || isCommitDir(rel)) continue;`. Removing `|| isCommitDir(rel)` keeps everything passing, yet without it a `.sbx-commit-x` folder planted by the agent would be committed into the project and then block every later operation. Add a test (needs bwrap): the agent creates top-level `.sbx-commit-x/f`; `diffOverlay` doesn't list it; `commitOverlay` doesn't create it in the project; the next `diffOverlay` isn't blocked. It must go red without `isCommitDir`.
2. **Delete the unreachable checks.**
   - `src/overlay.js:317`, `for (const rel of out.keys()) assertSafeRel(rel);`. The keys come from our own walker's `readdir` names, which can never be `..` or absolute.
   - The last fallback line of `exoticName` (`src/overlay.js:374`). Types `f`, `d` and `l` are filtered out before it is ever called.
   - If `assertSafeRel` has no other caller left, delete it.
3. **One way to build an entry.** `fpNow` (`src/overlay.js:389`) rebuilds file and symlink entries by hand, copying `walkLocal`'s per-entry code (`src/overlay.js:121-129`). Extract `entryOf(abs, lstat)`, used by both, so the fingerprint is defined once.

### How I'll verify section 6

1. **Rerun every repro above** in a real shell (6.1, 6.2 file and folder, 6.3, the 70,000-file driver for 6.5). Each must now succeed, or be refused cleanly with a safe message, and `cat -v` must show no escape bytes.
2. **Mutation checks in a scratch copy**, one at a time:
   - the raw `console.error` (6.1)
   - `chmodTree` moved after the walk (6.2)
   - the temporary `chmod` removed (6.3)
   - always deleting the commit folder (6.4)
   - a 1 MB `maxBuffer` on stdout (6.5)
   - `changedSince` returning null (6.7)
   - `isCommitDir` removed (6.8.1)

   Each must turn its test red.
3. **Greps:**
   - `grep -n "console\.\(log\|error\)" src/cli.js` matches only `out` and `err`.
   - `grep -n "/usr/bin/node\|maxBuffer\|timeout: 120000" src/overlay.js` matches nothing.
4. **Full suite 3 times:** 0 failures, 0 skipped.

## Out of scope

- **Audit line shape (`phase`/`decision`/`rule`/`run_id`/`agent`/`ts`), redaction via bareguard `secrets`, and replacing `mappedV4` with `isPrivateIp`.** These are M3 (PRD M2.5 item 6, deferred). Section 4.1 only puts the wall in one file, so M3 has one place to change.
- **Ledger items in `/refactor`'s queue:** IPv6 literal CONNECT, the bench sampling race, the bridge test race.
- **The socat bridge script in `launch()`.** It's the only shell left in the launcher, and `proxyPort` is now validated. It isn't worth replacing before M6 measures it.

## Done when

- [ ] Section 6 is done: every repro in it now passes or is refused cleanly, each new test was shown red with its mutation, and the section 6 greps are clean.
- [ ] Sections 1–5 are done. `wc -l` before and after for every `src/` file, plus the lists of deleted functions and removed options, are in the report.
- [ ] The section 1 grep check passes. `launcher.js` doesn't import `proxy.js`.
- [ ] No `process.stdout`/`process.stderr` writes remain in `src/` outside `cli.js` and `run.js`'s stream defaults.
- [ ] The audit log writes exactly one `deny` line per failed upstream (test).
- [ ] The CHANGELOG `[Unreleased]` has `### Removed` (control socket, `certDir`, `allowUpstream`, `gate`, `run()` low-level options) and `### Changed` (`unsafeTestOnly`, `onEvent`, decisions written as `allow`/`deny`).
- [ ] `npm run typecheck` and `npm run check:primitives` are clean. Every new test was shown red, then green.
- [ ] The orchestrator runs the full suite 3 times in a real shell (0 fail, 0 skipped). The user commits, then runs `/self-review`. If that finds new must-fix items caused by this rework, redesign rather than patch.
