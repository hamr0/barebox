---
title: Evidence and memory budget
description: The current memory budget, the go/no-go criteria with their results, and the measurements behind barebox's numbers.
---

# Evidence and memory budget

## Current memory budget

The shared proxy budget is about 205-245 MB in the full HTTPS worst case at 40 agents, from a quiet to a busy machine (docs/archive/agent-sandbox-prd.md:131). The user set it on Nov 2 (docs/archive/agent-sandbox-prd.md:131).

| Item | Target |
|---|---|
| Shared proxy | about 205-245 MB, full HTTPS worst case, 40 agents (docs/archive/agent-sandbox-prd.md:135) |
| Each extra sandbox, on top of the agent itself | 10 MB or less (docs/archive/agent-sandbox-prd.md:136) |
| Agents per proxy | 40 maximum, enforced (docs/archive/agent-sandbox-prd.md:137) |

- Over HTTPS, with every request in its own live TLS tunnel, the shared proxy measured 207-241 MB at 40 agents (docs/archive/agent-sandbox-prd.md:131).
- The cap of 40 agents is enforced by `addAgent`. Above 40, an orchestrator runs more proxies (docs/archive/agent-sandbox-prd.md:129).
- The `addAgent` check refuses the 41st agent with an error that says to run another proxy. The `tcp` door does not count, and `removeAgent` frees a place (docs/archive/agent-sandbox-prd.md:204).
- barebox is for small teams: free, local and lightweight, not for swarms or thousands of agents (docs/archive/agent-sandbox-prd.md:206).
- 80 MB is not reachable on Node. About 53 MB of the proxy is Node's own code (docs/archive/agent-sandbox-prd.md:129, docs/archive/agent-sandbox-prd.md:193).

## How the budget moved

- Start: 80 MB for the shared proxy (docs/archive/agent-sandbox-prd.md:135).
- Oct 30: the user retired 80 MB and set a flat 150 MB at 40 agents (docs/archive/agent-sandbox-prd.md:129, docs/archive/agent-sandbox-prd.md:204).
- Oct 30, later: the flat 150 MB became a range of about 145-175 MB, because identical runs vary with machine load (docs/archive/agent-sandbox-prd.md:206).
- Nov 2: the range became about 205-245 MB, because the earlier figures came from plain-HTTP traffic only (docs/archive/agent-sandbox-prd.md:131).

## Go/no-go criteria

The product stands or falls on three things, all on Linux (docs/archive/agent-sandbox-prd.md:115).

| # | Capability | Proof |
|---|---|---|
| a | The proxy is the only way out, fails closed, and can read inside HTTPS. | A request that skips the proxy fails. A request through it is visible in full for curl, node, python requests, git over https (docs/archive/agent-sandbox-prd.md:119). |
| b | The proxy holds one x request for human approval while the agent keeps working. | One request parked. Other requests from the same agent complete meanwhile. Approve forwards it. Deny or timeout returns a clear 403 (docs/archive/agent-sandbox-prd.md:120). |
| c | Per-agent memory and the shared proxy stay within the memory targets. | Measured with concurrent sandboxes (docs/archive/agent-sandbox-prd.md:121). |

- Each agent has one held request at a time. Later ones wait unread in line (max 16, then `429 hold queue full`). The deadline counts from arrival (docs/archive/agent-sandbox-prd.md:120).
- M0, M1 and M2 are the go/no-go modules. If any of a, b or c fails, stop and take it back to the PRD as a spec change (docs/archive/agent-sandbox-prd.md:123).

### Results

- (a) M0 passed 14/14 on Oct 26. The bypass set (`--noproxy`, env-unset, direct IP, host localhost) all failed closed, with curl exit 6 or 7 and no default routes (docs/archive/agent-sandbox-prd.md:250, docs/archive/agent-sandbox-prd.md:263).
- (a) Per-agent identity was attributed correctly with no cross-attribution (docs/archive/agent-sandbox-prd.md:264).
- (c) Go/no-go (c) was re-decided at the 150 MB budget and met at 143.6 MB with bareguard 0.30.0 (docs/archive/agent-sandbox-prd.md:204). The budget has since moved to the HTTPS range above (docs/archive/agent-sandbox-prd.md:131).

