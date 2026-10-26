# M1 POC: proxy sees inside HTTPS

Throwaway harness (not shipped). Proves PRD go/no-go (a) part 2 + (c):
the proxy reads method, URL, headers and body of HTTPS, and RSS with TLS
stays within 80 MB.

## Layout

- `mkcerts.sh` — local CA + per-host certs via `openssl` (decided Oct 26).
- `mitm.cjs` — CONNECT/HTTP MITM proxy. Parses for logging, forwards raw.
- `client.mjs` / `client.py` — node (undici) + python (requests) clients.
- `echo.py` — local TLS echo server, for the no-internet self-test.
- `matrix.sh` — curl + node + python (+ git) through the proxy, asserts log.
- `run-m1.sh` — full run: certs, proxy, matrix, RSS, verdict.

## Run

Dev box (no internet) — local self-test, git skipped:

```bash
bash poc/m1/run-m1.sh local
```

Netted box (real internet) — full matrix incl. git over https:

```bash
bash poc/m1/run-m1.sh real
```

## Done when

curl, node, python requests, git-over-https work through the proxy; the
proxy log shows method + URL + headers + body for each; proxy RSS ≤ 80 MB.
