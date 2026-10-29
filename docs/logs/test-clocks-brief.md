# Brief: deadline tests on a per-test mocked clock; stampede catches early release

Branch `hardening` at 385b2a3. Test-only: `test/holds.test.mjs`, `test/runtime.test.mjs`.
No `src/` edit. Ledger bullets are named by their `grep -F` snippet.

## H1 — mocked clock can leak (`"mock.timers.enable({ apis: ['setTimeout', 'Date'] });"`)
`test/holds.test.mjs:320` enables the global `mock.timers` before `mkQ` and outside
the `try`; if `mkQ` throws, the reset never runs and the other 14 subtests of the
describe die "Promise resolution is still pending" (reproduced by the reviewer).
Fix: take the test context (`(t) => {`) and use `t.mock.timers.enable(...)`, which
node:test restores when the test ends; drop the `mock.timers.reset()` from the
`finally` and the `mock` named import if nothing else uses it.
Proof: scratch copy where `mkQ` throws in that test → only that test fails, the other
subtests in the describe pass.

## H2 — "a promoted waiter keeps its arrival deadline" (`"assert.ok(elapsed >= 250 && elapsed < 450, "`)
`:402`, real clock, `timeoutMs: 300`, sleeps 180 ms, abandons A, asserts B expires
250–450 ms after arrival. A 300 ms stall after `q.abandon(idA);` fails it (484 ms).
Fix: `t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })`; replace the sleep with
`t.mock.timers.tick(180)`, abandon A, assert B promoted (sync), then
`tick(119)` → B not expired; `tick(1)` → B expired with `'hold timeout'`, and
`Date.now() - tB === 300` (mocked Date). No `waitFor` (it uses the mocked setTimeout).
Red: scratch mutant that re-arms the promoted waiter's reservation timer from
promotion (in `releaseSlot`, `clearTimeout(hst.timer)` then
`hst.timer = setTimeout(() => expireReservation(agent, next, 'hold timeout'), deadlineMs())`)
→ fails. Stall-proof: 300 ms `performance.now()` busy-wait after `q.abandon(idA);`
→ passes.

## H3 — "a handed-over ask keeps its arrival deadline" (`"assert.ok(Date.now() - tB < 450, "`)
`:506`, real clock, `timeoutMs: 300`, sleeps 200 ms, abandons A, adds B, asserts B
denied < 450 ms after arrival. A 300 ms stall after abandon fails it (514 ms); a
100 ms stall before the sleep makes it time out (B expires before handover).
Fix: same shape: `tick(200)`, abandon A, assert `ready === 1`, add B, `tick(99)` →
B not denied, `tick(1)` → B denied `'hold timeout'`, `Date.now() - tB === 300`.
Drop the "sanity: whole test inside one window" real-time assert (meaningless on a
mocked clock) and say so in the report.
Red: scratch mutant `const t0 = Date.now();` (ignore `arrivedAt`) in `add` at
`src/holds.js:500` → fails. Stall-proof: both stalls above → passes.

H2 and H3 close the idea bullet `"await new Promise((r) => setTimeout(r, 180));"`.

## R1 — stampede misses an early release (`"assert.equal(held.length + refused, 8, "`)
`test/runtime.test.mjs` stampede: all 8 children start at `at`, so a lock that frees
100 ms after the claim is never probed while the winner still believes it holds.
Fix: add 2 late children that spin until `at + 500` (mid-hold), same body; total 10
per round, so `held.length + refused === 10`. The overlap check then catches a
late child winning inside a holder's `[t1, t2]`. A late child that starts after the
hold ends wins legitimately and does not overlap, so load cannot make it flaky.
Red: scratch mutant `setTimeout(() => server.close(), 100)` right after
`server.unref()` in `claimRuntime` → fails on "claims overlap".

## R2 — contention never asserted (`"assert.ok(held.length >= 1, "`)
On a loaded host every claim can be sequential and the overlap check proves nothing.
Per-round `refused >= 1` would bring back the load flake. Fix: sum `refused` over
the 20 rounds and assert the total is > 0 after the loop ("at least one round
contended").
Red: scratch copy where each child's start is spread (`at + i * 1500`), so nobody
contends → fails on that assert.

## Already fixed — revalidation should drop
`"await waitFor(() => ready === 1, 'handover to B');"` was fixed by 385b2a3; if the
snippet's still found elsewhere in the file, read it before deleting the bullet.

## Not in scope
Every `src/` bullet, the CI duplicate, the context-doc idea and `docs/index.md`
(Claude regenerates the index with `index-flat`; it is that file's one writer).

## Required proofs (each shown with command and output)
- Each red above in a scratch copy under /tmp/claude-1000/ (never mutate the repo).
- The H2/H3 stall runs passing; the H1 throw run isolating the failure.
- Stampede 5x alone on this host with `uptime` per run, and 3x alongside
  `node --test test/proxy.test.mjs`.
- `node --test test/holds.test.mjs` 5 loops, all green.
- `npm test` 3x in a real shell, exit code and pass/fail/skip per run, `uptime` per
  run. 0 fail, 0 skip. Another test failing → STOP, report name, file:line, output.
- `npm run typecheck` exit 0.

## How Claude will verify
Reads the diff, reruns the H2 re-arm mutant, the R1 early-release mutant and one
stall run in its own scratch copy.
