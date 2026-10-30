```
  ┌──────────────┐
  │ agent inside │
  │  r   w   x   │── doorman ──▶ world
  └──────────────┘
   read undo ask

  barebox
```

> An agent runs on your machine with your real tools, every write is undoable, and nothing leaves the machine without passing a doorman. You're asked only when something irreversible is about to happen.
> No root, no daemon, no image. One shared proxy, many thin sandboxes: ~8 MB each, 10 ms to start (M0 POC figure — unmeasured on the rewritten code, TODO re-measure).

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/hamr0/barebox?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
  <img src="https://img.shields.io/badge/platform-Linux-2a4f8c" alt="platform: Linux">
</p>

## Why

Agents need real access to be useful — shell, files, network. Today you pick one of two bad options:

- **Approve everything.** About forty prompts per task. People stop reading them, or switch prompts off.
- **Heavy isolation.** Docker or a VM: images, a daemon, root, and the agent can't use your installed toolchain. Most people skip it.

Neither matches where the risk is. Reads are mostly harmless. File writes can be fixed. Only a few actions can't be undone: paying, sending, publishing, pushing. barebox asks about those and nothing else.

## What it is

Three letters, each handled differently — the same `r`/`w`/`x` as [bareguard](https://github.com/hamr0/bareguard) and [rwxmap](https://github.com/hamr0/rwxmap).

| Letter | Meaning | What barebox does | You're asked? |
|---|---|---|---|
| `r` | reads, changes nothing | lets it through (except locked paths) | never |
| `w` | changes things, can be set back | records it on an undo layer | once, at the end (review the diff) |
| `x` | can't be undone: send, pay, publish, push | holds it at the door until you decide | at the moment it happens |

The agent works in your house:

- **Tracing paper (w).** The agent sees your real files, but every change lands on an overlay laid over them. At the end you commit it or roll it back (`sbx run --overlay -- <cmd>`, then `sbx diff`, `sbx commit`, `sbx rollback`).
- **Locked drawers (r).** It reads most things. Keys and password stores (`~/.ssh`, `~/secrets`, `~/.gnupg`, `~/.password-store`, keyrings), browser profiles, cloud and cluster credentials (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.config/op`) and token files (`~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.cargo/credentials.toml`) stay shut. The agent's own model credentials (`~/.claude`) do not; moving those out is M5.
- **One front door with a doorman (x).** No network of its own. Lookups pass; anything that sends, pays, or publishes waits for your yes.
- **Keys it never holds.** The agent types a placeholder; the doorman puts the real API key in the request header only after you approve that request.

## What it isn't

- **Not a security boundary against a determined attacker.** The kernel is shared; a kernel exploit escapes. Use a VM for that. barebox is a strong guardrail against mistakes and prompt-injected agents.
- No Docker, no VM, no cluster, no cloud control plane. Your box or a cheap VPS.
- Not a content filter and not intent detection — the doorman sees requests, not intent. Cert-pinned apps, non-HTTP egress and UDP are denied, not inspected.

## How it works

```
  agent process (real node, python, git)
        |
  +-----+--------------- bwrap sandbox (unprivileged) ---------------+
  |  files:   overlay   lower = real project (read only)             |
  |                     upper = per-run tracing paper                |
  |  locked paths (~/.ssh etc.) -> empty tmpfs or /dev/null          |
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

- **Walls** are [bubblewrap](https://github.com/containers/bubblewrap), unprivileged: separate net/pid/ipc/uts namespaces, read-only binds, tmpfs over locked paths.
- **Identity** is the socket, not a header the agent could fake. One socket per agent, all into one proxy.
- **HTTPS inspection** uses a local CA that exists only inside the sandbox; the proxy reads method, URL, headers and body, then forwards.
- **The doorman's x-rules**, strongest first: card numbers in the body (Luhn) → payment domains and paths (`/checkout`, `/payment`, …) → rwxmap labels for known APIs → unknown `POST` by mode (strict: ask once per domain; normal: allow and log).
- **Approvals** come from a second terminal (`sbx pending`, `sbx approve <id>`, `sbx deny <id>`). Timeout means deny, with a clear `403` reason. One held request per agent at a time: later ones wait in line (16 at most, then `429 hold queue full`), and the deadline counts from arrival.

## Numbers

Measured, not estimated. Fedora, kernel 7.2, bubblewrap 0.12.0, Node 22.

| | barebox (measured) | [srt](https://github.com/anthropic-experimental/sandbox-runtime) 0.0.81 (measured) |
|---|---|---|
| Memory per sandbox | **7.8 MB** mean, 8.0 MB max | ~100 MB (each sandbox runs its own proxy) |
| Proxy | one shared: **about 85-120 MB** in normal use; **about 100 / 113-120 / 127-133 / 145-175 MB** at 10 / 20 / 30 / 40 agents in the full worst case (each agent with 1 parked + 16 waiting + a filled body slot). The low end is a quiet machine, the high end a busy one | one per sandbox |
| Start + exit | **10 ms** (M0 POC; unmeasured on the rewrite, TODO re-measure) | 1.87-2.05 s |
| 10 agents | ~180 MB worst case (proxy + 10 x 8 MB) | ~1 GB |
| 20 agents | ~275-280 MB worst case | ~2 GB |
| 40 agents | ~465-495 MB worst case | not measured |

barebox is for small teams: free, local and lightweight, built to assist and to connect to many tools, not to run swarms or thousands of agents. Budget: shared proxy about 145-175 MB in the full worst case at 40 agents, each extra sandbox 10 MB or less. 40 agents per proxy is the maximum and it is enforced: `addAgent` refuses the 41st with an error telling you to run another proxy. Above 40, run more proxies. Machine load moves the number. A long audit file does not: 205 MB of audit measured the same as 3 MB. Bypass attempts (`--noproxy`, unset proxy env, direct IP, host localhost) all fail closed, and a red-team script breaks each wall on purpose to prove the checks can fail. Setup, dead ends and why: [findings](docs/logs/findings.md).

## Roadmap

| Module | What |
|---|---|
| M0 | Walls + front door |
| M1 | Proxy sees inside HTTPS (curl, node, python requests, git) |
| M2 | Hold one `x` request, ask, keep everything else running |
| M3 | Decide r/w/x deterministically (rwxmap + bareguard), audit log |
| M4 | Undo layer: `diff`, `commit`, `rollback`, conflict flagging |
| M5 | Keys the agent never holds |
| M6 | Scale run: 20 agents + shared proxy |
| M7 | Demos: payment held for approval; prompt-injected `~/.ssh` exfil blocked |

M0–M2 are the go/no-go. Later: macOS (`sandbox-exec` + APFS clones), Windows via WSL2, Landlock/seccomp hardening. Full spec: [the PRD](docs/product/agent-sandbox-prd.md).

## Install

```
npm install barebox
```

Requires Node.js >= 22. Zero production dependencies. Needs bubblewrap >= 0.11.0 for `--overlay` / `sbx diff|commit|rollback` (Ubuntu 24.04 ships 0.9.0: build from source or use a newer distro); plain runs work with older bwrap. CI builds bubblewrap 0.12.0 from a checksum-pinned source tarball and fails if any test is skipped. The API is in [`barebox.context.md`](barebox.context.md) and `primitives.json` (both ship in the package); the `sbx` CLI comes with it.

## Try the POCs

Linux only, with `bwrap` (>= 0.11.0 only for the overlay), `socat`, `openssl`, Node >= 22 and Python 3. Needs a normal shell (namespaces + listening sockets), not a tool sandbox. The POCs are throwaway proofs, not the product.

```
git clone https://github.com/hamr0/barebox && cd barebox
npm run poc:m0              # 20 sandboxes, bypass suite
npm run redteam:m0          # breaks each wall on purpose; passes iff all detected
bash poc/m1/run-m1.sh local # HTTPS inspection against a local TLS echo server
bash poc/m1/run-m1.sh real  # same, real internet, incl. git over https
```

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the walls, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out. Work in → green / red.* Replaces hand-rolled allowlists and scattered policy code.
- **[barebox](https://github.com/hamr0/barebox)** [WIP] — the walls and the front door, this repo. *Agent in → contained run out: writes undoable, irreversible actions held for a human.* Replaces Docker/VM isolation and approve-everything prompts.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Add-on for bareguard** — labels API operations for the gate.

- **[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] — labels every OpenAPI operation r/w/x as a starting point, marked for review. *API spec in → per-operation letter out.* barebox's doorman uses its labels for known APIs.

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

bareguard decides the action; barebox contains where it runs.

## License

Apache 2.0. See [LICENSE](LICENSE).
