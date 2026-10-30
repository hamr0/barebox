# barebox.context.md — complete adopter contract (independent quickstart)

barebox is a lightweight local sandbox for AI agents: every write undoable,
nothing leaves the machine without passing the doorman.

## Install

Requires Node >= 22 and Linux with unprivileged user namespaces (bwrap)
for sandboxes; the proxy and CLI run anywhere Node runs.

```bash
npm install barebox
```

`primitives.json` (shipped at package root) lists every public primitive
with its contract. Use it to pick imports; the JSDoc on each export is
the full reference.

## 60-second quickstart

```bash
npx sbx --help
```

```js
import { createProxy, launch } from "barebox";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// one sandboxed agent: walls up, front door on, locked drawers masked.
// The agent's socket must already be listening: create the front door,
// then add the agent to it.
const runtime = mkdtempSync(join(tmpdir(), "sbx-"));
const proj = mkdtempSync(join(tmpdir(), "proj-"));
const proxy = createProxy({ runtime, port: 0, logFile: join(runtime, "mitm.log") });
await proxy.ready;
const child = launch({ runtime, agent: "fx", proj, command: ["bash", "-c", "echo hi"], socket: proxy.addAgent("fx"), caFile: proxy.caFile });
await new Promise((r) => child.on("close", r));
await proxy.close();
```

```js
import { createProxy } from "barebox";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// the front door: terminates agent TLS, logs every request, parks holds.
// The TCP port is opt-in for tests (bound to 127.0.0.1); agents connect
// over their own unix socket: proxy.addAgent("fx") -> <runtime>/socks/fx.sock
const runtime = mkdtempSync(join(tmpdir(), "sbx-"));
const proxy = createProxy({ runtime, port: 0, logFile: join(runtime, "mitm.log") });
await proxy.ready;
await proxy.close();
```

## Holds (human approval)

When a request needs a decision (see "Modes and the gate" below), it parks.
Decide from a second terminal through the file checkpoint (`<runtime>/asks` + `<runtime>/answers`):

```bash
SBX_RUNTIME=/tmp/sbx npx sbx pending
SBX_RUNTIME=/tmp/sbx npx sbx approve h1
SBX_RUNTIME=/tmp/sbx npx sbx deny h2 "reason here"
```

Held requests wait (default 120 s, `never` supported), counting from arrival:
time spent in line and reading the body counts too, and a request past its
deadline is denied `hold timeout` whether waiting, sending, or parked. Each
agent holds at most one request being read or parked; later ones wait in
line, unread, in order — at most 16, the next gets `429 hold queue full`.
Approve forwards, deny and timeout answer 403 with the reason. A held body is spooled to `<runtime>/held/<id>` (never kept in memory, deleted when the hold ends); one over `hold.maxBody` (default 50 MB) is denied `403 body too large to hold`. These commands
need the proxy to be alive: with no live proxy on the runtime `sbx pending`,
`approve` and `deny` exit 1 and say so, because nothing would read the answer.

## One call: `run()` and `sbx run`

`run()` starts the proxy, sandboxes one command, answers holds and returns
the exit code with the ask and audit trail. Modes: `ask`, `auto` (default),
`trust`; see "Modes and the gate" below. `run()` takes `heldBodyMaxBytes` to
change the held-body cap and `allowLocal` (the `localLlm` setting) to let
exact `host:port` pairs, such as a local model server, past the wall.

```js no-run
import { run } from "barebox";
const { exit, asks, audit, diff, runtime } = await run({
  proj: "/path/to/project",
  command: ["bash", "-c", "echo hi"],
  mode: "auto",
  overlay: true,        // writes land on the undo layer; `diff` lists them
  onAsk: async (ask) => ({ decision: "deny", reason: "not today" }), // omit for the file checkpoint
});
```

```bash
sbx run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd> [...]
```

`sbx run` uses the current directory as the project and `SBX_RUNTIME` as the
runtime (a short temp dir otherwise, printed on stderr). It prints an `ask`
line when a request parks and a `decided` line when it ends, then `done`;
with `--json` stdout carries only JSON lines. Its exit code mirrors the
agent's.

