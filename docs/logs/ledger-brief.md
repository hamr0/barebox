# Ledger brief: knock down what still holds (2026-10-28)

**For:** the build agent. **Branch:** `m4-undo-layer` at `640de2c`; the tree is clean except this brief (uncommitted). Don't stage or commit; the user commits.

**Source:** `.claude/remember/fix-ledger.md` (73 entries), re-checked against `640de2c`. 50 are fixed and 7 are moot (the code is gone); those are pruned after this round, so don't touch them. 16 still hold:
- **9 are in this brief.**
- **7 are left out on purpose:** #1 IPv6 literal CONNECT (a feature); #10/#11 (M3 replaces `denyReasonForIp` with bareguard's `isPrivateIp`, PRD:409 and F4); #12, #56, #70, #71 (design decisions for the owner); #51 and #69 (low value, need an injected race).

---

## Rules (read first)

1. **Prove every behaviour change with a test that goes red on today's code.** Order: write the test, run it and paste the red `# pass` / `# fail` lines, make the fix, run it and paste the green lines. Then apply the **mutation** listed for the item (in a scratch copy, see 4), show it red, and say you reverted it.
2. **A skipped test did not run.** Your sandbox may block unix sockets, abstract ones included. That makes `claimRuntime` (and so every proxy, run and CLI test that starts a proxy) fail or skip there. Don't "fix" that and don't add skips. List each test you could not run green in your sandbox, with its error; the orchestrator runs them in a real shell.
3. **Step 0, before any edit:** run the probe below and paste its output. It tells both of us what your sandbox can prove.
   ```
   node -e "const s=require('net').createServer();s.on('error',e=>{console.log('abstract bind:',e.code);process.exit()});s.listen('\0bb-probe-'+process.pid);console.log('listening sync:',s.listening);setTimeout(()=>s.close(),50)"
   ```
4. **Mutations go in a copy, never the repo:** `mkdir -p /tmp/bb-lmut && cp -r src test package.json barebox.context.md /tmp/bb-lmut/ && ln -s "$PWD/node_modules" /tmp/bb-lmut/node_modules`, edit there, then run `node --test --import ./test/setup-env.mjs <file>` from inside it. Delete `/tmp/bb-lmut` at the end.
5. **Surgical:** touch only the lines an item names. Reuse before you add: name what you reused. No new dependencies. Match the file's style (short JSDoc, sparse comments, default `fs` import).
6. **Never** `git checkout`, `git restore`, `git stash`, `git add` or `git commit`. Don't edit `.claude/`.
7. **The brief wins.** If a step is impossible or wrong, stop that item, say why, and go on to the next. List every deviation in the report.
8. Leave no node, bwrap or socat processes running.

**Order:** items 1 → 9. Items 1–4 are must; 5–6 should; 7–9 are nice to have. If your credit runs low, stop after a finished item. Never leave one half-done; a half-done item is worse than none.

---

## Item 1 (must): `release()` runs once (ledger #66)

**Bug:** `src/runtime.js:148`, the `release` closure returned by `claimRuntime`. Its guard `pidOf(owner) === process.pid` can't tell two claims from the same process apart. Reproduced:
```
const r1 = claimRuntime(rt); r1(); const r2 = claimRuntime(rt); r1();
// owner file is GONE while r2 still holds the lock
```
`src/proxy.js` calls its release from four places (`:159`, `:325`, `:514` `ready.catch`, `:561`). A failed `ready`, then a retry on the same runtime, then the old proxy's `close()` hits this.

**Test** (`test/runtime.test.mjs`, in `claimRuntime: one live proxy per runtime`): "a stale release never removes a newer claim from this process". Do r1 = claim, r1(), r2 = claim, r1(). Assert the owner file still exists and `JSON.parse(...).pid === process.pid`, then r2(). It must be **red** today.

**Fix:** a `let released = false;` in `claimRuntime`. The closure returns at once if it's set, otherwise sets it and does what it does today. Keep the JSDoc "idempotent" and add "per claim".

**Mutation:** remove the early return → red.

## Item 2 (must): a failed bind isn't always "in use" (ledger #68)

**Bug:** `src/runtime.js:135`, `throw inUseError(runtime, pidOf(owner));`. Every failed bind becomes "in use by pid …", because the async `'error'` (with its code) arrives after we throw. Two cases tell the user to change `SBX_RUNTIME`, which can't help: EMFILE at the fd limit, and a sandbox or LSM that blocks unix sockets. The same happens with "pid unknown" when no live owner is recorded.

