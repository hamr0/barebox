# Spec: the primitives manifest (`primitives.json`)

> Generic, reusable. Any bare-suite repo follows this from an empty repo to a shipped, CI-checked `primitives.json`. barebox is the worked example (section 7).
> Status: spec only. Nothing here is built in barebox yet. Every fact is taken from the sources listed in "Sources"; what could not be verified is in "Unverified" at the end.
> Labels used throughout: **EXISTS** (verified in a repo today), **PROPOSED** (a recommendation, not built), **TBD** (a decision nobody has made).

## Sources (read for this spec, 2026-10-27)

| Repo | Files |
|---|---|
| bareguard | `scripts/primitives-core.mjs` (402 lines), `scripts/primitives-core.hashes.json`, `scripts/gen-primitives.mjs`, `primitives.config.mjs`, `test/primitives-core.test.mjs`, `package.json`, `.github/workflows/ci.yml`, `primitives.json` (28 entries), `src/gate.js`, `src/primitives/classify.js`, `bareguard.context.md`, `README.md` |
| bareagent (upstream of the core) | `scripts/*`, `primitives.config.mjs`, `docs/product/prd.md` (section "Primitives manifest"), `docs/wiki/decisions-log.md`, `README.md`, `src/` (tool-call code) |
| litectx | `package.json`, `scripts/*`, `primitives.config.mjs`, `test/primitives-core.test.mjs` |
| barebox | `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/product/agent-sandbox-prd.md`, `package.json`, `tsconfig.json`, git log |

---

## 1. What `primitives.json` is

A compact, machine-readable menu of what a package offers. It is **generated from source JSDoc**, never hand-written, so it cannot drift.

| Question | Answer (EXISTS) |
|---|---|
| Who reads it? | The AI (or developer) that **builds** a harness with the package. Author time, before the loop exists. |
| Is it a runtime tool surface? | No. bareagent's PRD: "an author-time selection aid, not a runtime tool surface". bareguard's context doc: "Nothing in `src/` reads this file". |
| Why not prose? | A model can fetch it (`unpkg.com/<pkg>/primitives.json`, no install) and decide in one read. |
| Why not a version field? | `package.json` ships in the same tarball and is the one authority. A copy here only goes stale. |
| The load-bearing field | `when`. A description says what a thing does; `when` is what gets it picked. |

### 1.1 Exact shape

Top level has exactly two keys (core: `scripts/primitives-core.mjs:381`):

```json
{ "package": "<pkg.name>", "primitives": [ /* entries sorted by name, localeCompare */ ] }
```

Each entry has exactly seven string fields (core lines 354-362):

| Field | Source | Hand-written? |
|---|---|---|
| `name` | `@name` tag, else the symbol name | derived (override with `@name`) |
| `category` | `@category` tag, else `config.inferCategory(posixRelPath)` | derived (override with `@category`) |
| `when` | `@when` | **yes** |
| `import` | `import { <ExportedName> } from '<pkg>[/subpath]'`, resolved from the `exports` map | derived |
| `signature` | `@signature` literal, else built from `@param` / `@returns` | derived (override with `@signature`) |
| `fails` | `@fails` | **yes** |
| `example` | body of `@example`, dedented | **yes** |

Real entry, quoted from bareguard `primitives.json` (a plain export):

```json
{
  "name": "classifyCommand",
  "category": "classify",
  "when": "Reach for this to tier a shell command's blast radius BEFORE running it — e.g. to pick how much ceremony your human channel demands. Use it standalone when you want the tiering without a Gate; inside a Gate, set `bash: { classify: true }` instead and the gate calls it for you.",
  "import": "import { classifyCommand } from 'bareguard'",
  "signature": "classifyCommand(command: string, opts?: object) => \"safe\"|\"destructive\"|\"super_destructive\"",
  "fails": "Never throws on its own: a non-string or empty `command` returns `\"safe\"`, ...",
  "example": "import { classifyCommand } from \"bareguard\";\nclassifyCommand(\"git status\");        // \"safe\"\nclassifyCommand(\"rm -rf build\");      // \"destructive\"\n..."
}
```

A class-method entry (bareguard `Gate#readAudit`): `name` is `"Gate#readAudit"`, `import` is `import { Gate } from 'bareguard'` (the CLASS is what you import), `signature` is `gate.readAudit() => Promise<object[]>`.

Bareguard's file has 28 entries across 9 categories (rubric 11, classify 4, rwx 3, content 3, audit 2, matching 2, gate 1, secrets 1, axis-b 1).

