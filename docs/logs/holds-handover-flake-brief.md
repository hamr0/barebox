# Brief: "first is now, second queues, decision hands over" runs on a mocked clock

Branch `hardening`. Test-only change to `test/holds.test.mjs`; no `src/` edit.

## Problem (verified 2026-10-29 in a real shell)
`test/holds.test.mjs:314` failed once in three full-suite runs (load ~8):
`timed out waiting for: handover to B` at `:331`.

Mechanism, measured by printing `_idleStart`/`_idleTimeout` of each timer:
- `reserve(A)` arms A's reservation timer (200 ms) at loop time T, which creates
  Node's 200 ms timer list with expiry T+200.
- `add(A)` clears that timer and arms A's hold timer for `200 - (Date.now() - t0)`,
  e.g. 193 ms, in a *different* list, expiry also ≈ T+200.
- `reserve(B)` arms B's reservation timer in the 200 ms list (due T+3+200).
- When the event loop stalls past B's deadline, both lists are due with tied list
  expiries; Node may run the 200 ms list first. B's own arrival deadline has passed,
  so B expires (correct behaviour: the deadline counts from arrival) and never gets
  `onReady`. The test then waits 5 s and fails.
- Repro: a scratch copy with a synchronous busy-wait inserted before the
  `waitFor` fails 4/5 at 400 ms stall, 3/5 at 600 ms, 1/5 at 250 ms; instrumented
  run shows `B expire hold timeout` with no `B ready`.
- Not a product bug: B is past its own deadline. Tests at `:354` and `:381` share
  the shape but are immune: A's reservation timer is never cleared there, so A and B
  sit in the same 200 ms list and fire in insertion order.
- This test is the only one that covers "an added holder's hold timeout hands the
  slot over": mutating `settle` to `if (h.slot && reason !== "hold timeout")
  releaseSlot(h.agent);` turns only this subtest red (holds.test.mjs 29/30,
  proxy.test.mjs 65/65 green). So it must keep the timeout path; switching A to
  `q.abandon()` would delete that coverage.

## Fix
Rewrite only this one test to run on `node:test`'s mocked clock (stdlib; Node 22
prints an ExperimentalWarning, accepted):
1. `import { mock } from 'node:test'` (extend the existing `node:test` import).
2. Inside the test: `mock.timers.enable({ apis: ['setTimeout', 'Date'] })` BEFORE
   `mkQ(...)`, and `mock.timers.reset()` in `finally` after `q.close()`.
3. Same setup as now (`timeoutMs: 200`, A reserved and added, B reserved with
   `onReady` adding B). Replace both `waitFor` calls (they use `setTimeout`, which
   is mocked, so they would hang) with:
   - `mock.timers.tick(200)` → assert `ready === 1` and `expired` deep-equals `[]`;
   - `mock.timers.tick(1)` (or whatever B's remaining hold needs; read the code) →
     assert `denied.map(([, r]) => r)` deep-equals `['hold timeout', 'hold timeout']`;
   - keep the `onReady exactly once` assertion.
4. Keep the test name and its comment, adding one line saying why the clock is
   mocked (equal deadlines tie after a loop stall). Make the test synchronous if no
   `await` is left.
5. Check that nothing `mkQ` sets up depends on real timers (ask files, log); if it
   does, stop and report.

A working probe of this shape passed at 0/400/800 ms injected stall; it is not to be
copied blindly — fit it to the file's helpers (`mkQ`, `entry`, `noop`).

## Required proofs (each shown with the command and output)
- **Stall-proof:** in a scratch copy outside the repo (never mutate the repo tree),
  insert a 400 ms and an 800 ms synchronous busy-wait (use `performance.now()`, not
  the mocked `Date`) after `reserve(B)`; the new test passes 5/5 at each.
  Show the OLD test failing at least once in the same harness for contrast.
- **Red 1:** scratch mutant `if (h.slot && reason !== "hold timeout") releaseSlot(h.agent);`
  in `settle` → the new test fails.
- **Red 2:** scratch mutant that drops `if (hst.timer) clearTimeout(hst.timer);` in
  `add` → the new test fails (`expired` non-empty or denied wrong). If it stays green,
  report that rather than reshaping the test to force it.
- **No timer leak into other tests:** `node --test test/holds.test.mjs` 30/30, 5 loops.
- **Full suite:** `npm test` 3x in a real shell, exit code and pass/fail/skip per run,
  report `uptime` per run. 0 fail, 0 skip. If a different test fails, STOP and report
  name, file:line and output; do not patch it. EDQUOT/-122 = /tmp quota (`df /tmp`).
- `npm run typecheck` exit 0.

## How Claude will verify
Reads the diff (only `test/holds.test.mjs`), reruns Red 1 and the 800 ms stall in its
own scratch copy.
