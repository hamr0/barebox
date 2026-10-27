// Launcher: one sandboxed agent (bwrap walls + socat front-door bridge).
// Port of poc/m0/launch.sh, minus the throwaway red-team hooks: secure
// defaults are baked in, not switchable. The project bind is read-only unless
// `overlay:true` mounts the M4 tracing paper over it (see overlay.js).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { socketPathForAgent, assertAgentName, realPathOf } from './proxy.js';
import { setupOverlay } from './overlay.js';

// Locked drawers: masked with an empty tmpfs wherever they exist.
const LOCKED_PATHS = [
  '.ssh',
  'secrets',
  '.mozilla',
  '.config/chromium',
  '.gnupg',
];

// System bundle locations the combined CA file is built from (first hit wins).
const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian/Ubuntu
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora/RHEL
  '/etc/ssl/cert.pem', // Alpine
];

// Proxy trust variables: every TLS stack worth having reads one of these.
const CA_ENV_VARS = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'];

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
  const ca = readFileSync(caFile, 'utf8');
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error(`buildCaBundle: no cert in ${caFile}`);
  let sys = '';
  for (const p of SYSTEM_BUNDLES) {
    if (existsSync(p)) { sys = readFileSync(p, 'utf8'); break; }
  }
  const out = join(runtime, 'ca-bundle.pem');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(out, `${sys}${sys.endsWith('\n') || !sys ? '' : '\n'}${ca}`);
  return out;
}

/**
 * Start one sandboxed agent. The agent sees a read-only `/usr` and `/etc`,
 * its project and home read-only, the locked drawers masked, no network of
 * its own, and a single front door: anything sent to `localhost:<proxyPort>`
 * is carried out through this agent's socket to the proxy. The agent starts
 * in the project dir (`--chdir proj`), so relative paths resolve there no
 * matter where the caller runs from.
 *
 * @param {object} opts
 * @param {string} opts.runtime where the runtime tree lives (`socks/` is created inside)
 * @param {string} opts.agent per-agent name; the outside socket is `<runtime>/socks/<agent>.sock` and must already be listening
 * @param {string} opts.proj project directory, bound read-only
 * @param {string[]} opts.command argv to run inside, for example `["python3", "agent.py"]`
 * @param {number} [opts.proxyPort] front-door port inside the sandbox (default 3128)
 * @param {object} [opts.extraEnv] extra environment entries for the inside
 * @param {string|null} [opts.socket] agent socket path, as returned by `proxy.addAgent` (default `<runtime>/socks/<agent>.sock`; the two must agree)
 * @param {string|null} [opts.caFile] barebox CA cert path (from `proxy.caFile`); when set, the sandbox trusts it for HTTPS alongside the system roots
 * @param {boolean} [opts.overlay] when true, mount a per-run overlay upper over the project (M4 tracing paper) instead of binding it read-only; the child carries `.overlay` (`{upper, work}`) for diff/commit/rollback
 * @param {string[]} [opts.overlayIgnore] path segments invisible to the overlay (default `node_modules`; see overlay.js Q3)
 * @returns {import('node:child_process').ChildProcess} the bwrap child (stdio piped); `close` gives its exit code
 * Carries `.overlay` (`{upper, work}`) when `overlay` is on.
 * @when Reach for this to HARNESS-ONLY start one sandboxed agent run: it creates the sandbox the agent lives in. It does not decide anything; combine with the proxy for the front door and the gate (M3) for policy. Pass overlay:true for a writable tracing-paper run (M4). The agent starts in the project dir.
 * @fails Throws synchronously on a missing/empty `runtime`, `agent`, `proj`, or `command`, on a bad agent name, on an over-long socket path, when `socket` disagrees with `<runtime>/socks/<agent>.sock`, when `runtime` IS `HOME` or the project dir (its sockets could not be hidden from the agent), or with overlay on when the runtime sits inside the project or uncommitted changes linger. The child fails at runtime (nonzero exit) when `bwrap` or `socat` is missing inside, or when nothing listens on the agent socket.
 * @example
 * import { launch } from "barebox";
 * const child = launch({ runtime: "/tmp/sbx", agent: "fx", proj: "/tmp/proj", command: ["bash", "-c", "echo hi"] });
 * await new Promise((r) => child.on("close", r)); // child.exitCode === 0
 */
