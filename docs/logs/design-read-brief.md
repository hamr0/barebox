# Design-read brief: proxy §4 debt, outcomes for abandoned holds, locked paths (2026-10-27)

**Branch:** `m4-undo-layer`, **on top of the committed runtime-claim work** (`docs/logs/runtime-claim-brief.md`). Start only after the orchestrator has verified and the user has committed it. The tree must be clean when you start. Don't stage or commit.

**Source:** the orchestrator's full design read of `holds.js`, `proxy.js`, `run.js` and `launcher.js` at `2491f61`. Three items, all real gaps against what was asked. The body-seam question found in the same read is recorded as PRD open question 10 for M3. **Not in scope here.**

**Rules (unchanged):**
- A skipped test did not run. List every test your sandbox couldn't run; the orchestrator runs them in a real shell.
- No test-only code paths in `src/`. Reuse before you add.
- Every new test: apply the listed mutation, show it red, revert, show it green. Paste the `# pass` / `# fail` lines.
- Never `git checkout` / `git restore` `src/` or `test/`. Back up to a scratch dir before fault isolation.
- The brief wins. Any deviation is named in the report with its reason.
- Leave no bwrap, socat or `node --test` processes running.

**Order:** item 3 is done. Then item 4 (claim races), item 1, item 2. Finish each one completely before the next. If credit runs short, stop after a finished item and report.

---

## 1. Foundations §4, never delivered: the wall in one file, one error writer, one deny line (must)

`docs/logs/foundations-rework-brief.md` §4 was in scope for the foundations rework. **None of it landed, and the report didn't mention it.** Do it now, as written there, with these specifics:

1. **Move the upstream wall into `src/wall.js`:**
   - Move `normIp`, `mappedV4`, `v4Parts`, `localIps`, `denyReasonForIp`, `resolveAllUpstream`, `interleaveIps` and `checkUpstream`, plus the wall's header comment.
   - Export only what `proxy.js` and the tests use: `checkUpstream` and `denyReasonForIp`.
   - `proxy.js` imports them. Tests that import `denyReasonForIp` from `proxy.js` change to `wall.js`.
   - This is a pure move: don't change any behaviour. M3 swaps the private-IP part for bareguard's `isPrivateIp` in this one file.
2. **One response writer.** `denyRes(cres, code, note)` is the only place a proxied HTTP error is logged and written.
   - `fail` in `forwardInner` becomes a call to `denyRes`, guarded by its own `done` flag. Delete its copy of the write code.
   - `denyRaw` stays only for pre-HTTP raw sockets (the CONNECT line, an oversized request head, a walled CONNECT, a cert failure), and logs the same way.
3. **The double log.** `forward()`'s `catch` (`proxy.js:367-368`) calls `log({ ev: 'deny' … })` and then `denyRes`, which logs again. Delete the explicit `log` line.
   - **Test** (`test/proxy.test.mjs`): count the `"ev":"deny"` lines in the audit log for one failed upstream; it must be exactly 1.
     - Cover the `fail` path: an upstream that refuses the connection. Use a free port with nothing listening, under `unsafeTestOnly.allowLoopback`.
     - Cover the `catch` path too, if you can make `forwardInner` throw synchronously from outside (for example, a request shape `http.request` rejects synchronously). If no input reaches that `catch`, say so and name what you tried. Keep the `catch` anyway, with its single `denyRes`: "a throw before it can answer must still be loud".
   - **Mutation:** put the extra `log` line back, or make `fail` log before calling `denyRes`. The count test goes red on the path it covers.
4. **Report `wc -l src/proxy.js` before and after.** There's no size target. The test is whether a reader can find "where is a request decided" and "where is an error answered" in one place each.

## 2. Every hold's outcome is reported, abandoned ones included (must)

**Gap:** `abandon()` (`src/holds.js`, the client went away while held) logs `hold-abandoned` and calls `onDeny`, but emits **no** `onEvent`. So:
- `run()`'s `asks` keeps that ask with no `decision` forever (`run.js` `recordEvent` only fills one on `decided`);
- `sbx run --json` never prints any outcome at all. `cliRun` forwards only `type: 'ask'` events, so a JSON consumer sees asks but never learns how any of them ended.

Foundations §2.4's "outcomes are reported, never reconstructed" is only half done.

