# Brief: stampede test asserts mutual exclusion, not a winner count

Branch `hardening`. Test-only change; no `src/` edit.

## Problem (verified 2026-10-28)
`test/runtime.test.mjs:204` "stampede: 8 processes claim at one instant, exactly one
wins each round" fails under host load: `round N: winners (refused 6)`, `2 !== 1`.
- Failed 3/3 running the file alone and 2/2 on a clean worktree of HEAD 81c2561,
  with load average 18.7 on 8 cores from another project's suite.
- Mechanism (`:206-212`): each child spins until `at = now + 1500 ms`, claims, holds
  1000 ms, releases. A child whose node startup takes more than ~2.5 s arrives after
  the release and wins legitimately. The test counts that as a broken lock.

## Fix
Assert what the lock promises: no two claims are held at the same time.
1. Child body: after a successful claim print `WON <Date.now()>`; immediately before
   `release()` print `REL <Date.now()>`; keep the 1 s hold and the `ERR ...` branch.
2. Per round, parse each child's stdout:
   - winner: both a `WON t1` and `REL t2` line, `t1 <= t2`;
   - refused: one `ERR` line matching the existing regex;
   - anything else goes to `other` (asserted empty, as now).
3. Assert per round: `won >= 1`, `won + refused === 8`, and the winners' intervals,
   sorted by t1, never overlap: `next.t1 >= prev.t2` (equal ms is allowed; same host,
   same clock).
4. Rename the test to say what it now proves, e.g. "stampede: 8 processes claim at
   once, no two ever hold the runtime together". Keep 20 rounds and the 15 s child
   timeout.

## Required proofs (each shown, not asserted)
- **Red:** in a scratch copy outside the repo (never mutate the repo tree), make
  `claimRuntime`'s kernel lock not exclusive (e.g. bind a per-process unique abstract
  name instead of `lockName(rt)`, so every claimer wins). The new test must fail on
  the overlap assertion. Show the output.
- **Red 2:** in the scratch copy, revert only the test to HEAD's version and show
  that the old test also goes red under the same mutant (sanity: both catch it).
- **Green under load:** run `node --test --test-name-pattern=stampede test/runtime.test.mjs`
  5 times in the repo while the host is loaded (it currently is; check `uptime` and
  report the load average), and 5 times alongside a parallel run of
  `node --test test/proxy.test.mjs`. All must pass.
- **Full suite:** `npm test` 3x in a real shell, report exit code and
  pass/fail/skip per run. 0 fail, 0 skip. If a different test fails, STOP and report
  its name, file:line and output; do not patch it. EDQUOT/-122 means /tmp quota;
  check `df /tmp`.
- `npm run typecheck` exit 0.

## How Claude will verify
Reads the diff (only `test/runtime.test.mjs`), reruns the mutant red in its own
scratch copy and loops the test alone under load.