export function launch({ runtime, agent, proj, command, proxyPort = 3128,
  extraEnv = {}, socket = null, caFile = null, overlay = false, overlayIgnore }) {
  for (const [k, v] of Object.entries({ runtime, agent, proj })) {
    if (typeof v !== 'string' || !v) throw new Error(`launch: ${k} must be a non-empty string`);
  }
  if (!Array.isArray(command) || !command.length) throw new Error('launch: command must be a non-empty argv array');
  assertAgentName(agent);
  // The socket IS the identity: both sides must name the same path.
  const expected = socketPathForAgent(runtime, agent);
  const sock = socket ?? expected;
  if (sock !== expected) throw new Error(`launch: socket ${sock} disagrees with ${expected}`);
  mkdirSync(join(runtime, 'socks'), { recursive: true });
  /** @type {{upper: string, work: string} | null} */
  let ov = null;
  if (overlay) {
    // The upper/work dirs live under the runtime: a runtime inside the
    // project would put them inside their own lower, which overlayfs
    // forbids — so that layout throws here, before anything is snapshotted.
    // (Lexical like the mask block below: bwrap sees these same spellings.)
    const under = (base, target) => {
      const rel = relative(base, target);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (under(join(proj), join(runtime)) || under(realPathOf(join(proj)), realPathOf(join(runtime)))) {
      throw new Error('launch: runtime must not be inside the project dir when overlay is on (the upper would sit inside its own lower)');
    }
    ov = setupOverlay({ runtime, agent, proj, ignore: overlayIgnore });
  }
  const home = process.env.HOME || '/root';
  const args = [
    '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-net',
    '--die-with-parent',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    // $HOME first, the project second: a project under $HOME would otherwise
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
  ];
  // Locked drawers AFTER the project mount: the tmpfs mask must land on top,
  // or a project that contains one of these paths (a project that IS $HOME,
  // or holds its own `.ssh`) would leak the real drawer through the overlay.
  for (const p of LOCKED_PATHS) {
    if (existsSync(`${home}/${p}`)) args.push('--tmpfs', `${home}/${p}`);
  }
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
    // Lexical on purpose: bwrap sees these same spellings, so the mask
    // lands on the path the sandbox actually shows. (`resolve` would
    // follow symlinks and can name a path the sandbox never displays.)
    const rt = join(runtime);
    const hm = join(home);
    const pr = join(proj);
    if (rt === hm || rt === pr) {
      throw new Error(`launch: runtime must not be ${rt === hm ? 'HOME' : 'the project dir'} itself (its sockets cannot be hidden there)`);
    }
    const inside = (base) => {
      const rel = relative(base, rt);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (inside(hm) || inside(pr)) args.push('--tmpfs', rt);
    // Real-tree mask as well: the sandbox shows the REAL tree (symlinks
    // resolved), so a runtime passed as a symlink from outside $HOME/proj
    // can still land inside it and stay visible through the ro-binds. The
    // lexical mask above covers the spelling bwrap is given; this one covers
    // the sandbox-visible spelling join(home, relative(realHome, realRt))
    // (likewise proj). Both masks are cheap; keep both.
    const realRt = realPathOf(rt);
    const realHm = realPathOf(hm);
    const realPr = realPathOf(pr);
    if (realRt === realHm || realRt === realPr) {
      throw new Error(`launch: runtime must not be ${realRt === realHm ? 'HOME' : 'the project dir'} itself (its sockets cannot be hidden there)`);
    }
    const realInside = (realBase, baseSpelling) => {
      const rel = relative(realBase, realRt);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
      return join(baseSpelling, rel);
    };
    for (const m of [realInside(realHm, hm), realInside(realPr, pr)]) {
      if (m && !args.includes(m)) args.push('--tmpfs', m);
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
    '--setenv', 'PATH', '/usr/bin:/bin:/usr/sbin',
    '--setenv', 'HTTP_PROXY', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'HTTPS_PROXY', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'http_proxy', `http://127.0.0.1:${proxyPort}`,
    '--setenv', 'https_proxy', `http://127.0.0.1:${proxyPort}`,
  );
  if (caBundle) {
    for (const v of CA_ENV_VARS) args.push('--setenv', v, '/run/sbx/ca-bundle.pem');
  }
  for (const [k, v] of Object.entries(extraEnv)) args.push('--setenv', k, String(v));
  const door = String(proxyPort);
  const inner = 'ip link set lo up 2>/dev/null; ' +
    `socat TCP-LISTEN:${door},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/sbx/agent.sock & ` +
    `ok=; for i in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/${door}) 2>/dev/null && { ok=1; break; }; sleep 0.1; done; ` +
    '[ -n "$ok" ] || exit 99; exec "$@"';
  const child = spawn('bwrap', [...args, '/usr/bin/bash', '-c', inner, 'bash', ...command],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  if (ov) {
    // Address of this run's tracing paper for diff/commit/rollback.
    const anyChild = /** @type {unknown} */ (child);
    /** @type {{ overlay?: { upper: string, work: string } }} */ (anyChild).overlay = { ...ov };
  }
  return child;
}