**Fix:**
1. `abandon()` emits `onEvent({ type: 'decided', id, decision: 'deny', reason: 'client gone' })` after its log line. Keep one event shape, `decided`, with no new event type.
2. `holds.close()`:
   - `settle()` already removes each ask file, so the extra `unlinkSync` loop over `parked` is dead. Delete it, along with the `parked` variable.
   - If the runtime-claim work changed `close()`, apply the same rule: one removal per ask file, in `settle`/`abandon` only.
3. `sbx run` prints outcomes from the same events, through `out()` (sanitized):
   - human mode: `decided <id> <allow|deny>` plus ` (<reason>)` when there's a reason;
   - `--json`: `{"ev":"decided","id":…,"decision":…,"reason":…}`, with the values sanitized before `JSON.stringify` exactly as `emitAsk` does.
   - Reuse `emitAsk`'s sanitizing: extract one helper if both need it. Don't copy it.
4. Update the `OnEvent` / `HoldEvent` JSDoc, and the `cli.js` header comment that describes the `--json` stream. Record the new `decided` line in the CHANGELOG `[Unreleased]` under `### Changed`, `sbx run` output.

**Tests:**
- `test/holds.test.mjs`: park a hold, abandon it. `onEvent` receives `decided` / `deny` / `client gone` exactly once, and `asks/` no longer has its file.
- `test/run.test.mjs` (or wherever `run()`'s `asks` is tested): a held request whose client disconnects ends with `decision: 'deny'`, `reason: 'client gone'` in `asks`.
- `test/cli.test.mjs` (needs bwrap): `sbx run --json --mode ask` with one held request that's denied prints an `ask` line, then a `decided` line for the same id, then `done`.
- **Mutations:**
  - Drop the `onEvent` call in `abandon()`, and the holds and run tests go red.
  - Drop the `decided` printing in `cliRun`, and the CLI test goes red.

## 3. Locked paths cover the common credential stores (must, security)

**Gap:** `LOCKED_PATHS` (`src/launcher.js:12`) masks only `.ssh`, `secrets`, `.mozilla`, `.config/chromium` and `.gnupg`, while the PRD promises "password stores" too (section 2, Locked drawers).
- Everything else in `$HOME` is readable inside the sandbox.
- `auto` mode forwards every GET, so an agent can read `~/.aws/credentials` and send it out in a query string with no ask.
- The user decided (Oct 27): expand the list now (PRD: "more later without changing the walls"). An allow-list `$HOME` is a later M5 question.

**Fix:**
1. Split the list into **directories** (masked with `--tmpfs`, as today) and **files**. bwrap can't mount a tmpfs on a file, so files are masked with `--ro-bind /dev/null <path>`. One `LOCKED_PATHS` table of `{ path, kind: 'dir' | 'file' }`; the loop picks the flag. **No second list.**
2. The set (relative to `$HOME`):
   - **Directories:** `.ssh`, `secrets`, `.gnupg`, `.password-store`, `.local/share/keyrings`, `.mozilla`, `.config/chromium`, `.config/google-chrome`, `.config/BraveSoftware`, `.aws`, `.azure`, `.config/gcloud`, `.kube`, `.docker`, `.config/gh`, `.config/op`.
   - **Files:** `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.cargo/credentials.toml`.
   - **Deliberately not masked:** `~/.claude` and `~/.claude.json`, `~/.config/anthropic` and similar. A sandboxed coding agent needs its own model credentials to run at all; M5 (keys the agent never holds) is where those move out. Say this in a comment beside the list, so nobody adds them without that decision.
3. Mask **only what exists**, as today: `existsSync` before adding the flag, and pick the flag from the real kind (`lstatSync`). If a listed "file" is actually a directory, or the reverse, use the flag for what's really there.
4. **Symlinks:** if a listed path is a symlink (dotfile managers do this), also mask its real target when that target is under `$HOME` and outside the project. Otherwise the content is readable at the target. Use `realPathOf` from `runtime.js`. Don't add a resolver.
5. Ordering is unchanged: the masks go after the home and project mounts, which the existing comment explains.
6. Update the launcher JSDoc's `@when` / `@fails` if they mention locked paths, regenerate `primitives.json`, and update `barebox.context.md` and README if they list the locked paths (grep for `.gnupg`).

**Tests** (`test/launcher.test.mjs`, needs bwrap):
- Build a fake `$HOME` in tmpdir (set `process.env.HOME` for the call and restore it in `finally`) holding:
  - one masked directory with a file inside (`.aws/credentials`);
  - one masked file (`.netrc`);
  - one symlinked masked file (`.npmrc` → `dotfiles/npmrc` inside the fake home);
  - one unmasked control file (`notes.txt`).
- Inside the sandbox:
  - `.aws` is empty;
  - `.netrc` reads as empty;
  - both `.npmrc` and `dotfiles/npmrc` read as empty;
  - `notes.txt` reads its content.
- **Mutations:**
  - Use `--tmpfs` for the file entries: launch fails, or the test goes red. Show which.
  - Drop the symlink-target mask, and the `dotfiles/npmrc` assertion goes red.

## 4. `claimRuntime` startup races (must; added after the runtime claim landed)

**Status:** item 3 is done and merged (`f2ecebb`, via `ebe984d`). Items 1, 2 and 4 remain.

`claimRuntime` (`src/runtime.js`) is the single enforcer of "one proxy per runtime". Two narrow races let two proxies start on one runtime when they start within microseconds of each other:
1. **The claim file is briefly empty.**
   - `writeMine` does `openSync(owner, 'wx')`, then writes the JSON.
   - A second starter reading in that gap gets `readClaim() === null`, treats the claim as garbage, takes it over, and both proceed.
   - **Fix:** write the claim to a temp file in the runtime first, then `fs.linkSync(tmp, owner)`. That atomically creates `owner` with its full content, or fails with `EEXIST`. Remove the temp file in `finally`. `owner` then can never be seen empty.
   - Keep treating a truly garbage or empty file as stale. Once `owner` can only be created whole, an unreadable one is leftover debris.
2. **Takeover steals a fresh claim.**
   - Two starters both judge the same dead owner stale.
   - A renames it away and links its own claim.
   - B's `renameSync(owner, stale)` then moves **A's fresh claim** away, and B links its own. Both proceed.
   - **Fix:** after renaming `owner` to the stale name, read the renamed file and compare it with the claim judged stale (same pid and start, or both unreadable).
     - **If it differs,** someone else's fresh claim was moved. Rename it back (`fs.linkSync(stale, owner)`, which fails if a third claim landed meanwhile), then throw the in-use error naming that pid.
     - **If it matches,** delete it and link our own claim.

**Tests** (`test/runtime.test.mjs`). They exercise the decision logic. Don't try to win real scheduling races, and don't add sleeps.
- A claim never leaves an empty `owner`: after a successful claim, the file parses with our pid and start time, and no temp file is left in the runtime.
- Takeover refuses a fresh claim. Plant a dead owner, then simulate "another process won the takeover" by replacing `owner` with a live claim (`process.pid` with the real start time).
  - Exercise this through a small internal step function that takes the judged-stale content as an argument. Export it from `runtime.js` for the test, the way `changedSince` is exported from `overlay.js`.
  - That function must restore the live claim and throw `in use by pid`.
- **Mutations:**
  - Back to `openSync(owner, 'wx')` + write. The test asserting no `wx`-then-write gap can't observe a microsecond gap, so instead assert that the claim is created via `link` (no partially written owner on an injected write failure). Make the write throw, for example by passing an unserializable claim through the same step function, and `owner` must not exist afterwards.
  - Drop the post-rename comparison, and the fresh-claim test goes red.

Also, two stale doc rows from item 3: `docs/product/agent-sandbox-prd.md:266` (the decision row "Locked paths (M0)") and `docs/product/agent-sandbox.md:172` still list the old 5 paths. Update both to "21 credential stores; see `LOCKED_PATHS` in `src/launcher.js`", and say `~/.claude` stays readable until M5.

---

## Report back

- `wc -l` before and after for every changed `src/` file.
- Item 1: the list of moved functions, and whether the `catch` path was reachable (with what you tried).
- Red/green lines for each new test, with the exact mutation.
- `npm run typecheck` and `npm run check:primitives` output.
- Every test your sandbox couldn't run.
- Every deviation, and why.

## How the orchestrator will verify

1. In a real shell:
   - Run an agent under a fake `$HOME` that tries to `cat` every listed credential path. Each one is empty.
   - Through `sbx run --json --mode ask`, one denied hold prints a `decided` line, and one abandoned hold (the client is killed) gives `deny` / `client gone`.
   - One failed upstream writes exactly one deny line.
2. Apply each mutation in a scratch copy; each test must go red.
3. Grep: `wall.js` holds every wall function, and `proxy.js` defines none of them.
4. Run the full suite 3× (0 fail, 0 skipped, no hang), plus `npm run bench` within budget.
5. You commit, then `/self-review`.
