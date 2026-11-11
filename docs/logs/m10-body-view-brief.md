# M10 build brief: body view (2026-11-11)

Branch: `m10-body-view` (created from main 886bfb3). Worker: code-developer (Sonnet). Orchestrator verifies. Do not commit.
Decisions: PRD section 9, row "M10 decisions (Nov 11, user)", including POC 1, POC 2 and the queue decision. Read it first.
POC code to learn from (never copy as is, never ship): `/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/58a49caf-7ae6-4996-8480-39036c06e177/scratchpad/m10poc/view.mjs` and `.../m10b/queue/src/bodyview.js`.

## Goal

One owner, `src/bodyview.js`, gives the proxy a view of a request body that fits the 64 KB working slot: decoded when it is `gzip`/`x-gzip`/`deflate`, plus `get(path)` over JSON and form fields. The card scan and the ask preview move onto it. No decision changes except that cards inside gzip/deflate bodies are now found.

## Facts checked (Nov 11)

- Card scan today: `src/proxy.js:757`, `createCardScanner().push(Buffer.concat(ctx.chunks))` when `!ctx.over && !models.has(tool)`. `ctx` is built at `:748` and has `headers` (a copy of `creq.headers`).
- Preview today: `bodyPreview(ctx.tee.head)` at `src/proxy.js:611` (`parkIt`), `bodyPreview` in `src/holds.js:69` masks cards in the first 4 KB. `makeTee` (`:800`) keeps the raw first 4 KB, byte count and SHA-256; the audit's body fact (length + SHA-256) stays on the raw bytes.
- The allowed body is forwarded from `ctx.chunks` (`:779`, `:781`) or the held file: **the upstream must keep getting the original compressed bytes and headers.**
- zlib `maxOutputLength` throws without partial output; stream and `destroy()` at the cap instead. Without `destroy()` 40 bombs reach 1.6 GB (POC 1).
- `Buffer.subarray` keeps the whole parent alive: anything kept past the scan (the preview) must be a copy (`Buffer.from(...)`), never a subarray of the decoded buffer.

## Steps

1. **`src/bodyview.js`** (internal; not exported from `src/index.js`):
   - `viewBody(buf, headers)` → `Promise<{ text: Buffer, state: 'plain'|'decoded'|'truncated'|'unread', get(path) }>`.
     - No `content-encoding`, or `identity`: `state 'plain'`, `text = buf`.
     - Exactly `gzip`, `x-gzip` or `deflate` (trimmed, case-insensitive; a list such as `gzip, br` is not one): decode through **one proxy-wide queue** (one decoder at a time; a promise chain whose tail never rejects), stop at 65536 output bytes with `destroy()`. Full output → `'decoded'`; stopped → `'truncated'`; zlib error → `'unread'` with `text = buf`.
     - Any other encoding (`br`, `zstd`, lists): `'unread'`, `text = buf`, nothing decoded.
     - `get(path)`: content type from `headers['content-type']`, parameters ignored. JSON (`application/json`, `*+json`): dotted path, numeric segments index arrays, own properties only. `application/x-www-form-urlencoded`: the key as given, first value. Parsed lazily on first `get`; invalid or truncated JSON, `'unread'`, or another type → `undefined`. Never throws.
   - Module-level JSDoc says what it owns and why the queue exists (PRD M10 decisions).
2. **`src/proxy.js`**: where the card scan is today, build the view once (only when `hasBody && !ctx.over`), scan `view.text` (which is the raw bytes for `'plain'` and `'unread'`, so a false `Content-Encoding` cannot dodge the scan), keep `models.has(tool)` skipping the scan as today. Store on `ctx` only what the preview needs: a **copy** of the first 4 KB of `view.text` when `state` is `'decoded'` or `'truncated'`. `parkIt` uses that copy for `bodyPreview` when present, else `ctx.tee.head` as today. Forwarding, the tee, the audit body fact and held files are unchanged.
3. **CHANGELOG** `[Unreleased]` `### Added`: "Card numbers are found in `gzip` and `deflate` request bodies up to 64 KB (decoded output), and the ask preview shows such bodies decoded. `br` and other encodings are not decoded; they are scanned as sent."
4. **`barebox.context.md`** (lines ~150 and ~360 describe the card floor and the 64 KB limit): add the gzip/deflate sentence and that decoded output is capped at 64 KB. Do not move the file. Update `test/context-doc.test.mjs` only if it pins that text.
5. **PRD section 10, known gaps**: one line: "`br` and `zstd` request bodies are not decoded; a card inside one is not found (backlog, section 9)." Docs only.

