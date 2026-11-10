# Ledger triage: the three items found during M8/M9 (2026-11-10)

Rule used: fix what is confirmed and hits a normal user on a laptop or VPS; every claim below has a repro run in a real shell.

| # | Item | Verdict | Why |
|---|---|---|---|
| 1 | Bench dies with "Client network socket disconnected before secure TLS connection was established" | **Fix (proxy bug, not bench)** | Reproduced 20/20 rounds: a cert read during another tunnel's mint gets a half-written file. Hits any agent that opens parallel connections to a new host (`npm install`, `git clone` + API calls). |
| 2 | rwxmap classifier runs on every unlabelled request | **Leave (nit)** | About 65 µs per request on a quiet machine, small next to a TLS request; the clean fix is upstream (key-only `match()`, not planned by rwxmap). Stays in the ledger for `/refactor`. |
| 3 | 2 MB over-cap POST gets curl `100` instead of `403` | **Fix, POC first** | Reproduced: 2 of 96 and 1 of 96 runs of the test 12-way parallel (load ~40); 0 of 56 at lower load. The mechanism below is a hypothesis until step 3.1 shows it. |

## Fix 1: certs are read only when complete

**Evidence.** `src/certs.js` `certFor` returns the files when `existsSync(key) && existsSync(cert)`, and checks `inflight` only after that. `mint` writes both files in place: `openssl genrsa -out <host>.key` and `openssl x509 ... -out <host>.pem`. A second CONNECT to the same host that arrives while `x509` is writing sees both files, skips `inflight`, reads a partial or empty `.pem`, and `tls.createSecureContext` throws `error:0480006C:PEM routines::no start line`. `src/proxy.js:979-983` logs `no cert for <host>` and destroys the socket after the 200 is sent, so the client sees a TLS disconnect.

Repro (`scratchpad/ledger/mintrace.mjs`): one `certFor` plus a new uncached `certFor` to the same host every 0.5 ms while it mints: **20/20 rounds, 56 of 3745 reads failed**.

`ensureCA` has the same in-place writes (`ca.key`, `ca.pem`) and no in-flight guard. The concurrent case is unreachable: the proxy awaits `ensureCA` before it listens (`src/proxy.js:1003`) and one proxy owns a runtime. The crash case is reachable: a kill during `x509` leaves a partial `ca.pem`, and every later start trusts it because it only checks `existsSync(ca.pem)`.

**Steps.**
1. In `mint`: write the key and cert to temp names in the same dir (`<host>.key.tmp`, `<host>.pem.tmp`), then `renameSync` the key into place, then the cert. The cert's final name exists only when the pair is complete. Clean up temp files on failure.
2. In `certFor`: check `inflight` before the file check.
3. In `ensureCA`: the same temp-then-rename, key first, cert last.
4. No other file changes. One writer of cert files stays `certs.js`.

**Tests, each red then green.**
- The repro as a test in `test/certs.test.mjs`: a fresh dir, one mint plus uncached same-host calls on a 0.5 ms timer until the first resolves; every call's result passes `tls.createSecureContext`. Red today (paste the PEM error), green after.
- A mutation that renames the cert before the key, or writes the cert in place again, turns it red.
- Crash case: a dir with `ca.key` and a partial `ca.pem.tmp` but no `ca.pem` (what a killed run leaves after the fix) gets a fresh CA that `tls.createSecureContext` accepts. Red-then-green is shown with a mutation (write `ca.pem` in place again, kill mid-write via an injected partial file): the partial CA is then trusted.
- `npm run bench:agents` 9 times after the fix: 0 TLS disconnects (it was 3 of 9 runs before).

**Open question (yours):** an existing runtime that already holds a truncated `ca.pem` from an old crash. Proposed: leave it; the fix stops new ones, and `rm -r` of the runtime's `certs/` recovers. Validating `ca.pem` on every start costs one parse and would also catch it.

## Fix 3: an over-cap upload gets its 403

**Evidence.** In `src/proxy.js` the hold path fails a body over `heldBodyMaxMB` with `fail('body too large to hold')` (lines 596, 620). The deny is written by `denyRes` (`src/proxy.js:268-278`, used at line 788) with `connection: close`, while the client is still uploading. Repro: the `heldBodyMaxMB` test in `test/cli.test.mjs:656`, 12 copies in parallel, 8 rounds: `actual: ['000', '100']`, 1-2 of 96.

**Hypothesis (unproven).** The server closes the socket with upload bytes still unread; Linux answers the unread data with a TCP RST, and the RST makes the client drop the 403 it already received. curl then reports the last status it saw, the `100 Continue`.

**Steps.**
1. POC in a scratch copy, before any change in the repo: keep the socket open after the deny and discard the rest of the body (bounded: stop and close after N MB or T seconds, whichever comes first; the brief picks N and T from the POC). Run the 12-way x 8-round loop 3 times on base and 3 times on the POC, on a machine with the peers holding. The hypothesis holds only if base fails at least once and the POC shows 0 of 288. If base shows 0, the repro is not good enough; report instead of fixing.
2. If it holds: the same drain goes in the one place that writes the deny for a request whose body is not fully read (`denyRes` or its caller), not in each `fail` site. The 429 "hold queue full" and the other mid-upload denies get it too, since they share the path.
3. Bound the drain so a client cannot hold a socket open forever by uploading slowly: the bound is part of the test.

**Tests.**
- The parallel loop as the red/green proof (base red at least once in 288, fixed 0 of 288).
- A unit-level test: a client uploading 2 MB past a 1 MB cap reads the full `403` response before its upload finishes, over a real socket with its own timeout.
- A slow-upload test: a client that keeps sending past the drain bound is cut off by the bound, not held open.

## Order

Fix 1 first (confirmed, cheap, no open mechanism). Fix 3 after its POC, which needs the machine quiet for about 20 minutes. Item 2 stays in the ledger.
