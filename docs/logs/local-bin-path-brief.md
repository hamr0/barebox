# Brief: `~/.local/bin` on the inside PATH

Branch `m6`. Finding (PRD M6, "Findings from the real-agent run"): `sbx run -- claude` exits 127
`claude: not found`. Claude Code's native installer puts `claude` in `~/.local/bin` (a symlink
into `~/.local/share/claude/versions/<v>`), both under `$HOME`, which the sandbox already binds
read-only. The inside `PATH` is built at `src/launcher.js:295` from `SYSTEM_PATH`
(`src/launcher.js:50`) plus the bound Node's `bin` first. User decision (Nov 2): add
`~/.local/bin`.

## Change (`src/launcher.js`)

- When `$HOME/.local/bin` exists on the host (`home` as `launch()` computes it), append it to the
  inside `PATH` **after** the system dirs: `[nodeBin?, ...SYSTEM_PATH, `${home}/.local/bin`?]`.
  After, so a file there never shadows a system tool of the same name.
- One place builds the PATH (one writer): keep it a single expression or a small local helper in
  `launch()`, not a second assignment.
- No new exposure: the dir is already visible through the read-only `$HOME` bind; nothing is
  bound. Say so in one comment line.
- Docs: the `launch()` JSDoc where it describes the inside PATH (if it does), `barebox.context.md`
  where the inside `PATH` is described (grep `PATH`), CHANGELOG `[Unreleased]` one line under
  the right heading (create `## [Unreleased]` above `## [0.7.0]` if missing). If any JSDoc
  changes, run `npm run build:primitives` and include `primitives.json`.

## Tests (`test/launcher.test.mjs`), each red then green

- **T1 (args level, existing `argsFor` / `pathOf` helpers near line 282):** with a temp HOME
  that has `.local/bin`, the PATH value ends with `<home>/.local/bin` and starts with the system
  dirs (or nodeBin then system dirs); without `.local/bin`, PATH is unchanged from today.
- **T2 (real launch, bwrap):** a temp HOME with `.local/bin/hello` (an executable `sh` script
  printing a marker); inside, `sh -c 'hello'` prints the marker and exits 0. Follow the file's
  existing real-launch tests for HOME handling and short socket paths.
- Red proof in a scratch copy (never the repo tree) with `src/launcher.js` at HEAD.

## Constraints

- Shared machine: single test files only, one at a time; `cat /proc/loadavg` < 15 before each
  bwrap-heavy run. No full suite, no bench (the orchestrator runs those).
- Run `npm run typecheck`, `npm run build:types`, `npm run check:primitives`; report exit codes
  (bare command, no pipe).
- Don't commit.

## Report

Diff stat; T1/T2 red then green; `test/launcher.test.mjs` totals (0 skipped); the three CI
exit codes.

## How the orchestrator verifies

`sbx run -- claude -p ...` exits 0 with a real answer (no absolute path); the red re-run; the
full suite 3x; then commit.
