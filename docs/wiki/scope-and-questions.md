---
title: Scope and questions
description: What barebox leaves out of the build, which questions are still open, and which are decided.
---

# Scope and questions

## Out of scope

For the whole build. Core foundations first, all else is out of scope (docs/archive/agent-sandbox-prd.md:333-335).

- Not a defence against kernel exploits. Use a VM for that (docs/archive/agent-sandbox-prd.md:337-337).
- No Docker or VM (docs/archive/agent-sandbox-prd.md:338-338).
- No native Windows (docs/archive/agent-sandbox-prd.md:339-339).
- No cluster or k8s orchestration (docs/archive/agent-sandbox-prd.md:340-340).
- No cloud control plane (docs/archive/agent-sandbox-prd.md:341-341).
- No phone agents (baremobile) (docs/archive/agent-sandbox-prd.md:342-342).
- No GraphQL or gRPC body parsing in v1 (docs/archive/agent-sandbox-prd.md:343-343).
- No cert-pinned apps (docs/archive/agent-sandbox-prd.md:344-344).
- Non-HTTP egress is denied (docs/archive/agent-sandbox-prd.md:345-345).
- UDP is denied (docs/archive/agent-sandbox-prd.md:346-346).
- No web UI in v1 (docs/archive/agent-sandbox-prd.md:347-347).
- No multi-user approvals, org roles or phone push in v1 (docs/archive/agent-sandbox-prd.md:348-348).
- No Landlock or custom seccomp in v1 (docs/archive/agent-sandbox-prd.md:349-349).
- No body placeholder swap in v1 (docs/archive/agent-sandbox-prd.md:350-350).
- No personal-data-leaving rule (passport, date of birth, address) (docs/archive/agent-sandbox-prd.md:351-351).
- No browser agents or on-screen action classifier (Jev) in v1 (docs/archive/agent-sandbox-prd.md:352-352).

Also out of scope until Nov 5 (docs/archive/agent-sandbox-prd.md:354-354):

- Bareguard-shape audit lines, unless `gate.record` and `gate.annotate` cover them as they are (docs/archive/agent-sandbox-prd.md:356-356).
- A run on a VPS (optional) (docs/archive/agent-sandbox-prd.md:357-357).
- A secret scrubber for bodies in the ask preview. Card numbers are masked. API keys and passwords are not, until bareguard's redaction covers them in M3 (docs/archive/agent-sandbox-prd.md:358-358).
- "Don't ask again for this run" (docs/archive/agent-sandbox-prd.md:359-359).
- Adopting bareguard's `isPrivateIp` (F4) (docs/archive/agent-sandbox-prd.md:360-360).
- Checking compressed (gzip) bodies for card numbers (docs/archive/agent-sandbox-prd.md:361-361).

## Open questions

None of these block M0. Nothing here is silently assumed (docs/archive/agent-sandbox-prd.md:821-822). The source still marks three as open.

- Q3: how the undo layer handles large untracked dirs (`node_modules`) and build output. It decides the M4 design (docs/archive/agent-sandbox-prd.md:828-828).
- Q5: how long a hold can last given server-side timeouts. It decides the approval timeout value in M2. The 120 s in the idea note's sketch is not tested (docs/archive/agent-sandbox-prd.md:830-830).
- Q9: the poll interval and default deadline for the file-channel ask. The recommendation is a 250 ms poll and a 120 s deadline, configurable, with timeout meaning deny. It decides M2.5 (docs/archive/agent-sandbox-prd.md:834-834).

## Decided questions

- Q1, proxy memory with bareguard loaded: budget set by the user as a range, 40 agents per proxy at most; about 145-175 MB, superseded Nov 2 by about 205-245 MB over HTTPS. Decided Oct 30 (docs/archive/agent-sandbox-prd.md:826-826).
- Q2, certificates: `openssl` subprocess, not `node-forge`. Decided Oct 26 (docs/archive/agent-sandbox-prd.md:827-827).
- Q4, localhost sockets (Postgres, Docker daemon): block. Decided Oct 26 for M0. M3 revisits only if a demo needs a local DB (docs/archive/agent-sandbox-prd.md:829-829).
- Q6, working name: barebox (npm and repo); the CLI stays `sbx` (docs/archive/agent-sandbox-prd.md:831-831).
- Q7, the agent's own model calls: labelled `r` by policy in barebox, not rwxmap. Decided Oct 29. Decided Nov 2 (user): model calls also skip the card floor; every other request keeps it (docs/archive/agent-sandbox-prd.md:832-832).
- Q8, "Don't ask again for this run": not in v1. Decided Oct 29 (docs/archive/agent-sandbox-prd.md:833-833).
- Q10, the hold decision never seeing the body: a 64 KB read-whole threshold with a card scan and a floor ask (never a deny); larger bodies stream unchecked (known gap); held bodies go to a file (cap 50 MB). Decided Oct 29 (docs/archive/agent-sandbox-prd.md:835-835).
