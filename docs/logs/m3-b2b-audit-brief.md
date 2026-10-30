# M3 part B2b brief: one audit file (2026-10-30)

Branch `m3`, at `9ddbc6d`. Today a runtime writes two logs:
- `<runtime>/audit.jsonl`: barebox's own lines, written by `log()` in `src/proxy.js`. The hold queue gets the same `log`.
- `<runtime>/gate.jsonl`: bareguard's lines, one Gate per agent.

B2b makes `gate.jsonl` the only file. Every line is in bareguard's shape and is written through a bareguard Gate.
Design source: the PRD's Decisions, "Audit", and F3: "`gate.record` for response status, `gate.annotate({ surface:false, ... })` for barebox's own facts".

## Rules

These are the same as `docs/logs/m3-b2a-labels-brief.md`:
- Sonnet writes the code.
- Each required test is shown red, then green.
- No docs edits.
- Do not commit.
- Never run sync child clients in the proxy's process.
- Every socket test gets its own timeout.
- Your tool calls time out at about 60 s, so run the affected test files and `npm run typecheck`. The orchestrator runs the full suite 3x and the bwrap tests in a real shell. List what you could not run.

## Facts checked in bareguard 0.29.0 (`node_modules/bareguard/src/gate.js`, `primitives/audit.js`)

- `gate.record(action, result, { aid })`:
  - It writes `{ phase: "record", action, aid, result }`.
  - Pass the `aid` from the matching `check()` decision (`d.aid`) to join the record to its request.
  - A real run gave `{"phase":"record","aid":"e7fd09c4","result":{"status":200}}` after a check with the same aid.
- `gate.annotate({ surface, verdict, where, meta })` writes `{ phase: "annotate", surface, verdict, where, meta }`.
  - `surface` must be a boolean. Without one, the call writes an `annotate_malformed` line instead.
  - Limits: `verdict` is cut to 80 characters and `where` to 300. If `meta` serializes to more than 1000 bytes, it is replaced WHOLE by `{ _truncated: true, bytes }`, so every field in it is lost.
  - An audit write failure throws out of `annotate`.
- **`annotate` keeps every fact in memory until `gate.drainAnnotations()` is called.** A real run of 1000 `annotate({ surface: false })` calls left `_annotations.length === 1000`, and a later ask carried none of them. barebox has no turns, so it must call `drainAnnotations()` right after every `annotate`, or memory grows forever.
- Each Gate has its own `Audit`. It stamps `ts`, `seq` (per gate) and `run_id` (per gate). Writes are appends to the same file, so several gates can share one file (B1 already does this).
- The docs say `check` and `record` must be called serially per Gate, or `seq` ordering is undefined. barebox already calls `check()` concurrently per agent, and only `seq` ordering is affected (`seq` is `++this.seq` at emit). Accept that, and do not add locking.
- `Gate`, `redact` and `routeAnnotation` are exported. `Audit` is not.

## Today's barebox lines and where each goes

These are every `log({ ev: ... })` call site (from `grep -n "ev: '" src/*.js`):
- `src/proxy.js`:
  - `req` (L~628)
  - `resp` (L~338)
  - `deny` (L223, L234, L895)
- `src/holds.js`:
  - `hold` (L550)
  - `decide` (L420, L424)
  - `deny` 500 (L450)
  - `stale-answer` (L294, L498)
  - `malformed-answer` (L494)
  - `hold-queue-full` (L603)
  - `hold-abandoned` (L627)

1. **`req` is dropped.** The gate's own check line already records the request: `action` has method, url, tool, agent, cardLike, paymentPath and rid. The scrubbed request headers are no longer logged. That is deliberate: fewer secrets on disk.
2. **`resp` becomes `gate.record(action, { status }, { aid })`.**
   - It is written on the gate that decided the request, with that request's action and `d.aid`.
   - Thread the action and aid from `handleRequest` through `forward()` to the `up.on('response')` site.
   - A plain-object gate without `record`, or a missing aid, falls back to item 3's path, with `verdict: "resp"`.