`sbx run` reads one optional config file,
`${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`, with keys `mode`,
`holdTimeoutSec` (positive integer or `"never"`), `heldBodyMaxMB`
(positive integer) and `localLlm` (array of `"host:port"`). A flag beats the file, the file beats the default; an
unknown key, bad value or bad JSON exits 2 naming the file and key. The file
is hidden inside the sandbox wherever it resolves. The library does not read it.
Two more keys, `labels` and `tenants`, are described under "Labels and model endpoints".

## Modes and the gate

Every request becomes one bareguard `gate.check()`; `run()` builds one gate
per agent (and one for the TCP door's `tcp` agent), all sharing one tools
table. The mode picks the agent's rwx letters:

| Mode | Letters | Asks for |
|---|---|---|
| `ask` | `r--` | `w`, `x` |
| `auto` (default) | `rw-` | `x` |
| `trust` | `rwx` | nothing |

`GET`/`HEAD` are `r`; `POST`/`PUT`/`PATCH`/`DELETE` are `x`; any other method
is denied in every mode (`rwx.unlisted`). Without a label a request is the tool
`http.<METHOD>` (see "Labels and model endpoints"). The gate runs with empty
content patterns, so no word in a URL or method asks or denies on its own: the
mode letters, the labels and the floor decide. The floor is two bareguard flags,
`cardLike` (a body of 64 KB or less holding a card number: 13-19 digits,
optional single space or dash, first digit 2-6, Luhn-valid) and `paymentPath`
(`/checkout`, `/payment`, `/orders`, `/purchase`); both ask in every mode,
`trust` included. Nothing is denied because of a card. Bodies over 64 KB
stream through unscanned. The body never enters the gate's action.

barebox's hold queue is each gate's `humanChannel`: the ask files, `onAsk`
and `sbx approve|deny` work as above, and the ask carries the gate's `rule`
(`rwx.ask`, `flags.cardLike`, `flags.paymentPath`) and `letter`. A request
with a body of 64 KB or less is read in the agent's working slot before the
gate decides. Denials read `403 denied: <rule>[: reason]` (a human or timeout
denial reads `denied: <reason>`).

`createProxy` takes `gateFor(agent, { humanChannel })`, called once per agent,
returning a bareguard `Gate` or any object with `async check(action)` that
resolves `{ outcome: "allow" | "deny" | "askHuman", rule?, reason? }`;
`askHuman` from a plain object goes to the same queue. Without `gateFor`
nothing is checked and everything forwards. `policy.js` exports `MODES` and
`gateFor({ agent, mode, auditPath, humanChannel })`. bareguard writes its
decisions to `<runtime>/gate.jsonl`, the one audit file (see "The audit file"
below). `close()` waits up to 3 s for requests
still inside a `check()`.

`localLlm` (config key; `allowLocal` on `run()` and `createProxy()`) is an
array of `"host:port"` strings. Only those exact pairs pass the wall's
private/loopback check, never link-local (cloud metadata).

## The audit file

`<runtime>/gate.jsonl` (`runtimePaths(runtime).audit`; `run()` returns it as
`audit`) is the only log, one JSON object per line, all in bareguard's shape.
- Decisions: bareguard's gate lines carry the action (`method`, `url`, `tool`,
  `agent`, `rid`) and an `aid`.
- Response status: a `phase:"record"` line with the same `aid` and
  `result.status`.
- barebox's own facts: `phase:"annotate"`, `surface:false`, keyed by `verdict`:
  `deny`, `hold`, `decide`, `hold-abandoned`, `hold-queue-full`, `stale-answer`,
  `malformed-answer`, `body`, and `resp` (forward-all mode, no gate). A hold and
  its outcome share `meta.id`; a request with a body gets one `body` line,
  `meta: { agent, rid, bodyBytes, bodySha256 }`, joined to its gate line by
  `action.rid`.
- Lines for an agent whose gate is not built, and every line when `gateFor` is
  omitted, are written by a runtime-level `sbx` gate (`meta.agent` names the
  agent).

