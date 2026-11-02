# Brief: answer holds in the same terminal as `sbx run`

Branch `m6`. User decision (Nov 2): "build the same-terminal prompt now". The
user ran Demo B live and found the second-terminal flow (env var, temp path,
`rule=rwx.ask`) too technical to read or answer.

## Target UX

When `sbx run` has a terminal (stdin AND stderr are TTYs) and is not `--json`,
each hold prints a plain-language question on stderr and waits for one key line:

```
⏸  h3 · The agent wants to SEND data to httpbin.org
   Why:  a change barebox can't undo
   URL:  POST https://httpbin.org/post?step=7
   Data: step=7&stolen=ssh:          (first 200 chars, already masked)
   Allow? [y/N]  — no answer in 120 s means No
```

- `y` / `yes` (any case) + Enter → approve. Anything else, or just Enter → deny with
  reason `denied at the terminal`. Then one line: `✓ allowed` / `✗ denied`.
- Wording, from the ask record fields (`method`, `url`, `rule`, `letter`,
  `bodyPreview`, `expiresAt`): verb by method — POST "SEND data to", PUT/PATCH
  "CHANGE data on", DELETE "DELETE data on", other "make a <METHOD> request to";
  host from the URL. Why by rule: `flags.cardLike` "it contains what looks like a
  card number"; `flags.paymentPath` "the address looks like a payment"; else by
  letter: `w` "a change (reversible: the vendor says it can be undone)", `x` "a
  change barebox can't undo". Unknown rule: print the rule as is.
- Every agent-controlled byte goes through `safe()` (`src/runtime.js`), as
  `emitAsk` already does (`src/cli.js` run()).