## Evidence behind the numbers

Measured on the dev machine: Fedora, kernel 7.2, bubblewrap 0.12.0, Node 22, ext4 home. The POCs were throwaway: evidence, not the product (docs/archive/agent-sandbox-prd.md:169).

### Per-sandbox walls overhead

The limit is 10 MB per sandbox (docs/archive/agent-sandbox-prd.md:136).

| Measurement | Result |
|---|---|
| M0 POC, 20 idle sandboxes (2 bwrap + socat, no agent) | mean 7.7 MB, max 7.9 MB, PASS (docs/archive/agent-sandbox-prd.md:256) |
| Rewrite bench, Oct 27, 20 agents | mean 7.8 MB, max 7.9 MB, PASS (docs/archive/agent-sandbox-prd.md:149) |
| B2c bench scaling | about 8 MB per sandbox, max 8.0 MB, mean 7.8 MB (docs/archive/agent-sandbox-prd.md:194) |

- RSS came from exact `/proc` tree walks of each bwrap PID, with the agent `sleep` excluded (docs/archive/agent-sandbox-prd.md:143-144).
- Own walls POC: start plus exit 0.02-0.03 s, peak about 3.8 MB (docs/archive/agent-sandbox-prd.md:232). The rewrite's start timing is unmeasured (docs/archive/agent-sandbox-prd.md:155).

### Proxy memory at 10 to 40 agents (plain HTTP, bareguard 0.30.0)

This is the evidence for the scaling shape. It predates the HTTPS range. `npm run bench:agents` ran the proxy in its own process with GC forced before each reading. Per agent, the worst case was 1 parked hold, 16 waiting, 1 turned away with 429 and the working slot filled, all with 64 KB bodies (docs/archive/agent-sandbox-prd.md:181).

| Agents | bareguard 0.29.0 | bareguard 0.30.0 |
|---|---|---|
| 10 | 141.9 MB | 99.5 MB |
| 20 | 318.3 MB | 114.4 MB |
| 30 | 290.1 MB | 124.3 MB |
| 40 | 383.6 MB | 143.6 MB |

(docs/archive/agent-sandbox-prd.md:183-188)

- Cause 1 (upstream): bareguard `gate.haltContext()` read and parsed the whole shared audit file once per ask. It was fixed in bareguard 0.30.0 (docs/archive/agent-sandbox-prd.md:190).
- Cause 2 (barebox): held bodies stayed in memory after spooling to disk. It was fixed with `readWorkBody(ctx)`. 68 held bodies grew `arrayBuffers` 4.6 MB before and 0.28 MB after (docs/archive/agent-sandbox-prd.md:191).
- Clean runs on published 0.30.0: 99.0-100.2 / 112.7-116.0 / 126.8-133.4 / 145.0-147.7 MB at 10 / 20 / 30 / 40 agents (docs/archive/agent-sandbox-prd.md:202).
- Memory stayed flat over 54,000 more requests. Audit file size does not move the worst case (docs/archive/agent-sandbox-prd.md:202).
- 40-agent runs read 143.2-172.2 MB depending on machine load. This is why the budget is a range (docs/archive/agent-sandbox-prd.md:202, docs/archive/agent-sandbox-prd.md:206).
- Normal use (3600 allowed requests, no holds): 83-87 MB (docs/archive/agent-sandbox-prd.md:192).
- Where 117 MB goes at 20 agents: libnode 52.7 MB, native C heap about 32 MB, V8 heap pages about 25 MB, other about 7 MB (docs/archive/agent-sandbox-prd.md:193).
- Scaling is about 1.4 MB per agent at the proxy, plus about 8 MB per sandbox for walls. It is linear with the fix (docs/archive/agent-sandbox-prd.md:194).

