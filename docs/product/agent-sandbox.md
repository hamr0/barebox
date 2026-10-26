# Lightweight sandbox for agents

> Working name: TBD. Status: idea / hackathon candidate (Meta Global AI Developer Hackathon, Oct 26 – Nov 4 2026).
> One line: **an agent runs on your machine with your real tools, every write is undoable, and nothing leaves the machine without passing a doorman. You're asked only when something irreversible is about to happen.**

## Application pitch

Agents are only useful when they get real access to your shell, files, network and wallet. Today developers pick between approving every action, which means forty prompts per task until they stop reading them or switch prompts off, and heavy isolation in Docker or a VM, which most people skip. Neither fits where the risk actually is. Reads are harmless, file writes can be fixed, and only a few actions can't be undone: paying, sending, publishing, pushing. We're building a lightweight sandbox that handles each of these differently. It runs on the developer's own Linux machine with no root, no daemon and no image, and the agent uses its real tools. Every file write lands on an undo layer that is committed or rolled back at the end. Secrets folders are locked. The agent has no internet of its own; its only way out is an egress proxy. The proxy lets lookups through, holds anything irreversible, and asks the human at that moment, while the rest of the agent keeps working. If an agent is asked to "find and book a flight under £450", it searches and compares freely and stops only twice: to pay, and to send the itinerary.

The core idea is capability without custody. The agent never holds the card or the API keys. It types placeholders, and the proxy fills in the real values only after the human approves that specific request. A hijacked or mistaken agent therefore has nothing to leak or spend. Decisions are deterministic: detected card numbers, known payment services, and operation labels from rwxmap. A fast classifier labels on-screen actions for browser and phone agents. Meta's Llama reads the full set of changes at the end of each run and explains in plain language what changed and what looks off-task. We'll measure prompts per task against standard agent setups, start-up time, and blocked exfiltration attempts. We'll ship it as an open-source tool any agent framework can run inside.

## The problem

Agents need real access to be useful: your shell, your files, the network. Today you choose between:

- **Approve everything.** 40 prompts per task, so people stop reading them, or turn them off (`--dangerously-skip-permissions`).
- **Heavy isolation.** Docker or a VM: images to build, a daemon, root, and the agent can't use your installed toolchain.

Neither matches what's actually risky. Reading is mostly harmless. Writing files is risky but *fixable*. Sending, paying, publishing and pushing are the only things that *can't be taken back*.

## The idea: r / w / x, each handled differently

Same three letters as rwxmap and bareguard:

| Letter | Meaning | What the sandbox does | You're asked? |
|---|---|---|---|
| **r** | reads, changes nothing | lets it through (except locked paths) | never |
| **w** | changes things, can be set back | records it on an undo layer | once, at the end (review the diff) |
| **x** | can't be undone: send, pay, publish, push, delete remote | holds it at the door until you decide | **at the moment it happens** |

So the agent is **not** blocked on every action. It runs freely, and you're interrupted only when an x is triggered. Everything else is either harmless (r) or reversible (w).

## How it works, in simple terms

Picture the agent working in your house:

1. **Tracing paper (w).** The agent sees your real files, but everything it changes goes on tracing paper laid over them. At the end you look at the tracing paper and press it down (**commit**) or throw it away (**rollback**).
2. **Locked drawers (r).** It can read most things. Some drawers are locked and can't even be opened: `~/.ssh`, `~/secrets`, browser profiles, password stores.
3. **One front door with a doorman (x).** The agent has no internet of its own. The only way out is through the doorman, who waves through lookups and holds anything that sends, pays or publishes until you say yes.

## How it's built (Linux, no root, no Docker)

```
  agent process (your real node, python, git, browser)
        │
  ┌─────┴──────────────── user namespace (unprivileged) ─────────────┐
  │  files:   overlayfs   lower = real ~/project   (read only)        │
  │                       upper = /scratch/run-42  (all writes land)  │
  │  Landlock: ~/.ssh, ~/secrets, browser profiles → unreadable       │
  │  seccomp:  no ptrace, mount, kernel modules                       │
  │  network:  own namespace, no internet; only route = the proxy     │
  └─────┬─────────────────────────────────────────────────────────────┘
        │  (unix socket bridged in, HTTP_PROXY / HTTPS_PROXY set)
        ▼
   egress proxy (mitmproxy + policy script → bareguard)
        ├── r  → forward
        ├── x  → hold the request, ask the human, forward or reject
        └── unknown → per-mode default (see Policy)
```

| Piece | Job | Off-the-shelf part |
|---|---|---|
| Namespaces + overlay | tracing paper, private network | `bubblewrap` (`bwrap`) |
| Landlock | locked drawers | `landrun` or a Python binding |
| seccomp | no escaping via kernel tricks | `bwrap` seccomp filter |
| Egress proxy | the doorman | `mitmproxy` (scriptable, sees inside HTTPS) |
| Decision | allow / ask / deny + audit log | bareguard |
| Labels | what an operation does | rwxmap (APIs), Jev (fast UI/text labels) |
| Review | commit / rollback the diff | new code |
| Model | end-of-run plain-language summary of the diff, flags off-task changes | Llama via Meta Model API |

