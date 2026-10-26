# Findings: experiments and why

Contract: the [PRD](agent-sandbox-prd.md) is the spec — problem, goal, modules,
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

### Dropped, not decided

- Branch protection: first dropped, then applied Oct 26 mirroring bareguard.
- GitHub About description + topics: set Oct 26 via `gh`.
- npm trusted-publisher: needed before the first Actions dispatch.
