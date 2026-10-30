# M3 part B2a brief: API labels and model endpoints (2026-10-30)

Branch `m3`, at `bef6c39`, plus `rwxmap` 0.8.0 pinned exactly in `package.json` (installed, uncommitted). B1 put every request through the gate as `http.<METHOD>`. B2a gives a request a vendor key when a label file documents it, and marks model calls `r`. The audit merge is B2b and the memory bench is B2c; neither is in this round.
Design source: PRD section 7 M3, "Design (decided Oct 29)"; the user approved the labels/tenants key names and the letters-from-the-gate-file rule on Oct 30.

## Rules

These are the same as `docs/logs/m3-b1-gate-brief.md`:
- Sonnet writes the code.
- Each required test is shown red, then green.
- Full `npm test` and `npm run typecheck` at the end, with counts. A skip is not a pass.
- Reuse before adding. One writer per piece of state.
- No docs, CHANGELOG, `barebox.context.md` or README edits. `primitives.json` only through the repo's generator if a new export needs it; say so.
- Do not commit.
- Never run sync child clients in the proxy's process.
- Every socket test gets its own timeout.

## Facts checked against rwxmap 0.8.0 (real runs, Oct 30)

- `import { matcherFrom } from 'rwxmap/match'`. `matcherFrom([sidecar, ...]).match(method, url)` always returns `{ key, letter, marker, source: 'spec'|'request', tie }`. It throws only on a non-http(s) or unparsable URL. `matcherFrom` throws on a bad sidecar, and on one with no `servers` key (written before 0.8.0) with a "regenerate it with rwxmap 0.8.0" message.
- The rwxmap CLI (`rwxmap <spec> -o <dir> --vendor <v>`) writes three files per vendor into `<dir>`:
  - `<v>.rwxmap.json`: the gate file. Its `bareguard.tools` is a map `{ "<v>.<operationId>": { letter, marker } }`. bareguard's `rwx.tools` accepts that object form as-is.
  - `<v>.rwxmap.review.json`: the sidecar `matcherFrom` reads. Top-level keys: `vendor`, `servers`, `counts`, `rows`, `review`, `destructiveSuggestions`, `collisions`, plus `serverTemplates` when the spec has one.
  - `<v>.openapi.rwx.json`: not used by barebox.
- Placeholder tenants: a jira-like spec wrote `servers: ["https://your-domain.atlassian.net/"]`. `PUT https://acme.atlassian.net/rest/api/3/issue/ABC-1` then came back `source:'request'`. After `sidecar.servers = ["https://acme.atlassian.net"]` it came back `{ key: "jira.editIssue", letter: "w", source: "spec" }`, and the host match ignores case.
- Request-only keys: `api.anthropic.com.POST /v1/messages`, `api.openai.com.POST /v1/chat/completions` (the query is dropped), `localhost:11434.POST /api/chat` (the port is kept, and `:443` on https is dropped). Path ids become `{id}`. For example `/rest/api/3/other` keys as `/rest/api/{id}/other`.
- A reproducible fixture spec is at the end of this brief.

## The design

1. **Config: two new keys in `~/.config/barebox/config.json`** (`src/config.js`, the one writer of settings). Validate them like the existing keys; an unknown or bad value throws and names the file and the key.
   - `labels`: an array of folder paths that the rwxmap CLI wrote. A leading `~/` means `$HOME`. Default `[]`.
   - `tenants`: an object `{ "<vendor>": ["https://tenant.example.com", ...] }`, a non-empty array of http(s) URLs per vendor. Default `{}`.
2. **Loading labels** (`src/labels.js`, new; the only reader of label files).
   - Export `loadLabels({ labels, tenants })`, which returns `{ matcher, tools }`. The CLI calls it once at startup, before the proxy starts, so a bad file fails the run before any agent starts.
   - For each folder, take every `*.rwxmap.review.json` and its sibling `<v>.rwxmap.json`. A review file without its gate file throws, naming both paths. A folder with no review file throws, naming the folder.
   - `tools` comes from each gate file's `bareguard.tools`, so a letter you edit there is the letter barebox uses. The review file's letters are never used, and neither is `match().letter`.
   - Two vendors defining the same key throws.
   - A `tenants` entry replaces that vendor's sidecar `servers` before `matcherFrom` runs. A `tenants` vendor that no label folder defines throws.
   - `matcherFrom`'s pre-0.8.0 error is passed through unchanged, with the file path in front.
   - The parsed sidecars are not kept after `matcherFrom` returns: only `matcher` and `tools` live on.
