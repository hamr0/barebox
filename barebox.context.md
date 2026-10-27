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
import { launch } from "barebox";
// one sandboxed agent: walls up, front door on :3128, locked drawers masked.
// The agent's socket must already be listening: proxy.addAgent("fx").
const child = launch({ runtime: "/tmp/sbx", agent: "fx", proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
await new Promise((r) => child.on("close", r));
```

```js
import { createProxy } from "barebox";
// the front door: terminates agent TLS, logs every request, parks holds.
// The TCP port is opt-in for tests (bound to 127.0.0.1); agents connect
// over their own unix socket: proxy.addAgent("fx") -> <runtime>/socks/fx.sock
const proxy = createProxy({ port: 3129, certDir: "./certs", logFile: "./mitm.log" });
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

Held requests wait (default 120 s, `never` supported); approve forwards,
deny and timeout answer 403 with the reason.

## Gotchas

- Agent socket paths must fit the ~108-byte unix limit: `launch()` throws
  with the path and its length past 107 chars. Keep `runtime` short.
- `launch({ caFile })` is what makes HTTPS work inside: it binds a combined
  bundle (system roots + barebox CA) and sets `SSL_CERT_FILE`,
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`. Without it every HTTPS call from inside fails
  verification. Only `ca.pem` enters the sandbox, never the key.
- `createProxy` throws if `certDir` or `controlSocket` is not inside `runtime` (real paths, so symlinks don't help): the launcher masks only the runtime dir, and `ca.key` / the approve socket must stay behind it. The default `<runtime>/certs` always passes.
- The upstream wall answers `403` for loopback, link-local (incl. `169.254.169.254`), the host's own addresses, private LAN ranges and unresolvable names. Every DNS answer is checked and the dial is pinned to the checked IP; `allowLoopback` is test-only.
- The audit log (`logFile`) is created `0600`, but only when the file is new. `Authorization` and `Proxy-Authorization` values are logged as `[redacted]`; other headers (cookies, API-key headers) and bodies are logged as-is unless your `redact` hook shapes them (it runs after the built-in scrub).
- `sbx` exits 0 ok, 1 unknown id / refused / socket failure, 2 usage.
- Any listening unix socket under `$HOME` (IDE IPC, rootless-container sockets) is reachable from inside the sandbox: a read-only bind does not block `connect(2)`; the locked-paths list is the lever.

## What this package does not do

Enforcement policy (which requests hold) arrives in a later module; this
release parks by path rule. No Docker, no MCP server, no macOS/Windows —
Linux only. POC harnesses live in `poc/` in the repo and never ship.
