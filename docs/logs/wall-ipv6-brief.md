# Wall brief: every spelling of a private IPv6 address is denied (2026-10-28)

**For:** the build agent. **Branch:** `hardening` at `43ffdbd` (clean). **Don't stage or
commit**; the user commits. Same nine rules as `docs/logs/hardening-brief.md` (read them
there): red before green, a skip is not a pass, mutations only in `/tmp/bb-wmut`, surgical, doc
comments stay with their function, no git writes, the brief wins, no processes left. Skip step 0.

Everything here is a pure function. **Your sandbox can run all of it**: no sockets, no bwrap.

## Why (checked by the orchestrator in a real shell)

`denyReasonForIp` (`src/wall.js:61`) recognises an embedded IPv4 only in the dotted spelling
(`mappedV4`, `src/wall.js:26`) and IPv6 loopback only as the exact string `'::1'`
(`src/wall.js:77`). So these return `null` (allowed) today:

| address | what it is | should be |
|---|---|---|
| `::ffff:7f00:1` | IPv4-mapped 127.0.0.1, hex spelling | `loopback` |
| `::ffff:a9fe:a9fe` | IPv4-mapped 169.254.169.254 (cloud metadata) | `link-local` |
| `::ffff:a00:1` | IPv4-mapped 10.0.0.1 | `private` |
| `::7f00:1` | IPv4-compatible (deprecated) 127.0.0.1 | `loopback` |
| `0:0:0:0:0:0:0:1` | `::1` uncompressed | `loopback` |
| `0:0:0:0:0:0:0:0` | `::` uncompressed | `unspecified` |
| `64:ff9b::7f00:1` | NAT64 (RFC 6052) of 127.0.0.1 | `loopback` |
| `64:ff9b::a00:1` | NAT64 of 10.0.0.1 | `private` |
| `2002:7f00:1::` | 6to4 (RFC 3056) of 127.0.0.1 | `loopback` |
| `2002:a9fe:a9fe::1` | 6to4 of 169.254.169.254 | `link-local` |

How each one reaches the dialer:
- **Through DNS, today.** An agent-controlled domain whose AAAA record is `64:ff9b::a00:1` passes
  the wall. On an IPv6-only network with a NAT64 gateway, that dial lands on 10.0.0.1 on the LAN.
  `checkUpstream` checks every resolved address with `denyReasonForIp`, so this is the live hole.
- **Through a literal, later.** `new URL('http://[::ffff:127.0.0.1]/').hostname` is
  `[::ffff:7f00:1]` (WHATWG rewrites it to hex). Today that bracketed host fails DNS and is denied
  as "unresolvable", by luck. The moment IPv6 literals are supported (an open design item), it
  would pass the wall. And `net.connect({ host: '::ffff:7f00:1' })` does reach a server on
  127.0.0.1: the orchestrator tested it.

**Must stay allowed** (no false positives; IPv6-only DNS64 networks show every IPv4 site
through NAT64):

| address | why |
|---|---|
| `8.8.8.8`, `2001:4860:4860::8888`, `2606:4700::1111` | public |
| `64:ff9b::808:808` | NAT64 of public 8.8.8.8 |
| `2002:808:808::1` | 6to4 of public 8.8.8.8 |
| `::ffff:808:808` | mapped public 8.8.8.8 |

## W1 (must): parse IPv6 once, check embedded IPv4 against the IPv4 rules

In `src/wall.js`, all stdlib, no dependency:

