# Wall brief 2: the host-local check matches every spelling (2026-10-28)

**For:** the build agent. **Branch:** `hardening` at `1c0db8c` (clean). **Don't stage or commit.**
Same nine rules as `docs/logs/hardening-brief.md`: red before green, mutations only in
`/tmp/bb-hlmut`, surgical, doc comments stay with their function, no git writes, the brief wins.
Skip step 0. **Your sandbox can run all of it** (no sockets). Your budget is small: H1 is the
must; stop after a finished item.

Source: `/self-review` of `43ffdbd..1c0db8c`, Fix now 1 (and Later 3, 4).

## The bug (reproduced by the orchestrator in a real shell)

`denyReasonForIp` (`src/wall.js:122`) ends with `if (localIps().has(ip)) return 'host-local';`
(`src/wall.js:142`). `localIps()` (`src/wall.js:96-113`) stores each interface address as
`normIp(a.address)`. `normIp` strips brackets and the `%zone` and lowercases, but it **doesn't
canonicalise IPv6**. So the check compares strings, and another spelling of the host's own address
slips past:

```
os.networkInterfaces = () => ({ eth0: [{ address: '2001:db8::1', family: 'IPv6', internal: false }] })
2001:db8::1            host-local
2001:db8:0:0:0:0:0:1   null        ← should be host-local
2001:0db8::1           null        ← should be host-local
2001:DB8::0:1          null        ← should be host-local
[2001:db8::1]          host-local
2001:db8::2            null        (correct: a different address)
```

It's latent today: CONNECT to an IPv6 literal answers `400 bad connect line`, and a bracketed
absolute-form host fails DNS. It goes live once IPv6 literals are supported, and the wall must be
right on its own. It's the same "every spelling" class your last wall brief closed for embedded
IPv4.

## H1 (must): compare IPv6 by its parsed groups, on both sides

In `src/wall.js`. Reuse `v6Groups` (you wrote it; it's at `src/wall.js:38`). Don't add a second
parser.

1. In `localIps()`, store an IPv6 address as its canonical key: `v6Groups(addr).join(':')` (the 8
   numbers joined; it's an internal key, so it doesn't have to be pretty). Store IPv4 as today
   (dotted, via `normIp`). An address `v6Groups` can't parse: keep today's `normIp` string, so
   nothing is dropped.
2. In `denyReasonForIp`, the IPv6 host-local check uses the same key: `g.join(':')`, where `g` is
   the groups you already have there. The IPv4 path (`v4Reason` → `localIps().has(v4)`) stays as
   it is: dotted IPv4 already has one spelling once `net.isIP(v4) === 4`.
3. Update `localIps`'s one-line doc ("one spelling (see `normIp`)") to say IPv6 is keyed by its
   parsed groups.

Nothing else changes. The order of checks in `denyReasonForIp` stays the same.

## H2 (must): tests in `test/wall.test.mjs`

A new `describe('host-local: every spelling of the host\'s own address', …)`. Stub
`os.networkInterfaces` on the **default import** (`import os from 'node:os'`;
`os.networkInterfaces = () => ({ … })`). `wall.js` calls it on every check, so the stub takes
effect. Restore the real function in a `finally` (or `afterEach`), so no other test sees the stub.
Stub shape: `{ eth0: [{ address: '2001:db8::1', family: 'IPv6', internal: false }] }`.

- `2001:db8::1`, `2001:db8:0:0:0:0:0:1`, `2001:0db8::1`, `2001:DB8::0:1`, `[2001:db8::1]` →
  `'host-local'`.
- `2001:db8::2` → `null` (no false positive).
- An IPv4 stub as a control (`{ address: '203.0.113.7', family: 'IPv4', internal: false }`):
  `203.0.113.7` → `'host-local'`, and `::ffff:203.0.113.7` → `'host-local'` (it goes through
  `v4Reason`; this already passes today, so it pins the IPv4 path you mustn't break).
- A stub whose `networkInterfaces` **throws** → `2001:db8::1` is `null` and nothing throws (today's
  behaviour: `localIps` returns an empty set).

**Red today:** run it before H1 and paste the `# pass` / `# fail` lines. The three non-canonical
IPv6 rows must be the red ones; the canonical, bracketed, `::2`, IPv4 and throws rows are green.

**Mutations** (in `/tmp/bb-hlmut`, each red, then reverted; delete the dir at the end):
1. `localIps` stores the raw `normIp` string again → the non-canonical rows red;
2. `denyReasonForIp` checks `localIps().has(ip)` again (not the key) → the same rows red;
3. join the groups of only the first 4 → `2001:db8::2` red (a false positive).

## H3 (nit, comments only, no code)

- `test/fixtures/probes.mjs:13-17`: the docstring says `bwrapUsable` "checks it is usable, not
  just present". `bwrap --version` succeeds even where namespaces or netlink are blocked (your own
  sandbox proves it), so make the comment say what it really does: bwrap is on `PATH` and runs
  `--version`. Don't change the code.
- `test/overlay.test.mjs:5` header comment and the `scripts/bench.mjs:109` SKIP message still say
  `/usr/bin/bwrap`: say "bwrap on PATH" instead.

## Not yours

`test/proxy.test.mjs` (the vacuous log check, Later item 2), `barebox.context.md`, `CHANGELOG.md`.
The orchestrator does those.

## Done when

- [ ] H1: the `localIps` key and the `denyReasonForIp` check (file:line); no second parser.
- [ ] H2: red lines before H1, green after; 3 mutations red, each reverted.
- [ ] H3: three comment edits (file:line), no code change.
- [ ] `npm run typecheck` clean. `test/wall.test.mjs` fully green in your sandbox. `npm test`
      totals, with every failing or skipped test listed with its error.
- [ ] `git status`: `src/wall.js`, `test/wall.test.mjs`, `test/fixtures/probes.mjs`,
      `test/overlay.test.mjs`, `scripts/bench.mjs`, this brief. Nothing else.
- [ ] `/tmp/bb-hlmut` removed, no processes left.

**Report format:** H1, H2 (red, green and mutation lines), H3, the rule-2 list, then this checklist.
