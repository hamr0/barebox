# Hardening round 3: the R3 test proves the right thing, two nits (2026-10-28)

**For:** the build agent. **Branch:** `hardening`, on top of rounds 1–2 (uncommitted; leave it
so). **Don't stage or commit.** Same nine rules as `docs/logs/hardening-brief.md`.

**Why:** the orchestrator verified round 2 in a real shell: the suite at 275/276 (3/3 runs, 0
skip), R1 and R4 red under mutation, green after. One problem, and it's the round-2 brief's fault,
not yours:

- The R3 test (`test/run.test.mjs:151`) fails in a real shell. It asserts `/ENOTDIR/`, but
  `mkdirSync(dir, { recursive: true })` on an existing plain file throws **`EEXIST`**
  (`REJECTED:EEXIST: file already exists, mkdir '…/rt/socks'`).
- Worse, it can't go red. `addAgent` throws **before** any listener exists, so nothing holds the
  event loop and the child exits whether or not `proxy.close()` runs. With `addAgent` moved back
  outside the `try`, the test still passes. The brief's "the process hangs" premise was wrong.
- The real damage is a **leaked runtime claim in-process**. The orchestrator's probe: after `run()`
  rejects, `claimRuntime(rt)` on the same runtime gives `RECLAIM OK` with the fix, and
  `runtime … is in use by pid …` with `addAgent` back outside the `try`. So a host calling `run()`
  twice on one runtime is locked out until it restarts.

## T1 (must): rewrite the R3 test to assert the claim is released

Replace the round-2 test at `test/run.test.mjs:151` (drop the child process; it isn't needed):

- Make `proj` and `rt` in a tmp root, and plant the socket folder as a plain file:
  `writeFileSync(dirname(runtimePaths(rt).socket('a')), 'x')`.
- `await assert.rejects(run({ proj, command: ['true'], runtime: rt, agent: 'a' }), /EEXIST/)`.
- Then `const release = claimRuntime(rt); release();` must **not** throw.
- `rmSync` the root in `finally`.

Rename it to `'a throwing addAgent rejects AND releases the runtime'`. Move it out of the
`describe` at `:101` if it no longer fits that describe's "the process exits" comment; your call,
say which.

Your sandbox can't run it (runtime lock): rule-2 list. The orchestrator runs red (with
`sock = proxy.addAgent(agent)` moved back above the `try`) and green.

## T2 (should): two nits in `src/proxy.js`, no behaviour change

1. The comment above `fs.chmodSync(logFile, 0o600)` still says "A not-yet-created file throws here
   and is created 0600 by the stream." `openSync` creates it now. Reword it to say `openSync`'s
   mode is masked by the umask and doesn't apply to an existing file, hence the `chmod`.
2. `fs.createWriteStream(/** cast */ (null), { fd: logFd })`: pass `logFile` instead of the
   double-cast `null` (Node ignores the path when `fd` is given) and drop the cast and its comment.
   `npm run typecheck` must stay clean.

## Done when

- [ ] T1: the test rewritten as above (file:line); on the rule-2 list with its error.
- [ ] T2: both edits (file:line); typecheck clean.
- [ ] `npm test` totals, with every failing or skipped test listed with its error.
- [ ] `git status`: the same files as round 2, plus this brief. Nothing else.

**Report format:** a short section per item, then the rule-2 list, then this checklist.
