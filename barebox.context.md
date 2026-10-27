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
npx barebox --help
```

```js
import { launch } from "barebox";
// one sandboxed agent: walls up, front door on :3128, locked drawers masked
const child = launch({ runtime: "/tmp/sbx", agent: "fx", proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
await new Promise((r) => child.on("close", r));
```

```js
import { createProxy } from "barebox";
// the front door: terminates agent TLS, logs every request, parks holds
const proxy = createProxy({ port: 3129, certDir: "./certs", logFile: "./mitm.log" });
proxy.close();
```

## Holds (human approval)

Start the proxy with a hold rule and a control socket, then decide from a
second terminal:

```bash
SBX_SOCK=/tmp/sbx/ctl.sock npx sbx pending
SBX_SOCK=/tmp/sbx/ctl.sock npx sbx approve h1
SBX_SOCK=/tmp/sbx/ctl.sock npx sbx deny h2 "reason here"
```

Held requests wait (default 120 s, `never` supported); approve forwards,
deny and timeout answer 403 with the reason.

## What this package does not do

Enforcement policy (which requests hold) arrives in a later module; this
release parks by path rule. No Docker, no MCP server, no macOS/Windows —
Linux only. POC harnesses live in `poc/` in the repo and never ship.
