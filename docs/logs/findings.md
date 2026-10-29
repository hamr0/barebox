# Findings: experiments and why

Contract: the [PRD](../product/agent-sandbox-prd.md) is the spec — problem, goal, modules,
verdicts. This file holds the experiments behind the verdicts: setup, numbers,
dead ends, and why each decision went the way it did.

## M0 — walls + front door (PASS Oct 26)

Harness `poc/m0/` on the dev box (no internet; local `http.server` upstream),
runtime `/tmp/sbx-m0`. 20 idle sandboxes, bypass suite, 5-break red-team.

- Walls-only overhead: mean 7.7 MB, max 7.9 MB (target ≤ 10). Bare proxy 52.1 MB.
- Cold start 10 ms. Bypass set all fail closed (exits 6/7, zero routes).
- Red-team 8/8 detections: nonet, nolock, rw (canary cleaned), miswire,
  fat sandbox metered 69.5 MB. Thresholds/scopes never moved.
- Gotcha that bit: bwrap root needs `/lib64 -> usr/lib64` or every dynamic
  binary dies with `No such file or directory` (proven red/green).
- Why own walls over srt: ~8 MB vs ~100 MB per sandbox (measured, PRD table).

## M1 — proxy sees inside HTTPS (PASS Oct 26)

Harness `poc/m1/`. Local self-test on dev box + real-internet run on federver
(Fedora 43, rootless Node v22.23.4, no sudo).

- Matrix: curl, node, python-requests GET+POST all 200 through the MITM;
  `git ls-remote` over https through the proxy. Log shows method, URL,
  headers, body for every request.
- Proxy RSS: 60.2 MB local, 56.7 MB real (target ≤ 80; bare baseline 52.1).
  TLS costs ~4–8 MB. Go/no-go (a)2 + (c) met.

### Why openssl, not node-forge

M1 is graded on proxy RSS. A subprocess that exits costs zero resident
memory; a resident library bills every byte against the 80 MB bar. openssl
3.5.9 was already on the box. Accepted cost: platform coupling — each future
platform must prove cert generation works (macOS ships LibreSSL, Windows has
no native binary). PRD updated.

### Why federver, not local-only

The dev box has no outbound internet/DNS, so real CA chains and real servers
were untestable there. Local echo-server self-test proved the mechanics;
federver proved fidelity. Same-IP egress was a non-issue. The user runs all
remote commands (my sandbox has no keyring, no network); every block is
inspectable before pasting; no credentials involved.

### Bugs the harness caught (all fixed, all in-repo)

1. Upstream TLS used system roots against our self-signed echo server → 502.
   Fix: proxy takes an upstream-CA argument (empty = system default).
2. Matrix invoked clients by bare name; they live in `poc/m1/`. Fix: resolve
   the harness dir from `$0`.
3. Runner printed PASS after MATRIX FAIL. Fix: `|| exit 1` on every step —
   a harness that cannot fail proves nothing.
4. `import ... from 'undici'` is not resolvable on stock Node. Fix: rewrote
   the node client on stdlib `net`+`tls` (CONNECT by hand). No new dependency.
5. `openssl req -x509` rejects `-extfile` on this build. Fix: CSR +
   `openssl x509 -req` (the same shape the leaf path already used).
6. `tls.connect({socket})` defaults `host` to `localhost` → identity check
   fails. Fix: pass the real hostname.
7. Python 3.14 refuses CAs without extensions (`key usage` missing). Fix:
   real CA extensions (basicConstraints, keyUsage, SKID/AKID) and leaf
   extensions (serverAuth, SAN). Product-correct, not test-only.
8. Truncated response bodies (IncompleteRead). First theory (write+destroy
   race) tested red — rejected. Real cause: response framing never checked
   `buffer.length >= needed`, so split arrivals truncated. The log looked
   complete while the client starved. Fix: the length guard.
9. Keep-alive reuse broken (adversarial review + live git log agreed): a
   second request on one tunnel was forwarded into an already-destroyed
   upstream — logged, never answered. Fix: upstream is now per-request,
   tunnel stays open; python client uses a Session so the reuse is covered.
10. `requests.Session` honors sandbox proxy env over explicit config, so the
    python leg hit the wrong proxy (502 "Bad Gateway" from elsewhere).
    Fix: `trust_env = False`. The hostile env stays as a precedence test.
11. Stale test servers made negatives fail spuriously — and no-CA "PASSED"
    for the wrong reason (dead echo also refuses). Fix: echo-liveness gate
    aborts the round when the fixture is down; plaintext moved to :18080;
    runtime dir is pid-suffixed.
12. Single-threaded echo blocked on an idle aborted upstream, wedging later
    tunnels (reproduced deterministically). Fix: threaded echo; proxy frees
    the upstream the moment the client goes away.
