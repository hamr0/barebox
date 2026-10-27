# Retro: init → v0.2.0 (Oct 26 – 27, 2026)

> Everything done from the first commit (`1f144f4`) to `barebox@0.2.0` on npm (`d6c67f5`).
> Two days, 38 commits, 4 PRs, 2 npm releases. Covers days 1–2 of the hackathon window (Oct 26 – Nov 4).
> Sources: git history, `CHANGELOG.md`, `agent-sandbox-prd.md`, `findings.md`, `rewrite-review.md`, `.claude/remember/fix-ledger.md`.

## Timeline

| When | What | Gate | Result |
|---|---|---|---|
| Oct 26 | Repo scaffold, npm name reserved (`0.1.0`), M0 POC | M0 walls + front door | PASS 14/14, red-team 8/8 |
| Oct 26 | M1 POC: TLS inspection | Client matrix, real internet | PASS |
| Oct 26 | M2 POC: hold and ask | 9-scenario hold matrix | PASS: all go/no-go met |
| Oct 26 | README, GitHub description + 17 topics, branch protection, profile README entry | — | Done |
| Oct 27 | Graduation rewrite (POC → `src/`) on branch `rewrite` | Reviews §0–7, self-review, branch-review | Ready at `0800f9d` |
| Oct 27 | Rewrite bench | Go/no-go (c), re-measured | PASS |
| Oct 27 | Design decisions for M2.5 → M7 | Written into PRD (`fe40a4e`) | Signed off |
| Oct 27 | Release v0.2.0 (PR #1) + three publish fixes (PRs #2–#4) | CI, adopter gate, npm provenance | Live on npm, `latest` = 0.2.0 |

## Day 1 (Oct 26): prove the three go/no-go modules

Commits `1f144f4` → `09c8529`. All POC code lives in `poc/`: throwaway by design, never shipped.

### M0: walls + front door
bwrap launcher (ro-bind `/usr` `/etc` `$HOME` `$PROJ`, tmpfs over locked paths, unshare net/pid/uts/ipc), a socat bridge inside, and per-agent unix sockets into a dumb proxy. Each socket is the agent's identity.
- 20 idle sandboxes at once: **7.7 MB mean / 7.9 MB max** each (budget ≤ 10). Bare proxy 52.1 MB.
- Bypass set (`--noproxy`, env unset, direct IP, host localhost) all fail closed; `~/.ssh` masked; home and project read-only.
- Red-team: each wall broken on purpose through `SBX_BREAK=` hooks. **8/8 detections across 5 breaks.**
- Gotchas: ~108-char unix socket path limit; the bwrap root needs a `/lib64 → usr/lib64` symlink; count RSS by PID tree, never `pgrep -f`.

### M1: proxy sees inside HTTPS
Local CA plus per-host certs minted by `openssl` subprocess (node-forge dropped: zero proxy RSS cost). Trust env: `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`.
- curl, node, python requests and `git ls-remote` all return 200 over the real internet, with the wire bodies visible.
- Negatives: unknown host, dead upstream 502, no CA, plain HTTP, chunked intact, close-delimited loud 500.
- Proxy peak RSS **59.9 MB local / 63.1 MB real** (budget ≤ 80).

### M2: hold and ask
A hold queue plus `sbx pending/approve/deny` over a unix socket.
- Approve forwards with the body intact while another GET from the same agent completes.
- Depth 2 and 3 concurrent holds work; double decides are answered but never applied twice; malformed input is denied 400 and the proxy survives.
- 1 MB cap denied at the door; 5 s timeout denies with a reason; a 30 s hold survives.

**Verdict:** go/no-go (a), (b) and (c) met, so the graduation rewrite was unblocked.

## Day 2 (Oct 27): graduation rewrite, reviews, release

### Rewrite (`f6122c4` → `46cd374`)
- Packaging, CI, primitives tooling, `barebox.context.md`, publish gate.
- `createProxy`: `http.Server` front door on 127.0.0.1, holds queue, on-demand certs.
- `launch`: per-agent socket wiring plus a CA trust bundle.
- `sbx` CLI with `--help` and defined exit codes; TypeScript types; `primitives.json`.
- Tests moved to async clients, exact curl exit codes, and fixtures outside `poc/`.

### Review trail: what the reviews caught
Reviews ran in `rewrite-review.md` §0–7, then `/self-review` (full history, and the bookmark at `a317fac`), then `/branch-review` (first run blocked; the re-review was ready at `0800f9d`). Every item below was proven and fixed before merge:

| Area | Bug | Fix |
|---|---|---|
| Tests | In-process `execFileSync` deadlock; bypass tests passing by timeout ("slow by design"); flaky socat bridge tests | Async clients, exact exit codes, ack-after-receipt bridges (`39d512d`) |
| Proxy | Bound on `*:port`; hand-rolled HTTP framing (HEAD 502 after 6 s, slow upstream killed at 10 s) | 127.0.0.1 only; stdlib `http` |
| Proxy | Plain HTTP bypassed holds; holds outlived their clients | Holds on both paths; abandoned holds dropped |
| Upstream wall | Loopback hole through the proxy; DNS check-then-dial (fails open on unresolvable names); LAN reachable | Fail-closed DNS, checked IP pinned into the dial, private ranges denied (`dd5c9a3`) |
| Launcher | Not wired to the proxy; no CA trust env | Socket = identity, trust bundle exported |
| Launcher | **ro-bind does not block unix-socket `connect`: an agent could approve its own holds through `ctl.sock`** | Runtime sockets masked (`2a3b72f`), symlink-proof (`8eefc88`), control socket confined to the runtime (`84e0545`) |
| Bench | `rss()` crash; sampled at the wrong moment | Fixed sampling (`39d512d`) |
| Proxy (branch-review blocker) | POST body lost for real-DNS hosts | Client stream paused until the upstream pipe is attached (`10f2ceb`) |
| Security | `certDir` outside the runtime exposed `ca.key`; audit log 0644 with `Authorization` in it | certDir inside the runtime; log 0600, auth headers scrubbed (`0800f9d`) |

Docs sweep `f913c53`. `AGENTS.md` merged into `CLAUDE.md` (`3f24c66`).

### Rewrite bench: go/no-go (c) re-measured
`npm run bench`, 20 concurrent agents, exact `/proc` tree walks:

| Item | Measured | Budget |
|---|---|---|
| Per-sandbox overhead | 7.8 mean / 7.9 max MB | ≤ 10 |
| Proxy idle | 60.1 MB | ≤ 80 |
| Proxy after 10 certs | 69.4 MB | ≤ 80 |
| Proxy with 20 parked holds | 71.9 MB | ≤ 80 |

Suite **89/89, 0 skipped, ~9 s**, locally and on GitHub CI. Start time is not measured on the rewrite yet.

### Design decisions (`fe40a4e`)
- **Modes:** `ask` (r passes; w and x ask) / `auto`, the default (r and w pass; x asks) / `trust` (all pass, logged). Card numbers (Luhn) and payment paths ask in every mode.
- **Policy:** "two gateways, one channel". Depend on bareguard and also accept an injected gate, matched by shape (`check(action)`).
- **Ask channel:** a single file checkpoint, `asks/<id>.json` → `answers/<id>.json`. The control socket is removed.
- **Audit:** one 0600 JSONL file in bareguard's line shape, with secrets redacted.
- **Suite reuse rule:** a missing primitive in a suite library gets fixed in that library.
- **Order:** M2.5 → M4 → M3 → M5 → M6 → M7.

### Release v0.2.0
`/release` cut `0987116` (CHANGELOG + version bump) and PR #1 merged the rewrite (`eea006b`). Each gate in the publish path then failed once:

| PR | Gate that failed | Cause | Fix |
|---|---|---|---|
| #2 | Tests (`spawn socat ENOENT`) | `publish.yml` lacked the bwrap/socat/curl/openssl install and the userns sysctl | Same runner deps as `ci.yml` (`de696d7`) |
| #3 | Adopter type check (TS2339, TS1543) | Quickstart still used `proxy.holds` and a JSON import without `with { type: "json" }` | Quickstart updated to the 0.2.0 API (`748b0ef`) |
| #4 | npm `E422` | No `repository` field; provenance requires it to match the repo | `repository` added, bin set to `src/cli.js` (`d6c67f5`) |

Tag `v0.2.0` was moved to `d6c67f5` (it was never published under the old commit). Publish run 40504981455 succeeded with sigstore provenance (logIndex 3516467556). The registry now shows `latest` = 0.2.0, with `repository` and `bin.sbx` set.

## What went well
- **POC first paid off.** All three go/no-go modules were settled on day 1, so the rewrite never had to argue about feasibility.
- **Red-team rituals.** Breaking each wall on purpose proved the tests can fail, not just pass.
- **Reviews found real holes, not nits.** The worst was the self-approval path through a unix socket (ro-bind does not stop `connect`). A happy-path test would never find it.
- **Memory stayed flat.** POC to rewrite moved per-sandbox overhead by 0.1 MB, and the proxy has ~8 MB headroom under 80 MB.

## What hurt
- **The rewrite shipped POC-era test habits.** Timeouts that pass for the wrong reason and racy bridges cost several review rounds.
- **Security bugs clustered at the edges:** DNS, LAN ranges, symlinks, file modes, socket reachability. Every one sits on a trust boundary.
- **The publish path had never run before release day.** Three PRs fixed three gates, one at a time, each found only once the previous one passed.

## Lessons (carried forward)
1. Every workflow that runs `npm test` needs identical runner deps.
2. Change the adopter quickstart in the same PR as any public API change.
3. Every suite package needs `repository` (provenance), and bin paths are written without `./`.
4. A test that passes by timeout proves nothing. Assert exact exit codes and the reason.
5. A read-only bind is not a wall for sockets. Mask the runtime, and compare real paths.
6. Dry-run the publish workflow before release day.

## Open debt
`fix-ledger.md` has 19 bullets (9 nits, 7 changes, 3 ideas). The ones that matter most:
- Dial pinned to `ips[0]` with no fallback (`localhost` → `::1` gives `ECONNREFUSED`).
- IPv6 literal `CONNECT` returns 400.
- Hex-mapped IPv6 missed by `mappedV4` (goes away once bareguard `isPrivateIp` is reused).
- `Cookie` / `X-Api-Key` logged verbatim; a pre-existing log keeps mode 0644.
- No `--new-session` (TIOCSTI risk, unverified on this host).

Suite friction to file upstream: F1 (bareguard `askOn` letters), F2 (rwxmap request→key matcher), F3 (bareguard audit append), F4 (NAT64/6to4 coverage).

## Next
Oct 28 M2.5 (ask seam, file channel, `run()`, `sbx run --json`) → Oct 29–30 M4 undo layer → Oct 31–Nov 1 M3 + M5 → Nov 2–4 M6/M7. Run `/refactor` on the ledger between features.
