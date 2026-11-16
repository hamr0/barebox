# Brief: demo GIF module 1 — the recorder (2026-11-16)

Worker: code-developer (Sonnet). Spec: `docs/logs/demo-gif-prd.md` (read all of it, including
"Module 0 result"). Branch `demo-gif` (exists, checked out). Do **not** commit, do not spawn agents.
Rules: `.claude/remember/AGENT_RULES.md`. Module 1 works on its own: it makes a real take and
proves it; module 2 (renderer) comes later and is not yours.

## Build: `examples/demo-gif/`
Model on `examples/demo-a/run.sh` (read it: temp XDG config, short /tmp root because sockets cap
at 107 bytes, `--name`, secrets config, cleanup trap). Reuse its patterns; it is not sourced (it
runs on load), so copying a small helper is fine — name what you copied in the report.

1. `agent.sh` — the scripted agent, run inside `sbx run` as `bash -c "$(cat agent.sh)"` (inline,
   like demo-a). Five requests, all to `https://httpbin.org/anything/...`, each tagged `?step=N`:
   1. `GET  .../search?from=LHR&to=BCN&step=1` (flight search)
   2. `POST .../v1/payment_intents?step=2` with `Authorization: Bearer $STRIPE_API_KEY`, JSON body
   3. `POST .../send-email?step=3`, JSON itinerary
   4. `POST .../v1/payment_intents?step=4` (a second, unexpected payment), same auth header
   5. `POST .../upload?step=5`, JSON notes (an upload nobody approves)
   curl with **`-m 120`** (not 20: a person pauses; see the ledger item on demo-a's `-m 20`).
   Output: **every line ≤ 80 columns**, plain text, one line before and one after each request,
   e.g. `agent: search flights LHR-BCN` / `  → 200`. For steps 2 and 4 also print what httpbin
   echoed as the Authorization header (`  httpbin got: Bearer sk_test_…` or
   `  httpbin got: nothing (the request never left)`), like demo-a's `server received:`.
2. `record.sh [outdir]` — one take:
   - Temp root + XDG config: `{"mode":"auto","secrets":{"STRIPE_API_KEY":{"value":"<fresh random sk_test_…>","hosts":["httpbin.org"]}}}`.
   - Runs inside `script -q -T <outdir>/take.timing -O <outdir>/take.log -c "<inner>"` where
     `<inner>` first does `stty cols 80 rows 30`, prints the exact command as a shell-prompt line
     (`$ sbx run --mode auto --hold 8 -- bash book-trip.sh`), runs the real
     `node src/cli.js run --name gif --mode auto --hold 8 -- bash -c "$(cat agent.sh)"`, then prints
     the summary (below). The terminal prompt must be on (stdin and stderr are the pty).
   - Answers by typing into the pty, like a person: a feeder writes to `script`'s stdin, watching
     `take.log` for each new `Allow? [y/N]`; waits ~2.5 s, types `y`+CR for holds 1 and 2, `n`+CR
     for hold 3, and **nothing** for hold 4 (it must time out at 8 s). Feeder pattern you may
     copy: `scratchpad/live-drive.sh` (path below).
   - Summary, printed inside the recorded session after sbx exits, read from the sandbox's own
     `gate.jsonl` (find how a timeout deny is recorded there — check, do not assume), ≤ 80 cols,
     a header line then one line per step: name, free / allowed / denied / timed out, and the
     reason in plain words (payment rule, a change barebox can't undo). Colour like demo-a's
     `live_summary` (green allowed/free, red denied/timed out, dim reasons).
   - **Self-check, exit 1 on any miss** (must be able to fail): from `gate.jsonl`, step 1 free
     allow; 2 held→allow; 3 held→allow; 4 held→deny; 5 held→deny by hold timeout; and the real key
     appears in `take.log` exactly once (the step-2 echo) and in no file under the sandbox runtime
     or project except gate.jsonl/audit if barebox puts it there (check whether it does — if the
     real value is in gate.jsonl, report that as a finding, do not hide it). Also: no line in
     `take.log` wider than 80 columns after stripping SGR.
   - Writes `take.log`, `take.timing`, and a copy of `gate.jsonl` to outdir (default
     `examples/demo-gif/take/`, gitignored? check .gitignore and say; do not commit the take).
3. `.gitignore` entry for the default take dir if needed.

Feeder pattern: `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/5c5f0d3d-f125-4ca7-aef2-a9a8f8929e98/scratchpad/live-drive.sh`.
Use `#!/usr/bin/env bash` scripts (zsh does not word-split; write bash). Network: httpbin.org.

## Prove (paste real output)
- Two takes in a row, both `record.sh` exit 0, with the self-check lines.
- The self-check going **red**: e.g. make the feeder answer hold 4 (`y`) in a scratch copy → exit 1
  naming step 5; and one other mutation of your choice. Never mutate in the repo tree.
- `take.log` stripped of SGR (`sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r'`), pasted whole, so the
  orchestrator sees the exact screen text. Max line width.
- Elapsed real time of a take, and the timestamps of each Allow and each outcome line.
- `git status --porcelain` at the end: only `examples/demo-gif/*` (and `.gitignore` if touched).

Stop and report if: the prompt is not shown (stdin/stderr not a TTY in `script`), the timeout
deny does not appear as `✗ timed out (denied)`, or anything in this brief is wrong.
