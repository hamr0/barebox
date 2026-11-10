---
title: Hackathon plan
description: The day-by-day hackathon schedule, Oct 26 to Nov 5, with what each day delivered. Historical record.
---

# Hackathon plan

The hackathon ran from Oct 26 to Nov 5, ending at 01:00 Amsterdam time (docs/archive/agent-sandbox-prd.md:694-694).
This page records the plan per day and what each day delivered.
The schedule shifted as the proofs of concept (POCs) returned (docs/archive/agent-sandbox-prd.md:696-696).

## Review rule

Each module got a review cap: one self-review and one branch-review (docs/archive/agent-sandbox-prd.md:696-696).
Small nits went to the fix ledger. They did not trigger more review rounds (docs/archive/agent-sandbox-prd.md:696-696).

## Schedule

| Day | Date | Work | Gate |
|---|---|---|---|
| 1 | Oct 26 | M0, M1, M2 POCs | Go/no-go (a), (b), (c) met |
| 2 | Oct 27 | Graduation rewrite, reviews, rewrite bench | Branch review: ready |
| 3 | Oct 28 | M2.5 ask seam, M4 undo layer, hardening, release 0.4.0 | 0.4.0 on npm |
| 4 | Oct 29 | M3 scoping, memory POC | none |
| 5-6 | Oct 30-31 | M3 build and review | Proxy memory at 40 agents |
| 7 | Nov 1 | M5 (keys) | none |
| 8 | Nov 2 | M6 numbers, Demo B | Memory targets measured |
| 9 | Nov 3 | Demo A, README, freeze in the evening | none |
| 10 | Nov 4 | Release 0.9.0 and submission | none |
| 11 | Nov 5 | Buffer only, before 01:00 Amsterdam time | none |

(docs/archive/agent-sandbox-prd.md:698-709)

## What each day delivered

### Day 1, Oct 26

The M0, M1 and M2 POCs were the work. All three go/no-go checks passed (docs/archive/agent-sandbox-prd.md:700-700).
The gate was go/no-go (a), (b) and (c) (docs/archive/agent-sandbox-prd.md:700-700).

### Day 2, Oct 27

The work was the graduation rewrite, the reviews and the rewrite bench. It was done (docs/archive/agent-sandbox-prd.md:701-701).
The gate was a branch review with the result "ready" (docs/archive/agent-sandbox-prd.md:701-701).

### Day 3, Oct 28

The work was the M2.5 ask seam, the M4 undo layer, hardening and the 0.4.0 release. It was done (docs/archive/agent-sandbox-prd.md:702-702).
The gate was 0.4.0 on npm (docs/archive/agent-sandbox-prd.md:702-702).

### Day 4, Oct 29

The work was M3 scoping and the memory POC. Rounds 1 and 2 were done (docs/archive/agent-sandbox-prd.md:703-703).
This day had no gate (docs/archive/agent-sandbox-prd.md:703-703).

### Days 5 and 6, Oct 30-31

The work was the M3 build and review. bareguard 0.29.0 and rwxmap 0.8.0 landed upstream (docs/archive/agent-sandbox-prd.md:704-704).
Release 0.5.0 was done on Oct 30 (docs/archive/agent-sandbox-prd.md:704-704).

The gate was proxy memory at 40 agents, on bareguard 0.30.0, pinned. The measured range was 143-172 MB, from a quiet to a busy machine. The target was about 145-175 MB. It was re-decided on Oct 30. It had been 80 MB or less (docs/archive/agent-sandbox-prd.md:704-704).
On Nov 2 this was superseded. Over HTTPS the range became about 205-245 MB (see M6) (docs/archive/agent-sandbox-prd.md:704-704).

### Day 7, Nov 1

The work was M5 (keys). There was no gate (docs/archive/agent-sandbox-prd.md:705-705).
Release 0.6.0 shipped M5 on Nov 1 (docs/archive/agent-sandbox-prd.md:708-708).

### Day 8, Nov 2

The work was the M6 numbers and Demo B (docs/archive/agent-sandbox-prd.md:706-706).
The gate was memory targets measured (docs/archive/agent-sandbox-prd.md:706-706).
Release 0.8.0 shipped on Nov 2 (docs/archive/agent-sandbox-prd.md:708-708).

### Day 9, Nov 3

The work was Demo A and the README. The project froze in the evening (docs/archive/agent-sandbox-prd.md:707-707).

### Day 10, Nov 4

The work was release 0.9.0 and the submission (docs/archive/agent-sandbox-prd.md:708-708).

### Day 11, Nov 5

This day was buffer only, before 01:00 Amsterdam time (docs/archive/agent-sandbox-prd.md:709-709).

## Upstream dependencies

Two upstream items landed in their own repos and gated the `auto` and `ask` modes of M3 (docs/archive/agent-sandbox-prd.md:711-711).
F1 was bareguard `askUnheld`. F2 was the rwxmap `match` entry (docs/archive/agent-sandbox-prd.md:711-711).
The fallback was that if either slipped, M3 would ship `trust` plus the floor first (docs/archive/agent-sandbox-prd.md:711-711).

## Status of the plan

Days 1-3 were recorded as results. The source marked the remaining days as plan (docs/archive/agent-sandbox-prd.md:711-711).
