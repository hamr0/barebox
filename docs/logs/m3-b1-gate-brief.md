# M3 part B1 brief: bareguard decides every request (2026-10-29)

Branch `m3`, at `7dfcccb`. bareguard 0.29.0 is on npm, and our acceptance test (`poc/m3/askunheld.mjs`) passes against it. rwxmap 0.8.0 is NOT released yet: in this round every request reaches the gate as `http.<METHOD>`. The rwxmap lookup is B2.
Design source: PRD section 7 M3, "Design (decided Oct 29)".

## Rules

These are the same as `docs/logs/m3-a-brief.md`:
- Sonnet writes the code.
- Each required test is shown red, then green.
- Full `npm test` and `npm run typecheck` at the end, with counts. A skip is not a pass.
- Reuse before adding. One writer per piece of state.
- No docs, CHANGELOG, `barebox.context.md` or README edits. `primitives.json` only through `npm run gen:primitives` (or the repo's generator) if a new export needs it; say so.
- Do not commit.
- Never run sync child clients in the proxy's process.
- Every socket test gets its own timeout.

## Facts checked in bareguard 0.29.0 (`node_modules/bareguard/src/gate.js`)

- `check()` never returns `askHuman`. It resolves the ask through `humanChannel` and returns allow or deny.
- With no `humanChannel` it denies with "(no humanChannel registered)" (about L1139–1152). So barebox MUST give each gate a `humanChannel`.
- The grant comes from gate config (`rwx.agent`, `rwx.agents`, `rwx.tools`), never from the action. Use one gate per agent, all built from ONE shared `tools` object.
- `flags` read `action[field]`. They run before rwx and can only add an ask or deny.
- Audit: `audit: { path }`. Never use fileless mode: it keeps every line in memory.

## The design

1. **`src/policy.js` (new)** owns the modes. Export `MODES` and `gateFor({ agent, mode, auditPath, humanChannel })`, which builds a bareguard `Gate` (then `init()`):
   - The letters come from the mode:
     - `ask` → `letters "r--"`, `askUnheld ["w","x"]`
     - `auto` → `"rw-"`, `["x"]`
     - `trust` → `"rwx"`, `[]`
   - `tools` is ONE module-level object: `http.GET` and `http.HEAD` = `r`; `http.POST`, `http.PUT`, `http.PATCH` and `http.DELETE` = `x`. Any other method is unlisted, so it is denied (`rwx.unlisted`).
   - `flags: { cardLike: { true: "ask" }, paymentPath: { true: "ask" } }`.
   - `src/config.js` and `src/cli.js` import `MODES` from here; their own mode lists go. This also clears the ledger nit about three copies of the mode list.
2. **The action**: `{ type: "net", tool: "http.<METHOD>", url, method, agent, cardLike, paymentPath, rid }`.
   - `rid` is a barebox per-request id. It is how the human channel finds the request.
   - `paymentPath` is the existing `FLOOR_PATHS` check, moved from `src/run.js` to `policy.js`.
   - `cardLike` comes from the card scanner. It is `false` when the body is over 64 KB or absent.
   - Never put the body in the action. bareguard writes the action to its audit file.
3. **One decision path in the proxy.** For every request (the TCP door's `tcp` agent included):
   - If it has a body, read up to 64 KB in the agent's working slot first. Reuse `takeWorkSlot` and `readBounded`.
   - Then `await gate.check(action)`.
     - **allow** → forward. Use the buffer for a small body; use the prefix plus the stream for a large one.
     - **deny** → 403 with the gate's `rule` and `reason` in the note.
     - The human channel (item 4) runs *inside* `check()` whenever the gate asks.
   - `queue.decide()` / `shouldHold` / `holdBuffered` / `holdStreamed` as separate decision paths go away. Tests that used `hold.shouldHold` move to a test gate (item 5), so the proxy keeps one decision path.
4. **The human channel = barebox's hold queue.** Each gate's `humanChannel(event)`:
   - Finds the request by `event.action.rid`.
   - Reserves the agent's hold slot. If the line is full, it returns `{ decision: "deny", reason: "hold queue full" }`, and the proxy answers **429** (not 403) for that reason.
   - Spools the body to `<runtime>/held/<id>`: the 64 KB already read, plus the rest of the stream, up to `hold.maxBody`. Over the cap it is denied `body too large to hold`.
   - Frees the working slot, parks, writes the ask file or calls `onAsk` as today, and waits for the answer or the deadline.
   - Returns `{ decision, reason }`. On allow the proxy forwards from the file; deleting the file and the existing settle/abandon paths stay as they are.
   - The ask `rule` is the gate's `event.rule` (e.g. `rwx.ask`, `flags.cardLike`, `flags.paymentPath`), and `letter` is `event.rwxLetter` when present.
   - Everything else in the queue stays as it is (1 held + 16 waiting, the deadline from arrival, the ask files, `onAsk`, `onEvent`).
5. **Who supplies the gate.** `createProxy` takes `gateFor: (agent) => checkObject`, called once per agent at `addAgent` and once for `tcp`.
   - `run()` passes `(agent) => policy.gateFor({ agent, mode, auditPath, humanChannel })`.
   - A caller may pass any object with `async check(action)` returning `{ outcome: "allow"|"deny"|"askHuman", rule?, reason? }`. When a plain object returns `askHuman`, the proxy calls the same human channel itself, so there is one channel either way.
   - Tests use this for a simple path-based test gate instead of `shouldHold`.
6. **Audit**: all gates write to `<runtime>/gate.jsonl`, add it to `runtimePaths`. barebox's own `audit.jsonl` stays for now; merging the two files is B2.
   - Show, by reading bareguard's audit writer, whether 20 gates appending to one file is safe: one `write` per line in append mode. If it isn't, use one file per agent, `gate-<agent>.jsonl`, and say why.
7. **Local model servers**: a new config key `localLlm`, an array of `"host:port"` strings, default `[]`, validated.
   - It flows CLI → `run({ allowLocal })` → `createProxy({ allowLocal })` → the wall. ONLY those exact host:port pairs pass the private/loopback check; any other local destination is still denied.
   - The wall stays the one owner of that check (`src/wall.js`). Add the exception there; do not duplicate the logic.
   - Do not touch `unsafeTestOnly.allowLoopback`: it is the test-only escape and stays separate.

## Required tests (each red first, then green)

1. **Modes, through the real proxy** (a local upstream with `unsafeTestOnly.allowLoopback`):
   - `ask`: GET forwards; POST asks.
   - `auto`: GET forwards; POST asks.
   - `trust`: POST forwards.
   - An `OPTIONS` request is denied with `rwx.unlisted` in every mode.
2. **Floor in trust**: a small body with a card asks (rule `flags.cardLike`), and a POST to `/checkout` asks (`flags.paymentPath`).
3. **Answers**: approve forwards the exact bytes (a held body over 64 KB included, checked by SHA-256); deny gives 403; timeout gives 403 "timed out".
4. **Line full**: the 18th held request of one agent gets **429**.
5. **Audit**: `gate.jsonl` has a `phase:"gate"` line with `rule:"rwx.ask"` and `rwxLetter:"x"` for an auto-mode POST, and a `phase:"approval"` line with the same `aid` after the answer. No line contains the body bytes: send a unique marker string in the body and assert that it is absent.
6. **A plain check object**: `gateFor` returning `{ check: async () => ({ outcome: "askHuman", rule: "test" }) }` parks and asks through the same channel.
7. **localLlm**:
   - With `allowLocal: ["127.0.0.1:<port of a host-side listener>"]` and NO `allowLoopback`, a request from INSIDE a real sandbox (`run()` + curl) reaches the listener.
   - The same request to a different loopback port is denied by the wall.
   - Use the repo's sandbox gating; this test needs bwrap and sockets.
8. All existing tests stay green. List each test you migrated off `shouldHold` and why.

## Report back

- The files changed.
- Each red→green pair, with output.
- Full-suite counts and typecheck.
- The public API changes (for the CHANGELOG): `hold.shouldHold` / `hold.match` removed or kept, `gateFor`, `allowLocal`, the `localLlm` key, `gate.jsonl`.
- What you found about concurrent audit writes, with file:line.
- The doc text now false.

## How the orchestrator will verify

- Rerun the red→green pairs.
- The suite 3x in a real shell.
- An `sbx run --mode auto` smoke test against a real HTTPS site: a GET passes, a POST asks.
- A memory spot check with 20 gates (the full bench is B2).
