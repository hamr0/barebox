# Ledger brief after 0.6.0: plain http in tunnels, the host's node inside, keys in URLs, CI setup (2026-11-01)

Picked from the fix ledger by the user against the product goal: a quick, safe, one-command sandbox for a laptop or VPS. No tail-end hardening. Branch `chore/fix-ledger`, cut from main 0a64d1d (v0.6.0). Workers write all code and tests. Every required test is shown red on the current code, then green. Full suite (`npm test`) passes with 0 fail, 0 skipped. `npm run typecheck` and `npm run check:primitives` stay clean.

Each mechanism below was reproduced by the orchestrator in a real shell on 2026-11-01.

## 1. Plain HTTP inside a CONNECT tunnel (proxy)

**Problem.** Every sandbox sets `NODE_USE_ENV_PROXY=1` (`src/launcher.js:288`). Node's built-in `fetch` then tunnels *every* URL with `CONNECT`, even `http://` ones (curl does not: it sends plain `http://` as an absolute-form request). `handleConnect` (`src/proxy.js:913-948`) always wraps the tunnel in a server `TLSSocket`, so a plain HTTP request inside it dies.

Reproduced inside `sbx run`:
- `fetch('https://example.com/')` gives 200.
- `fetch('http://example.com/')` fails `UND_ERR_SOCKET`.
- With `localLlm: ["127.0.0.1:18434","localhost:18434"]` and a plain-HTTP server there, `fetch('http://localhost:18434/api/chat', {method:'POST'})` fails `UND_ERR_SOCKET`. `curl -X POST http://localhost:18434/api/chat` gets 200.

A Node agent that talks to a local model (Ollama and the like) is broken today.

**Change.** In `handleConnect`, after the verdict check and after writing `HTTP/1.1 200 Connection established`, look at the first byte the client sends. Use `rest[0]` if `rest.length`; otherwise wait for the first chunk and keep the socket idle timeout (`clientIdleMs`) while waiting.
- **First byte is `0x16` (TLS handshake):** do what happens today. Mint the cert, wrap in a `TLSSocket`, set `SECURE`, and `emit('connection')`.
- **Any other byte:** `unshift` the bytes back onto the raw socket, leave `SECURE` unset, and `server.emit('connection', sock)`, the same path plain HTTP takes in `admit`.

Mint the cert only on the TLS path, so a plain tunnel never mints one. The inner request is still re-checked by `handleRequest` against its own Host, as it is for TLS tunnels today. Its URL is `http://`, so a placeholder in it is refused `403 denied: secret.scheme` by the existing check (`src/proxy.js:682`). One reader per byte: make sure the sniff listener is removed before the http server takes the socket, so no byte is consumed twice or dropped.

**Tests (`test/m5.test.mjs` or `test/proxy.test.mjs`, wherever CONNECT tests live; real sockets, each with its own timeout):**
- A raw client sends `CONNECT 127.0.0.1:<plain upstream port>`, reads the 200, then sends `GET /x HTTP/1.1\r\nHost: 127.0.0.1:<port>\r\n\r\n` in clear. It gets the upstream's 200 body, and the upstream saw `/x`. Red today: no response, or a TLS error.
- The same through a tunnel, with a bound secret's placeholder in `Authorization`: `403 denied: secret.scheme`, the upstream saw 0 requests, and the only secret line is `swapped:false`. This closes ledger bullet "no test pins `secret.scheme` for plain http inside a CONNECT tunnel".
- The existing https-through-CONNECT tests stay green unchanged.
- e2e (`test/e2e.test.mjs`, next to the `NODE_USE_ENV_PROXY` test): `node -e "fetch('http://127.0.0.1:<plain fixture port>/?m=nodeplain')"` inside the sandbox prints the fixture body and exits 0. Red today: `UND_ERR_SOCKET`.

## 2. A placeholder in the URL is refused, not silently sent

**Problem.** Placeholders are found in headers only (`src/secrets.js:47`, `findPlaceholders`). `curl "https://bound/api?key=$KEY"` sends the literal `sbx-ph-...`, the API answers 401, and nothing tells the agent or the user why.

**Change.** In `handleRequest`, next to the `secret.host` and `secret.scheme` refusals and before the gate: if any secret's placeholder appears in `url.pathname + url.search`, refuse `403 denied: secret.url` in every mode. Write one `ev:'secret'` line per such secret, with `swapped:false` and the same shape as the others. Placeholders are `sbx-ph-<16 hex>`, so they never need URL-encoding and a plain `includes` on the raw string is enough. Keep one detection pass: extend `findPlaceholders`, or add a sibling in `src/secrets.js` that the proxy calls once. Don't scan the URL twice.

**Tests (`test/m5.test.mjs` and `test/secrets.test.mjs`):**
- A placeholder in the query to the bound host, over TLS: `403 denied: secret.url`, the upstream saw 0 requests, and `swapped:false`. Red today: the request goes through with the literal placeholder.
- A placeholder in the path: the same result.
- A unit test for the helper: the query, the path, and none.

