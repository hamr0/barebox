# Rewrite review: M0–M2 graduation (2026-10-27)

Review of the uncommitted rewrite (`src/`, `test/`, `barebox.context.md`, CI) after the M0–M2 POCs passed. Read it top to bottom before changing code. Work the **Must fix** list in order: each item unblocks the next.

Every claim marked **(proven)** was reproduced. The probe scripts are `deadlock.mjs` and `probe.mjs` in the reviewer's scratchpad; rebuild them from the notes here if needed. **(read)** means it was found by reading the code and not yet run.

---

## 0. Why the build keeps hanging

**The tests deadlock themselves.** `test/proxy.test.mjs` and `test/cli.test.mjs` start the proxy *in the test process*, then call `curl` / `sbx` with `execFileSync`. A synchronous child freezes the event loop, so the proxy can never answer:

| Same curl call against an in-process proxy | Result |
|---|---|
| `execFileSync` | curl exit 28 (timed out) after 4031 ms |
| `execFile` (async) | 502 in 26 ms |

curl has `--max-time` so it ends eventually. `sbx` has no timeout, so it hangs forever. `npm test` on the proxy file produced no output in 2 minutes.

The hangs then compound:
- Killed runs leave `echo.py` children holding fixed ports (8443, 8444).
- The next run talks to those stale servers. This is the failure behind findings #11, and it is the same cause.

**Rule:** never call a server living in the test process through a synchronous child. Always `await promisify(execFile)(...)`.

---

## 1. Must fix (in this order)

### 1.1 Test mechanics (unblocks everything else)
1. Replace every `execFileSync('curl'|'node'|'python3'|sbx, ...)` that talks to the in-process proxy with async `execFile`. Fixture setup (`mkcerts`) can stay sync.
2. Delete every `setTimeout(r, N)` that waits for "server is up". Await the readiness promise from 1.2 instead. For the hold tests, poll `pending` until it is non-empty, with a timeout that says what it was waiting for.
3. Use port `0` everywhere and read the bound port back. No hardcoded 3139/3140/3141/8443/8444.
4. In `after()`, always kill fixture children and close proxies, even when a test failed. Wrap everything in `try/finally`.
5. A suite that cannot run must say so through the reporter: `describe(name, { skip: 'unix bind blocked' }, ...)`. An early `return` in an async `describe` reports zero tests as a **pass**.

### 1.2 `createProxy` lifecycle (proven)
- **Binds every interface.** `ss` shows `*:3195`, so any host on the LAN can use a TLS-decrypting proxy with your CA. Bind `127.0.0.1` (and see 1.4: per-agent unix sockets replace the TCP port for agents).
- **No `error` handler.** A second proxy on the same port crashes the process with an uncaught `EADDRINUSE`.
- **No ready signal.** Return `{ ready: Promise<{ port }>, close(): Promise<void>, ... }`.
- **`close()` leaves sockets behind.** It only stops accepting. It must destroy open tunnels, settle every hold as denied, and clear hold timers. Otherwise the process stays alive (a hold with `timeoutMs: 'never'` keeps it alive forever).

### 1.3 Replace the hand-rolled HTTP framing with stdlib (proven + read)
`parseReq` / `respLen` is the spot `findings.md` has patched 12 times. Per CLAUDE.md, a third patch on the same spot means redesign. Current breakage:

| Case | Today |
|---|---|
| `HEAD` | **502 after 6 s** (waits for a body that never comes) (proven) |
| Upstream slower than 10 s | **tunnel killed at 10 s**, curl exit 56 (proven). The client idle timer fires while waiting on upstream. LLM API calls routinely take longer than 10 s. |
| 204 / 304 without `content-length` | 500 "unframed response" (read) |
| Chunked **request** body (git push, streaming uploads) | 500 "pipelining unsupported" (read) |
| Chunked response whose body contains `0\r\n\r\n` | truncated early (read) |
| Plain-HTTP second request on a keep-alive connection | never answered: the `data` listener is removed after the first request (read) |

**Do instead (stdlib only, no new dependency):**
- After the CONNECT 200 and the TLS wrap, hand the decrypted socket to a private `http.Server` with `httpServer.emit('connection', tlsSocket)`.
- Forward each request with `https.request` (plain: `http.request`).
- Node's parser then handles HEAD, 204/304, chunked both ways, keep-alive and pipelining.
- Tee the request body into a buffer for the log (cap it, e.g. 1 MB, and log `truncated: true` beyond that).
- Holds: decide *before* calling `https.request`.
- Timeouts: one for the upstream response (configurable, default ≥ 120 s) and a separate client-idle timeout that is **paused while a request is in flight**.

