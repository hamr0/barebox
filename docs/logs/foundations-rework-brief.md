# Foundations rework brief: M0–M2.5 core (2026-10-27)

> **For:** the build agent, after the M4 rework (`docs/logs/m4-rework-brief.md`) is committed and its `/self-review` has no must-fix items left.
> **Scope:** `src/proxy.js`, `src/holds.js`, `src/run.js`, `src/cli.js`, `src/launcher.js` and `src/certs.js`, plus their tests. `src/overlay.js` only where a shared helper moves (section 1).
> **From:** a design read of every line of those files, as they stood with the M4 rework uncommitted (suite 188/188, 0 skipped, in a real shell).
> **Mandate:** clean, simple foundations before M3 builds on them. Rewriting a file from scratch is allowed. Behaviour that the tests pin stays; structure, API surface and duplication are fair game. barebox is pre-1.0 with no known users, so breaking the 0.2.0 API is fine: record it in the CHANGELOG.

## How to work this brief

The working rules from the M4 brief still apply:
- A skipped test did not run.
- Show every new test red, then green.
- Stage by explicit path; commit only when the user says so.
- Report `wc -l` before and after for every `src/` file, plus the list of deleted functions and options.

**Order:** sections 1, 2, 3 and 4 depend on each other in that order. Section 5 is independent. Run the full suite after each section, not only at the end.

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

## Out of scope

- **Audit line shape (`phase`/`decision`/`rule`/`run_id`/`agent`/`ts`), redaction via bareguard `secrets`, and replacing `mappedV4` with `isPrivateIp`.** These are M3 (PRD M2.5 item 6, deferred). Section 4.1 only puts the wall in one file, so M3 has one place to change.
- **Ledger items in `/refactor`'s queue:** IPv6 literal CONNECT, the bench sampling race, the bridge test race.
- **The socat bridge script in `launch()`.** It's the only shell left in the launcher, and `proxyPort` is now validated. It isn't worth replacing before M6 measures it.

## Done when

- [ ] Sections 1–5 are done. `wc -l` before and after for every `src/` file, plus the lists of deleted functions and removed options, are in the report.
- [ ] The section 1 grep check passes. `launcher.js` doesn't import `proxy.js`.
- [ ] No `process.stdout`/`process.stderr` writes remain in `src/` outside `cli.js` and `run.js`'s stream defaults.
- [ ] The audit log writes exactly one `deny` line per failed upstream (test).
- [ ] The CHANGELOG `[Unreleased]` has `### Removed` (control socket, `certDir`, `allowUpstream`, `gate`, `run()` low-level options) and `### Changed` (`unsafeTestOnly`, `onEvent`, decisions written as `allow`/`deny`).
- [ ] `npm run typecheck` and `npm run check:primitives` are clean. Every new test was shown red, then green.
- [ ] The orchestrator runs the full suite 3 times in a real shell (0 fail, 0 skipped). The user commits, then runs `/self-review`. If that finds new must-fix items caused by this rework, redesign rather than patch.
