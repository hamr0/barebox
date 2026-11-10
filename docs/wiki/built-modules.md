---
title: Built modules M0-M7
description: What each module of barebox does as built (walls, HTTPS inspection, hold and ask, the ask seam, decide, undo, keys, scale, demos), with key decisions and current measured results.
---

# Built modules M0-M7

Modules are built in dependency order. Each one is a POC aimed at its riskiest assumption. A module is done when it works alone and still works connected to the earlier ones (docs/archive/agent-sandbox-prd.md:365-365).

M0, M1 and M2 were the go/no-go modules (docs/archive/agent-sandbox-prd.md:367-367). All three passed (docs/archive/agent-sandbox-prd.md:406-406).

The order after M2 was decided Oct 27: M2.5, M4, M3, M5, M6, M7. M2.5 came first because M3 plugs policy into the ask seam. M4 came before M3 because without undo the project is read-only inside the sandbox (docs/archive/agent-sandbox-prd.md:408-412).

## M0. Walls and front door

An agent runs with locked paths, no network of its own, and one way out: a per-agent socket into the proxy (docs/archive/agent-sandbox-prd.md:373-373).

- Built with bubblewrap, `socat` and Node (docs/archive/agent-sandbox-prd.md:374-375).
- The launcher locks paths and gives each agent its own unix socket into the proxy. The connection is the agent's identity, not a header it could fake. A `socat` bridge runs inside, with `HTTP_PROXY` and `HTTPS_PROXY` set (docs/archive/agent-sandbox-prd.md:375-375).
- Result (Oct 26): pass. Walls-only overhead is at most 7.9 MB per agent, and the bypass set (unset proxy env, `--noproxy`, direct curl) fails closed (docs/archive/agent-sandbox-prd.md:380-380).

## M1. HTTPS inspection

The proxy reads method, URL, headers and body of HTTPS requests (docs/archive/agent-sandbox-prd.md:386-386).

- A local CA exists only inside the sandbox, with per-host certificates. Trust env vars are `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE`. Non-HTTP and UDP traffic is denied (docs/archive/agent-sandbox-prd.md:388-388).
- Decision (Oct 26): certificates come from an `openssl` subprocess. This costs no proxy RSS, and the binary is present. node-forge was dropped (docs/archive/agent-sandbox-prd.md:387-387).
- Result (Oct 26): pass. curl, node, python requests and git all work through it. Unknown host, dead upstream (502), no CA and plain HTTP all behave correctly (docs/archive/agent-sandbox-prd.md:393-393).

## M2. Hold and ask

One request is parked while the human is asked, and everything else keeps running (docs/archive/agent-sandbox-prd.md:399-399).

- A hold queue parks the request. A timeout means deny, with a clear 403 reason such as `403 denied by user: payment` (docs/archive/agent-sandbox-prd.md:401-401).
- Result (Oct 26): pass. Approve forwards the request while other requests complete. Concurrent holds work. A double decision is never applied twice. Malformed input gets 400 and the proxy survives. A 1 MB cap denies at the door. A 30 s hold survives and approves (docs/archive/agent-sandbox-prd.md:406-406).
- The M2 control socket and its `pending`, `approve` and `deny` server were later replaced by the M2.5 channel (docs/archive/agent-sandbox-prd.md:431-431).

## M2.5. Integration seam

Any loop, agent or human can start a sandboxed run in one call and answer its asks through one channel (docs/archive/agent-sandbox-prd.md:418-418). The risk was two code paths drifting apart for loops and for humans in other processes (docs/archive/agent-sandbox-prd.md:421-421).

