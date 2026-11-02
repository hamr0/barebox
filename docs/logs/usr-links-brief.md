# Brief: /bin, /sbin, /lib inside the sandbox (mirror the host's top-level links)

Branch `m6`, on top of the uncommitted `~/.local/bin` PATH change (keep it). User decision
(Nov 2): fix now, before Demo B.

## The bug (verified by the orchestrator on Fedora 44, merged /usr)

Host: `/bin -> usr/bin`, `/sbin -> usr/sbin`, `/lib -> usr/lib`, `/lib64 -> usr/lib64`. The
sandbox binds `/usr` and recreates only `--symlink usr/lib64 /lib64` (`src/launcher.js:212`;
the same hard-coded pair in the overlay walker, `src/overlay.js:493`, and asserted in
`test/overlay.test.mjs:96`). Inside: `ls /bin /sbin /lib` → No such file; `/bin/sh -c ...` →
not found; `node -e "require('child_process').exec('echo x', ...)"` → `spawn /bin/sh ENOENT`.
So every `#!/bin/sh` / `#!/bin/bash` script and Node's `exec` fail inside barebox on any
merged-/usr distro. Tests never caught it: they call `sh` via PATH (`/usr/bin/sh`).

## The fix — one owner

1. A helper in `src/runtime.js` (beside `hostNode`), e.g. `usrLinks()`, that looks at the host's
   `/bin`, `/sbin`, `/lib`, `/lib64` with `lstat` and returns bwrap args:
   - a symlink → `--symlink <its readlink target> <path>` (exactly as the host has it, e.g.
     `usr/bin`);
   - a real directory (non-merged distros) → `--ro-bind <path> <path>`;
   - missing → nothing.
   Also return which real directories it bound, so `launch()` can add them to `roots` (every
   path the sandbox binds; it drives the masks).
2. `src/launcher.js`: replace `'--symlink', 'usr/lib64', '/lib64'` with the helper's args (same
   position, right after `/usr`); add bound real dirs to `roots`.
3. `src/overlay.js`: the walker's mount list uses the same helper instead of its hard-coded pair
   (the walker is trusted code but runs node and may exec; keep its mount-order comment true).
4. JSDoc on the helper (`@returns`), and if `launch()`'s JSDoc describes what the sandbox sees,
   add `/bin`, `/sbin`, `/lib`. Then `npm run build:primitives` if any exported JSDoc changed.
5. Docs: `barebox.context.md` where it says what the sandbox sees (grep "sees `/usr`"), one line;
   CHANGELOG `[Unreleased]` under `### Fixed`: `#!/bin/sh` scripts and Node's `exec` failed
   inside the sandbox on merged-/usr hosts (this shipped in 0.7.0 and earlier, so Fixed is right).

## Tests, each red then green

- **T1 real launch (`test/launcher.test.mjs`, bwrap):** inside, `/bin/sh -c 'echo bin-sh-ok'`
  prints `bin-sh-ok`, exit 0; and `node -e` with `child_process.exec('echo exec-ok')` prints
  `exec-ok` (proves the Node path the bug report names). Skip-proof: assert the exact output.
- **T2 a `#!/bin/sh` script in the project runs** (real launch): write `run.sh` with a
  `#!/bin/sh` shebang, chmod +x, run `./run.sh` inside → its marker, exit 0.
- **T3 unit (`hostNode`-style, no bwrap):** the helper's output for this host matches `lstat`
  of each path (symlink → `--symlink` with `readlinkSync` target; dir → `--ro-bind`). If you can
  inject a fake root cheaply, also cover the real-dir and missing cases; if not, say so.
- Update `test/overlay.test.mjs:96` to the helper's output (that test pins the old pair) — state
  why in the report.
- Red proof in a scratch copy (never the repo tree) with `src/launcher.js`, `src/overlay.js`,
  `src/runtime.js` at HEAD.

## Constraints

Shared machine: single test files, one at a time, `cat /proc/loadavg` < 15 before bwrap-heavy
runs; no full suite, no bench. Run `npm run typecheck`, `npm run build:types`,
`npm run check:primitives` (bare commands). Don't commit.

## Report

Diff stat; T1-T3 red then green; totals for `test/launcher.test.mjs`, `test/overlay.test.mjs`
(0 skipped); the three CI exit codes.

## How the orchestrator verifies

Inside `sbx run`: `/bin/sh`, `node exec` and a `#!/bin/bash` script work; the red re-run; full
suite 3x; then one commit with the `~/.local/bin` change.
