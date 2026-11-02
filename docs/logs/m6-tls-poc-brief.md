# Brief: M6 POC — proxy memory with every request over a live MITM TLS tunnel

Branch `m6`. The spec is the PRD's M6 section ("Spec (interview with the user, Nov 2)").
This POC is the go/no-go: **does the proxy stay ≤ 175 MB at 40 agents when the traffic
is HTTPS?** It is a POC: it lives in `poc/m6/`, is never imported by `src/`, and is not
shipped. If it passes, the real bench (`scripts/bench-agents.mjs`) is extended in a
separate step.

## What exists (verified by the orchestrator)

- `scripts/bench-agents.mjs` + `scripts/bench-agents-child.mjs`: per agent count, a fresh
  child (`node --expose-gc --max-semi-space-size=1`) runs `createProxy` with real
  `gateFor` (auto mode) and `loadLabels`; every IPC reply follows `global.gc()`; the parent
  reads the child's VmRSS from /proc (`scripts/measure.mjs`: `rssKb`, `treeRss`,
  `waitFor`, `waitSteady`). Sandboxes are real `launch()`es of `sleep`. All traffic today
  is plain HTTP in absolute form over each agent's unix socket (`sockOf[name]`).
- Worst case per agent today: 1 parked hold + 16 waiting + the 18th refused 429, then the
  working slot filled (POST declaring 64 KB, 60 KB sent). Before that, 3600 labelled
  `allow` GETs.
- TLS pieces: `ensureCA` / `certFor` in `src/certs.js`; `startHttps({ key, cert })` in
  `test/fixtures/upstream.mjs`; `createProxy({ upstreamCa, unsafeTestOnly: { allowLoopback,
  resolveUpstream } })` (see `test/proxy.test.mjs` ~line 125 and ~676 for use). A CONNECT
  tunnel's first byte 0x16 → MITM with a minted cert per host; the client must trust
  `proxy.caFile`.
- Secrets: `createProxy({ secrets })` with entries from `loadSecrets` in `src/secrets.js`
  (`{ name, value, hosts, placeholder }`). A placeholder in a request header is swapped for
  the value only after the gate allows the request, only for the secret's hosts, only over
  TLS upstream. Held requests are not swapped until approved — so swaps happen on the
  allow phase.

## What to build (`poc/m6/`)

Copy `bench-agents.mjs` and its child into `poc/m6/` (`tls-bench.mjs`, `tls-child.mjs`)
and change only what HTTPS needs. Keep every measurement rule of the original (fresh child
per count, GC before each reading, VmRSS of the child pid, sandboxes in the parent).

1. **10 hosts** `h0.test` … `h9.test`, all resolved by `resolveUpstream` to `127.0.0.1`,
   served by one local HTTPS upstream that presents a cert valid for each name (e.g. an
   `SNICallback` that uses `certFor` per host, signed by a CA passed to the proxy as
   `upstreamCa`). Labels: the rwxmap spec's server and the `tenants` entry use these
   https hosts so labelled allows still count as labelled.
2. **One secret** `BENCH_KEY` with `hosts: ['h0.test' … 'h9.test']`; every allow GET sends
   `authorization: Bearer <placeholder>`. Count swaps (the `secret` annotate lines in the
   audit, or a stats counter in the child) and assert every allow was swapped.
3. **Allow phase over TLS:** each agent keeps a keep-alive TLS tunnel per host it uses
   (CONNECT `hN.test:443` over its unix socket, then `tls.connect({ socket, servername,
   ca: proxy CA })`), 3600 GETs spread as today.
4. **Worst case over TLS:** every parked, waiting, refused (429), control, filler and
   probe request is sent inside its **own** CONNECT + TLS tunnel (one tunnel per request,
   hosts round-robin), so at 40 agents about 720+ live TLS sessions are open at the worst
   reading. Keep all the original assertions (pending === n, exactly one 429 per agent,
   slot held, filler + probe reach the gate) — adapted to TLS. Assert the live tunnel
   count at the worst reading (e.g. count of open client TLS sockets that completed the
   handshake) and print it.
5. **Readings per count (10, 20, 30, 40):** idle, after 3600 TLS allows, worst case held
   over TLS. Also run the **plain-HTTP original once at 40** in the same session for the
   side-by-side (`npm run bench:agents` is fine for that, or the copied plain path).
6. **Where the memory goes** at 40 agents worst case: from the child, report
   `process.memoryUsage()` (rss, heapUsed, external, arrayBuffers) and the number of
   minted certs held; enough for the orchestrator to split TLS buffers vs cert cache vs
   other if the number is high.

## Output

A table like the original's, plus columns: live TLS tunnels at worst, swaps counted,
`external`/`arrayBuffers` at worst. Exit 1 if any proxy reading > 175 MB or walls > 10 MB
(same gate as the bench) — printed as `POC FAIL`/`POC PASS`. The POC can fail: that is
the point.

## Constraints

- The machine is shared with other Claude sessions. Before each full POC run: check
  `cat /proc/loadavg` (1-min < 15). Run the POC itself **at most once** while developing at
  40 agents; iterate at 10 agents. Never run the test suite or `npm run bench*` in parallel
  with it. The orchestrator does the recorded runs.
- No changes under `src/` or `test/`. If the POC can't be built without a src change
  (e.g. a missing test seam), stop and report what and why.
- Socket paths cap at 107 bytes: keep runtimes under `/tmp/bb-…` as the bench does.
- Do not commit.

## Report

The table from one 10-agent run and (if load allows) one full 10/20/30/40 run, the memory
breakdown at the largest count reached, the live tunnel and swap counts, and anything that
behaved unexpectedly (handshake failures, 429 counts off, timeouts).

## How the orchestrator verifies

1. Read the POC diff against the original bench: only HTTPS changes, same measurement rules.
2. Check that the tunnels are real: the live TLS count at the worst reading, and that the
   proxy minted certs for the 10 hosts.
3. Re-run the full POC myself (load < 15, peers told), plus `npm run bench:agents` for the
   plain side-by-side.
4. Record the numbers in the PRD M6 section and `docs/logs/findings.md`.
