# M7 brief: Demo A (flight booking, httpbin standing in for Stripe)

Branch `m7`. Decisions: PRD `docs/product/agent-sandbox-prd.md`, M7, "Decisions (user, Nov 3)". Read them first; stop and report if this brief contradicts them.

## Build
`examples/demo-a/` modelled on `examples/demo-b/` (read `run.sh`, `agent.sh`, `prompt.md` there and **reuse its skeleton**: arg parsing, `ROOT` under a short `/tmp` path, `XDG_CONFIG_HOME`/`TMPDIR` isolation, `unset SBX_RUNTIME XDG_RUNTIME_DIR`, `--name`, cleanup trap, expect/actual matrix, PASS/FAIL table, exit 1 on any FAIL).

- `./run.sh [--driver scripted|claude] [--mode ask|auto|trust|all] [--live]`. Defaults as Demo B (scripted → all, claude → auto).
- Config written into `$XDG_CONFIG_HOME/barebox/config.json`: `mode`, and `secrets: { STRIPE_API_KEY: { value: "sk_test_demoA_<random per run>", hosts: ["httpbin.org"] } }`. Requests go to `https://httpbin.org` (the swap needs TLS: README line 91).
- Steps (scripted driver, `agent.sh` inside the sandbox, using `curl` with the placeholder `$STRIPE_API_KEY`):
  1. **search**: `GET https://httpbin.org/anything/search?from=LHR&to=BCN&max=450`, expect free 200 in every mode.
  2. **pay**: `POST https://httpbin.org/anything/v1/payment_intents` with `Authorization: Bearer $STRIPE_API_KEY` and a small JSON body (no card number). Expect held in **every** mode (`flags.paymentPath`, src/policy.js:113), approved → 200, and httpbin's echoed `Authorization` header equals the **real** value.
  3. **email**: `POST https://httpbin.org/anything/send-email` with the itinerary. Expect held → approved → 200 in ask and auto; free 200 in trust.
  4. **pay denied**: the same payment, denied → 403. Assert from `gate.jsonl` / the response that it never left.
- Key assertions, each its own cell:
  - The agent's `$STRIPE_API_KEY` (printed by the agent) is not the real value.
  - The real value appears in the step 2 echo only.
  - The real value is in no file the agent can read (grep the overlay/upper dir and the agent's output).
- Answering: the scripted driver approves or denies with `sbx approve|deny --name <n>`, exactly as Demo B does. `--live` leaves the prompt to the user, as in Demo B.
- `--driver claude`: a short `prompt.md` ("find a flight LHR→BCN under £450 with the search API at …, pay with the Stripe-style API at …, email the itinerary to …"). Best effort, like Demo B.
- Not in `npm test` or the tarball. Check that `package.json` `files` already excludes `examples/`.

## Done when
- `bash examples/demo-a/run.sh` exits 0 with every cell PASS in all three modes. Paste the table into your report.
- **Red check:** set the secret's `hosts` to `["example.com"]` in a scratch copy. The demo must FAIL the echo cell (403 `secret.host`). Paste that output, then revert.
- `--mode trust` alone passes, and the payment is still held.
- `bash -n` is clean and `shellcheck` is clean if it's installed.
- Don't touch `src/`. If a step can't pass without a src change, stop and report with a repro command.
- The sandbox you run in may lack bwrap or real network. If so, say exactly which cells you couldn't run; the orchestrator runs them in a real shell. A skip is not a pass.
