# Brief: instant "→ sent" receipt, verdict on the same line (2026-11-12)

Worker: code-developer (Sonnet). Branch `fix/prompt-verdict` (checked out, on top of 06e986b). Do **not** commit.
Rules: `.claude/remember/AGENT_RULES.md`. Every new or changed test is shown **red** (old code or the mutation named) then **green**; paste both. Mutations only in a fresh full scratch copy (scratchpad), never in the repo tree. Do not run the full suite. Loop one test with `node --test --import ./test/setup-env.mjs --test-name-pattern='<name>' <file>`. `grep` here may be a wrapper; use `/usr/bin/grep -a`.
If a fact below is wrong, or the design does not fit the code, stop and report with options.

## Why

06e986b prints the outcome only when the proxy settles the hold (correct: a late `y` no longer shows ✓ next to a 403), but the user now sees nothing for up to ~250 ms after pressing Enter (the proxy polls answer files every 250 ms, `src/holds.js:73`). The user wants an instant signal that the answer was heard, with the verdict on the same line.

## Facts (checked, 2026-11-12)

- `src/prompt.js` (06e986b): `onLine` writes the answer; on a written answer it records `typed.set(id, yes)` and prints nothing; on `answer() === false` it prints `answered elsewhere`. `decided(e)` prints `outcome(e, typedYes)` for the open question or a typed id. `say()` always appends `\n`.
- Only one hold is ever shown at a time in `sbx run`: the proxy keeps one held request per agent and `sbx run` has one agent (no TCP door: `src/run.js:145` passes no `port`). Orchestrator run: three parallel POSTs from one sandbox asked h1, then h2 only after h1 was decided, then h3. So **no other question can print between the receipt and its verdict**. Do not build an id fallback for that case.
- Every parked hold ends in exactly one `decided` (`src/holds.js` settle/abandon/close), and `sandboxRun` awaits `proxy.close()` before `prompt.close()` (`src/cli.js` ~299/309), so a typed hold always gets its verdict before close.
- The agent's own output goes to the same terminal and may land between `→ sent` and the verdict (rare; accepted by the user, no cursor tricks).

## Decided design (user, 2026-11-12)

One line per answer. Exact texts (colours as today: ✓ lines bold green, ✗ denied bold red, timed out / agent gone / sandbox closed red, answered elsewhere plain; `→ sent` dim):

You typed and your answer was written — `→ sent ` is written **immediately, without a newline**; the verdict is appended when the proxy decides, then `\n`:

| proxy outcome | line |
|---|---|
| allow (you typed y) | `→ sent ✓ allowed` |
| deny, reason `denied at the terminal` (you typed n/Enter) | `→ sent ✗ denied` |
| deny, `hold timeout` | `→ sent ✗ timed out (denied)` |
| deny, `client gone` | `→ sent ✗ agent gone (denied)` |
| deny, `proxy closing` | `→ sent ✗ sandbox closed (denied)` |
| anything else | `→ sent ` + the elsewhere text below |

Nothing was sent (your write lost: `answer()` returned false, or the hold ended while the question was open, nothing typed): **no `→ sent`**, one line when the proxy decides:

| proxy outcome | line |
|---|---|
| `hold timeout` | `✗ timed out (denied)` |
| `client gone` | `✗ agent gone (denied)` |
| `proxy closing` | `✗ sandbox closed (denied)` |
| anything else (another terminal answered) | `✓ answered elsewhere (allowed)` for allow; `✗ answered elsewhere (<reason>)` for deny, `(denied)` when there is no reason, e.g. `✗ answered elsewhere (denied by user)` |

For a lost write, print nothing at typing time; remember the id so its `decided` prints the "nothing was sent" line (today the decided for a lost write prints nothing and the user never learns the outcome — check this and say so).
Keep one function that words the outcome (`outcome`); the receipt prefix is decided by whether the answer was written. Agent-supplied strings stay behind `safe()`.

## Tests

`test/prompt.test.mjs` — one test per table row, asserting the **exact** line (NO_COLOR and colour). Required reds:
1. Typing `y` writes `→ sent ` at once, before any `decided`: red against 06e986b (it prints nothing).
2. `y` then `decided` deny `hold timeout` → output ends `→ sent ✗ timed out (denied)\n` and never contains `✓`: red under mutation "append `✓ allowed` in onLine".
3. Verdict printed once: a repeated `decided` for the same id adds nothing — must be red under mutation "don't delete the id after printing". (This replaces the test the self-review flagged as unable to fail.)
4. The colour test asserts the new coloured strings: red against 06e986b.
5. Lost write: `answer()` returns false, then `decided` deny 'denied by user' → `✗ answered elsewhere (denied by user)`, no `→ sent`: red against 06e986b.
`test/cli-prompt.test.mjs` (pty): the y and n runs show `→ sent ✓ allowed` / `→ sent ✗ denied` on one line, and no `decided h` line.

## Docs

- `README.md` transcript (~line 95-101): the answer line becomes `→ sent ✓ allowed` (check the exact current transcript and change only that line).
- `barebox.context.md` (the sentence 06e986b added, ~line 63): say `→ sent` prints at once and the outcome is appended when the proxy decides; list the outcome words.
- `CHANGELOG.md` `[Unreleased]` `### Changed`: replace the line with: "`sbx run` on a terminal answers at once with `→ sent` and appends the outcome when the proxy decides (`✓ allowed`, `✗ denied`, `✗ timed out (denied)`, ...): a `y` typed just before the `--hold` deadline shows `✗ timed out (denied)`, never `✓ allowed`, and no plain `decided` line repeats it."

## Done when

Diffs; red then green per required red; whole-file results of `test/prompt.test.mjs` and `test/cli-prompt.test.mjs` (skips listed as pending); `npm run typecheck` passes; `git status --porcelain`.

## Orchestrator verifies

Reruns each mutation; reruns the delay sweep with a pty (expects every line to match the agent's HTTP status, and `→ sent` visible at once); full suite 3x on a quiet machine announced to peers; user runs the demo on a real terminal.
