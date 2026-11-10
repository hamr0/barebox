// lists.js — the one owner of "does this request match an endpoint list?".
//
// A list is entries like `"POST gmail.googleapis.com/gmail/v1/users/{userId}/messages/send"`:
// `{name}` matches one path segment, everything else is exact. It is built on
// rwxmap's matcher with one sidecar per host (every row of a sidecar applies to
// every server in it). The host is checked in a Map first: rwxmap's `match()` runs
// a classifier on every miss, and most requests are for hosts on no list.
import { matcherFrom } from 'rwxmap/match';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The one place a request URL is normalised: one trailing dot is stripped from the
 * host (`api.anthropic.com.` is `api.anthropic.com`). Throws like `URL` on a non-URL.
 *
 * @param {string} url full request URL
 * @returns {string} the normalised URL
 */
export function normalizeUrl(url) {
  const u = new URL(url);
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
  return u.href;
}

/**
 * @param {string} entry `"METHOD host[:port]/path"`
 * @returns {{ method: string, host: string, path: string }} the parts; throws on a bad entry
 */
function parseEntry(entry) {
  const bad = (why) => new Error(`endpoint list: ${JSON.stringify(entry)}: ${why}`);
  if (typeof entry !== 'string') throw bad('must be a string');
  const sp = entry.indexOf(' ');
  const method = sp < 0 ? '' : entry.slice(0, sp);
  if (!METHODS.includes(method)) throw bad(`method must be one of ${METHODS.join(' ')} (upper case)`);
  const rest = entry.slice(sp + 1).trim();
  if (rest.includes('://')) throw bad('no scheme');
  if (rest.includes('*')) throw bad('no `*` (host patterns are not supported)');
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (!host) throw bad('host must not be empty');
  if (/:(443|80)$/.test(host)) throw bad('drop the default port (:443/:80); the URL host never carries it');
  if (host !== host.toLowerCase()) throw bad('host must be lower case');
  if (slash < 0) throw bad('path must start with /');
  return { method, host, path: rest.slice(slash) };
}

/**
 * Build an endpoint list.
 *
 * @param {string[]} entries `"METHOD host[:port]/path"` strings
 * @param {typeof matcherFrom} [makeMatcher] builds one host's matcher (a test counts its `match` calls)
 * @returns {{ match: (method: string, url: string) => string | null }} `match` returns the matched entry, else `null`
 */
export function endpointList(entries, makeMatcher = matcherFrom) {
  /** @type {Map<string, any[]>} */
  const rowsByHost = new Map();
  for (const entry of entries) {
    const { method, host, path } = parseEntry(entry);
    const rows = rowsByHost.get(host) ?? [];
    rowsByHost.set(host, rows);
    rows.push({ key: entry, method, path, letter: 'r', marker: 'settled' });
  }
  // One sidecar per host, never one for all of them.
  const byHost = new Map();
  for (const [host, hostRows] of rowsByHost) {
    byHost.set(host, makeMatcher([{ vendor: '', servers: [`https://${host}`], rows: hostRows }]));
  }
  return {
    match(method, url) {
      const u = new URL(normalizeUrl(url));
      const m = byHost.get(u.host);
      if (!m) return null;
      const r = m.match(method, u.href);
      return r.source === 'spec' ? r.key : null;
    },
  };
}
