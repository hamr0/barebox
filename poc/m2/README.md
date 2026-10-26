# M2 POC: hold one x-request, ask the human, keep everything else running

Throwaway harness (not shipped). Proves PRD go/no-go (b) with a placeholder
hold trigger (path substring); M3 replaces the trigger with the classifier.
No bareguard/rwxmap imports here — sequencing.

## Layout

- Proxy hold mode lives in `poc/m1/mitm.cjs` (`HOLD_MATCH`, `HOLD_TIMEOUT_MS`
  ms or `never`, `HOLD_MAX_BODY`, control socket argv).
- `poc/m1/sbx.mjs` — second-terminal CLI: `pending | approve | deny`.
- `hold.sh` — scenarios: approve, two (depth 2), cap, timeout, never, long.
- `run-m2.sh` — full run, local only.

## Run

```bash
bash poc/m2/run-m2.sh
```

## Done when

Held POST waits; meanwhile GET completes; approve forwards with echo intact;
deny/timeout return reasoned 403s; 2 concurrent holds; 1 MB cap denied loud
at the door, never queued; 120 s default, `never` supported; 30 s hold
survives. Timeout-deny itself is proven on a 5 s override.
