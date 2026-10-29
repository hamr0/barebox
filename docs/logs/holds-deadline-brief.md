# Holds brief: one deadline per reservation, from arrival (2026-10-28)

**For:** the build agent. **Branch:** `hardening`, on top of your uncommitted wall work (leave it
so). **Don't stage or commit.** Same nine rules as `docs/logs/hardening-brief.md`. Skip step 0.
Everything here is in `src/holds.js` and `test/holds.test.mjs`. **Your sandbox can run all of
it** (no sockets).

## Why (from `/self-review` of `43ffdbd`, reproduced by its worker in a real shell)

1. **The slot holder has no deadline.** `reserve` arms a timer only for waiters in line
   (`src/holds.js:541-553`). The `'now'` reservation, whose body is still being read, gets none
   (`:530`), and `add()` runs only when the body ends. A held POST dripping 1 byte every 300 ms
   still held its agent's slot after 9 s, while the agent's later held requests got 403 "hold
   timeout" at 2 s. Only Node's 300 s `requestTimeout` ends it. The user chose to fix this now.
2. **`add()` with a finished slot still parks.** `add({ slot })` links the slot only when it's
   still the live holder (`:476-483`). Otherwise it parks the entry **anyway**, with no slot. That
   can't be reached today. Once item 1 lets a holder expire, its body can still complete
   afterwards, and the agent then gets a second parked request whose client was already answered
   403.

## D1 (must): one timer per reservation, armed in `reserve`, from `arrivedAt`

Replace today's waiter-only timer with **one deadline timer per reservation, whatever its state**:

- `reserve` arms it for `'now'` and `'queued'` (not `'full'`) at `deadlineMs()` (`null` =
  `'never'` = no timer), unref'd, keyed to the reservation's internal state (the `handleState`
  record or the waiter record; your call, but **one** place).
- **Promotion does not reset it.** `releaseSlot` hands the slot to the next waiter and calls
  `onReady`, but the waiter's timer keeps running from its own arrival. Delete the
  `clearTimeout(next.timer)` there.
- **On expiry:** mark it done; if it's in the line, take it out of the line; if it holds the slot,
  call `releaseSlot(agent)` (the next waiter gets `onReady`); then `onExpire('hold timeout')`. Once.
- **Cleared by:** `add` consuming the slot (the parked entry's own timer takes over, still from
  `arrivedAt`, as today), `cancel`, and `close`.
- **`close()`:** today it expires only the waiters in line. It must also expire a `'now'` holder
  that hasn't been added yet: clear its timer and call its `onExpire('proxy closing')`, once. A
  parked entry is still settled by the existing `settle` loop, not twice.
- The holder's `onExpire` / `onReady` callbacks must be reachable for the holder too. Today
  `reserve` keeps them only in the waiter record. Store them where expiry and `close` can find
  them.

Keep **one** expiry path. If the old waiter timer and the new one both exist, you've done it wrong.

## D2 (must): `add()` refuses a finished slot

When `slot` is given and that slot is done (expired, cancelled, closed) or no longer the agent's
holder, `add` **parks nothing**: no queue entry, no ask file, no `'hold'` log line, no timer. It
returns `null`. Update `add`'s JSDoc `@returns` to `string|null`, and the `@returns` type of
`createHolds` for `add`. Without `slot`, `add` is unchanged: it still parks without limit (your
round-1 test h stays green).

The proxy side (`readHeld` ignoring a late body, destroying the dripping client) is the
orchestrator's, not yours.

## D3 (should, behaviour-neutral): fix one false comment

`releaseSlot`'s doc says "The single writer of slot state". It isn't: `add`, `cancel`, the timer
and `close` write it too. Reword it to say what it does: it hands the slot to the next waiter, or
forgets the agent. No code change.

## Tests (`test/holds.test.mjs`, in your `describe('one held request per agent')`)

Each new test red before D1/D2 (paste the lines), green after:
- (i) a `'now'` holder that is never added expires at about `timeoutMs` after **its** arrival:
  `onExpire('hold timeout')` once, and the next waiter gets `onReady`.
- (ii) a promoted waiter keeps its **arrival** deadline: B arrives at t≈0 behind A; A is decided
  at t≈60 % of `timeoutMs`; B (never added) expires at about `timeoutMs` after B's arrival, not
  after its promotion.
- (iii) `add` clears the holder's timer: no `onExpire` after `add`, even past the deadline. The
  parked entry then times out through `settle` at arrival + `timeoutMs`, once.
- (iv) `cancel` clears it: no `onExpire` after `cancel`.
- (v) `add` with an expired slot returns `null` and parks nothing (`pending()` empty, no `'hold'`
  log line); the next waiter is the holder.
- (vi) `close()` with an un-added `'now'` holder calls its `onExpire('proxy closing')` exactly once,
  and nothing fires afterwards.
- (vii) `timeoutMs: 'never'` arms no timer: a holder never expires within, say, 300 ms.

**Existing test you must update, not delete:** round-1 test (c) "a waiter still in line at its
deadline expires unread" holds A as an un-added `'now'` reservation. A now expires first (it
arrived first), so B is promoted (`onReady`) before its own deadline. Rewrite (c) to assert the
new truth: A expires, B gets `onReady`, then B (never added) expires at B's arrival deadline. Say
in the report what you changed and why.

**Mutations** (each red, then reverted, in `/tmp/bb-dmut`; delete it at the end):
1. no timer for `'now'` → (i) red;
2. promotion resets the timer (clear it and re-arm from now in `releaseSlot`) → (ii) red;
3. `add` doesn't clear the timer → (iii) red;
4. `add` parks a finished slot again → (v) red;
5. `close` skips the `'now'` holder → (vi) red.

## Not yours

`src/proxy.js` (ignore a late body after expiry, destroy the dripping client, attach the
`cres 'close'` cancel before the DNS await) and the socket tests in `test/proxy.test.mjs`. The
round-1 socket test "a waiter expires in line while the holder is still reading its body" will
change meaning with D1; the orchestrator rewrites it.

## Done when (tick each with evidence)

- [ ] D1: one timer per reservation (file:line), promotion keeps it, one expiry path, `close` covers
      the holder.
- [ ] D2: `add` returns `null` for a finished slot; JSDoc updated.
- [ ] D3: comment reworded.
- [ ] Tests (i)–(vii) red before, green after; (c) rewritten (say how); 5 mutations red, reverted.
- [ ] `npm run typecheck` clean; `npm run check:primitives` current.
- [ ] `npm test` totals, with every failing or skipped test listed with its error.
      `test/holds.test.mjs` itself must be fully green in your sandbox.
- [ ] `git status`: the wall files, plus `src/holds.js`, `test/holds.test.mjs`, this brief. Nothing
      else.
- [ ] `/tmp/bb-dmut` removed, no processes left.

**Report format:** D1, D2, D3, tests (red, green and mutation lines), the rule-2 list, then this
checklist.
