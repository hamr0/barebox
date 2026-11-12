# Brief: the terminal prompt shows the proxy's verdict, not the typed answer (2026-11-11)

Worker: code-developer (Sonnet). Branch `fix/prompt-verdict` (checked out). Do **not** commit.
Rules: `.claude/remember/AGENT_RULES.md`. Each new or changed test is shown **red** against the old code, then **green**; paste both. Mutations only in a scratch copy (scratchpad), never in the repo tree. Do not run the full suite. Loop one test with `node --test --import ./test/setup-env.mjs --test-name-pattern='<name>' <file>`. Note: `grep` in this shell is a wrapper that treats `test/cli.test.mjs` as binary; use `/usr/bin/grep -a`.
If a fact below is wrong, stop and report.

## The bug (reproduced by the orchestrator, 2026-11-11)

`sbx run --hold 1` with a pty typing `y` at a delay after `Allow?`:

| delay | terminal | agent |
|---|---|---|
| 0.70 s | ✓ allowed | 200 |
| 0.80, 0.85, 0.90, 0.95 s | **✓ allowed** | **403** (hold timeout) |
| 1.00, 1.05 s | timed out: deny | 403 |

Cause (checked): `src/prompt.js:94-98` `onLine` prints `✓ allowed` / `✗ denied` as soon as `answer()` writes the answer file. The proxy reads answer files on a 250 ms poll (`src/holds.js:73`, `pollAnswers` at `:479`), so the deadline can fire first. `onLine` sets `open = null`, so the later `decided(e)` (`src/prompt.js:125`) returns early and prints nothing. Since bc70894 the CLI also skips the plain `decided` line for a prompted hold (`src/cli.js:266`, `:272`), so nothing on the terminal tells the truth.

## Decided design (user, 2026-11-11): one writer of the outcome line

The outcome line is printed **only when the proxy settles the hold** (`decided(e)`), never at typing time.

1. `onLine`: write the answer as today. If `answer()` returned false, print `answered elsewhere` as today. Otherwise print nothing and remember what was typed for that id (a `Map` id → yes, deleted on its `decided`). If `answer()` throws, remember nothing (as today).
2. `decided(e)`: if `e.id` is the open question, behave exactly as today. Else if `e.id` was typed:
   - typed yes and `e.decision === 'allow'` → `✓ allowed` (bold green, as today);
   - typed no and `e.decision === 'deny'` with reason `denied at the terminal` → `✗ denied` (bold red, as today);
   - anything else → the existing non-open lines (`timed out: <d>`, `agent gone: <d>`, `answered elsewhere: <d> (<reason>)`), same text and colours.
   Reuse the existing message code: one function picks the line; do not copy the branches.
3. Otherwise (an id the prompt never showed) print nothing, as today.
4. `src/cli.js` is unchanged: a prompted hold still gets no plain `decided` line, because the prompt now prints its verdict.
5. `close()` forgets the map.

## Tests

- `test/prompt.test.mjs`:
  - Update the test at ~line 70 ("y/yes allow ... count ✓ and ✗"): typing alone prints no `✓`/`✗`; after a `decided` for each id with the matching decision, the counts are 3 and 3.
  - New: typed `y`, then `decided({id, decision: 'deny', reason: 'hold timeout'})` → output ends `timed out: deny`, and `✓ allowed` never appears. **This is the bug's test**: red on the old `prompt.js`.
  - New: typed `n`, then `decided` allow from elsewhere → `answered elsewhere: allow`, no `✗ denied`.
  - The colour test (~line 225): adjust so ✓/✗ come from `decided` after typing.
- `test/cli-prompt.test.mjs`: the pty tests still see `✓ allowed` / `✗ denied` (now printed on settle) and no `decided h` line. No timing-race pty test (timing tests may not depend on a window); the orchestrator repeats the sweep above.
- Mutation (scratch copy): restore printing `✓ allowed` in `onLine` on a written yes → the new hold-timeout test goes red.

## Docs

- `barebox.context.md` ~line 61-71: one sentence: the outcome line (`✓ allowed`, `✗ denied`, `timed out`, `answered elsewhere`) is printed when the proxy decides, so a `y` that arrives after the deadline shows `timed out: deny`.
- `CHANGELOG.md` `[Unreleased]` `### Changed`: replace the existing line with: "`sbx run` on a terminal prints the outcome of a held request once, when the proxy decides it: a `y` typed just before the `--hold` deadline now shows `timed out: deny` instead of `✓ allowed`, and no plain `decided` line repeats it."

## Done when

- Diffs, red then green per test, mutation red, `test/prompt.test.mjs` and `test/cli-prompt.test.mjs` whole-file green (list skips as pending), `npm run typecheck` passes.

## Orchestrator verifies

- Reruns the mutation; reruns the delay sweep (expects no `✓ allowed` with a 403); full suite 3x on a quiet machine announced to peers; real `since-demo.sh` on the user's terminal.
