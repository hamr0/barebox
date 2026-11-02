# Brief: model calls skip the card floor

Branch `m6`. User decision (Nov 2): requests to a known model endpoint are not
card-scanned. Every other request keeps the floor, in every mode.

## Why (checked by the orchestrator, Nov 2)

- Demo B, `claude -p` inside `sbx run` in auto: a 3.7 KB Claude Code side call
  `POST https://api.anthropic.com/v1/messages?beta=true` was held with
  `rule=flags.cardLike`; the conversation carried `card=4242424242424242` from the
  project README. Denied → Claude Code died ("API Error: 403"). Seen in 2 of 2 runs.
- The main model calls of the same agent (over 64 KB) were allowed unscanned
  (`src/proxy.js` comment "Past 64 KB the body streams on unscanned"). So today the
  floor on model calls fires by body size: random to the user, and no protection.
- Model calls are already `r` (free in every mode, any content): the floor was the
  only thing that looked at them.

## Facts

- Model endpoints: `MODEL_PATHS` and `LOCAL_LLM_PATHS` in `src/policy.js:37-42`;
  `buildTools()` (`src/policy.js:57`) adds them as `r` tools keyed by
  `emptyMatcher.match('POST', url).key`.
- Tool choice: `toolFor(matcher, tools, method, url)` (`src/policy.js:80`).
- Scan: `src/proxy.js:749-757`: `cardLike` is computed from the body, then the
  action is built with `tool: toolFor(...)`, `cardLike`, `paymentPath`.

## Build

1. One owner of "is this a model call": `src/policy.js`. `buildTools` already
   builds the model keys; expose that set (e.g. `buildTools` returns the tools
   table plus a `models` set, or a sibling exported function) — do not write a
   second list of hosts/paths anywhere. A label tool that happens to share a key
   is not a model (label tools win in `buildTools`; keep that order meaningful).
2. `src/proxy.js`: compute the tool first; when it is a model tool, `cardLike` is
   `false` and the scanner does not run. `paymentPath` unchanged.
3. Tests (each shown red on HEAD, then green):
   - a POST with a Luhn card number in the body to a model endpoint (use a
     `localLlm`/`allowLocal` `host:port` with `/v1/chat/completions`, like the
     existing local-model tests) is allowed in `ask`, `auto` and `trust`, with no hold;
   - control: the same body to a non-model path on the same host is still held
     `flags.cardLike` (in trust too);
   - a label tool on a model-looking path is still scanned if the worker finds that
     reachable; if not reachable, say so.
4. Docs: CHANGELOG [Unreleased] (Changed: model calls skip the card floor, with
   the reason in one line), `barebox.context.md` wherever the floor is described
   ("asks in every mode" now has this one exception), PRD M3/M7 decision line
   (user, Nov 2), README if it states the floor. Update JSDoc and run
   `npm run build:primitives` if a documented export changes.

## Rules

- Touch only `src/policy.js`, `src/proxy.js`, tests, the docs above. Another worker
  is editing `src/cli.js`, `examples/demo-b/` and the CHANGELOG at the same time:
  edit the CHANGELOG with small Edits to your own lines, re-read on a failed Edit.
- No full suite or bench (peer sessions share the machine): run the touched test
  files only. Do not commit.
- If a fact above is wrong, stop and report.

## Done when

- [ ] Tests red on HEAD (show output), green after; touched files 0 fail 0 skip.
- [ ] Mutation: re-enable the scan for model tools → the new allow test fails.
- [ ] `npm run typecheck`, `npm run check:primitives` exit 0.
- [ ] Report: files changed, test outputs, what differed from this brief.

## Orchestrator verifies

Rerun the touched test files, the mutation, and `examples/demo-b/run.sh --driver claude --mode auto`
(the model call must no longer be held), then the full suite 3x in a real shell.