The plain-HTTP path goes through the same `http.Server` handler. Do not keep a second code path.

### 1.4 Wire the launcher to the proxy: identity = socket (read)
The PRD says the per-agent unix socket *is* the agent's identity. Today:
- `launch()` binds `<runtime>/socks/<agent>.sock` but nothing in `src/` creates it.
- `createProxy()` listens on one TCP port and names clients `c1`, `c2`, … per connection.

So the public API cannot run a sandboxed agent through the proxy, and identity is lost.

Fix:
- The proxy owns the agent listeners. Add `proxy.addAgent(name) → socketPath` (listens on `<runtime>/socks/<name>.sock`) and `proxy.removeAgent(name)`.
- Every log line and every hold carries `agent: name`, never `c<n>`.
- `launch({ ..., socket })` takes the path `addAgent` returned, so the two pieces cannot disagree about the path.
- Validate the agent name (`^[a-z0-9][a-z0-9-]{0,31}$`) to stop `../` reaching the socket path.
- Check the ~108-byte unix socket path limit up front, and throw with the path and its length. This is a known PRD gotcha.
- Keep the TCP listener only as an opt-in for tests, bound to `127.0.0.1`.

### 1.5 The sandbox must trust the CA (read)
`launch()` sets the proxy variables but no CA trust variables, so every HTTPS call from inside fails verification. The library has never been run end to end.
- Set `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` to a CA file bound read-only into the sandbox.
- `SSL_CERT_FILE` *replaces* the system bundle, so use a combined bundle (system roots + barebox CA). This is the same lesson as commit `6ffb87a`.
- **Never** bind the CA *key* into the sandbox. Only `ca.pem`.

### 1.6 Mint certificates on demand, in `src/` (read)
`certDir` must be filled in advance by `poc/m1/mkcerts.sh`, which does not ship. Any host without a ready-made cert gets `502 no cert`, so a real agent dies on its first unfamiliar domain.
- Add `src/certs.js` with `ensureCA(dir)` and `certFor(host)`: an `openssl` subprocess (the PRD decision), cached on disk, de-duplicated with a per-host promise so concurrent CONNECTs mint once.
- Use the real extensions that M1 bug #7 proved necessary.
- Key files get mode `0600`.
- Re-measure proxy RSS after this. It is a go/no-go number.

### 1.7 Holds: two safety bugs (read)
- **Plain HTTP bypasses the hold queue.** `handlePlain` never checks `hold.match`, so `POST http://…/checkout` forwards with no human asked. Section 1.3's single handler fixes this. Add a test for it.
- **A hold outlives its client.** If the agent disconnects or gives up, the entry stays queued, and a later `approve` still sends the irreversible request upstream with nobody listening. On client close, remove the hold and log `ev: 'hold-abandoned'`. `approve` on a gone hold returns `unknown <id>`.
- Make the hold rule a function, `shouldHold(req) → reason | null`, instead of `hold.match` path-substring config. M3 plugs rwxmap + bareguard into that one seam without touching the proxy. The path substring becomes the default implementation in tests.

### 1.8 CI cannot pass as written (proven)
- `npm ci` needs `package-lock.json`, and there is none. Commit the lockfile.
- Install `socat` (and `curl`, `openssl`, `python3` if the runner lacks them) next to `bubblewrap`.
- `npm run typecheck` was not verified: no `node_modules` on the review machine. Run it and fix what it finds before anything else in CI.

---

## 2. Should improve

1. **Types (LIBRARY_CONVENTIONS §2, trap 1).** `@param {object} opts.extraEnv`, `holds: Map`, and the generated signature `createProxy(opts: object)` give adopters and `primitives.json` nothing. Use `@typedef` for the options and `Record<string,string>` for env. Let `tsc` infer the returned object and export it as `@typedef {ReturnType<typeof createProxy>} Proxy`. Do not expose the raw `holds` Map. Expose `pending()`, which returns plain objects.
2. **`barebox.context.md`.** Follow `CONTEXT_TEMPLATE.md`: All options, Public API, Architecture, What's NOT in barebox, **Threat model**, **Gotchas** (socket path limit, `/lib64` symlink, userns sysctl on Ubuntu, CA trust vars). Fix the quickstart: `npx barebox --help` is wrong, because the bin is `sbx` and it has no `--help`.
3. **CLI.**
   - Add a 5 s connect/response timeout.
   - Add a real `--help` that does not touch the socket.
   - Exit codes: 0 ok, 1 unknown id / refused, 2 usage.
   - Make the control protocol JSON lines both ways, not space-split text.
   - Default `SBX_SOCK` to `<runtime>/ctl.sock`, not `./sbx-ctl.sock`. The relative path depends on the shell's cwd.
