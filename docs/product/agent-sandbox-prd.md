# PRD: Lightweight local sandbox for AI agents

> Working name: TBD (see Open questions).
> Status: M2 PASS Oct 26 (local hold matrix, all nine scenarios); graduation rewrite next (not M3). Scopes the idea note `agent-sandbox.md` in this folder.
> Build window: Meta Global AI Developer Hackathon, Oct 26 – Nov 4 2026 (10 days). Built to be the seed of a real product, not a throwaway.

This PRD follows the minimum content from AGENT_RULES.md "Operating Flow": Problem & goal, Go/no-go, Out of scope, Modules, Open questions. Every POC result updates this file. A result that flips the go/no-go or a module's assumption is a spec change.

## 1. Problem & goal

### Problem

Agents need real access to be useful: shell, files, network. Today a developer picks one of two bad options.

- **Approve everything.** About forty prompts per task. People stop reading them, or switch prompts off.
- **Heavy isolation.** Docker or a VM. Images, a daemon, root, and the agent can't use the installed toolchain. Most people skip it.

Neither matches where the risk is. Reads are mostly harmless. File writes can be fixed. Only a few actions can't be undone: paying, sending, publishing, pushing.

The existing lightweight sandboxes (for example Anthropic's sandbox-runtime, srt) block well but cost memory. Measured below: about 100 MB per sandbox, because each one starts its own proxy. That does not scale to many agents on one small machine.

### Goal

A lightweight local sandbox for running AI agents with guardrails. Two jobs: damage control (mistakes and prompt-injected agents) and controlled governance (who may do what, with an audit log).

The one-line version: **an agent runs on your machine with your real tools, every write is undoable, and nothing leaves the machine without passing a doorman. You're asked only when something irreversible is about to happen.**

### Priorities, in order

1. **Low memory.** Primary.
2. **Local or a cheap VPS.** Never needs a cloud. Zero cost.
3. **Many agents per machine.** One shared proxy, many thin sandboxes. Not a cluster.
4. **Cross-platform.** Later.

### First users

Solo devs and small teams. They want maximum control and freedom at zero cost.

### Why now

The hackathon gives a fixed 10-day window and a demo audience. The memory measurements already show a clear gap against the current prior art, so the idea can be tested quickly.

### What it is and isn't

- **Is:** a strong guardrail against mistakes and prompt-injected agents. No root, no daemon, no image. Millisecond-scale start for the walls (M0 POC measurement; unmeasured on the rewritten code — TODO re-measure).
- **Isn't:** a security boundary against a determined attacker. The kernel is shared. A kernel exploit escapes. Use a VM for that.

## 2. How it works (same model as the idea note)

Three letters, each handled differently. Same letters as rwxmap and bareguard.

| Letter | Meaning | What the sandbox does | You're asked? |
|---|---|---|---|
| **r** | reads, changes nothing | lets it through (except locked paths) | never |
| **w** | changes things, can be set back | records it on an undo layer | once, at the end (review the diff) |
| **x** | can't be undone: send, pay, publish, push, delete remote | holds it at the door until you decide | at the moment it happens |

The agent works in your house:

1. **Tracing paper (w).** The agent sees the real files. Every change lands on tracing paper laid over them. At the end you press it down (commit) or throw it away (rollback).
2. **Locked drawers (r).** It reads most things. Some drawers can't be opened: `~/.ssh`, `~/secrets`, browser profiles, password stores.
3. **One front door with a doorman (x).** The agent has no network of its own. The only way out is the doorman. It waves lookups through and holds anything that sends, pays or publishes until you say yes.

### Picture

```
  agent process (real node, python, git)
        |
  +-----+--------------- bwrap sandbox (unprivileged) ---------------+
  |  files:   overlay   lower = real project (read only)             |
  |                     upper = per-run tracing paper                |
  |  locked paths (~/.ssh etc.) -> empty tmpfs                       |
  |  network: none of its own                                        |
  |  socat inside: 127.0.0.1:3128 -> per-agent unix socket           |
  +-----+------------------------------------------------------------+
        | per-agent unix socket (the connection = the agent's identity)
        v
   ONE shared proxy (Node, in-process: rwxmap + bareguard)
        |-- r        -> forward
        |-- x        -> hold, ask the human, forward or 403
        '-- unknown  -> per-mode default
```

### The doorman's deterministic x-rules (strongest first)

The proxy sees requests, not intent, and sites use `POST` for both searching and paying. So `GET = r, POST = x` is too crude. The rules, strongest first:

1. **Card data in the body: always x.** Any 13–19 digit number that passes the Luhn check, or a CVV/expiry field.
2. **Payment destinations: always x.** Known payment domains and paths such as `/checkout`, `/payment`, `/orders`, `/purchase`.
3. **Known APIs: rwxmap labels.** For example, search = r, create order = x.
4. **Unknown POST: mode default.** Strict: ask once per new domain, then remember for the run. Normal: allow and log.

The idea note's "personal data leaving" rule is out of scope.

### Capability without custody

The agent never holds the card or API keys. It types a placeholder. The proxy puts the real value in only after the human approves that specific request. In v1 this works for **request headers only** (see M5).

## 3. Go / no-go

The product stands or falls on three things, all on Linux.

| # | Capability | Proof |
|---|---|---|
| a | The proxy is the only way out, fails closed, and can read inside HTTPS. | A request that skips the proxy fails. A request through it is visible in full (method, URL, headers, body) for curl, node, python requests, git over https. |
| b | The proxy holds one x request for human approval while the agent keeps working. | One request parked; other requests from the same agent complete meanwhile; approve forwards it, deny or timeout returns a clear 403. |
| c | Per-agent memory and the shared proxy stay within the memory targets. | Measured with 20 concurrent sandboxes (see Memory targets). |

M0, M1 and M2 are the go/no-go modules. If any of a, b or c fails, stop and take it back to this PRD as a spec change. M3 onward is not started until M0–M2 pass.

### Memory targets

These are targets, not results. They get measured in M0, M1 and M6.

| Item | Target |
|---|---|
| Shared proxy | <= 80 MB |
| Each extra sandbox, on top of the agent itself | <= 10 MB |
| Agents on a 2 GB VPS | 20 |

### Rewrite bench (Oct 27): go/no-go (c) re-measured on the rewritten code

`npm run bench` exit 0 PASS, measured 2026-10-27 in a real shell with 20 concurrent agents
(`addAgent` + `launch`; per-sandbox RSS from exact `/proc` tree walks of each bwrap PID;
agent `sleep` excluded per the PRD walls-only definition).

| Item | Measured | Budget | Verdict |
|---|---|---|---|
| Per-sandbox overhead (two bwrap processes + socat each) | mean 7.8 MB, max 7.9 MB (range 7.7–7.9 across agents) | ≤ 10 MB each | PASS |
| Proxy RSS idle | 60.1 MB | ≤ 80 MB | PASS |
| Proxy RSS after minting 10 certs | 69.4 MB | ≤ 80 MB | PASS |
| Proxy RSS with 20 parked holds | 71.9 MB | ≤ 80 MB | PASS |

This supersedes the M0/M1 POC proxy figures (52.1 MB bare, 59.9–63.1 MB with TLS) for the
rewritten code. Start timing remains unmeasured on the rewrite (TODO re-measure).

## 4. Evidence so far

Measured on the dev machine: Fedora, kernel 7.2, bubblewrap 0.12.0, Node 22, ext4 home. These came from throwaway POCs. They are evidence, not the product.

### Baseline

| Item | Measured |
|---|---|
| Idle Node process | 49 MB RSS |

### srt 0.0.81, one sandboxed command

| Item | Measured |
|---|---|
| srt Node process | 82 MB |
| 3 socat relays | ~12 MB |
| 3 bash wrappers | ~8 MB |
| Total per sandbox | ~100 MB |
| Start time (3 runs) | 1.87 / 2.05 / 1.98 s |

srt starts a proxy per sandbox, so that is about 1 GB for 10 agents and about 2 GB for 20. Its blocks worked: allowed domain returned 200, other domain blocked, `~/.ssh` empty, write outside the allowed area blocked (read-only).

### Own walls POC (bwrap + overlay)

- Agent edited `a.txt` and created `b.txt`. The agent saw its own changes.
- The real folder was untouched. Both files landed in the upper layer.
- `~/.ssh` showed empty (tmpfs). A write outside the project was blocked.
- No network of its own.
- Start plus exit: 0.02–0.03 s. Peak about 3.8 MB.

### Front door POC

- Per-agent unix socket bind-mounted into the sandbox. `socat` inside bridges `127.0.0.1:3128` to the socket. A tiny Node CONNECT proxy runs on the host.
- `example.com` allowed (200). `github.com` denied. Bypassing the proxy (`--noproxy`) fails closed.
- `socat` inside the sandbox: 4.1 MB.
- Bare test proxy: 55 MB RSS. It has no TLS inspection and no libraries loaded yet. **Real proxy memory is unmeasured.**

### Rough sum

| Setup | 20 agents |
|---|---|
| Own walls (rewrite bench): ~72 MB proxy + 20 × 7.8 MB | ~228 MB |
| srt | ~2 GB |

The own-walls figure will grow. The proxy still has to load TLS handling, rwxmap and bareguard, and none of that is measured. Treat 228 MB as a floor to check, not a promise.

### M0 measured run (Oct 26, PASS 14/14)

Harness `poc/m0/run-m0.sh` (runtime `/tmp/sbx-m0`; throwaway POC, not shipped): dumb Node forward+CONNECT proxy on 22 per-agent unix sockets; bwrap launcher (ro-bind `/usr` `/etc` `$HOME` `$PROJ`, tmpfs locked paths, unshare-net/pid/uts/ipc, socat bridge to `127.0.0.1:3128`). 20× idle sandboxes (`sleep` + `socat`) concurrent.

| Item | Measured | Target | Verdict |
|---|---|---|---|
| Walls-only overhead per sandbox (2×bwrap + socat, no agent) | mean 7.7 MB, max 7.9 MB | ≤ 10 MB each | PASS |
| Bare proxy RSS, 22 sockets, no TLS | 52.1 MB | ≤ 80 MB with TLS (M1) | recorded, TLS unmeasured |
| Cold start + exit, single sandbox | 10 ms M0 POC figure (17 ms prior run) — unmeasured on the rewrite, TODO re-measure | ms-scale walls | PASS (M0 POC only) |
| Through-proxy HTTP | 200 | works | PASS |
| CONNECT tunnel mechanics | 2 tunnels in log | works | PASS (opaque; inspection is M1) |
| `~/.ssh` masked (host has 6 entries, non-vacuous) | 0 visible | empty | PASS |
| Project + home read-only | BLOCKED | blocked | PASS |
| Bypass set: `--noproxy`, env-unset, direct IP, host localhost | all fail (curl exit 6/7), 0 default routes | fail closed | PASS |
| Per-agent identity (fx, fy probes) | attributed correctly, no cross-attribution | connection = identity | PASS |

Caveats: the tool shell had no outbound internet, so the upstream was a local `python3 -m http.server`; the real-internet client matrix (curl, node, python requests, git) is M1's job. One baseline `socat` on the box (origin unconfirmed, left running) was excluded via baseline subtraction; per-sandbox RSS comes from exact `/proc` tree walks of the 20 bwrap PIDs, not name matching.

### M0 red-team (Oct 26, 8/8 detections across 5 breaks)

Ritual `poc/m0/redteam.sh` (runtime `/tmp/sbx-m0`): each wall broken on purpose via `SBX_BREAK=` hooks in the throwaway launcher; PASS iff every break is DETECTED.

| Break | Expected detection | Observed |
|---|---|---|
| `nonet` (no net namespace) | B3 exit 0 (host-localhost leak) | DETECTED, B3=0; door still 200, B4=2 routes |
| `nolock` (no tmpfs masks) | T3 == host count (6) | DETECTED |
| `rw` (writable binds) | T4a + T4b ALLOWED | DETECTED; canary in real `$HOME` created + removed, verified clean |
| Miswired socket (marker alpha via socket bravo) | identity assertion fails; attributed to bravo | DETECTED both |
| Fat sandbox (50 MB anon alloc) | meter reports over the 10 MB bar | DETECTED, 69.5 MB total |

Notes: in `nonet` mode all file walls stayed green — only the network leaked, as designed. The hooked launcher's default path is proven unchanged (T1=200 with no `SBX_BREAK`). B1 stayed exit 6 even with host networking: this machine itself has no outbound internet/DNS, so M1's client matrix needs a local HTTPS upstream or a machine with internet.

### Gotchas found

- Unix socket paths have a limit of about 108 characters. Use a short runtime dir.
- Mounting the proxy socket needs a tmpfs over its target dir.
- The bwrap root needs a `/lib64 -> usr/lib64` symlink or every dynamic binary fails with `No such file or directory` (the ELF interpreter path). Proven by red/green minimal repro in the M0 run.
- Each sandbox holds 2 bwrap processes (supervisor + ns child) plus socat; count RSS per-PID-tree, and never `pgrep -f` the bridge string (bwrap parents match their own command line).

## 5. Decisions

Signed off by the user.

| Area | Decision |
|---|---|
| Platforms | Linux first (hackathon). macOS and Windows (via WSL2, which reuses the Linux build) come after. |
| Stack | Node. bareguard (action gate: allow / ask / deny + audit log) and rwxmap (labels API operations r/w/x) run in-process in the proxy. mitmproxy (Python) is dropped. |
| Walls | Our own thin walls on bubblewrap, not Anthropic's sandbox-runtime. See "Why own walls" below. |
| Dropped for v1 | Landlock and custom seccomp. bwrap's own isolation is enough for a guardrail. They can return later. |
| Undo layer (Linux) | bwrap overlay. Lower = real project, read-only. Upper = per-run tracing paper. Commands: diff, commit, rollback. |
| Approvals | Second-terminal CLI (`sbx pending`, `sbx approve <id>`, deny) over a local unix socket. Timeout means deny. No web UI. |
| Governance v1 | Single operator, one policy file per agent, one audit log. |
| Secrets v1 | Injected in request headers only, after approval. A placeholder sits inside the sandbox. Body placeholder swap (for example `{{CARD}}` in a form body) is not v1. |
| Localhost sockets (M0) | Blocked entirely. The net namespace isolates localhost; revisit treat-as-x in M3 only if a demo needs a local DB. |
| Locked paths (M0) | `~/.ssh`, `~/secrets`, `~/.mozilla`, `~/.config/chromium`, `~/.gnupg`. More later without changing the walls. |
| Browser agents + Jev | Out of v1. Demo A uses an API, not a browser. |
| M0 harness | 20× idle sandboxes (`sleep` + `socat`, no real agent) for walls-only overhead ≤ 10 MB each; bypass set = unset proxy env, `--noproxy`, direct curl to IP. Real-agent and TLS memory come in M1/M6. |
| API surface | CLI for sure plus programmatic APIs for spawning sandboxed workflows (goal: spawn workflows in a sandbox easily). |

### Why own walls (option B)

| | srt (measured) | Own walls (measured) |
|---|---|---|
| Memory per sandbox | ~100 MB (Node 82 + socat ~12 + bash ~8) | ~8 MB (socat 4.1 + walls peak ~3.8) |
| Proxy | one per sandbox | one shared |
| Start time | 1.87 / 2.05 / 1.98 s | 0.02–0.03 s (walls only) |
| 20 agents | ~2 GB | ~228 MB rough sum (~72 MB proxy + 20 × 7.8 MB, rewrite bench) |
| Blocks work | yes | yes |

Memory is priority 1, and the per-sandbox proxy is the cost. We build the thin walls ourselves (a launcher of about 50 lines). srt stays as prior art. We borrow these ideas from it:

- An async per-request filter.
- Credential masking.
- `node-forge` for certificates (must pass the dependency checklist; see Open questions).

Cost of this choice: we own the walls code and its upkeep.

## 6. Out of scope

For the whole build. Core foundations first, all else is out of scope.

- Not a defence against kernel exploits. Use a VM for that.
- No Docker or VM.
- No native Windows.
- No cluster or k8s orchestration.
- No cloud control plane.
- No phone agents (baremobile).
- No GraphQL or gRPC body parsing in v1.
- No cert-pinned apps.
- Non-HTTP egress is denied.
- UDP is denied.
- No web UI in v1.
- No multi-user approvals, org roles or phone push in v1.
- No Landlock or custom seccomp in v1.
- No body placeholder swap in v1.
- No personal-data-leaving rule (passport, date of birth, address).
- No browser agents or on-screen action classifier (Jev) in v1.

## 7. Modules

Order is dependency order. Each module is a POC aimed at its riskiest assumption. A module is done when it works alone and still works connected to everything built before it. Do not start N+1 while N is unproven.

**M0, M1, M2 are the go/no-go.**

### M0. Walls + front door (Linux) [go/no-go]

| | |
|---|---|
| Goal | An agent runs with locked paths, no network of its own, and one way out: a per-agent socket into the proxy. |
| We use | bubblewrap, `socat`, Node. |
| We build | bwrap launcher (about 50 lines). Locked paths. Per-agent unix socket into the proxy. The connection is the agent's identity, not a header it could fake. `socat` bridge inside. `HTTP_PROXY` / `HTTPS_PROXY` env. |
| Riskiest assumption | Per-agent overhead stays <= 10 MB with N agents running at once. |
| Done when | 20× idle sandboxes (`sleep` + `socat`) measured: walls-only overhead ≤ 10 MB each, bare proxy RSS recorded. Bypass set (unset proxy env, `--noproxy`, direct curl) all fail closed. |
| Estimate | 0.5 day (mostly proven by the POCs above). |

**Result (Oct 26): PASS.** 14/14 harness checks; max walls-only overhead 7.9 MB; bypass set fails closed. Go/no-go (a) part 1 met, (c) met for walls. POC stays throwaway; graduation rewrite deferred until M2 passes (M1 is the make-or-break).

### M1. Proxy sees inside HTTPS [go/no-go]

| | |
|---|---|
| Goal | The proxy can read method, URL, headers and body of HTTPS requests. |
| We use | `openssl` subprocess for certificates (decided Oct 26: zero proxy RSS, binary present; node-forge dropped), Node `tls`. |
| We build | A local CA that exists only inside the sandbox. Per-host certificates. Trust env vars: `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`. Non-HTTP and UDP denied. |
| Riskiest assumption | This is the hardest piece. Common clients must work through it, and proxy memory with TLS must stay <= 80 MB. |
| Done when | curl, node, python requests and git over https all work through the proxy and the proxy can see inside. Proxy RSS with TLS is measured and compared with the 80 MB target. |
| Estimate | 2 days. |

**Result (Oct 26): PASS.** Positives everywhere (dev self-test + real internet: 4 clients 200 with wire bodies, per-client headers, git ls-remote). Negatives everywhere (unknown host, dead upstream 502, no-CA, plain HTTP, chunked intact, close-delimited loud 500, echo-liveness gate). Peak proxy RSS 59.9 MB local, 63.1 MB real (target ≤ 80). Go/no-go (a)2 + (c) met. POC stays throwaway; graduation rewrite after M2.

### M2. Hold and ask [go/no-go]

| | |
|---|---|
| Goal | Park one x request, ask the human, keep everything else running. |
| We use | Node, a local unix socket. |
| We build | A hold queue. A notification. `sbx pending`, `sbx approve <id>`, `sbx deny <id>` over a unix socket. Timeout means deny, with a clear 403 reason (for example `403 denied by user: payment`). |
| Riskiest assumption | Held requests don't break clients or servers on slow approvals. |
| Done when | One request is held for a long approval while other requests from the same agent complete. Approve forwards it. Deny and timeout return the 403 with the reason. Tested with the M1 client set. |
| Estimate | 1 day. |

**Result (Oct 26): PASS.** Local hold matrix (`poc/m2/`, placeholder path trigger, 9 scenarios): approve forwards with echo intact while a meanwhile GET completes; depth 2 and 3 concurrent holds (approve rest, deny with reason, queue empties); double-decide and unknown ids answered, never applied twice; malformed input denied 400 with the proxy surviving; 1 MB cap denied loud at the door, never queued; 5 s timeout denies with reason and frees the queue; `never` holds until decided; 30 s hold survives and approves. Go/no-go (b) met. All three go/no-go modules pass — graduation rewrite unblocked.

### M3. Decide

| | |
|---|---|
| Goal | The proxy decides r / w / x deterministically and logs every decision. |
| We use | rwxmap (labels), bareguard (allow / ask / deny + audit log). |
| We build | The glue and the deterministic rules from section 2: Luhn card numbers, CVV/expiry, payment domains and paths, unknown POST by mode (strict / normal). One policy file per agent. One audit log. |
| Riskiest assumption | rwxmap labels and bareguard run in-process in the proxy without breaking the memory target. |
| Done when | A scripted request set gets the expected decision for each rule, including a case that should not match. The audit log shows each decision. Proxy RSS re-measured with both libraries loaded. |
| Estimate | 1–1.5 days. |

### M4. Undo layer

| | |
|---|---|
| Goal | Every file write is reviewable and reversible. |
| We use | bwrap overlay. |
| We build | An overlay upper per run. `sbx diff`, `sbx commit`, `sbx rollback`. Handling of deletions (overlay whiteouts). Detection of files the user changed meanwhile: on conflict, refuse or flag. |
| Riskiest assumption | Commit applies the upper layer to the real folder correctly, including deletions and files changed meanwhile. |
| Done when | A run that edits, creates and deletes files commits to the correct result. Rollback leaves the folder as it was. A file changed by the user mid-run is flagged, not overwritten. |
| Estimate | 1 day. |

### M5. Keys the agent never holds

| | |
|---|---|
| Goal | The agent works with a placeholder. The real key never enters the sandbox. |
| We build | A placeholder inside the sandbox. The real value is added to request headers only after approval. Per-agent credentials. |
| Riskiest assumption | The key is never visible inside the sandbox (env, files, process list), and a denied request carries only the placeholder. |
| Done when | An approved request reaches an API with the real header value. A denied one carries only the placeholder. A search of the sandbox for the real value finds nothing. |
| Estimate | 0.5 day. |

### M6. Scale run

| | |
|---|---|
| Goal | Check the memory targets at the real scale. |
| What | 20 agents plus the shared proxy on one box, and on a 2 GB VPS if one is available. Compare with the memory targets. |
| Note | If M0 and M1 measurements already cover this, fold it into them and record the numbers there. It is then not a separate step. |
| Estimate | No separate estimate. It is part of the 9–10 day total. |

### M7. Demos, numbers, README

| | |
|---|---|
| Demo A | Flight booking. Search runs free. Payment stops for approval. The key is never in the agent. Use an API whose key goes in a header, for example Stripe test mode. |
| Demo B | A prompt-injected agent tries to read `~/.ssh` and push it out. Blocked. Good work is committed. Bad edits are rolled back. |
| Numbers | Start time. Memory per agent. Prompts per task versus a stock agent setup. Blocked exfiltration attempts. |
| Also | README. |
| Estimate | 1.5 days. |

### Total

About 9–10 days on Linux. This is tight for the hackathon.

## 8. Day-by-day plan (Oct 26 – Nov 4)

This is a plan, not a result. It shifts as POCs return.

| Day | Date | Work | Gate |
|---|---|---|---|
| 1 | Oct 26 | M0 (and M6 numbers for 20 sandboxes if trivial) | Go/no-go (a) part 1: bypass fails closed; per-agent overhead measured |
| 2 | Oct 27 | M1 start: CA, per-host certs | |
| 3 | Oct 28 | M1 finish: client matrix, proxy memory with TLS | Go/no-go (a) and (c) |
| 4 | Oct 29 | M2: hold and ask | Go/no-go (b). All three pass, or stop. |
| 5 | Oct 30 | M3: labels, gate, rules | |
| 6 | Oct 31 | M3 finish. M4 start. | |
| 7 | Nov 1 | M4 finish. M5. | |
| 8 | Nov 2 | M6 scale run. M7 start (demo A). | Memory targets measured |
| 9 | Nov 3 | M7: demos A and B, numbers | |
| 10 | Nov 4 | M7: README, final checks, submission | |

Nov 2 has room to spare and absorbs slips from earlier days. Nov 4 is the last day.

## 9. Later (after the hackathon)

Not sorted into the 10 days.

| Item | Note |
|---|---|
| macOS walls | `sandbox-exec` profile plus APFS clone (`cp -c`) for undo. No Mac available; needs a test machine (borrowed Mac or macOS CI runner) before it can start. About 1–1.5 days. |
| Windows | Via WSL2. A test run of the Linux build. |
| Body placeholder swap | For cards, for example `{{CARD}}` in a form body. |
| Per-step snapshots | Per-step undo of the upper layer. |
| Phone push approvals | |
| Landlock / seccomp hardening | |
| GraphQL / gRPC parsing | |
| Llama end-of-run summary | Plain-language summary of the diff and audit log, flags off-task changes; model output treated as untrusted. Optional, not required for the hackathon. |
| Go proxy rewrite | See the verdict below. |

**Go verdict, verbatim:**

> Verdict: Node, with no real contest. Go wins on memory and shipping. Node wins on reuse, and that reuse turns out to be large. Go could come back later as a rewrite of just the proxy, if measurements ever show memory is the bottleneck.

## 10. Known gaps

- **Writes over sockets escape the overlay.** A local Postgres or Docker daemon is not a file. See Open questions.
- **Commit conflicts.** If the user edits the same files during a run, M4 flags the conflict. It does not merge.
- **Held requests can time out on the server side.** Holding happens before forwarding, so only the agent's client waits.
- **Certificate pinning breaks inspection.** Out of scope.
- **The proxy sees traffic, not intent.** Every API needs a mapping. File edits and local stdio MCP servers never touch the network. The undo layer and locked paths cover files. An MCP server running outside the sandbox with its own credentials is a hole.

## 11. Open questions

None of these block M0. Nothing here is silently assumed.

| # | Question | Decides |
|---|---|---|
| 1 | What is the real proxy memory with TLS, rwxmap and bareguard loaded? M0: bare proxy 52.1 MB (22 sockets, no TLS). TLS still unmeasured. | The <= 80 MB target. Measured in M1 and M3. |
| 2 | ~~`node-forge` or shelling out to `openssl` for certificates?~~ Decided Oct 26: `openssl` subprocess (sandbox keeps proxy RSS clean; platform coupling accepted, see M1). | — |
| 3 | How should the undo layer handle large untracked dirs (`node_modules`) and build output? | M4 design. |
| 4 | Localhost sockets (Postgres, Docker daemon) are writes the overlay can't see. Decided Oct 26 for M0: block. | M3 revisits only if a demo needs a local DB. |
| 5 | Server-side timeouts while a request is held. How long can a hold last in practice? | The approval timeout value in M2. The idea note's sketch used 120 s; that is not tested. |
| 6 | Working name. | Repo and CLI naming (`sbx` is a placeholder). |
