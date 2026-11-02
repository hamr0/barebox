# Brief: M6 — one MITM TLS context per host, and the HTTPS bench as the gate

Branch `m6`. The spec, the POC numbers and the user's decision are in the PRD's M6 section
("POC result" and "Decision (user, Nov 2)"). POC code is in `poc/m6/` and is **not** shipped:
read it for mechanics, write the real code fresh.

## Part 1 — cache the MITM SecureContext per host (`src/proxy.js`)

Today, around `src/proxy.js:966-975`, every TLS tunnel calls `certFor(certDir, host)` (two
`readFileSync`s from disk) and then `new tls.TLSSocket(sock, { isServer: true, key, cert })`,
which builds a new SecureContext from PEM per tunnel. Measured cost: ~37 MB at 40 agents in the
HTTPS worst case (PRD table, last two rows).

Change:
1. One `Map` per proxy (inside `createProxy`, beside the other per-proxy state), host →
   `tls.createSecureContext({ key, cert })`. On a hit, skip `certFor` entirely. On a miss,
   `certFor` as today, build the context, store it, then use it. A mint failure keeps today's
   path exactly (log the 502 deny, destroy) and stores nothing.
2. `new tls.TLSSocket(sock, { isServer: true, secureContext })`.
3. Bound it: at most 256 hosts; on overflow delete the oldest entry (`Map` insertion order).
   One constant, named, with a one-line why (agents that browse many hosts must not grow the
   proxy without limit).
4. Certs are valid 825 days and never re-minted while their files exist, so a context never
   goes stale within a proxy's life. Say so in one comment line.
5. No API change, no new option.

Tests (`test/proxy.test.mjs`), each shown red then green:
- **T1 one context per host:** count calls to `tls.createSecureContext` (the proxy uses the
  default `import tls from 'node:tls'`, so wrapping the exported property counts both the
  explicit call and Node's internal one from `TLSSocket`; restore it in `finally`). Open 5
  MITM tunnels to the same host one after another, each completing a request: before the fix
  the count grows by 5 (or more), after it by 1. Assert the exact delta. Then one tunnel to a
  second host: +1.
- **T2 still correct:** the 5 tunnels each get a valid cert for that host (handshake verifies
  against the proxy CA with `servername`), and the request round-trips.
- **T3 the bound:** with the cap lowered for the test (export the constant only if needed; a
  test-only option is not wanted — if the bound can't be tested without one, say so and
  test it by reading the code path instead, and tell the orchestrator).
Red proof: in a scratch copy (never the repo tree) with `src/proxy.js` at the branch base.

## Part 2 — `bench:agents` measures the HTTPS worst case (`scripts/bench-agents*.mjs`)

Rewrite the bench's traffic to HTTPS, following the POC's mechanics but clean:
- 10 hosts `h0.test`…`h9.test` via `unsafeTestOnly.resolveUpstream` → `127.0.0.1`; one local
  HTTPS upstream with per-host SNI certs from its own CA.
- **Production trust path:** the bench forks the proxy child with
  `NODE_EXTRA_CA_CERTS=<upstream CA pem>` and passes **no** `upstreamCa` (that option builds a
  context per upstream connection and inflated the POC by ~40 MB; production never sets it).
- One secret bound to the 10 hosts, sent as a placeholder header on every allow; assert every
  allow was swapped (upstream sees the real value 3600/3600, never the placeholder).
- Allow phase: keep-alive CONNECT+TLS tunnel per (agent, host). Worst case: every parked,
  waiting, refused, control, filler and probe request in its own CONNECT+TLS tunnel. Keep every
  existing assertion (pending === n, one 429 per agent, slot held, filler and probe reach the
  gate). Print live TLS tunnels at the worst reading.
- `MAX_PROXY_MB = 230`; walls still ≤ 10 MB. Update the header comment: the budget is about
  200-230 MB in the full HTTPS worst case at 40 agents (PRD, Nov 2), and why TLS.
- Plain-HTTP traffic is no longer the bench; don't keep a second mode.
- The upstream port is not 443 (unprivileged); CONNECT and Host carry `hN.test:<port>` as in
  the POC. Fine.

## Constraints

- Machine is shared with other sessions: check `cat /proc/loadavg` (< 15) before any bench run;
  run the bench **at most twice** (one at 10 agents via a temporary local edit is fine for
  iteration — revert it), never in parallel with a test file or another bench. The orchestrator
  does the recorded full run and the suite 3x.
- Test files: single files only (`env -u ...proxy vars... node --test --import ./test/setup-env.mjs test/proxy.test.mjs`), 0 skipped.
- Also run `npm run typecheck`, `npm run build:types`, `npm run check:primitives` (CI runs all
  three; `primitives.json` is generated from JSDoc — rebuild with `npm run build:primitives` if
  you change any JSDoc) and report exit codes.
- Don't touch README / PRD / context docs (the orchestrator updates them with the recorded
  numbers). Don't commit.

## Report

Diff stat; T1-T3 red then green output; single-file totals; the three CI-step exit codes; one
bench run's table (the agent counts you ran) with live TLS count and swaps; anything off.

## How the orchestrator verifies

1. Read the diff: the cache is one Map, bounded, used only at the MITM spot.
2. Re-run T1 red in a scratch copy.
3. Recorded `npm run bench:agents` (load < 15, peers told): pass at ≤ 230 MB at 40 agents.
4. Full suite 3x, 0 fail 0 skip; typecheck, build:types, check:primitives exit 0.
5. Then the docs (PRD numbers, README budget lines, findings) and commit.