4. **Control socket.** Create it with mode `0600`. Anyone who can connect can approve payments.
5. **Audit log.**
   - `appendFileSync` on every request blocks the proxy. Use one `fs.createWriteStream` with `flags: 'a'`.
   - Bodies are logged in plain text. That is fine until M5, but put the redaction hook in the same writer now, because real keys arrive in M5.
6. **Tests depend on `poc/`.** `mkcerts.sh` and `echo.py` are throwaway by rule. Move what tests need into `test/fixtures/`. The upstream fixture can be a Node `https.createServer` in-process, which drops the Python dependency, the stale-process problem and the fixed ports at once.
7. **`docs/product/primitives-manifest-spec.md`** (526 lines) is a generic suite spec, not barebox. Keep it in one shared place (bareguard or the profile repo's conventions) and link it.
8. **Test gaps to add:**
   - `curl` without the CA asserts **exit 60** (certificate rejected), not just "throws". Today it also passes when the proxy is down.
   - HEAD; a slow upstream (> 10 s, using a fake-timer-free fixture with an `/slow?ms=` route); plain-HTTP keep-alive; plain-HTTP hold; body over `maxBody`; client disconnect while held; `close()` with an open tunnel and a parked hold, after which the process must exit.
   - The M0 bypass set inside a real sandbox: `--noproxy`, env unset, direct IP, the host's localhost. All must fail.
   - **One end-to-end test**, the only one that proves the product: `addAgent` → `launch` → curl inside the sandbox to the fixture → logged with the agent's name; then a held POST → `sbx approve` → 200.

---

## 3. Better flow

The rewrite ported each POC file to a library file (mitm.cjs → proxy.js, launch.sh → launcher.js) and tested each alone. The pieces were never joined, which is how 1.4 and 1.5 slipped through. Build outward from the end-to-end path instead.

### Target layout (small files, one writer per piece of state)

| File | Owns | Writes |
|---|---|---|
| `src/certs.js` | CA + per-host certs on disk | cert cache |
| `src/proxy.js` | agent listeners, CONNECT, TLS wrap, `http.Server` handler, forwarding | per-agent socket set, open tunnels |
| `src/holds.js` | hold queue, timers, control socket | the queue (only `holds.js` adds or removes entries) |
| `src/launcher.js` | bwrap argv, CA + proxy env | nothing shared |
| `src/cli.js` | `sbx` | nothing |
| `src/index.js` | barrel | — |

### Order
1. **Test harness first (section 1.1).** No new feature until `npm test` finishes in seconds and fails loudly.
2. **`certs.js`** + test: mint, cache, concurrent mint once, `0600`.
3. **`proxy.js` on stdlib `http`** (1.2, 1.3) over a localhost TCP listener. Port the M1 matrix: curl/node/python GET+POST, HEAD, chunked, slow, keep-alive.
4. **Per-agent unix listeners + identity** (1.4). Re-run the matrix through a unix socket using `socat` in the test.
5. **`holds.js` + `shouldHold` seam** (1.7) + CLI (section 2.3). Port the M2 tests: approve, deny, timeout, abandoned, plain-HTTP hold.
6. **`launcher.js`** with CA env (1.5) + walls tests + the M0 bypass set.
7. **End-to-end test** (section 2.8, last item). Only now is M0–M2 "graduated".
8. **Re-measure** with the end-to-end setup: walls ≤ 10 MB per sandbox and proxy ≤ 80 MB with TLS + minting, 20 agents. Record the numbers in the PRD. The POC numbers do not carry over to new code.
9. Types, `context.md`, `primitives.json`, CI (1.8, 2.1, 2.2).

Each step: works alone, then works joined to everything before it, then the next step starts.

---

## 4. Done when

- [ ] `npm test` completes with no sleeps, no fixed ports and no leftover processes (`pgrep -f echo.py` empty afterwards); a deliberately broken proxy makes it fail, not hang.
- [ ] Proxy binds nothing outside `127.0.0.1` / the runtime dir (`ss -ltnp` checked).
- [ ] HEAD, 204, chunked request + response, keep-alive, and a 30 s upstream all pass through.
- [ ] Any hostname works with no pre-made certs.
- [ ] Every log line and hold names the agent by its socket, not `c<n>`.
- [ ] Plain-HTTP and HTTPS holds both park; a disconnected client's hold is dropped and never forwarded.
- [ ] End-to-end: agent in bwrap → proxy → held POST → `sbx approve` → 200, in one test.
- [ ] `close()` lets the process exit with a parked hold and an open tunnel.
- [ ] CI green on a clean runner: lockfile, socat, typecheck, build:types, check:primitives, test.
- [ ] RSS re-measured and recorded in the PRD.

---

## 5. Follow-up: "slow by design" is wrong-reason passing (2026-10-27)

After the rework, the suites were read as "slow by design" and the plan was to raise outer timeouts. **Don't.** Slow negatives are the bug, not the budget.

### Measured
Inside `bwrap --unshare-net`, each of these fails with **exit 7 in ~15 ms**:
- `curl http://192.0.2.1/`
- the same with `--noproxy "*"`
- `curl http://127.0.0.1:1/`

A bypass test that takes 8–20 s is waiting on something else, and still passes because it asserts `! curl ...`. A timeout (exit 28) satisfies `!` exactly like a working wall (exit 7).

### What's wrong in `test/launcher.test.mjs` (M0 bypass set)
- **Every bypass test accepts any failure**, so it cannot tell a wall from a hang.
- **"the host loopback is unreachable from inside" never reaches the wall.** The proxy env is still set, so curl goes to the test's dummy socket server (`net.createServer(() => {})`). That server accepts and never answers, curl waits `--max-time 8` and exits 28, and the test passes.

### Real hole behind it (read)
`src/proxy.js` has no loopback/internal-address rule, and `test/e2e.test.mjs` depends on that: it reaches `https://127.0.0.1:<port>` through the proxy and expects 200. So an agent can reach anything on the **host's** localhost through the front door: Postgres, the Docker API on `:2375` (root-equivalent), dev servers. That contradicts the PRD decision "Localhost sockets (M0): blocked entirely."

### Fix (in this order; do not commit to main before 1–3 are green)
1. **Assert the exact curl exit code**, never `! curl`.
   - Use `curl ...; echo "rc=$?"`, then assert `rc` in the test.
   - Exit 7 (or 6 for DNS) means the wall worked. **Exit 28 (timeout) fails the test.**
   - Set `--max-time 3`, record elapsed time, and assert it is **< 1000 ms**.
2. **Split the loopback test:**
   - a) Direct: proxy env unset or `--noproxy '*'`. Assert exit 7, fast.
   - b) Through the front door: a real `createProxy`, then a request to the host's `127.0.0.1`. It must be **denied by the proxy** (403 with a reason), not forwarded.
