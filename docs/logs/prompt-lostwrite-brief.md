# Brief: prove the lost and failed answer paths; a failed write says "✗ not sent" (2026-11-12)

Worker: code-developer (Sonnet). Branch `fix/prompt-verdict` (checked out, clean, HEAD d14cc0a). Do **not** commit.
Rules: `.claude/remember/AGENT_RULES.md`. Every new or changed test is shown **red** (mutation or old code named) then **green**; paste both. Mutations only in a fresh full scratch copy (scratchpad), never in the repo tree. Do not run the full suite. `grep` may be a wrapper: use `/usr/bin/grep -a`.
Edit only: `src/prompt.js`, `test/prompt.test.mjs`, `barebox.context.md`, `CHANGELOG.md`. If a fact is wrong or the design doesn't fit, stop and report with options.

## Facts (checked, d14cc0a)

- `src/prompt.js:110-120` `onLine`: `written = answer(...) !== false` inside `try`; `catch {}` swallows a throw; then `typed.set(id, written ? yes : null)`; `→ sent ` only when written.
- The CLI's `answer` is `writeAnswer` (`src/cli.js:469-483`): returns false on `EEXIST` (another answer won), **throws** on any other error from `mkdirSync`, `writeFileSync`, `linkSync` (e.g. `ENOSPC`, `EDQUOT`, `EACCES`, `ENOENT` when the runtime dir is gone).
- Self-review of d14cc0a (mutations run in a scratch copy, 25/25 still green under each):
  1. `test/prompt.test.mjs:181-196` lost-write test only decides `deny 'denied by user'`, which words the same whether the record is null or the typed yes. Mutation `typed.set(id, yes)` for a lost write survives. Real failure: lost write after typing `y`, then `sbx approve` from another terminal → `✓ allowed`, as if the typed y did it.
  2. `test/prompt.test.mjs:236-247` throw test asserts nothing. Mutation `written = true` in the `catch` survives → a false `→ sent` would ship.
  3. A throwing write prints nothing at all; with `sbx run`'s default of no hold timeout the user sees a blank line and the hold waits forever.

## Changes

1. **Test (lost write + allow elsewhere).** Add to the lost-write test, or a sibling: `answer: () => false`, type `y`, then `decided({ decision: 'allow' })` → output ends `✓ answered elsewhere (allowed)\n` and never contains `✓ allowed` or `→ sent`. Red under mutation: lost write recorded as `typed.set(id, yes)`.
2. **Behaviour (failed write).** In the `catch`, print one line at once: `✗ not sent (<code>)` in red, where `<code>` is the error's `code` when it is a string (e.g. `ENOSPC`), else `error`, through `safe()`; never the message (it may hold a path). Record the id as null as today, so its later `decided` still prints its own outcome line (e.g. `✗ timed out (denied)`).
3. **Test (failed write).** Replace the assert-nothing test: `answer: () => { const e = new Error('x'); e.code = 'ENOSPC'; throw e; }`, type `y` → output is exactly `✗ not sent (ENOSPC)\n` with no `→ sent`; then `decided({ decision: 'deny', reason: 'hold timeout' })` → output ends `✗ timed out (denied)\n`. Also an error with no `code` → `✗ not sent (error)`. Red against d14cc0a (prints nothing), and red under mutation `written = true` in the `catch`.
4. **Docs.** `barebox.context.md:74`: "the prompt says `answered elsewhere`" → it prints `✓ answered elsewhere (allowed)` or `✗ answered elsewhere (<reason>)` when the proxy decides; add: a write that fails prints `✗ not sent (<code>)` and the hold stays open for another terminal or its deadline. `CHANGELOG.md` `[Unreleased]` `### Changed`: append one sentence to the existing line: "An answer that cannot be written prints `✗ not sent (<code>)` instead of nothing." Do not touch released sections.

## Done when

Diffs; red then green for 1 and 3 (both reds for 3); whole-file `test/prompt.test.mjs` and `test/cli-prompt.test.mjs` results (skips listed as pending); `npm run typecheck`; `git status --porcelain` lists only the four files plus this brief.

## Orchestrator verifies

Reruns both mutations; full suite 3x on a quiet machine announced to peers; then `/self-review`.
