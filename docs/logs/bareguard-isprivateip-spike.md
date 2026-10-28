# Spike: does bareguard's `isPrivateIp` catch what our wall misses? (2026-10-28)

bareguard **0.27.0** (tarball `https://registry.npmjs.org/bareguard/-/bareguard-0.27.0.tgz`,
package `exports`: only `"."`, `"./types"`, `"./primitives.json"`).
`isPrivateIp` is exported from `src/primitives/net.js` (`export { isPrivateIp };`)
but is **not** re-exported from the package root (`src/index.js`), so it is not
reachable through the published subpath map today — M3 adoption needs a
bareguard export (or a deep file import that the `exports` map currently blocks).

Import line used (extracted tarball, `npm i` itself is blocked in this sandbox):

```js
import { isPrivateIp } from './pkg/package/src/primitives/net.js';
```

Ours column: `denyReasonForIp(addr, false)` from `src/wall.js` (`null` shown as `allow`).

| address | expected | bareguard `isPrivateIp` | our `denyReasonForIp` |
|---|---|---|---|
| `::ffff:7f00:1` | private | true | allow |
| `::ffff:a9fe:a9fe` | private | true | allow |
| `64:ff9b::7f00:1` | private | **false** | allow |
| `2002:7f00:1::` | private | **false** | allow |
| `0:0:0:0:0:0:0:1` | private | **false** | allow |
| `::7f00:1` | private | true | allow |
| `::ffff:0a00:0001` | private | true | allow |
| `127.0.0.1` | private | true | loopback |
| `::1` | private | true | loopback |
| `10.0.0.1` | private | true | private |
| `169.254.169.254` | private | true | link-local |
| `fc00::1` | private | true | private |
| `fe80::1` | private | true | link-local |
| `::ffff:127.0.0.1` | private | true | loopback |
| `8.8.8.8` | public | false | allow |
| `2001:4860:4860::8888` | public | false | allow |
| `2606:4700::1111` | public | false | allow |

No false positives or negatives on the controls. bareguard catches 4 of the 7
forms our wall lets through (both hex-mapped forms, the `::7f00:1` compat form,
`::ffff:0a00:0001`) and still misses 3: NAT64 `64:ff9b::/96`, 6to4 `2002::/16`,
and the uncompressed loopback `0:0:0:0:0:0:0:1` (its `::1` check is an exact
string match, so the full form falls through; the same gap exists in our wall).

## Draft upstream issue (not filed — the user files it)

Title: `isPrivateIp` misses NAT64, 6to4, and uncompressed-`::1` loopback forms

Failing inputs (all should return `true`):

- `64:ff9b::7f00:1` (NAT64 `64:ff9b::/96` embedding loopback) → `false`
- `2002:7f00:1::` (6to4 `2002::/16` embedding `127.0.0.1`) → `false`
- `0:0:0:0:0:0:0:1` (uncompressed `::1`; the check matches the exact string `"::1"` only) → `false`

Expected: `true` for each. Why it matters in one sentence: DNS answers in
those forms still reach loopback or the LAN through NAT64 or 6to4 translation,
so a literal-only check lets an SSRF dial through.
