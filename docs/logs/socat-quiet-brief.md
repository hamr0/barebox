# Brief: the sandbox bridge stops printing socat errors

Branch `m6`. User decision (Nov 2): make them quiet. The live Demo B prints lines like
`2026/11/02 16:22:41 socat[16] E write(5, …): Broken pipe` and `E read(6, …): Connection
reset by peer` whenever a connection closes early (a denied hold, a refused host). They are
harmless and look like failures on camera.

## Facts (checked by the orchestrator)

- The bridge: `src/launcher.js:325`
  `socat TCP-LISTEN:${door},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/sbx/agent.sock &`.
- socat 1.8.1.3: `-d0` is "errors only" (already the default), so `-d` cannot hide `E` lines;
  `-lf <file>` sends all socat logging to a file.
- Start-up failure is already caught without socat's log: the loop after it probes the door
  50 times and `exit 99` when it never opens (`src/launcher.js:326-327`).

## Build

1. Add `-lf /dev/null` to that socat call. Nothing else in the bridge changes.
2. Tests (red on HEAD, then green), in the launcher/CLI test file that already runs a real
   sandbox: a request that the proxy refuses/denies mid-connection (or the client closes
   early) leaves the agent's stderr free of `socat[`. Prove the red with HEAD's line. If you
   can't make socat print an `E` line on HEAD in a test, stop and report how you tried.
3. Keep the existing missing-socat / no-door behaviour: show an existing test still covers
   exit 99 (or add one if none), green after the change.
4. CHANGELOG [Unreleased] one line under Fixed/Changed (the bridge no longer prints socat
   connection errors). Comment beside the line saying why `-lf /dev/null` is safe (the door probe).

## Rules

Only `src/launcher.js`, its test file, CHANGELOG. No full suite or bench (peer sessions); run the
touched test file. Don't commit. A fact above wrong → stop and report.

## Done when

- [ ] Red on HEAD, green after (outputs pasted); touched file 0 fail 0 skip.
- [ ] `npm run typecheck`, `npm run check:primitives` exit 0.
- [ ] Report: diff, test outputs, differences from this brief.
