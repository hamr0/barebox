# M10 brief: remove the raw-inflate retry (2026-11-11)

Branch: `m10-body-view` at 90e12f1 (clean). Worker: code-developer (Sonnet). Orchestrator verifies. Do not commit.
Asked by the user via `/refactor carry the fix as recommended` after self-review round 3. **This is a deliberate behaviour change the user chose** (one case stops being decoded), not a pure refactor; everything else must behave exactly as at 90e12f1.

## Why

The `deflate` → `createInflateRaw` retry (added in e84c6a8) caused two findings: round 2's card dodge (fixed for good by the 90e12f1 rule "the raw bytes are always scanned") and round 3's ledger `change` at `src/proxy.js:869`: a plain JSON body with a false `Content-Encoding: deflate` starts with `{` (0x7b), a valid raw-deflate final block, so the retry "decodes" it to ~1 byte, state `'decoded'`, and the ask preview shows that junk byte instead of the body. Removing the retry removes the cause: such a body fails `createInflate`, is `'unread'`, and the preview shows the body as sent (`ctx.tee.head`).

Cost, accepted by the user: a card inside a genuine raw-deflate body (no zlib header) sent as `deflate` is no longer found (only old or broken clients send that). It becomes a PRD section 10 known-gap line (the orchestrator writes it).

## Steps

1. `src/bodyview.js`: delete the retry (the `.then(...)` around `run(factory)`, lines ~67-69) and the `produced` flag (line ~41 JSDoc, ~64). `decodeRaw` is back to one decoder run. Update the header comment (line ~8) so it no longer mentions the raw-inflate retry, and say raw deflate sent as `deflate` is not decoded (known gap).
2. `test/gate.test.mjs:320` `'a raw deflate body with a card asks in trust mode'`: this asserted the retry. Replace it with the gap's guard: a raw deflate body is not decoded, unit level in `test/bodyview.test.mjs` (`'unread'`, `text` equals the raw body). Remove the gate test.
3. `test/bodyview.test.mjs:100` `describe('the queue covers the raw-deflate retry')`: delete it (nothing to cover). Keep every other queue test.
4. New tests (red on 90e12f1, green after; paste both):
   - P1 (`test/gate.test.mjs`, next to the preview test "a held gzip JSON body previews decoded"): in `ask` mode a plain **pretty-printed** JSON body `{\n  "to": "x",\n  "amount": 9999\n}` with `Content-Encoding: deflate` (corrected Nov 11: the misread needs `{` then a newline; the compact form stays 'unread' on 90e12f1, checked in a real shell) is held and its `asks/<id>.json` `bodyPreview` equals that JSON. Red on 90e12f1 (preview is one junk byte).
   - P2 (`test/bodyview.test.mjs`): `viewBody(Buffer.from('{\n  "card": "4111111111111111"\n}'), { 'content-encoding': 'deflate' })` → state `'unread'`, `text` is the raw body.
   - The existing "a plain JSON body with a card and a false Content-Encoding: deflate still asks" stays green.
5. Mutation (scratch copy under `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10dr/`, every changed src file copied): put the retry back → P1 and P2 red.

## Done when

- `git status --porcelain` lists only `src/bodyview.js`, `test/bodyview.test.mjs`, `test/gate.test.mjs` (plus this brief, untracked).
- `node --test --import ./test/setup-env.mjs test/bodyview.test.mjs test/gate.test.mjs test/bodies.test.mjs test/cardscan.test.mjs` green, 0 skipped (totals pasted).
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` tails pasted.
- No full suite, no bench, no `sbx run` (the orchestrator runs them; a peer runs a timed bench). Stop and report anything this brief does not predict; do not pick a fix yourself. Never touch `.claude/`.
