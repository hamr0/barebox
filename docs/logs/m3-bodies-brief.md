# M3 bodies brief: working slot, held bodies on disk, masked previews (2026-10-29)

Branch `m3`. Part A is already on the branch, uncommitted: `src/cardscan.js` (`createCardScanner`, `maskCards`), `src/config.js`, and the CLI semi-space flag.
Design source: PRD section 7 M3, "The body check", as decided by the user on Oct 29.
This brief needs neither bareguard 0.29.0 nor rwxmap 0.8.0: the hold decision is still today's `decide()` seam (`shouldHoldForMode` in `src/run.js`).

## Rules

These are the same as `docs/logs/m3-a-brief.md` "Rules":
- Sonnet workers write the code. The orchestrator verifies in a real shell.
- Each required test is shown red, then green.
- Full `npm test` and `npm run typecheck` at the end, with counts. A skip is not a pass.
- Reuse before adding. One writer per piece of state.
- No docs, CHANGELOG, `barebox.context.md`, README or `primitives.json` edits. Report what your change makes false.
- Do not commit.

## Today's code (read before changing; line numbers at the brief's writing)

- `src/proxy.js` `handleRequest` (about L357–458) has two body paths:
  - **Unheld** requests stream to upstream, with a tee that keeps up to `maxLogBody` (1 MB) in memory for the `req` log line, verbatim.
  - **Held** requests reserve the agent's hold slot (`queue.reserve`), then read the whole body into memory up to `holdMaxBody` (1 MB). The body travels in the held entry and `onApprove` forwards it with `forward({ body })`.
- `src/holds.js` `askPayload` (about L359) builds `bodyPreview` as the first `ASK_BODY_LIMIT` (4096) bytes, verbatim.
- `forward()`/`forwardInner()` take either `body` (a Buffer) or `stream` (piped to upstream).

## B1: the working slot and the card floor (`src/proxy.js`)

For a request that `decide()` would let through (`!reason`) and that has a body:
- Each agent has ONE working slot. It is held while that request's body is read into memory, up to 64 KB, and freed as soon as the body is forwarded or handed to the held file.
  - Another body-carrying request from the same agent waits, paused and unread, until the slot is free.
  - A request with no body (GET, or `content-length: 0`) never takes the slot.
- If the body ends within 64 KB:
  - Run `createCardScanner` on it.
  - No card: forward the Buffer.
  - Card: the request becomes a hold, with reason `card number in body (floor)`. It enters the agent's normal line: reserve, then park. It works in every mode, because it bypasses `decide()`'s mode logic, like the payment-path floor. Its body goes to the held file (B2), and the working slot is freed.
- If the body passes 64 KB: stop buffering. Forward the buffered bytes, then pipe the rest of the stream upstream, unchecked for cards (a known gap, decided). Free the slot once the buffered part has been handed to upstream.
- Requests that `decide()` holds (x asks, the payment path) do not use the working slot. Their body is read only when they reach the front of the line, as today, but into the held file (B2).

## B2: held bodies on disk (`src/runtime.js`, `src/proxy.js`, `src/holds.js`)

- `runtimePaths` gains `heldDir` (`<runtime>/held`, created 0700 like `asks/`) and `heldFile(id)`. `runtime.js` stays the one owner of runtime paths. The runtime folder is already masked inside the sandbox; confirm that `held/` falls under the existing mask, and show the proof.
- A held request's body is written to its file as it is read (never whole in memory), up to `hold.maxBody`. Change the default from 1 MB to 50 MB (`52428800`). Over the cap, deny 403 `body too large to hold`, as today, and delete the partial file.
- On approve, forward with `stream: fs.createReadStream(file)`. The upstream must receive the exact bytes; keep or set `content-length` correctly.
- The file is deleted on every end: approve (after the upstream has read it), deny, timeout, client gone, removeAgent, and proxy close. One function deletes it; grep for every settle/abandon path and call it from each.
- The held entry no longer carries the body Buffer. Remove `body` from the entry, or keep only the 4 KB preview for `askPayload`. Your choice; say which and why.

