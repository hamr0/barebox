# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- Planned for M2.5 (in the PRD, not built): three modes, `ask`, `auto` (the default) and `trust`, with cards and payments asking in every mode. A file-checkpoint ask channel (`asks/<id>.json` → `answers/<id>.json`) will replace the control socket. bareguard becomes the policy gate, and any `check(action)` gate can be passed in instead. One 0600 JSONL audit log will use bareguard's line format.

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
