// Launcher tests: validation pure, walls need bwrap (real shell/CI, not sandbox).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import net from 'node:net';
import { launch, buildCaBundle } from '../src/launcher.js';
import { bwrapUsable } from './fixtures/probes.mjs';

function canUnix() {
  return new Promise((resolve) => {
    const p = join(tmpdir(), `bb-lprobe-${process.pid}.sock`);
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(p, () => s.close(() => { try { rmSync(p); } catch {} resolve(true); }));
  });
}
const UNIX_OK = await canUnix();
const NEED_SANDBOX = !bwrapUsable() ? 'needs bwrap; run in a real shell or CI'
  : (!UNIX_OK ? 'unix socket bind blocked here; run in a real shell or CI' : false);


function run(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${out}${err}`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('launch validation (no sandbox needed)', () => {
  it('throws on missing inputs', () => {
    assert.throws(() => launch({}), /runtime/);
    assert.throws(() => launch({ runtime: '/x', agent: 'a', proj: '/y', command: [] }), /command/);
  });

  it('rejects bad agent names before touching the filesystem', () => {
    for (const bad of ['../evil', 'UPPER', 'has space', 'a'.repeat(40)]) {
      assert.throws(() => launch({ runtime: '/x', agent: bad, proj: '/y', command: ['true'] }),
        /bad agent name/, JSON.stringify(bad));
    }
  });

  it('refuses a socket that disagrees with <runtime>/socks/<agent>.sock', () => {
    assert.throws(() => launch({ runtime: '/x', agent: 'a', proj: '/y',
      command: ['true'], socket: '/elsewhere.sock' }), /disagrees/);
  });

  it('rejects a non-integer proxyPort before spawning (shell injection)', () => {
    const base = { runtime: '/x', agent: 'a', proj: '/y', command: ['true'] };
    assert.throws(() => launch({ ...base, proxyPort: '3128;touch /tmp/x' }), /proxyPort/);
    assert.throws(() => launch({ ...base, proxyPort: 0 }), /proxyPort/);
    assert.throws(() => launch({ ...base, proxyPort: 70000 }), /proxyPort/);
    assert.throws(() => launch({ ...base, proxyPort: 3.5 }), /proxyPort/);
  });

  it('fails loudly past the ~108-char socket path limit', () => {
    const rt = join(tmpdir(), `bb-long-${'d'.repeat(90)}`);
    assert.throws(() => launch({ runtime: rt, agent: 'agent', proj: '/y', command: ['true'] }),
      /too long \(\d+ > 107\)/);
  });

  it('refuses a runtime that IS HOME or the project dir', () => {
    const saved = process.env.HOME;
    const root = mkdtempSync(join(tmpdir(), 'bb-rt-'));
    try {
      process.env.HOME = root;
      const proj = join(root, 'p');
      mkdirSync(proj, { recursive: true });
      assert.throws(() => launch({ runtime: root, agent: 'a', proj, command: ['true'] }),
        /must not be HOME/);
      assert.throws(() => launch({ runtime: proj, agent: 'a', proj, command: ['true'] }),
        /must not be the project dir/);
    } finally {
      process.env.HOME = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mount order for a project under $HOME (no sandbox needed)', () => {
  // Setup-independent: a fake `bwrap` on PATH records its argv and exits 0,
  // so the mount ORDER is asserted without any sandbox. bwrap mounts cover
  // what is below them (later wins), so $HOME read-only must come FIRST,
  // then the project (overlay or read-only), then locked-path tmpfs masks,
  // then runtime masks.
  let binDir, prevPath, prevArgsFile, savedHome;
  const argsFile = () => process.env.BB_ARGS_FILE;
  before(() => {
    binDir = mkdtempSync(join(tmpdir(), 'bb-fakebin-'));
    const out = join(binDir, 'args');
    writeFileSync(join(binDir, 'bwrap'),
      '#!/bin/sh\n[ "$1" = "--version" ] && { echo "bubblewrap 0.12.0"; exit 0; }\nprintf \'%s\\n\' "$@" > "$BB_ARGS_FILE"\nexit 0\n');
    chmodSync(join(binDir, 'bwrap'), 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath}`;
    prevArgsFile = process.env.BB_ARGS_FILE;
    process.env.BB_ARGS_FILE = out;
    savedHome = process.env.HOME;
  });
  after(() => {
    process.env.PATH = prevPath;
    if (prevArgsFile === undefined) delete process.env.BB_ARGS_FILE;
    else process.env.BB_ARGS_FILE = prevArgsFile;
    process.env.HOME = savedHome;
    rmSync(binDir, { recursive: true, force: true });
  });

  async function launchArgs(opts) {
    rmSync(argsFile(), { force: true });
    const child = launch(opts);
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return readFileSync(argsFile(), 'utf8').split('\n').filter((l) => l !== '');
  }

  /** Index of a consecutive argv run, or -1. */
  const idxOf = (args, ...seq) =>
    args.findIndex((_, i) => seq.every((s, k) => args[i + k] === s));

  it('overlay: $HOME read-only lands before the project overlay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-mo-'));
    try {
      const home = join(root, 'home');
      const proj = join(home, 'proj');
      const rt = join(root, 'rt');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, 'f.txt'), 'x\n');
      process.env.HOME = home;
      const args = await launchArgs({ runtime: rt, agent: 'mo', proj, command: ['true'], overlay: true });
      const homeIdx = idxOf(args, '--ro-bind', home, home);
      const ovIdx = idxOf(args, '--overlay-src', proj);
      assert.ok(homeIdx >= 0, `home bind missing in ${args.join(' ')}`);
      assert.ok(ovIdx >= 0, `project overlay missing in ${args.join(' ')}`);
      assert.ok(homeIdx < ovIdx, `home bind must precede the project overlay (got ${homeIdx} vs ${ovIdx})`);
    } finally {
      process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no overlay: $HOME read-only lands before the project read-only bind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-mo-'));
    try {
      const home = join(root, 'home');
      const proj = join(home, 'proj');
      const rt = join(root, 'rt');
      mkdirSync(proj, { recursive: true });
      process.env.HOME = home;
      const args = await launchArgs({ runtime: rt, agent: 'mp', proj, command: ['true'] });
      const homeIdx = idxOf(args, '--ro-bind', home, home);
      const projIdx = idxOf(args, '--ro-bind', proj, proj);
      assert.ok(homeIdx >= 0 && projIdx >= 0, `binds missing in ${args.join(' ')}`);
      assert.ok(homeIdx < projIdx, `home bind must precede the project bind (got ${homeIdx} vs ${projIdx})`);
    } finally {
      process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('always detaches the terminal (--new-session), even when stdin is a TTY', async () => {
    // Pretend the caller sits at a terminal: the flag must not depend on it.
    const root = mkdtempSync(join(tmpdir(), 'bb-mo-'));
    const savedTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    try {
      const home = join(root, 'home');
      const proj = join(home, 'proj');
      const rt = join(root, 'rt');
      mkdirSync(proj, { recursive: true });
      process.env.HOME = home;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const args = await launchArgs({ runtime: rt, agent: 'ns', proj, command: ['true'] });
      assert.ok(args.includes('--new-session'), `--new-session missing in ${args.join(' ')}`);
    } finally {
      if (savedTty) Object.defineProperty(process.stdin, 'isTTY', savedTty);
      else delete process.stdin.isTTY;
      process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a locked path inside the project stays masked after the project mount', async () => {
    // The project IS $HOME here and holds its own `.ssh`: the locked tmpfs
    // must land on top of the project mount, or the real drawer leaks
    // through the overlay.
    const root = mkdtempSync(join(tmpdir(), 'bb-mo-'));
    try {
      const home = join(root, 'home');
      const rt = join(root, 'rt');
      mkdirSync(join(home, '.ssh'), { recursive: true });
      writeFileSync(join(home, '.ssh', 'id_test'), 'secret\n');
      writeFileSync(join(home, 'f.txt'), 'x\n');
      process.env.HOME = home;
      const args = await launchArgs({ runtime: rt, agent: 'ml', proj: home, command: ['true'], overlay: true });
      const homeIdx = idxOf(args, '--ro-bind', home, home);
      const ovIdx = idxOf(args, '--overlay-src', home);
      const lockIdx = idxOf(args, '--tmpfs', join(home, '.ssh'));
      assert.ok(homeIdx >= 0 && ovIdx >= 0, `binds missing in ${args.join(' ')}`);
      assert.ok(lockIdx >= 0, `locked mask missing in ${args.join(' ')}`);
      assert.ok(homeIdx < ovIdx, 'home bind must precede the project mount');
      assert.ok(lockIdx > ovIdx, `locked mask must follow the project mount (got ${lockIdx} vs ${ovIdx})`);
    } finally {
      process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('locked file masks (no sandbox needed)', () => {
  // Fake bwrap again: a file is masked with a /dev/null bind (never --tmpfs),
  // a symlinked file at its real target, and both land after the project mount.
  let binDir, prevPath, prevArgsFile, savedHome, root;
  before(() => {
    binDir = mkdtempSync(join(tmpdir(), 'bb-fakebin-'));
    writeFileSync(join(binDir, 'bwrap'),
      '#!/bin/sh\n[ "$1" = "--version" ] && { echo "bubblewrap 0.12.0"; exit 0; }\nprintf \'%s\\n\' "$@" > "$BB_ARGS_FILE"\nexit 0\n');
    chmodSync(join(binDir, 'bwrap'), 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath}`;
    prevArgsFile = process.env.BB_ARGS_FILE;
    process.env.BB_ARGS_FILE = join(binDir, 'args');
    savedHome = process.env.HOME;
    root = mkdtempSync(join(tmpdir(), 'bb-lf-'));
  });
  after(() => {
    process.env.PATH = prevPath;
    if (prevArgsFile === undefined) delete process.env.BB_ARGS_FILE;
    else process.env.BB_ARGS_FILE = prevArgsFile;
    process.env.HOME = savedHome;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('masks a file with /dev/null, a symlink at its target, a dir with tmpfs; skips absent and outside-link', async () => {
    const home = join(root, 'home'); const proj = join(root, 'proj'); const rt = join(root, 'rt');
    mkdirSync(join(home, '.aws'), { recursive: true });
    mkdirSync(join(home, 'dotfiles'));
    mkdirSync(proj);
    writeFileSync(join(home, '.netrc'), 'n');
    writeFileSync(join(home, 'dotfiles', 'npmrc'), 't');
    symlinkSync('dotfiles/npmrc', join(home, '.npmrc'));
    const outside = join(root, 'outside-pypirc');
    writeFileSync(outside, 'o');
    symlinkSync(outside, join(home, '.pypirc'));     // target outside HOME and project
    symlinkSync(join(home, 'nowhere'), join(home, '.git-credentials')); // dangling
    process.env.HOME = home;
    rmSync(process.env.BB_ARGS_FILE, { force: true });
    const child = launch({ runtime: rt, agent: 'lf', proj, command: ['true'] });
    await new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
    const args = readFileSync(process.env.BB_ARGS_FILE, 'utf8').split('\n').filter((l) => l !== '');
    const at = (...seq) => args.findIndex((_, i) => seq.every((s, k) => args[i + k] === s));
    const projIdx = at('--ro-bind', proj, proj);
    assert.ok(projIdx >= 0);
    for (const f of [join(home, '.netrc'), join(home, 'dotfiles', 'npmrc')]) {
      const i = at('--dev-bind', '/dev/null', f);
      assert.ok(i > projIdx, `file mask for ${f} missing or before the project mount: ${args.join(' ')}`);
    }
    assert.ok(at('--tmpfs', join(home, '.aws')) > projIdx, '.aws dir mask missing');
    assert.equal(at('--tmpfs', join(home, '.netrc')), -1, 'a file must never get --tmpfs');
    assert.equal(at('--dev-bind', '/dev/null', join(home, '.npmrc')), -1, 'symlink spelling is not bound');
    assert.ok(!args.includes(outside) && !args.includes(join(home, '.pypirc')), 'outside link masked');
    assert.ok(!args.includes(join(home, '.git-credentials')), 'dangling link masked');
  });
});

describe('buildCaBundle (no sandbox needed)', () => {
  it('combines system roots with the barebox CA, key never involved', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-ca-'));
    try {
      const caKey = join(root, 'ca.key');
      const caPem = join(root, 'ca.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', caKey, '-out', caPem, '-days', '1', '-subj', '/CN=bb-test-ca'],
        { stdio: 'ignore' });
      const out = buildCaBundle(join(root, 'rt'), caPem);
      const bundle = readFileSync(out, 'utf8');
      const ca = readFileSync(caPem, 'utf8');
      assert.ok(bundle.includes(ca.trim()), 'bundle carries the barebox CA');
      assert.ok(!bundle.includes('PRIVATE KEY'), 'no key material in the bundle');
      if (existsSync('/etc/ssl/certs/ca-certificates.crt')) {
        assert.ok(bundle.length > ca.length, 'system roots are in the bundle too');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a present bundle is reused, not rewritten (5.3)', () => {
    // The CA doesn't change during a runtime's life: 20 agents launching at
    // once build the bundle once. A second CA must not replace the first.
    const root = mkdtempSync(join(tmpdir(), 'bb-ca2-'));
    try {
      const mkCa = (cn, keyN, pemN) => {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', join(root, keyN), '-out', join(root, pemN), '-days', '1',
          '-subj', `/CN=${cn}`], { stdio: 'ignore' });
        return join(root, pemN);
      };
      const ca1 = mkCa('bb-test-ca-1', 'ca1.key', 'ca1.pem');
      const ca2 = mkCa('bb-test-ca-2', 'ca2.key', 'ca2.pem');
      const rt = join(root, 'rt');
      const out = buildCaBundle(rt, ca1);
      assert.ok(out.endsWith('ca-bundle.pem'), 'still reports the bundle path');
      const first = readFileSync(out, 'utf8');
      assert.ok(first.includes(readFileSync(ca1, 'utf8').trim()), 'first CA in the bundle');
      const again = buildCaBundle(rt, ca2);
      assert.equal(again, out, 'same path back');
      const second = readFileSync(out, 'utf8');
      assert.equal(second, first, 'not rewritten');
      assert.ok(!second.includes(readFileSync(ca2, 'utf8').trim()), 'second CA ignored');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('launch walls (needs bwrap)', { skip: NEED_SANDBOX }, () => {
  let root, home, proj, rt;
  let savedHome;
  const servers = [];
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-l-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'secret.txt'), 'x');
    // credential-store fixtures: a dir, a file, a symlinked file, a control
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'credentials'), 'aws-secret\n');
    mkdirSync(join(home, '.config', 'barebox'), { recursive: true });
    writeFileSync(join(home, '.config', 'barebox', 'config.json'), '{"mode":"trust"}\n');
    writeFileSync(join(home, '.netrc'), 'machine x password netrc-secret\n');
    mkdirSync(join(home, 'dotfiles'));
    writeFileSync(join(home, 'dotfiles', 'npmrc'), '_authToken=npm-secret\n');
    symlinkSync('dotfiles/npmrc', join(home, '.npmrc'));
    writeFileSync(join(home, 'notes.txt'), 'plain notes\n');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'ro.txt'), 'x');
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(async () => {
    for (const s of servers) { s.closeAllConnections?.(); s.close();
      await new Promise((r) => { s.on('close', r); setTimeout(r, 3000); }); }
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  // The agent socket must be listening before launch (documented prerequisite,
  // same as the M0 harness). Returns the collected bytes when asked.
  async function listenSock(agent, collect) {
    const sock = join(rt, 'socks', `${agent}.sock`);
    mkdirSync(join(rt, 'socks'), { recursive: true });
    try { rmSync(sock); } catch {}
    const got = collect ? [] : null;
    // Resume every accepted socket: the door-readiness probes open unix
    // connections that never send data. An accepted-but-paused socket sits
    // in CLOSE_WAIT after the sandbox dies and blocks server 'close' forever.
    const srv = net.createServer((s) => {
      // Ack-after-receipt: the inner socat bridge (backgrounded, separate PID
      // namespace, --die-with-parent) is killed when the sandboxed command
      // exits, so a fire-and-forget echo can lose trailing bytes. The inner
      // command below waits for this ack before exiting, which proves the
      // marker reached the host. The ack is sent only AFTER data arrives on
      // this connection (never on connect), so reading it confirms delivery
      // of this connection's bytes.
      if (got) s.on('data', (c) => { got.push(c.toString()); s.write('ok\n'); });
      else s.resume();
    });
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
    return got;
  }

  it('spawns and exits 0', async () => {
    await listenSock('t0');
    const c = launch({ runtime: rt, agent: 't0', proj, command: ['true'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
  });

  it('runs the agent in its own session, detached from our terminal', async () => {
    // /proc/self/stat field 6 is the session id. Without --new-session the
    // session leader lives outside the sandbox's pid namespace and reads as
    // 0; with it the session starts inside, so the id is nonzero.
    await listenSock('ts');
    const c = launch({ runtime: rt, agent: 'ts', proj,
      command: ['bash', '-c', 'read -r l </proc/self/stat; set -- ${l##*) }; echo "$4"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    assert.notEqual(r.out.trim(), '0', 'agent shares the caller\'s session (no --new-session)');
  });

  it('masks locked drawers', async () => {
    await listenSock('t1');
    const c = launch({ runtime: rt, agent: 't1', proj,
      command: ['bash', '-c', 'test ! -e "$HOME/.ssh/secret.txt"'] });
    assert.equal((await run(c)).code, 0);
  });

  it('masks credential stores: dirs empty, files read empty, symlinked file shut at both spellings', async () => {
    await listenSock('t1b');
    const script = [
      '[ -z "$(ls -A "$HOME/.aws")" ] || exit 11',
      '[ "$(wc -c < "$HOME/.netrc")" = 0 ] || exit 12',
      '[ "$(wc -c < "$HOME/.npmrc")" = 0 ] || exit 13',
      '[ "$(wc -c < "$HOME/dotfiles/npmrc")" = 0 ] || exit 14',
      '[ "$(cat "$HOME/notes.txt")" = "plain notes" ] || exit 15',
    ].join('\n');
    const c = launch({ runtime: rt, agent: 't1b', proj, command: ['bash', '-c', script] });
    const r = await run(c);
    assert.equal(r.code, 0, `exit ${r.code} (11 .aws, 12 .netrc, 13 .npmrc, 14 dotfiles/npmrc, 15 notes): ${r.err}`);
  });

  it('masks barebox\'s own config: the file reads empty and the drawer lists empty', async () => {
    await listenSock('t1c');
    const script = [
      '[ -z "$(cat "$HOME/.config/barebox/config.json" 2>/dev/null)" ] || exit 11',
      '[ -z "$(ls -A "$HOME/.config/barebox")" ] || exit 12',
    ].join('\n');
    const c = launch({ runtime: rt, agent: 't1c', proj, command: ['bash', '-c', script] });
    const r = await run(c);
    assert.equal(r.code, 0, `exit ${r.code} (11 config.json readable, 12 drawer not empty): ${r.err}`);
  });

  it('binds project read-only', async () => {
    await listenSock('t2');
    const c = launch({ runtime: rt, agent: 't2', proj,
      command: ['bash', '-c', 'cat "$0/ro.txt" >/dev/null && ! touch "$0/nope" 2>/dev/null', proj] });
    assert.equal((await run(c)).code, 0);
  });

  it('sets the front-door env', async () => {
    await listenSock('t3');
    const c = launch({ runtime: rt, agent: 't3', proj,
      command: ['bash', '-c', '[ "$HTTP_PROXY" = http://127.0.0.1:3128 ]'] });
    assert.equal((await run(c)).code, 0);
  });

  it('has no route out', async () => {
    await listenSock('t4');
    const c = launch({ runtime: rt, agent: 't4', proj,
      command: ['bash', '-c', '! echo > /dev/tcp/192.0.2.1/9 2>/dev/null'] });
    assert.equal((await run(c)).code, 0);
  });

  it('bridges localhost:3128 to the agent socket', async () => {
    const got = await listenSock('t5', true);
    // Delivery-confirmed write: the shell holds a bidirectional fd open,
    // sends the marker, and only exits after reading the host's ack (sent
    // after receipt). Exiting earlier would kill the backgrounded socat
    // before it flushes. No sleep involved; `read -t` bounds the ack wait.
    const c = launch({ runtime: rt, agent: 't5', proj,
      command: ['bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/3128; echo marker >&3; read -t 5 ack <&3; [ "$ack" = ok ]'] });
    assert.equal((await run(c)).code, 0);
    const t0 = Date.now();
    while (!/marker/.test(got.join(''))) {
      if (Date.now() - t0 > 10000) throw new Error('timed out waiting for socat bridge delivery');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('sets CA trust env pointing at a readable combined bundle', async () => {
    await listenSock('t6');
    const caDir = join(root, 'ca');
    mkdirSync(caDir, { recursive: true });
    const caPem = join(caDir, 'ca.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(caDir, 'ca.key'), '-out', caPem, '-days', '1',
      '-subj', '/CN=bb-test-ca'], { stdio: 'ignore' });
    const c = launch({ runtime: rt, agent: 't6', proj, caFile: caPem,
      command: ['bash', '-c',
        '[ "$SSL_CERT_FILE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$NODE_EXTRA_CA_CERTS" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$REQUESTS_CA_BUNDLE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$CURL_CA_BUNDLE" = /run/sbx/ca-bundle.pem ] && ' +
        '[ "$GIT_SSL_CAINFO" = /run/sbx/ca-bundle.pem ] && ' +
        'grep -q "BEGIN CERTIFICATE" "$SSL_CERT_FILE"'] });
    assert.equal((await run(c)).code, 0);
  });

  it('without caFile, no CA trust vars leak in', async () => {
    await listenSock('t7');
    const c = launch({ runtime: rt, agent: 't7', proj,
      command: ['bash', '-c', '[ -z "$SSL_CERT_FILE" ] && [ -z "$CURL_CA_BUNDLE" ]'] });
    assert.equal((await run(c)).code, 0);
  });

  it('an agent cannot answer its own ask (runtime under $HOME is masked)', async () => {
    // The file checkpoint is the approve/deny capability: a forged
    // `answers/<id>.json` from inside must never reach the host tree the
    // proxy polls. The runtime lives under $HOME here, so the launcher
    // masks it; the write below lands on the mask (or fails) — either way
    // the host must not see it. The trailing visibility check catches
    // missing masks: without them $HOME/rt shows through (readable) and
    // the inner command exits nonzero even though the write itself fails.
    const rtHome = join(home, 'rt');
    mkdirSync(join(rtHome, 'answers'), { recursive: true });
    mkdirSync(join(rtHome, 'asks'), { recursive: true });
    mkdirSync(join(rtHome, 'socks'), { recursive: true });
    const srv = net.createServer((s) => s.resume());
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(join(rtHome, 'socks', 'ta.sock'), resolve);
    });
    servers.push(srv);
    const c = launch({ runtime: rtHome, agent: 'ta', proj,
      command: ['bash', '-c', 'echo \'{"decision":"allow"}\' > "$HOME/rt/answers/h1.json"; echo wrote:$?; test ! -e "$HOME/rt/asks" && test ! -e "$HOME/rt/answers"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    assert.ok(!existsSync(join(rtHome, 'answers', 'h1.json')),
      `forged answer reached the host (inside said: ${r.out}${r.err})`);
  });

  it('a runtime outside home/proj is not visible inside at all', async () => {
    const rtOut = join(root, 'rt-out');
    mkdirSync(join(rtOut, 'answers'), { recursive: true });
    mkdirSync(join(rtOut, 'socks'), { recursive: true });
    const srv = net.createServer((s) => s.resume());
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(join(rtOut, 'socks', 'tb.sock'), resolve);
    });
    servers.push(srv);
    const c = launch({ runtime: rtOut, agent: 'tb', proj,
      extraEnv: { RT_OUT: rtOut },
      command: ['bash', '-c', 'echo \'{"decision":"allow"}\' > "$RT_OUT/answers/h1.json"'] });
    const r = await run(c);
    assert.notEqual(r.code, 0, `write to an invisible runtime must fail (got ${r.code})`);
    assert.ok(!existsSync(join(rtOut, 'answers', 'h1.json')), 'host tree untouched');
  });

  it('hides runtime sockets that show through $HOME, front door still works', async () => {
    // Production layout: the runtime lives under $HOME, so the ro-bind of
    // home would expose every agent socket (identity) and the file
    // checkpoint (`asks/`, `answers/` — approve/deny) — and a read-only
    // bind does NOT stop connect(2). The launch must mask the runtime dir
    // inside.
    const rtHome = join(home, 'rt');
    mkdirSync(join(rtHome, 'socks'), { recursive: true });
    const sock = join(rtHome, 'socks', 't8.sock');
    try { rmSync(sock); } catch {}
    const got = [];
    const srv = net.createServer((s) => {
      // Same ack-after-receipt as listenSock: reply only after data arrives,
      // so the inner read confirms this connection's marker was delivered.
      s.on('data', (c) => { got.push(c.toString()); s.write('ok\n'); });
    });
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
    const c = launch({ runtime: rtHome, agent: 't8', proj,
      command: ['bash', '-c',
        'test ! -e "$HOME/rt/socks/t8.sock" && exec 3<>/dev/tcp/127.0.0.1/3128 && echo marker >&3 && read -t 5 ack <&3 && [ "$ack" = ok ]'] });
    assert.equal((await run(c)).code, 0);
    const t0 = Date.now();
    while (!/marker/.test(got.join(''))) {
      if (Date.now() - t0 > 10000) throw new Error('front door broke under a masked runtime');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('hides a runtime reached through a symlink from outside $HOME, front door still works', async () => {
    // Section 7 repro: the real runtime dir lives inside the fake home, but
    // the runtime is passed as a symlink located OUTSIDE home pointing in.
    // The sandbox shows the real tree, so the lexical mask misses and only
    // the real-tree mask hides the sockets. The agent's own front door
    // (/run/sbx/agent.sock bridge to 127.0.0.1:3128) must still deliver.
    const realRt = join(home, 'real-rt');
    mkdirSync(join(realRt, 'socks'), { recursive: true });
    const sock = join(realRt, 'socks', 't9.sock');
    try { rmSync(sock); } catch {}
    const got = [];
    const srv = net.createServer((s) => {
      // Same ack-after-receipt as listenSock: reply only after data arrives,
      // so the inner read confirms this connection's marker was delivered.
      s.on('data', (c) => { got.push(c.toString()); s.write('ok\n'); });
    });
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
    const lnk = join(root, 'lnk-t9');
    try { rmSync(lnk); } catch {}
    symlinkSync(realRt, lnk);
    try {
      const c = launch({ runtime: lnk, agent: 't9', proj,
        command: ['bash', '-c',
          'test ! -e "$HOME/real-rt/socks/t9.sock" && exec 3<>/dev/tcp/127.0.0.1/3128 && echo marker9 >&3 && read -t 5 ack <&3 && [ "$ack" = ok ]'] });
      assert.equal((await run(c)).code, 0);
      const t0 = Date.now();
      while (!/marker9/.test(got.join(''))) {
        if (Date.now() - t0 > 10000) throw new Error('front door broke under a symlinked runtime');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      try { rmSync(lnk); } catch {}
    }
  });
});

describe('M0 bypass set: no way out but the front door (needs bwrap)', { skip: NEED_SANDBOX }, () => {
  let root, home, proj, rt;
  let savedHome;
  const servers = [];
  function run(child, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { child.kill(); reject(new Error(`timeout: ${out}${err}`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });
  }
  // Slow negatives are the bug: in a netns without routes curl fails with
  // exit 7 (connect refused/unreachable) or 6 (DNS) in ~15 ms. Exit 28
  // (timeout) means the test waited on something else and must FAIL.
  // Every bypass test below captures `rc=$?` and asserts rc + elapsed.
  function wallReport(out, allowed = [7]) {
    const rc = /rc=(\d+)/.exec(out)?.[1];
    assert.ok(rc !== undefined, `no rc captured in: ${out}`);
    assert.ok(allowed.includes(parseInt(rc, 10)),
      `expected curl exit ${allowed}, got ${rc} (28 = timeout: passing for the wrong reason)`);
    const ms = parseInt(/ms=(\d+)/.exec(out)?.[1] ?? 'NaN', 10);
    assert.ok(ms < 1000, `wall must fail fast, took ${ms}ms: ${out}`);
  }
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-b-'));
    home = join(root, 'home'); proj = join(root, 'proj'); rt = join(root, 'rt');
    mkdirSync(home, { recursive: true });
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(rt, 'socks'), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  after(async () => {
    for (const s of servers) { s.closeAllConnections?.(); s.close();
      await new Promise((r) => { s.on('close', r); setTimeout(r, 3000); }); }
    process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });
  async function listenSock(agent) {
    const sock = join(rt, 'socks', `${agent}.sock`);
    // Resume: probe connections never send data; paused sockets block close.
    const srv = net.createServer((s) => s.resume());
    await new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(sock, resolve);
    });
    servers.push(srv);
  }

  it('direct IP with proxy env unset fails fast with exit 7', async () => {
    await listenSock('b0');
    const c = launch({ runtime: rt, agent: 'b0', proj,
      command: ['bash', '-c',
        'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; ' +
        't0=$(date +%s%N); curl -s --max-time 3 http://192.0.2.1/ -o /dev/null; rc=$?; ' +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('--noproxy * still fails fast with exit 7', async () => {
    await listenSock('b1');
    const c = launch({ runtime: rt, agent: 'b1', proj,
      command: ['bash', '-c',
        't0=$(date +%s%N); curl -s --max-time 3 --noproxy "*" http://192.0.2.1/ -o /dev/null; rc=$?; ' +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('direct to the host loopback fails fast with exit 7 (no proxy env involved)', async () => {
    const hostOnly = net.createServer((s) => s.end('host'));
    await new Promise((r) => hostOnly.listen(0, '127.0.0.1', r));
    servers.push(hostOnly);
    const hp = hostOnly.address().port;
    await listenSock('b2');
    // Direct: unset the front-door env so curl cannot wander into the dummy
    // agent socket (which never answers — that is a timeout, not a wall).
    const c = launch({ runtime: rt, agent: 'b2', proj,
      command: ['bash', '-c',
        'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; ' +
        `t0=$(date +%s%N); curl -s --max-time 3 http://127.0.0.1:${hp}/ -o /dev/null; rc=$?; ` +
        't1=$(date +%s%N); echo "rc=$rc ms=$(( (t1-t0)/1000000 ))"'] });
    const r = await run(c);
    assert.equal(r.code, 0, r.err);
    wallReport(r.out, [7]);
  });

  it('raw TCP out fails too', async () => {
    await listenSock('b3');
    const c = launch({ runtime: rt, agent: 'b3', proj,
      command: ['bash', '-c', '! echo > /dev/tcp/192.0.2.1/9 2>/dev/null'] });
    assert.equal((await run(c)).code, 0);
  });
});
