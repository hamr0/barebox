# M5 build brief: keys the agent never holds (2026-10-31)

Spec and decisions: `docs/product/agent-sandbox-prd.md`, M5 (interview rounds 1-3, "M5 spec", "M5 POC result"). POC evidence: `docs/logs/findings.md`, "M5 — POC"; code in `poc/m5/` (reference only, never copied in as-is). Branch `m5`, after the `ledger-060-brief.md` commits. Workers write all code and tests; every required test is shown red on the code before the change, then green.

## 1. Config (`src/config.js`)

Add two keys to `KEYS` (line 26), validated like the others (unknown key or bad value: exit 2 with the file and key named):

- `env`: `{ pass?: string[], set?: Record<string, string> }`. Names must match `^[A-Za-z_][A-Za-z0-9_]*$`. A `pass` name matching `/KEY|TOKEN|SECRET|PASSWORD/i` is refused: `env.pass: "<name>" looks like a secret; use "secrets" for it`.
- `secrets`: `Record<NAME, { fromEnv?: string, value?: string, hosts: string[] }>`. Exactly one of `fromEnv` / `value`; `hosts` non-empty hostnames (no scheme, no port). A `fromEnv` variable missing from the host environment fails at startup naming the secret, never the value.

## 2. Secrets (`src/secrets.js`, new)

Port `poc/m5/swap.mjs`, two functions:

- `loadSecrets(config, env)`: one entry per secret `{ name, value, hosts, placeholder }`, `placeholder = sbx-ph-<16 hex>` from `crypto.randomBytes`, fresh per call (per run).
- `findPlaceholders(headers, host, secrets)` → `[{ name, header, bound }]`, and `applySecrets(headers, host, secrets)` → a new headers object with every bound placeholder replaced. Both search each header value as a substring, also inside a decoded `Basic <base64>` value (re-encoded on apply), and handle array values. Hosts compare by hostname without port.

Split detect from apply (the POC did both at once): the real value must not sit in the request's headers while it waits for a decision. Detect before the gate; apply only after `allow`.

## 3. Launcher (`src/launcher.js`)

- Spawn bwrap (line 276) with `env: { PATH: '/usr/bin:/bin' }`, always. This is what clears `/proc/1/environ` inside. No `--clearenv` (decided: redundant).
- After the CA variables (line 268-269), `--setenv` in this order: the default pass list `^(TERM|COLORTERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|USER|LOGNAME|SHELL|EDITOR|PAGER)$` read from the parent's `process.env`, then `env.pass` names present in the parent, then `env.set`, then one placeholder per secret under its own name, then `extraEnv` (line 270, unchanged, last wins).
- New `launch()` option `env: { pass, set, placeholders }`; JSDoc on the option.
- This changes behaviour for every caller: everything not listed no longer reaches the inside. Check every existing test that relies on an inherited variable (`git grep -n "process.env" test/`), and the e2e/cli fixtures.

## 4. Proxy (`src/proxy.js`)

- `createProxy` option `secrets` (the `loadSecrets` result), line 124.
- In `handleRequest` (line 639), right after `checkUpstream` passes (line 656), before the gate and before the `!gateFor` branch (line 682): `findPlaceholders`. Any `bound: false` hit: one audit line per hit (`ev: 'secret'`, `meta: { agent, rid, name, host, swapped: false }`), resume and drop the body, answer `403 denied: secret.host`. Every mode. Use the request's own `rid`; do not allocate an extra one (the POC did).
- On `d.outcome === 'allow'` (line 715), and on the `!gateFor` path: `applySecrets` into the forwarded headers, one audit line per swap (`swapped: true`). A held request that is later approved goes through the same `common` path; check it.
- The value must never reach the audit, the ask file, the 403 body or any error text. Grep the diff for every place headers are logged or echoed.
- Requests that arrive through CONNECT (decrypted) and the TCP door must take the same path; test both.

## 5. `run()` and the CLI

- `run()` takes `secrets` (the config shape) and `env`; it calls `loadSecrets` once, passes the result to `createProxy` and `{ pass, set, placeholders }` to `launch`.
- `src/cli.js` (line 170, 215): pass `cfg.secrets` and `cfg.env` through.
- `~/.claude` stays readable (out of scope); say so in the docs' known gaps.

## Required tests (each red before, green after)

- `test/config.test.mjs`: `env.pass: ["GITHUB_TOKEN"]` refused; a secret with both `fromEnv` and `value`, or no `hosts`, refused; a `fromEnv` that is unset fails naming the secret.
- `test/launcher.test.mjs`, fixture `$HOME`, needles fed on stdin and searched from inside: a host variable `BB_HOST_ONLY=<random>` is absent from every `/proc/*/environ` inside (red today: it is present, including in `/proc/1/environ`); the placeholder is present under its name; `TERM` passes; an `env.pass` name passes; the real value is in no file under the fixture `$HOME` or `/tmp` inside.
- `test/secrets.test.mjs` (new, no sandbox): `Bearer <ph>`, `x-api-key: <ph>`, `Basic base64(<ph>:)`, array values, an unbound host, two secrets in one header.
- `test/proxy.test.mjs` or a new `test/m5.test.mjs`, real proxy, two loopback upstreams (`127.0.0.1` bound, `127.0.0.2` unbound, `unsafeTestOnly.allowLoopback`): allowed request to the bound host arrives with the real value (red with apply removed); unbound host gets `403 denied: secret.host` and the upstream sees 0 requests (red with the host check removed); a denied request (`rwx.unlisted`) and an ask answered deny send 0 requests upstream and write no `swapped: true` line (red with apply moved before the gate); a held-then-approved request arrives with the real value; the real value appears 0 times in `gate.jsonl`, `asks/`, `answers/` and every response body; the same over CONNECT (self-signed upstream via `upstreamCa`) and through the TCP door.
- `test/run.test.mjs` or `test/cli.test.mjs`: `sbx run` with a config `secrets` entry (`XDG_CONFIG_HOME` set explicitly) and `curl -H "Authorization: Bearer $NAME"` inside reaches the bound upstream with the real value.

All sandbox and socket tests run in a real shell.

## Docs

- `barebox.context.md`: the environment the inside gets, `env` and `secrets` config, the swap rule, the `secret` audit line, the `403 secret.host` denial, `loadSecrets`-free usage of `run({ secrets })`.
- `README.md`: one short section, "Keys the agent never holds", with the config example.
- `CHANGELOG.md` `[Unreleased]`: Added (`secrets`, `env`), Security (the host environment no longer reaches the sandbox), Changed (callers relying on an inherited variable must list it in `env.pass`).
- PRD M5: mark built, with test counts.

## Verification (orchestrator, real shell)

- Every required test red on the pre-change code, then green.
- Full `npm test` three times, 0 fail 0 skip, once with `XDG_CONFIG_HOME=$HOME/.config`.
- `npm run typecheck`, `npm run check:primitives`.
- `poc/m5/checks.mjs` re-pointed at the built `src/` (a scratch copy), A-G pass, including the 7-minute C.
- `npm run bench:agents` once on a quiet machine: within the 145-175 MB range at 40 agents.
- A real `sbx run` smoke: `curl -u $STRIPE_API_KEY: https://api.stripe.com/v1/balance` with a Stripe test key gets 200; the same placeholder sent to `https://httpbin.org/anything` gets `403 secret.host`.
