// Test gates for createProxy({ gateFor }): plain check objects, so proxy
// tests need no bareguard and no mode. An `askHuman` outcome goes to the
// proxy's own human channel (the hold queue), like a real gate's ask.

/**
 * A gate that asks for any URL whose path contains `substr` (rule `rule`),
 * asks for a card-like body (rule `flags.cardLike`, the floor), and allows
 * everything else.
 *
 * @param {string} [substr] path substring that asks
 * @param {string} [rule] the ask's rule
 * @returns {() => { check: (action: Record<string, any>) => Promise<{ outcome: string, rule?: string }> }} a `gateFor`
 */
export function pathGate(substr = '/hold', rule = 'test hold') {
  return () => ({
    async check(action) {
      if (action.cardLike) return { outcome: 'askHuman', rule: 'flags.cardLike' };
      if (new URL(action.url).pathname.includes(substr)) return { outcome: 'askHuman', rule };
      return { outcome: 'allow', rule: 'test.allow' };
    },
  });
}