## B3: one preview for the log and the ask (`src/holds.js`, `src/proxy.js`)

- One function makes the preview: the first 4 KB of the body as utf8, then `maskCards`. Both `askPayload` and the proxy `req` log line use it.
- The `req` log line carries `bodyPreview` (masked, ≤ 4 KB), `bodyBytes` (full length) and `bodySha256` (hex, over all bytes, computed as they stream: constant memory). It never carries the full body. `maxLogBody` goes away.
  - Grep its uses, including the types and the option's JSDoc. Report it as a public option removal for the CHANGELOG.
- A large streamed body still gets a preview (the first 4 KB seen) and a hash. The tee keeps at most 4 KB.

## B4: hide the config wherever it resolves (`src/launcher.js`)

- The locked-path mask for barebox's config must use `path.dirname(configPath(process.env))` from `src/config.js`, not the fixed `.config/barebox`. Keep the existing `lockMask` behaviour: a path outside `$HOME` that is not bound into the sandbox needs no mask, and a path inside the project follows the existing rule.
- Test: with `XDG_CONFIG_HOME=$HOME/altcfg` and the file at `$HOME/altcfg/barebox/config.json`, reading it inside the sandbox returns empty. It must be red with today's fixed entry.

## B5: config key `heldBodyMaxMB` (`src/config.js`, `src/cli.js`)

- A positive integer. The default comes from the library's 50 MB. The CLI passes it as `hold.maxBody` (through `run()`; add a `heldBodyMaxBytes` run option if `run` has no path for it; say which).
- Test: an unknown or bad value is refused, naming the key, in the existing config test style.

## Required tests (each red first, then green; real sockets, real proxy, as `test/proxy.test.mjs` does)

1. **Card floor.** In `trust` mode, an allowed POST with a 2 KB body containing `4242 4242 4242 4242` parks as an ask with reason `card number in body (floor)`.
   - Approve: the upstream echo receives the exact bytes.
   - Deny: 403.
   - The ask file's `bodyPreview` shows `**** **** **** 4242`.
2. **No card, small body:** forwarded with no ask, exact bytes.
3. **Large body:** a 200 KB allowed POST with a card number near its end is forwarded with no ask, and the upstream receives exact bytes (compare SHA-256).
4. **Held body on disk.**
   - A held x POST with a 2 MB body: while it is parked, `<runtime>/held/<id>` exists with 2 MB.
   - After approve, the upstream receives exact bytes (SHA-256) and the file is gone.
   - Repeat with deny, with timeout, and with the client gone: each time the file is gone afterwards.
5. **Cap:** a held POST over `hold.maxBody`, set small in the test, gets 403 `body too large to hold`, and no file is left.
6. **No freeze.** Agent A has a card ask parked. Agent A's second, allowed small POST without a card completes while the ask is still parked.
7. **Same agent, concurrent.** Two allowed small POSTs from one agent, started together, both complete with exact bytes. The working slot serialises them; it does not deadlock.
8. **Log.**
   - A 1 MB allowed POST produces a `req` line with `bodyBytes` 1048576, a correct `bodySha256`, and a `bodyPreview` of at most 4096 bytes.
   - A card in a small allowed body appears masked in `bodyPreview`.
   - No `req` line contains a full body over 4 KB.
9. **Chunked:** a held request sent with `transfer-encoding: chunked` (no content-length) is forwarded on approve with exact bytes.
10. B4's XDG test and B5's config test.

All existing tests stay green. Some assert today's verbatim log `body` or the ask `bodyPreview`. Update those, and list each one you changed and why.

## Report back

- The files changed.
- Each red→green pair, with the pasted output.
- Full-suite counts and typecheck.
- The public API changes: `maxLogBody` removed, the `hold.maxBody` default, any new `run` option.
- The doc text now false.

## How the orchestrator will verify

- Rerun the red→green pairs.
- `npm test` 3x in a real shell, plus typecheck.
- A manual probe: park a 2 MB held POST, check that the proxy's RSS does not grow by about 2 MB, and that the file exists.
- Read the diff against this brief.