- No TTY, or `--json`: behaviour unchanged (today's `ask …` / `decided …` lines).
  The existing lines also stay printed in TTY mode? No: in TTY mode the question
  replaces the `ask …` line; keep the `decided …` line.
- Second-terminal answers keep working at the same time (`sbx approve/deny`):
  the first answer wins.

## Facts (checked by the orchestrator, Nov 2)

- The agent never reads the terminal: `src/launcher.js:331` spawns bwrap with
  `stdio: ['ignore','pipe','pipe']`; `sbx` owns stdin.
- `sbx run` (`src/cli.js` `run()`, about lines 145-240) gets holds through
  `onEvent` (`type: 'ask'` with the ask record; `type: 'decided'` with
  `id, decision, reason`). It does not pass `onAsk`, so the default file channel
  is on: `asks/<id>.json` → `answers/<id>.json`.
- `sbx approve/deny` answer with
  `writeFileAtomic(paths.answerFile(id), JSON.stringify({ decision: 'allow' }))`
  (`src/cli.js` ~378-386). The terminal answer must use this same writer — one
  writer of answer files. Do NOT pass `onAsk` (it turns the file channel off and
  `sbx approve` would stop working).
- One held request per agent; `sbx run` runs one agent, so at most one question
  is open at a time. A hold also ends without the terminal: answered from another
  terminal, timeout (`decided … deny (hold timeout)`), or client gone.

## Must hold (stale vs fresh — CLAUDE.md "one writer per piece of state")

1. A line typed before a question was printed never answers it (e.g. a `y` typed
   during h1 must not approve h2). Bind each answer to the open hold id; drop
   input that arrived while no question was open.
2. When the open hold is decided elsewhere (`decided` event for that id), the
   prompt closes with one line (`answered elsewhere: allow|deny (reason)`), and
   no answer file is written afterwards.
3. Writing an answer for a hold that is already decided must not crash `sbx run`.
4. Ctrl-C still stops the run as today.
5. When the run ends, stdin is released (the process exits; no hanging readline).

## Build

- The question text: a small pure function (ask record → lines), exported from
  where it is used or a small module; unit-tested for every rule/letter/method
  above and for unsafe bytes.
- The prompt: takes `input`/`output` streams so tests can drive it with
  `PassThrough`; `run()` passes `process.stdin`/`process.stderr` only when both are
  TTYs and not `--json`.
- One end-to-end test through a real pty: `script -qec "<sbx run …>" /dev/null`
  (util-linux; present on Ubuntu CI runners — verify `script` exists in CI's
  image via `scripts/ci-runner-deps.sh` or the runner; if not certain, add it
  there) feeding `y\n` → a held POST gets 200; feeding `n\n` → 403 with reason
  `denied at the terminal`. Use the existing CLI test helpers and a local upstream
  (`SBX_UNSAFE_TEST_ALLOW_LOOPBACK`) like `test/cli.test.mjs` does. Its own
  timeout so a hang fails by name.
- Tests for Must-hold 1-3, each shown red against a version without the guard.
- `examples/demo-b/run.sh`:
  - `--live`: run each agent's `sbx run` in the foreground with the terminal, no
    hold loop, so the user answers in place. Print one line before each mode
    telling what to approve (`demo=legit`) and what to deny.
  - claude driver: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for claude;
    the run FAILs (not PASS) when the agent exits non-zero or none of steps 2-5
    ran ("hollow green" otherwise). Today it printed `RESULT: all PASS` with every
    step NOT RUN.
- Docs: README "Approvals" line (`README.md:76`), `barebox.context.md` (how to
  answer), CHANGELOG [Unreleased] Added. Another worker edits the CHANGELOG and
  context doc at the same time for the model-call card exemption: small Edits,
  re-read on a failed Edit. JSDoc changes → `npm run build:primitives`.

## Rules

- Touch `src/cli.js` (and a new small module if needed), tests, `examples/demo-b/`,
  the docs above. Not `src/proxy.js` / `src/policy.js` (another worker).
- No new dependencies. No full suite or bench (peer sessions); run touched test
  files. Do not commit. A fact above wrong → stop and report.

## Done when

- [ ] Unit + pty tests red first (show), green after; touched files 0 fail 0 skip.
- [ ] Mutations: drop the stale-input guard → test 1 fails; write the answer after
      an elsewhere-decided event → test 2 fails.
- [ ] `./examples/demo-b/run.sh` (scripted, all) still all PASS.
- [ ] `npm run typecheck`, `npm run check:primitives` exit 0.
- [ ] Paste one real question block as printed in a pty.
- [ ] Report: files, test output, mutations, differences from this brief.

## Orchestrator verifies

Run `sbx run -- curl -X POST …` by hand in a terminal and answer y and n; run
`examples/demo-b/run.sh --mode auto --live` by hand; the mutations; full suite 3x.

## Amendment (user, Nov 2): name the sandbox

One `sbx run` = one sandbox = one agent, so the user names the **sandbox**:
`sbx run --name docs-bot -- <cmd>`. The name replaces the `SBX_RUNTIME=/tmp/…` path
for every later command.

- `--name <n>` (rules: `assertAgentName`, `src/runtime.js:25`) sets BOTH the
  agent name (audit, ask records, the question header) and the runtime dir:
  `$XDG_RUNTIME_DIR/barebox/<n>` when `XDG_RUNTIME_DIR` is set and is an existing dir you own,
  else `<os.tmpdir()>/sbx-<uid>/<n>`. Parent dirs created 0700 through the
  existing owner-only helper (`src/runtime.js` ~136-150, refuses a dir owned by
  another uid). One owner: a `namedRuntime(name, env)` function in
  `src/runtime.js` next to `createRuntime()`; every command calls it.
  Check the socket path cap (107 bytes): the longest socket path under a named
  runtime with a 32-char name must fit; refuse longer with a clear error.
- The question header leads with the name: `⏸  docs-bot wants to SEND data to
  httpbin.org` and the hold id moves to the end of the Allow line
  (`Allow? [y/N] (h3)`), since it only matters to a second terminal.
- `sbx pending|approve|deny|diff|commit|rollback --name <n>` address that
  sandbox (runtime from `namedRuntime`, agent = name for the overlay
  commands). `SBX_RUNTIME` still works and wins when both are given? No: giving
  both is a usage error (exit 2) — one way to address a runtime per call.
  `--agent` on diff/commit/rollback stays for library-made runtimes.
- The startup line becomes `sandbox docs-bot (answer from another terminal:
  sbx approve --name docs-bot <id>)`; unnamed runs keep today's line.
- Without `--name`: unchanged (fresh temp runtime, agent `agent`).
- A named runtime persists after the run (diff/commit need it). A second
  `sbx run --name docs-bot` while one runs is refused by the existing runtime lock
  (verify the message names the sandbox); after it ends with uncommitted overlay
  changes, the existing launch refusal applies (verify, and that the message
  tells the user to `sbx commit|rollback --name docs-bot`).
- Tests: namedRuntime with and without `XDG_RUNTIME_DIR` (tests set the env
  explicitly — never depend on the host's; CI runners differ), foreign-owned
  parent refused, name rules, path-cap refusal; one CLI test running
  `sbx run --name t1 --overlay`, then `sbx diff --name t1` and
  `sbx rollback --name t1`; `--name` with `SBX_RUNTIME` → exit 2. Red first.
- `examples/demo-b/run.sh`: use `--name` (e.g. `ask-good`, `auto-injected`)
  instead of exported runtime paths where it simplifies; the printed answer
  hints use `--name`.
- Docs: README usage and Approvals, `barebox.context.md`, CHANGELOG Added.
