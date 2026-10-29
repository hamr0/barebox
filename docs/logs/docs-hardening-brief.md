# Docs brief: write down what the hardening branch changed (2026-10-28)

**For:** the build agent. **Branch:** `hardening`. There's other uncommitted work in the tree; **edit
only the three docs named below.** Don't stage or commit. Same rules as
`docs/logs/hardening-brief.md` where they apply (surgical, the brief wins, no git writes). No code,
no tests. Your budget is small: do D1 → D3 in order, stop only after a finished item, and keep every
edit to the facts listed here. Don't add claims of your own. Match each file's voice: short plain
sentences.

## The facts (all verified by the orchestrator in a real shell; use only these)

1. **One held request per agent.** Each agent has at most one held request whose body is being read
   or that is parked. Later held requests from that agent wait in line, unread, in order. At most 16
   wait. The next one gets `429 hold queue full`.
2. **The deadline counts from arrival** (default 120 s, `never` supported), time spent in line and
   reading the body included. A request past its deadline gets `403 denied: hold timeout`, whether
   it is waiting in line, still sending its body, or parked.
3. **The TCP door is one agent.** Every connection through `createProxy`'s TCP `port` counts as the
   agent `tcp`, so those requests share one line. Use `addAgent` sockets (`sbx run` does) to give
   agents separate lines.
4. **The wall checks an IPv4 embedded in IPv6 in every spelling**: IPv4-mapped (`::ffff:7f00:1`
   and `::ffff:127.0.0.1`), IPv4-compatible, uncompressed (`0:0:0:0:0:0:0:1`), NAT64
   `64:ff9b::/96` (local-use `64:ff9b:1::/48` is denied outright) and 6to4 `2002::/16`. NAT64 and
   6to4 addresses of public IPv4 sites stay reachable.
5. **Runtime folders are owner-only (0700) whatever the umask**: the runtime root, `asks/`,
   `answers/` and `socks/`.
6. **`createProxy` throws synchronously on an unopenable `logFile`** and releases the runtime. In
   0.3.0 that, and any later audit-log write error such as a full disk, was an uncaught exception
   that killed the host process. A write error now prints one `sbx: audit log … write failed` line
   to stderr and the proxy keeps running. (Don't mention `close()` hangs: those were introduced
   and fixed on this unreleased branch, and the CHANGELOG never lists fixes to unreleased code.)
7. **The `sbx run` "answer with" hint quotes the runtime path**, so it is safe to copy-paste.
8. **Overlay hashing reads files in 1 MiB chunks**, so very large files no longer exhaust memory.
10. **`run()` releases the runtime when the agent socket can't be created.** In 0.3.0 that throw
    left the proxy's runtime claim held, so a second `run()` on the same runtime in the same
    process was refused "in use".
9. **bareguard 0.27.0's `isPrivateIp`** catches the hex-mapped and compat forms but still misses
   NAT64, 6to4 and the uncompressed `::1`, and it isn't reachable through bareguard's package
   exports. A draft upstream issue is in `docs/logs/bareguard-isprivateip-spike.md` (not filed).

## D1 (must): `CHANGELOG.md`, a new `## [Unreleased]` section above `## [0.3.0]`

Keep a Changelog headings. Facts 1–3 go under `### Changed`; 4–5 under `### Security`; 6–8 and 10 under
`### Fixed`. That's allowed here, because these fix behaviour that **shipped in 0.3.0**. One
bullet per fact, one or two sentences, in the voice of the 0.3.0 entries. Fact 1 says "(pre-1.0
behaviour change)". Fact 9 isn't a change; leave it out.

## D2 (must): `barebox.context.md` (ships in the npm package, so be exact)

- Line 67 ("Held requests wait (default 120 s, `never` supported); …"): say the deadline counts
  from arrival, and add one sentence for fact 1 (one per agent, 16 waiting, `429`).
- Line 131 (the upstream wall bullet): add fact 4 in one sentence.
- Next to line 130 (the certificates bullet), add one bullet for fact 3.
- Change nothing else in the file.

## D3 (should): `docs/product/agent-sandbox-prd.md`

- Line 410 ("bareguard's `isPrivateIp` replaces barebox's `denyReasonForIp`. bareguard's version
  already decodes the hex …"): it is now wrong. Rewrite it: barebox's `denyReasonForIp` already
  covers every form in fact 4; adopt bareguard's only once it covers NAT64, 6to4 and the
  uncompressed `::1` and is exported (fact 9, link the spike doc).
- Row F4 (line 428): status `verified: misses 3 forms` and a pointer to the spike doc. Keep the
  table's columns.
- **Don't touch the memory numbers** (lines 146 and 400). The orchestrator updates them after the
  final bench.

## Done when

- [ ] D1, D2, D3: paste each diff hunk (`git diff -- <file>`).
- [ ] Each bullet traces to a fact number. Say which, briefly.
- [ ] `git status`: only these three docs (plus this brief) are new changes from you.
