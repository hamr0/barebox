# bwrap version brief: the overlay needs bubblewrap ≥ 0.11.0 (2026-10-28)

**Branch:** `m4-undo-layer` at `8dbd738` (release commit v0.3.0, pushed; PR #5 open, CI red). The tree is clean except this brief. Don't stage or commit; the orchestrator commits.

**Why:** CI (ubuntu-24.04) installs bubblewrap **0.9.0** from apt. The M4 overlay passes `--overlay-src` / `--overlay` to bwrap, and those options exist only from bubblewrap **0.11.0** (upstream NEWS: "New `--overlay`, `--tmp-overlay`, `--ro-overlay` and `--overlay-src`", 0.11.0, 2024-10-30). The result is 49/255 failing tests, all overlay or M4, each with `bwrap: Unknown option --overlay-src`. Users on Ubuntu 24.04 LTS would hit the same raw error. This machine has 0.12.0, which is why everything was green locally.

**Decision (user, option A):** require ≥ 0.11.0 for the overlay, fail loudly with an actionable message, build a pinned bubblewrap in CI and publish, and document it. Runs without `--overlay` keep working on any bwrap.

**Rules:** as in earlier briefs.
- Every behaviour change gets a test that fails on today's code first; paste the red and green `# pass` / `# fail` lines.
- Mutations go in a scratch copy, never the repo.
- No test-only code paths in `src/`; reuse before you add.
- Don't touch anything else.
- No processes left running; kill by pid, never `pkill -f` with a pattern that could match your own shell.

---

## Item 1 (must): one version check, both call sites

The overlay reaches bwrap in exactly two places:
- `src/launcher.js:187`: `['--overlay-src', proj, '--overlay', ov.upper, ov.work, proj]`, the run mount.
- `src/overlay.js:399-404`: `spawnSync('bwrap', [... '--overlay-src', lower, '--overlay', upper, work, merged, ...])`, the diff/commit walk.

1. **In `src/overlay.js`** (the overlay owns overlay facts), add:
   - `export function overlaySupportError(versionOutput)`, a pure function. It parses `bubblewrap X.Y.Z` (patch optional) out of the output of `bwrap --version`. It returns `null` when the version is ≥ 0.11.0, and otherwise an `Error` with the message `the overlay needs bubblewrap >= 0.11.0 (found <version or "unknown">): upgrade bubblewrap, or run without --overlay`. Garbage or empty output counts as "unknown", which is an error.
   - `export function assertOverlaySupport()`: runs `spawnSync('bwrap', ['--version'], { encoding: 'utf8' })` **once per process** (cache the result in a module variable) and throws `overlaySupportError(...)` when it is non-null. If bwrap is missing (spawn `error` ENOENT), don't invent a new message: let the existing path fail as it does today, by returning without throwing, and say so in a comment.
2. **Call `assertOverlaySupport()`:**
   - in `launch()` (`src/launcher.js`), only when the overlay is on, **before** any overlay setup or mount, so a refused run leaves no overlay record behind;
   - in `src/overlay.js`, at the top of the function that builds the walk's `spawnSync('bwrap', ...)`, before the spawn.

   `launcher.js` already imports from `./overlay.js`; reuse that import.
3. Short JSDoc on both functions, with `@fails` on `assertOverlaySupport`. Add one line to the `launch` and `diffOverlay`/`commitOverlay` `@fails` (whichever exist) so `primitives.json` learns it. Regenerate `primitives.json` if `npm run check:primitives` says it's stale.

**Tests** (`test/overlay.test.mjs`, in a new `describe('overlay needs bubblewrap >= 0.11.0')`):
- (a) **Unit tests of `overlaySupportError`:** `'bubblewrap 0.9.0\n'` → error matching `/needs bubblewrap >= 0\.11\.0 \(found 0\.9\.0\)/`. `'bubblewrap 0.10.0'` → error. `'bubblewrap 0.11.0'`, `'bubblewrap 0.12.0'`, `'bubblewrap 0.13.2'` and `'bubblewrap 1.0'` → `null`. `''` and `'nope'` → error with `found unknown`. Red today, because the export doesn't exist yet.
- (b) **Both call sites, through a fake bwrap:** write a `bwrap` shell script into a temp bin dir that prints `bubblewrap 0.9.0` for `--version` and exits 1 otherwise. In a **child process** with `PATH=<fakebin>:<PATH>` (the cache is per process), call (i) `launch({... overlay: true ...})` and (ii) `diffOverlay(...)` on a runtime with a non-empty upper. Each must throw the "needs bubblewrap >= 0.11.0" message. For (i), also assert that no `<runtime>/overlay/<agent>` dir was created. Reuse the fake-bin pattern already used in `test/launcher.test.mjs` (around `:94`/`:220`); don't invent a second one. Today (i) and (ii) fail with something else (the fake's exit 1, or no throw), so the test is red.
- (c) **A run without the overlay is unaffected:** in the same child, with the same fake 0.9.0 bwrap, `launch({ overlay: false ... })` must **not** throw the version error. It may fail later because the fake can't sandbox, which is fine: assert only that the message doesn't match `/needs bubblewrap/`.