- **`onAsk(ask)`** returns `{ decision: "allow" | "deny", reason? }`, the same shape as bareguard's `humanChannel`. The default implementation is the file checkpoint (docs/archive/agent-sandbox-prd.md:426-427).
- **File checkpoint.** `<runtime>/asks/<id>.json` is written when a request parks. `<runtime>/answers/<id>.json` is read once, then renamed away. A stale or late answer is ignored and logged (docs/archive/agent-sandbox-prd.md:428-429).
- **Terminal output.** `sbx run` prints an `ask <id> <agent> <method> <url> rule=<rule>` line, or `{"ev":"ask",...}` with `--json`. The library prints nothing. A caller gets `asks/<id>.json` and the `onEvent` callback (docs/archive/agent-sandbox-prd.md:430-430).
- **Ask payload.** It holds `id`, `agent`, `method`, `url`, `rule`, `letter`, a 4 KB body preview with card numbers masked except the last 4 digits, `waitingSec` and `expiresAt`. The caller adds its own context (docs/archive/agent-sandbox-prd.md:432-432).
- **`run({ proj, command, mode, onAsk })`** returns `{ exit, asks, audit, diff, runtime }`. It wraps `createProxy`, `addAgent` and `launch`, which stay public as the low-level parts. `diff` is the M4 overlay diff (docs/archive/agent-sandbox-prd.md:433-433).
- **`sbx run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd>`.** With `--json`, stdout carries JSON lines for `ask`, `decided` and `done`. The exit code mirrors the agent's (docs/archive/agent-sandbox-prd.md:434-434).
- **Audit lines** use bareguard's shape. Since M3 B2b, `gate.jsonl` is the one audit file (docs/archive/agent-sandbox-prd.md:435-435).

Checks that hold: a loop answers through `onAsk` with no files; a second process answers by writing `answers/<id>.json`; a stale answer is ignored; writing an answer file from inside the sandbox fails (docs/archive/agent-sandbox-prd.md:438-442).

## M3. Decide

Every request gets a letter and a decision through a gate. The mode decides what each letter does. Every decision lands in the one audit log (docs/archive/agent-sandbox-prd.md:449-449). It uses bareguard (`Gate`, rwx, flags, audit; 0.29.0 for `rwx.askUnheld`) and rwxmap's `rwxmap/match` entry (0.8.0) (docs/archive/agent-sandbox-prd.md:450-450).

### Letters and modes (decided Oct 29)

The letter is per request. The mode is per run (docs/archive/agent-sandbox-prd.md:458-458).

- **r**: read with no outside effect (GET and HEAD).
- **w**: reversible write, only where an rwxmap label says so.
- **x**: irreversible. Any non-GET request with no label is x (docs/archive/agent-sandbox-prd.md:460-462).

| Mode | rwx letters | askUnheld | Effect |
|---|---|---|---|
| `ask` | `r--` | `["w","x"]` | r free; w and x ask |
| `auto` (default) | `rw-` | `["x"]` | r and w free; x asks |
| `trust` | `rwx` | `[]` | all free |

(docs/archive/agent-sandbox-prd.md:463-472)

The floor (card numbers and payment paths) asks in every mode, `trust` included (docs/archive/agent-sandbox-prd.md:464-464).

bareguard gained an optional `rwx.askUnheld`, an array of letters. A matched letter the agent does not hold, but which is listed, goes to `askHuman` with rule `rwx.ask`. A letter not listed is still `rwx.denied`. An unlisted tool is `rwx.unlisted` (docs/archive/agent-sandbox-prd.md:466-466).

### Letters come only from config

The gate never takes a letter from the caller. barebox sends `tool` as the rwxmap key for a labelled request, or `http.<METHOD>` for an unlabelled one. The generated rwx file gives each its letter, and unlisted means deny. Granting rwx and passing the letter as a flag was rejected, because a mislabelled x would pass silently (docs/archive/agent-sandbox-prd.md:480-480).

The action handed to the gate is `{ type: "net", tool, url, method, agent, cardLike?, paymentPath? }`, with no letter (docs/archive/agent-sandbox-prd.md:514-514).

### Labels and request keys

