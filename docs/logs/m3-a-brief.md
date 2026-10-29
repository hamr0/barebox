# M3 part A brief: work that needs neither bareguard 0.29.0 nor rwxmap 0.8.0 (2026-10-29)

Branch `m3`. Design source: `docs/product/agent-sandbox-prd.md`, section 7 M3 ("Design (decided Oct 29)").
Part B (the gate and the matcher wiring, the bench rewrite) waits for the two releases.

## Rules (every item)

- Sonnet workers write code and tests. The orchestrator verifies in a real shell.
- Each required test is shown red first (revert or break the code, run it, paste the failure), then green.
- Full suite at the end: `npm test` and `npm run typecheck`. Paste the counts. Zero fail and zero skip in a real shell; a skip is not a pass.
- Reuse before you add: grep for an existing helper before writing one, and report what you reused.
- One writer per piece of state.
- Do not touch `docs/`, `CHANGELOG.md`, `barebox.context.md`, `README.md` or `primitives.json`. A docs worker does those afterwards. Report any doc text your change makes false.
- Do not commit.

## A1: the card scanner, pure (`src/cardscan.js`, new; worker 1)

`createCardScanner()` returns `{ push(chunk: Buffer): boolean, found: boolean }`.
- It scans the bytes as they arrive and keeps only a short tail (40 bytes) between chunks, so a number split across chunks is still found. Memory per scanner is constant, whatever the body size.
- A card candidate is 13 to 19 digits, optionally grouped by single spaces or dashes between digits. It must not touch another digit on either side, its first digit must be 2 to 6 (card networks; this excludes millisecond timestamps, which start with 1), and it must pass the Luhn check.
- `found` turns true on the first hit and stays true.

`maskCards(text: string): string` replaces every candidate's digits with `*` except the last 4, keeping the separators.

Tests (`test/cardscan.test.mjs`):
- `4242424242424242`, `4242 4242 4242 4242` and `4242-4242-4242-4242` are found. `4242424242424241` (bad checksum) is not.
- `1730000000000` (a timestamp that passes Luhn, if one is used; pick a real one and show its Luhn result in the test name) is not found, because of the first-digit rule.
- A 20-digit run that contains a valid 16-digit card is not found.
- The 16-digit test card, split across two chunks at every possible offset, is found every time.
- One 5 MB body with the card at the end is found, and the scanner's retained tail stays at most 40 bytes (assert on an exposed length or an internal getter made for the test, your choice; say which).
- `maskCards('pay 4242 4242 4242 4242 now')` returns `'pay **** **** **** 4242 now'`.

## A2: one config file (`src/config.js`, new; `src/cli.js`, `src/launcher.js`; worker 2, in its own worktree)

The user's rule: one config file for barebox, now and later. No second config file unless it is a frequently rewritten, transitory one with a different job.
- Path: `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`.
- Keys today: `mode` (`ask` | `auto` | `trust`), `holdTimeoutSec` (positive integer, or `"never"`). Later modules add keys to this same file.
- No file means defaults. An unknown key, a bad value, or invalid JSON is an error that names the file and the key, and `sbx run` exits 2 with it on stderr.
- Precedence: a CLI flag beats the file, and the file beats the default.
- The library (`run`, `createProxy`) does not read the file. Only the CLI does. Library callers pass options.
- The sandbox must not see it: add `.config/barebox` to `LOCKED_PATHS` in `src/launcher.js` (reuse `lockMask`).

Tests:
- In `test/config.test.mjs`: defaults with no file; the file's `mode` used; a CLI `--mode` overriding it; an unknown key refused, naming the key; bad JSON refused, naming the file.
- In `test/launcher.test.mjs`: inside a sandbox, reading `~/.config/barebox/config.json` returns empty. Use the same proof style as the existing locked-path tests.

## A3: the Node flag and its cost (worker 2)

- `src/cli.js` first line: `#!/usr/bin/env -S node --max-semi-space-size=1`.
- Test: while `sbx run -- sleep 2` runs, `/proc/<sbx pid>/cmdline` contains `--max-semi-space-size=1`. Spawn `src/cli.js` as an executable, not `node src/cli.js`, so the shebang is what's tested.
- `scripts/latency.mjs` (not in `npm test`): the proxy in a child process, with and without the flag, and 2000 allowed requests through it to a local upstream (`unsafeTestOnly.allowLoopback`). Report p50, p95 and p99 in ms for each, 3 runs. It reports only; it has no pass or fail.

## Not in this round (waits for the user's decision on the body path)

The proxy body path: the per-agent working slot, held bodies to a file, the log without bodies, and the ask preview masking. A1 is its building block.

## How the orchestrator will verify

- Rerun each red/green pair named in the reports.
- `npm test` 3x and `npm run typecheck` in a real shell, with the worktree merged.
- Run `scripts/latency.mjs`.
- Read the diffs against this brief, line by line.
