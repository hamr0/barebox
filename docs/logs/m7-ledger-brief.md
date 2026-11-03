# M7 brief: three fix-ledger items

Branch `m7`. Source: `.claude/remember/fix-ledger.md`, the bullets anchored at `out('nothing held');`, `` out(`approved ${id}`); `` and `a half-typed line`. Each fix: write the test, show it **red** on current code, apply the fix, show it **green**. Paste both outputs. Don't touch `examples/`.

## 1. A mistyped `--name` says "nothing held" (src/cli.js)
- Today: `needRuntime(name)` (src/cli.js:75) returns `namedRuntime(name)` without checking that the dir exists. `sbx pending --name typo` prints `nothing held` and exits 0 (src/cli.js:391), and `sbx approve h1 --name typo` prints `unknown h1`.
- Fix, in one place, `needRuntime`: when `name` is given, `create` is false, and the returned dir doesn't exist, print `no sandbox named <name> (start one with 'sbx run --name <name> -- …')` and exit 1. Every command that takes `--name` gets this for free; don't add per-command checks.
- Tests in test/cli.test.mjs: `pending`, `approve`, and `diff` with an unknown `--name` each exit 1 with that message. The existing named-sandbox tests stay green.

## 2. A late `sbx approve` prints "approved" for an already-decided hold (src/cli.js approve/deny, src/holds.js)
- Mechanism (verified in code): `answerTarget` sees `asks/h1.json` present. The proxy then settles h1, from another answer (`consumeFile` renames it away, src/holds.js:490) or a timeout, and `removeAskFile` follows. The CLI's exclusive `linkSync` (src/cli.js writeAnswer) then succeeds on the now-free name and prints `approved h1`, exit 0. The proxy later logs `stale-answer` (src/holds.js:498).
- Required behaviour: after a successful link, `approve`/`deny` report the real outcome. If the hold was already settled, print `h1 already decided` and exit 1 (reuse `alreadyAnswered`).
- Design: your choice, but it must be correct in the race, not just narrower. Two options:
  - (a) The CLI waits, bounded at about 4× `DEFAULT_POLL_MS`, for its answer file to be consumed, then reads the outcome. Find a reliable source: the `stale-answer` vs settle events in `<runtime>/gate.jsonl`, read from an offset taken before the link. Check the line shape bareguard actually writes; don't assume it.
  - (b) A small proxy-side record of settled ids that the CLI can check after linking.
  - Explain the remaining window, if any, in your report. If neither option is clean, stop and report with the trade-off; don't patch around it.
- Test: the race must be forced, not timed. For example, settle h1 through the files API (holds test with a real runtime), then link a second answer while `asks/h1.json` is restored. The test must fail on today's code.

## 3. The stale half-typed buffer test misses its own line (test/prompt.test.mjs:106)
- The code is right (`buf = ''` in `ask()`, src/prompt.js:99). The test types `ye` with no question open, so `onData` drops it before the reset.
- Rewrite the test as the real case: question h1 opens, the user types `ye` with no newline, then `decided({id:'h1', reason:'hold timeout'})`, then h2 opens and the user types `s\n`. Assert h2 is **denied**, not allowed.
- Red check: replace `buf = '';` in `ask()` with `void 0;`. The new test must fail. Revert.

## Done when
- All three are red then green, with outputs pasted.
- `npm test`, `npm run typecheck`, `npm run build:types` and `npm run check:primitives` all pass.
- Your sandbox skips bwrap/unix-socket tests. List exactly which ones it skipped; the orchestrator runs the full suite 3x in a real shell. A skip is not a pass.
- No commit. Report the changed files.