- rwxmap's `rwxmap/match` entry maps `(method, url)` to a key. It never returns null. With no match it returns a request-only key such as `api.anthropic.com.POST /v1/messages`. Sidecars carry a `servers` list. The import costs about 0.9 MB; `rwxmap/discover` costs 14 MB and is out (docs/archive/agent-sandbox-prd.md:482-482).
- Decided Oct 30: the gate file's letters (`<v>.rwxmap.json`, `bareguard.tools`) always win. rwxmap's guessed letter is never used. A spec key the gate file lacks is denied (docs/archive/agent-sandbox-prd.md:505-505).
- Config keys `labels` (folders the rwxmap CLI wrote) and `tenants` (vendor to server URLs). Label folders are masked inside the sandbox (docs/archive/agent-sandbox-prd.md:506-506).
- Tool order: spec key when a label documents the request, else a model endpoint key (`r`), else `http.<METHOD>` (docs/archive/agent-sandbox-prd.md:507-507).

### Model endpoints

barebox labels model endpoints `r` by policy, not through rwxmap, because rwxmap labels some of them `x` (for example `/v1/responses` with store can persist state). The default list covers Anthropic `/v1/messages` and `/v1/messages/count_tokens`; OpenAI `/v1/chat/completions`, `/v1/responses` and `/v1/embeddings`; and each `localLlm` host:port with `/api/chat`, `/api/generate`, `/api/embed`, `/v1/chat/completions` and `/v1/completions` (docs/archive/agent-sandbox-prd.md:484-484, 507-507). A model endpoint request is never card-scanned (docs/archive/agent-sandbox-prd.md:493-493).

### The floor and the body check

- A card number sets `cardLike: true` on the action, with `flags: { cardLike: { true: "ask" } }`. Flags run before the allowlist and rwx, so they ask in every mode. A flag can only add an ask or a deny, which is why a caller-set flag is safe and a caller-set letter is not (docs/archive/agent-sandbox-prd.md:488-488).
- Payment paths (`/checkout`, `/payment`, `/orders`, `/purchase`) use the same mark (docs/archive/agent-sandbox-prd.md:488-488).
- Bodies up to 64 KB are read whole into the agent's 64 KB working slot, scanned, then decided. A card turns the request into a floor ask. Nothing is ever denied because of a card (docs/archive/agent-sandbox-prd.md:492-495).
- Bodies over 64 KB stream through unchecked for cards. They still get the normal letter and mode decision. Reason: random 16-digit numbers pass Luhn about 1 time in 10, so denying large uploads would break uploads full of ids (docs/archive/agent-sandbox-prd.md:494-494).
- The scanner `src/cardscan.js` looks for 13 to 19 digits, with optional single space or dash separators, a first digit of 2 to 6, then Luhn. It keeps a 40-byte tail between chunks (docs/archive/agent-sandbox-prd.md:496-496).
- Held bodies are written to a file in the owner-only runtime folder, never kept in memory. The cap is 50 MB (`heldBodyMaxMB`). Over the cap, the request gets 403 "body too large to hold". The file is deleted when the ask ends (docs/archive/agent-sandbox-prd.md:497-497).
- Known gaps: gzip bodies are not checked, and API keys inside a body still show in the ask file's preview (docs/archive/agent-sandbox-prd.md:501-502).

### Queue

Only requests that need the human's answer enter an agent's line. Per agent: 1 held and up to 16 waiting unread in the kernel socket buffer. The next gets 429 at once. A deadline counts from arrival. On timeout the request is denied with 403 "timed out", and a late answer is ignored. barebox never retries (docs/archive/agent-sandbox-prd.md:476-476).

### Audit

`gate.jsonl` is the one audit file, in bareguard's shape. Response status goes through `gate.record`. barebox's own facts go through `gate.annotate({ surface:false, ... })` (docs/archive/agent-sandbox-prd.md:486-486, 511-511).

A request with a body gets one `body` line with `bodyBytes` and `bodySha256`, joined to its gate line by `rid`. The audit file stores no body and no preview. The masked 4 KB preview lives only in the ask file (user decision, Oct 30) (docs/archive/agent-sandbox-prd.md:500-500).

### Other M3 decisions

