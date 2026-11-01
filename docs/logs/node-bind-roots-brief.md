# Brief: the node bind must not expose the runtime or shadow the project

Branch `chore/fix-ledger`, base `aef95e6`. Found by `/branch-review` (ledger bullet
`src/launcher.js · "...(nodeBind ? ['--ro-bind', nodeBind, nodeBind] : []),"`).
Orchestrator reproduced both cases with real bwrap on 2026-11-01. Repro script:
`/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/79fd0aea-5f80-4a55-a825-eb9d436d5797/scratchpad/hn/run.mjs`.

## The two holes (both reproduced)

`hostNode` (src/runtime.js) binds the host's node install `B` read-only when it sits
outside `/usr`, `$HOME` and the project. `src/launcher.js` then:

1. **Runtime under `B` leaks.** With node at `B/bin/node` and runtime `B/rt`, the agent
   ran `ls B/rt/socks; cat B/rt/asks/h1.json` and got `a.sock` and the ask's content.
   The runtime mask (the block after the locked drawers) only masks a runtime that
   shows through `home` or `proj`; `nodeBind` is not in its list. A read-only bind
   does not stop `connect(2)` to the other agents' sockets. Breaks the hard rule:
   the agent never reaches `asks/`, `answers/` or `socks/`.
2. **Project under `B` is shadowed.** With the project at `B/proj` and `--overlay`,
   `echo new > f` inside failed with `Read-only file system`: the `--ro-bind B B` is
   pushed after the project's overlay mount, and in bwrap the later mount wins.

## The fix (one owner: the `roots` list)

`roots` in `launch()` already lists every host path the sandbox binds
(`[home, proj, '/etc', '/usr', nodeBind?]`) and drives the locked-drawer masks. Make it
drive the runtime mask too, and fix the bind order. No change to `hostNode`, the CLI,
or the overlay walker.

1. **Bind order.** Move `...(nodeBind ? ['--ro-bind', nodeBind, nodeBind] : [])` from
   after the project mount to right after `'--ro-bind', '/etc', '/etc'` (before
   `$HOME`). `nodeBind` never contains `$HOME` (refused) and is never inside `$HOME`,
   `/usr` or the project (then it isn't bound), so the only overlap is a project or
   runtime *inside* it, and those must win. Update the bind-order comment block.
2. **Runtime mask over every root.** In the runtime-mask block, replace the two-entry
   `[[realHm, hm], [realPr, pr]]` with one entry per element of `roots` (real path +
   the spelling bwrap sees, i.e. `join(r)`), so a runtime under `nodeBind` (or `/etc`,
   `/usr`) gets the same `--tmpfs` mask. Keep the `args.includes(m)` dedupe.
3. **Runtime equal to a root throws.** Extend the existing "runtime must not be HOME /
   the project dir itself" check to every root: a runtime that IS `nodeBind` cannot be
   masked without hiding node. Message names the root, e.g.
   `launch: runtime must not be the Node install dir itself (its sockets cannot be hidden there)`.
   Keep the existing HOME / project wording unchanged (tests may match it).
4. Docs: the `@fails` and `opts.nodeExec` JSDoc on `launch`; `barebox.context.md` where the
   node bind and runtime masking are described (around line 327 — grep `Node`);
   CHANGELOG `[Unreleased]` one line under the existing host-node entry (describe what
   ships, not "fixed").

## Required tests (each shown red, then green)

In `test/launcher.test.mjs`, real launches with real bwrap (follow the file's existing
real-launch Node-prefix test for helpers). Socket paths cap at 107 bytes: put `B` at a
short `mkdtempSync('/tmp/sbx-nb-')`-style path, not under the scratchpad.

- **T1 runtime under the node install is masked:** node at `B/bin/node` (symlink to the
  real node is fine), runtime `B/rt` with a file in `asks/` and an entry in `socks/`;
  inside, listing `B/rt/asks` and `B/rt/socks` shows nothing and reading the ask file fails.
  Assert on the exact output, not just exit code.
- **T2 a project under the node install keeps its overlay:** project `B/proj` (git repo,
  committed file `f`), `--overlay` on; inside `echo new > f && cat f` prints `new`, exit 0,
  and the host's `B/proj/f` is still the original.
- **T3 runtime equal to the node install throws** (args level is fine): `nodeExec` at
  `B/node` (flat layout → install dir `B`), `runtime: B` → throws with the message above.
- Existing ordering assertions (e.g. the "bound read-only, before the masks" test near
  line 284) may need updating for the new position; if so, say which and why — the new
  order is the point of this fix, so updating that assertion is expected, not a red flag.

Red proof: in a scratch copy (never the repo tree), with `src/launcher.js` at `aef95e6`,
T1 and T2 must fail on an assertion (not a load error). T3 must fail with "did not throw".
Show the failing output for each.

## Constraints

- Single test files only, one at a time: `env -u NODE_USE_ENV_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u FTP_PROXY -u http_proxy -u https_proxy -u all_proxy -u ftp_proxy node --test --import ./test/setup-env.mjs test/launcher.test.mjs`
  (and `test/cli.test.mjs`, `test/m5.test.mjs` once each after the change). No full
  suite, no bench: the orchestrator runs those (peer sessions share the machine).
- 0 skipped. A skip is not a pass.
- Do not commit. Report the diff summary, each test's red then green output, and the
  single-file totals.

## How the orchestrator verifies

1. Re-run the repro script against the fixed tree: runtime case shows nothing, overlay
   case prints `new`.
2. Read the diff: only `src/launcher.js`, `test/launcher.test.mjs`, `barebox.context.md`,
   `CHANGELOG.md`.
3. Re-run one red in a scratch copy.
4. Full suite 3x (when the machine is free, load < 15, peers told): 0 fail, 0 skip.
5. Then commit, `/self-review`, push.
