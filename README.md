```
  ┌──────────────┐
  │ agent inside │
  │  r   w   x   │── doorman ──▶ world
  └──────────────┘
   read undo ask

  barebox
```

> An agent runs on your machine with your real tools, every write is undoable, and nothing leaves the machine without passing a doorman. You're asked only when something irreversible is about to happen.
> Status: M0 walls + front door proven and red-teamed, POC-grade. Linux only. Millisecond start, ~8 MB per sandbox.

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/hamr0/barebox?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

## What it is

- **Tracing paper (w).** The agent sees your real files, but every change lands on an overlay layer. At the end you commit it or roll it back.
- **Locked drawers (r).** It reads most things. `~/.ssh`, `~/secrets`, browser profiles stay shut.
- **One front door with a doorman (x).** No network of its own — lookups pass, anything that sends, pays, or publishes waits for your yes.

Full story: [the PRD](docs/product/agent-sandbox-prd.md).

## What it isn't

- Not a security boundary against kernel exploits — the kernel is shared, use a VM for that.
- No Docker, no cluster, no cloud. Your box or a cheap VPS.

## Install

```
npm install barebox
```

Requires Node.js >= 22. Zero production dependencies. Published 0.1.0 is the reservation scaffold — the API lands with the graduation rewrite.

## Quickstart

POC-grade: clone it and run the walls proof (needs an unsandboxed shell for namespaces + sockets).

```
git clone https://github.com/hamr0/barebox && cd barebox
npm run poc:m0       # 20 sandboxes, bypass suite
npm run redteam:m0   # breaks each wall on purpose; passes iff all detected
```

## The bare ecosystem

bareguard decides the action; barebox contains where it runs. Same patterns throughout.

- **[bareguard](https://github.com/hamr0/bareguard)** — the single gate every action passes through: allow / deny / ask-a-human.
- **[rwxmap](https://github.com/hamr0/rwxmap)** [WIP] — labels API operations r/w/x for the gate.
- **barebox** — the walls and the front door, in this repo.

## License

Apache 2.0. See [LICENSE](LICENSE).
