#!/usr/bin/env node
// sbx — second-terminal CLI for the hold queue (M2.5 file channel):
// sbx pending | approve <id> | deny <id> [reason]
// Reads `<runtime>/asks/<id>.json`, answers by atomically writing
// `<runtime>/answers/<id>.json` (tmp file + rename, so the proxy never sees
// a partial). The runtime comes from SBX_RUNTIME only; there is no
// cwd-relative default. Choice, documented: SBX_SOCK (the M2 control socket)
// is UNSUPPORTED — setting it is a usage error (exit 2), not a fallback —
// because the control socket server is deleted and two decision paths would
// drift. Set SBX_RUNTIME instead.
//
// sbx run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd> [...]
// Runs one sandboxed agent start-to-finish in this process (project = cwd).
// The runtime is SBX_RUNTIME when set, else a short temp dir (printed to
// stderr so a second terminal can approve from it). With --json, stdout
// carries JSON lines only (`{"ev":"ask",...}` per parked ask, then
// `{"ev":"done","exit":N}`); the agent's own output goes to stderr there so
// the stream stays parseable. Without --json the same events print as
// human-readable lines. The process exit code mirrors the agent's (usage
// errors stay exit 2). SBX_ALLOW_LOOPBACK=1 is a TEST-ONLY opt-in (fixtures
// live on 127.0.0.1); production never sets it.
//
// sbx diff [--agent <name>] | commit [--agent <name>] [--skip-conflicts] | rollback [--agent <name>]
// Reviews the M4 tracing paper of the last overlay run in SBX_RUNTIME:
// `diff` lists added/modified/deleted paths (`A`/`M`/`D`, conflicts flagged),
// `commit` presses the paper down (refusing on conflicts unless
// --skip-conflicts), `rollback` throws it away. Exit 1 on refusal or when no
// overlay exists for the agent (default `agent`); SBX_RUNTIME is required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { askPaths, writeFileAtomic } from './holds.js';
import { run as sandboxRun } from './run.js';
import { diffOverlay, commitOverlay, rollbackOverlay } from './overlay.js';
import { assertAgentName } from './proxy.js';

const USAGE = 'usage: sbx [--help] | pending | approve <id> | deny <id> [reason] | diff [--agent <name>] | commit [--agent <name>] [--skip-conflicts] | rollback [--agent <name>] | run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd> [...]';

/** Hold ids the CLI accepts: `h<n>` only. Anything else is a usage error, never a path. */
const HOLD_ID_RE = /^h\d+$/;

/**
 * Strip terminal control before printing agent-controlled bytes (ask URLs,
 * rules, body previews, overlay paths): an escape sequence smuggled into a
 * preview could otherwise rewrite the approver's terminal line before
 * approval, and bidi controls in an agent-chosen filename could flip how a
 * reviewed path reads.
 *
 * @param {unknown} s value to print
 * @returns {string} printable text with no VT sequences, C0/C1 controls, or bidi controls
 */
function safe(s) {
  return stripVTControlCharacters(String(s ?? ''))
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Bidi controls U+200E/F, U+202A-E, U+2066-9: an agent-chosen filename
    // could otherwise flip how a reviewed path reads.
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}
// Exit codes: 0 ok, 1 unknown id / refused / run failure, 2 usage.
// `sbx run` mirrors the agent's exit code instead (usage errors stay 2).
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'run') {
  let mode = 'auto';
  let json = false;
  let overlay = false;
  const sep = args.indexOf('--');
  if (sep < 0) {
    console.log(USAGE);
    process.exit(2);
  }
  const flags = args.slice(0, sep);
  const command = args.slice(sep + 1);
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === '--json') {
      json = true;
    } else if (f === '--overlay') {
      overlay = true;
    } else if (f === '--mode') {
      const v = flags[++i];
      if (v !== 'ask' && v !== 'auto' && v !== 'trust') {
        console.log(USAGE);
        process.exit(2);
      }
      mode = v;
    } else {
      console.log(USAGE);
      process.exit(2);
    }
  }
  if (!command.length) {
    console.log(USAGE);
    process.exit(2);
  }
  await cliRun({ mode, json, overlay, command });
} else if (cmd === 'diff' || cmd === 'commit' || cmd === 'rollback') {
  await cliOverlay(cmd, args);
} else {
  if (!['pending', 'approve', 'deny'].includes(cmd) || (cmd !== 'pending' && !args[0])) {
    console.log(USAGE);
    process.exit(2);
  }
  if (process.env.SBX_SOCK) {
    console.log('SBX_SOCK is no longer supported (control socket removed in M2.5); set SBX_RUNTIME instead');
    process.exit(2);
  }
  await cliDecide(cmd, args);
}

