# M10 POC brief: capped body decode, go/no-go (2026-11-11)

Worker: code-developer (Sonnet). Orchestrator verifies. **POC only: nothing goes in `src/` or `test/`, nothing is committed.** Never ship POC code.
Decisions: PRD section 9, row "M10 decisions (Nov 11, user)". Read it first.

## Question the POC answers (go/no-go)

Can the proxy decode `gzip`, `deflate` and `br` request bodies inside the 64 KB working slot, stopping at 64 KB of output, so that a decompression bomb costs no more than a normal body, the event loop does not stall, and 40 agents decoding at once fit the memory budget (bench 206 MB at 40 agents today, gate 245 MB)?

## Facts checked in a real shell (Nov 11, Node 22.22.2)

- `zlib.gunzip(buf, { maxOutputLength: 65536 }, cb)` on a bomb gives error `ERR_BUFFER_TOO_LARGE` and **no partial output**. So the view cannot use `maxOutputLength`; it must stream and stop itself.
- Streaming works: `createGunzip()` / `createInflate()` / `createBrotliDecompress()`, collect `data` chunks, at 65536 bytes call `z.destroy()` and keep the first 65536 bytes. Bombs that fit the slot: gzip 62237 B → 64 MB, stopped at 64 KB in 7-9 ms; deflate 62225 B → 64 MB, 1.6 ms; br 46505 B → 256 MB, 7.6 ms. Probe: `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/cap.mjs` and `capbr.mjs`. (Do not build br bombs with `brotliCompressSync` at default quality on GB inputs: it runs for minutes; use quality 1 and a fixed size.)
- Garbage input to `createGunzip()` emits `error` (code `Z_DATA_ERROR`); handle it as "undecodable".
- Today: the card scan is `src/proxy.js:757` on `Buffer.concat(ctx.chunks)` when `!ctx.over`; the working slot is `WORK_BODY_LIMIT = 65536` (`src/proxy.js:36`), read by `readWorkBody` (`src/proxy.js:845`). The ask preview is `bodyPreview(head)` in `src/holds.js:69`. Nothing in `src/` reads `content-encoding`.

## Steps

Work in `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10poc/`.

1. `view.mjs`: `decodeBody(buf, encoding)` → `Promise<{ text: Buffer, truncated: boolean } | { undecodable: true }>`. Encodings `gzip`, `x-gzip`, `deflate`, `br`, identity/absent (returns `buf` as is). Unknown encoding → `undecodable`. Stops at 65536 output bytes with `destroy()`; resolves exactly once. Plus `fields(text, contentType)` → `get(path)`: JSON (`application/json`, `*+json`, charset ignored) with dotted paths and numeric array indexes; `application/x-www-form-urlencoded` with keys as sent (`metadata[x]`). Parse lazily on first `get`; a truncated or invalid JSON body gives no fields (every `get` returns `undefined`), never throws.
2. `measure.mjs`, one process, `--expose-gc`, GC forced before each reading. Per encoding, and for a 64 KB plain JSON body:
   - **Bomb cap**: the largest bomb that fits 64 KB (as above). Output length, `truncated`, wall time.
   - **Concurrency**: 40 decodes started at once, 200 rounds. Read `VmHWM` from `/proc/self/status` and peak `process.memoryUsage().heapUsed` before the first round and after the last. Report the delta.
   - **Event loop**: `perf_hooks.monitorEventLoopDelay({ resolution: 1 })` across the concurrency run; report p50, p99, max.
   - **Leak**: 10000 bomb decodes in sequence; `process.getActiveResourcesInfo().length` and `heapUsed` after GC at start and end.
   - **Cost on normal traffic**: per-call time of `decodeBody` + one `get` on a 4 KB and a 64 KB plain JSON body (no encoding), 1e4 calls; and of a 4 KB gzip JSON body.
3. Line count of `view.mjs` (non-blank, non-comment).

## Go/no-go thresholds (fixed before measuring; do not move them)

- Every bomb stops at exactly 65536 output bytes, `truncated: true`, in under 50 ms.
- 40 concurrent bomb decodes: VmHWM delta ≤ 10 MB.
- Event-loop delay p99 ≤ 20 ms during the concurrency run.
- Leak run: active resources back to the start count; heap growth ≤ 1 MB.
- Plain 4 KB JSON: `decodeBody` + one `get` ≤ 50 µs per call.

## Required red runs (the measurement must be able to fail)

- **Uncapped**: replace the stop-at-cap with collecting all output, run the bomb cap and concurrency checks with **4 agents only, gzip only** (40 uncapped would take about 2.5 GB). Paste the failing numbers.
- **No destroy**: keep the cap but drop `z.destroy()` (stop collecting, let the stream run on). Paste the leak and time numbers; if they still pass, say so: that tells us `destroy()` is not what bounds the cost.
- **Bad JSON**: a truncated JSON body; show `get` returns `undefined` and nothing throws. Mutation: parse eagerly without try/catch → red.

## Done when

- Report has: every number above with the command that produced it, each threshold marked pass/fail, the three red runs pasted, the line count, and a one-line go or no-go.
- Anything that contradicts a fact above: stop and report it, do not work around it.
- Load check before measuring: `uptime` load < 15, paste it. No full suite, no bench.

## Orchestrator verifies

- Reruns `measure.mjs` in a real shell on a quiet machine, twice, and the uncapped red run.
- Checks the thresholds against the pasted output, not the summary.
- If go: writes the result into the PRD M10 row, then a build brief (one owner in `src/`, card scan and preview onto the view, tests red then green, full suite 3x, bench at 40 agents with gzip bodies, real `sbx run`).
