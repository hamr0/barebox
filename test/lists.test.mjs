// Endpoint lists (src/lists.js): entries, templates, validation, the host pre-check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matcherFrom } from 'rwxmap/match';
import { endpointList, normalizeUrl } from '../src/lists.js';

const SEND = 'POST gmail.googleapis.com/gmail/v1/users/{userId}/messages/send';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users';

describe('endpointList', () => {
  it('a {name} template matches one segment, with or without a query', () => {
    const l = endpointList([SEND]);
    assert.equal(l.match('POST', `${BASE}/me/messages/send`), SEND);
    assert.equal(l.match('POST', `${BASE}/me/messages/send?x=1`), SEND);
    assert.equal(l.match('POST', `${BASE}/me/x/messages/send`), null);
    assert.equal(l.match('GET', `${BASE}/me/messages/send`), null);
    assert.equal(l.match('POST', 'https://gmail.googleapis.com:8443/gmail/v1/users/me/messages/send'), null);
  });

  it('a host with a trailing dot matches like the host without it', () => {
    const l = endpointList([SEND]);
    assert.equal(l.match('POST', 'https://gmail.googleapis.com./gmail/v1/users/me/messages/send'), SEND);
  });

  it('a host with a port matches only that port', () => {
    const l = endpointList(['POST 127.0.0.1:11434/api/chat']);
    assert.equal(l.match('POST', 'http://127.0.0.1:11434/api/chat'), 'POST 127.0.0.1:11434/api/chat');
    assert.equal(l.match('POST', 'http://127.0.0.1:11435/api/chat'), null);
  });

  it('each bad entry throws naming the entry', () => {
    for (const bad of ['post x/y', 'POST x', 'POST https://x/y', 'POST *.x/y', 'POST /y', 'POST X.com/y', 'POST x.com:443/y', 'POST x.com:80/y']) {
      assert.throws(() => endpointList([bad]), (e) => e.message.startsWith(`endpoint list: ${JSON.stringify(bad)}: `), bad);
    }
  });

  it('rwxmap match() runs only for a host on the list', () => {
    let calls = 0;
    const l = endpointList([SEND], (sidecars) => {
      const m = matcherFrom(sidecars);
      return { match: (...a) => { calls++; return m.match(...a); } };
    });
    assert.equal(l.match('POST', 'https://example.org/a/b'), null);
    assert.equal(l.match('POST', 'https://gmail.googleapis.com.evil.org/a/b'), null);
    assert.equal(calls, 0);
    assert.equal(l.match('POST', `${BASE}/me/messages/send`), SEND);
    assert.equal(calls, 1);
  });
});

describe('normalizeUrl', () => {
  it('strips one trailing dot and throws on a non-URL', () => {
    assert.equal(normalizeUrl('https://api.anthropic.com./v1/messages'), 'https://api.anthropic.com/v1/messages');
    assert.throws(() => normalizeUrl('not a url'));
  });
});
