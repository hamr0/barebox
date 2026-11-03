# M7 brief: "prompts per task", measured with a real agent (Demo A, muse driver)

Branch `m7`. User, Nov 3: measure prompts per task with a real agent. Paid runs use the Baseten key in the user's password store (`pass amr/baseten_api`), with the "muse" models (`meta-models/muse-spark-open-1026`, `meta-models/muse-spark-open`), as many runs as needed. **Never print, log or commit the key.** Pass it only as `BASETEN_API_KEY="$(pass amr/baseten_api)"` in the environment of the command that needs it.

## What the number means
- **Stock setup:** an agent that asks before every shell command (Claude Code's default for Bash). Its prompts = the number of shell commands the agent ran.
- **barebox:** the holds it asked, read from `gate.jsonl` (`askHuman`) for the run.
- Same run, two counts. Report each mode's range over several runs.

## Build (examples/demo-a/ only; no src/ change, no test/ change)
1. **`muse-agent.mjs`:** a minimal agent loop in plain Node (no deps), run **inside** the sandbox.
   - It calls `https://inference.baseten.co/v1/chat/completions` (OpenAI-compatible) with `Authorization: Api-Key $BASETEN_API_KEY`. Inside the sandbox this is the barebox placeholder; the proxy swaps the real key after the gate.
   - Model: `$MUSE_MODEL`, default `meta-models/muse-spark-open-1026`.
   - One tool, `bash(command)`, run with `child_process.spawnSync('bash', ['-c', command])`. Return stdout and stderr, truncated to 4 KB.
   - Print `TOOL <n> <command, first line, 120 chars>` before each call.
   - Stop at the model's final answer or 25 turns. Print `FINAL <one line>`.
   - **First check** that the swap works with the `Api-Key <placeholder>` header form (README line 91 shows Bearer and basic). If the swap doesn't happen for that form, stop and report with the repro; don't work around it.
2. **Label:** Baseten's chat endpoint must be a model call, free in every mode. Use barebox's own labels feature, not a src change:
   - Write `examples/demo-a/baseten-openapi.json`, a minimal OpenAPI 3 spec with `POST /v1/chat/completions` and server `https://inference.baseten.co`.
   - Run `npx rwxmap examples/demo-a/baseten-openapi.json --vendor baseten -o examples/demo-a/labels/baseten`.
   - If rwxmap grades it `x`, set it to `r` in the gate file (`baseten.rwxmap.json`); the gate file is the user's review. Record that edit in a comment line in run.sh.
   - Check with node_modules/rwxmap/README.md and src/labels.js that the files load: config `labels: [<abs dir>]`, plus `tenants` only if needed.
3. **`run.sh --driver muse`:**
   - Needs `BASETEN_API_KEY` in the host env, and exits 2 with a clear message without it.
   - The config adds `secrets.BASETEN_API_KEY: { fromEnv: "BASETEN_API_KEY", hosts: ["inference.baseten.co"] }` beside the Stripe one, plus `labels`.
   - The prompt is `prompt.md`. Check that it gives the URLs and asks for search → pay → email the itinerary, and fix it if not.
   - The real agent's cells work like the claude driver's (model-dependent cells say NOT RUN or NOT CHECKED). The answer loop approves the first payment and the email, and denies a second payment if the agent makes one.
   - Add `--runs N` (default 1) for the muse driver. At the end print one line per run, `PROMPTS mode=<m> run=<i> stock=<shell commands> barebox=<holds> model_calls=<n>`, and a summary with min-max per mode.
   - **Hollow-green guard:** a run where the agent never made the payment request is reported as `INCOMPLETE`, not counted.

## Done when
- In a scratch copy, show the agent's model calls are not held. The muse run's `gate.jsonl` has the baseten POSTs as free (not `askHuman`). Show a red check: with the label folder removed from the config, they're held. Paste both.
- `--driver muse --runs 3 --mode all` completes. Paste the PROMPTS lines and the summary. If the model fails the task often, try `meta-models/muse-spark-open` and report both.
- `grep -r` for the key's value across the runtime, the project dir and your output finds nothing. Use a variable, never echo it.
- `bash examples/demo-a/run.sh` (scripted, all modes) still exits 0 with all PASS. Check `$?` unpiped.
- Don't run `npm test`. The machine is loaded, and the orchestrator runs it.
- Don't commit. Report the files changed, the outputs, and the cost in calls and tokens if the API reports usage.
