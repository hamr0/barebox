# Ledger brief for 0.6.0: env lockdown, loadLabels export, held-body cap test (2026-10-30)

Three items from the fix ledger, validated on main at v0.5.0 (2c777a2). Each was reproduced in a real shell. Build them on a branch cut from main, one commit per item. Workers write all code and tests; every required test is shown red on the current code, then green.

## 1. The host environment must not change the policy (security)

**Problem.** `src/policy.js` `gateFor` builds the gate with `rwx: { agent, agents: { [agent]: letters }, tools, askUnheld }` (line 129) and no `budget`. bareguard then reads two environment variables of the proxy process:

- `BAREGUARD_RWX_LETTERS` (`node_modules/bareguard/src/primitives/rwx.js:238`, `rwxCfg.letters ?? envLetters`) replaces the mode's letters. Reproduced: `--mode ask` with `BAREGUARD_RWX_LETTERS=rwx` allows a POST with no ask (`allow rwx.allow`, 0 asks; unset: `deny rwx.ask`, 1 ask). `trust` with `bogus` denies everything (`rwx.invalid`).
- `BAREGUARD_BUDGET_FILE` (`node_modules/bareguard/src/gate.js:697`, `config.budget?.sharedFile ?? process.env.BAREGUARD_BUDGET_FILE ?? null`) attaches a shared budget file. Reproduced: a version-2 file with `spent_usd: 5, cap_usd: 1` makes a plain GET in `trust` mode `deny budget.maxCostUsd`. A file without a supported `version` makes `gateFor` throw `BudgetUnavailableError`. bareguard also writes to the named file.

The sandboxed agent cannot set these, since they are the host's environment. A user shell, or a parent bareguard process that exports them, silently changes or breaks the mode.

`BAREGUARD_SPAWN_DEPTH`, `BAREGUARD_PARENT_RUN_ID` and `BAREGUARD_ROOT_RUN_ID` change only audit fields (`spawn_depth`, `parent_run_id`); barebox makes no spawn actions and sets no `maxDepth`. Out of scope. `BAREGUARD_AUDIT_PATH` is already overridden by the explicit `audit.path`.

**Change.** In `gateFor`: pass the letters explicitly, `rwx: { agent, letters, tools, askUnheld }`, and add `budget: { sharedFile: '' }`. `''` is deliberate: bareguard's `??` treats only `null`/`undefined` as absent, so `''` stops the env fallback while staying falsy (no file). Before building, check in `node_modules/bareguard/src/gate.js` and `primitives/budget.js` that a `''` `sharedFile` really means "no shared file" and is not opened as a path; if it is, stop and report instead of choosing another value. Check that nothing else in barebox reads `rwx.agents` (`git grep -n "agents:" src`).

**Tests (in `test/policy-content.test.mjs`, env restored in `finally`):**
- `BAREGUARD_RWX_LETTERS=rwx`, `gateFor({ mode: 'ask' })`, POST: `deny`, rule `rwx.ask`, exactly 1 human-channel call. Red today.
- `BAREGUARD_RWX_LETTERS=bogus`, `gateFor({ mode: 'trust' })`, POST: `allow`. Red today.
- `BAREGUARD_BUDGET_FILE` naming a version-2 file with spent over cap, `trust`, GET: `allow`, and the file is unchanged byte for byte afterwards. Red today.
- `BAREGUARD_BUDGET_FILE` naming a file with no `version`: `gateFor` resolves (does not throw). Red today.

**Docs.** CHANGELOG `[Unreleased]` under Security: the mode no longer changes with `BAREGUARD_RWX_LETTERS` or `BAREGUARD_BUDGET_FILE` in the host environment. Remove the `BAREGUARD_RWX_LETTERS` line from the PRD's known gaps if it was added there; the 0.5.0 CHANGELOG entry stays as history.

## 2. Export `loadLabels` (API)

**Problem.** `run()` and `createProxy()` take `labels: { matcher, tools, dirs }`, documented as "what `loadLabels` returns" (`src/run.js:65`, `:87`), but `src/index.js` exports only `launch`, `createProxy`, `run` and the three overlay functions. `import('barebox/src/labels.js')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so an embedder cannot build the `labels` value. Only the `sbx` CLI can use labels today.

**Change.** Export `loadLabels` from `src/index.js`, give it the `@when` / `@fails` / `@example` tags the other exports carry, and run `npm run build:primitives` so `primitives.json` lists it. `buildTools`, `toolFor` and `emptyMatcher` stay internal; `loadLabels` is the one an embedder needs. Add it to `barebox.context.md` where `labels` is described.

**Tests.** `test/primitives-completeness.test.mjs` already checks every barrel export with `@when` is in `primitives.json`; add a test that `(await import('barebox')).loadLabels` is a function and returns `{ matcher, tools, dirs }` for a one-file label folder (reuse `test/fixtures/jira-mini.json`). Red today (not exported). `npm run check:primitives` must pass.

## 3. Prove the `heldBodyMaxMB` setting takes effect (test only)

**Problem.** `heldBodyMaxMB` is a documented config key (`src/cli.js:215` turns it into `heldBodyMaxBytes`; `src/run.js:142` passes it as `hold.maxBody`). Two mutations, `* 1048576` → `* 1` in `cli.js` and `maxBody: heldBodyMaxBytes` → `maxBody: undefined` in `run.js`, leave the whole suite green. The key could stop working with no test noticing.

**Change.** Tests only, no source change.

**Tests:**
- `test/run.test.mjs`: `run()` with `heldBodyMaxBytes: 16` and an asking gate; a held POST with a 64-byte body gets `403` and `body too large to hold`. Red under the `run.js` mutation.
- `test/cli.test.mjs`: `sbx run` with `XDG_CONFIG_HOME` pointing at a config file `{"heldBodyMaxMB":1}`, a held POST with a 2 MB body gets the same 403. Red under the `cli.js` mutation. Set `XDG_CONFIG_HOME` explicitly (CI sets it; see c669404).

Both need bwrap and unix sockets: they must run in a real shell, not the agent sandbox.

## Verification (orchestrator, real shell)

- Each required test shown red on main's code, then green, with the command and output.
- Full suite `npm test` three times, 0 fail 0 skip, once with `XDG_CONFIG_HOME=$HOME/.config` set as CI does.
- `npm run typecheck` and `npm run check:primitives` exit 0.
- Re-run the env repro (`gateFor` under `BAREGUARD_RWX_LETTERS=rwx` and an over-cap `BAREGUARD_BUDGET_FILE`) against the built branch: the mode wins.
- Fresh-project install of the packed tarball: `import { loadLabels } from 'barebox'` works.

## Out of scope

The other ledger items (IPv6 CONNECT and SIIT spelling, bench limits, overlay walk cost, audit rotation, the slow-drip body slot, the two timing-sensitive tests) stay in the ledger for later.
