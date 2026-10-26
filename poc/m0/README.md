# M0 POC: walls + front door (+ red-team)

Throwaway spike, not shipped. Proves the go/no-go for M0: per-agent overhead
≤ 10 MB with 20 concurrent sandboxes, and bypass attempts fail closed.
Full results: [agent-sandbox-prd.md](../../docs/product/agent-sandbox-prd.md).

- `proxy.js` — dumb forward + CONNECT proxy on per-agent unix sockets (allow-all)
- `launch.sh` — bwrap launcher: ro binds, tmpfs locked paths, net/pid/uts/ipc
  namespaces, socat bridge to `127.0.0.1:3128`. `SBX_BREAK=nonet|nolock|rw`
  are red-team-only hooks
- `measure.js` — exact RSS per sandbox process tree from `/proc`
- `run-m0.sh` — main harness, 14 checks, exits nonzero on failure
- `redteam.sh` — breaks each wall on purpose; passes iff every break is detected
- `measure.txt`, `proxy.log`, `func-*.txt`, `red-*.txt` — evidence from the passing runs

Run: `npm run poc:m0`, `npm run redteam:m0`. Both need an unsandboxed shell
(listening sockets, namespaces) and print PASS/FAIL with evidence.

Runtime dir stays `/tmp/sbx-m0` by design: unix socket paths cap at ~108 chars.
Only code, docs, and evidence live here.
