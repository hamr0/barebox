# Pre-M11 fixes brief: one CLI nit, three missing tests (2026-11-11)

Worker: code-developer (Sonnet). Branch `fix/pre-m11` (already checked out). Do **not** commit; the orchestrator commits on the user's word.
Rules: `.claude/remember/AGENT_RULES.md`. Every new or changed test is shown **red** (against the mutation or the old code named below) and then **green**; paste both outputs. Run a mutation in a scratch copy of the repo (scratchpad), never in the repo tree, and copy every changed src file into the copy (a partial copy gives a false "green red").
Loop one test with `node --test --import ./test/setup-env.mjs --test-name-pattern='<name>' <file>`. Do **not** run the full suite. Socket and bwrap tests may skip in your sandbox: list each skipped test as **pending**, never as passed; the orchestrator runs them in a real shell.
If a fact below is wrong, stop and report it. Do not work around it.

## A. Print the answer once when the terminal prompt showed the hold

Facts (checked):
- `src/cli.js:263` `emitAsk`: `if (prompt?.ask(h)) return;`, so a hold shown in the prompt gets no plain `ask` line on stdout.
- `src/cli.js:270-274` `emitDecided` always prints `decided <id> <decision> (<reason>)` to stdout, so a prompted hold shows `✗ denied` (prompt, stderr) and then `decided h1 deny (denied at the terminal)`. Seen in a live run.
- `src/cli.js:298` calls `prompt?.decided(e); emitDecided(e);`. `prompt.decided` (`src/prompt.js:125`) returns nothing and is a no-op once the person has answered, since `open` is already null.
- `test/cli-prompt.test.mjs:102` asserts `/decided h\d+ allow/` in the pty run, which is the duplicate.

Rule: **the plain `decided` line is printed only for a hold whose plain `ask` line was printed.** `--json` is unchanged: no prompt runs with `--json`, so every ask and decided event is still emitted.

Steps:
1. In `run()` keep a `Set` of ids the prompt showed: add the id in `emitAsk` when `prompt?.ask(h)` is true. In `emitDecided` (non-json only), if the set holds `e.id`, delete it and print nothing. Leave `prompt.js` alone.
2. `test/cli-prompt.test.mjs:102`: replace it with an assertion that no `decided h\d+` line appears in that run. Add the same "no decided line" check to the `typing n denies it` test.
3. Red: the changed test against the old `src/cli.js`. Green: with step 1.
4. `CHANGELOG.md` `[Unreleased]`, under **Changed**: "`sbx run` on a terminal no longer prints a plain `decided` line after an answer the prompt already showed."

## E. A held request never carries the real secret value

Facts (checked):
- `src/proxy.js:707-712` `withSecrets` is the only call of `applySecrets`. It runs after the gate, on the headers being forwarded.
- Ledger (2026-11-01 @ 9ead282): applying the secrets to `creq.headers` before the gate leaves all m5 tests green, because nothing writes held headers anywhere.
- Heap-snapshot probe, checked in a shell: a string built by split/join is flat and shows up in `v8.getHeapSnapshot()` text; a string built by `+` (cons) may not. `swapIn` builds the forwarded header value; check how it builds it before relying on this.

Steps:
1. In `test/m5.test.mjs` (reuse its proxy and secrets setup), add: a secret bound to the test host, the agent sends a request that is **held**, with `Authorization: Bearer <placeholder>`. While it is held, take `v8.getHeapSnapshot()` of the test process (the proxy runs in-process; check this) and assert the text does **not** contain `Bearer <real value>`. Then deny the hold. Give the test its own timeout.
2. Red: in a scratch copy, swap early (e.g. `creq.headers = applySecrets(creq.headers, url.hostname, secrets)` before the gate decision). The test must fail **5 of 5** runs. Green: unmodified, 5 of 5.
3. Positive control in the same test or a sibling: after an allow, the snapshot (or the echoed upstream header) shows the real value was used, so the probe can see the string at all.
4. If the probe cannot go red reliably (5/5), stop and report with output. Do not add a test-only hook to `src/` without the orchestrator's go.

## F. The CONNECT first-byte wait times out

Facts (checked):
- `src/proxy.js:919` `admit` sets `sock.setTimeout(clientIdleMs, ...)` and clears it with `sock.setTimeout(0)` (~`:939`) before `handleConnect`. So after the `200 Connection established`, the only bound on a client that sends nothing is `src/proxy.js:978` `sock.setTimeout(clientIdleMs, () => sock.destroy());`.
- Ledger: deleting `:978` or its `close` listener leaves all tests green.

Steps:
1. In `test/proxy.test.mjs` (reuse its proxy setup), with a small `clientIdleMs` (e.g. 300): send `CONNECT host:443`, read the 200, send nothing, and assert the proxy closes the socket within a bounded time (e.g. 3 s). The test fails by name if it does not close: give it its own timeout and assert the close, don't wait for the runner's timeout.
2. Red: in a scratch copy, delete the `:978` line; the test fails. Green: unmodified. Loop each 5x.
3. Only if it is observable without timing guesses: a client that closes before its first byte frees the proxy, e.g. `proxy.close()` resolves promptly. If not observable, report it as not covered and say why.

## G. The raw bytes are scanned even when the decoded text differs

Facts (checked in a shell, `viewBody` from `src/bodyview.js`):
- `deflate` body = `zlib.deflateSync('hello world')` followed by plain ` 4242 4242 4242 4242`: `viewBody` returns state `decoded`, text `hello world`, and `view.text !== body`. The card is only in the raw bytes.
- `src/proxy.js:871`: `return createCardScanner().push(body) || (view.text !== body && createCardScanner().push(view.text));`
- Ledger: the mutation "scan raw only when the decoded text equals the body" leaves the gate tests green.

Steps:
1. In `test/gate.test.mjs`, next to the existing deflate card tests: send that body with `Content-Encoding: deflate` in **trust** mode and assert it asks (`rule=flags.cardLike`, or however the neighbouring tests assert an ask).
2. Red: in a scratch copy, change `:871` to `return view.text !== body ? createCardScanner().push(view.text) : createCardScanner().push(body);`. Green: unmodified.

## Done when

- A, E, F, G: diff of each changed file, plus red then green output for each test (E 5/5 both ways, F 5x).
- `npm run typecheck` passes. List the skipped tests as pending.
- One-line report per section: done / stopped (why).

## Orchestrator verifies

- Reruns each red mutation itself in a scratch copy.
- Full suite 3x in a real shell, 0 fail 0 skip, plus typecheck, build:types and check:primitives, announced to peer sessions with UTC times. A real `sbx run` on a TTY shows one answer line.
- Deletes the fixed ledger bullets (A, E, F, G) and the stale ones.
