# Hardening brief: one held request per agent, plus four small fixes (2026-10-28)

**For:** the build agent. **Branch:** `hardening`, cut from `main` at `78b6406` (v0.3.0 is released). The tree is clean except this brief, which is untracked. **Don't stage or commit**; the user commits.

**Source:** the `/branch-review` findings on v0.3.0 (#3 unbounded parked holds, #5 whole-file hashing, #6 umask-dependent dir modes, #7 unquoted hint), plus PRD open item F4 (bareguard's `isPrivateIp`, which M3 adopts).

---

## Rules (read first, same as last round)

1. **Prove every behaviour change with a test that goes red on today's code.** Write the test, run it and paste the red `# pass` / `# fail` lines. Fix, run it and paste the green lines. Then apply the item's **mutation** in a scratch copy, show it red, and say you reverted it.
2. **A skipped test did not run.** Your sandbox blocks unix sockets (including abstract ones, `EPERM`) and bwrap netlink. Every test that needs a proxy, `claimRuntime`, `sbx run` or bwrap fails or skips there. Don't "fix" that, and don't add skips. List each test you couldn't run green, with its error; the orchestrator runs them in a real shell.
3. **Step 0, before any edit:** paste the output of
   `node -e "const s=require('net').createServer();s.on('error',e=>{console.log('abstract bind:',e.code);process.exit()});s.listen('\0bb-probe-'+process.pid);console.log('listening sync:',s.listening);setTimeout(()=>s.close(),50)"`
4. **Mutations go in a copy, never the repo:** `mkdir -p /tmp/bb-hmut && cp -r src test package.json barebox.context.md /tmp/bb-hmut/ && ln -s "$PWD/node_modules" /tmp/bb-hmut/node_modules`. Run `node --test --import ./test/setup-env.mjs <file>` inside it, and delete `/tmp/bb-hmut` at the end.
5. **Surgical:** touch only what an item names. Reuse before you add, and name what you reused. No new dependencies in `package.json`. Match each file's style: short JSDoc, sparse comments, default `fs` import.
6. **Doc comments stay with their function.** When you add a function next to a documented one, put it **above** that function's `/** … */` block, never between the block and its function. Two earlier rounds got this wrong.
7. **Never** `git checkout`, `restore`, `stash`, `add` or `commit`. Don't edit `.claude/`.
8. **The brief wins.** If a step is impossible or wrong, stop that item, say why, and go on to the next. List every deviation in the report.
9. Leave no node, bwrap or socat processes running. Kill by pid, never with `pkill -f` on a pattern that could match your own shell.

**Order:** H1 → H5. H1 is must; H2–H4 should; H5 is a spike (no repo code). If credit runs low, stop after a **finished** item. Never leave one half-done.

---

## H1 (must): each agent has at most one request waiting for the human

**Today:** `src/holds.js` `createHolds` has no limit on parked holds. `src/proxy.js` (around `:390-405`) reads each held request's whole body (up to `maxBody`, 1 MB) and calls `queue.add(...)`. Measured: 150 parked 1 MB POSTs took the proxy from 66 MB to 387 MB, against an 80 MB budget. With `timeoutMs: 'never'` they never leave.

**The rule (decided by the user):**
1. **One parked request per agent.** Each agent has at most one request parked and waiting for a decision. That is the only ask the human sees from it.
2. **The agent's next held request waits in a line, unread.** The proxy doesn't read its body until it gets the slot, so it costs a socket, not a megabyte. Requests that aren't held (GET/HEAD, and anything `decide` returns null for) never wait.
3. **When the parked one is decided** (allow, deny, timeout, client gone or close), the next one in that agent's line gets the slot. The proxy then reads its body and parks it.
4. **One clock: the existing deadline (`timeoutMs`, default 120 s) counts from arrival.** A request still in line when its deadline passes is denied `hold timeout` without ever being read. A request that waited 50 s in line and then parks has 70 s left as a parked ask, not a fresh 120 s.
5. **Backstop: at most 16 waiting per agent** (`MAX_WAITING_PER_AGENT = 16`, an internal constant, not an option). The 17th is refused at once with the reason `hold queue full`. That bounds the `timeoutMs: 'never'` case.

**Your part is all in `src/holds.js` and `test/holds.test.mjs`.** No sockets are needed: the queue never touches a socket, it only calls callbacks. The orchestrator wires `src/proxy.js` afterwards (see "Not yours" below).

### API to add to the object `createHolds` returns

```js
/**
 * Ask for this agent's hold slot before reading a held request's body.
 * @param {string} agent
 * @param {{ onReady: () => void, onExpire: (reason: string) => void }} cbs
 * @returns {{ state: 'now'|'queued'|'full', arrivedAt: number, cancel: () => void }}
 */
reserve(agent, { onReady, onExpire })
```

**`reserve` behaviour:**
- **`'now'`:** the agent has no parked hold, no held reservation and nobody in line. The slot is now **held by this reservation** (count it as occupied). The caller reads the body and calls `add({ ..., slot: handle })`. `onReady` is **not** called for `'now'`; the caller goes ahead directly.
- **`'queued'`:** otherwise, if the agent's line has fewer than 16 waiting, the waiter is appended to that agent's FIFO line. Later it gets exactly one of two calls:
  - `onReady()` when the slot passes to it (it now holds the slot, as above);
  - `onExpire('hold timeout')` when its deadline (`arrivedAt + timeoutMs`) passes while it's still in line. Use the same `deadlineMs()` the queue already has; `'never'` means no timer. Unref the timer like the existing hold timer.
- **`'full'`:** the line already has 16. Nothing is queued. Log `{ ev: 'hold-queue-full', agent }`. The caller refuses the request.
- **`arrivedAt`:** `Date.now()` at the call. The caller passes it on to `add`.

**`handle.cancel()`** (idempotent):
- a waiter still in line is removed, and nothing is called;
- a reservation holding the slot but not yet `add`-ed (the body read failed, the body was too large, or the client left) releases the slot, so the next waiter's `onReady` fires;
- after `add` consumed the slot, it does nothing (the parked entry owns the slot now).

**`add(...)` changes:**
- It accepts an optional `slot` (the handle) and `arrivedAt`. With a `slot`, the parked entry takes over that slot. The slot is released when the entry leaves the queue by **any** path: `settle` (allow, deny, timeout or close) or `abandon`. Find every place an entry is deleted from `queue` (`settle`, `abandon`, `close`) and release there. Use **one** small `releaseSlot(agent)` helper that hands the slot to the next waiter, so there is a single writer of slot state (project rule).
- **The deadline counts from `arrivedAt`:** `setTimeout(..., Math.max(0, ms - (Date.now() - arrivedAt)))`. Without `arrivedAt`, use `Date.now()`, so today's callers behave as now.
- **Without a `slot`** (direct callers, existing tests), `add` behaves exactly as today: no slot, no limit. Don't change existing call shapes.
- Add `queued: <n waiting for this agent>` to the existing `hold` log line.

**`close()`:** every waiter in every line gets `onExpire('proxy closing')`, then today's behaviour.

**`pending()`:** unchanged. Waiters aren't asks; they have no id and no ask file.

**JSDoc:** `reserve`, the new `add` fields, and one sentence on the rule in the `createHolds` doc. Update the `@returns` type of `createHolds` so `npm run typecheck` passes.

### Tests (`test/holds.test.mjs`, new `describe('one held request per agent')`)

Use the `onAsk` channel with an `onAsk` that never resolves (no files, no runtime), small `timeoutMs` values, and fake `sock`/`cres` objects. Look at how the existing tests in this file drive `createHolds` and reuse that.

**a. First is now, second queues, decision hands over.**
- A: `reserve('a')` returns `'now'`, then `add({ agent:'a', slot, arrivedAt, ... })`.
- B: `reserve('a')` returns `'queued'`.
- Settle A (use the onAsk resolver, or let A time out with a short timeout).
- B's `onReady` is called **once**.
- **Red today:** `reserve` doesn't exist.

**b. Agents are independent.** `reserve('a')` → `'now'` and `reserve('b')` → `'now'`.

**c. The deadline counts from arrival, in line.**
- `timeoutMs: 200`. A parks; B queues.
- Wait 300 ms: B's `onExpire('hold timeout')` fires, and B's `onReady` never does.

**d. The deadline counts from arrival, after the handover.**
- `timeoutMs: 300`. A parks; B queues at t0.
- A settles at about 200 ms, so B gets `onReady`. B is added with its `arrivedAt`.
- B times out at about 300 ms after t0, not 500 ms. Assert B is denied before 450 ms after t0.

**e. Backstop.** A parks, then 16 `reserve('a')` calls return `'queued'`. The 17th returns `'full'`, and a `hold-queue-full` log line exists.

**f. `cancel()` paths.**
- A cancelled waiter is skipped: it never gets `onReady`, and the next waiter does.
- A `'now'` reservation cancelled before `add` passes the slot to the next waiter.
- `cancel()` called twice does nothing extra.

**g. Abandon and close release.**
- `abandon(id)` of A gives B `onReady`.
- `close()` calls every waiter's `onExpire('proxy closing')`.

**h. Back-compat.** `add` without `slot`, called three times for the same agent, parks all three, as today.

**Mutations** (scratch copy):

| Mutation | Must turn red |
|---|---|
| don't release the slot in `abandon` | g |
| use a fresh deadline in `add`, ignoring `arrivedAt` | d |
| backstop 17 instead of 16 | e |
| `cancel` of a held reservation doesn't release | f |
| don't clear the waiter timer on `onReady` (it would also expire later) | a or d: assert `onExpire` is never called after `onReady` |

## H2 (should): runtime folders are owner-only, whatever the umask

**Today:**
- `src/holds.js:251-252` creates `asks/` and `answers/` with `mkdirSync(..., { recursive: true })`.
- `src/proxy.js:520` creates `socks/` the same way, and `src/runtime.js:173` does the runtime root in `claimRuntime`.
- Under `umask 0` they come out 0777. With an explicit `SBX_RUNTIME` in a shared place, another local user could then write `answers/h1.json` and approve a hold. The default `mkdtemp` runtime is already 0700.

**Fix:** one helper `ensurePrivateDir(dir)` in `src/runtime.js`: `mkdirSync(dir, { recursive: true, mode: 0o700 })`, then `chmodSync(dir, 0o700)`. The `mode` is masked by the umask and doesn't apply to an existing dir, hence the `chmod`. Use it at those four sites. Don't add a second helper.

**Tests:**
- (a) In `test/holds.test.mjs`: under `process.umask(0)` (restore it in `finally`), `createHolds({ runtime: <fresh dir>, ... })` leaves `asks/` and `answers/` at `mode & 0o777 === 0o700`. Also cover a pre-existing `answers/` at 0o777 that ends up 0o700. **Red today.**
- (b) In `test/runtime.test.mjs`: under umask 0, `claimRuntime(<fresh path>)` leaves the root at 0o700. This needs an abstract bind, so it goes on your rule-2 list.
- (c) `socks/`: assert 0o700 after `addAgent` in an existing proxy test that already starts a proxy (rule-2 list).

**Mutation:** drop the `chmodSync` → the pre-existing-dir case goes red.

## H3 (should): hash files in chunks, never whole

**Today:** `src/overlay.js:127`, inside `entryOf`, does `createHash('sha256').update(readFileSync(abs))`, which reads the whole file into memory. A 3 GiB file makes `sbx run --overlay` fail at setup with a raw `ERR_FS_FILE_TOO_LARGE` that names no path.

**Fix:** a small `hashFile(abs)` in `src/overlay.js`, placed above `entryOf`'s doc block (rule 6). It opens the file, reads it with `readSync` into one reused 1 MiB buffer, updates the hash, and closes in `finally`. It stays synchronous: `entryOf` and its callers are sync, and `overlay-walk.js` runs inside bwrap using the same code. Grep for other `update(readFileSync(` hashing in `src/` and route them through the helper. Any error is rethrown with the path in the message (`hash failed for <path>: <reason>`).

**Tests** (`test/overlay.test.mjs`, no bwrap needed):
- (a) For a file of `1 MiB * 2 + 123` bytes of non-repeating content, the hash equals `createHash('sha256').update(fs.readFileSync(f)).digest('hex')`.
- (b) For a 0-byte file, the hash equals the empty-string sha256.
- **Mutation:** read only the first chunk → (a) red.
- Export the helper only if the test needs it, the way `changedSince` is exported. **Red today** only if you export a new name. Otherwise say the proof is the mutation.

## H4 (should): the "answer with" hint is copy-paste safe

**Today:** `src/cli.js:182` prints `answer with: SBX_RUNTIME=${runtime} sbx approve <id>`. A runtime path with a space or a `'` breaks when pasted into a shell.

**Fix:** `export function shellQuote(s)` in `src/runtime.js`, next to `safe()`. It returns `s` unchanged when it matches `/^[A-Za-z0-9_\/.,:@%+=-]+$/`. Otherwise it returns `'` + `s.replace(/'/g, "'\\''")` + `'`. Use it for that one hint. The line still goes through `err()`, so `safe()` keeps stripping control bytes.

**Tests** (`test/runtime.test.mjs`, a plain unit test that needs no socket):
- `/tmp/sbx-a1` comes back unchanged.
- `/tmp/my dir` → `'/tmp/my dir'`.
- `/tmp/it's` → `'/tmp/it'\''s'`.
- Round-trip: `bash -c 'printf %s '"$q"` prints the original for each of these.

**Mutation:** skip the `'` escaping → the round-trip goes red.

## H5 (spike, no repo code): does bareguard's `isPrivateIp` catch what our wall misses?

**Context:** `src/wall.js` `denyReasonForIp` lets these through: `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `64:ff9b::7f00:1`, `2002:7f00:1::`, `0:0:0:0:0:0:0:1`, `::7f00:1`, `::ffff:0a00:0001`. M3 replaces it with bareguard's `isPrivateIp` (PRD:409, open item F4). bareguard is on npm (latest 0.27.0).

**Do:**
1. In `/tmp/bb-spike` (**not** the repo), run `npm init -y && npm i bareguard@0.27.0 --ignore-scripts`. Find how `isPrivateIp` is exported (read its `package.json` `exports` and `src/`).
2. Call it on each address above, plus controls that must be private (`127.0.0.1`, `::1`, `10.0.0.1`, `169.254.169.254`, `fc00::1`, `fe80::1`, `::ffff:127.0.0.1`) and controls that must be public (`8.8.8.8`, `2001:4860:4860::8888`, `2606:4700::1111`).
3. Write a table to **`docs/logs/bareguard-isprivateip-spike.md`**: address · expected · bareguard result · our `denyReasonForIp(addr, false)` result. Include the exact bareguard version and the import line you used.
4. If bareguard misses any form, draft (don't file) an upstream issue at the end of that doc: title, the failing inputs, the expected results, and one sentence on why (DNS answers in those forms reach loopback or the LAN through NAT64 or 6to4). The user files it.
5. Delete `/tmp/bb-spike`. This adds no dependency to barebox.

---

## Not yours: the orchestrator does these afterwards in a real shell

- **H1 wiring in `src/proxy.js`:** for a held request, `creq.pause()` and call `queue.reserve(agent, { onReady, onExpire })` **before** any body listener.
  - `'now'` reads the body as today, then `add({ ..., slot, arrivedAt })`.
  - `'queued'` waits; `onReady` resumes and reads; `onExpire` sends `denyRes(cres, 403, reason)`.
  - `'full'` sends `denyRes(cres, 429, 'hold queue full')`.
  - The client socket closing calls `handle.cancel()`.
  - An over-size body or a body error calls `cancel()` before the deny.
  - Socket tests and the paused-socket close path go with it (this repo has been burned by paused sockets wedging `close()` before).
- `src/run.js:189`: `addAgent` moves inside the try/finally that closes the proxy.
- `src/proxy.js:153`: an `'error'` listener on the log stream, so an unwritable `logFile` is a loud logged failure, not an uncaught crash.
- `sbx pending` showing "N waiting" per agent, if wanted later (needs the line count in a file): an idea, not this round.

## Done when (tick each line in your report with its evidence)

- [ ] Step 0 probe output pasted.
- [ ] H1: tests a–h red today, green after; every mutation in the table red. Pasted.
- [ ] H2–H4 done: red (or mutation-only proof, said so), green, mutation. Or skipped with the reason.
- [ ] H5: `docs/logs/bareguard-isprivateip-spike.md` written with the full table, plus a draft issue if anything is missed.
- [ ] `npm run typecheck` clean. `npm run check:primitives` current; regenerate `primitives.json` if a primitive's `@fails` changed, and say so.
- [ ] `npm test`: totals, and **every** failing or skipped test listed with its error (rule 2).
- [ ] `git status` shows only `src/holds.js`, `src/runtime.js`, `src/proxy.js` (H2 `socks/` line only), `src/overlay.js`, `src/cli.js`, `test/holds.test.mjs`, `test/runtime.test.mjs`, `test/overlay.test.mjs`, maybe `test/proxy.test.mjs` and `primitives.json`, and the two docs: this brief and the spike doc.
- [ ] No processes left; `/tmp/bb-hmut` and `/tmp/bb-spike` removed.

**Report format:** one section per item: what changed (file:line), the red, green and mutation lines, deviations. Then the rule-2 list. Then the Done-when checklist.

**Orchestrator verification after you:**
- the full suite 3× in a real shell (0 fail, 0 skip);
- H1–H4 mutations re-run independently;
- the "Not yours" wiring with socket tests;
- a real stampede: 30 POSTs from one agent in `ask` mode, so one parks, 16 wait, 13 get 429, and proxy RSS stays ≤ 80 MB;
- then `/self-review`.
