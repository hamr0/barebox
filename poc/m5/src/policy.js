// policy.js — the one owner of what each mode lets through.
//
// Every request becomes one bareguard action and one `gate.check()`. The
// mode only chooses the agent's letters and which unheld letters ask:
//   ask   -> holds "r--", asks for w and x
//   auto  -> holds "rw-", asks for x
//   trust -> holds "rwx", asks for nothing
// A request is one tool: `<vendor>.<operationId>` when a label file documents
// it (letters come from the gate file), `<host>.POST <path>` for a known model
// endpoint (`r`), else `http.<METHOD>`: GET and HEAD are `r`; POST, PUT, PATCH
// and DELETE are `x`. A tool that is not listed is denied (`rwx.unlisted`) in
// every mode. The card/payment floor
// is `flags`: it asks in every mode, trust included.
import { Gate } from 'bareguard';
import { matcherFrom } from 'rwxmap/match';

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

/** Model-call endpoints per host (`host[:port]`); each is `POST` and reads (`r`). */
const MODEL_PATHS = {
  'api.anthropic.com': ['/v1/messages', '/v1/messages/count_tokens'],
  'api.openai.com': ['/v1/chat/completions', '/v1/responses', '/v1/embeddings'],
};
const LOCAL_LLM_PATHS = ['/api/chat', '/api/generate', '/api/embed',
  '/v1/chat/completions', '/v1/completions'];

/** The matcher used when no label files are loaded: every request is request-only. */
export const emptyMatcher = matcherFrom([]);

/**
 * The one tools table of a runtime: the `http.*` tools, the model endpoints
 * (`r`) and the label tools. Model keys come from `matcher.match()` itself so
 * there is no second key builder.
 *
 * @param {Record<string, any>} [labelTools] the label files' gate-file tools (`{ key: { letter, marker } }`)
 * @param {string[]} [localLlm] `host:port` pairs of local model servers
 * @returns {Record<string, any>} tool name to letter
 */
export function buildTools(labelTools = {}, localLlm = []) {
  /** @type {Record<string, any>} */
  const models = {};
  const add = (scheme, host, paths) => {
    for (const p of paths) models[emptyMatcher.match('POST', `${scheme}://${host}${p}`).key] = 'r';
  };
  for (const [host, paths] of Object.entries(MODEL_PATHS)) add('https', host, paths);
  for (const hp of localLlm) add('http', hp, LOCAL_LLM_PATHS);
  return { ...TOOLS, ...models, ...labelTools };
}

/**
 * The tool name for one request. A spec key (a label file documents it) is
 * used as is, even if the gate file lacks it (then the gate denies it:
 * fail closed). A request-only key is used only when it is a known model
 * endpoint; everything else is `http.<METHOD>`. Never the matcher's letter.
 *
 * @param {{ match: (method: string, url: string) => { key: string, source: string } }} matcher
 * @param {Record<string, any>} tools the runtime's tools table
 * @param {string} method HTTP method
 * @param {string} url full request URL
 * @returns {string} the tool name
 */
export function toolFor(matcher, tools, method, url) {
  try {
    const r = matcher.match(method, url);
    if (r.source === 'spec' || Object.hasOwn(tools, r.key)) return r.key;
  } catch { /* not an http(s) URL: fall through */ }
  return `http.${method}`;
}

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
 * @param {Record<string, any>} [opts.tools] the runtime's tools table (default: the `http.*` tools)
 * @param {(event: any) => Promise<{ decision: 'allow' | 'deny', reason?: string }>} opts.humanChannel resolves every ask
 * @returns {Promise<Gate>} an initialised gate
 */
export async function gateFor({ agent, mode, auditPath, humanChannel, tools = TOOLS }) {
  if (!MODES.includes(mode)) {
    throw new Error(`policy: mode must be ${MODES.join('|')}, got ${JSON.stringify(mode)}`);
  }
  const { letters, askUnheld } = MODE_RULES[mode];
  const gate = new Gate({
    audit: { path: auditPath },
    rwx: { agent, agents: { [agent]: letters }, tools, askUnheld },
    // The mode letters plus the card/payment floor are the whole policy; bareguard's
    // default word patterns scan the URL and method and would fire before rwx.
    content: { askPatterns: [], denyPatterns: [] },
    flags: FLAGS,
    humanChannel,
  });
  await gate.init();
  return gate;
}
