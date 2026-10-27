# Self-review round 1 brief: walker mounts, stale answers, unchecked scripts and docs (2026-10-27)

**Branch:** `m4-undo-layer` at `44e7099`, with a clean tree. Don't stage or commit.

**Source:** the `/self-review` of `044f607..44e7099`. Its findings are in `.claude/remember/fix-ledger.md`, dated `@ 44e7099`.

**Rules (unchanged):**
- A skipped test did not run. Your sandbox can't mount bwrap overlays: list every test it couldn't run, and the orchestrator runs them in a real shell.
- No test-only code paths in `src/`. Reuse before you add.
- Every new test: apply the listed mutation, show it red, revert, show it green. Paste the `# pass` / `# fail` lines.
- Never `git checkout` / `git restore` `src/` or `test/`. Back up to a scratch dir before fault isolation.
- The brief wins. Any deviation is named in the report with its reason.
- Leave no bwrap, socat or `node --test` processes running.

**Order and budget:**
- Items 1 and 2 are must-do: data loss, and an approval bypass.
- 3 and 4 are should-do.
- Finish one item completely before starting the next. If credit runs low, stop after a finished item and report.

**Each item closes its whole class**, not just the instance the review found. This is the second fix on the walker's mounts (6.6 added the node bind), so item 1 is a small redesign of the mount order, not a patch on one bind. If round 2 of the review finds a new must-fix caused by these fixes, the orchestrator stops and redesigns.

---

## 1. The walker's mounts have one order: host binds first, then the overlay (must)

**Bug:** `src/overlay.js:377-392` (`bwrapWalk`) adds `--ro-bind <nodePrefix> <nodePrefix>` **after** `--overlay … <merged>`. bwrap applies mounts in argument order. If node's prefix contains the runtime, the read-only bind lands on top of the overlay mount and hides it.
- The merged view lives in `<runtime>/overlay/<agent>/merged-*`.
- The walker then sees the bare mountpoint, so every file reads as deleted.