## Required tests, each shown red then green (paste both)

Unit tests in `test/bodyview.test.mjs`; proxy-level next to the existing card tests (find them with `grep -n cardLike test/*.mjs`).

1. **gzip card, trust mode**: a POST with a gzip body holding `4111111111111111` asks in `trust`. Red on main.
2. **deflate card**: same with `deflate`. Red on main.
3. **False encoding**: a plain body with a card and `Content-Encoding: gzip` still asks. Mutation: skip the scan on `'unread'` → red.
4. **br as sent**: a `br` body is `'unread'` and not decoded (unit); a plain-text body labelled `br` with a card still asks (proxy).
5. **Bomb**: the 62 KB gzip bomb (`zlib.gzipSync(Buffer.alloc(64e6))`) gives `'truncated'`, `text.length === 65536`, in under 1 s (unit), and through the proxy the request is decided normally (an allow in `auto` reaches the upstream). Mutation: remove `destroy()` or the cap → the unit test fails by name within its own timeout.
6. **Queue**: 20 concurrent `viewBody` calls on bombs never have more than one decoder live (count via an injected or exported test hook, or by wrapping the zlib factory). Mutation: remove the queue → red. A decode error in the middle does not stall the queue (the next call still resolves).
7. **Upstream bytes unchanged**: an allowed gzip POST reaches the upstream with the identical compressed bytes and its `content-encoding` header. Mutation: forward `view.text` → red.
8. **Preview decoded**: a held gzip JSON body's `asks/<id>.json` `bodyPreview` is the decoded JSON, card masked. Red on main.
9. **Model skips scan**: a gzip body with a card to a built-in model endpoint is not card-asked (existing behaviour, now through the view).
10. **`get(path)`**: nested JSON with arrays (`personalizations.0.to.0.email`), `+json` with `; charset=utf-8`, form key `metadata[x]`, truncated JSON → `undefined`, prototype keys (`__proto__`, `constructor`) → `undefined`, unknown type → `undefined`, no throw anywhere. Mutation: eager parse without try/catch → red.

Every proxy-level socket test gets its own timeout so a hang fails by name.

## Done when

- Diff touches only `src/bodyview.js`, `src/proxy.js`, the test files above, `CHANGELOG.md`, `barebox.context.md` (+ its doc test if pinned), and PRD section 10's one line.
- Every required test red then green, every mutation red, outputs pasted. Mutations run in a scratch copy with every changed src file copied, never in the repo tree.
- `npm run typecheck`, `npm run build:types`, `npm run check:primitives` pass (paste tails).
- Run only the test files you touched plus `test/cardscan.test.mjs` and `test/holds.test.mjs`: `node --test --import ./test/setup-env.mjs <files>`. **No full suite and no bench**: another session is running a long bench. Your sandbox skips bwrap/unix-socket tests: list every skipped test by name.
- Stop and report if any fact above is wrong; do not work around it.

## Orchestrator verifies

- Reruns tests 1, 3, 5, 6, 7 red→green in a real shell, and the mutations of 3, 5, 6, 7 in a scratch copy.
- After the peer bench ends: full suite 3x (0 fail, 0 skip), `BENCH_GZIP` bench A/B against main (queue worst case at 40 agents ≤ 245 MB), and a real `sbx run` sending a gzip POST with a card (asks) and a plain GET.
