# M4 rework brief: clean up before M3 (2026-10-27)

> **For:** the build agent on branch `m4-undo-layer` (HEAD `82cb719`).
> **From:** two `/self-review` rounds (`dd14a16`, `82cb719`) and checks in a real shell (bwrap + unix sockets, nothing skipped).
> **Mandate:** rewrite whatever is needed. Rewriting from scratch is allowed and preferred over patching. The goal is a small, clean design that reviews stay able to verify, not a passing suite.
> **Status:** open. M3 does not start until section 1 and section 2 are done and reviewed.

## How to work this brief

1. Read the whole file before changing anything. Work in the order given: 0, then 1A–1F, then 2. Section 3 lists decisions that belong to the user; do not implement them.
2. **A test that was skipped did not run.** Your sandbox blocks bwrap and unix-socket bind, and it has a writable `/` and a different working directory. Three bugs already passed there and failed in a real shell (missing `--chdir`, mkdir before validation, a project under `$HOME`). Never report "green" from a run with skips. Say what was skipped, and the real-shell run (done by the orchestrator) is the proof.
3. **Show every new test red, then green.** Revert the fix, run the test, show it fails, restore the fix.
4. Commit only when the user says so. Stage by explicit path, never `git add -A`.
5. Report back with:
   - `wc -l` of every changed `src/` file, before and after
   - the list of deleted functions
   - the red/green proof for each test in 1E
   - anything you chose to do differently from this brief, and why

---

## 0. Ground rules (how the review will judge this)

- **One walker.** `walkLocal` is the only code that walks a tree: the project, the upper, and the merged view.
- **No shell programs in `overlay.js`.** No `sh -c`, `find`, `sha256sum` or `cp -a`, no hand-made quoting (`sq`, `escName`), and no parsing of mixed output (`MARKER`). Inside bwrap, run `/usr/bin/node` and return JSON on stdout. Checked: `/usr/bin/node` runs in a bare bwrap with only `/usr` bound.
- **One state record per operation.** Commit keeps a single journal of the steps it actually took, with one entry shape. Every report (applied, undone, not undone) is built from that journal. Nothing is inferred afterwards.
- **One sanitizer, one id validator, one definition per rule.** Reuse before adding. Grep before writing a new helper.
- **Delete, don't keep "just in case".** For every function that stays, you must be able to say what breaks without it.
- **Size target:** `src/overlay.js` is 1,052 lines today. Target 600 or fewer. If you go over, justify each extra part in the report.
- **Docs and comments describe the code as it is.** A comment or JSDoc that claims something the code doesn't do counts as a bug.

---

## 1. M4 rework: diff, commit, rollback (`src/overlay.js`, `src/cli.js`)

**Why rewrite and not patch:** two review rounds found commit bugs. The worst bug in round 2 was caused by the round-1 fix:
- A commit that fails partway permanently deletes a file. The agent runs `rm a_del; mkdir q; echo x>q/f; chmod 555 q`: the mode lands on `q` before `q/f` is written, `q/f` fails, and `a_del` can't be restored.
- Changing a file into a folder, or the reverse, can never be committed. Both directions fail, and the error messages are wrong.
- Rollback's list disagrees with `sbx diff`.
- Filenames chosen by the agent are printed raw, so escape codes in them reach your terminal.

The current commit tracks 9 backup kinds, falls back to in-memory copies when the backup is on a different filesystem, prechecks writability, and patches over the order. Replace all of that with the design below.

### 1A. Diff: walk the merged view with node inside the mount

