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
import { requestKey } from 'rwxmap/discover';
import { endpointList, normalizeUrl } from './lists.js';

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

/** Built-in model-call endpoints (`POST`, `r`), as endpoint-list entries. */
const MODEL_PATHS = [
  'POST api.anthropic.com/v1/messages',
  'POST api.anthropic.com/v1/messages/count_tokens',
  'POST api.openai.com/v1/chat/completions',
  'POST api.openai.com/v1/responses',
  'POST api.openai.com/v1/embeddings',
];
/** The endpoints of one local model server (`host:port`), as list entries. */
const LOCAL_LLM_PATHS = ['/api/chat', '/api/generate', '/api/embed',
  '/v1/chat/completions', '/v1/completions'];

/** @param {string[]} localLlm `host:port` pairs @returns {string[]} every model endpoint entry */
function modelEntries(localLlm) {
  const entries = [...MODEL_PATHS];
  for (const hp of localLlm) for (const p of LOCAL_LLM_PATHS) entries.push(`POST ${hp.toLowerCase()}${p}`);
  return entries;
}

/** @param {string} entry `"POST host/path"` @returns {string} the model tool name for it (`<host>.POST <path>`) */
function modelToolName(entry) {
  const sp = entry.indexOf(' ');
  return requestKey(entry.slice(0, sp), `https://${entry.slice(sp + 1)}`);
}

/**
 * The model endpoints as one endpoint list (the built-ins plus each local server).
 *
 * @param {string[]} [localLlm] `host:port` pairs of local model servers
 * @returns {{ match: (method: string, url: string) => string | null }} matches to the entry string
 */
export function modelList(localLlm = []) {
  return endpointList(modelEntries(localLlm));
}

/** The matcher used when no label files are loaded: every request is request-only. */
export const emptyMatcher = matcherFrom([]);

/**
 * The one tools table of a runtime: the `http.*` tools, the model endpoints
 * (`r`) and the label tools. Model keys come from rwxmap's `requestKey`.
 *
 * @param {Record<string, any>} [labelTools] the label files' gate-file tools (`{ key: { letter, marker } }`)
 * @param {string[]} [localLlm] `host:port` pairs of local model servers
 * @returns {Record<string, any>} tool name to letter
 */
export function buildTools(labelTools = {}, localLlm = []) {
  /** @type {Record<string, any>} */
  const models = {};
  for (const k of modelKeys(localLlm)) models[k] = 'r';
  return { ...TOOLS, ...models, ...labelTools };
}

/** @param {string[]} localLlm @returns {Set<string>} every model endpoint's tool key */
function modelKeys(localLlm) {
  return new Set(modelEntries(localLlm).map(modelToolName));
}

/**
 * The tool keys that are model calls (they skip the card floor). A label
 * tool that shares a key wins in `buildTools`, so it is not a model here.
 *
 * @param {Record<string, any>} [labelTools] the label files' gate-file tools
 * @param {string[]} [localLlm] `host:port` pairs of local model servers
 * @returns {Set<string>} model tool keys
 */
export function modelTools(labelTools = {}, localLlm = []) {
  const keys = modelKeys(localLlm);
  for (const k of Object.keys(labelTools)) keys.delete(k);
  return keys;
}

/**
 * The tool name for one request, in order: a spec key (a label file documents
 * it) is used as is, even if the gate file lacks it (then the gate denies it:
 * fail closed); else a model endpoint's name when the tools table has it; else
 * `http.<METHOD>`. Never the matcher's letter. The host is normalised once
 * (`normalizeUrl`).
 *
 * @param {{ match: (method: string, url: string) => { key: string, source: string } }} matcher
 * @param {Record<string, any>} tools the runtime's tools table
 * @param {string} method HTTP method
 * @param {string} url full request URL
 * @param {{ match: (method: string, url: string) => string | null }} models the runtime's model list (`modelList(localLlm)`); required, no default
 * @returns {string} the tool name
 */
export function toolFor(matcher, tools, method, url, models) {
  let norm;
  try {
    norm = normalizeUrl(url);
  } catch { return `http.${method}`; } // not a URL
  // rwxmap's match() throws on a non-http(s) URL (ftp://...), so it is checked here, not caught.
  if (!/^https?:/.test(norm)) return `http.${method}`;
  const r = matcher.match(method, norm);
  if (r.source === 'spec') return r.key;
  const entry = models.match(method, norm);
  if (entry !== null) {
    const name = modelToolName(entry);
    if (Object.hasOwn(tools, name)) return name;
  }
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
    // Explicit letters and an empty sharedFile ('' is falsy: no file, and bareguard's
    // `??` stops there) keep the host's BAREGUARD_RWX_LETTERS / BAREGUARD_BUDGET_FILE out.
    rwx: { agent, letters, tools, askUnheld },
    budget: { sharedFile: '' },
    // The mode letters plus the card/payment floor are the whole policy; bareguard's
    // default word patterns scan the URL and method and would fire before rwx.
    content: { askPatterns: [], denyPatterns: [] },
    flags: FLAGS,
    humanChannel,
  });
  await gate.init();
  return gate;
}
