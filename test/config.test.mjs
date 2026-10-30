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
    assert.deepEqual(loadConfig({ XDG_CONFIG_HOME }), { mode: 'auto', holdTimeoutSec: 120, localLlm: [], labels: [], tenants: {} });
  });

  it('the file\'s mode and holdTimeoutSec are used', () => {
    const { XDG_CONFIG_HOME } = xdg('{"mode":"ask","holdTimeoutSec":"never"}');
    assert.deepEqual(resolveConfig({}, { XDG_CONFIG_HOME }), { mode: 'ask', holdTimeoutSec: 'never', localLlm: [], labels: [], tenants: {} });
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
