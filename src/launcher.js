// Launcher: one sandboxed agent (bwrap walls + socat front-door bridge).
// Port of poc/m0/launch.sh, minus the throwaway red-team hooks: secure
// defaults are baked in, not switchable. The project bind is read-only unless
// `overlay:true` mounts the M4 tracing paper over it (see overlay.js).
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, delimiter } from 'node:path';
import { assertAgentName, hostNode, isInside, realPathOf, runtimePaths, usrLinks } from './runtime.js';
import { assertOverlaySupport, setupOverlay } from './overlay.js';
import { configPath } from './config.js';

// Locked drawers (relative to $HOME): masked wherever they exist — a folder
// with an empty tmpfs, a file with /dev/null (bwrap cannot mount a tmpfs on
// a file; `--dev-bind`, because `--ro-bind` makes the mount nodev and the
// read fails EACCES instead of reading empty). The real kind on disk picks the
// mask.
// Deliberately NOT here: the agent's own model credentials (`~/.claude`,
// `~/.claude.json`, `~/.config/anthropic`, ...). A sandboxed coding agent
// needs them to run at all; moving keys out of the agent's reach is M5
// ("keys the agent never holds"), not a mask.
const LOCKED_PATHS = [
  // keys, password stores, keyrings
  '.ssh',
  'secrets',
  '.gnupg',
  '.password-store',
  '.local/share/keyrings',
  // browser profiles (cookies, saved passwords)
  '.mozilla',
  '.config/chromium',
  '.config/google-chrome',
  '.config/BraveSoftware',
  // cloud, cluster and container credentials
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker',
  // forge and password-manager CLIs
  '.config/gh',
  '.config/op',
  // token files
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.cargo/credentials.toml',
];

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin'];

/**
 * The bwrap args that mask one locked path, or none when it does not exist.
 * A symlinked drawer (dotfile managers) is masked at its real target, which
 * is where bwrap lands a mount anyway, so the content is shut at both
 * spellings; a target outside every bound root is not in the sandbox at all,
 * so there is nothing to mask.
 *
 * @param {string} abs the locked path (under a bound root to matter)
 * @param {string[]} roots the paths the sandbox binds in: `$HOME`, the project, `/etc`, `/usr` and the Node install
 * @returns {string[]} `--tmpfs <dir>` or `--dev-bind /dev/null <file>`, or `[]`
 */
function lockMask(abs, roots) {
  const bound = (p) => roots.some((r) => isInside(r, p));
  // Under no bound root: not in the sandbox at all.
  if (!bound(abs)) return [];
  let target = abs;
  let st;
  try {
    st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      target = realPathOf(abs);
      if (!bound(target)) return [];
      st = statSync(target);
    }
  } catch {
    return []; // absent, or a dangling link: nothing readable to mask
  }
  return st.isDirectory() ? ['--tmpfs', target] : ['--dev-bind', '/dev/null', target];
}

// System bundle locations the combined CA file is built from (first hit wins).
const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian/Ubuntu
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora/RHEL
  '/etc/ssl/cert.pem', // Alpine
];

// Proxy trust variables: every TLS stack worth having reads one of these.
const CA_ENV_VARS = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'];

// Host variables that reach the inside without being asked for (M5). Nothing
// else does: the sandbox gets a short list, not the host environment.
const PASS_DEFAULT = /^(TERM|COLORTERM|LANG|LANGUAGE|LC_[A-Z_]+|TZ|USER|LOGNAME|SHELL|EDITOR|PAGER)$/;

/**
 * Where `bwrap` is, looked up on THIS process's PATH. The spawn below runs
 * with a clean environment (its PATH is fixed), so node could not find a
 * `bwrap` that the caller's PATH puts first (the fake one the tests use).
 *
 * @returns {string} the first executable `bwrap` on PATH, else the bare name (spawn then fails ENOENT as before)
 */
function bwrapBin() {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    const p = join(d, 'bwrap');
    try { accessSync(p, constants.X_OK); return p; } catch {}
  }
  return 'bwrap';
}

/**
 * Build the CA bundle the sandbox trusts: system roots plus the barebox CA,
 * so public hosts verify as usual and the proxy's minted certs verify too.
 * Only ever reads `caFile` (the CA *cert*); the key stays outside.
 * `SSL_CERT_FILE` *replaces* the system bundle, hence the combine.
 *
 * @param {string} runtime runtime dir the bundle is written into
 * @param {string} caFile barebox CA cert path (from `proxy.caFile`)
 * @returns {string} path of the combined bundle inside `runtime`
 */
