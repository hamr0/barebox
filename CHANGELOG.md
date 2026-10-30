# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- One config file, `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`, read by the CLI only (`sbx run`). Keys: `mode`, `holdTimeoutSec` (a positive integer or `"never"`), `heldBodyMaxMB` (a positive integer), `localLlm` (an array of `"host:port"`). A flag beats the file, the file beats the default. An unknown key, a bad value or bad JSON makes `sbx run` exit 2, naming the file and the key.
- The card floor now looks inside bodies: an allowed request whose body is 64 KB or less and holds a card number (13-19 digits, optional single space or dash between digits, first digit 2-6, Luhn-valid) parks as an ask with rule `card number in body (floor)` in every mode, `trust` included. Nothing is denied because of a card. Bodies over 64 KB stream through unchecked for cards (known gap). Each agent has one 64 KB working slot, so allowed body-carrying requests read their body one at a time per agent.
- Held bodies are spooled to `<runtime>/held/<id>` (a 0600 file in an owner-only dir), never kept in memory, and deleted whenever the hold ends. `runtimePaths` gains `heldDir` and `heldFile(id)`; `run()` gains the `heldBodyMaxBytes` option.
- The `sbx` CLI starts Node with `--max-semi-space-size=1` (caps the V8 young generation to hold proxy memory down; latency unchanged).
- `holds.js` exports `ASK_BODY_LIMIT`, `DEFAULT_HOLD_MAX_BODY` and `bodyPreview`.
- bareguard decides every request: one `gate.check()` per request, one gate per agent (and one for the TCP door's `tcp` agent), all sharing one tools table. `src/policy.js` exports `MODES` and `gateFor`. Modes: `ask` holds `r--` and asks for w and x; `auto` holds `rw-` and asks for x; `trust` holds `rwx`. GET/HEAD are r; POST/PUT/PATCH/DELETE are x; any other method is denied (`rwx.unlisted`). Every request is the tool `http.<METHOD>` until rwxmap labels land.
- The floor is two bareguard flags, `cardLike` and `paymentPath` (`/checkout`, `/payment`, `/orders`, `/purchase`), which ask in every mode, `trust` included.
- `createProxy` option `gateFor(agent, { humanChannel })`: returns a bareguard `Gate` or any object with `async check(action)` resolving `{ outcome, rule?, reason? }`; `askHuman` from a plain object goes to the same hold queue. Without it nothing is checked.
- One audit file: `<runtime>/gate.jsonl` (`runtimePaths(runtime).audit`; `createProxy`'s `logFile` names it). Every line is in bareguard's shape. bareguard's gate lines carry the decision; a response status is a `record` line joined to its decision line by `aid`; barebox's own facts are `annotate` lines with `surface:false`, keyed by `verdict`: `deny`, `hold`, `decide`, `hold-abandoned`, `hold-queue-full`, `stale-answer`, `malformed-answer`, `body`, and `resp` in forward-all mode. A request with a body gets one `body` line with `meta: { agent, rid, bodyBytes, bodySha256 }`, joined to its gate line by `rid`.
- A runtime-level audit-only `sbx` gate takes lines for agents whose gate is not built, and every line when `gateFor` is omitted. `close()` waits up to 3 s for pending audit writes; later lines are dropped.
- `GateLike` gains optional `record`, `annotate` and `drainAnnotations`; `check` may return `aid`.
- Config key `localLlm` and the `allowLocal` option of `run()` and `createProxy()`: exact `host:port` pairs (such as a local model server) pass the wall's private/loopback check; link-local (cloud metadata) never does. `checkUpstream` takes a port argument.
- New dependency: `bareguard` 0.29.0 (exact).
- rwxmap labels. Two config keys: `labels` (folders the rwxmap CLI wrote) and `tenants` (vendor -> server URLs, replacing placeholder hosts such as `your-domain.atlassian.net`). `src/labels.js` exports `loadLabels({ labels, tenants })`, which reads each `<v>.rwxmap.review.json` for request keys (via `rwxmap/match`). The letters come only from the matching `<v>.rwxmap.json` file's `bareguard.tools`, the file you review and can edit; rwxmap's own guessed letter is never used. A bad or missing label file fails `sbx run` before any agent starts.
- The tool for a request is the label's key when a label documents it, else a model endpoint key (`r`), else `http.<METHOD>`. A key a label documents but the gate file lacks (a row you deleted) is denied (`rwx.unlisted`).
- Model endpoints are `r`: Anthropic `/v1/messages` and `/v1/messages/count_tokens`; OpenAI `/v1/chat/completions`, `/v1/responses` and `/v1/embeddings`; and on each `localLlm` host:port `/api/chat`, `/api/generate`, `/api/embed`, `/v1/chat/completions` and `/v1/completions` (http only).
- `src/policy.js` exports `buildTools`, `toolFor` and `emptyMatcher`; `gateFor` takes `tools`; `createProxy` and `run()` take `labels`; `launch()` takes `maskDirs`.
- New dependency: `rwxmap` 0.8.0 (exact). Label files written before rwxmap 0.8.0 fail to load with rwxmap's "regenerate" message.

### Changed

- `hold.maxBody` now defaults to 52428800 (50 MB), was 1048576. A body over the cap is denied `403 body too large to hold`.
- The audit file carries a body's length and SHA-256 only (the `body` line), never its content. The ask payload carries the 4 KB `bodyPreview` (card numbers masked except the last 4).
- Long audit fields are cut before they reach bareguard (`url` to 400 characters, `note` and `reason` to 200), so the ids that join an ask to its outcome survive bareguard's 1000-byte `meta` limit.
- A denial reads `403 denied: <rule>[: reason]`; an ask carries the gate's rule (`rwx.ask`, `flags.cardLike`, `flags.paymentPath`) and letter. The card floor's rule is now `flags.cardLike`, not `card number in body (floor)`.
- Request bodies of 64 KB or less are read in the agent's working slot before the gate decides; a waiting request's body is spooled to `<runtime>/held/<id>` when it enters the hold line.
- `holds.add` takes `preview`, `bodyBytes` and `bodyFile` in place of `body` (internal shape).

### Removed

- **Breaking:** the `createProxy` option `maxLogBody`.
- **Breaking:** the separate `<runtime>/audit.jsonl` and the `runtimePaths().gateAudit` path; `runtimePaths().audit` is now `gate.jsonl`.
- The `req` audit line and request-header logging: no request header is written to the audit file. `scrubSecrets` and `SENSITIVE_HEADERS` are gone; the `redact` hook stays and now shapes annotate `meta`.
- **Breaking:** `hold.shouldHold` and `hold.match` (replace with `gateFor`); `run()`'s internal `shouldHoldForMode` and `holds.js`'s `matchPath` / `ShouldHold` type.

### Security

- The audit file holds no request header and no body content. Card numbers are masked in the ask files' 4 KB preview. Known gap: other secrets inside a body still show in the ask file's preview until bareguard redaction lands.
- The config file is hidden inside the sandbox wherever it resolves (the mask follows `XDG_CONFIG_HOME`).
- Label folders are hidden inside the sandbox the same way, so the agent cannot rewrite a letter for the next run.
- The modes decide, with no keyword patterns: the gate runs with empty content patterns, so no word in a URL or method (`remove`, `drop`, `TRUNCATE TABLE`) asks or denies on its own. Only the mode letters, the labels and the floor (card number, payment path) decide.

## [0.4.0] - 2026-10-29

### Changed

- Held requests are one per agent (pre-1.0 behaviour change): each agent has at most one held request being read or parked; later ones wait in line, unread, in order. At most 16 wait; the next gets `429 hold queue full`.
- The hold deadline counts from arrival (default 120 s, `never` supported), time in line and reading the body included; a request past its deadline is denied `hold timeout` whether waiting, sending, or parked.
- `proxy.removeAgent(name)` ends that agent's open connections, and its held requests end `deny` / `client gone` at once. `run()` calls it when the sandbox exits, so shutting down no longer races a held request into a `proxy closing` log line.
- An existing runtime dir you don't own (e.g. `SBX_RUNTIME=/tmp`, which 0.3.0 accepted) is now refused with a message naming the dir, its owner and a subdir to use, such as `/tmp/sbx`.
- The TCP door is one agent: every connection through `createProxy`'s TCP `port` counts as the agent `tcp` and shares one hold line. Use `addAgent` sockets (`sbx run` does) for separate lines.

### Security

- The upstream wall checks an IPv4 embedded in IPv6 in every spelling: IPv4-mapped (`::ffff:7f00:1` as well as `::ffff:127.0.0.1`) and compat forms, uncompressed loopback (`0:0:0:0:0:0:0:1`), NAT64 `64:ff9b::/96` (local-use `64:ff9b:1::/48` denied outright) and 6to4 `2002::/16`. NAT64 and 6to4 of public sites stay reachable.
- Runtime folders are owner-only (0700) whatever the umask: the runtime root, `asks/`, `answers/` and `socks/`. A runtime dir you own is tightened to 0700.
- Each minted certificate gets a random 128-bit serial instead of a shared serial file (`ca.srl`) that concurrent mints could corrupt (a failed mint reached the agent as a 502); at most 4 mints run at once.

### Fixed

- `createProxy` throws synchronously on an unopenable `logFile` and releases the runtime. A later audit-log write error prints one `sbx: audit log … write failed` line to stderr and the proxy keeps running.
- The `sbx run` "answer with" hint quotes the runtime path, so it is safe to copy-paste.
- Overlay hashing reads files in 1 MiB chunks, so very large files no longer exhaust memory.
- `run()` releases the runtime when the agent socket can't be created; the claim no longer stays held refusing a second `run()` on the same runtime as "in use".

## [0.3.0] - 2026-10-28

Breaking changes (pre-1.0): the control socket, `createProxy`'s `certDir` and `allowUpstream`, `run()`'s low-level options, the hold queue's `approve`/`deny`/`size` and the top-level `allowLoopback` option are removed or moved; `runtime` is now required. Each is marked **Breaking** below.

### Added

- M2.5 integration seam: `ask`, `auto` (the default) and `trust` modes with the card/payment floor in every mode; the `onAsk` seam plus the file-checkpoint ask channel (`asks/<id>.json` → `answers/<id>.json`, control socket deleted); `run()` wrapping proxy + launch; `sbx run [--mode ask|auto|trust] [--json] [--overlay]`; a 0600 JSONL audit log (bareguard's line shape deferred to M3); `sbx pending` / `approve` / `deny` refuse when no live proxy owns the runtime.
- M4 undo layer: per-run overlay tracing paper with `sbx diff` / `commit` / `rollback`, conflict flagging (refuse by default, `--skip-conflicts`), and `node_modules` invisibility. Diff walks the merged view with node inside the mount (no shell); `commit` stages into the project and swaps by journaled rename, undoing every step on failure (a full undo reports nothing was applied; a partial one names the steps not undone and keeps the commit folder with the originals); it strips setuid/setgid bits, and committed files get fresh mtimes. `rollback` reports diff's answer, or raw upper paths when the project is gone. Needs bubblewrap ≥ 0.11.0; older bwrap gets a clear refusal.
- The agent always starts in the project dir.
- The commit applies under read-only project folders.
- Rollback always removes the overlay upper, whatever the agent left there.
- The walker has no output cap, and node is resolved wherever it is installed.
- One proxy per runtime, enforced by a kernel-held lock: `createProxy` binds an abstract unix socket named from the runtime's real path, device and inode and holds it while the proxy lives. A second live proxy throws "in use" naming the owner's pid, before touching sockets or `asks/`. The kernel frees the lock when the process dies (SIGKILL included), so there is no stale claim and no takeover. `<runtime>/owner` (0600) only names the pid.
- `sbx pending`, `approve` and `deny` need a live proxy on the runtime and refuse otherwise.
- `SBX_OVERLAY_IGNORE=a,b` extends the list of folders the overlay layer ignores (`node_modules` is always ignored).
- Locked credential paths: `launch` hides 21 credential stores from the agent (keys, password stores, keyrings, browser profiles, cloud/cluster/container credentials, `gh`/`op` CLIs, token files). Folders are masked with an empty tmpfs and files read empty; a symlinked drawer is masked at its real target inside `$HOME` or the project. `~/.claude` is deliberately left visible.
- The upstream wall lives in `src/wall.js`: every resolved IP is checked after DNS, unresolvable names fail closed, and the dial is pinned to the checked IPs. One writer (`denyRes`) produces every HTTP error response.
- The agent sandbox always runs with bwrap `--new-session`, so its stdin is never the terminal.

### Security

- The audit log is owner-only (0600) and scrubs sensitive header values to `[redacted]` before any user `redact` hook runs.
- Ask and answer files are owner-only (0600); `sbx approve`/`deny` accept only `h<n>` ids; `sbx pending` and `sbx run` strip terminal control sequences from agent-controlled fields before printing.

### Removed

- **Breaking:** Control socket (`createProxy`'s `controlSocket` option, `SBX_SOCK`): decisions flow through the file checkpoint (`<runtime>/asks` + `<runtime>/answers`) or `hold.onAsk`; the migration guards are deleted.
- **Breaking:** `createProxy`'s `certDir`. Certificates always live in `<runtime>/certs`, and `runtime` is now required.
- **Breaking:** `createProxy`'s `allowUpstream`. There is no escape hatch around the upstream wall.
- **Breaking:** `run()`'s `gate`, `match`, `shouldHold`, `pollMs`, `proxyPort` and `extraEnv`. Use `createProxy` + `launch` for low-level control.
- **Breaking:** The hold queue's `approve(id)`, `deny(id)` and `size()`, and `body` on `pending()` entries (the ask payload carries `bodyPreview`).
- **Breaking:** The library's `ASK OPEN <id>` write to stderr. The library never prints.

### Changed

- **Breaking:** Test-only options moved under one key: `createProxy({ unsafeTestOnly: { allowLoopback, resolveUpstream } })`, `run({ unsafeTestOnly: { allowLoopback } })`. The CLI variable is renamed from `SBX_ALLOW_LOOPBACK` to `SBX_UNSAFE_TEST_ALLOW_LOOPBACK`.
- `onEvent(e)` on `createHolds` / `createProxy`'s `hold` / `run()`: `{ type: 'ask', ask }` when a hold parks, `{ type: 'decided', id, decision, reason }` when it settles. `run()`'s `asks` result is built from these events.
- `sbx run` prints how each ask ended: `decided <id> <allow|deny> [(reason)]`, or `{"ev":"decided","id","decision","reason"}` with `--json`, between the `ask` and `done` lines. A hold whose client went away reports `deny` / `client gone` (also in `run()`'s `asks`).
- Decisions are written as `allow` / `deny` everywhere, the audit log included. `approve` is still accepted, as an alias in answer files only.
- `sbx` results go to stdout; every error, refusal and usage-on-error goes to stderr through `err`. `--help` stays on stdout, exit 0. Exit codes don't change.

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

[0.3.0]: https://github.com/hamr0/barebox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hamr0/barebox/compare/1f144f4...v0.2.0
[0.1.0]: https://github.com/hamr0/barebox/commit/1f144f4