**Docs.** In `barebox.context.md` "Keys the agent never holds", and in the README secrets paragraph: keys are swapped in headers only; a placeholder in the URL is refused `403 denied: secret.url`.

## 3. The host's node runs inside the sandbox

**Problem.** The sandbox binds `/usr` and `/etc` only and fixes PATH to `/usr/bin:/bin:/usr/sbin` (`src/launcher.js:202-204, 282`). A Node from nvm, fnm, asdf or a CI toolcache lives outside `/usr`, so `sbx run -- node agent.js`, or any npm-global agent CLI, gets `node: not found` (127). Proven on CI for PR #10 (setup-node in `/opt/hostedtoolcache`). It was worked around there by copying node into `/usr/bin`. Locally, a bwrap with `--ro-bind <prefix> <prefix>` and `PATH=<prefix>/bin:...` runs a node copied to `/tmp/.../bin/node`.

**Change.** In `launch()`: `prefix = dirname(dirname(process.execPath))`, the Node install prefix, where `bin/` holds node, npm and the global CLIs and `lib/node_modules` holds their code.
- Put `${prefix}/bin` first on the inside PATH unless it is already one of `/usr/bin`, `/bin` or `/usr/sbin`.
- Add `--ro-bind prefix prefix` unless the prefix is already visible inside: under `/usr`, under `$HOME` (read-only bound already), or under the project. Read-only, never writable.
- Place the bind before the locked-drawer masks, so a mask still lands on top.

Nothing else about PATH changes.

**Tests (`test/launcher.test.mjs` for args, plus one real run):**
- **Args, prefix outside home and `/usr`:** `--ro-bind <prefix> <prefix>` is present, and PATH starts with `<prefix>/bin`. Stub or inject the exec path if `launch` has no seam. If a seam is needed, add the smallest one (an optional `nodePrefix` opt defaulting to the derived value) and say so.
- **Args, prefix `/usr`:** no extra bind, and PATH unchanged.
- **Real run:** copy `process.execPath` to `<tmp>/bin/node` and run `sbx run -- node -e "console.log(process.execPath)"` with that copied node. It prints `<tmp>/bin/node`. Red today: it prints `/usr/bin/node`, or 127 where `/usr/bin/node` is absent.

**CI.** Remove the `sudo install ... /usr/bin/node` workaround (see item 5). CI's e2e:102 then proves the fix on a runner with no `/usr/bin/node`.

## 4. A mask folder under `/etc` is really hidden

**Problem.** `/etc` is `--ro-bind` (`src/launcher.js:204`), but `lockMask` returns `[]` for any path outside `$HOME` and the project (`src/launcher.js:64` and `:71`). So `maskDirs: ['/etc/xdg/...']` (a labels or config folder under `/etc`) stays readable inside. Reproduced 2026-10-30.

**Change.** In `lockMask`, treat every path the sandbox binds as maskable: `$HOME`, the project, `/etc`, `/usr`, and the node prefix from item 3. Use one list, the same one the binds are built from if that is simple. The comment on `lockMask` must match.

**Test (`test/launcher.test.mjs`, real launch):** create a folder under a bound root that the test owns, and pass it as `maskDirs`. Inside, it reads empty. Red today. If no writable spot exists under `/etc` in the test environment, stub the bound-roots list and say so. Never write to the real `/etc`.

## 5. One CI setup script

**Problem.** The 12-line bubblewrap source-build block, the apt deps and the AppArmor sysctl are duplicated in `.github/workflows/ci.yml` and `publish.yml`. Drift already broke PR #2.

**Change.**
- Move them into `scripts/ci-runner-deps.sh` (bash, `set -euo pipefail`), with the URL, sha256 and meson flags kept verbatim.
- Both workflows call `bash scripts/ci-runner-deps.sh`.
- Drop the `install ... /usr/bin/node` lines; item 3 makes them unnecessary.

`scripts/` is not in package `files`, so the tarball does not change. Verify with `npm pack --dry-run`.

## 6. Docs (orchestrator)

- README: `env.set` is the way past the secret-looking-name refusal (for example `XKB_KEYMAP`). `barebox.context.md:179` already says so.
- `barebox.context.md` "The audit file": each run without `SBX_RUNTIME` gets a fresh runtime. With a reused `SBX_RUNTIME`, `gate.jsonl` keeps growing; delete it between runs to reset it.
- CHANGELOG `[Unreleased]` for items 1-4.

## Verification by the orchestrator

- Each red/green rerun in a scratch copy.
- The full suite in a real shell.
- The reproductions above, re-run: the Node `fetch` http case and the local-model case get 200; the copied-node `process.execPath` case prints the prefix; a URL placeholder gets 403 `secret.url`.
- CI green with the `/usr/bin/node` copy removed.
- `git status` shows only the files named here.