3. **Close the hole.**
   - Deny loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, which covers cloud metadata, and `fe80::/10`) and the host's own interface addresses by default.
   - Check **after DNS resolution**, against the IP actually dialled, not the hostname string. Otherwise `localtest.me` → 127.0.0.1 walks through.
   - Add one explicit opt-in (e.g. `allowUpstream: (host, ip) => boolean`) that only the tests use for their fixtures.
4. **Hold tests: test ratios, not wall-clock.**
   - Make client-idle and hold timeouts options.
   - Tests use idle ≈ 500 ms and a hold of ≈ 1.5 s. That proves a parked request outlives the idle timer just as well as 30 s does.
   - No 30 s / 60 s / 120 s waits anywhere in the suite.
5. **Budget and diagnosis.**
   - Target: a full `npm test` in **under ~30 s**.
   - Run files as `node --test --test-reporter=spec --test-timeout=20000 test/<file>`. A stuck test then fails with its own name instead of the whole run hitting an outer kill.
   - List the 5 slowest tests and fix those. Never pad timeouts to make a suite finish.

### Done when (adds to section 4)
- [ ] No test asserts `! curl`; every bypass asserts exit 6/7 and < 1 s.
- [ ] Proxy denies loopback, link-local and host addresses after resolution; test fixtures use the explicit opt-in.
- [ ] Through-the-proxy loopback attempt returns 403 with a reason, and is logged.
- [ ] No test waits more than ~2 s on a timer; `npm test` < ~30 s.

---

## 6. Test coverage review (2026-10-27)

### Measured
Full suite, working tree (includes uncommitted `src/proxy.js` + `test/proxy.test.mjs` changes):

```
node --test --experimental-test-coverage --test-coverage-include='src/**' "test/*.test.mjs"
→ 70/70 pass, 0 skipped, ~7 s
lines 97.0% · branches 72.5% · functions 84.5%   (proxy.js: lines 95.8%, branches 69.4%)
```