- Correction found in B2a (Oct 30): bareguard's default content word patterns scanned URLs before the mode letters and made PUT, PATCH and DELETE ask even in `trust`. `gateFor` now passes `content: { askPatterns: [], denyPatterns: [] }`, so the modes table is the whole policy (docs/archive/agent-sandbox-prd.md:508-508).
- The `sbx` proxy runs with `--max-semi-space-size=1`, set on the CLI's first line. It caps the V8 young generation at 1 MB. Latency with and without it is the same at p50 (about 0.8 to 1.0 ms), with p95 and p99 up to about 0.5 ms slower in 2 of 3 runs (docs/archive/agent-sandbox-prd.md:474-474).
- The gate option: none means a preset. Otherwise a passed bareguard `Gate`, or any object with the same `check(action)` contract, is matched by shape (docs/archive/agent-sandbox-prd.md:519-519).
- barebox's own `denyReasonForIp` stays. It covers mapped, compat, uncompressed, NAT64 and 6to4 forms. bareguard's redaction replaces barebox's `SENSITIVE_HEADERS` scrub (docs/archive/agent-sandbox-prd.md:522-523).
- New dependency `rwxmap` 0.8.0, pinned exactly (docs/archive/agent-sandbox-prd.md:509-509).

### Config file

One file, `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`, read by the CLI only. Keys: `mode`, `holdTimeoutSec`, `heldBodyMaxMB`, `localLlm`, `labels`, `tenants`, `env` and `secrets`. A flag beats the file, and the file beats the default. An unknown key, bad value or bad JSON makes `sbx run` exit 2, naming the file and key. The file is hidden inside the sandbox, including under a custom `XDG_CONFIG_HOME` below `$HOME` (docs/archive/agent-sandbox-prd.md:518-518).

### Memory result

The proxy is capped at 40 agents, enforced by `addAgent`. The bench `npm run bench:agents` measured 99.5 / 114.4 / 124.3 / 143.6 MB at 10 / 20 / 30 / 40 agents on plain HTTP in the full worst case, about 1.4 MB per agent, with walls at most 8.0 MB (docs/archive/agent-sandbox-prd.md:499-499, 510-510). The bench found two causes of 318 MB at 20 agents: bareguard re-reading the audit file per ask (fixed upstream in 0.30.0) and held bodies kept in memory (fixed) (docs/archive/agent-sandbox-prd.md:510-510). The earlier 80 MB budget and the 150 MB budget were replaced; the final budget is in M6 (docs/archive/agent-sandbox-prd.md:452-452).

## M4. Undo layer

Every file write is reviewable and reversible (docs/archive/agent-sandbox-prd.md:548-548).

- It uses a bwrap overlay (`--overlay-src` and `--overlay`), which needs bubblewrap 0.11.0 or newer. An older bwrap is refused with a clear message, and runs without the overlay still work (docs/archive/agent-sandbox-prd.md:549-549).
- An overlay upper layer exists per run, with `sbx diff`, `sbx commit` and `sbx rollback`. Deletions are handled through overlay whiteouts. A file the user changed meanwhile is flagged, not overwritten (docs/archive/agent-sandbox-prd.md:550-552).
- The riskiest assumption was that commit applies the upper layer to the real folder correctly, including deletions and files changed meanwhile (docs/archive/agent-sandbox-prd.md:551-551).

## M5. Keys the agent never holds

The agent works with a placeholder. The real key never enters the sandbox (docs/archive/agent-sandbox-prd.md:559-559). It was built Nov 1 and released as 0.6.0 (docs/archive/agent-sandbox-prd.md:602-602).

### Scope and decisions (user, Oct 31)

- Scope: API keys sent in a request header to a service. The agent's own sign-in in `~/.claude` is out. `~/.claude` stays readable and is a known gap (docs/archive/agent-sandbox-prd.md:567-567).
- Before M5, all 115 host variables reached the sandbox (measured Oct 31). The host environment is now cleared (docs/archive/agent-sandbox-prd.md:568-568).
- Keys live in config `secrets`. Each entry names a host variable (`fromEnv`) or holds the value inline, with `hosts` it is bound to. No OS keyring (docs/archive/agent-sandbox-prd.md:569-569, 587-587).
- The real value goes in only on a request the gate allows, and only to bound hosts (docs/archive/agent-sandbox-prd.md:570-570).
- The placeholder is random, fresh per run, one per secret, under the secret's usual variable name. Seen headed anywhere else, it is a tripwire (docs/archive/agent-sandbox-prd.md:574-574).
- One shared `secrets` set serves every agent on the proxy. Per-agent keys can come later without changing the design (docs/archive/agent-sandbox-prd.md:575-575).
- `env.pass` refuses names matching `*KEY*`, `*TOKEN*`, `*SECRET*` or `*PASSWORD*` (case-insensitive) with "use `secrets` for this". There is no override; `env.set` covers a harmless match (docs/archive/agent-sandbox-prd.md:578-578).