1. Add one small entry file, for example `src/overlay-walk.js`. It imports `walkLocal`, walks the directory given in `argv`, and prints the Map as JSON. Bind `src/` read-only into the bwrap call at its own path, and run `/usr/bin/node <that file> <merged> <ignore-json>`.
2. Copy the changed regular files out in the same node process, into a staging folder bound read-write (1B says where it lives). Remove the "only the merged mount is visible on both sides" workaround (`extractToStage` and its shell loop). Bind the folder explicitly instead.
3. **Delete:** `sq`, `escName`, `findCmd`, `MARKER`, `BWRAP_PREFIX` (if it's no longer needed), `readMergedManifest`, `extractToStage`, and every truncated, malformed or inconsistent-output check that existed only to parse shell output.
4. If a filename isn't valid UTF-8, refuse loudly and name it, the same way fifos, sockets and devices are refused now. Never mangle it silently.
5. `computeChanges` and the conflict rule stay as they are: `conflict = (lower != base) && (merged != lower)`.

### 1B. Commit: stage, then swap by rename, with a journal

**Where:** one folder per commit inside the project, `<proj>/.sbx-commit-<pid>-<rand>/`, holding `new/` (staged content) and `old/` (originals moved aside). It's inside the project so every move is a `rename` on the same filesystem. That removes copies, the in-memory fallback and the different-filesystem error. The name prefix `.sbx-commit-` is reserved:
- `walkLocal` never lists it. Nothing commits, diffs or deletes it, except the commit that owns it.
- If one exists when `diffOverlay`, `commitOverlay` or `setupOverlay` starts, they refuse with an error that names its path. That is what a killed commit leaves behind.

**Phase 1: prepare. Nothing in the project changes in this phase.**
1. Diff, refuse conflicts (or skip them with `--skip-conflicts`), and refuse fifos, sockets, devices and non-UTF-8 names, all as today.
2. Copy the changed files out into `new/` (1A, step 2). Recreate staged symlinks in `new/`.
3. Re-fingerprint every path about to change (as `fpNow` does). If anything moved, stop with "project changed during commit; nothing was applied".

Any failure in phase 1 deletes the commit folder and reports "nothing was applied". In this phase that's true by construction.

**Phase 2: swap. Every step is one `rename`, `mkdir`, `rmdir` or `chmod`, each journaled before the next one runs.** In this order:
1. **Move aside.** Rename into `old/` every path that will be deleted or replaced, leaves first, deepest first. This covers deleted files and symlinks, replaced files and symlinks, and the old file in a file-to-folder change.
2. **Remove deleted folders**, deepest first, with `rmdir`. Journal each one with its mode so undo can recreate it.
   - If the folder still holds only ignored content (`node_modules`), `ENOTEMPTY` is not an error. Keep the folder; that's the Q3 rule.
   - If the folder is being replaced by a file, `ENOTEMPTY` is an error: `"<dir> holds ignored content; cannot replace it with a file"`.
3. **Create new folders**, shallowest first, with writable permissions.
4. **Move new content in.** Rename every staged file and symlink from `new/` to its destination.
5. **Apply permissions last**, deepest first: new folders, same-kind folder mode changes, and file modes with setuid/setgid stripped (`mode & 0o1777`). Journal each old mode. Doing permissions last is what fixes the `chmod 555 q` case.

**On any failure in phase 2:** undo the journal in reverse (rename back, `rmdir` what was created, `mkdir` what was removed, `chmod` back).
- If every step undoes: report `"nothing was applied"` and delete the commit folder.
- If an undo step fails: continue undoing the rest. Then throw an error that lists exactly the steps that couldn't be undone, and keep the commit folder, naming its path in the error. The originals are in `old/`.

**On success:** delete the commit folder, then empty the upper and work folders as today. With `--skip-conflicts`, the skipped paths stay on the upper as today.

**Type changes then work in both directions, because of the order:**
- File to folder: step 1 moves the file aside, step 3 creates the folder, step 4 moves its contents in.
- Folder to file: step 1 moves the children aside, step 2 removes the folder, step 4 moves the file in.

**Delete:** `StashRecord` and its 9 kinds, `stashForReplace`, `restoreCommitDest`, `commitFailed`, `removeExisting`, the `goneDirs` prefix check, `rmLowerRecursive`, `preflightCommitDests`, `writableAncestor`. Phase 1 has no side effects, so no precheck is needed: a parent folder that can't be written fails at step 1 and is undone.

### 1C. Rollback

1. Remove `<runtime>/overlay/<agent>/` completely. The overlay work folder can be mode 000, so fix permissions first (`chmodTree` exists), then remove it recursively. Delete the dead `rmdirSync(basedir)` and the comment claiming "the record dir vanishes when empty".
2. **Report:**
   - If the project exists and the overlay mounts: print exactly what `diffOverlay` returns, taken before removal, so rollback and diff can never disagree.
   - Otherwise: print `discarded <n> entries (project gone or no userns: exact list unavailable)` and the raw relative paths found in the upper. Don't infer added, modified or deleted. Delete `listUpper`'s status guessing.

### 1D. CLI output (`src/cli.js`)

1. **Sanitize every agent-controlled string when it's printed:** paths in `diff`, `committed`, `skipped`, `discarded` and `conflict:` lines, and in the overlay error messages that `sbx` prints. Put the call in the one function that prints a change, not at each call site.
2. **Extend `safe()` to strip bidirectional-text controls** (`‎‏‪-‮⁦-⁩`) as well. It stays the only sanitizer in `src/`.

### 1E. Tests (`test/overlay.test.mjs`)

Delete tests that only cover removed internals. Test behaviour, not implementation. Compare the project byte for byte (a recursive hash of content, modes and symlink targets) for every "unchanged" or "exact" claim. Each row must go red with its fix reverted.

| # | Case | Expected |
|---|---|---|
| 1 | `rm a_del; mkdir q; echo x>q/f; chmod 555 q` | commits; `q` is 555, `q/f` exists, `a_del` gone |
| 2 | case 1, plus a deleted file's parent made unwritable in the project before commit | fails; project byte-for-byte unchanged; error says nothing was applied |
| 3 | file `asfile` → folder `asfile/z` | commits |
| 4 | folder `asdir/y` → file `asdir` | commits |
| 5 | folder → file, where the folder holds `node_modules` | refuses with the ignored-content message; project unchanged |
| 6 | failure at phase 2 step 4 (a destination's parent made unwritable after phase 1) | undo exact: content, modes, symlinks, deleted files all back |
| 7 | an undo step fails | error lists the steps not undone; commit folder kept and named; `old/` holds the originals |
| 8 | commit folder left over from a killed commit | `diff`, `commit` and `run --overlay` refuse and name it |
| 9 | rollback, project present | output equals `diff` output; overlay folder gone |
| 10 | rollback, project gone | raw list; overlay folder gone; the next run is allowed |
| 11 | filename `x\r\e[2K\e[1Aevil`, and one containing U+202E | `sbx diff/commit/rollback` print neither the control bytes nor the bidi controls |
| 12 | filename that isn't valid UTF-8 | refused loudly, named |
| 13 | project under `$HOME` (existing test) | still passes; keep it |

For cases 6 and 7, inject the failure with filesystem permissions (`chmod`), not with a hook in `src/`. If a case truly can't be produced that way, say so. Don't add a test-only code path.

### 1F. Comments, JSDoc, docs

- **`overlay.js` header comment:** rewrite it for this design. Remove the claims about rollback listing the upper, "all-or-nothing", the shell walk, and visibility only through the merged mount.
- **`commitOverlay` and `rollbackOverlay` JSDoc and `primitives.json`:** state the real guarantee:
  - Commit applies everything or undoes it.
  - If the undo fails, it says so, names what's left, and names where the originals are.
  - A killed commit leaves a folder that blocks the next operation until it's removed.
- **CHANGELOG `[Unreleased]`:** update the M4 line to match. Never list unreleased bugs under "Fixed".

---

## 2. Older issues worth fixing now (verified in `82cb719`)

These are from M0–M2.5, from the fix ledger (`.claude/remember/fix-ledger.md`), and I checked each one against the current code. Only the ones that matter before M3 are listed. Each fix is small, and none needs a redesign.

### 2.1 Correctness and security

1. **The dial uses only the first resolved IP, with no fallback** (`src/proxy.js:195`, `return { ok: true, ip: ips[0] };`).
   - Failure: `localhost` resolves to `::1` first, so with an upstream on 127.0.0.1 the request gets `502 ECONNREFUSED ::1`. A dual-stack host whose first address is unreachable fails where curl would fall back.
   - Fix: check every resolved address against the wall (already done), then try them in order, IPv4 and IPv6 interleaved, with a short connect timeout each. All pinned, none re-resolved. Test: an upstream on 127.0.0.1 reached as `localhost` with `allowLoopback`.
2. **`proxyPort` is pasted into a shell command** (`src/launcher.js:209`, `` `socat TCP-LISTEN:${door},bind=127.0.0.1,...` ``).
   - Failure: `launch({ proxyPort: '3128;touch /tmp/x' })` runs `touch` inside the sandbox's start-up script.
   - Fix: validate that `proxyPort` is an integer from 1 to 65535 at the top of `launch()`, and throw otherwise. Test with a string and with `0`.
3. **Secrets in other headers are logged in plain text** (`src/proxy.js:39`, `const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization']);`).
   - Failure: `Cookie: session=…` and `X-Api-Key: …` land in the audit log verbatim.
   - Fix: add `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` and `api-key`. This is interim: M3 replaces it with bareguard's `secrets` redaction, so add no other machinery.
4. **An existing audit log keeps its old permissions** (`src/proxy.js:363`, `fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 })`).
   - Failure: `mode` applies only when the file is created, so a 0644 log from an older run stays world-readable while new lines are appended.
   - Fix: `fs.chmodSync(logFile, 0o600)` right after opening, plus a test that pre-creates the log as 0644.

### 2.2 Duplication (one definition per rule)

5. **`HOST_RE` is defined twice** (`src/proxy.js:25` and `src/certs.js:10`). Keep one, and import it in the other file.
6. **`matchPath` duplicates the inline default in `createHolds`** (`src/holds.js:211` and `:453`). Make the default call `matchPath(match)`.
7. **The runtime has two masks, one redundant** (`src/launcher.js:162`, `if (inside(hm) || inside(pr)) args.push('--tmpfs', rt);`). The real-path mask already covers it: a mutation test showed that deleting this line leaves the launcher tests green. Delete it. The real-path mask stays, and its tests go red without it.
8. **A nested try/catch wraps a single callback** (`src/proxy.js:458`). Simplify it to one guarded call.

### 2.3 Leave until M3 (don't touch)

- **`mappedV4` handles only the dotted IPv6-mapped form, so the hex form `::ffff:7f00:1` passes** (`src/proxy.js:81`). M3 reuses bareguard's `isPrivateIp`, which already decodes the hex form. Replace it then, and file F4 (NAT64/6to4 coverage) upstream first.
- **The ask body preview isn't redacted, although the PRD says it is.** Ask files are now 0600. Redaction arrives with bareguard's `secrets` in M3. The PRD already marks it as not done.
- **IPv6 literal CONNECT returns 400; there are bench sampling and bridge test races.** These are low impact. They stay in the ledger for `/refactor`.

---

## 3. Decisions for the user (do not implement)

- **`--new-session` for bwrap** (`src/launcher.js`). Without it, the agent shares the launcher's controlling terminal. On kernels with `dev.tty.legacy_tiocsti=1`, an agent could inject keystrokes into the terminal where you type `sbx approve`. This host has it set to 0, so it isn't reproduced here. Adding `--new-session` closes that, but it detaches the terminal, which breaks interactive TUI agents run directly under `sbx run`. Options:
  - always add it
  - add it only when stdin isn't a TTY
  - leave it and document the kernel setting

---

## 4. Design notes for the next modules (for scoping M3 and later)

These are for the user's scoping session, not for this rework.

- **Prove in the real environment before claiming done.** Every module's "done when" names the shell it ran in. A skip counts as not run. CI already runs bwrap; keep it that way.
- **Write the riskiest case as the first test.** In M4 that would have been a project under `$HOME`, a failure mid-commit, and a file-to-folder change. All of these were found by review, not by the module's own tests.
- **Prefer one mechanism over a case analysis.** The commit grew 9 backup kinds because each case was patched as it was found. A single journal of renames covers all of them. Apply the same test in M3: if the gate needs a growing switch statement, the model is wrong.
- **M3 should add as little as possible.** bareguard owns policy, redaction and private-IP checks, and rwxmap owns labels. barebox keeps transport only. F1 and F2 upstream come before M3's `auto`/`ask` modes, per the PRD.

---

## Done when

- [ ] 1A–1F are implemented. `src/overlay.js` is 600 lines or fewer, or each extra part is justified. The deleted-function list is reported.
- [ ] Section 2.1 items 1–4 and 2.2 items 5–8 are done, each with a test where the item names one.
- [ ] `npm run typecheck` and `npm run check:primitives` are clean.
- [ ] Every new test was shown red with its fix reverted, then green.
- [ ] The orchestrator runs the full suite 3 times in a real shell: 0 failures, 0 skipped.
- [ ] The user commits. Then `/self-review` runs on the commit. If it finds new must-fix items caused by this rework, stop and redesign; don't patch.
