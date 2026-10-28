# Test-hygiene brief: one bwrap probe, one misplaced doc block (2026-10-28)

**For:** the build agent. **Branch:** `hardening`. Other uncommitted work is in the tree (`src/holds.js`,
`test/holds.test.mjs`, and the orchestrator's `src/proxy.js` / `test/proxy.test.mjs`). **Don't
touch those four files**, and don't stage or commit. Same nine rules as
`docs/logs/hardening-brief.md`. Skip step 0. Two small items, both from the ledger.

## T1 (should): one bwrap probe that checks bwrap is usable, not a hardcoded path

**Today:** five places decide "is bwrap here?" by a hardcoded `/usr/bin/bwrap`:
- `test/overlay.test.mjs:40`: `const BWRAP_OK = existsSync('/usr/bin/bwrap');`
- `test/launcher.test.mjs:20`: `NEED_SANDBOX = !existsSync('/usr/bin/bwrap') ? …`
- `test/e2e.test.mjs:42-43`: `existsSync('/usr/bin/bwrap')`, twice
- `test/run.test.mjs:37-38`: `existsSync('/usr/bin/bwrap')`, twice
- `scripts/bench.mjs:114`: `readdirSync('/usr/bin').includes('bwrap')`

`hasBin` is copy-pasted three times: `test/e2e.test.mjs:37`, `test/run.test.mjs:32`,
`scripts/bench.mjs:47`.

**Failure:** bwrap installed at `/usr/local/bin` (a source build's default prefix) makes every
bwrap test skip on a dev box. That's what produced the hollow-green CI run before v0.3.0. CI now
fails on any skip, but a local `npm test` still reports green with all the bwrap tests skipped.

**Fix:** one helper, `bwrapUsable()` in a new `test/fixtures/probes.mjs`. It runs
`spawnSync('bwrap', ['--version'], { stdio: 'ignore' })` (PATH lookup, so any prefix works) and
returns `true` when `status === 0`. Use it in all four test files, keeping each file's skip-message
text. For `scripts/bench.mjs`, import the same helper (`../test/fixtures/probes.mjs`) so there's
one probe, and keep its SKIP/exit-77 behaviour. Reuse first: move `hasBin` into `probes.mjs`
(read the three copies; if they differ, keep the strictest and say how they differed), use it for
socat and curl everywhere, and delete the three copies.

**Proof:** no behaviour test can go red for a probe, so prove it two ways and paste both:
- in your sandbox, `node -e` the helper. It should be true if `bwrap --version` works there; say
  what it printed.
- a scratch PATH with a fake `bwrap` (`#!/bin/sh\necho bubblewrap 0.12.0`) and no `/usr/bin/bwrap`
  dependency: the helper returns true; with an empty PATH it returns false. Write this as a test in
  `test/probes.test.mjs` (no sockets, so it runs in your sandbox).

## T2 (nit, behaviour-neutral): runChild's doc block sits above the wrong function

`test/runtime.test.mjs:15-24`: the `/** Run a script in a child node process … @param timeoutMs …
@returns {Promise<…>} */` block describes `runChild`, but `spawnChild` was later inserted between
the block and `runChild`. Move the block down to sit directly above `function runChild`, and give
`spawnChild` its own one-line JSDoc above it (rule 6: doc comments stay with their function). No
code change; `npm run typecheck` must stay clean.

## Done when

- [ ] T1: `test/fixtures/probes.mjs` (file:line); every hardcoded `/usr/bin/bwrap` probe gone
      (`grep -rn "/usr/bin/bwrap\|readdirSync('/usr/bin')" test scripts` shows none, apart from
      comments you name). The three `hasBin` copies merged into one. `test/probes.test.mjs`
      green here.
- [ ] T2: the block moved; typecheck clean.
- [ ] `npm test` totals, with every failing or skipped test listed with its error. Expect your
      sandbox's bwrap tests to move from **skip** to **fail** (netlink is blocked) if
      `bwrap --version` works there. That's correct; list them.
- [ ] `git status`: only `test/fixtures/probes.mjs`, `test/probes.test.mjs`, the four test files,
      `scripts/bench.mjs`, and this brief, plus the four files above that aren't yours.
- [ ] No processes left; scratch removed.

**Report format:** T1, T2, the rule-2 list, then this checklist.