13. Real mode never passed the test CA to the proxy (it was wired for local
    only), so every echo leg failed with "unable to verify the first
    certificate" — while positives stayed green and masked it. The
    echo-liveness gate caught the rot. Fix: proxy trusts system roots AND
    the test CA together. M1 real PASS Oct 26 ~21:05: full matrix + peak
    RSS 63.1 MB. Go/no-go (a)2 + (c) met.

## M2 — hold and ask (PASS Oct 26, local only)

Harness `poc/m2/` + hold mode in the M1 proxy + `sbx.mjs` CLI. Holds park
before upstream contact, so real internet adds zero evidence; echo doubles
as upstream everywhere. Decisions (all signed in scoping): path-substring
placeholder trigger (M3 replaces it, no sibling imports in M2); 120 s
default with `never` supported; 2 concurrent holds proven; 1 MB cap denied
loud at the door, never queued (approving unseen bytes breaks the doorman's
promise); log line + `sbx pending/approve/deny` over unix socket (my sandbox
blocks unix binds — M2 runs in a real terminal).

1. 2 MB bodies don't fit argv (`Argument list too long`). Fix: bodies travel
   over the wire from a file — the only path the product ever sees.
2. The M1 10 s tunnel idle timer reaped a 30 s hold (queue fine, tunnel
   dead). Fix: a parked tunnel disables the idle timer; settle always ends
   or destroys the socket, so no path leaks.
3. `deny()` wrote then destroyed, risking truncated reasons. Fix: flush+FIN
   with the reason as the body — every deny now arrives readable.
4. Depth 3, double-decide, unknown ids, malformed input: all answered loud,
   none applied twice, proxy survives garbage. The plain-HTTP path had the
   same unguarded-target crash the CONNECT path once had; fixed the same way.
5. Over-cap fate doctrine: denied at the door with the reason on a live
   connection. The agent loses nothing — files, plan and state untouched —
   and the reason tells it what to do instead (split the payload). Fail
   closed, never silent; 1 MB is a POC value.

### Dropped, not decided

- Branch protection: first dropped, then applied Oct 26 mirroring bareguard.
- GitHub About description + topics: set Oct 26 via `gh`.
- npm trusted-publisher: needed before the first Actions dispatch.

## M3 — memory with bareguard (round 1, Oct 29)

POC `poc/m3/rss.mjs`, run in a real shell with bwrap, socat and unix sockets, nothing
skipped. Three runs by a worker and one by the orchestrator, matching within 1 MB. One
process, GC forced from row 1d. Means:

| Stage | RSS MB | Delta |
|---|---|---|
| baseline held (gc) | 78.0 | 0 |
| + bareguard 0.28.0 import | 81.5 | +3.5 |
| + 20 gates built + init (one per agent) | 82.6 | +1.1 |
| + 360 gate.check() | 86.8 | +4.2 |
| + rwxmap match.js import | 86.9 | +0.1 |
| + 360 matchOperation() | 90.9 | +4.0 |
| + 20 held 64 KB bodies | 91.6 | +0.7 |
| + 100 held 64 KB bodies | 96.7 | +5.1 |
| + 360 held 64 KB bodies | 112.9 | +16.2 |

Sandbox walls unchanged: mean 7.8 MB, max 7.9–8.0 MB.

Reading: as measured, bareguard alone takes the proxy over 80 MB. Bodies are the swing
factor, and the global buffered-body limit bounds them (replaced in round 2 by two body slots per agent).

Two known flaws in round 1, fixed in round 2 below:

- The "proxy" RSS includes the client side (360 client sockets, child handles), which in
  production live in the sandboxes.
- Per-call deltas may be V8 heap high-water, not retained state.

Lesson: measure the proxy in its own process before sizing a budget from it.

## M3 — memory, round 2 (Oct 29)

POC `poc/m3/rss2.mjs` + `proxy-host.mjs`. The proxy runs in its own child process. The
parent hosts the 20 sandboxes and the 360 hold sockets, and reads the child's VmRSS from
/proc after the child forces GC. 2 variants x 3 runs, real shell, nothing skipped, all
exit 0. The orchestrator reran variant B once, within 0.4 MB. Means, VmRSS MB:

| Stage | default node | --max-semi-space-size=1 |
|---|---|---|
| idle | 60.6 | 58.9 |
| 10 certs minted | 69.7 | 66.1 |
| held: 20 agents x (1 parked + 16 waiting) | 74.7 | 71.2 |
| + bareguard 0.28.0 import | 77.8 | 74.4 |
| + 20 gates | 79.9 | 75.0 |
| + 360 check() | 84.6 | 75.2 |
| + 3600 check() total | 85.1 | 75.8 |
| + rwxmap match import | 85.2 | 75.9 |
| + 360 matches | 90.3 | 76.3 |
| + 3600 matches total | 90.5 | 76.4 |
| + 20 held 64 KB bodies | 91.6 | 77.3 |
| + 100 bodies | 96.6 | 82.3 |
| + 360 bodies | 112.9 | 98.6 |