**Fix** (same function, no new module):
- On `!server.listening`, read `pid = pidOf(owner)`.
- If `pid` is a number and that process is alive, throw `inUseError(runtime, pid)` as today. Alive means `process.kill(pid, 0)` doesn't throw, or throws `EPERM`.
- Otherwise throw `new Error(`runtime ${runtime} could not be locked: no live owner is recorded (another proxy may be starting, or this process cannot bind unix sockets)`)`.
- One helper for "is pid alive" is fine. Put it next to `pidOf`.

**Tests:**
- (a) "a bind that fails with no live owner is not reported as in use". Temporarily replace `net.Server.prototype.listen` with a no-op (restore it in `finally`), so `server.listening` stays false. Then `assert.throws(() => claimRuntime(rt), /could not be locked/)`, and assert the message doesn't match `/in use/`. **Red** today.
- (b) The existing "a second names our pid" test must stay green, since a live owner is still "in use by pid N".
- (c) The stampede test, "8 processes …": a loser may now get either message, because the winner binds before it writes the owner file. Accept exactly these two messages, keep counting anything else as a failure, and keep `won === 1`. Don't loosen it in any other way.

**Mutation:** always throw `inUseError` → (a) red.

## Item 3 (must): `sbx pending` / `approve` / `deny` need a live proxy (ledger #57)

**Bug:** `src/cli.js:286` (`pending`) and `answerTarget` (`src/cli.js` around `:320-340`) never check for a live proxy. After `kill -9` of `sbx run`, `sbx pending` still lists the dead queue's `h1`, and `sbx approve h1` prints `approved h1` for an answer nobody will read. The next proxy clears it as stale.

**Fix:**
1. **`src/runtime.js`:** move the lock-name computation out of `claimRuntime` into one function, `lockName(runtime)` (realpath, stat, the same hash). `claimRuntime` calls it. Don't compute the name in two places.
2. **`src/runtime.js`:** add `export function runtimeLive(runtime)` that returns `Promise<boolean>`. `net.connect(lockName(runtime))` resolves `true` on `'connect'` (then destroy the socket) and `false` on `'error'`. A runtime that doesn't exist, where `lockName` throws ENOENT, is `false`. It must never bind; binding would steal the claim from a proxy that's starting.
3. **`src/cli.js` `pending`:** after reading the asks, if there are none, print `nothing held` and exit 0 as today, live proxy or not. If there are asks and `!(await runtimeLive(runtime))`, `err(`no live proxy on ${runtime}: ${n} stale ask(s) can't be decided (cleared at the next start)`)` and exit 1.
4. **`src/cli.js` `answerTarget`** (used by approve and deny): after the id and ask-file checks, if `!(await runtimeLive(runtime))`, `err(`no live proxy on ${runtime}: nothing reads answers`)` and exit 1. **Write nothing.** `answerTarget` becomes async; await it in `approve` and `deny`.
5. **CHANGELOG `[Unreleased]`:** fold one line into the existing file-ask-channel entry under **Added**, not Fixed (this code is unreleased): "`sbx pending` / `approve` / `deny` refuse when no live proxy owns the runtime."

**Tests** (`test/cli.test.mjs`; the file has binary bytes, so use `grep -a`):
- (a) New: plant `asks/h1.json` in a runtime with no proxy. `sbx pending` exits 1 with `no live proxy` on stderr. `sbx approve h1` exits 1 with `no live proxy`, and `answers/h1.json` doesn't exist. **Red** today (pending exits 0, approve writes the answer).
- (b) The tests around `:92-160` (`sbx approve/deny id validation + pending sanitizing`) plant ask files with no proxy and expect them listed. Give them a live owner: call `claimRuntime(rt)` in the test process before the CLI runs, and release it in `finally`. The id-validation tests (exit 2) must still exit 2 before any liveness check. Keep that order: validate the id first.
- (c) `:65` "pending on an empty runtime prints nothing held (exit 0)" stays as it is and stays green.
- (d) The live tests (`sbx cli over the file channel`, around `:170+`) stay green unchanged.
- Run all of `test/cli.test.mjs`. Every test that needs bwrap or sockets and won't run in your sandbox goes on your list (rule 2).

**Mutations:** make `runtimeLive` always return `true` → (a) red. Move the liveness check before the id check → the exit-2 tests go red.

## Item 4 (must): pin the lock's identity and the owner mode (ledger #67)

