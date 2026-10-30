# M3 part B2c brief: the memory bench at 10, 20, 30 and 40 agents (2026-10-30)

Branch `m3`. B2a is committed and B2b sits uncommitted in the tree, which is what this measures. The goal is to replace the estimate ("about 28 agents in the worst case under 80 MB", PRD L463, L496, L536) with a measurement. This is the last piece of M3 part B.

## Rules

- Sonnet writes the code. Do not commit. No docs edits.
- Reuse before adding. `scripts/bench.mjs` is the shipped bench. `poc/m3/rss2.mjs` and `poc/m3/proxy-host.mjs` show the method, but they are throwaway and out of date (they use the removed `hold.shouldHold`): read them, do not import or copy them wholesale. POC code never ships.
- Do not fit the numbers. A reading over 80 MB is a result, so report it. Do not change thresholds, flags or caps to pass.
- The bench needs bwrap, unix sockets and socat. Print a loud SKIP and exit 77 otherwise, as `bench.mjs` does. Never print numbers from a skipped run.

## The method (PRD L536, round 2)

- The proxy runs in its **own child process**, started as the CLI runs it: `node --expose-gc --max-semi-space-size=1`. The parent hosts the sandboxes and the client sockets.
- A reading is `global.gc()` in the child, then VmRSS of the child from `/proc/<pid>/status`, read by the parent.
- The real stack: `createProxy`, `policy.gateFor` in `auto` mode with one gate per agent, `ctx.tools` and the shared `gate.jsonl`. Labels come from a real `loadLabels` over one generated label folder with **170 operations** (write a spec in the temp dir and run the rwxmap CLI with `cwd` in that dir and no `JEV_KEY`; check that it prints `Jev: off`). A real gate file means the tools table is the real size.
- One fresh child process per agent count (10, 20, 30, 40). Do not grow one process, because V8 high-water would carry over between counts.

## The worst case for each agent, all at once

1. One real sandbox (`launch` with `sleep`), measuring walls as `bench.mjs` already does.
2. One parked hold: an unlabelled POST with a 64 KB body. It asks in `auto`, with `timeoutMs: 'never'`.
3. 16 waiting requests, each an unlabelled POST with a 64 KB body. The 17th waiting request must get 429, which proves the line is full.
4. The working slot filled: one more POST whose declared `Content-Length` is 64 KB, with about 60 KB sent and the rest withheld, so the proxy keeps that buffer in memory. Prove the slot is really held (for example a further request from that agent does not reach the gate, or read the proxy's own state if it exposes one), or say why you could not. This is the bench's riskiest assumption: a mistake here makes the number too low.
5. Before the readings, drive 3600 `allow` requests through the proxy across all agents (a labelled GET to a local upstream, with `unsafeTestOnly: { allowLoopback: true }`), so one gate check, one matcher lookup, one `record` line and one annotate have all run many times. This is what `bench.mjs` lacks.

The 3600 requests matter because of B2b: they prove that the audit path does not grow memory.

## What to record, per agent count

- VmRSS at three points: idle after agents join; after the 3600 requests; with the worst case held.
- Also a drift check at one count (20): VmRSS after 3600, then after 7200 more. Growth over about 1 MB is a finding.
- Max and mean walls RSS per sandbox. The gate is 10 MB.
- The agent count where the proxy crosses 80 MB, by straight-line fit across the four points. State that it is a fit.

## Output and exit

- New script `scripts/bench-agents.mjs` with a small child helper next to it, plus an npm script `bench:agents`. Reuse `bench.mjs`'s `/proc` walk by exporting it, or by moving it to one shared helper, rather than copying it. Say which.
- Also check that `npm run bench` still works after B2b (it may use `hold.shouldHold`, or the old `audit.jsonl`). If it is broken, fix it the smallest way and say so.
- Print a markdown table to paste into the PRD. Exit 1 if the reading at 20 agents exceeds 80 MB, or if any walls reading exceeds 10 MB. A count above 20 over 80 MB is a result, not a failure, because the PRD's commitment is 20 agents. Say this in the script header.

## Done when

- Run it for real, once in full, and report the whole table and the exit code.
- A single count may take longer than your 60 s tool limit. Run it in the background with the tool's background option, and do not count a partial run. If you cannot run it at all, stop and hand it to me.
- Report what was reused, how slot-filling was proven, and every assumption.

## Addendum (Oct 30, after the first run): the user's decision

The first run measured 318 MB at 20 agents. The cause was bareguard re-reading the whole shared audit file on every ask (`haltContext`, fixed upstream as ruling #72 in 0.30.0), plus barebox keeping held bodies in memory after spooling them (fixed). With both fixes the worst case measured 99.5 / 114.4 / 124.3 / 143.6 MB at 10 / 20 / 30 / 40 agents, and normal use 84–87 MB. About 53 MB of that is Node's own code, so 80 MB is not reachable.

The user decided:
- The proxy budget is **150 MB in the full worst case at 40 agents**. 80 MB is retired.
- barebox is for **small teams**. **40 agents per proxy is the maximum**, and above that an orchestrator runs more proxies.
- The 40-agent maximum is enforced, not just documented: `addAgent` refuses the 41st agent with an error that names the limit and says to run another proxy. The TCP door's `tcp` agent does not count. `removeAgent` frees a place.
- The bench fails (exit 1) when any proxy reading at up to 40 agents exceeds 150 MB, or any walls reading exceeds 10 MB.
