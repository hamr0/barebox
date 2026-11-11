# M9 brief: endpoint lists, model endpoints as the first user (2026-11-10)

Branch: `m8-upstream-bump` (continue on it). Worker: code-developer (Sonnet). Orchestrator verifies.
Decisions: PRD section 9, row "M9 decisions (Nov 10, user)". Read it first.

## Goal

One owner, `src/lists.js`, answers "does this request match an endpoint list?". Today's built-in model endpoints (`MODEL_PATHS`, `LOCAL_LLM_PATHS` in `src/policy.js`) move onto it. No new config keys. Host patterns (`*.domain`) are **not** built here: they land with M11, their first user.

## Facts checked in a real shell (Nov 10)

- `matcherFrom` (rwxmap/match) accepts plain sidecar objects, no files: `{ vendor: '', servers: ['https://<host>'], rows: [{ key, method, path, letter, marker }] }`. Templates `{name}` match one segment; query, trailing slash, `.` segments, host case and `:443` match; path case, `%2F` and a non-default port do not.
- **Every row in one sidecar applies to every server in it**: with servers `127.0.0.1:11434` and `api.anthropic.com` in one sidecar, `POST https://api.anthropic.com/api/chat` matched the local `/api/chat` row. So: **one sidecar per host**.
- The scheme is ignored by the matcher (`http://api.anthropic.com/v1/messages` matches an `https://` server). Same as today's model keys (`requestKey` has no scheme). Keep it.
- **Trailing dot**: `https://api.anthropic.com./v1/messages` gets key `api.anthropic.com..POST /v1/messages`, so it misses the model key today (falls to `http.POST`, `x`), and a labelled host with a trailing dot misses its labels too.
- **Cost**: every `match()` that finds no row runs rwxmap's v4 classifier (about 64 to 222 µs per POST since 0.11.1). So the list must check the host in a `Map` first and call `match()` only for hosts on the list.
- `requestKey(method, url)` is public: `import { requestKey } from 'rwxmap/discover'`. It returns the same `<host>.<METHOD> <path>` key `match()` returns on a miss, with no classifier (rwx session, Nov 10; src/matcher.js:181).

## Steps

1. **`src/lists.js`** (new, internal, not exported from the package index):
   - `normalizeUrl(url)`: parse with `URL`, strip one trailing `.` from `hostname`, return `href`. Throws on a non-URL like `URL` does. The only place a host is normalized.
   - `endpointList(entries)`: `entries` are strings `"METHOD host[:port]/path"`. Validate each, throwing `endpoint list: "<entry>": <why>`: method one of GET HEAD POST PUT PATCH DELETE (upper case); host non-empty, no scheme, no `*`, lower-case after trim; path starts with `/`. Build one sidecar per host (key = the entry string, letter `r`, marker `settled`; the letter is never read). Return `{ match(method, url) }` → the matched entry string or `null`. `match` normalizes the URL, looks the host (with port if non-default) up in a `Map` of list hosts, returns `null` without calling rwxmap when absent, else calls the host's matcher and returns the entry on `source === 'spec'`.
2. **`src/policy.js`**: `MODEL_PATHS` and `LOCAL_LLM_PATHS` become entry strings (`"POST api.anthropic.com/v1/messages"`, ... and per `localLlm` `host:port`, `"POST <hp>/api/chat"`, ...). One function builds the model list from `localLlm`. Model **tool names stay exactly as today** (`api.anthropic.com.POST /v1/messages`): build them with `requestKey` from `rwxmap/discover`, not `emptyMatcher.match`. `toolFor` order: (1) labels `matcher.match(method, normalizeUrl(url))` with `source === 'spec'` → its key; (2) model list match → that entry's tool name, if that name is in `tools`; (3) `http.<METHOD>`. A label tool sharing a model key still wins (existing test `a label tool that shares a model key is not a model`). `modelTools` and `buildTools` keep their signatures and results.
3. **`src/proxy.js`**: build the model list once per runtime next to `tools` and `models` (line ~141); no other change. If wiring needs more, stop and report.
4. **CHANGELOG** `[Unreleased]`: under `### Fixed`, "A host written with a trailing dot (`api.anthropic.com.`) now matches its labels and the built-in model endpoints; before, it fell back to the method's letter." Under `### Changed`, nothing else.
5. `barebox.context.md`: only if it states how model endpoints or label matching treat the host; then add the trailing-dot sentence. Do not move the file.

## Required tests, each shown red then green

Put unit tests in `test/lists.test.mjs`; gate-level tests next to the existing model tests in `test/gate.test.mjs`.

1. **Trailing dot, model**: in `ask` mode, `POST https://api.anthropic.com./v1/messages` is tool `api.anthropic.com.POST /v1/messages` and is allowed. Red on HEAD before the change (paste: tool `http.POST`, ask).
2. **Trailing dot, labels**: in `test/labels.test.mjs`, the labelled issue URL with `acme.atlassian.net.` gets the same spec key as without the dot. Red before.
3. **One sidecar per host**: with `localLlm: ['127.0.0.1:11434']`, `POST https://api.anthropic.com/api/chat` is `http.POST`, not a model. Mutation: build one sidecar for all hosts → red. Paste it.
4. **Templates**: `endpointList(['POST gmail.googleapis.com/gmail/v1/users/{userId}/messages/send'])` matches `/users/me/messages/send` and `/users/me/messages/send?x=1`; misses `/users/me/x/messages/send`, `GET` on the same path, and `:8443`. Mutation: make the template match any number of segments, or drop the method check → red.
5. **Host pre-check**: a test proving `match()` of rwxmap is not called for a host not on the list (inject or count calls; a mutation that removes the `Map` check must go red).
6. **Validation**: each bad entry (`post x/y`, `POST x`, `POST https://x/y`, `POST *.x/y`, `POST /y`) throws naming the entry.
7. **No tool name moved**: for every built-in model entry, the tool name equals today's (`emptyMatcher.match('POST', 'https://' + host + path).key` on HEAD). A test listing the exact expected strings.

## Measure (prove, don't assert)

Per-request cost of `toolFor` for an unlabelled POST to a host not on any list, 1e5 calls, before (HEAD) and after, alternating twice. Must not exceed before by more than 5%. Paste both numbers. A model-list hit is measured too, numbers only.

## Done when

- Diff touches only `src/lists.js`, `src/policy.js`, `src/proxy.js` (wiring only), the test files named above, `CHANGELOG.md`, and `barebox.context.md` if step 5 applies.
- All existing model, label and gate tests green; `npm run typecheck`, `npm run build:types`, `npm run check:primitives` pass (paste tails).
- Every required test shown red then green, every mutation red, with pasted output.
- Your sandbox skips bwrap/unix-socket tests: report the counts; the full suite is the orchestrator's. Do not commit, do not run a bench.

## Orchestrator verifies

- Reruns tests 1-3 red→green in a real shell and the mutations of 3-5 in a scratch copy (all changed src files copied).
- Reruns the cost measurement.
- Full suite 3x, 0 fail 0 skip, one suite machine-wide, peers told; a real `sbx run` calling a model host and a plain POST.
