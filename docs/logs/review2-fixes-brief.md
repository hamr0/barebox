# Brief: m6 self-review round 2 — items 1-3 and the three cleanups

Branch `m6` (HEAD a6e442b). User (Nov 2, `/refactor do 1,2,3 and cleanup`): fix the
three Later items and the three Cleanup items from the second m6 self-review. They are
the 2026-11-02 `@ a6e442b` bullets at the end of `.claude/remember/fix-ledger.md`.
Item 1 is a behaviour fix the user asked for by name; items 2-3 are test-only; the
cleanups must change no behaviour.

Pre-existing, not yours: `docs/product/agent-sandbox-prd.md` has one uncommitted line (the
orchestrator's Demo A decision). Leave it.

## Facts (checked by the orchestrator)

- `writeAnswer(paths, id, decision, reason)` at `src/cli.js:452` is the one answer writer
  (`sbx approve` :459, `sbx deny` :466, the terminal prompt :252). It calls
  `writeFileAtomic` (`src/holds.js:137`: tmp file 0600 + `renameSync`, which overwrites).
- The proxy polls every `DEFAULT_POLL_MS = 250` (`src/holds.js:74`) and takes an answer with
  `consumeFile` (`src/holds.js:150`: rename it away, read, unlink). The ask file is removed when
  the hold is decided (`src/holds.js:395`).
- `writeFileAtomic` is also used for ask files and elsewhere: do not change it.

## 1. First answer really wins (`change`, behaviour fix)

`writeAnswer` creates the answer exclusively: write the tmp file as today (0600), then
`fs.linkSync(tmp, final)` (EEXIST when an answer is already there), then unlink the tmp
in every case. On EEXIST, `writeAnswer` reports "already answered" to its caller:
- `sbx approve|deny`: print `h1 already answered` on stderr, exit 1, write nothing.
- terminal prompt: print `answered elsewhere` (not `✓ allowed` / `✗ denied`) when its write
  lost. Check `src/prompt.js` prints the ✓/✗ line only after a successful write; make it so
  if not.
Tests, red on HEAD first: two `writeAnswer` calls for one id → the file holds the first
decision and the second caller gets the "already answered" result; `sbx approve` then
`sbx deny` on a held request before the proxy polls (use a long `pollMs` if the test can set
it, else stage the answer file directly) → the hold is allowed and `deny` exits 1 with the
message; prompt unit test: `answer()` reporting already-answered prints `answered elsewhere`.

## 2. `test/named.test.mjs` must not depend on the host TMPDIR (`change`, test only)

`before()` at line 23 makes `root` under `tmpdir()`. Use a short fixed root
(`mkdtempSync('/tmp/bb-nr-')`) for the 32-char-name test, so it measures barebox's layout,
not the caller's TMPDIR. Red first: `TMPDIR=/tmp/sr/t node --test test/named.test.mjs` fails
on HEAD ("socket path too long (108 > 107)"); green after with that TMPDIR and with it unset.
Check the other `tmpdir()` uses in the file (lines 80, 91) for the same dependency.

## 3. `--json` never prompts (`change`, test only)

`src/cli.js:248` `const prompt = !json && process.stdin.isTTY && process.stderr.isTTY`. Add a
real-pty test (python3 `pty`, like the existing `test/cli-prompt.test.mjs`): `sbx run --json`
with a held POST → stdout carries `{"ev":"ask",...}`, no `Allow?` on the terminal, and the hold
is answered with `sbx approve --name …` (or SBX_RUNTIME) → 200. Red: delete `!json &&` in a
scratch copy → the test fails. Own timeout so a hang fails by name.

## Cleanups (no behaviour change)

4. `src/prompt.js:64` ask queue: unreachable from the CLI (one agent, one hold slot; `src/run.js`
   opens no TCP door). Delete the queue (`queue`, `shift`, `findIndex/splice`, the queuing
   branch at :105) and its test (`test/prompt.test.mjs:117` "queued h2"). If an ask arrives while
   one is open, do the simplest thing with no new state: print the non-TTY `ask …` line for it
   (it is still answerable from a second terminal). Report what you chose.
5. `src/prompt.js` lines that survive deletion with prompt.test.mjs 14/14: `if (!open) return;`
   (:76), `buf = ''` in onData's `!open` branch, `open = null` at the top of `decided()` and
   before the write in `onLine`, `if (closed) return;` in `close()`. Delete each one at a time,
   tests green after each; if one turns out to matter (a test goes red or you can name an input
   that breaks), keep it and say why.
6. `test/cli-prompt.test.mjs:78` mis-indented line: fix the indent. Add `python3` to the
   `apt-get install` line in `scripts/ci-runner-deps.sh` so CI guarantees it (the pty tests skip
   without it, and a skip fails CI).

## Rules

- Touch only: `src/cli.js`, `src/prompt.js`, `test/prompt.test.mjs`, `test/cli-prompt.test.mjs`,
  `test/named.test.mjs`, a CLI test file for item 1 if needed, `scripts/ci-runner-deps.sh`,
  CHANGELOG (one line for item 1 under Fixed, small Edit).
- Mutations and red runs in a scratch copy under /tmp (short path: sockets cap at 107 bytes),
  replacing every changed src file; remove scratch copies at the end.
- No full suite or bench (peer sessions). Run touched test files, each 3x at the end.
- Do not commit. Do not touch `.claude/`. Wrong fact → stop and report.

## Done when

- [ ] Items 1-3: red shown (output), green after; touched files 0 fail 0 skip, 3x.
- [ ] Cleanups 4-6 done, tests green after each; anything kept, with the reason.
- [ ] `npm run typecheck`, `npm run check:primitives` exit 0.
- [ ] Report per item: change, test output, differences from this brief; `git status --porcelain`.