1. **One parser:** `v6Groups(ip)` → an array of 8 numbers (0–0xffff), or `null` when `ip` isn't
   IPv6 (`net.isIP(ip) !== 6`). It handles `::` anywhere and a trailing dotted quad
   (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`). Short JSDoc.
2. **One IPv4 rule set:** move today's IPv4 checks (the `if (v4) { … }` block) into
   `v4Reason(v4, allowLoopback)`, so the dotted IPv4 path and every embedded IPv4 use the same
   function. Behaviour for plain IPv4 is unchanged.
3. **IPv6 path in `denyReasonForIp`,** from the groups `g`:
   - all zero → `unspecified` (same `allowLoopback` rule as today);
   - `g[0..6]` zero and `g[7] === 1` → `loopback` (same `allowLoopback` rule);
   - `::ffff:0:0/96` (g0–g4 zero, g5 `0xffff`) → `v4Reason` of g6–g7;
   - `::/96` compat (g0–g5 zero, and not the two cases above) → `v4Reason` of g6–g7;
   - NAT64 `64:ff9b::/96` (g0 `0x64`, g1 `0xff9b`, g2–g5 zero) → `v4Reason` of g6–g7;
   - NAT64 local-use `64:ff9b:1::/48` (RFC 8215; g0 `0x64`, g1 `0xff9b`, g2 `1`) → `private`.
     Fail closed: the IPv4 position depends on the prefix length, which the wall can't know;
   - 6to4 `2002::/16` (g0 `0x2002`) → `v4Reason` of g1–g2;
   - link-local `fe80::/10` and ULA `fc00::/7` as today, but from `g[0]`;
   - then the existing host-local check, unchanged.

   An embedded IPv4 that `v4Reason` allows (public) means the address is allowed: return `null`,
   don't fall through to anything else.
4. **Delete `mappedV4`** once nothing calls it (grep first). `normIp` stays.
5. Update the header comment at the top of `src/wall.js` in a line or two: embedded IPv4 is
   checked in every IPv6 spelling, including NAT64 and 6to4. **No other doc edits**; list in your
   report any doc lines that name the wall's ranges (`barebox.context.md` does), and the
   orchestrator updates them at the docs sweep.

## W2 (must): tests in a NEW file `test/wall.test.mjs`

The existing wall tests sit in `test/proxy.test.mjs` under a `before` hook that starts a proxy,
so your sandbox can't run them. The new file needs no sockets and must run green for you.

- `describe('denyReasonForIp: every spelling', …)`: table-driven over **both tables above**, each
  row asserting the exact reason (or `null`), with the address in the assertion message. Add the
  `allowLoopback: true` cases: `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, `64:ff9b::7f00:1` → `null`;
  `::ffff:a9fe:a9fe` → still `link-local`.
- `describe('checkUpstream: DNS answers in embedded forms', …)`: through
  `checkUpstream('evil.test', { allowLoopback: false, resolveUpstream: async () => [...] })`:
  - `['64:ff9b::a00:1']` → `ok: false`, `reason` matches `/private upstream denied: evil\.test \(64:ff9b::a00:1\)/`;
  - `['8.8.8.8', '2002:7f00:1::']` → `ok: false` (any walled answer denies);
  - `['64:ff9b::808:808']` → `ok: true`.
- Red today: run the file before W1 and paste the `# pass` / `# fail` lines. The embedded and
  uncompressed rows must be the red ones, and the "must stay allowed" rows green.

**Mutations** (each red, then reverted, in `/tmp/bb-wmut`; delete it at the end):
1. remove the NAT64 `/96` branch → its rows red;
2. remove the 6to4 branch → its rows red;
3. loopback back to `ip === '::1'` → `0:0:0:0:0:0:0:1` red;
4. make NAT64 deny the whole prefix (ignore the embedded IPv4) → `64:ff9b::808:808` red;
5. make the mapped branch use only dotted input (like the old `mappedV4`) → `::ffff:7f00:1` red.

## Not this round (say so if you see them, don't do them)

- Teredo `2001::/32` (an obfuscated client IPv4), and the reserved IPv4 ranges (`198.18/15`,
  `224/4`, `240/4`, `192.0.0/24`): ledger ideas, not this brief.
- IPv6 literals in CONNECT and absolute-form URLs (the "unresolvable" luck above): a design item.
- The host-local check's spelling: DNS and `os.networkInterfaces()` both give the canonical form,
  so it isn't live.
- `test/proxy.test.mjs`, the CHANGELOG, `barebox.context.md`: the orchestrator's.

## Done when (tick each with evidence)

- [ ] W1: `v6Groups`, `v4Reason`, the IPv6 rules (file:line); `mappedV4` gone (grep shown).
- [ ] W2: `test/wall.test.mjs`. Red lines before W1, green after, 5 mutations red, each reverted.
- [ ] `npm run typecheck` clean; `npm run check:primitives` current (say if you regenerated).
- [ ] `npm test` totals, with every failing or skipped test listed with its error (rule 2).
      `test/wall.test.mjs` itself must be fully green in your sandbox.
- [ ] Doc lines that name the wall's ranges, listed (not edited).
- [ ] `git status`: `src/wall.js`, `test/wall.test.mjs`, this brief. Nothing else.
- [ ] `/tmp/bb-wmut` removed, no processes left.

**Report format:** W1, then W2 (red, green and mutation lines), then the rule-2 list, then this
checklist.