**The egress proxy, briefly.** The network namespace has no route out except the proxy, so anything that ignores the proxy settings simply fails (fails closed). The proxy trusts a CA certificate that exists *only inside the sandbox* (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`), so it can see method, URL and body of HTTPS requests. Your real system never trusts that CA. Non-HTTP traffic (`git push` over SSH, raw TCP) is denied by default, or allowed through a SOCKS rule as an x. UDP is blocked, which forces HTTP/3 clients back to HTTP/2 where the proxy can see them.

## When does it stop and ask?

**Only when an x is triggered.** The proxy holds that one request open, sends you an approval prompt (terminal, or a push to your phone), and waits:

- **Approve** → the request goes out unchanged; the agent gets the real response.
- **Deny / timeout** → the agent gets a clear refusal (e.g. `403 denied by user: payment`) and can carry on or stop.

While one request is held, the rest of the agent keeps running.

## Walkthrough: "find and book me a flight to Barcelona under £450"

| Step | What the agent does | Network | Letter | You see |
|---|---|---|---|---|
| 1 | Reads your saved travel prefs file | none | r | nothing |
| 2 | Searches flights (API or website) | `GET`/search `POST` to airline, aggregator | r | nothing |
| 3 | Compares fares, writes `notes/barcelona.md` | none (file write → tracing paper) | w | nothing yet |
| 4 | Selects a fare, fills passenger details | `POST` form / offer request | w-ish (see below) | nothing, or one ask per new site in strict mode |
| 5 | **Pays** | `POST` to `/orders`, a checkout endpoint, or a payment processor | **x** | **"Pay £412.30 to Vueling — LHR→BCN 12 Nov, 1 adult. Approve?"** |
| 6 | Emails you the itinerary | `POST` to mail API / SMTP | **x** | "Send email to you@… — subject 'Your Barcelona flight'. Approve?" |
| 7 | Run ends | — | — | Diff review: `notes/barcelona.md` added. Commit / rollback. Llama summary of what changed. |

So for this task you'd be interrupted **twice** (pay, send), not forty times.

### The hard part: telling "search" from "pay" at the network level

The proxy sees requests, not intent, and websites use `POST` for both searching and paying. So `GET = r, POST = x` is too crude. The doorman uses layered, deterministic rules, strongest first:

1. **Card data in the body → always x.** Any 13–19 digit number that passes the Luhn check, or a CVV/expiry field, in an outgoing request. No guessing needed.
2. **Payment destinations → always x.** `api.stripe.com`, `*.adyen.com`, `*.paypal.com`, `*.braintreegateway.com`, `checkout.*`, paths like `/checkout`, `/payment`, `/orders`, `/purchase`.
3. **Known APIs → rwxmap labels.** e.g. for a flight API: create offer request / search = r, create order = x.
4. **Your personal data leaving → ask.** Passport number, date of birth, home address (from a local profile) appearing in a request body to a new destination.
5. **Unknown POST → mode default.** Strict: ask once per new domain, then remember for the run. Normal: allow and log. (Jev can classify an unknown endpoint + body summary as r/w/x in milliseconds when you want a smarter default.)

For browser agents (barebrowse / baremobile), a second signal comes from the screen: Jev labels the button about to be pressed ("Pay now" = x). The network rule is the backstop that can't be fooled by a misleading button label.

### Better: the agent never holds the card

Capability without custody: the agent fills payment fields with a **placeholder** (`{{CARD}}`). The proxy swaps in the real card details **only after you approve**, at the moment the request leaves. The agent can't leak, misuse or be tricked into spending a card it never had. A denied payment can't happen by accident, because without approval the request carries only a placeholder the merchant rejects.

Same trick works for other secrets: API keys and tokens live in the proxy, not in the agent's environment.

## Per-agent access: roles at the door, not in every tool

A common pattern today is one MCP server per agent, each loaded with roles, or a policy engine checking tool calls. The proxy can do the same job at finer detail, and in a place the agent can't get around.

### How the proxy does fine-grained access

1. **It knows which agent is calling.** Each agent runs in its own sandbox with its own private connection to the proxy. The proxy knows who's calling from *which connection the request arrived on*, not from a header the agent could fake.
2. **Rules can be as narrow as you want:**

```yaml
agent: support-bot
  github.com:
    r:  issues, comments           # allow
    w:  comment on issues          # allow
    x:  close issue                # ask
    x:  merge, delete, admin       # deny
    repos: [acme/helpdesk]         # only this repo
agent: travel-bot
  payments:
    x:  pay                        # ask, ≤ £500, merchants: airlines only
```

3. **rwxmap is the vocabulary.** It turns a raw request like `PUT /repos/acme/x/pulls/12/merge` into "merge a pull request = x". Without that mapping, people end up writing rules about URL patterns, which is where policy setups get unwieldy.
4. **The proxy holds the keys.** Each agent's credentials live in the proxy and are added to the request on the way out. An agent can't use another agent's credentials, and one shared token (e.g. GitHub) can be narrowed per agent beyond what the token itself allows.

### Compared with MCP-per-agent and policy-based setups

| | MCP per agent with roles | Policy-based (OPA/Cedar, MCP gateways) | Egress proxy with r/w/x |
|---|---|---|---|
| Where it's checked | inside each MCP server | in a central policy engine, usually at the tool-call layer | at the network exit the agent can't get around |
| **Can the agent bypass it?** | **Yes**, if it also has a shell or HTTP (it can just `curl` the API) | **Usually yes**, for the same reason | **No.** Its sandbox has no other route out |
| Covers | only traffic that goes through MCP | only traffic that goes through the gateway | everything: MCP, SDKs, `curl`, browsers |
| Detail level | which tools the agent can see; arguments rarely checked | depends on hand-written rules per tool | operation, resource and limits (amount, repo, recipient) |
| Credentials | often sit in each MCP server, shared across agents | varies | held by the proxy, one set per agent, added only on approval |
| Sprawl | agents × servers × roles | one policy engine, but rules per tool | one proxy, one policy file, one audit log |
| Ask a human mid-task | rare | rare | built in: the request is held at that moment |

**The key point:** an MCP role check only means something if the agent has *no other way* to reach the API. When the role lives in the tool but the agent's network stays open, the check works like a suggestion. The proxy works because the sandbox's network makes it the only way out.

### Where the proxy is weaker

- **It sees HTTP traffic, not what the agent meant to do.** Every API needs a mapping. rwxmap covers REST well. GraphQL and gRPC need the request body parsed, since one endpoint does many things.
- **It needs to see inside HTTPS.** That relies on the sandbox-only certificate; apps that pin their certificates break.
- **It can't see local actions.** File edits and local MCP servers talking over stdio never touch the network. The sandbox's file layer (undo layer, locked folders) covers those.
- **An MCP server running *outside* the sandbox with its own credentials is a hole.** Run it inside the sandbox so its traffic goes through the proxy too.

### Combine them

- **The proxy** is where rules are enforced.
- **A policy engine (Cedar or OPA)** can make the decisions if a company already uses one.
- **rwxmap** supplies the labels.
- **MCP** stays as the convenient way agents call tools, with the real enforcement at the door.

## Policy (sketch)

```yaml
mode: strict            # strict | normal | relaxed
locked_paths: [~/.ssh, ~/secrets, ~/.mozilla, ~/.config/chromium, ~/.gnupg]
network:
  always_x:
    domains: [api.stripe.com, "*.adyen.com", "*.paypal.com"]
    paths:   ["/checkout", "/payment", "/orders", "/purchase"]
    body:    [card_number_luhn, cvv]
  allow_r:
    domains: [api.duffel.com, "*.skyscanner.net"]
  unknown_post: ask_once_per_domain   # strict
  non_http: deny
  udp: deny
secrets:
  CARD: from_keyring          # injected by proxy after approval
approval:
  channel: terminal           # or phone push
  timeout: 120s → deny
end_of_run:
  diff_review: true
  summary_model: llama        # Meta Model API
```

## What it is and isn't

- **Is:** a strong guardrail against mistakes and prompt-injected agents, with near-zero setup and millisecond start.
- **Isn't:** a security boundary against a determined attacker. The kernel is shared; a kernel exploit escapes. Use a VM for that.
- **Prior art:** the blocking part exists (bubblewrap, firejail, Claude Code's and Codex's sandboxes). New here: **undo layer + r/w/x-aware doorman + held-request approval + secrets injected only on approval + end-of-run diff review.**

## Known gaps

- **Writes over sockets escape the overlay.** A local Postgres or Docker daemon isn't a file. Treat localhost sockets as x, or block them.
- **Commit conflicts** if you edited the same files while the agent ran → needs a 3-way merge.
- **Held requests can time out** on the server side if you approve slowly. Holding happens *before* forwarding, so only the agent's client waits; set a long client timeout.
- **Certificate pinning** breaks inspection for some clients (rare for CLIs, common for mobile apps).
- **Linux only.** macOS has no overlayfs or Landlock.

## 10-day plan (modules, each a POC)

1. `bwrap` + overlay run; commit / rollback of the upper layer.
2. Landlock locked paths.
3. Network namespace + mitmproxy as the only route out; fails closed.
4. Policy script → bareguard: always-x rules, held-request approval (terminal first).
5. Placeholder secrets injected on approval.
6. Per-step snapshots of the upper layer (per-step undo).
7. End-of-run diff review + Llama summary.
8. Demo A: flight booking — search runs free, payment stops for approval, card never in the agent.
9. Demo B: prompt-injected agent tries to read `~/.ssh` and push it out — both blocked; useful work committed, bad edits rolled back.
10. README, numbers (start time, prompts per task vs. stock), video.