### 1.2 Discovery contract (EXISTS)

| Piece | bareguard value |
|---|---|
| Fixed filename at package root | `primitives.json` |
| Pointer in `package.json` | `"primitives": "./primitives.json"` |
| Subpath export | `"./primitives.json": "./primitives.json"` |
| Consumer, no install | `unpkg.com/bareguard/primitives.json` |
| Consumer, installed (ESM) | `import menu from 'bareguard/primitives.json' with { type: 'json' }` |
| Consumer, installed (CJS, bare-agent doc) | `require('bare-agent/primitives.json')` |
| Reading `package.json` itself | `exports` hides it; read via `fs` (bareguard memory note, not re-verified here) |

---

## 2. What counts as a primitive

**EXISTS.** A primitive is an exported symbol, or a documented method of an exported class, whose JSDoc block contains `@when`. The generator only parses blocks that match `/@when\b/` (core line 339). A block without `@when` is invisible to it.

| Counts | Does not count |
|---|---|
| An exported function, class, or `const` with `/** ... @when ... */` | An export with no `@when` (it is simply absent) |
| A `const` bound to data (array, object): rendered as `NAME: Type`, never `NAME()` (core 205-211). Needs `@type {...}` | Config keys, rule strings, audit-line formats (bareguard's "rules are not in it") |
| A public class method: needs `@when`; add `@name Class#method` (bareguard style) | Methods starting with `_` (private by convention, core 219) |
| A `constructor` doc: resolves to the enclosing class, rendered `new Class(args)` | Bare error classes: fold them into the `fails` line of whatever throws them (bareagent PRD) |
| A harness-only call, if it is public. Say so in `@when` (bareguard does) | Internal helpers, test seams |

Completeness (EXISTS in bareagent/bareguard, per-repo, not in the shared core): `test/primitives-completeness.test.js` owns a deliberate-exclusion allow-list and fails if any other public export is unmanifested. barebox should add its own (section 4, step 9; PROPOSED for barebox).

### 2.1 Category naming

| Rule | Detail |
|---|---|
| Default | `config.inferCategory(posixRelPath)` in the repo's `primitives.config.mjs`. Path is `/`-normalized. Required. |
| Override | `@category <word>` on one block. Single line. |
| Convention (observed) | lowercase single word; bareguard maps `src/primitives/classify.js` to `classify`, `gate.js` to `gate`; litectx uses an explicit `@category` per verb because most verbs live in one file. bareagent also uses `integration`. |
| Fallback | bareguard falls back to the file basename; litectx and bareagent fall back to `core`. |
| Stability | Not a verified SemVer rule. **PROPOSED:** treat a category rename as a visible diff in `primitives.json`; it breaks nothing at runtime. |

---

## 3. The JSDoc contract

### 3.1 Tags (EXISTS, core lines 95-109)

| Tag | Required? | Rule |
|---|---|---|
| `@when` | **yes** (it is the trigger) | ONE line. Start with "Reach for this ...". Say when to pick it and when to pick the neighbour instead. |
| `@fails` | **yes** | ONE line. What happens on failure or refusal: throws what, returns what, never throws. |
| `@example` | **yes** | Must be the LAST tag. Body runs to the end of the comment, any number of lines. |
| `@param {type} name` | for a derived signature | `[name]` marks optional. A dotted name (`opts.x`) is ignored. |
| `@returns {type}` | for a derived signature | Rendered ` => type`. |
| `@name` | optional | Overrides the catalog name. Use `Class#method` for methods. Single line. |
| `@category` | optional | Single line. |
| `@signature` | optional | Exact literal; wins over everything. Single line. |
| `@type {T}` | for data `const` | Rendered `NAME: T`. |
| `@throws`, `@property`, `@typedef`, `@template` | allowed | Known tags. Not in the manifest. |

Any other tag inside a `@when` block is an error (RULE C), with a hint for aliases `return`, `arg`, `argument`, `exception`, `prop`. Adding a new tag means changing `KNOWN_TAGS` upstream in bare-agent, not locally.

### 3.2 What makes the generator FAIL (exit 1, nothing written)

All problems print together, then exit 1 (core 385-388).

| Failure | Core | Message gist |
|---|---|---|
| Missing `@when`, `@fails` or `@example` body | 347 | `name: missing @fails` |
| `@when`/`@fails`/`@category`/`@name`/`@signature` body spans a second non-empty line | 109, 166 | "keep it on one line (the manifest reads only the first)" |
| Unknown tag in the block | 167-170 | `unknown tag @x` (+ alias hint) |
| Any line starting with `@` inside `@example` | 138-145 | "`@example` must be the last tag" (RULE D). Write `// @foo` if it is content. |
| An indented line starting with `@` outside `@example` | 148 | a tag must start right after ` * ` |
| `@when` block with no symbol after it | 341 | `@when block has no resolvable symbol` |
| Symbol not found in any exports barrel | 352-353 | `not found in any exports barrel (is X exported?)` |
| Two entries with the same `name` | 372-376 | `duplicate primitive name`; give each a distinct `@name` |
| An exports barrel fails to `import()` | 268-269, 327-330 | fail-fast, with the real error |

### 3.3 What makes it SKIP silently

| Skip | Why |
|---|---|
| A JSDoc block without `@when` | Not a primitive. |
| A symlinked file or directory under a source root | Walker skips symlinks (core 285). |
| A non-`.js` file | Walker only reads `.js`. **TypeScript sources are not scanned** (barebox is JS + JSDoc; fine). |
| A source root that does not exist | Filtered out (core 321). |
| A `.json` / non-JS `exports` subpath | Not a barrel (core 258). |
| A trailing `@when` in a non-doc `/* */` comment | Only `/** */` blocks are scanned. |

### 3.4 Annotated example (a plain export)

Pattern taken from bareguard `src/primitives/classify.js`. `@example` is last.

```js
/**
 * Short human description (free text is fine above the tags).
 * @param {string} command   the shell command to tier
 * @param {object} [opts]    optional; `[ ]` marks it optional in the signature
 * @returns {"safe"|"destructive"|"super_destructive"}
 * @when Reach for this to tier a command BEFORE running it. Inside a Gate set `bash: { classify: true }` instead.   <- one line
 * @category classify                                                                                              <- optional override
 * @fails Never throws on its own: a non-string `command` returns `"safe"`.                                       <- one line
 * @example
 * import { classifyCommand } from "bareguard";
 * classifyCommand("rm -rf build"); // "destructive"
 */
export function classifyCommand(command, opts) { /* ... */ }
```

### 3.5 Annotated example (a class method)

Pattern taken from bareguard `src/gate.js:1965-1982`. The tag order there is `@returns`, `@name`, `@when`, `@category`, `@signature`, `@fails`, `@example`.

```js
export class Gate {
  /**
   * @param {object} entries
   * @returns {Promise<void>}
   * @name Gate#add
   * @when Reach for this at RUNTIME when your harness ... (HARNESS-ONLY wording goes here)
   * @category rwx
   * @signature gate.add(entries) => Promise<void>
   * @fails Throws when ... Nothing lands on any throw.
   * @example
   * const gate = new Gate({ ... });
   * await gate.add({ deploy: "x" });
   */
  async add(entries) { /* ... */ }
}
```

Two styles coexist (EXISTS, decisions-log, bareagent):

| Style | Tags | Rendered |
|---|---|---|
| bareguard | `@name Class#method` + `@signature` | the literal `@signature` text |
| litectx | neither | `receiver.method(args)`, receiver from `config.receivers` (`{LiteCtx:'liteCtx'}`) or lowercase-first-letter of the class |

The class must be exported from a barrel (the entry's `import` names the class). Class detection is line-anchored: `^\s*(export )?(default )?class Name` (core 194).

### 3.6 Style rules for the hand-written fields (EXISTS in bareguard's practice, not enforced by the generator)

- `when`: begin "Reach for this ..."; name the neighbour primitive to use instead; mark harness-only calls.
- `fails`: say "Never throws" or exactly what throws; say what is NOT guaranteed.
- `example`: copy-paste ready, runs against the real package, ends with a result comment.

---

## 4. Build from an empty repo, step by step

Assumes: Node >= 22, ESM (`"type": "module"`), plain JS with JSDoc, sources under `src/`. Paths are relative to the new repo. `BA` is the bare-agent checkout.

```bash
BA=~/PycharmProjects/bareagent      # canonical source of the core
```

**Step 1. Copy the core, its pin test, and the hashes. Never edit them.**

```bash
mkdir -p scripts test
cp $BA/scripts/primitives-core.mjs          scripts/
cp $BA/scripts/primitives-core.hashes.json  scripts/
cp $BA/test/primitives-core.test.mjs        test/
sha256sum scripts/primitives-core.mjs test/primitives-core.test.mjs   # compare with hashes.json
```

Also copy bareguard's `.gitattributes` lines so Windows checkouts cannot change the bytes (EXISTS):

```
scripts/primitives-core.mjs text eol=lf
test/primitives-core.test.mjs text eol=lf
scripts/primitives-core.hashes.json text eol=lf
```

**Step 2. Write `scripts/gen-primitives.mjs`.** bareguard's is 7 lines (bareagent's PRD calls it 5; the extra lines are comments):

```js
#!/usr/bin/env node
// Thin entry: the real generator is vendored byte-identically at
// scripts/primitives-core.mjs (pinned via test/primitives-core.test.mjs).
// See docs/product/<prd>.md "Primitives manifest".
import { run } from './primitives-core.mjs';
import config from '../primitives.config.mjs';
await run(config);
```

**Step 3. Write `primitives.config.mjs`** (repo root; the only repo-specific file). Keys: `inferCategory` (required), `sourceRoots` (default `['src','tools']`), `receivers` (default `{}`). bareguard's:

```js
import { basename } from 'node:path';
function inferCategory(file) {            // file is POSIX-normalized, relative to repo root
  const b = basename(file, '.js');
  if (b === 'index' || b === 'types') return 'core';
  if (b === 'gate') return 'gate';
  return b;                               // fallback: file name
}
export default { inferCategory, sourceRoots: ['src', 'tools'], receivers: {} };
```

**Step 4. Wire `package.json`** (every line below is from bareguard/litectx):

```json
{
  "type": "module",
  "engines": { "node": ">=22" },
  "exports": {
    ".": { "types": "./types/index.d.ts", "default": "./src/index.js" },
    "./primitives.json": "./primitives.json"
  },
  "files": ["src", "types", "primitives.json", "README.md", "LICENSE"],
  "primitives": "./primitives.json",
  "scripts": {
    "build:primitives": "node scripts/gen-primitives.mjs",
    "check:primitives": "node scripts/gen-primitives.mjs --check",
    "build:types": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json",
    "prepublishOnly": "npm run build:primitives && npm run build:types"
  }
}
```

Rules that bite:

| Rule | Why |
|---|---|
| The package needs an `exports` map (or `main`) that points at a real `.js` barrel | The generator resolves every `import` line by actually `import()`ing each JS barrel (core 246-276). With neither, it defaults to `./index.js` at the repo root (core 249). |
| `"./primitives.json"` must be in `exports` | Otherwise consumers cannot `import` it; the core skips non-JS subpaths itself. |
| `primitives.json` must be in `files` | `docs/` and `bench/` do not ship; the manifest must. |
| Each primitive's class or function must be re-exported from a barrel | Else: "not found in any exports barrel". |

**Step 5. Annotate the first primitive** (section 3), then generate and read the output:

```bash
npm run build:primitives     # writes primitives.json, prints "✓ wrote primitives.json — N primitive(s): ..."
git diff primitives.json
```

**Step 6. Add the CI check.** bareguard's `ci.yml` runs it in the typecheck job, after `npm ci`:

```yaml
      - run: npm ci
      - run: npm run typecheck
      - run: npm run check:primitives
```

**Step 7. TypeScript types from the same JSDoc** (only if the repo ships types; bareguard and barebox both do). EXISTS in bareguard:

- `tsconfig.json`: `allowJs`, `checkJs`, `declaration`, `emitDeclarationOnly`, `declarationDir: ./types`, `module/moduleResolution: NodeNext`, `strict: false`, `strictNullChecks: true`, `include: ["src/**/*.js"]`.
- `npm run build:types` and `npm run typecheck` both run `tsc -p tsconfig.json`. Typecheck is the real gate.
- `types/` and `src/**/*.d.ts` are git-ignored, generated at publish by `prepublishOnly`, shipped via `files`.
- The generator reads JSDoc from source, not from `.d.ts`; both come from the same JSDoc, so they agree. (Checking `signature` against the emitted `.d.ts` is NOT built; bareagent PRD lists it as deferred.)

**Step 8. Pin test runs in the default `npm test`.** `test/primitives-core.test.mjs` is picked up by `node --test`. It checks the core's SHA-256 and its own against `scripts/primitives-core.hashes.json` (CRLF-normalized) and fixture-tests the generator rules.

**Step 9. Add a completeness test (PROPOSED for new repos; EXISTS as `test/primitives-completeness.test.js` in bareagent, bareguard, litectx).** Content differs per repo, so it is not vendored. Minimum: every public export is either in `primitives.json` or in a named exclusion list with a reason; every entry has non-empty `when`, `fails`, `example`; every `import` line resolves.

**Step 10. Fresh-install smoke before the first publish (from bareguard practice).** `npm pack`, install the tarball in a temp dir, `import menu from '<pkg>/primitives.json' with { type: 'json' }`, and run one `example`. Validate the installed artifact, not the working tree.

---

## 5. Keeping it honest

| Guard | What it catches | Where |
|---|---|---|
| `check:primitives` (`--check`) | Source JSDoc changed but `primitives.json` not regenerated: exit 1 "primitives.json is stale" (core 389-396) | CI, every push (bareguard `ci.yml`) |
| Generator problems list | Missing `@when/@fails/@example`, wrapped tags, `@` in `@example`, duplicate names, unexported symbols | same command |
| Hash pin (`primitives-core.test.mjs`) | The vendored core or the pin test drifted a single byte from bare-agent's | `npm test` |
| Completeness test (per repo) | A new public export missing from the manifest | `npm test` |
| `prepublishOnly` | Publishing with a stale manifest or missing types | publish time |

### 5.1 Hash comparison (run 2026-10-27, `sha256sum`)

| File | bareagent | bareguard | litectx | Pinned in each `primitives-core.hashes.json` |
|---|---|---|---|---|
| `scripts/primitives-core.mjs` | `d62754222bded43185fbba29530df8bb1829cf2605a79dff2f9b7b5f80dbe9bf` | same | same | `core` = same |
| `test/primitives-core.test.mjs` | `1da7b1f2a2016185b5ff70a2d6fc4ff3178a0658ac3c8275263b3498b6d314f0` | same | same | `test` = same |

Result: **all three repos match.** bareguard's hashes file is identical to bareagent's (`diff -q` empty). litectx's hashes file has the same two values; the core file hash was computed there too.

How litectx pins it (EXISTS): the same way as bareguard. Vendored core, vendored pin test, `scripts/primitives-core.hashes.json`, its own `primitives.config.mjs` (`sourceRoots: ['src']`, `receivers: {LiteCtx:'liteCtx', ScopedView:'view'}`), and the same three npm scripts (`build:primitives`, `check:primitives`, `prepublishOnly`). There is no npm dependency on the core; it is copy-and-pin.

### 5.2 Adopting a new upstream core version (PROCEDURE, derived from the pin test text and decisions-log; not a script)

1. Change lands in bare-agent only (core, and test file if its rules changed). Never patch a local copy: the pin test message says "Fix upstream in bare-agent and re-vendor this exact file".
2. In the consumer repo: `cp` the core, the test file, and the hashes file from bare-agent.
3. `npm run build:primitives`.
4. **Adoption gate: `git diff primitives.json` must be EMPTY.** A non-empty diff means the new core changes your output or your JSDoc now breaks a rule. Fix the JSDoc (not the core), or send the finding upstream.
5. `npm test` (pin test green), `npm run check:primitives`, `npm run typecheck`.
6. Precedent: when RULE D (strict `@example`-last) landed, bareguard's `Gate#add/#rwxTools/#readAudit` and `addToGates` had to reorder JSDoc so `@example` was last; the output stayed byte-identical (decisions-log).

### 5.3 Stale JSDoc ships into the types

The same JSDoc feeds the manifest and the generated `.d.ts`. A wrong JSDoc claim (bareguard's example: "symlinks not resolved") is therefore published in `types/` and in the manifest's `fails`. The manifest check proves the file matches source; it does not prove the source is true. Review JSDoc text like code. `npm run typecheck` is the real type gate.

---

## 6. Exposing primitives to agents as tool calls

Two different things get called "tools". Do not mix them:

| | Author-time manifest (`primitives.json`) | Runtime tool call |
|---|---|---|
| Reader | the AI building the harness | the model inside the loop |
| Shape | `{name, when, import, signature, fails, example}` | `{name, description, parameters (JSON Schema)}` + an `execute` |
| Status | EXISTS | see 6.1 |

### 6.1 What exists today (EXISTS; searched bareagent `src/`, `tools/`, `scripts/`, `test/`, docs)

**Finding: nothing in bareagent turns `primitives.json` or package exports into tool definitions.** The only files in bareagent that mention `primitives.json` are `scripts/primitives-core.mjs`, `scripts/gen-primitives.mjs`, `test/primitives-completeness.test.js`, `test/primitives-core.test.mjs`. All are generator or test code. bareagent's PRD states the split is deliberate: "The runtime-callable packages (barebrowse, baremobile, litectx) are out of scope: they are already MCP servers, the correct shape for tools a model calls at runtime. A model does not 'call' a budget gate or a loop; it builds with them and gets caged by them." (`docs/product/prd.md`, section "Primitives manifest", Scope paragraph).

What does exist is the tool-definition shape and the plumbing around it:

| Piece | Where | What it does |
|---|---|---|
| Tool shape `ToolDef`: `{name, description, parameters, execute}` | `src/mcp-bridge.js:372-378`, `src/stash.js:138-152` | The internal tool object. `parameters` is JSON Schema. |
| Anthropic wire mapping | `src/provider-anthropic.js:165-169` | `{name, description, input_schema: t.parameters}` |
| OpenAI wire mapping | `src/provider-openai.js:165` | `{function: {name, description, parameters}}` |
| Ollama wire mapping | `src/provider-ollama.js:90` | same function form |
| Gemini wire mapping | `src/provider-gemini.js:122` | `parameters` passed through |
| MCP tools to ToolDef | `src/mcp-bridge.js:372-378` | MCP `inputSchema` becomes `parameters`; name is `<server>_<tool>`; description from the MCP tool |
| MCP errors to model | `src/mcp-bridge.js:380-385` | `result.isError` becomes a thrown `ToolError` |
| ToolDef to MCP (reverse) | `src/provider-clipipe-mcp.js:202` | `inputSchema: t.parameters` |
| Built-in tool factories | `src/tools.js:1-17` (browse, mobile, shell, spawn, defer, litectx MCP) | Hand-written tool defs, not generated from the manifest |
| Policy before execute | `src/loop.js:1124-1146` | `policy(name, args, ctx)`; only `true` allows; a string verdict is the deny reason fed back to the model as the tool result |
| bareguard wiring | `src/bareguard-adapter.js` (`wireGate`, `Gate` typedef at lines 10-24) | bareagent accesses bareguard structurally; the gate decides each call |
| Deny shape from bareguard | `bareguard/src/gate.js:52` and `:1746` | structured `{error: {type: "policy_denied", ...}}` result for a denied executor call |

So today every tool a model can call is either a hand-written `ToolDef` or an MCP tool. The manifest feeds none of them.

### 6.2 Proposed (NOT BUILT): manifest entry to tool-calling definition

This is a recipe, not code in any repo. Treat every row as PROPOSED.

**Step A. Pick what is exposable (an allow-list, never a deny-list).**

| Rule | Detail |
|---|---|
| Opt-in | **PROPOSED:** add a per-entry marker the generator does not yet emit (for example a separate hand-kept `tools.config` file listing exposed names). Default is NOT exposed. The shared core must not change locally; a new field would have to come from bare-agent. |
| Only runtime-safe verbs | Pure or read-only calls with plain-data arguments: the classifiers, matchers, redactors. |
| Never expose | See 6.3. |

**Step B. Map the fields.**

| Tool-call field | From | Note (all PROPOSED) |
|---|---|---|
| `name` | manifest `name` | `Class#method` is not a valid tool name for most providers. Replace `#` with `_` (for example `Gate_check`). Provider name charset limits: not verified here. |
| `description` | manifest `when` | `when` is already written as a trigger ("Reach for this ..."). Optionally append the first sentence of `fails`. |
| `parameters` (OpenAI/Gemini/internal) / `input_schema` (Anthropic) | **not in the manifest** | The manifest `signature` is a display string with JSDoc types, not JSON Schema. Options: (1) hand-write a schema per exposed entry in the harness; (2) **PROPOSED upstream change:** a new `@schema` tag (single line, JSON) added to bare-agent's core; (3) derive from emitted `.d.ts` with a converter (not evaluated). Option 1 is the only one that needs no core change. |
| `execute` | harness code | `import` line from the manifest tells the harness what to import; the harness owns the call and the argument checking. |

**Step C. Errors (`fails`) come back in-band.** Follow what already exists:

- An exception inside `execute` becomes a tool result string the model reads (bareagent: `ToolError` in `mcp-bridge.js:381`; a thrown error is fed back, BA-12 in `loop.js:583`).
- A policy deny comes back as the structured `{error:{type:"policy_denied", ...}}` (`bareguard/src/gate.js:52`) so the model can adapt.
- Use `fails` only as the human-facing description of these cases; the runtime error text should come from the actual throw, not from the manifest.

**Step D. Route every exposed call through the gate.** `policy` runs before `execute` (`loop.js:1124`). The manifest never bypasses it.

### 6.3 Must NOT be exposed to the agent

The bare-suite boundary, stated plainly: **the floor and the permissions are user-authored, never agent-authored.** An agent that can widen its own permissions has no floor. The agent writes the body; it never holds a handle that edits the constitution.

| Do not expose | Why (source) |
|---|---|
| `Gate#add`, `addToGates` | They grow the rwx tools map at runtime. Harness-only (`bareguard.context.md:21-26`, `src/gate.js` JSDoc). Tighten-only, but the agent still must not choose its own entries. |
| `Gate#rwxTools`, `Gate#readAudit` | Harness-only reads of gate state and audit. |
| `Gate#recordAccept` | Records a human ACCEPT. `bareguard.context.md:723, 783`: "never give the agent a handle on the gate that can call this". |
| `Gate` constructor, `createRubric`, `rubricSha` | They build or sign the policy. Authoring the floor is the user's job. |
| `checkStep` / `Gate#checkStep` as an agent-callable verdict | The gate grades itself; a caller's verdict is never trusted (bareguard memory). The harness calls it, not the agent. |
| Anything that mutates config, allow-lists, scopes, budgets, or secrets lists | Same reason. |
| Anything returning raw secrets or unredacted audit lines | Audit-only redaction exists to keep these out of the agent's reach. |
| Any call that takes a path, command, or URL and acts on it without the gate | Must pass `gate.check` first. |

**PROPOSED rule for new repos:** a primitive that is harness-only says `HARNESS-ONLY` in its `@when` (bareguard does). The exposure config refuses any name whose `when` contains that word, and fails closed on a name it does not know.

---

## 7. Worked example: barebox

### 7.1 What barebox's docs actually say about its API

| Fact | Source |
|---|---|
| Status: POC. "The npm package is a name reservation — the API lands with the graduation rewrite next." Published `0.1.0` is "the reservation scaffold — nothing to import yet." | `README.md`, status line and Install section |
| Latest commit `f6122c4` "Sync status to rewrite-next, record API surface decision" added one row to the PRD decisions table: **"API surface: CLI for sure plus programmatic APIs for spawning sandboxed workflows (goal: spawn workflows in a sandbox easily)."** | `docs/product/agent-sandbox-prd.md:224`, commit diff |
| CLI verbs named: `sbx pending`, `sbx approve <id>`, `sbx deny <id>`, `sbx diff`, `sbx commit`, `sbx rollback`. `sbx` is a placeholder name (open question 6). | PRD lines 217, 303, 327, 423 |
| Stack: Node; bareguard and rwxmap run in-process in the proxy. | PRD line 213 |
| Package state: `"type":"module"`, `engines.node >=22`, scripts `typecheck`/`build:types`/`prepack`; **no `exports`, no `main`, no `src/`** yet. | `package.json`; `ls` |
| `tsconfig.json`: `include ["src/**/*.js"]`, `rootDir ./src`, `declarationDir ./types`, `checkJs`. | `tsconfig.json` |
| Dev rules: zero production dependencies; reuse before you add; POC first. | `CLAUDE.md`, `README.md` |
| The POC proxy/launchers are throwaway, "not shipped" (`poc/`). | PRD line 169, README |

Nothing in the docs names a single exported function, class, or method. So barebox's first `primitives.json` has **no decided content yet**.

### 7.2 What it would plausibly hold (all TBD; do not treat as API)

The decision says "programmatic APIs for spawning sandboxed workflows". The README/PRD describe these capabilities. Candidate primitives, by capability, with names left open:

| Capability (from docs) | Candidate category (TBD) | Name | Harness-only? |
|---|---|---|---|
| Start a sandboxed run for an agent (walls + front door) | `run` | TBD | yes: it creates the sandbox the agent lives in |
| List held `x` requests | `approvals` | TBD (CLI: `sbx pending`) | yes: human channel |
| Approve / deny a held request | `approvals` | TBD (CLI: `sbx approve`, `sbx deny`) | **yes, and never agent-callable**: it is the human's decision |
| Show / commit / roll back the undo layer | `undo` | TBD (CLI: `sbx diff`, `sbx commit`, `sbx rollback`) | yes: human decision |
| Classify a request r/w/x | `doorman` | TBD (decided by M3: rwxmap + bareguard) | unknown |
| Read the audit log | `audit` | TBD | yes |

Every barebox primitive that starts, approves, commits or configures is harness/human-side. Almost nothing here belongs in the agent's tool list. That matches section 6.3. (PROPOSED reading, not a decision.)

### 7.3 Build plan for barebox (PROPOSED; wait for the API to exist)

1. When the graduation rewrite creates `src/index.js`, add `exports` (`"."` and `"./primitives.json"`) and `files` including `primitives.json` to `package.json`. Today the `prepack` script runs `build:types` only; add `build:primitives` and a `prepublishOnly` per step 4 (barebox uses `prepack`, bareguard uses `prepublishOnly`; choose one on purpose).
2. Run section 4 steps 1-3. Config: `sourceRoots: ['src']`, `inferCategory` by file name (for example `src/run.js` to `run`); `receivers` only if a class-method style without `@name` is chosen.
3. Do NOT scan `poc/`: it is outside `sourceRoots` and is throwaway.
4. Annotate each public export with `@when/@fails/@example` as it is written. The first entries are decided by the API, not by this doc.
5. Add `npm run check:primitives` to CI. barebox's CI setup: not checked here (no `.github` seen; see Unverified).
6. The `docs/product/` PRD gets a one-line pointer to this spec. (Not done here; docs were not to be edited.)
7. Dependency rule: the core uses only `node:` modules, so zero production dependencies still holds. The hash pin test also uses only `node:` modules.

---

## 8. New-repo checklist (one screen)

```
[ ] "type":"module", engines.node >= 22, a real JS barrel in exports (".")
[ ] cp from bare-agent: scripts/primitives-core.mjs, scripts/primitives-core.hashes.json, test/primitives-core.test.mjs
[ ] .gitattributes: eol=lf on those three files
[ ] sha256sum matches hashes.json (core + test)
[ ] scripts/gen-primitives.mjs  (import run + config; await run(config))
[ ] primitives.config.mjs       (inferCategory; sourceRoots; receivers if needed)
[ ] package.json: exports "./primitives.json", files has primitives.json, "primitives": "./primitives.json"
[ ] package.json scripts: build:primitives, check:primitives, build:types, typecheck, prepublishOnly
[ ] each public export: JSDoc with @when (1 line) @fails (1 line) @example (LAST tag)
[ ] class methods: @name Class#method (+ @signature), class exported from the barrel
[ ] harness-only calls say HARNESS-ONLY in @when
[ ] npm run build:primitives; read the output; commit primitives.json
[ ] CI: npm run check:primitives (after npm ci)
[ ] completeness test with a named exclusion list
[ ] types: tsconfig from JSDoc, types/ git-ignored, shipped via files
[ ] fresh-install smoke of the packed tarball before the first publish
[ ] README: link primitives.json and the unpkg URL
[ ] upstream change to the core? Land in bare-agent, re-vendor, git diff primitives.json must be empty
```

---

## Unverified

Things stated above that I could not confirm from the sources:

1. **Provider tool-name rules.** The advice to replace `#` with `_` in tool names is a recommendation; I did not check any provider's allowed-character rules.
2. **Whether `exports` hides `./package.json`.** Taken from the bareguard memory note; not re-tested here.
3. **barebox CI.** I did not look for `.github/` in barebox; whether a CI workflow exists there is unknown.
4. **barebox `.gitattributes` / `.gitignore`.** Not checked.
5. **Whether a category rename is "visible only"** (section 2.1 stability row) is my reading; no source states a rule for category names.
6. **Fresh-install smoke (step 10)** comes from the bareguard memory notes, not from a script in the repo; no command was run.
7. **`@schema` tag** and the "exposure config" in section 6.2 are inventions of this spec; nothing in bare-agent, bareguard or litectx does them today.
8. **Stale text in bareguard's own docs.** `bareguard.context.md` says "13 of 14 public exports are manifested" in one place while the real file has 28 entries; I used the real file. The bareagent PRD says the entry script is "5-line" while bareguard's is 7 lines including comments.
9. **bareagent PRD "As built" counts** (49 primitives, v0.44.1) were not re-counted.
10. **litectx pin.** I confirmed identical hashes and the same scripts, but did not run litectx's test suite or its `check:primitives`.
11. **No generator run in a fresh empty repo.** The step list is assembled from reading the core and three repos' wiring; I did not execute steps 1-6 in a scratch directory.
12. **Windows behavior** of the walker and pin test is described from comments in the core, not tested.