```bash
# every request with its response status, joined by aid
jq -s 'group_by(.aid)[] | select(.[0].aid) | {url: .[0].action.url, status: (map(.result.status) | map(select(.)) | first)}' <runtime>/gate.jsonl
# a request's body size and hash, joined by rid
jq -c 'select(.verdict=="body") | .meta' <runtime>/gate.jsonl
# one ask from hold to decision
jq -c 'select(.meta.id=="h1")' <runtime>/gate.jsonl
```

## Labels and model endpoints

Two config keys turn on rwxmap labels. `labels` is an array of folders the
rwxmap CLI wrote (`rwxmap <spec> -o <dir> --vendor <v>`); a leading `~/` means
`$HOME`. `tenants` is `{ "<vendor>": ["https://tenant.example.com"] }` (a
non-empty array of http(s) URLs per vendor); it replaces that vendor's server
URLs, so a placeholder host such as `your-domain.atlassian.net` matches your
tenant. A `tenants` vendor that no label folder defines is an error.

`loadLabels({ labels, tenants })` (`src/labels.js`) reads each
`<v>.rwxmap.review.json` for request keys, through `rwxmap/match`. The letters
come only from the sibling `<v>.rwxmap.json` file's `bareguard.tools`, the file
you review and can edit; rwxmap's own guessed letter is never used. A folder
with no review file, a review file without its gate file, or two vendors
defining the same key fails `sbx run` before any agent starts. A label file
written before rwxmap 0.8.0 fails with rwxmap's "regenerate it with rwxmap
0.8.0" message.

The tool for a request is chosen in this order: the label's key when a label
documents the request; else a model endpoint key when known; else
`http.<METHOD>`. A label key the gate file lacks (a row you deleted) reaches the
gate unlisted and is denied (`rwx.unlisted`), in every mode: it fails closed.

Model endpoints are `r` (free in every mode): `api.anthropic.com`
`POST /v1/messages` and `/v1/messages/count_tokens`; `api.openai.com`
`POST /v1/chat/completions`, `/v1/responses` and `/v1/embeddings`; and on each
`localLlm` host:port `POST /api/chat`, `/api/generate`, `/api/embed`,
`/v1/chat/completions` and `/v1/completions` (http only). Any other path on
those hosts is a normal `POST`.

Label folders are hidden inside the sandbox like the config file, so the agent
cannot rewrite a letter. `run()` and `createProxy()` take `labels:
{ matcher, tools }` (what `loadLabels` returns); omitted means no labels and
only the built-in model endpoints.

## Undo layer

`overlay: true` (`sbx run --overlay`) mounts a per-run upper over the
project: the agent sees the real files, every write lands on the upper.
Review and press it down from the same runtime:

```bash
SBX_RUNTIME=/tmp/sbx npx sbx diff [--agent <name>]       # A/M/D, conflicts flagged
SBX_RUNTIME=/tmp/sbx npx sbx commit [--skip-conflicts]   # refuses on conflicts by default
SBX_RUNTIME=/tmp/sbx npx sbx rollback                    # throw the paper away
```

A path the project changed after the run started is a conflict: commit
refuses all of it unless `--skip-conflicts`. `node_modules` is invisible to
the layer (extend with `SBX_OVERLAY_IGNORE=a,b`). Commit strips setuid/setgid
and does not keep mtimes; a killed commit leaves a `.sbx-commit-*` folder in
the project that blocks the next diff/commit/run until you remove it. The
library equivalents are `diffOverlay`, `commitOverlay` and `rollbackOverlay`.
The overlay needs bubblewrap >= 0.11.0 for `--overlay` / `sbx diff|commit|rollback` (Ubuntu 24.04 ships 0.9.0: build from source or use a newer distro); plain runs work with older bwrap.

## Gotchas

- Agent socket paths must fit the ~108-byte unix limit: `launch()` throws
  with the path and its length past 107 chars. Keep `runtime` short.
- `launch({ caFile })` is what makes HTTPS work inside: it binds a combined
  bundle (system roots + barebox CA) and sets `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`. Without it every HTTPS call from inside fails
  verification. Only `ca.pem` enters the sandbox, never the key.