3. **Model endpoints are `r`** (`src/policy.js`, which owns letters).
   - `MODEL_PATHS`: `POST /v1/messages` and `POST /v1/messages/count_tokens` on `api.anthropic.com`; `POST /v1/chat/completions`, `POST /v1/responses` and `POST /v1/embeddings` on `api.openai.com`.
   - Every `localLlm` host:port gets `POST /api/chat`, `POST /api/generate`, `POST /api/embed`, `POST /v1/chat/completions` and `POST /v1/completions`.
   - Each becomes a tool `"<host[:port]>.POST <path>": "r"`, the exact request-only key format above.
   - Build the key with the same `matcher.match()` call (`source:'request'` gives the key). Do not write a second key builder.
4. **The tool for a request** (one function in `src/policy.js`, `toolFor(matcher, tools, method, url)`; the proxy's `tool: \`http.${method}\`` at about `src/proxy.js:666` calls it):
   - `r = matcher.match(method, url)`.
   - If `r.source === 'spec'`, the tool is `r.key`.
   - Else, if `tools` has `r.key` (a model endpoint), the tool is `r.key`.
   - Else the tool is `http.<METHOD>`.
   - Never use `r.letter`. A spec key the gate file lacks (for example, a row you deleted) reaches the gate unlisted and is denied. That is intended: fail closed.
   - If `match` throws, the tool is `http.<METHOD>`.
5. **One tools table per runtime.**
   - `gateFor` takes `tools`. The table is `{ ...http.* table, ...model keys, ...label tools }`, built once and shared by every gate, as in B1.
   - `createProxy` and `run()` take `labels: { matcher, tools }` (optional; omitted means no labels and only the built-in model keys).
   - The CLI passes `loadLabels(cfg)`.
6. **The sandbox never sees label folders.** Mask each `labels` folder exactly as the config dir is masked (`lockMask` in `src/launcher.js:206`). The agent could otherwise rewrite a letter for the next run.

## Required tests (each shown red first)

1. Config: `labels` and `tenants` are accepted. Each bad shape throws, naming the key: not an array, a non-string entry, a non-http tenant URL, an empty tenant list.
2. `loadLabels` throws on:
   - a missing gate file
   - a folder with no review file
   - a pre-0.8.0 sidecar (delete `servers`), with rwxmap's message and the path
   - a duplicate key across vendors
   - a `tenants` vendor with no label folder
3. With the fixture (`--vendor jira`) and `tenants: { jira: ["https://acme.atlassian.net"] }`:
   - `PUT …/issue/ABC-1` gives the tool `jira.editIssue`. Without the tenant it gives `http.PUT`.
4. Gate file wins: edit `jira.editIssue` to `"x"` in the gate file. In `auto` mode the PUT then asks; with the original `w` it passes.
5. Model endpoints: in `ask` mode (r free, w and x ask), `POST https://api.anthropic.com/v1/messages` and a `localLlm` `POST http://localhost:11434/api/chat` pass without an ask. `POST https://api.anthropic.com/v1/other` asks.
6. A deleted gate row is denied: remove `jira.deleteIssue` from the gate file, and a DELETE to it is denied (`rwx.unlisted`) in `trust` mode.
7. Through the proxy (a socket test with its own timeout): a matched PUT is logged in `gate.jsonl` with `action.tool === "jira.editIssue"`.
8. Sandbox: a `labels` folder cannot be read from inside `sbx run`, the same check the config-dir test uses.

## Done when

- `npm test` passes with 0 fail and 0 skip, `npm run typecheck` is clean, and the counts are reported.
- Every required test is shown red, then green.
- The report lists what was reused, every new export, and any assumption it had to make.

## Fixture spec (`test/fixtures/jira-mini.json`)

```json
{"openapi":"3.0.0","info":{"title":"t","version":"1"},"servers":[{"url":"https://your-domain.atlassian.net"}],
"paths":{"/rest/api/3/issue":{"post":{"operationId":"createIssue","responses":{"200":{"description":"ok"}}}},
"/rest/api/3/issue/{id}":{"get":{"operationId":"getIssue","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}},
"put":{"operationId":"editIssue","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}},
"delete":{"operationId":"deleteIssue","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}}}}
```

Generate the label pair in the test's own temp dir with `node node_modules/rwxmap/src/cli.js <spec> -o <dir> --vendor jira`. This checked-in mechanical run gives createIssue x, getIssue r, editIssue w, deleteIssue x. Run it with no `JEV_KEY` set and with `cwd` set to the temp dir, because the CLI also looks for a Jev key file in its cwd. That way Jev stays off and no network is used. Check that the CLI prints `Jev: off`.