### Environment inside

The inside gets barebox's own variables (`HOME`, `PATH`, proxy and CA variables), a short default pass list (`TERM`, `COLORTERM`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `USER`, `LOGNAME`, `SHELL`, `EDITOR`, `PAGER`), `env.pass` names, `env.set` values, and one placeholder per secret. Nothing else (docs/archive/agent-sandbox-prd.md:568-568, 588-588).

The launcher spawns bwrap with a clean environment (`PATH=/usr/bin:/bin`) and sets everything with `--setenv`. `--clearenv` was proven redundant, and the clean spawn fixes bwrap's own `/proc/1/environ` (docs/archive/agent-sandbox-prd.md:598-598). `NODE_USE_ENV_PROXY=1` is set inside, because Node's built-in `fetch` ignores the proxy variables without it. Node added the variable in v22.21.0 (docs/archive/agent-sandbox-prd.md:602-602).

### The swap

- Every request header value is searched for each placeholder (substring, so `Bearer <ph>` works). `Authorization: Basic <base64>` is decoded, swapped and re-encoded (docs/archive/agent-sandbox-prd.md:589-589, 597-597).
- If the gate allows, the host is bound and the upstream hop is https, the real value replaces the placeholder (docs/archive/agent-sandbox-prd.md:589-589).
- A denied request never goes upstream. An unbound host gets `403 secret.host`. A bound host over plain http gets `403 secret.scheme` (docs/archive/agent-sandbox-prd.md:589-589).
- A placeholder in a URL path or query is refused `403 denied: secret.url` in every mode (docs/archive/agent-sandbox-prd.md:604-604).
- Detection runs before the gate, and the swap applies only after `allow`. The real value is never in a held request's headers (docs/archive/agent-sandbox-prd.md:602-602).
- The value never appears in the audit, the ask file or an error body. Swap facts are `annotate` lines in `gate.jsonl` with `verdict: "secret"` and `meta: { agent, rid, name, host, swapped }` (docs/archive/agent-sandbox-prd.md:576-576, 589-590).
- `run()` and `createProxy()` take `secrets` directly. The CLI reads them from the config and passes them in (docs/archive/agent-sandbox-prd.md:596-596).

POC result (Oct 31): go. The real value appears 0 times inside the sandbox, each check shown red by a mutation (docs/archive/agent-sandbox-prd.md:586-586, 594-594). The suite was 491 of 491 with 0 fail and 0 skip in a real shell at the branch review (docs/archive/agent-sandbox-prd.md:602-602).

Known gaps: `~/.claude` stays readable, and an upstream that echoes a request header hands the real value back to the agent (docs/archive/agent-sandbox-prd.md:602-602). Swaps in bodies, URLs, OAuth and refresh tokens are out of scope (docs/archive/agent-sandbox-prd.md:591-591).

### Changes after 0.6.0

- A CONNECT tunnel is sniffed. First byte `0x16` means TLS, which is decrypted. Anything else is plain HTTP, checked like any request. A certificate is minted only for a TLS tunnel (docs/archive/agent-sandbox-prd.md:604-604).
- The host's Node (`hostNode` in `src/runtime.js`) is bound read-only when it lives outside `/usr`, `$HOME` and the project, with its `bin` dir first on the inside `PATH`. It is never bound when its install dir is `/`, `$HOME` or above (docs/archive/agent-sandbox-prd.md:604-604).
- Locked drawers and `maskDirs` folders are masked under any bound root. The runtime tree is masked too. `launch()` throws when the runtime is `/etc`, `/usr` or the Node install dir (docs/archive/agent-sandbox-prd.md:604-604).

