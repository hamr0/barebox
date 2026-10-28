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

Start the proxy with a hold rule, then decide from a second terminal
through the file checkpoint (`<runtime>/asks` + `<runtime>/answers`):

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
Approve forwards, deny and timeout answer 403 with the reason. These commands
need the proxy to be alive: with no live proxy on the runtime `sbx pending`,
`approve` and `deny` exit 1 and say so, because nothing would read the answer.

## One call: `run()` and `sbx run`

`run()` starts the proxy, sandboxes one command, answers holds and returns
the exit code with the ask and audit trail. Modes: `ask`, `auto` (default),
`trust`. Payment destinations (`/checkout`, `/payment`, `/orders`,
`/purchase`) hold in every mode; `ask` and `auto` also hold every
non-GET/HEAD request (an interim rule until the policy module lands).

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
- Certificates live in `<runtime>/certs` (`runtime` is required). There is no `certDir` option and no control socket: decisions flow through `<runtime>/asks` + `<runtime>/answers` or `hold.onAsk`.
- The TCP door is one agent: every connection through `createProxy`'s TCP `port` counts as the agent `tcp` and shares one hold line. Use `addAgent` sockets (`sbx run` does) for separate lines per agent.
- The upstream wall answers `403` for loopback, link-local (incl. `169.254.169.254`), the host's own addresses, private LAN ranges and unresolvable names. An IPv4 embedded in IPv6 is checked in every spelling: mapped, compat, uncompressed, NAT64 `64:ff9b::/96` (local-use `/48` denied outright) and 6to4 `2002::/16`; NAT64 and 6to4 of public sites stay reachable. Every DNS answer is checked and the dial is pinned to the checked IP; test-only options live under `unsafeTestOnly` (`allowLoopback`, `resolveUpstream`) and production never sets them.
- The audit log (`logFile`) is set to `0600` every time a proxy starts. The values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token` and `Api-Key` are logged as `[redacted]`; other headers and bodies are logged as-is unless your `redact` hook shapes them (it runs after the built-in scrub).
- One proxy per runtime: `createProxy` throws "in use by pid N" (`run()` rejects, `sbx run` exits 1) while a live proxy owns the runtime. The claim is held by the proxy process and the kernel frees it when the process dies, so a crashed proxy never blocks the runtime. Use another `SBX_RUNTIME`, or leave it unset for a fresh one.
- `launch()` starts the agent in the project dir, in a new session (no controlling terminal). Locked drawers are 21 credential stores (see `LOCKED_PATHS` in `src/launcher.js`); the agent's own model credentials in `~/.claude` stay readable until keys move out of its reach.
- `sbx` exits 0 ok, 1 unknown id / refused / no live proxy / run failure, 2 usage; `sbx run` mirrors the agent's exit code.
- Any listening unix socket under `$HOME` (IDE IPC, rootless-container sockets) is reachable from inside the sandbox: a read-only bind does not block `connect(2)`; the locked-paths list is the lever.

## What this package does not do

Enforcement policy (which requests hold) arrives in a later module; until
then holds follow the interim rules above (a path rule for `createProxy`;
payment destinations plus non-GET/HEAD for `run()`). The hold decision never
sees the request body, so card numbers in a body are not caught yet. No Docker, no MCP server, no macOS/Windows —
Linux only. POC harnesses live in `poc/` in the repo and never ship.