**Gap:** `src/runtime.js:127`. The JSDoc claims "a recreated dir gets a new lock", but removing dev and inode from the name leaves every test green. The owner file's `0600` mode isn't tested either.

**Tests** (`test/runtime.test.mjs`):
- (a) "a recreated dir at the same path gets its own lock". `claimRuntime(p)` and hold it (r1). `renameSync(p, p + '.old')`, `mkdirSync(p)`. Now `claimRuntime(p)` must **succeed** (r2): new inode, new lock. Release both. This is green today; it guards the dev and inode part.
- (b) "the owner file is 0600": after a claim, `statSync(owner).mode & 0o777` equals `0o600`. Green today.

**Mutations:** drop `\0${st.dev}\0${st.ino}` from the hash → (a) red. Write the owner with `0o644` → (b) red. These mutations are the proof here, since there's no code change.

## Item 5 (should): docs say what shipped

1. **`README.md:102`, the M4 row**, says "IN PROGRESS … full bwrap+unix proof pending". It's built and was proven in a real shell (the suite 3× green, 0 skipped). Change the status cell to match the style of the other rows' finished status. Check the M2.5 row the same way.
2. **`docs/product/agent-sandbox-prd.md:377`** says "An `ASK OPEN <id>` line goes to stderr". The library no longer prints it (`CHANGELOG.md:30`). Replace it with what's true: read how `sbx run` reports an ask (`emitAsk` in `src/cli.js`) and describe that in one line.
3. **`docs/product/agent-sandbox-prd.md:379`** says "a redacted body preview". Make it "a body preview (redaction lands in M3, see item 6)".

No tests. Run `node --test --import ./test/setup-env.mjs test/context-doc.test.mjs` if you touched any shipped doc; it must stay green.

## Item 6 (should): drop the unread `kind` (ledger #60)

`src/launcher.js:22-…`: every `LOCKED_PATHS` entry carries `kind`, and nothing reads it. The use site destructures only `path`, and the mask is picked from the real kind on disk.
- Make `LOCKED_PATHS` an array of strings and update the loop that reads it. Grep `LOCKED_PATHS` repo-wide (tests too) and update every reader.
- Delete the comment sentence "`kind` documents intent."
- No behaviour change, so no new test. `test/launcher.test.mjs` must stay green; it may need sockets (rule 2).

## Item 7 (nice): honest test title (ledger #72)

`test/runtime.test.mjs:174`: rename `'the refusal is synchronous and leaks no handle: the process exits by itself'` to `'the refusal is synchronous and the process still exits by itself'`. Change its timeout message from "the refused lock leaked a handle" to "the refusing process hung". No other change.

## Item 8 (nice): one way to spawn a child (ledger #73)

`test/runtime.test.mjs:151`: the SIGKILL test repeats `runChild`'s spawn arguments. Extract `spawnChild(body, args)` that returns the `ChildProcess` (the shared spawn call). `runChild` uses it, and so does the SIGKILL test. Behaviour is identical: the whole file stays green with the same test count.

## Item 9 (nice): no stale "pid unknown" wording in tests

After item 2, grep `test/` for `pid unknown` or `(\d+|unknown)` patterns written for the old message. Update them to the two exact messages. If there are none, say so.

---

## Done when (tick each line in your report with its evidence)

- [ ] Step 0 probe output pasted.
- [ ] Items 1–4: red today, green after the fix, mutation red. All three pasted per item, or the item is on the rule-2 list with the error.
- [ ] Items 5–9 done, or skipped with the reason.
- [ ] `npm run typecheck` clean. `npm run check:primitives` current (if `runtimeLive` or `lockName` reach `index.js` exports it must be regenerated; they shouldn't, so keep them out of `index.js`).
- [ ] `npm test`: totals pasted, and **every** failing or skipped test listed with its error (rule 2).
- [ ] `git status` shows only the files the items name, plus this brief untracked.
- [ ] No processes left, and `/tmp/bb-lmut` removed.

**Report format:** one section per item: what changed (file:line), the red, green and mutation lines, deviations. Then the rule-2 list. Then the Done-when checklist.

**Orchestrator verification after you:**
- the full suite 3× in a real shell (0 fail, 0 skip);
- items 1–4 mutations re-run independently;
- a real `kill -9` of `sbx run`, then `sbx pending` / `sbx approve h1` → exit 1 "no live proxy" and no answer file;
- typecheck and primitives;
- then `/self-review`.