## M6. Scale

The goal was to check the memory targets at real scale (docs/archive/agent-sandbox-prd.md:610-610). The M3 bench sent plain HTTP only, while real traffic is mostly HTTPS, so the MITM path at scale needed measuring (docs/archive/agent-sandbox-prd.md:616-616).

### Decision and worst case

- Go/no-go (Nov 2): the proxy stays at or under 175 MB at 40 agents on HTTPS traffic (docs/archive/agent-sandbox-prd.md:620-620).
- Worst case: per agent 1 parked hold, 16 waiting and the working slot filled, with every request in its own live MITM TLS tunnel. That is about 18 TLS sessions per agent, 720 at 40 agents, over 10 shared hosts, with one secret swapped per request (docs/archive/agent-sandbox-prd.md:621-621).
- Method: the M3 round 2 bench. The proxy runs in its own process, GC is forced before each reading, and the real gate and matcher are loaded (docs/archive/agent-sandbox-prd.md:613-613).

### What the POC found

The first HTTPS POC failed the 175 MB target (docs/archive/agent-sandbox-prd.md:628-628).

- About 40 MB was test setup: `upstreamCa` builds a context from about 145 roots plus the test CA for each new upstream connection. Production passes none (docs/archive/agent-sandbox-prd.md:637-637).
- About 37 MB was a real per-tunnel cost: each MITM tunnel built its own context. The fix caches one `SecureContext` per host in `src/proxy.js` (docs/archive/agent-sandbox-prd.md:638-641).
- The rest is about 50 KB of OpenSSL state per live TLS session. No cache removes it (docs/archive/agent-sandbox-prd.md:639-639).

### Final budget (user, Nov 2)

The proxy budget is about 205-245 MB in the full HTTPS worst case at 40 agents, quiet to busy machine. The bench fails above 245 MB. This replaced two earlier ranges. The 40-agent cap stays (docs/archive/agent-sandbox-prd.md:641-641, 663-663).

Measured with `npm run bench:agents` on the HTTPS worst case, production trust path, every allow's secret swapped:

| Agents | Quiet (load 5.5) | Busy (load 12-17) | Live TLS at worst |
|---|---|---|---|
| 10 | 117.3 MB | 117.9 MB | 280 |
| 20 | 133.5 MB | 151.3 MB | 560 |
| 30 | 176.9 MB | 206.8 MB | 840 |
| 40 | 206.6 MB | 241.0 MB | 1120 |

(docs/archive/agent-sandbox-prd.md:643-650)

- Walls are 7.8 to 8.1 MB. The quiet and busy gap is machine load, since native TLS memory is released later on a busy box (docs/archive/agent-sandbox-prd.md:652-652).
- 2 GB check: the whole bench ran inside a 2 GB cgroup with swap off. Exit 0, proxy 116.4 / 141.0 / 179.9 / 207.2 MB, `oom_kill 0` (docs/archive/agent-sandbox-prd.md:654-654).
- Real agent: Claude Code 2.1.316 peaked at 249 MB bare and 248 MB inside barebox. The `sbx` process with its in-process proxy peaked at 83 MB, and walls about 8 MB. So barebox adds about 91 MB to one real agent and does not change the agent's own memory. Each further agent adds about 8 MB of walls plus about 3 MB at the proxy (docs/archive/agent-sandbox-prd.md:656-656).

### Fixes from the real-agent run

- `claude` was not on the inside `PATH`. `~/.local/bin` is now appended to the inside `PATH` when it exists (user decision, Nov 2) (docs/archive/agent-sandbox-prd.md:659-660).
- `/bin`, `/sbin` and `/lib` did not exist inside on merged-`/usr` hosts, so `#!/bin/sh` scripts failed. Fixed by mirroring the host's top-level links (user decision, Nov 2) (docs/archive/agent-sandbox-prd.md:660-660).
- A `time -v` report that stops early inside barebox was not reproduced as a barebox bug (docs/archive/agent-sandbox-prd.md:661-661).

