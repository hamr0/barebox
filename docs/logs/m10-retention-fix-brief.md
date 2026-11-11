# M10 fix brief: the body view kept every held body in memory (2026-11-11)

Branch: `m10-body-view` (uncommitted M10 work on it). Worker: code-developer (Sonnet). Orchestrator verifies. Do not commit.

## Finding (orchestrator, real shell)

- Full suite 3x on the M10 work: 623/624 every run. Failing: `test/bodies.test.mjs:409` "68 held 64 KB bodies ... add no body memory after gc": `arrayBuffers grew 4638720 B; bodies total 4352000 B` (main: passes).
- Cause: `const view = await viewBody(Buffer.concat(ctx.chunks), ...)` sits inside the long-lived async request handler (`src/proxy.js` ~757), which then awaits the gate for as long as the request is held. The suspended handler keeps `view` (and so the concatenated body) alive. `readWorkBody` already lives in its own function for exactly this reason (see its JSDoc).
- Proven fix (scratch copy `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10fix/`): move the view, the preview copy and the scan into their own `async function scanBody(ctx)` returning `cardLike`; the handler only does `cardLike = await scanBody(ctx)`. Same test: grew 286720 B, pass, twice.

## Steps

1. `src/proxy.js`: add `scanBody(ctx)` next to `readWorkBody`, with JSDoc saying it is its own frame so no reference to the body outlives the scan (same reason as `readWorkBody`). It builds the view, sets `ctx.decodedHead` (a copy) for decoded/truncated, returns the scan result. The handler calls it in place of the inline block. No other change.
2. New test in `test/bodies.test.mjs` next to the failing one: the same 4 agents x 17 held bodies, but each body a 64000-byte JSON-ish text **gzip-compressed** with `Content-Encoding: gzip`; after gc `arrayBuffers` growth stays under `2 * AGENTS * PER * 4096 + total_compressed / 10` (each held request keeps its raw 4 KB `tee.head` plus the 4 KB decoded preview copy; corrected Nov 11 after the worker measured the floor: plain test grows exactly 68 x 4096, the first limit missed `tee.head`). Show it red on the current tree (before step 1) and green after.

## Done when

- `test/bodies.test.mjs` and `test/gate.test.mjs` and `test/bodyview.test.mjs` pass: `node --test --import ./test/setup-env.mjs <files>`; the old test 409 red before step 1 and green after (paste both), the new test the same.
- Mutation: inline the block back into the handler → both memory tests red. Run it in a scratch copy, never in the repo tree.
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` pass (tails pasted).
- No full suite, no bench (shared machine). Stop and report if any fact above is wrong.
