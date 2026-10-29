# Brief: sweep tests for real-clock assertions — change only what a stall proves fragile

Branch `hardening` at 9daaead. Test-only. The owner's rule: no change on speculation;
a test changes only when it is shown to break.

## Why
Every flake this branch hit was a test leaning on real time: the stampede winner
count, the handover tie, the two arrival-deadline upper bounds. Each was found one
failure at a time. This sweep finds the rest at once.

## The bar (what counts as proof)
A suite run at load ~8 stalled the event loop past 200 ms (the handover test failed
that way in a full run; injected stalls of 250 ms reproduced it). So:
- **Proven fragile** = the test fails with an injected synchronous stall of
  **≤ 250 ms** (`const e = performance.now() + N; while (performance.now() < e) {}`)
  placed at one point inside the test, in a scratch copy under /tmp/claude-1000/
  (never in the repo tree). Run each failing placement 3x; it must fail at least
  2/3. Record N, the placement (file:line) and the failure text.
- **Robust** = no placement fails at 250 ms. Leave it untouched.
- A test that only fails above 250 ms is robust for this sweep; list it with the
  smallest failing N.

## Candidates
`grep -rnE "setTimeout\(r, [0-9]+\)|Date\.now\(\) - |elapsed|performance\.now" test/*.mjs`
(42 hits at 9daaead), plus any `waitFor` whose condition depends on a deadline
firing in a given order, plus `timeoutMs`/`--max-time` values under 2 s in tests.
For each test containing a hit: try a stall at each point between an action and the
assertion that measures it (before a sleep, after a sleep, after the action that
should trigger the deadline). Skip tests already on `t.mock.timers`.

## Fix (only for proven-fragile tests)
- **In-process tests** (holds, proxy units, wall, runtime helpers that use timers):
  move to `t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })` with `tick()`,
  the shape already used in `test/holds.test.mjs` for "a promoted waiter keeps its
  arrival deadline". Keep every assertion's meaning; replace real-time bounds with
  exact mocked times. If a test needs real sockets or child processes AND a mocked
  clock, stop and report it: don't mix.
- **Tests across real processes or sockets** (run, e2e, cli, proxy over sockets,
  runtime child processes): do NOT widen a bound or add a sleep (that is fitting to
  pass). Report them with the proof and two options (assert only what the code
  guarantees / a product change that guarantees the order); the owner decides.
- For each fixed test, show it red against a scratch mutant that breaks the
  behaviour it pins (the deadline it measures), and green under the stall that
  broke it before.

## Known, out of scope
`test/run.test.mjs:265` "client gone" race: already proven and ledgered as a product
change. Don't touch it; if your sweep reproduces it, just say so.

## Required proofs
- A table of every test with a candidate hit: file:line · test name · placements
  tried · smallest failing N (or "robust ≤250") · verdict.
- Per fixed test: diff, mutant red, stall green.
- `node --test` on each changed file, 5 loops green.
- `npm test` 3x in a real shell: exit code, pass/fail/skip, `uptime` per run.
  0 fail, 0 skip. A failure in a test you did not change → STOP, report name,
  file:line, output; do not patch it.
- `npm run typecheck` exit 0.

## How Claude will verify
Reruns two of the proven-fragile placements against HEAD (must fail) and against
the fix (must pass), and one mutant red.