## M7. Demos, numbers, README

### Terminal prompts and naming (user, Nov 2)

- `sbx run` asks in its own terminal, in plain words (`<name> wants to SEND data to <host>`, why, URL, masked data, `Allow? [y/N]`), when stdin and stderr are terminals and `--json` is off. A key typed before a question opens never answers it. A second terminal (`sbx approve` or `sbx deny`) still works, and the first answer wins (docs/archive/agent-sandbox-prd.md:675-675).
- `sbx run --name <n>` sets the agent name and a fixed runtime dir (`$XDG_RUNTIME_DIR/barebox/<n>`, else `<tmpdir>/sbx-<uid>/<n>`). Other commands take `--name` instead of `SBX_RUNTIME` (docs/archive/agent-sandbox-prd.md:676-676).
- Colors (user, Nov 3): basic ANSI colors when stderr is a TTY and `NO_COLOR` is unset. `--json` and piped output stay plain (docs/archive/agent-sandbox-prd.md:684-684).
- Hold wait (user, Nov 3): the default is now to wait until answered (`holdTimeoutSec` default `"never"`). `sbx run --hold <seconds|never>` overrides it per run. The backlog stays bounded at 1 held, 16 waiting, and the 17th gets 429. The library's default stays 120 s (docs/archive/agent-sandbox-prd.md:685-685).

### Demo B

A prompt-injected agent tries to read `~/.ssh` and push it out. It is blocked. Good work is committed and bad edits are rolled back (docs/archive/agent-sandbox-prd.md:670-670).

`examples/demo-b/run.sh` runs one 10-step workflow under ask, auto and trust, asserting every cell, plus two agents at once for commit and rollback. The scripted driver is the proof. The `claude -p` driver is best effort, because the API's own safeguards refuse the injection text (docs/archive/agent-sandbox-prd.md:677-677).

### Demo A (user, Nov 2 and Nov 3)

- A flight booking: search runs free, payment stops for approval, and the key is never in the agent. httpbin stands in for Stripe, so no account is needed and results are deterministic. The key swap shows in httpbin's echo (docs/archive/agent-sandbox-prd.md:669-669).
- `examples/demo-a/run.sh` is run by hand, not in `npm test` or the tarball. The scripted driver asserts every step. `--driver claude` is best effort, and `--live` lets the user answer (docs/archive/agent-sandbox-prd.md:680-680).
- Steps: search (`GET /anything/search`, free), pay (`POST /anything/v1/payment_intents`, held by the floor because the path holds `/payment`), and an itinerary email (a second hold) (docs/archive/agent-sandbox-prd.md:681-681).
- Modes: search is free in every mode. Payment is held in every mode. The email is held in ask and auto, and free in trust (docs/archive/agent-sandbox-prd.md:682-682).
- The recorded demo is a live run with `--driver muse --live`. Meta's muse model books the flight inside barebox and the user answers each question. Model calls are labelled `r` with an rwxmap label. The model key is a barebox secret, so the agent holds a placeholder (docs/archive/agent-sandbox-prd.md:686-686).
- Known gap: a model endpoint labelled `r` is an open channel. A fix idea is to allow a model call freely only when it carries the run's secret placeholder (docs/archive/agent-sandbox-prd.md:686-686).

### Numbers (measured Nov 3)

- Start time: `sbx run -- true` has a median of 0.70 s (range 0.56 to 0.80), from proxy start to teardown, over 11 runs at load about 2. With `--overlay` it is 0.80 s. Bare bwrap is 6 ms and `node -e 0` is 0.16 s, so most of the time is Node starting the proxy and the CLI (docs/archive/agent-sandbox-prd.md:687-687).
- The recorded Demo A take had 31 requests, 23 free and 8 asked. Demo B blocked 3 of 3 exfiltration attempts in every mode (docs/archive/agent-sandbox-prd.md:687-687).
- A prompts-per-task comparison against a stock agent setup stays open (docs/archive/agent-sandbox-prd.md:687-687).
