# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.0] - 2026-10-27

Graduation rewrite: the M0-M2 POCs become a library.

### Added

- `createProxy`: TLS-inspecting front door with on-demand per-host certs (via `openssl`), per-agent unix sockets as identity (`addAgent`), an opt-in test TCP listener bound to 127.0.0.1 only, and `ready`/`close` lifecycle.
- Upstream wall: DNS is fail-closed (every answer checked, unresolvable names denied) and the checked IP is pinned into the dial, so there is no rebinding. Loopback, link-local, private LAN (RFC 1918, CGNAT, ULA) and host addresses are denied; `allowUpstream` and test-only `allowLoopback` are the opt-ins.
- Hold queue: requests park for approve/deny or time out; holds abandoned by a disconnecting client are dropped; `maxBody` caps queued bodies.
- `launch`: bwrap sandbox with locked paths, a CA trust bundle exported through the usual env vars, and the runtime sockets masked from the sandbox (including a runtime reached through a symlink).
- `sbx` CLI: `pending`, `approve`, `deny`, `--help`, defined exit codes; socket from `SBX_SOCK` or `SBX_RUNTIME`, with no cwd default.
- `npm run bench`: per-sandbox and proxy RSS benchmark.
- TypeScript types, `primitives.json` and `barebox.context.md`.

### Changed

- `createProxy` throws unless `certDir` and the control socket live inside `runtime` (real paths compared).

### Fixed

- POST/PUT bodies to real hostnames no longer hang; the client stream is paused until the upstream pipe is attached.

### Security

- Audit log is created 0600 and `Authorization` headers are scrubbed from logged lines.

## [0.1.0] - 2026-10-26

### Added

- Reserved `barebox` on npm; repo scaffold (docs, M0 throwaway POC, publish workflow).
