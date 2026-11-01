// Secrets (M5): detect and apply, pure. No sandbox, no proxy.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSecrets, findPlaceholders, applySecrets } from '../src/secrets.js';

const REAL_A = 'sk_test_REAL_aaaaaaaaaaaaaaaa';
const REAL_B = 'ghp_REAL_bbbbbbbbbbbbbbbb';
const cfg = {
  STRIPE_API_KEY: { value: REAL_A, hosts: ['api.stripe.com'] },
  GITHUB_TOKEN: { fromEnv: 'HOSTVAR_GH', hosts: ['api.github.com', 'Uploads.GitHub.com'] },
};
const secrets = loadSecrets(cfg, { HOSTVAR_GH: REAL_B });
const [A, B] = secrets;
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');

describe('loadSecrets', () => {
  it('one entry per secret, fresh random placeholders each call', () => {
    assert.deepEqual(secrets.map((s) => s.name), ['STRIPE_API_KEY', 'GITHUB_TOKEN']);
    assert.equal(A.value, REAL_A);
    assert.equal(B.value, REAL_B);
    assert.match(A.placeholder, /^sbx-ph-[0-9a-f]{16}$/);
    assert.notEqual(A.placeholder, B.placeholder);
    const again = loadSecrets(cfg, { HOSTVAR_GH: REAL_B });
    assert.notEqual(again[0].placeholder, A.placeholder);
    assert.deepEqual(B.hosts, ['api.github.com', 'uploads.github.com']);
  });

  it('a missing value names the secret, never a value', () => {
    assert.throws(() => loadSecrets({ X: { fromEnv: 'NOPE', hosts: ['a.b'] } }, {}),
      (e) => e.message === 'secret X: no value');
  });
});

describe('findPlaceholders and applySecrets', () => {
  it('Authorization: Bearer <placeholder>', () => {
    const h = { authorization: `Bearer ${A.placeholder}`, accept: '*/*' };
    assert.deepEqual(findPlaceholders(h, 'api.stripe.com', secrets), [{ name: 'STRIPE_API_KEY', header: 'authorization', bound: true }]);
    const out = applySecrets(h, 'api.stripe.com', secrets);
    assert.equal(out.authorization, `Bearer ${REAL_A}`);
    assert.equal(out.accept, '*/*');
    assert.equal(h.authorization, `Bearer ${A.placeholder}`, 'the input is never changed');
  });

  it('x-api-key: <placeholder>', () => {
    const h = { 'x-api-key': A.placeholder };
    assert.deepEqual(findPlaceholders(h, 'api.stripe.com', secrets), [{ name: 'STRIPE_API_KEY', header: 'x-api-key', bound: true }]);
    assert.equal(applySecrets(h, 'api.stripe.com', secrets)['x-api-key'], REAL_A);
  });

  it('Basic base64(<placeholder>:) is decoded, swapped and re-encoded', () => {
    const h = { authorization: `Basic ${b64(`${A.placeholder}:`)}` };
    assert.deepEqual(findPlaceholders(h, 'api.stripe.com', secrets), [{ name: 'STRIPE_API_KEY', header: 'authorization', bound: true }]);
    assert.equal(applySecrets(h, 'api.stripe.com', secrets).authorization, `Basic ${b64(`${REAL_A}:`)}`);
  });

  it('a Basic value without a placeholder is left alone', () => {
    const h = { authorization: `Basic ${b64('user:pass')}` };
    assert.deepEqual(findPlaceholders(h, 'api.stripe.com', secrets), []);
    assert.equal(applySecrets(h, 'api.stripe.com', secrets).authorization, h.authorization);
  });

  it('array values: every element is searched and swapped', () => {
    const h = { 'set-cookie': ['a=1', `k=${A.placeholder}`] };
    assert.deepEqual(findPlaceholders(h, 'api.stripe.com', secrets), [{ name: 'STRIPE_API_KEY', header: 'set-cookie', bound: true }]);
    assert.deepEqual(applySecrets(h, 'api.stripe.com', secrets)['set-cookie'], ['a=1', `k=${REAL_A}`]);
  });

  it('an unbound host: found as bound:false, never swapped', () => {
    const h = { authorization: `Bearer ${A.placeholder}` };
    assert.deepEqual(findPlaceholders(h, 'httpbin.org', secrets), [{ name: 'STRIPE_API_KEY', header: 'authorization', bound: false }]);
    assert.equal(applySecrets(h, 'httpbin.org', secrets).authorization, `Bearer ${A.placeholder}`);
    // a secret bound elsewhere is still unbound here
    assert.equal(findPlaceholders({ authorization: A.placeholder }, 'api.github.com', secrets)[0].bound, false);
  });

  it('two secrets in one header, each to its own value', () => {
    const h = { 'x-both': `${A.placeholder}+${B.placeholder}` };
    const f = findPlaceholders(h, 'api.stripe.com', secrets);
    assert.deepEqual(f.map((x) => [x.name, x.bound]), [['STRIPE_API_KEY', true], ['GITHUB_TOKEN', false]]);
    // each secret swaps only on a host it is bound to
    assert.equal(applySecrets(h, 'api.stripe.com', secrets)['x-both'], `${REAL_A}+${B.placeholder}`);
    const both = loadSecrets({ P: { value: 'one', hosts: ['x.test'] }, Q: { value: 'two', hosts: ['x.test'] } });
    const hh = { 'x-both': `${both[0].placeholder}+${both[1].placeholder}` };
    assert.equal(applySecrets(hh, 'x.test', both)['x-both'], 'one+two');
  });

  it('the host compares by name, case-insensitive', () => {
    const h = { authorization: B.placeholder };
    assert.equal(applySecrets(h, 'API.GitHub.com', secrets).authorization, REAL_B);
    assert.equal(applySecrets(h, 'uploads.github.com', secrets).authorization, REAL_B);
  });

  it('a non-ASCII real value survives the Basic round trip', () => {
    const s = loadSecrets({ U: { value: 'ключ-é', hosts: ['x.test'] } });
    const out = applySecrets({ authorization: `Basic ${b64(`${s[0].placeholder}:`)}` }, 'x.test', s);
    assert.equal(Buffer.from(out.authorization.slice(6), 'base64').toString('utf8'), 'ключ-é:');
  });
});