**Repro (reviewer's, real shell):**
1. Copy node to `<tmp>/nb/bin/node`, so the prefix `<tmp>/nb` contains `rt/` and `proj/`.
2. Run `run({ overlay: true })`, where the agent edits `a.txt` and adds `b.txt`.
3. `diffOverlay` returns `["deleted:a.txt"]`. Under system node it returns `["modified:a.txt","added:b.txt"]`.

Real-world case: node at `~/bin/node`, or nvm under `$HOME`, with the project and `SBX_RUNTIME` also under `$HOME`. `sbx commit` would then delete real files.

**The same class:** `--ro-bind <srcDir> <srcDir>` is also a host-path bind placed after the overlay. It shadows the overlay too whenever the runtime sits under barebox's `src/`.

**Fix (the design, stated once in a comment above the args):**
1. Build the args in two groups, in this order:
   - **a. host paths at their own paths, read-only:** `/usr` (+ the `/lib64` symlink), `srcDir`, and `nodePrefix` when node isn't under `/usr`.
   - **b. then everything the walk creates:** `--overlay-src … --overlay … <merged>`, `--bind <outDir> /sbx-out`, `--bind <stageDir> /sbx-new`.
   - Later mounts land on top of earlier ones, so nothing a host bind covers can hide the overlay or the output folders.
2. Keep binding node's prefix at its own path. Don't move it to a fixed path like `/sbx-node`: Linuxbrew's node carries an absolute interpreter and rpath under its prefix, and moving it breaks loading.
3. No refusal for odd prefixes. With this order, even a prefix of `/` is correct: it just exposes the host read-only to our own walker. Say that in the comment.

**Test** (`test/overlay.test.mjs`, needs bwrap; extend the 6.6 "node outside /usr" test or add one beside it):
- Make a tmp prefix `<tmp>/nb` and copy `process.execPath` to `<tmp>/nb/bin/node`.
- Create the runtime **and** the project inside `<tmp>/nb`.
- Prepare an overlay where `a.txt` is modified and `b.txt` is added.
- In a child running the copied node, call `diffOverlay` and assert exactly `modified a.txt` and `added b.txt`.
- Then `commitOverlay` in the same child. Assert the project has the new `a.txt` content and `b.txt`, and nothing was deleted.

**Mutation:** move the `nodePrefix` bind back after the overlay args. Both assertions must go red. Show it.

## 2. No answer outlives its queue (must)

**Bug:** `src/holds.js:390` assigns ids `h${++n}`, restarting at `h1` for every queue. `answers/` is never cleared when a queue starts, so a leftover `answers/h1.json` decides the next queue's `h1`.
- **Repro (reviewer's):** pre-create `answers/h1.json` with `{"decision":"allow"}` in a reused runtime. Start a queue and park `h1`. Within 700 ms you get `hold | decide:allow | FORWARDED`, so a request nobody reviewed goes out.
- **Reachable:** a proxy dies, or closes, after `sbx approve h1` passed its ask-file check but before the answer was consumed. Then `SBX_RUNTIME` is reused.

**Fix:**
1. On the file channel, the queue owns `asks/` and `answers/` for its runtime: one queue per runtime, which `sbx` already assumes.
   - At queue start, after creating the folders, delete every file in both. Log one `stale-answer` audit line per removed answer.
   - On `close()`, delete the asks it still has parked, so `sbx pending` can't list holds of a dead queue.
2. Keep `h<n>` ids (`sbx approve h1` stays easy to type; `HOLD_ID_RE` in `src/cli.js` doesn't change).
3. Document "one queue per runtime" once, in `createHolds`' JSDoc `@fails` or a header line. Regenerate `primitives.json` if its text changes.

**Tests** (`test/holds.test.mjs`):
- The repro above: a leftover `answers/h1.json` allow plus a new `h1` → the hold is **not** forwarded on it. It stays parked until a fresh answer, or denies at timeout. Assert the stale answer was logged as `stale-answer`.
- After `close()`, `asks/` holds no files from that queue.

**Mutation:** remove the clearing at start. The first test must go red.

## 3. `scripts/` is type-checked (should)

**Bug:**
- `scripts/bench.mjs:135` passes `allowLoopback: true` at the top level, but the rework moved it to `unsafeTestOnly.allowLoopback` (`src/proxy.js:288`).
- `npm run bench` now times out with "waiting for 20 holds to park", so the ≤80 MB proxy budget can't be checked.
- The class: `tsconfig.json` includes only `src/**/*.js`, so nothing checks a caller in `scripts/` against the API.

**Fix:**
1. Add `tsconfig.scripts.json`: `extends` `./tsconfig.json`, `noEmit: true`, `rootDir: "."`, and `include` `scripts/**/*.mjs` plus `src/**/*.js`.
   - Keep the main tsconfig's `rootDir: ./src`, which the declaration build needs.
   - `npm run typecheck` runs both: `tsc --noEmit && tsc -p tsconfig.scripts.json`.
2. Fix whatever it reports in `scripts/`, the bench's `allowLoopback` first. Type-only fixes (JSDoc) are fine there. Don't change script behaviour beyond the API fix.
3. Run `npm run bench` and paste its full summary: sandbox MB mean, proxy idle MB and proxy MB with 20 holds, against the 10 / 80 MB budgets.

**Proof:** put `allowLoopback: true` back at the top level of the bench's `createProxy` call, and `npm run typecheck` must fail, naming it. **If the type checker doesn't catch an excess property there**, say so with its output and stop this item after the bench fix plus the bench run. The orchestrator decides the fallback.

## 4. The packaged quickstart runs as written (should)

**Bug:**
- `barebox.context.md` ships in the npm tarball.
- Its quickstart (line 38) calls `createProxy({ port: 3129, certDir: "./certs", logFile: "./mitm.log" })`, which now throws "createProxy: runtime is required".
- Line 66 still describes `certDir`, `controlSocket` and `allowLoopback`.
- The class: nothing runs the doc's code.

**Fix:**
1. Update the doc to the current API:
   - The quickstart blocks use a temp runtime made with `mkdtempSync` and `port: 0`, so they run anywhere.
   - Line 66 describes what's true now: certificates live in `<runtime>/certs`, test-only options are under `unsafeTestOnly`, and there's no control socket.
   - Grep the whole doc for every name in the CHANGELOG's `### Removed` and fix each hit.
2. Add `test/context-doc.test.mjs`. It extracts every ```` ```js ```` block from `barebox.context.md`, writes each to a temp `.mjs`, and runs it with node.
   - The only rewrite allowed is the import specifier: `"barebox"` becomes the absolute path of `src/index.js`, unless package self-reference resolves `"barebox"` already (it has `exports`). If it does, change nothing.
   - Every block must exit 0 within a timeout.
   - The `launch` block needs bwrap and a listening agent socket. Make it self-contained: create the proxy and `addAgent` in the same block, the way a reader would actually run it. Or, if that makes the example worse to read, mark that block ```` ```js no-run ```` and have the test skip only blocks marked that way.
     - Report every block you mark, and why.
     - A `no-run` block is a deviation the orchestrator reviews.
3. Grep `README.md` for the same removed names. Fix any hit (the README isn't run by the test).

**Mutation:** put `certDir: "./certs"` back in the quickstart's `createProxy` call and drop `runtime`. The doc test must go red.

---

## Report back

- `wc -l` before and after for every changed file.
- Red/green lines for each new test, with the exact mutation.
- Item 3: the typecheck failure output from the mutation, and the full bench summary with the budgets.
- Item 4: every `no-run` block and why. The README grep output.
- `npm run typecheck` and `npm run check:primitives` output.
- Every test your sandbox couldn't run.
- Every deviation, and why.

## How the orchestrator will verify

1. In a real shell, rerun the item 1 repro (node copied into a prefix that holds the runtime and the project) through `sbx diff` and `sbx commit`, and the item 2 repro.
2. Apply each mutation in a scratch copy; each test must go red.
3. Run `npm run bench`: sandbox ≤10 MB, proxy ≤80 MB.
4. Run the full suite 3× in a real shell: 0 fail, 0 skipped, no hang.
5. You commit, then `/self-review` round 2.
