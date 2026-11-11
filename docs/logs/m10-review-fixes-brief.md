# M10 review fixes brief (2026-11-11)

Branch: `m10-body-view` at 09c09b0 (clean). Worker: code-developer (Sonnet). Orchestrator verifies. Do not commit.
Source: `/self-review` of 09c09b0, ledger `.claude/remember/fix-ledger.md` bullets anchored on `src/bodyview.js`. The user asked: fix the Fix-now item and the nit.

Two separate changes. Do A, then B. Do not touch anything else (the two `idea` bullets, stacked encodings and the queue timeout, stay as they are).

## Facts checked in a real shell (Nov 11, Node 22.22.2)

Body = gzip of `"pay 4242 4242 4242 4242 now " + "x" * 200`, streamed through `createGunzip` / `createInflate`, collecting `data` until `close`:

| case | default | `{ finishFlush: zlib.constants.Z_SYNC_FLUSH }` |
|---|---|---|
| gzip, 8-byte trailer cut | full text out, then `Z_BUF_ERROR` | full text out, **no error** |
| valid gzip | ok | ok (same output) |
| zlib deflate, trailer cut | (error) | full text, no error |
| raw deflate (no zlib header) as `deflate` via `createInflate` | 0 out, `Z_DATA_ERROR` | same |
| raw deflate via `createInflateRaw` | full text, no error | — |
| gzip member + 7 garbage bytes | **0 out**, `Z_DATA_ERROR` | same; slicing the writes (64 B, 1 KB, 16 KB) does not help: Node drops the last buffered output on error |
| 30 KB-text gzip + garbage, card at the end | 16384 out (card not in it), `Z_DATA_ERROR` | same |
| gzip of "hi" + plain " 4242 4242 4242 4242" appended | 0 out, `Z_DATA_ERROR`; the **raw** scan finds the card (today's 'unread' path) | — |

So: trailer-cut bodies are fixed by `Z_SYNC_FLUSH`; raw deflate by one retry with `createInflateRaw`; a member followed by garbage cannot be decoded with Node's zlib and stays a known gap (only a deliberate sender produces it; Node-based servers reject such a body).

## A. Broken gzip/deflate bodies must not dodge the card scan (behaviour fix, ledger `change`)

1. `src/bodyview.js` `decodeRaw`: create every decoder with `{ finishFlush: zlib.constants.Z_SYNC_FLUSH }`.
2. For `deflate` only: when the decoder errors having emitted **no** output, retry once with `createInflateRaw` (same options, same 64 KB stop, same `destroy()`, inside the **same** queued task so the queue still has one decoder live at a time).
3. When a decode errors after emitting some output: state stays `'unread'`, and `text` is the partial output followed by the raw bytes (`Buffer.concat([partial, buf])`), so the scan covers both. Keep the 64 KB output stop as is.
4. Fix the comment that claims "a false Content-Encoding cannot dodge the card scan" (find it: `grep -rn "cannot dodge" src`): say instead that a body that does not decode is scanned as sent, and that a gzip member followed by garbage is not decoded (known gap).
5. PRD section 10, next to the existing `br`/`zstd` line, one line: "A gzip body with bytes after its member (trailing garbage) is not decoded by Node's zlib; it is scanned as sent, so a card inside the compressed member is not found. Only a deliberate sender makes such a body."

Required tests, each red on 09c09b0 then green (paste both), proxy-level in `test/gate.test.mjs` next to the M10 card tests, unit in `test/bodyview.test.mjs`:
- A1. gzip body with a card, trailer cut (`gz.subarray(0, -8)`): asks in `trust`.
- A2. raw deflate (`zlib.deflateRawSync`) with a card, `Content-Encoding: deflate`: asks in `trust`.
- A3. unit: a 30 KB-text gzip + garbage where the card is in the **first** 1 KB of text: `'unread'`, and `text` contains the card (partial output kept).
- A4. unit: the trailing-garbage case of the table (card at the end, 0 output) is `'unread'` and its `text` equals the raw body (documents the gap; not red on main, a guard).
- Mutations in a scratch copy (every changed src file copied), each red: drop `Z_SYNC_FLUSH` → A1 red; drop the `inflateRaw` retry → A2 red; drop the partial concat → A3 red; run the retry outside the queue → the existing one-decoder queue test red (if it stays green, say so: then the queue test does not cover the retry and needs a deflate case).

## B. Remove `get(path)` until M11 needs it (ledger `nit`, refactor: no runtime behaviour change)

1. `src/bodyview.js`: delete `fieldGetter`, the `get` property and its typedef line; `viewBody` returns `{ text, state }`. Grep repo-wide first (`git grep -n "\.get(\|fieldGetter\|BodyView"`): `src/` must have no caller (the review found none); stop and report if one exists.
2. `test/bodyview.test.mjs`: delete the `get(path)` tests only.
3. Docs: `barebox.context.md`, CHANGELOG and the brief files do not describe `get` to users: check with `grep -n "get(path)\|get(" barebox.context.md CHANGELOG.md`; change only a line that does. The PRD M10 rows are the orchestrator's (it edits them).

## Done when

- `git status --porcelain` lists only `src/bodyview.js`, `test/bodyview.test.mjs`, `test/gate.test.mjs`, `docs/product/agent-sandbox-prd.md` (the one section-10 line), and a doc file only if B3 found a line.
- A1-A4 and every mutation pasted as above. `node --test --import ./test/setup-env.mjs test/bodyview.test.mjs test/gate.test.mjs test/bodies.test.mjs` green, 0 skipped (paste totals).
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` tails pasted.
- No full suite, no bench (a peer session runs a timed bench). Stop and report if any fact above is wrong.