Readings:

- Round 1's 78.0 baseline included the client side. The proxy alone is 74.7 (default) /
  71.2 (flag).
- The per-call growth is one-time V8 young-generation high-water, not retained state:
  heapUsed after GC rose only ~0.2 MB over 3240 extra calls.
- `--max-semi-space-size=1` caps the young generation at 1 MB and removes most of it
  (first 360 checks +4.7 to +0.2 MB; first 360 matches +5.1 to +0.4 MB). Its CPU cost is
  not measured yet.
- Bodies live off-heap. The flag does not change them (64 KB each).
- Split, with the flag: about 70 MB fixed (Node + proxy + certs ~66, bareguard + rwxmap
  ~4) plus about 0.34 MB per agent in the worst case (gate ~0.03, 1 held + 16 waiting
  ~0.25, one 64 KB body ~0.06). An estimate from the 20-agent point, assuming linear
  growth; not measured at other counts.

bareguard's answers (from the bareguard session):

- One Gate per agent is deliberate: the grant comes from gate config, never from the
  action. About 55 KB each.
- A lighter bareguard entry would save ~0: gate.js imports every primitive.
- Fileless audit mode keeps every line in memory, so always give the gate a file path.
- Build all gates from ONE shared tools object.

Lessons: measure the proxy in its own process; force GC and read heapUsed to tell retained
state from high-water; repeat calls to see a plateau.

## M3 — part A results (Oct 29)

Built: card scanner (`src/cardscan.js`), the one config file, the semi-space flag in the
CLI's first line, `scripts/latency.mjs`. Full suite 350/350 three times in a real shell,
0 skip; typecheck clean.

Latency with and without `--max-semi-space-size=1` (`scripts/latency.mjs`, 2000 requests,
3 runs):

- p50: the same (about 0.8–1.0 ms).
- p95/p99: up to about 0.5 ms slower with the flag in 2 of 3 runs, the same in the third.

Card scanner, found in review and fixed: a card followed by a CVV was missed. The greedy
match ran into the CVV digits and Luhn failed on the longer run. Fixed so the scanner finds
the card when a CVV follows.

Why large bodies are not checked: random 16-digit numbers starting 2–6 pass Luhn about 1
time in 10. Denying on a hit would break uploads full of ids. Bodies over 64 KB stream
through unchecked for card numbers (known gap).

## M3 — B1 gate wiring (Oct 29)

Part B1 puts bareguard 0.29.0 in front of every request. Brief: `docs/logs/m3-b1-gate-brief.md`.

Design as built:
- One gate per agent (and one for the TCP door's `tcp` agent), built by `policy.gateFor` from one shared tools table (`src/policy.js`). The mode only picks the letters and `askUnheld`.
- barebox's hold queue is each gate's `humanChannel`. A request gets a barebox id (`rid`) that goes in the gate action; the channel looks the request up by `event.action.rid` (`src/proxy.js` `askHuman`). Inside `check()` the channel reserves the agent's hold slot, spools the body to `held/<id>`, frees the working slot and parks. A full line answers 429 `hold queue full`.
- Bodies of 64 KB or less are read in the agent's working slot before the gate decides, so the card scanner can set `cardLike`. The body never goes in the action, since bareguard writes the action to its audit file.
- A plain object with `check()` can stand in for a Gate (tests do); `askHuman` from it goes to the same channel.

Smoke test (orchestrator, real internet): `sbx run --mode auto --json -- bash -c 'curl https://example.com/; curl -X POST -d q=1 https://httpbin.org/post'`. The GET returned 200. The POST parked as ask h1 (rule `rwx.ask`, letter `x`, bodyPreview `q=1`). `sbx deny h1` gave 403 on the POST. Events were ask, decided, done, exit 0. `gate.jsonl` held 1 `rwx.allow` and 2 `rwx.ask` lines (the gate phase and the approval phase of the one ask). Suite 398/398 three times in a real shell; typecheck clean.

Concurrent audit writes (20 gates, one `gate.jsonl`): safe by reading, not stress-tested. bareguard's audit writer appends each line with one `appendFile` in append mode on Linux (`node_modules/bareguard/src/primitives/audit.js:575`) and caps a line at 3500 bytes (`MAX_LINE_BYTES`, `audit.js:11`), under the 4096-byte PIPE_BUF its comment cites. The code comment relies on the kernel keeping such appends whole. One file per agent was not needed on that reading; a concurrent stress test is in the fix ledger.

Still separate: barebox's `audit.jsonl` and bareguard's `gate.jsonl`. They merge in B2.
