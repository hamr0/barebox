// Config tests: the one config file, read by the CLI only. All pure or
// error-path (no sandbox needed): a bad file makes `sbx run` exit 2 before
// any proxy or bwrap starts.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, resolveConfig } from '../src/config.js';

const execA = promisify(execFileCb);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/cli.js');

describe('config file', () => {
  let root, n = 0;
  before(() => { root = mkdtempSync(join(tmpdir(), 'bb-cfg-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  /** A fresh XDG dir holding `text` as the config file (or none). @returns {{ XDG_CONFIG_HOME: string, file: string }} */
  function xdg(text) {
    const dir = join(root, `x${n++}`);
    const file = join(dir, 'barebox', 'config.json');
    mkdirSync(join(dir, 'barebox'), { recursive: true });
    if (text !== undefined) writeFileSync(file, text);
    return { XDG_CONFIG_HOME: dir, file };
  }

  it('the path is XDG_CONFIG_HOME, else $HOME/.config', () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: '/x' }), '/x/barebox/config.json');
    assert.equal(configPath({ HOME: '/h' }), '/h/.config/barebox/config.json');
  });

  it('no file means the defaults', () => {
    const { XDG_CONFIG_HOME } = xdg();
    assert.deepEqual(loadConfig({ XDG_CONFIG_HOME }), { mode: 'auto', holdTimeoutSec: 'never', localLlm: [], labels: [], tenants: {} });
  });

  it('the file\'s mode and holdTimeoutSec are used', () => {
    const { XDG_CONFIG_HOME } = xdg('{"mode":"ask","holdTimeoutSec":"never"}');
    assert.deepEqual(resolveConfig({}, { XDG_CONFIG_HOME }), { mode: 'ask', holdTimeoutSec: 'never', localLlm: [], labels: [], tenants: {} });
  });

  it('a CLI --hold beats the file key; "never" and positive integers pass, anything else names --hold', () => {
    const { XDG_CONFIG_HOME } = xdg('{"holdTimeoutSec":60}');
    assert.equal(resolveConfig({ hold: '5' }, { XDG_CONFIG_HOME }).holdTimeoutSec, 5);
    assert.equal(resolveConfig({ hold: 'never' }, { XDG_CONFIG_HOME }).holdTimeoutSec, 'never');
    for (const bad of ['0', '1.5', 'soon', '-3', '']) {
      assert.throws(() => resolveConfig({ hold: bad }, { XDG_CONFIG_HOME }), /--hold/, bad);
    }
  });

  it('a CLI --mode beats the file; the file still beats the default for the rest', () => {
    const { XDG_CONFIG_HOME } = xdg('{"mode":"ask","holdTimeoutSec":30}');
    assert.deepEqual(resolveConfig({ mode: 'trust' }, { XDG_CONFIG_HOME }), { mode: 'trust', holdTimeoutSec: 30, localLlm: [], labels: [], tenants: {} });
  });

  it('an unknown key is refused, naming the file and the key', () => {
    const { XDG_CONFIG_HOME, file } = xdg('{"mode":"ask","frobnicate":1}');
    assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
      (e) => e.message.includes(file) && e.message.includes('"frobnicate"'));
  });

  it('bad values are refused, naming the key', () => {
    for (const [text, key] of [['{"mode":"yolo"}', 'mode'], ['{"holdTimeoutSec":0}', 'holdTimeoutSec'],
      ['{"holdTimeoutSec":1.5}', 'holdTimeoutSec'], ['{"holdTimeoutSec":"soon"}', 'holdTimeoutSec']]) {
      const { XDG_CONFIG_HOME, file } = xdg(text);
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes(`"${key}"`), text);
    }
  });

  it('heldBodyMaxMB: a positive integer is read, absent means the library default, bad values name the key', () => {
    const ok = xdg('{"heldBodyMaxMB":8}');
    assert.equal(resolveConfig({}, { XDG_CONFIG_HOME: ok.XDG_CONFIG_HOME }).heldBodyMaxMB, 8);
    assert.equal('heldBodyMaxMB' in loadConfig({ XDG_CONFIG_HOME: xdg().XDG_CONFIG_HOME }), false);
    for (const text of ['{"heldBodyMaxMB":0}', '{"heldBodyMaxMB":-1}', '{"heldBodyMaxMB":1.5}',
      '{"heldBodyMaxMB":"50"}', '{"heldBodyMaxMB":null}', '{"heldBodyMaxMB":"never"}']) {
      const { XDG_CONFIG_HOME, file } = xdg(text);
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes('"heldBodyMaxMB"'), text);
    }
  });

  it('labels and tenants: accepted, defaults empty, each bad shape names the key', () => {
    const good = '{"labels":["~/rwx/jira","/abs/x"],"tenants":{"jira":["https://acme.atlassian.net"]}}';
    const c = loadConfig({ XDG_CONFIG_HOME: xdg(good).XDG_CONFIG_HOME });
    assert.deepEqual(c.labels, ['~/rwx/jira', '/abs/x']);
    assert.deepEqual(c.tenants, { jira: ['https://acme.atlassian.net'] });
    const d = loadConfig({ XDG_CONFIG_HOME: xdg().XDG_CONFIG_HOME });
    assert.deepEqual([d.labels, d.tenants], [[], {}]);
    const bad = [['labels', '{"labels":"x"}'], ['labels', '{"labels":[1]}'],
      ['tenants', '{"tenants":[]}'], ['tenants', '{"tenants":{"j":"https://a.b"}}'],
      ['tenants', '{"tenants":{"j":[]}}'], ['tenants', '{"tenants":{"j":[3]}}'],
      ['tenants', '{"tenants":{"j":["ftp://a.b"]}}'], ['tenants', '{"tenants":{"j":["acme.net"]}}']];
    for (const [key, text] of bad) {
      const { XDG_CONFIG_HOME, file } = xdg(text);
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes(`"${key}"`), text);
    }
  });

  it('localLlm: host:port strings are read, default is empty, bad values name the key', () => {
    const ok = xdg('{"localLlm":["127.0.0.1:11434","localhost:8080"]}');
    assert.deepEqual(resolveConfig({}, { XDG_CONFIG_HOME: ok.XDG_CONFIG_HOME }).localLlm,
      ['127.0.0.1:11434', 'localhost:8080']);
    assert.deepEqual(loadConfig({ XDG_CONFIG_HOME: xdg().XDG_CONFIG_HOME }).localLlm, []);
    for (const text of ['{"localLlm":"127.0.0.1:1"}', '{"localLlm":[1]}', '{"localLlm":["nohost"]}',
      '{"localLlm":["a:0"]}', '{"localLlm":["a:70000"]}', '{"localLlm":["http://a:80"]}',
      '{"localLlm":["a:80/x"]}', '{"localLlm":[null]}']) {
      const { XDG_CONFIG_HOME, file } = xdg(text);
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes('"localLlm"'), text);
    }
  });

  it('env and secrets: a good shape is read as written', () => {
    const text = JSON.stringify({ env: { pass: ['MY_VAR'], set: { FOO: 'bar' } },
      secrets: { STRIPE_API_KEY: { fromEnv: 'HOSTVAR', hosts: ['api.stripe.com'] }, TWO: { value: 'v', hosts: ['a.test'] } } });
    const { XDG_CONFIG_HOME } = xdg(text);
    const cfg = loadConfig({ XDG_CONFIG_HOME, HOSTVAR: 'x' });
    assert.deepEqual(cfg.env, { pass: ['MY_VAR'], set: { FOO: 'bar' } });
    assert.deepEqual(Object.keys(cfg.secrets), ['STRIPE_API_KEY', 'TWO']);
  });

  it('env.pass refuses a secret-looking name, case-insensitively, naming the file and the name', () => {
    for (const n of ['GITHUB_TOKEN', 'my_api_key', 'DB_Password', 'CLIENT_SECRET']) {
      const { XDG_CONFIG_HOME, file } = xdg(JSON.stringify({ env: { pass: ['TERM', n] } }));
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes(`env.pass: "${n}" looks like a secret; use "secrets" for it`), n);
    }
    // env.set covers a harmless match
    const ok = xdg(JSON.stringify({ env: { set: { MY_KEY_NAME: 'harmless' } } }));
    assert.equal(loadConfig({ XDG_CONFIG_HOME: ok.XDG_CONFIG_HOME }).env.set.MY_KEY_NAME, 'harmless');
  });

  it('env: bad names and shapes are refused', () => {
    for (const env of [{ pass: ['1BAD'] }, { pass: 'TERM' }, { set: { 'a-b': 'x' } }, { set: { A: 1 } }, { extra: 1 }, []]) {
      const { XDG_CONFIG_HOME, file } = xdg(JSON.stringify({ env }));
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
        (e) => e.message.includes(file) && e.message.includes('key "env"') && !/unknown key/.test(e.message), JSON.stringify(env));
    }
  });

  it('a secret with both fromEnv and value, with neither, or with no hosts is refused', () => {
    const bad = [
      { S: { fromEnv: 'H', value: 'v', hosts: ['a.test'] } },
      { S: { hosts: ['a.test'] } },
      { S: { value: 'v' } },
      { S: { value: 'v', hosts: [] } },
      { S: { value: 'v', hosts: ['https://a.test'] } },
      { S: { value: 'v', hosts: ['a.test:443'] } },
      { S: { value: '', hosts: ['a.test'] } },
      { 'BAD-NAME': { value: 'v', hosts: ['a.test'] } },
      { S: { value: 'v', hosts: ['a.test'], extra: 1 } },
    ];
    for (const secrets of bad) {
      const { XDG_CONFIG_HOME, file } = xdg(JSON.stringify({ secrets }));
      assert.throws(() => loadConfig({ XDG_CONFIG_HOME, H: 'x' }),
        (e) => e.message.includes(file) && e.message.includes('key "secrets"') && !/unknown key/.test(e.message), JSON.stringify(secrets));
    }
  });

  it('a fromEnv variable that is not set fails at startup, naming the secret and never a value', () => {
    const { XDG_CONFIG_HOME, file } = xdg(JSON.stringify({ secrets: { STRIPE_API_KEY: { fromEnv: 'NOT_SET_ANYWHERE', hosts: ['api.stripe.com'] } } }));
    assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
      (e) => e.message === `${file}: secret STRIPE_API_KEY: host variable NOT_SET_ANYWHERE is not set`);
  });

  it('sbx run exits 2 for a secret-looking env.pass, before starting anything', async () => {
    const { XDG_CONFIG_HOME, file } = xdg(JSON.stringify({ env: { pass: ['GITHUB_TOKEN'] } }));
    const err = await execA('node', [CLI, 'run', '--', 'true'],
      { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME } }).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.ok(err.stderr.includes(file) && err.stderr.includes('use "secrets" for it'), err.stderr);
  });

  it('bad JSON is refused, naming the file', () => {
    const { XDG_CONFIG_HOME, file } = xdg('{not json');
    assert.throws(() => loadConfig({ XDG_CONFIG_HOME }),
      (e) => e.message.includes(file) && /invalid JSON/.test(e.message));
  });

  it('sbx run exits 2 with the file and key on stderr, before starting anything', async () => {
    const { XDG_CONFIG_HOME, file } = xdg('{"nope":true}');
    const err = await execA('node', [CLI, 'run', '--', 'true'],
      { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME } }).then(() => null, (e) => e);
    assert.ok(err, 'must fail');
    assert.equal(err.code, 2);
    assert.ok(err.stderr.includes(file) && err.stderr.includes('"nope"'), err.stderr);
    assert.equal(err.stdout, '');
  });
});