export function buildCaBundle(runtime, caFile) {
  const out = join(runtime, 'ca-bundle.pem');
  // Once per runtime: the CA doesn't change during a runtime's life, so a
  // present bundle is reused (20 agents launching at once build it once).
  if (existsSync(out)) return out;
  const ca = readFileSync(caFile, 'utf8');
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error(`buildCaBundle: no cert in ${caFile}`);
  let sys = '';
  for (const p of SYSTEM_BUNDLES) {
    if (existsSync(p)) { sys = readFileSync(p, 'utf8'); break; }
  }
  mkdirSync(runtime, { recursive: true });
  writeFileSync(out, `${sys}${sys.endsWith('\n') || !sys ? '' : '\n'}${ca}`);
  return out;
}

/**
 * Start one sandboxed agent. The agent sees a read-only `/usr` and `/etc`
 * (and the host's `/bin`, `/sbin`, `/lib`, `/lib64`, mirrored),
 * its project and home read-only, the locked drawers masked, no network of
 * its own, and a single front door: anything sent to `localhost:<proxyPort>`
 * is carried out through this agent's socket to the proxy. The agent starts
 * in the project dir (`--chdir proj`), so relative paths resolve there no
 * matter where the caller runs from. The agent always runs in a new session
 * (`--new-session`), detached from the caller's terminal, so it cannot inject
 * keystrokes via TIOCSTI on kernels with `dev.tty.legacy_tiocsti=1`. Its stdin
 * is never the terminal (`stdio: ignore`), so detaching costs nothing.
 *
 * @param {object} opts
 * @param {string} opts.runtime where the runtime tree lives (`socks/` is created inside)
 * @param {string} opts.agent per-agent name; the outside socket is `<runtime>/socks/<agent>.sock` and must already be listening
 * @param {string} opts.proj project directory, bound read-only
 * @param {string[]} opts.command argv to run inside, for example `["python3", "agent.py"]`
 * @param {number} [opts.proxyPort] front-door port inside the sandbox (default 3128)
 * @param {object} [opts.extraEnv] extra environment entries for the inside, set last (they win)
 * @param {{ pass?: string[], set?: Record<string, string>, placeholders?: Record<string, string> }} [opts.env] the inside's environment (M5). The host environment never reaches it except: a short default list (`TERM`, `COLORTERM`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `USER`, `LOGNAME`, `SHELL`, `EDITOR`, `PAGER`), the host variables named in `pass`, the values in `set`, and one placeholder per secret under its own name (`placeholders`, name to value). Set in that order, then `extraEnv`.
 * @param {string|null} [opts.socket] agent socket path, as returned by `proxy.addAgent` (default `<runtime>/socks/<agent>.sock`; the two must agree)
 * @param {string|null} [opts.caFile] barebox CA cert path (from `proxy.caFile`); when set, the sandbox trusts it for HTTPS alongside the system roots
 * @param {string} [opts.nodeExec] the node executable to run inside (default: this process's `process.execPath`). The install is a `bin/` layout's parent dir (npm and global CLIs live there) or, for any other layout, the exec's own dir. It is bound read-only with the exec's dir first on the inside PATH, unless already visible there (under `/usr`, `$HOME` or the project). Never bound when it is `/`, `$HOME` or above it: then it is not on PATH either (see `hostNode` in `src/runtime.js`). A runtime or project under the install is masked or mounted over it, so the bind never exposes either
 * @param {string[]} [opts.maskDirs] extra folders hidden from the agent exactly like barebox's config dir (the `labels` folders: the agent must not read or rewrite a letter)
 * @param {boolean} [opts.overlay] when true, mount a per-run overlay upper over the project (M4 tracing paper) instead of binding it read-only; diff/commit/rollback address it as `runtimePaths(runtime).overlay(agent)`
 * @param {string[]} [opts.overlayIgnore] path segments invisible to the overlay (default `node_modules`; see overlay.js Q3)
 * @returns {import('node:child_process').ChildProcess} the bwrap child (stdio piped); `close` gives its exit code
 * @when Reach for this to HARNESS-ONLY start one sandboxed agent run: it creates the sandbox the agent lives in. It does not decide anything; combine with the proxy for the front door and the gate (M3) for policy. Pass overlay:true for a writable tracing-paper run (M4). The agent starts in the project dir.
 * @fails Throws synchronously on a missing/empty `runtime`, `agent`, `proj`, or `command`, on a bad agent name, on a non-integer `proxyPort`, on an over-long socket path, when `socket` disagrees with `<runtime>/socks/<agent>.sock`, when `runtime` IS `HOME`, the project dir, `/etc`, `/usr` or the bound Node install dir (its sockets could not be hidden from the agent), or with overlay on when the runtime sits inside the project or uncommitted changes linger. The child fails at runtime (nonzero exit) when `bwrap` or `socat` is missing inside, or when nothing listens on the agent socket.
 * @example
 * import { launch } from "barebox";
 * const child = launch({ runtime: "/tmp/sbx", agent: "fx", proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
 * await new Promise((r) => child.on("close", r)); // child.exitCode === 0
 */