/**
 * One sandboxed run in this process. Watches the runtime's ask files and
 * reports every parked ask, then the agent's exit code.
 *
 * @param {object} opts
 * @param {string} opts.mode `ask` | `auto` | `trust`
 * @param {boolean} opts.json machine-readable JSON lines on stdout
 * @param {boolean} opts.overlay run on the M4 tracing paper, reviewed after with `sbx diff`
 * @param {string[]} opts.command argv to run inside the sandbox
 * @returns {Promise<void>} sets `process.exitCode` (mirrors the agent)
 */
async function cliRun({ mode, json, overlay, command }) {
  const runtime = process.env.SBX_RUNTIME || fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const paths = askPaths(runtime);
  const seen = new Set();
  const emitAsk = (h) => {
    // Agent-controlled bytes, sanitized before they reach a terminal.
    const clean = {
      ...h,
      id: safe(h.id), agent: safe(h.agent), method: safe(h.method),
      url: safe(h.url), rule: safe(h.rule),
      ...(h && typeof h === 'object' && 'bodyPreview' in h ? { bodyPreview: safe(h.bodyPreview) } : {}),
    };
    if (json) console.log(JSON.stringify({ ev: 'ask', ...clean }));
    else console.log(`ask ${clean.id} ${clean.agent} ${clean.method} ${clean.url} rule=${clean.rule}`);
  };
  const sweepOnce = () => {
    let names;
    try {
      names = fs.readdirSync(paths.asksDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (seen.has(id)) continue;
      let h;
      try {
        h = JSON.parse(fs.readFileSync(path.join(paths.asksDir, name), 'utf8'));
      } catch {
        continue; // being written; the next sweep sees it
      }
      seen.add(id);
      emitAsk(h);
    }
  };
  let watching = true;
  const poll = setInterval(() => { if (watching) sweepOnce(); }, 100);
  if (poll && typeof poll.unref === 'function') poll.unref();
  console.error(`runtime ${runtime} (answer with: SBX_RUNTIME=${runtime} sbx approve <id>)`);
  /** @type {{ exit: number, diff: { path: string }[] } | null} */
  let result = null;
  try {
    // SBX_OVERLAY_IGNORE extends the M4 ignore list (Q3) as comma names.
    const extraIgnore = (process.env.SBX_OVERLAY_IGNORE ?? '').split(',')
      .map((s) => s.trim()).filter(Boolean);
    result = await sandboxRun({
      runtime, proj: process.cwd(), command, mode,
      allowLoopback: process.env.SBX_ALLOW_LOOPBACK === '1',
      overlay,
      ...(extraIgnore.length ? { overlayIgnore: ['node_modules', ...extraIgnore] } : {}),
      // With --json stdout is a pure event stream: agent output goes to
      // stderr so a parser never trips over it.
      ...(json ? { stdout: process.stderr, stderr: process.stderr } : {}),
    });
  } catch (e) {
    watching = false;
    clearInterval(poll);
    console.error(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  watching = false;
  clearInterval(poll);
  sweepOnce(); // an ask parked after the last poll still gets its line
  if (json) console.log(JSON.stringify({ ev: 'done', exit: result.exit }));
  else console.log(`done exit ${result.exit}`);
  if (overlay) {
    const n = result.diff.length;
    console.error(n
      ? `overlay: ${n} change(s) — review with: SBX_RUNTIME=${runtime} sbx diff`
      : 'overlay: no changes');
  }
  process.exitCode = result.exit;
}

/**
 * `diff` / `commit` / `rollback` over one run's tracing paper.
 *
 * @param {string} overlayCmd `diff` | `commit` | `rollback`
 * @param {string[]} rest command args (`--agent <name>`, commit's `--skip-conflicts`)
 * @returns {Promise<void>}
 */
async function cliOverlay(overlayCmd, rest) {
  const runtime = process.env.SBX_RUNTIME;
  if (!runtime) {
    console.log(USAGE);
    process.exit(2);
  }
  let agent = 'agent';
  let skipConflicts = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--agent') {
      const v = rest[++i];
      if (!v) {
        console.log(USAGE);
        process.exit(2);
      }
      agent = v;
    } else if (a === '--skip-conflicts' && overlayCmd === 'commit') {
      skipConflicts = true;
    } else {
      console.log(USAGE);
      process.exit(2);
    }
  }
  try {
    assertAgentName(agent);
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  /**
   * The one function that prints an agent-controlled change (or an overlay
   * error carrying agent-controlled paths): every path and reason is
   * sanitized here, once — never at the call sites below.
   *
   * @param {unknown} line full line to print
   */
  const say = (line) => {
    console.log(safe(line));
  };
  /**
   * @param {unknown} e
   * @returns {never}
   */
  const fail = (e) => {
    say(e instanceof Error ? e.message : String(e));
    process.exit(1);
    throw new Error('unreachable');
  };
  const letter = (/** @type {string} */ s) => (s === 'added' ? 'A' : s === 'deleted' ? 'D' : 'M');

  if (overlayCmd === 'diff') {
    let changes;
    try {
      changes = diffOverlay({ runtime, agent });
    } catch (e) {
      fail(e);
    }
    if (!changes.length) {
      say('no changes');
      return;
    }
    for (const c of changes) {
      say(`${letter(c.status)} ${c.path}${c.conflict ? ` (CONFLICT: ${c.reason})` : ''}`);
    }
    return;
  }

  if (overlayCmd === 'commit') {
    let res;
    try {
      res = commitOverlay({ runtime, agent, onConflict: skipConflicts ? 'skip' : 'refuse' });
    } catch (e) {
      // Refusal is the product working, not a crash: name every conflict and
      // how to proceed, and exit 1 (never 0 — nothing was committed).
      if (e instanceof Error && /** @type {{code?: string}} */ (e).code === 'SBX_CONFLICT') {
        for (const c of /** @type {{conflicts: {path: string, reason: string}[]}} */ (/** @type {unknown} */ (e)).conflicts) {
          say(`conflict: ${c.path} (${c.reason})`);
        }
        say('commit refused: resolve the conflicts, or re-run with --skip-conflicts to commit the rest');
        process.exit(1);
      }
      fail(e);
    }
    for (const p of res.committed) say(`committed ${p}`);
    for (const s of res.skipped) say(`skipped (conflict): ${s.path} (${s.reason})`);
    if (!res.committed.length && !res.skipped.length) say('nothing to commit');
    return;
  }

  let res;
  try {
    res = rollbackOverlay({ runtime, agent });
  } catch (e) {
    fail(e);
  }
  if (!res.discarded.length) {
    say('nothing to discard');
    return;
  }
  if (!res.exact) {
    say(`discarded ${res.discarded.length} entries (project gone or no userns: exact list unavailable)`);
  }
  for (const c of res.discarded) {
    say(c.status === 'unknown' ? `discarded ${c.path}` : `discarded ${letter(c.status)} ${c.path}`);
  }
}

/**
 * `pending` / `approve` / `deny` over the file channel.
 *
 * @param {string} decisionCmd `pending` | `approve` | `deny`
 * @param {string[]} rest command args
 * @returns {Promise<void>}
 */
async function cliDecide(decisionCmd, rest) {
  const runtime = process.env.SBX_RUNTIME;
  if (!runtime) {
    console.log(USAGE);
    process.exit(2);
  }
  const paths = askPaths(runtime);

  if (decisionCmd === 'pending') {
    let names = [];
    try {
      names = fs.readdirSync(paths.asksDir);
    } catch {}
    const items = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        items.push(JSON.parse(fs.readFileSync(path.join(paths.asksDir, name), 'utf8')));
      } catch {
        // Being written; the next run sees it.
      }
    }
    if (!items.length) {
      console.log('nothing held');
      process.exit(0);
    }
    for (const h of items) {
      // Live wait from the ask file's mtime (the payload's waitingSec is 0 at park).
      let waiting = 0;
      try {
        const st = fs.statSync(paths.askFile(h.id));
        waiting = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
      } catch {}
      // Agent-controlled bytes (URL, rule, body preview): sanitized before
      // they reach the approver's terminal (see `safe`).
      const body = safe(h.bodyPreview).replace(/\s+/g, ' ').slice(0, 200);
      console.log(`${safe(h.id)} ${safe(h.agent)} ${safe(h.method)} ${safe(h.url)} (${waiting}s) rule=${safe(h.rule)} body=${body}`);
    }
    process.exit(0);
  }

  const [id, ...ids] = rest;
  // The id goes straight into `asks/<id>.json` and `answers/<id>.json`:
  // anything but `h<n>` is rejected here (exit 2) before any file is
  // touched, so `sbx approve ../asks/h9` cannot write outside `answers/`.
  if (!HOLD_ID_RE.test(id)) {
    console.log(`bad hold id ${JSON.stringify(id)} (want h<n>, e.g. h1)`);
    process.exit(2);
  }
  // Unknown (never parked, or already settled and swept) is exit 1, never a
  // stray answer file: writing one would linger as stale until the sweeper
  // removes it, and could be misread as a decision that counted.
  try {
    fs.readFileSync(paths.askFile(id), 'utf8');
  } catch {
    console.log(`unknown ${id}`);
    process.exit(1);
  }
  if (decisionCmd === 'approve') {
    writeFileAtomic(paths.answerFile(id), JSON.stringify({ decision: 'allow' }));
    console.log(`approved ${id}`);
  } else {
    writeFileAtomic(paths.answerFile(id),
      JSON.stringify({ decision: 'deny', reason: ids.join(' ') || 'denied by user' }));
    console.log(`denied ${id}`);
  }
}
