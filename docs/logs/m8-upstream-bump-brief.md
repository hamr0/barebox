# M8 brief: upstream bump, bareguard 0.34.0 and rwxmap 0.11.1 (2026-11-10)

Branch: `m8-upstream-bump`. Worker: code-developer (Sonnet). Orchestrator verifies.

## What the changelogs and the published code say (checked Nov 10, real shell)

Both tarballs were downloaded with `npm pack` and diffed against the current pins.

**bareguard 0.30.0 → 0.34.0.** Only `src/primitives/rubric.js` and `src/primitives/rubric-locate.js` differ. `Gate` and everything barebox imports is byte-identical. Changes are new rubric rules (`listItems`, `jsonValid`, `carriesNone`, `maxParagraphs`, `maxLineWords`, `cited` `any`/`edges`, `in`/`notIn` `ignoreCase`). barebox uses no rubric. Dependencies unchanged (`proper-lockfile`).
- 0.34.1 exists in the bareguard repo (rubric `cells` tightening, JSDoc only otherwise) but is **not on npm** as of Nov 10. Pin 0.34.0 as the PRD says; 0.34.1 is a no-op for barebox.

**rwxmap 0.8.0 → 0.11.1.** `src/matcher.js`, `src/match.js`, `src/key.js` and `gateEntriesFromRows` are byte-identical. What changed:
- Mechanical v4 classifier (`flow.js`, `step1-3.js`). The matcher calls it only for an unmatched request (`source: 'request'`), and barebox's `toolFor` (`src/policy.js:101-107`) uses only the key from that result, never its letter. No runtime letter changes in barebox.
- QUERY rows can now appear in label files built from OpenAPI 3.2 specs. Not a runtime change in barebox.
- The CLI's summary line `Jev: off (mechanical)` became `rwxlite: off (mechanical) — <reason>` (0.10.0). This **breaks** two places that grep for `Jev: off`.
- The gate file gains a top-level `rwxlite` block and `rwxmapVersion: "0.11.1"`. Rows of `test/fixtures/jira-mini.json` are identical between 0.8.0 and 0.11.1 (r 1, w 1, x 2).
- `--engine mechanical` (0.10.0) never imports rwxlite and never fetches a model. Without it, a machine with rwxlite installed would download a ~91 MB model during tests.
- Dependencies unchanged (`yaml ^2.5.1`).

Real-shell result with the new pins in a scratch copy: `test/labels.test.mjs` fails 3 of 3 suites on `/Jev: off/`; `test/primitives-completeness.test.mjs` passes; `npm run typecheck` and `npm run check:primitives` pass.

## Steps

1. `package.json`: `"bareguard": "0.34.0"`, `"rwxmap": "0.11.1"`, exact (no `^`). `npm install` to update `package-lock.json`. Nothing else in `package.json`.
2. `test/labels.test.mjs` (lines 2, 33-36): pass `--engine mechanical` to the rwxmap CLI; replace `/Jev: off/` with `/rwxlite: off \(mechanical\)\n/` (anchored at the newline, so the line must carry no reason). Fix the line 2 comment to say rwxlite off. Keep `JEV_KEY: ''`.
3. `test/primitives-completeness.test.mjs` (line ~37-39): pass `--engine mechanical` to its CLI call too. No assertion change.
4. `scripts/bench-agents.mjs` (lines 106-110): pass `--engine mechanical`; replace the `/Jev: off/` check and its error text with the same `rwxlite: off (mechanical)` check.
5. `CHANGELOG.md`: add `## [Unreleased]` above `## [0.10.0]` (there is none yet) with `### Changed` and one line, "bareguard 0.34.0 and rwxmap 0.11.1, pinned exactly; no behaviour change in barebox."
6. Do not touch `poc/` (POC code, not shipped). Do not touch `src/`. If any step needs a `src/` change, stop and report.

## Required tests, each shown red then green

- **labels.test.mjs red→green:** with the new pins and the old assertion, run it: red on `/Jev: off/` (paste the line). After step 2: green.
- **The new assertion can fail:** remove `--engine mechanical` from the CLI call only, run: red, because the line now carries `— the rwxlite package is not installed`. Put it back: green. Paste both.
- **bench script:** `node scripts/bench-agents.mjs` must get past label building. Run it only once and only if `cat /proc/loadavg` shows load under 15; if the sandbox cannot run it, say so and leave it to the orchestrator.

## Done when

- Diff touches only `package.json`, `package-lock.json`, the two test files, `scripts/bench-agents.mjs`, `CHANGELOG.md`.
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` pass (paste the tails).
- `grep -rn 'Jev: off' test scripts src` returns nothing.
- Your sandbox skips bwrap and unix-socket tests: report the counts you got, and list the full suite as pending for the orchestrator. Do not commit.

## Orchestrator verifies

- Rerun both red→green checks above in a real shell.
- Full suite 3x in a real shell, 0 fail 0 skip, one suite machine-wide, load < 15, peer sessions told.
- `npm run bench:agents` once on HEAD (memory within the 205-245 MB range at 40 agents; Gate code is unchanged, so no A/B is needed unless it lands outside).
- A real `sbx run` smoke test (a GET allowed, a POST parked) after the pin, and `npm ls bareguard rwxmap` shows exactly 0.34.0 and 0.11.1.