The suite is good: it tests behaviour, not lines. Sections 1 and 5 are covered:
- exact curl exit codes
- HEAD, 204/304, slow upstream
- plain-HTTP holds, abandoned holds, `close()` with open tunnels
- certificates minted on demand
- pinned DNS that checks every answer and fails closed
- LAN addresses denied
- one end-to-end run: agent in bwrap → hold → approve

The remaining uncovered lines are low-value branches (`clientError`, a throwing `allowUpstream`, a failing `networkInterfaces()`). Do not chase the percentage.

The gaps below are **behaviours**, not lines. Items 1–3 must land before merging `rewrite` → main.

### 1. HOLE: the agent can approve its own holds (proven)
A read-only bind does **not** stop `connect()` to a unix socket. Measured: a socket listening on the host, `bwrap --ro-bind / /`, and the sandboxed process connected and the host received `approve h1`.

The launcher ro-binds `$HOME` and the project. If `runtime` (holding `ctl.sock` and every agent's `socks/*.sock`) or `controlSocket` sits under either one, the agent can:
- **self-approve** its own held payments via the control socket, which defeats the x-gate;
- **impersonate another agent** by connecting to its socket, which defeats identity.

The tests miss it because they put `runtime` in `/tmp`, and the sandbox replaces `/tmp` with an empty tmpfs.

**Fix:**
- In `launch()`, mask the runtime dir and the control-socket's dir with `--tmpfs` (after the `$HOME`/project binds), then bind only this agent's socket at `/run/sbx/agent.sock`.
- Alternatively, refuse a runtime under `$HOME` or the project, loudly.
- The same class covers any listening unix socket under `$HOME` (IDE IPC, rootless container sockets). State that in `barebox.context.md` gotchas.

**Test:**
- `runtime` and `controlSocket` under the fake HOME.
- From inside the sandbox, `sbx approve <id>` must fail and the hold must stay pending.
- Connecting to another agent's socket must fail.

### 2. Go/no-go (b) is only half tested
The PRD says one request is held "**while other requests from the same agent complete meanwhile**". The hold tests prove park → approve/deny only.

**Test:** park one request, then send two more from the **same agent**, one on the same tunnel and one on a new connection. Both must get 200 while the hold is still pending. Then approve and assert the held one completes.

### 3. Upstream certificate verification has no negative test
The proxy decrypts the agent's TLS and re-encrypts it toward the real server, so the agent is only as safe as the proxy's upstream verification. Node verifies by default. Nothing catches a future `rejectUnauthorized: false` added "to make a fixture work".

**Test:**
- An upstream serving a cert from an unknown CA (not in `upstreamCa`, not in system roots) gets a 502 with a reason, and the request body never reaches it.
- An upstream whose cert names the wrong host also gets a 502.

### 4. Two agents at once
M0 proved no cross-attribution (`fx`/`fy`). The rewrite tests one agent's identity.

**Test:** two agents, interleaved requests, plus one hold each. Every log line and every `pending()` entry carries the right agent name; denying A's hold leaves B's untouched.

### Worth adding (not blocking the merge)
5. **The M1 client matrix isn't fully ported.**
   - Python `requests` and git over https were part of the M1 proof; the suite now runs only curl and node.
   - Add a python test (skip loudly if `requests` is missing).
   - Add an opt-in `npm run test:real` (`git ls-remote` + real hosts), kept out of `npm test` and the merge gate.
6. **Go/no-go (c) hasn't been re-measured.**
   - No benchmark covers the rewritten code with on-demand certificates and holds. The POC numbers (7.7 MB per sandbox, 56.7 MB proxy) do not carry over to new code.
   - Add `npm run bench`, not part of `npm test`: 20 agents, RSS per sandbox and for the proxy.
   - Record the result in the PRD against ≤ 10 MB / ≤ 80 MB.
7. **Malformed request target → 400.** This is uncovered at `src/proxy.js:332`, and the POC proved it in M2. One cheap test.

### Done when (adds to section 4)
- [ ] From inside a sandbox whose runtime lives under `$HOME`, `sbx approve` and other agents' sockets are unreachable; the hold stays pending.
- [ ] A held request does not block other requests from the same agent (same tunnel and new connection).
- [ ] Unknown-CA and wrong-host upstream certs are 502 and never forwarded.
- [ ] Two concurrent agents: no cross-attribution in logs or holds.
- [ ] RSS re-measured on the rewritten code and recorded in the PRD.
