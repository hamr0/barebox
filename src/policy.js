// policy.js — the one owner of what each mode lets through.
//
// Every request becomes one bareguard action and one `gate.check()`. The
// mode only chooses the agent's letters and which unheld letters ask:
//   ask   -> holds "r--", asks for w and x
//   auto  -> holds "rw-", asks for x
//   trust -> holds "rwx", asks for nothing
// Until rwxmap lands (B2) every HTTP method is one tool, `http.<METHOD>`:
// GET and HEAD are `r`; POST, PUT, PATCH and DELETE are `x`. A method that is
// not listed is denied (`rwx.unlisted`) in every mode. The card/payment floor
// is `flags`: it asks in every mode, trust included.
import { Gate } from 'bareguard';

/** The mode names, in the order the CLI and config list them. */
export const MODES = ['ask', 'auto', 'trust'];

const MODE_RULES = {
  ask: { letters: 'r--', askUnheld: ['w', 'x'] },
  auto: { letters: 'rw-', askUnheld: ['x'] },
  trust: { letters: 'rwx', askUnheld: [] },
};

// One map for every gate (the grant comes from each gate's letters, never
// from the action).
const TOOLS = {
  'http.GET': 'r',
  'http.HEAD': 'r',
  'http.POST': 'x',
  'http.PUT': 'x',
  'http.PATCH': 'x',
  'http.DELETE': 'x',
};

/** @type {Record<string, Record<string, 'ask' | 'deny'>>} */
const FLAGS = { cardLike: { true: 'ask' }, paymentPath: { true: 'ask' } };

/** Payment-destination path fragments: the URL-visible half of the floor (PRD section 2). */
const PAYMENT_PATHS = ['/checkout', '/payment', '/orders', '/purchase'];

/**
 * True when the URL's path names a payment destination (the floor's
 * URL-visible half). An unparsable URL is not one.
 *
 * @param {string} url full request URL
 * @returns {boolean} whether the path contains a payment fragment
 */
export function paymentPath(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return PAYMENT_PATHS.some((p) => pathname.includes(p));
}

/**
 * Build and initialise one agent's gate.
 *
 * @param {object} opts
 * @param {string} opts.agent agent name (the gate's rwx agent)
 * @param {string} opts.mode `ask` | `auto` | `trust`
 * @param {string} opts.auditPath bareguard audit file (shared by every gate of a runtime)
 * @param {(event: any) => Promise<{ decision: 'allow' | 'deny', reason?: string }>} opts.humanChannel resolves every ask
 * @returns {Promise<Gate>} an initialised gate
 */
export async function gateFor({ agent, mode, auditPath, humanChannel }) {
  if (!MODES.includes(mode)) {
    throw new Error(`policy: mode must be ${MODES.join('|')}, got ${JSON.stringify(mode)}`);
  }
  const { letters, askUnheld } = MODE_RULES[mode];
  const gate = new Gate({
    audit: { path: auditPath },
    rwx: { agent, agents: { [agent]: letters }, tools: TOOLS, askUnheld },
    // The mode letters plus the card/payment floor are the whole policy; bareguard's
    // default word patterns scan the URL and method and would fire before rwx.
    content: { askPatterns: [], denyPatterns: [] },
    flags: FLAGS,
    humanChannel,
  });
  await gate.init();
  return gate;
}