3. **Everything else becomes an annotate.** Keep the `log(o)` function signature, so `holds.js` and the call sites don't change. Replace its body:
   - Pick the gate:
     - If the agent's gate is already built (`gates.get(o.agent)`, awaited), use it. NEVER build a gate from `log`.
     - Otherwise use the runtime's **`sbx` gate**: one `new Gate({ audit: { path: logFile } })`, `init()`-ed once at `createProxy` start. It never runs `check()`.
     - Lines with no agent go to it, and so does everything when `gateFor` is omitted.
   - Write `annotate({ surface: false, verdict: o.ev, where: <short one-line summary, e.g. "h3 agent POST https://host/path">, meta })`, then `drainAnnotations()` on the same gate.
   - `meta` is `redact(scrubSecrets(o))` minus `ev`, **bounded by barebox before the call**:
     - cut `url` to 400 characters and `note` and `reason` to 200
     - if the JSON is still over 900 bytes, keep only `id`, `agent`, `method`, `code`, `decision`, plus `url` cut to 200 characters
     - The ids that join an ask to its outcome must never be lost to bareguard's whole-meta replacement.
   - `log` stays synchronous for callers. Track each pending write in a Set.
   - `close()` awaits them, within the existing 3 s shutdown wait. A write that fails is reported once to stderr, as the old stream `error` handler did. It never crashes the process.
   - A `log` after `close()` has started is dropped. This keeps the existing "late line after end" rule, whose violation once wedged `close()`.
4. **One file.**
   - `runtimePaths(runtime).audit` now IS `gate.jsonl`. Remove the separate `gateAudit` path.
   - `createProxy`'s `logFile` option stays and names that file. Every gate and the `sbx` gate write to it.
   - `run()` passes the same path to `gateFor({ auditPath })` and returns it as `audit`.
   - Keep the synchronous open check: a bad `logFile` must still throw from `createProxy` before the claim is held, and keep the 0600 chmod. Do this with `fs.openSync` + `closeSync` before building the `sbx` gate.
   - Nothing writes `audit.jsonl` any more. Tests that read it move to `gate.jsonl` and the new shape.
   - Search for test helpers that parse `ev` lines. Change them once, in one helper, not one by one.

## Required tests (each shown red first)

1. One file: after a run with a GET (allowed), a POST (asked, then approved) and a 403 deny, the runtime holds `gate.jsonl` and NO `audit.jsonl`. The GET's `check` line and its `record` line share one `aid`, and the record has `result.status === 200`.
2. A hold joins: the POST's ask id (`h1`) appears in an `annotate` line with `verdict: "hold"` and in one with `verdict: "decide"`, and both have `meta.id === "h1"`.
3. Bounded meta: a hold with a 5 KB URL still writes `meta.id` and `meta.agent`, and no `_truncated` marker.
4. Drain: after 200 denied requests on one agent (for example a bad request target), the agent's gate holds 0 buffered annotations (`_annotations.length === 0`). Also check the `sbx` gate.
5. No gate built from log: a `deny` logged for an agent whose gate is not built yet goes to the `sbx` gate, and `gateFor` was not called for it.
6. `gateFor` omitted (forward-all mode): lines still land in `gate.jsonl`, through the `sbx` gate.
7. `close()` waits for pending writes: a line logged just before `close()` is in the file once `close()` resolves. A `log` after `close()` started is dropped without throwing.
8. A bad `logFile` (a directory) still throws from `createProxy`, and the runtime claim is released. This is the existing test, kept green.
9. No headers: no line in `gate.jsonl` contains the request's `authorization` header value. Send `Authorization: Bearer test-secret-xyz` and grep the file for `test-secret-xyz`.

## Done when

- The affected test files and `npm run typecheck` are green with counts. Every required test is shown red, then green.
- `grep -rn "audit.jsonl" src/ test/` finds nothing except a comment saying it is gone, if one is needed.
- The report lists every barebox line kind and where it now goes, every changed export or option, what you reused, and every assumption.
