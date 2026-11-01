# M5 POC brief: keys the agent never holds (2026-10-31)

Spec: `docs/product/agent-sandbox-prd.md`, M5 ("M5 spec (decided Oct 31)"). This POC targets the riskiest assumption only. It lives in `poc/m5/` and never ships: the build comes after, from its own brief.

## Riskiest assumption

With a secret configured, the real value is found **0 times inside the sandbox**, while an allowed request to the bound host reaches upstream **with** it.

## Facts checked before writing (real shell, Oct 31)

- `src/launcher.js:178` runs bwrap with `--unshare-pid`; inside, `ls /proc` shows 5 pids, and the proxy process is not among them.
- `src/launcher.js:276` spawns bwrap without `--clearenv`, so the host environment passes in: `PROBE_SECRET=zz-host-only-zz sbx run -- ...` found it in 8 `/proc/*/environ` files inside. Clearing the environment is part of this POC.
- `src/launcher.js:260-270` adds `--setenv` for `HOME`, `PATH`, the proxy variables, the CA variables and `extraEnv`.
- Every CONNECT is decrypted (a certificate is minted per host, `src/proxy.js`), so HTTPS headers are visible to the proxy.

## What the POC does

1. `poc/m5/launch-env.mjs`: a copy of the launch path with `--clearenv`, then `--setenv` for barebox's variables, the default pass list (`TERM COLORTERM LANG LANGUAGE LC_* TZ USER LOGNAME SHELL EDITOR PAGER`) and one placeholder `sbx-ph-<16 random hex>` per secret.
2. `poc/m5/swap.mjs`: a proxy-side function `swap(headers, host, secrets)`: for each header value containing a placeholder, replace it with the real value if `host` is in that secret's `hosts`, else report `secret.host`. Wired into a scratch copy of the proxy's forward path, not into `src/`.
3. A local upstream (127.0.0.1, `allowLoopback` for the test only) that records the headers it receives.

## Required checks (each must be shown able to fail)

| Check | Pass | Shown able to fail by |
|---|---|---|
| A. Environment of every process inside | real value 0 hits in `/proc/*/environ` | run without `--clearenv`: hits > 0 |
| B. Command lines inside | 0 hits in `/proc/*/cmdline` | pass the value as an argument: hits > 0 |
| C. Files inside | 0 hits for `grep -rIl <value> /` excluding `/proc` and `/sys` | write the value to a file under `$HOME` on the host: hits > 0 |
| D. Allowed request, bound host | upstream receives `Authorization: Bearer <real>` | disable the swap: upstream sees the placeholder |
| E. Request to an unbound host | blocked, `403 denied: secret.host`, upstream receives nothing | remove the host check: upstream receives the real value |
| F. Denied request | upstream receives nothing; the real value is in no audit or ask file | move the swap before the gate: it leaks |
| G. Real tools | `curl -H "Authorization: Bearer $STRIPE_API_KEY"` and a `node` `fetch` with the placeholder both get the real value upstream | (D's mutation) |

Search with the real value as a fixed string (`grep -F`), and also its base64, since tools may encode headers.

## Measure

- Proxy RSS with the swap on, 20 agents, against the M3 numbers: the swap must not move the worst case by more than 1 MB.
- Added latency per request with 1 and 10 secrets configured.

## Done when

Checks A to G pass, each mutation turns its check red, and the numbers are recorded in `docs/logs/findings.md`. Then the build brief follows (config keys, `env.pass` guard, the audit line, tests in `test/`), together with the `docs/logs/ledger-060-brief.md` items.

## How Claude verifies

Every check rerun in a real shell (not the agent sandbox, which skips bwrap and sockets), every mutation shown red, and the files in `poc/m5/` read before anything is claimed.