- Certificates live in `<runtime>/certs` (`runtime` is required). There is no `certDir` option and no control socket: decisions flow through `<runtime>/asks` + `<runtime>/answers` or `hold.onAsk`. Each minted certificate gets a random 128-bit serial (no shared `ca.srl`), and at most 4 mints run at once.
- Memory and limits: one proxy serves at most 40 agents, enforced. `addAgent` throws `createProxy: agent limit reached (40 agents per proxy); run another proxy for more`; the TCP door's `tcp` agent does not count, and `removeAgent` frees a place. For more than 40 agents run more proxies. Measured worst case (every agent with 1 parked + 16 waiting + a filled 64 KB body slot): proxy 99.5 / 114.4 / 124.3 / 143.6 MB at 10 / 20 / 30 / 40 agents (budget 150 MB; needs bareguard 0.30.0), plus about 8 MB per sandbox (limit 10). Normal use is 83-87 MB.
- The TCP door is one agent: every connection through `createProxy`'s TCP `port` counts as the agent `tcp` and shares one hold line. Use `addAgent` sockets (`sbx run` does) for separate lines per agent. `removeAgent(name)` ends that agent's open connections; its held requests end as deny / client gone. `run()` calls it when the sandbox exits, so a request still held then ends as client gone, not `proxy closing`.
- The upstream wall answers `403` for loopback, link-local (incl. `169.254.169.254`), the host's own addresses, private LAN ranges and unresolvable names. An IPv4 embedded in IPv6 is checked in every spelling: mapped, compat, uncompressed, NAT64 `64:ff9b::/96` (local-use `/48` denied outright) and 6to4 `2002::/16`; NAT64 and 6to4 of public sites stay reachable. Every DNS answer is checked and the dial is pinned to the checked IP; test-only options live under `unsafeTestOnly` (`allowLoopback`, `resolveUpstream`) and production never sets them.
- `createProxy` throws synchronously on an unopenable `logFile` (a directory, a missing parent, no permission) and releases the runtime. The runtime root, `asks/`, `answers/`, `held/` and `socks/` are owner-only (`0700`) whatever the umask. An existing runtime dir you own is tightened to `0700`; one you don't own (such as `/tmp`) is refused with an error naming the dir and its owner and suggesting a subdir like `/tmp/sbx`. The audit file (`logFile`, `gate.jsonl`) is set to `0600` every time a proxy starts. No request header and no body content is written to it: a body is logged as its length and SHA-256 only. The ask payload's `bodyPreview` (the first 4 KB, card numbers masked except the last 4) lives in the ask file only; other secrets inside a body still show there until bareguard redaction lands. Your `redact` hook shapes the `meta` of barebox's own annotate lines.
- One proxy per runtime: `createProxy` throws "in use by pid N" (`run()` rejects, `sbx run` exits 1) while a live proxy owns the runtime. The claim is held by the proxy process and the kernel frees it when the process dies, so a crashed proxy never blocks the runtime. Use another `SBX_RUNTIME`, or leave it unset for a fresh one.
- `launch()` starts the agent in the project dir, in a new session (no controlling terminal). Locked drawers are 21 credential stores (see `LOCKED_PATHS` in `src/launcher.js`); the agent's own model credentials in `~/.claude` stay readable until keys move out of its reach.
- `sbx` exits 0 ok, 1 unknown id / refused / no live proxy / run failure, 2 usage; `sbx run` mirrors the agent's exit code.
- Any listening unix socket under `$HOME` (IDE IPC, rootless-container sockets) is reachable from inside the sandbox: a read-only bind does not block `connect(2)`; the locked-paths list is the lever.

## What this package does not do

Per-API labels (rwxmap) arrive in a later release; until then every request
is `http.<METHOD>`. The card-in-body floor checks bodies of 64 KB or less;
larger bodies stream through unchecked for cards. The removed `hold.shouldHold`
and `hold.match` are gone: pass `gateFor` instead. No Docker, no MCP server, no macOS/Windows —
Linux only. POC harnesses live in `poc/` in the repo and never ship.
