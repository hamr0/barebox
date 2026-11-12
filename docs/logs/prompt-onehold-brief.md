# Brief: the prompt owns one hold from question to verdict; hold timeout defaults by terminal (2026-11-12)

Worker: code-developer (Sonnet). Branch `fix/prompt-verdict` (clean, HEAD cac3b2c). Do **not** commit. Two parts, done in order; the orchestrator commits them separately, so keep Part A's edits to `src/prompt.js` and `test/prompt.test.mjs` (plus `test/cli-prompt.test.mjs` only if Part A needs it) and put every doc/CHANGELOG edit in Part B.
Rules: `.claude/remember/AGENT_RULES.md`. Every new or changed test is shown **red** (old code or the mutation named) then **green**; paste both. Mutations only in a fresh full scratch copy, never in the repo tree. Do not run the full suite. `grep` may be a wrapper: use `/usr/bin/grep -a`. Do not touch `.claude/` (show `find .claude/remember -maxdepth 1 -type f -exec md5sum {} + | sort -k2` before and after).
If a fact is wrong or the design does not fit, stop and report with options.

## Why (user, 2026-11-12)

Four commits on the same spot (041e892, 06e986b, d14cc0a, cac3b2c) each led to the next finding; the user chose a redesign around one rule instead of a fifth patch. Open findings it removes:
1. After `✗ not sent` the question is closed (`open = null` before the write, `src/prompt.js:108`), so a retry `y` is dropped and the user is not told what to do (self-review of cac3b2c, probe: answer called once).
2. While a `→ sent ` line is open, `open` is null, so `ask()` accepts a second hold and prints it into the open line (probe: `→ sent ⏸  a wants t...`). Not reachable in `sbx run` today (one agent, no TCP door: `src/run.js:145` passes no `port`; a real 3-POST run asked one at a time), but nothing enforces it.

## Part A — one rule: the prompt owns one hold from its question to its verdict

Facts (cac3b2c): `src/prompt.js:83-175`. State is `open` (AskRecord|null, cleared in `onLine` before the write) plus a `typed` Map (id → true/false/null) for holds awaiting a verdict. `ask()` returns false when `closed || open`; the CLI then prints a plain `ask` line and later a plain `decided` line (`src/cli.js:263-274`, `prompted` Set). `outcome(e, typedYes)` is the one wording function.