### Comparison with srt

| Agents | barebox worst case (proxy + 8 MB per sandbox) | srt 0.0.81 (~100 MB per sandbox) |
|---|---|---|
| 10 | ~180 MB | ~1 GB |
| 20 | ~275-280 MB | ~2 GB |
| 40 | ~465-495 MB | not measured |

(docs/archive/agent-sandbox-prd.md:196-201)

One srt sandbox measured about 100 MB: a 82 MB Node process, 3 socat relays at about 12 MB and 3 bash wrappers at about 8 MB. Start time was 1.87 / 2.05 / 1.98 s (docs/archive/agent-sandbox-prd.md:216-222). srt starts a proxy per sandbox (docs/archive/agent-sandbox-prd.md:224). Its blocks worked: allowed domain 200, other domain blocked, `~/.ssh` empty, outside writes blocked (docs/archive/agent-sandbox-prd.md:224). An idle Node process is 49 MB RSS (docs/archive/agent-sandbox-prd.md:212).

### Walls and front door POCs

- Walls (bwrap + overlay): the agent saw its own edits, the real folder was untouched, `~/.ssh` showed empty and a write outside the project was blocked. There was no network of its own (docs/archive/agent-sandbox-prd.md:228-231).
- Front door: a per-agent unix socket is bind-mounted in, and `socat` inside bridges `127.0.0.1:3128` to it. `example.com` was allowed (200), `github.com` denied, and `--noproxy` failed closed. `socat` inside costs 4.1 MB (docs/archive/agent-sandbox-prd.md:236-238).

### M0 measured run (Oct 26, PASS 14/14)

| Item | Measured | Verdict |
|---|---|---|
| Walls-only overhead per sandbox | mean 7.7 MB, max 7.9 MB | PASS |
| Through-proxy HTTP | 200 | PASS |
| CONNECT tunnel mechanics | 2 tunnels in log | PASS (opaque) |
| `~/.ssh` masked (host has 6 entries) | 0 visible | PASS |
| Project + home read-only | blocked | PASS |
| Bypass set | all fail, 0 default routes | PASS |
| Per-agent identity | attributed correctly | PASS |

(docs/archive/agent-sandbox-prd.md:254-264)

- The shell had no outbound internet, so the upstream was a local `python3 -m http.server`. The real-internet client matrix is M1's job (docs/archive/agent-sandbox-prd.md:266).

### M0 red-team (Oct 26, 8/8 detections across 5 breaks)

Each wall was broken on purpose through `SBX_BREAK=` hooks in the throwaway launcher. A pass means every break is detected (docs/archive/agent-sandbox-prd.md:270).

| Break | Observed |
|---|---|
| `nonet` (no net namespace) | detected, host-localhost leak |
| `nolock` (no tmpfs masks) | detected |
| `rw` (writable binds) | detected, canary created and removed |
| Miswired socket | detected both |
| Fat sandbox (50 MB alloc) | detected, 69.5 MB total |

(docs/archive/agent-sandbox-prd.md:272-278)

### Gotchas found

- Unix socket paths have a limit of about 108 characters. Use a short runtime dir (docs/archive/agent-sandbox-prd.md:284).
- Mounting the proxy socket needs a tmpfs over its target dir (docs/archive/agent-sandbox-prd.md:285).
- The bwrap root needs a `/lib64 -> usr/lib64` symlink, or every dynamic binary fails with `No such file or directory` (docs/archive/agent-sandbox-prd.md:286).
- Each sandbox holds 2 bwrap processes plus socat. Count RSS per PID tree, and never `pgrep -f` the bridge string (docs/archive/agent-sandbox-prd.md:287).
- Ubuntu's apt ships bubblewrap 0.9.0, which lacks the overlay options. CI and publish build 0.12.0 from a sha256-pinned source tarball and fail the run on any skipped test (docs/archive/agent-sandbox-prd.md:288).