**Mutations** (scratch copy):
- drop the `launch()` call → (b)(i) red;
- drop the walk call → (b)(ii) red;
- change the threshold to 0.9.0 → (a) red;
- call `assertOverlaySupport()` unconditionally in `launch` → (c) red.

## Item 2 (must): CI and publish build a pinned bubblewrap

In **both** `.github/workflows/ci.yml` and `.github/workflows/publish.yml`, replace the apt `bubblewrap` with a pinned source build, keeping `socat curl openssl` from apt and the existing `sysctl` line. The two workflows must stay identical in their runner deps (PRD:157 lesson). The step:

```yaml
      - name: Install sandbox runner deps (bubblewrap 0.12.0 from source; apt's 0.9.0 lacks --overlay-src)
        run: |
          sudo apt-get install -y socat curl openssl meson ninja-build libcap-dev pkg-config
          curl -sSfL -o /tmp/bwrap.tar.xz https://github.com/containers/bubblewrap/releases/download/v0.12.0/bubblewrap-0.12.0.tar.xz
          echo "9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314  /tmp/bwrap.tar.xz" | sha256sum -c -
          tar -xJf /tmp/bwrap.tar.xz -C /tmp
          meson setup /tmp/bwrap-build /tmp/bubblewrap-0.12.0 --prefix=/usr/local -Dman=disabled -Dtests=false -Dselinux=disabled -Dbash_completion=disabled -Dzsh_completion=disabled
          ninja -C /tmp/bwrap-build
          sudo ninja -C /tmp/bwrap-build install
          bwrap --version
```

Adapt it to each file's existing step shape: `ci.yml` uses bare `- run:` lines, `publish.yml` uses a named step with `sudo sysctl` inside it. Keep the sysctl in both. The sha256 was computed by the orchestrator from the official release asset. If `meson setup` rejects an option name, the 0.12.0 `meson_options.txt` defines `man`, `tests`, `selinux`, `bash_completion` and `zsh_completion`. You can't run CI; the orchestrator does.

## Item 3 (must): document the requirement

- **`README.md`:** wherever requirements or install are stated, add "bubblewrap ≥ 0.11.0 for `--overlay` / `sbx diff|commit|rollback` (Ubuntu 24.04 ships 0.9.0: build from source or use a newer distro); plain runs work with older bwrap."
- **`barebox.context.md`** (it ships in the tarball; **don't move it**): the same fact, one line in Gotchas or the undo-layer section.
- **`CHANGELOG.md` `## [0.3.0]`:** append to the M4 undo-layer bullet: "Needs bubblewrap ≥ 0.11.0; older bwrap gets a clear refusal." **Don't** add a new heading, and don't touch other entries.
- After editing, run `node --test --import ./test/setup-env.mjs test/context-doc.test.mjs`; it must stay green.

## Done when

- [ ] Items 1–3 done. Item 1's red, green and mutation lines are pasted.
- [ ] `npm run typecheck` is clean and `npm run check:primitives` is current (regenerated if needed, and say so).
- [ ] The full `npm test` passes with 0 fail and 0 skipped. Paste the totals: this shell has bwrap 0.12.0, so the real-bwrap overlay tests must stay green.
- [ ] `git status` shows only `src/overlay.js`, `src/launcher.js`, `test/overlay.test.mjs`, the two workflows, `README.md`, `barebox.context.md`, `CHANGELOG.md`, maybe `primitives.json`, and this brief untracked.

**Orchestrator after you:**
- re-run the mutations;
- a real check with a fake 0.9.0 `bwrap` on PATH: `sbx run --overlay -- true` refuses with the message, and `sbx run -- true` doesn't hit the version check;
- commit, then push;
- CI must be green (this is the real test of item 2);
- `/branch-review` re-review of the new range, then merge, tag and publish.
