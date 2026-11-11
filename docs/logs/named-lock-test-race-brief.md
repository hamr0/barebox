# Brief: named.test.mjs "a second run on a name that is running" races itself (2026-11-11)

Worker: code-developer (Sonnet). Branch `fix/pre-m11`. Do **not** commit. Test-only change: `src/` is not touched.
Rules: `.claude/remember/AGENT_RULES.md`. Mutations go in a scratch copy of the repo (scratchpad), never in the repo tree. Do not run the full suite.

## Facts (reproduced by the orchestrator, 18:34-18:35Z, load 19-24)

- `test/named.test.mjs:146-157`: the test spawns `sbx run --name t2 -- sleep 30` (`stdio: 'ignore'`) and then, every 300 ms for up to 15 s, probes with `sbx run --name t2 -- true`. Each probe is a full run that takes the runtime lock itself while it runs.
- Under load a probe can claim the lock first, so the **first** run is the one refused. Captured in a scratch copy, 1 of 8 runs: `FIRST exit=1 stderr="sandbox t2 (answer from another terminal: ...)\nrun failed: sandbox t2 is already running (pid 860641)..."`. Every later probe then runs freely, and the test fails after 15 s with `The input did not match ... /sandbox t2 is already running/`. It failed the same way in the orchestrator's full suite run 2 (18:26-18:31Z).
- The lock is correct: a run that finds the name taken is refused. Only the test's ordering is wrong.
- The `sandbox t2 (answer from another terminal ...)` stderr line is printed **before** the lock is claimed (the refused run printed it too), so it is not a "lock held" signal. The agent command running is one: the lock is claimed before the agent starts.

## Steps

1. The first run becomes `sbx run --name t2 -- sh -c 'echo T2UP; exec sleep 30'` with stdout piped. Wait for `T2UP` on its stdout, with its own deadline (e.g. 30 s, failing by name: "first run never started"). Keep its stderr and exit code, and put them in every assertion message.
2. Then probe **once** with `sbx run --name t2 -- true` and assert exit 1 and `/sandbox t2 is already running \(pid \d+\)/`. Also assert the first run is still alive (no exit yet). Kill it in `finally` as today.
3. Red: in a scratch copy, delete the `if (pid) return ...already running...` line in `named()` (`src/cli.js:180`). The test must fail. Green: unmodified.
4. Loop the test alone 20x: `node --test --import ./test/setup-env.mjs --test-name-pattern='name that is running is refused' test/named.test.mjs`. Report pass/fail counts. If bwrap or sockets skip in your sandbox, say so: the orchestrator loops it under load in a real shell.

## Done when

- Diff of `test/named.test.mjs`, red then green output, the 20x loop counts (or "skipped here, pending").
- `npm run typecheck` passes.

## Orchestrator verifies

- Reruns the red mutation, then loops the test 20x alone and 20x under parallel load in a real shell. The old test failed 1 in 8 under load; the new one must pass all.
- Full suite 3x, 0 fail 0 skip, on a quiet machine announced to peer sessions.
