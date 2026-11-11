# M10 POC 2 brief: queued gzip decode on the production bench (2026-11-11)

Worker: code-developer (Sonnet) prepares; **the orchestrator runs the bench** (it needs bwrap and unix sockets, which the worker sandbox skips). POC only: nothing in the repo's `src/`, `test/` or `scripts/` changes, nothing is committed.
Decisions: PRD section 9, row "M10 decisions (Nov 11, user)", including "POC 1" and "POC 2". Read it first. POC 1 code: `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10poc/` (`view.mjs`, `view-queue.mjs`).

## Question (go/no-go)

With gzip and deflate request bodies decoded one at a time through a single proxy-wide queue (64 KB output cap, `destroy()` at the cap), does the proxy's worst case at 40 agents, with **every** body-carrying request a gzip bomb, stay within 245 MB on `scripts/bench-agents.mjs`, A/B against main?

## Facts (checked, Nov 11)

- The bench runs the proxy as a child with `node --expose-gc --max-semi-space-size=1` (`scripts/bench-agents.mjs:18`, the CLI's flag), and fails at 245 MB.
- Bench bodies: the parked hold per agent is an unlabelled POST with a 64 KB body (`scripts/bench-agents.mjs:261,277`), the working-slot filler declares 64 KB and sends 60 KB (`:306`). Raw head builder `head()` at `:148`.
- Card scan site: `src/proxy.js:757`, on `Buffer.concat(ctx.chunks)` when `!ctx.over` and not a model tool.
- A gzip bomb that fits 64 KB: `zlib.gzipSync(Buffer.alloc(64e6))` is 62237 B.

## Steps

Work in `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10b/`.

1. Three full copies of the repo (with `node_modules`): `base/` (unchanged), `queue/`, `noqueue/`. Copy every file; verify with `diff -r` that only the files below differ.
2. In `queue/` and `noqueue/`: add `src/bodyview.js` from POC 1's `view.mjs` (gzip and deflate only, `br` returns undecodable). `queue/` wraps `decodeBody` in the single promise-chain queue of `view-queue.mjs`; `noqueue/` does not. At `src/proxy.js:757`: when the request has `content-encoding` gzip or deflate, await the decode and scan the decoded text instead of the raw bytes; otherwise unchanged.
3. In all three copies, `scripts/bench-agents.mjs`: with `BENCH_GZIP=1`, the hold and filler bodies become the 62237 B gzip bomb with a `Content-Encoding: gzip` header and the matching `Content-Length` (the filler sends all but the last 4 KB first, then the rest where it finishes the body today). Without the env var the bench is byte-identical to main. `base/` gets the same bench change so the A/B sends the same bytes.
4. Prove the wiring without the bench (unit level, in the copy): a node script that calls the `queue/` decode with 40 bombs at once and shows they run one at a time (timestamps), and that a gzip body containing a Luhn-valid card is found by the scan in `queue/` and not in `base/`. Paste output.
5. Write `run.sh` for the orchestrator: alternating `base`, `queue`, `noqueue`, 3 rounds, each `BENCH_GZIP=1 npm run bench:agents` in that copy, output to `<copy>-<round>.txt`. Do not run it.

## Done when

- Diff listing per copy (`diff -rq` against the repo, excluding `node_modules`), step 4 output pasted, `run.sh` written.
- Stop and report anything that contradicts a fact above. Do not run the bench or any full suite.

## Orchestrator runs and judges

- Tells the peer sessions, checks load < 15, runs `run.sh` on a quiet machine.
- **Go**: `queue` worst case at 40 agents ≤ 245 MB in every round, and within noise (about 1 MB) plus a stated margin of `base`.
- **Must be able to fail**: `noqueue` is the red run; if `noqueue` is no worse than `queue`, the queue is not what bounds memory and that is reported.
- Writes the result into the PRD M10 row; if go, a build brief follows.
