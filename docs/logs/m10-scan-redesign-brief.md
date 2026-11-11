# M10 redesign brief: the raw bytes are always scanned (2026-11-11)

Branch: `m10-body-view` at e84c6a8 (clean). Worker: code-developer (Sonnet). Orchestrator verifies. Do not commit.
Why a redesign, not a third patch: two self-review rounds on the same spot each found a card dodging the scan, and the second came from the first fix (project rule: a must-fix caused by the last fix means redesign). Ledger bullets anchored on `src/bodyview.js` and `test/gate.test.mjs` @ e84c6a8.

## The rule

**Decoding only adds to what is scanned. The raw bytes as sent are always scanned; any decoded output (full, truncated, partial before an error, or from the raw-inflate retry) is scanned as well. The card floor fires if either scan finds a card.** No decode outcome can then check a labelled body less than main does.

## Facts checked (Nov 11, real shell)

- Regression on e84c6a8: `{\n  "card": "4242 4242 4242 4242"\n}` with `content-encoding: deflate` → `viewBody` state `'decoded'`, `text.length` 1, card not found (09c09b0: `'unread'`, found). Cause: the `createInflateRaw` retry (`src/bodyview.js:61`) decodes plain JSON starting `{\n  "` to 1 byte.
- `createCardScanner()` (`src/cardscan.js:60`) is streaming: `push` carries a tail across calls. Use **one scanner per buffer** (`createCardScanner().push(a) || createCardScanner().push(b)`) so no false card is formed across the join, and nothing is concatenated.
- Today `scanBody` (`src/proxy.js` ~866) scans only `view.text`; `decodeRaw` builds `Buffer.concat([...out, buf])` on error (`src/bodyview.js:42`) and the retry tests `r.text === buf` (identity).

## Steps

1. `src/bodyview.js`:
   - `decodeRaw` returns the **decoded output only**: `'decoded'` / `'truncated'` as today; on error `'unread'` with `text` = the partial output if any, else `buf`. Delete the `raw()` concat.
   - The retry signal is explicit: `run` reports whether it produced any output (a `produced` boolean or `out.length`), and the `deflate` → `createInflateRaw` retry fires on "errored and produced nothing". No Buffer identity checks.
   - Wrap the header comment at ~80 columns (ledger nit at line 3) and state the rule above in it.
   - `BodyView` JSDoc: `text` is the decoded output when the body was decoded, else the body as sent; say the caller must also scan the raw bytes.
2. `src/proxy.js` `scanBody`: `const body = Buffer.concat(ctx.chunks)`; `const view = await viewBody(body, ctx.headers)`; card = `createCardScanner().push(body) || (view.text !== body && createCardScanner().push(view.text))`. The preview copy (`ctx.decodedHead`) is unchanged: only for `'decoded'`/`'truncated'`. Keep `scanBody` its own function.
3. PRD: nothing (the orchestrator edits it).

## Required tests (red on e84c6a8, then green; paste both)

- R1 (`test/gate.test.mjs`, next to the M10 card tests): a plain body `{\n  "card": "<CARD>"\n}` with `content-encoding: deflate` asks in `trust`. Red on e84c6a8.
- R2 (`test/bodyview.test.mjs` or gate): same for `content-encoding: gzip` and a plain body that partially "decodes" (find one with a short sweep if needed, or assert the rule at the `scanBody` level with the 1-byte case) — if no such gzip input exists, say so and skip R2.
- Every existing M10 test stays green (A1-A4, false gzip label, br as sent, bomb, queue tests, upstream bytes unchanged, preview decoded, model skip, memory tests in `test/bodies.test.mjs`).

Mutations, each in a scratch copy under `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10rd/` (every changed src file copied), each red:
- M1 drop the raw scan in `scanBody` (scan only `view.text`) → R1 red.
- M2 drop the decoded scan (scan only the raw body) → the gzip/deflate card tests red.
- M3 make the retry never fire → A2 (raw deflate card) red.
- M4 retry outside the queue → the raw-deflate queue test red.

## Done when

- `git status --porcelain` lists only `src/bodyview.js`, `src/proxy.js`, `test/gate.test.mjs`, `test/bodyview.test.mjs` (and this brief, untracked).
- `node --test --import ./test/setup-env.mjs test/bodyview.test.mjs test/gate.test.mjs test/bodies.test.mjs test/cardscan.test.mjs` green, 0 skipped (totals pasted).
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` tails pasted.
- No full suite, no bench (the orchestrator runs them after clearing it with peer sessions). Stop and report if a fact above is wrong or a test fails in a way this brief does not predict; do not pick a fix yourself.
