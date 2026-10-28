# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- M2.5 integration seam: `ask`, `auto` (the default) and `trust` modes with the card/payment floor in every mode; the `onAsk` seam plus the file-checkpoint ask channel (`asks/<id>.json` → `answers/<id>.json`, control socket deleted); `run()` wrapping proxy + launch; `sbx run [--mode ask|auto|trust] [--json] [--overlay]`; a 0600 JSONL audit log (bareguard's line shape deferred to M3); `sbx pending` / `approve` / `deny` refuse when no live proxy owns the runtime.
- M4 undo layer: per-run overlay tracing paper with `sbx diff` / `commit` / `rollback`, conflict flagging (refuse by default, `--skip-conflicts`), and `node_modules` invisibility (Q3). Diff walks the merged view with node inside the mount (no shell); `commit` stages into the project and swaps by journaled rename, undoing every step on failure (a full undo reports nothing was applied; a partial one names the steps not undone and keeps the commit folder with the originals); it strips setuid/setgid bits, and committed files get fresh mtimes. `rollback` reports diff's answer, or raw upper paths when the project is gone.
- The agent always starts in the project dir.
- The commit applies under read-only project folders (6.3).
- Rollback always removes the overlay upper, whatever the agent left there (6.2).
- The walker has no output cap, and node is resolved wherever it is installed (6.5, 6.6).
- One proxy per runtime is enforced: a second live proxy on the same runtime throws naming the owner's pid; the claim dies with its process; nothing is ever taken over.

### Security

- Ask and answer files are owner-only (0600); `sbx approve`/`deny` accept only `h<n>` ids; `sbx pending` and `sbx run` strip terminal control sequences from agent-controlled fields before printing.

### Removed

- Control socket (`createProxy`'s `controlSocket` option, `SBX_SOCK`): decisions flow through the file checkpoint (`<runtime>/asks` + `<runtime>/answers`) or `hold.onAsk`; the migration guards are deleted.
- `createProxy`'s `certDir`. Certificates always live in `<runtime>/certs`, and `runtime` is now required.
- `createProxy`'s `allowUpstream`. There is no escape hatch around the upstream wall.
- `run()`'s `gate`, `match`, `shouldHold`, `pollMs`, `proxyPort` and `extraEnv`. Use `createProxy` + `launch` for low-level control.
- The hold queue's `approve(id)`, `deny(id)` and `size()`, and `body` on `pending()` entries (the ask payload carries `bodyPreview`).
- The library's `ASK OPEN <id>` write to stderr. The library never prints.

### Changed

- Test-only options moved under one key: `createProxy({ unsafeTestOnly: { allowLoopback, resolveUpstream } })`, `run({ unsafeTestOnly: { allowLoopback } })`. The CLI variable is renamed from `SBX_ALLOW_LOOPBACK` to `SBX_UNSAFE_TEST_ALLOW_LOOPBACK`.
- `onEvent(e)` on `createHolds` / `createProxy`'s `hold` / `run()`: `{ type: 'ask', ask }` when a hold parks, `{ type: 'decided', id, decision, reason }` when it settles. `run()`'s `asks` result is built from these events.
- `sbx run` prints how each ask ended: `decided <id> <allow|deny> [(reason)]`, or `{"ev":"decided","id","decision","reason"}` with `--json`, between the `ask` and `done` lines. A hold whose client went away reports `deny` / `client gone` (also in `run()`'s `asks`).
- Decisions are written as `allow` / `deny` everywhere, the audit log included. `approve` is still accepted, as an alias in answer files only.
- `sbx` results go to stdout; every error, refusal and usage-on-error goes to stderr through `err`. `--help` stays on stdout, exit 0. Exit codes don't change. (Item 4 changed no output streams.)

## [0.2.0] - 2026-10-27

Graduation rewrite: the M0–M2 POCs become a library. The POCs (Oct 26, `poc/`, not shipped) passed all three go/no-go gates:

- walls + front door: 14/14 checks, red-team 8/8
- inspection inside HTTPS: curl, node, python requests and git over the real internet
- hold-and-ask: a 9-scenario matrix

### Added

- `createProxy`: TLS-inspecting front door with on-demand per-host certs (via `openssl`), per-agent unix sockets as identity (`addAgent`), an opt-in test TCP listener bound to 127.0.0.1 only, and `ready`/`close` lifecycle.
- Upstream wall: DNS is fail-closed (every answer checked, unresolvable names denied) and the checked IP is pinned into the dial, so there is no rebinding. Loopback, link-local, private LAN (RFC 1918, CGNAT, ULA) and host addresses are denied; `allowUpstream` and test-only `allowLoopback` are the opt-ins.
- Hold queue: requests park for approve/deny or time out; holds abandoned by a disconnecting client are dropped; `maxBody` caps queued bodies.
- `launch`: bwrap sandbox with locked paths, a CA trust bundle exported through the usual env vars, and the runtime sockets masked from the sandbox (including a runtime reached through a symlink).
- `sbx` CLI: `pending`, `approve`, `deny`, `--help`, defined exit codes; socket from `SBX_SOCK` or `SBX_RUNTIME`, with no cwd default.
- `npm run bench`: per-sandbox and proxy RSS benchmark. Measured with 20 agents: 7.8 MB mean per sandbox (budget 10), and proxy 60.1 MB idle, 71.9 MB with 20 parked holds (budget 80).
- TypeScript types, `primitives.json` and `barebox.context.md`.
- `package.json` `repository` field, which npm provenance needs. Published with SLSA provenance.

### Changed

- `createProxy` throws unless `certDir` and the control socket live inside `runtime` (real paths compared).
- HTTP handling uses the stdlib `http` server instead of hand-rolled framing.
- The `bin` path is written as `src/cli.js`, without `./`.

### Fixed

- POST/PUT bodies to real hostnames no longer hang; the client stream is paused until the upstream pipe is attached.
- HEAD requests no longer return 502 after 6 s, and slow upstreams are no longer killed at 10 s.
- Plain-HTTP requests now go through holds the same way HTTPS ones do.
- The publish workflow installs the same sandbox runner deps as CI (bubblewrap, socat, curl, openssl, userns sysctl).
- The adopter-gate quickstart uses the 0.2.0 API (`pending()`, a JSON import with `with { type: "json" }`).

### Security

- The proxy listens on 127.0.0.1 only, not on all interfaces.
- An agent can no longer approve its own holds. A read-only bind does not block `connect` on a unix socket, so the runtime is masked inside the sandbox and the control socket must live in the runtime.
- Loopback is no longer reachable through the proxy. A failed DNS lookup is denied, and the private LAN is blocked.
- `ca.key` can no longer leak through a `certDir` outside the runtime.
- Audit log is created 0600 and `Authorization` headers are scrubbed from logged lines.

## [0.1.0] - 2026-10-26

### Added

- Reserved `barebox` on npm; repo scaffold (docs, M0 throwaway POC, publish workflow).

[Unreleased]: https://github.com/hamr0/barebox/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hamr0/barebox/compare/1f144f4...v0.2.0
[0.1.0]: https://github.com/hamr0/barebox/commit/1f144f4