export function launch({ runtime, agent, proj, command, proxyPort = 3128,
  extraEnv = {}, env = {}, socket = null, caFile = null, overlay = false, overlayIgnore, maskDirs = [], nodeExec = process.execPath }) {
  for (const [k, v] of Object.entries({ runtime, agent, proj })) {
    if (typeof v !== 'string' || !v) throw new Error(`launch: ${k} must be a non-empty string`);
  }
  if (!Array.isArray(command) || !command.length) throw new Error('launch: command must be a non-empty argv array');
  // Pasted into the sandbox's start-up script: anything but an integer port is shell injection.
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`launch: proxyPort must be an integer from 1 to 65535, got ${JSON.stringify(proxyPort)}`);
  }
  assertAgentName(agent);
  // The socket IS the identity: both sides must name the same path.
  const expected = runtimePaths(runtime).socket(agent);
  const sock = socket ?? expected;
  if (sock !== expected) throw new Error(`launch: socket ${sock} disagrees with ${expected}`);
  mkdirSync(dirname(expected), { recursive: true });
  /** @type {{upper: string, work: string} | null} */
  let ov = null;
  if (overlay) {
    assertOverlaySupport();
    // The upper/work dirs live under the runtime: a runtime inside the
    // project would put them inside their own lower, which overlayfs
    // forbids — so that layout throws here, before anything is snapshotted.
    if (isInside(proj, runtime)) {
      throw new Error('launch: runtime must not be inside the project dir when overlay is on (the upper would sit inside its own lower)');
    }
    ov = setupOverlay({ runtime, agent, proj, ignore: overlayIgnore });
  }
  const home = process.env.HOME || '/root';
  // A Node outside /usr and $HOME (nvm, a CI toolcache) is bound read-only too, so the host's
  // node and its global CLIs run inside.
  const { bin: nodeBin, bind: nodeBind } = hostNode(nodeExec, home, proj);
  // Every path the sandbox binds in from the host: the locked drawers and mask folders are
  // hidden wherever they sit under one of these.
  const links = usrLinks();
  const roots = [home, proj, '/etc', '/usr', ...links.bound, ...(nodeBind ? [nodeBind] : [])];
  const args = [
    '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-net',
    '--die-with-parent',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    ...links.args,
    '--ro-bind', '/etc', '/etc',
    // The Node install first: a project or runtime inside it must win over it.
    // It never holds $HOME and is never inside $HOME, /usr or the project (then
    // it is not bound), so the only overlap is a project or runtime under it.
    ...(nodeBind ? ['--ro-bind', nodeBind, nodeBind] : []),
    // $HOME next, the project after: a project under $HOME would otherwise
    // vanish under the home bind (bwrap mounts cover what is below them —
    // the later mount wins where they overlap). The project mount (overlay
    // or read-only) therefore lands on top of the read-only home.
    '--ro-bind', home, home,
    // Tracing paper (M4): lower = real project, upper = this run's sheet.
    // Without it the project stays a read-only bind and writes fail.
    ...(ov
      ? ['--overlay-src', proj, '--overlay', ov.upper, ov.work, proj]
      : ['--ro-bind', proj, proj]),
    '--chdir', proj,
    // Always detach from our controlling terminal: otherwise the agent could
    // open /dev/tty and TIOCSTI keystrokes into it (e.g. into `sbx approve`)
    // on kernels with dev.tty.legacy_tiocsti=1. The agent's stdin is never
    // the terminal (spawned with stdin ignored), so nothing interactive is lost.
    '--new-session',
  ];
  // Locked drawers AFTER the project mount: the tmpfs mask must land on top,
  // or a project that contains one of these paths (a project that IS $HOME,
  // or holds its own `.ssh`) would leak the real drawer through the overlay.
  for (const p of LOCKED_PATHS) args.push(...lockMask(`${home}/${p}`, roots));
  // barebox's own config: settings the agent must neither read nor edit.
  // Masked wherever it resolves (XDG_CONFIG_HOME may move it).
  args.push(...lockMask(dirname(configPath(process.env)), roots));
  // The label folders (the letters live there) get the same mask.
  for (const d of maskDirs) args.push(...lockMask(d, roots));
  // The runtime tree holds the file-checkpoint dirs (`asks/`, `answers/`
  // — the approve/deny capability) and every agent's socket (identity). A
  // read-only bind does NOT stop connect(2) to a unix socket, so wherever
  // the runtime would show through the home or project binds, mask it with
  // an empty tmpfs. The mask lands on the runtime dir itself, so `asks/`
  // and `answers/` underneath are covered too: an agent cannot read its ask
  // file, and a forged answer file would land on the mask (or fail where
  // the runtime is outside home/proj and hence not bound in at all), never
  // on the host tree the proxy polls. (The agent's own socket is bound from
  // the host side to /run/sbx/agent.sock, so masking the sandbox-side
  // runtime path does not close the front door.) These masks stay after the
  // project and locked mounts: where paths overlap, the later mount wins.
  {
    // bwrap sees these same spellings, so the mask lands on the path the
    // sandbox actually shows. The sandbox shows the REAL tree (symlinks
    // resolved), so a runtime passed as a symlink from outside $HOME/proj
    // can still land inside it and stay visible through the ro-binds — the
    // mask below covers that spelling too.
    // Every root the sandbox binds: (real path, the spelling bwrap sees).
    const bases = roots.map((r) => [realPathOf(join(r)), join(r)]);
    const realRt = realPathOf(join(runtime));
    // One real-path comparison: a lexically-equal spelling resolves to the
    // same real path, so it is subsumed here.
    const same = bases.findIndex(([realBase]) => realRt === realBase);
    if (same >= 0) {
      const what = same === 0 ? 'HOME' : same === 1 ? 'the project dir' : roots[same] === nodeBind ? 'the Node install dir' : roots[same];
      throw new Error(`launch: runtime must not be ${what} itself (its sockets cannot be hidden there)`);
    }
    // Mask the sandbox-visible spelling join(root, relative(realRoot, realRt)):
    // where nothing is a symlink this IS the lexical path, so no separate
    // lexical mask is needed.
    for (const [realBase, baseSpelling] of bases) {
      if (isInside(realBase, realRt)) {
        const m = join(baseSpelling, relative(realBase, realRt));
        if (!args.includes(m)) args.push('--tmpfs', m);
      }
    }
  }
  args.push(
    '--dir', '/run',
    '--tmpfs', '/run/sbx',
    '--bind', sock, '/run/sbx/agent.sock',
  );
  /** @type {string|null} */
  let caBundle = null;
  if (caFile) {
    caBundle = buildCaBundle(runtime, caFile);
    args.push('--ro-bind', caBundle, '/run/sbx/ca-bundle.pem');
  }
  args.push(
    '--setenv', 'HOME', home,
    // ~/.local/bin (where `claude` installs) goes last, so it never shadows a system tool; no new
    // exposure: the dir is already visible through the read-only $HOME bind.
    '--setenv', 'PATH', [...(!nodeBin || SYSTEM_PATH.includes(nodeBin) ? [] : [nodeBin]), ...SYSTEM_PATH,
      ...(existsSync(`${home}/.local/bin`) ? [`${home}/.local/bin`] : [])].join(':'),
    '--setenv', 'HTTP_PROXY', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'HTTPS_PROXY', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'http_proxy', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'https_proxy', `http://127.0.0.1:${proxyPort}`,
    // Node's built-in fetch ignores the proxy variables unless this is set.
    '--setenv', 'NODE_USE_ENV_PROXY', '1',
  );
  if (caBundle) {
    for (const v of CA_ENV_VARS) args.push('--setenv', v, '/run/sbx/ca-bundle.pem');
  }
  // M5: the host environment never enters. The default list and `env.pass` are read from this
  // process; then `env.set`, one placeholder per secret, and `extraEnv` (last wins).
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && PASS_DEFAULT.test(k)) args.push('--setenv', k, v);
  }
  for (const k of env.pass ?? []) {
    const v = process.env[k];
    if (v !== undefined) args.push('--setenv', k, v);
  }
  for (const [k, v] of Object.entries(env.set ?? {})) args.push('--setenv', k, String(v));
  for (const [k, v] of Object.entries(env.placeholders ?? {})) args.push('--setenv', k, String(v));
  for (const [k, v] of Object.entries(extraEnv)) args.push('--setenv', k, String(v));
  const door = String(proxyPort);
  // `-lf /dev/null` drops socat's own log: an early-closed connection prints harmless `E` lines.
  // Safe because a bridge that failed to start is still caught below by the door probe (exit 99).
  const inner = 'ip link set lo up 2>/dev/null; ' +
    `socat -lf /dev/null TCP-LISTEN:${door},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/sbx/agent.sock & ` +
    `ok=; for i in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/${door}) 2>/dev/null && { ok=1; break; }; sleep 0.1; done; ` +
    '[ -n "$ok" ] || exit 99; exec "$@"';
  const child = spawn(bwrapBin(), [...args, '/usr/bin/bash', '-c', inner, 'bash', ...command],
    // A clean spawn environment: bwrap's own pid-1 process keeps the environment it was started
    // with (it is `/proc/1/environ` inside), so the host's must not be it.
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  // No `.overlay` on the child: the tracing paper's address is one call,
  // `runtimePaths(runtime).overlay(agent)`, so there is nothing to keep in sync.
  return child;
}