Design:
- Replace `open` + `typed` with one current hold: `{ ask, state: 'asking' | 'sent', typedYes }` or null. Delete the `typed` Map.
- `ask(h)`: false when closed or a current hold exists (in **either** state). Otherwise current = asking; clear `buf`; print the question.
- `onData`: lines are read only while state is `asking` (a line typed while `sent`, or with no hold, answers nothing — same rule as today's stale-line rule).
- `onLine` (state asking): write the answer.
  - written → state `sent`, `typedYes = yes`, write `→ sent ` (dim, no newline) as today.
  - returned false (another answer won) → state `sent`, `typedYes = null`, print nothing (its `decided` prints the elsewhere line, as today).
  - threw → stay `asking` for the same hold and print one line: `✗ not sent (<code>), try again: Allow? [y/N] (hold <id>)` (the `✗ not sent (<code>)` part red as today, the question part exactly as `questionLines` words its last line; `<code>` as today: string `e.code` else `error`, never the message). The next typed line retries the write.
- `decided(e)`: only for the current hold's id: print `outcome(e, typedYes)` (`typedYes` undefined while still asking), then current = null. Any other id prints nothing.
- `close()`: current = null.
- Keep `outcome()` and every approved line text unchanged.
- `src/cli.js` needs no change: a busy prompt already makes the CLI print the plain `ask`/`decided` lines.

Tests (`test/prompt.test.mjs`):
1. A second `ask` while the first hold is `sent` (typed, no verdict yet) returns false and prints nothing; after the first `decided`, a new `ask` returns true. Red on cac3b2c (today it returns true and prints into the line).
2. A throwing write then a retry: first `y` → output `✗ not sent (ENOSPC), try again: Allow? [y/N] (hold h1)\n`; answer writer now succeeds; second `y` → `→ sent `; `decided allow` → line ends `→ sent ✓ allowed\n`; the writer was called twice. Red on cac3b2c (second `y` dropped).
3. A line typed while `sent` answers nothing (writer not called again).
4. Every existing outcome-line test stays green unchanged (if one must change, say why).
Mutations (each red): `ask()` checks only `state === 'asking'`; the catch sets state `sent`; `decided` ignores the id check.

## Part B — hold timeout default by terminal

Facts: `src/config.js:10` `DEFAULTS.holdTimeoutSec = 'never'`; `resolveConfig` (`:144-158`) applies `--hold` over the file. `src/cli.js:236` turns it into `timeoutMs`; the prompt condition is `!json && process.stdin.isTTY && process.stderr.isTTY` (`src/cli.js:256`), computed after `:236`. Tests: `test/config.test.mjs:38` expects the default `'never'`; `test/cli-prompt.test.mjs:183` (`--json`, no flag, no key) expects `expiresAt` null.

Design (user, 2026-11-12):
- No `--hold` and no `holdTimeoutSec` set: **terminal** (the same condition that shows the prompt) → wait until answered (`never`); **no terminal** → `180` seconds, then deny.
- `--hold <seconds|never>` beats the config key, which beats the default; both apply with or without a terminal.
- Implementation: remove `holdTimeoutSec` from `DEFAULTS` (absent = automatic); in `run()` compute the prompt condition once and use it both for the prompt and for the default. One constant for 180 next to the code that uses it. Keep `loadConfig`/`resolveConfig` JSDoc types accurate (`holdTimeoutSec?`).

Tests:
- `test/cli-prompt.test.mjs:183`: becomes "`--json`, no flag, no key → expiresAt about 180 s out". Red on cac3b2c.
- A terminal run (pty), no flag, no key → the hold's `expiresAt` is null (reuse the pty driver; read the ask file while the question shows). Must go red under mutation "default 180 regardless of terminal".
- `--json` with `{"holdTimeoutSec":"never"}` → null; with `--hold 30` → about 30 s.
- `test/config.test.mjs:38`: the default no longer contains `holdTimeoutSec`.

Docs (Part B):
- `README.md:103`: a hold waits until you answer at a terminal; without one (cron, CI, `--json`, output redirected) it is denied after 3 minutes; `--hold <seconds|never>` or `holdTimeoutSec` changes either.
- `barebox.context.md` ~86, ~96, ~130: same facts; ~130 default becomes "unset: never with a terminal, 180 without".
- `src/cli.js` header comment if it states the default.
- `docs/product/agent-sandbox-prd.md`: add the decision to the section-5 decisions (find the row that records "holds wait for an answer"/`--hold`; add "Nov 12, user: without a terminal the default is 180 s then deny").
- `CHANGELOG.md` `[Unreleased]` `### Changed`: one line for Part A ("After `✗ not sent` the same question stays open for a retry; a second hold never prints into an open `→ sent` line.") and one for Part B ("`sbx run` without a terminal (cron, CI, `--json`, redirected output) now denies a held request after 3 minutes instead of waiting forever; with a terminal it still waits. `--hold` or `holdTimeoutSec` sets either."). Released sections untouched.

## Done when

Per part: diffs, red then green for each required red, mutation results; whole-file results for `test/prompt.test.mjs`, `test/cli-prompt.test.mjs`, `test/config.test.mjs` (skips listed as pending); `npm run typecheck`; `git status --porcelain`; md5 comparison of `.claude/remember`.

## Orchestrator verifies

Reruns the mutations; a pty run showing the retry; a real non-terminal `sbx run --json` hold expiring at ~180 s (or its `expiresAt`); full suite 3x on a quiet machine announced to peers; commits A and B separately on the user's word; then `/self-review`.
