#!/usr/bin/env -S node --max-semi-space-size=1
// sbx — second-terminal CLI for the hold queue (M2.5 file channel):
// sbx pending | approve <id> | deny <id> [reason]
// Reads `<runtime>/asks/<id>.json`, answers by atomically writing
// `<runtime>/answers/<id>.json` (tmp file + rename, so the proxy never sees
// a partial). The runtime comes from SBX_RUNTIME only; there is no
// cwd-relative default.
//
// Settings (mode, holdTimeoutSec) come from the one config file, see config.js;
// a flag beats the file. A bad file is a usage-class error (exit 2).
//
// sbx run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd> [...]
// Runs one sandboxed agent start-to-finish in this process (project = cwd).
// The runtime is SBX_RUNTIME when set, else a short temp dir (printed to
// stderr so a second terminal can approve from it). With --json, stdout
// carries JSON lines only (`{"ev":"ask",...}` per parked ask,
// `{"ev":"decided","id","decision","reason"}` when each one ends (answered,
// timed out, or its client went away), then `{"ev":"done","exit":N}`); the
// agent's own output goes to stderr there so the stream stays parseable. Without --json the same events print as
// human-readable lines. The process exit code mirrors the agent's (usage
// errors stay exit 2). SBX_UNSAFE_TEST_ALLOW_LOOPBACK=1 is a TEST-ONLY opt-in
// (fixtures live on 127.0.0.1); production never sets it.
//
// sbx diff [--agent <name>] | commit [--agent <name>] [--skip-conflicts] | rollback [--agent <name>]
// Reviews the M4 tracing paper of the last overlay run in SBX_RUNTIME:
// `diff` lists added/modified/deleted paths (`A`/`M`/`D`, conflicts flagged),
// `commit` presses the paper down (refusing on conflicts unless
// --skip-conflicts), `rollback` throws it away. Exit 1 on refusal or when no
// overlay exists for the agent (default `agent`); SBX_RUNTIME is required.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import { writeFileAtomic } from './holds.js';
import { run as sandboxRun } from './run.js';
import { diffOverlay, commitOverlay, rollbackOverlay } from './overlay.js';
import { assertAgentName, createRuntime, runtimePaths, runtimeLive, safe, shellQuote } from './runtime.js';

const USAGE = 'usage: sbx [--help] | pending | approve <id> | deny <id> [reason] | diff [--agent <name>] | commit [--agent <name>] [--skip-conflicts] | rollback [--agent <name>] | run [--mode ask|auto|trust] [--json] [--overlay] -- <cmd> [...]';

/** Hold ids the CLI accepts: `h<n>` only. Anything else is a usage error, never a path. */
const HOLD_ID_RE = /^h\d+$/;

// Exit codes: 0 ok, 1 unknown id / refused / run failure, 2 usage.
// `sbx run` mirrors the agent's exit code instead (usage errors stay 2).
//
// Every line `sbx` prints goes through `out` (stdout) or `err` (stderr):
// both sanitize, so agent-chosen bytes (paths, URLs, reasons) can never
// smuggle terminal control into the approver's terminal.
function out(line) {
  console.log(safe(line));
}
function err(line) {
  console.error(safe(line));
}
/** Usage error on stderr, exit 2. @returns {never} */
function usage() {
  err(USAGE);
  process.exit(2);
}
/** `SBX_RUNTIME` or a usage error. @returns {string} */
function needRuntime() {
  const runtime = process.env.SBX_RUNTIME;
  if (!runtime) usage();
  return runtime;
}
/**
 * @param {string[]} rest argv after the subcommand
 * @param {object} [opts]
 * @param {boolean} [opts.skipConflicts] this command accepts `--skip-conflicts` (commit only)
 * @returns {{ runtime: string, agent: string, skipConflicts: boolean }}
 */
function overlayArgs(rest, { skipConflicts = false } = {}) {
  const runtime = needRuntime();
  /** @type {{ agent?: string, 'skip-conflicts'?: boolean }} */
  let flagValues;
  try {
    ({ values: flagValues } = parseArgs({
      args: rest,
      options: {
        agent: { type: 'string' },
        'skip-conflicts': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    usage();
  }
  const agent = flagValues.agent ?? 'agent';
  const skip = flagValues['skip-conflicts'] ?? false;
  if (skip && !skipConflicts) usage();
  try {
    assertAgentName(agent);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  return { runtime, agent, skipConflicts: skip };
}
/**
 * @param {string[]} rest argv after the subcommand
 * @returns {{ runtime: string, positionals: string[] }}
 */
function decideArgs(rest) {
  const runtime = needRuntime();
  /** @type {string[]} */
  let positionals;
  try {
    ({ positionals } = parseArgs({ args: rest, options: {}, strict: true, allowPositionals: true }));
  } catch {
    usage();
  }
  return { runtime, positionals };
}
/** Overlay failure on stderr, exit 1 (`process.exit` is already `never`). @param {unknown} e @returns {never} */
function fail(e) {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** Change status to its letter. @param {string} s @returns {string} */
const letter = (/** @type {string} */ s) => (s === 'added' ? 'A' : s === 'deleted' ? 'D' : 'M');

const COMMANDS = { run, diff, commit, rollback, pending, approve, deny };
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') {
  if (!cmd) usage();
  out(USAGE);
  process.exit(0);
}
if (!Object.hasOwn(COMMANDS, /** @type {string} */ (cmd))) usage();
await COMMANDS[/** @type {keyof typeof COMMANDS} */ (cmd)](args);

/**
 * One sandboxed run in this process. Reports every parked ask from the
 * queue's events (same process, so nothing is polled and no ask is missed),
 * then the agent's exit code.
 *
 * @param {string[]} args argv after `run`
 * @returns {Promise<void>} sets `process.exitCode` (mirrors the agent)
 */
async function run(args) {
  const sep = args.indexOf('--');
  if (sep < 0) usage();
  const flags = args.slice(0, sep);
  const command = args.slice(sep + 1);
  /** @type {{ mode?: string, json?: boolean, overlay?: boolean }} */
  let values;
  try {
    ({ values } = parseArgs({
      args: flags,
      options: {
        mode: { type: 'string' },
        json: { type: 'boolean' },
        overlay: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    usage();
  }
  if (values.mode !== undefined && !['ask', 'auto', 'trust'].includes(values.mode)) usage();
  /** @type {{ mode: string, holdTimeoutSec: number|string }} */
  let cfg;
  try {
    cfg = resolveConfig({ mode: values.mode });
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const { mode } = cfg;
  const timeoutMs = cfg.holdTimeoutSec === 'never' ? 'never' : Number(cfg.holdTimeoutSec) * 1000;
  if (!command.length) usage();
  const json = values.json ?? false;
  const overlay = values.overlay ?? false;
  const runtime = process.env.SBX_RUNTIME || createRuntime();
  // Agent-controlled bytes, sanitized before they reach a terminal or a JSON consumer.
  const clean = (o, keys) => {
    const c = { ...o };
    for (const k of keys) if (c[k] != null) c[k] = safe(c[k]);
    return c;
  };
  const emitAsk = (h) => {
    const c = clean(h, ['id', 'agent', 'method', 'url', 'rule', 'bodyPreview']);
    if (json) out(JSON.stringify({ ev: 'ask', ...c }));
    else out(`ask ${c.id} ${c.agent} ${c.method} ${c.url} rule=${c.rule}`);
  };
  const emitDecided = (e) => {
    const c = clean(e, ['id', 'decision', 'reason']);
    if (json) out(JSON.stringify({ ev: 'decided', id: c.id, decision: c.decision, reason: c.reason }));
    else out(`decided ${c.id} ${c.decision}${c.reason ? ` (${c.reason})` : ''}`);
  };
  err(`runtime ${runtime} (answer with: SBX_RUNTIME=${shellQuote(runtime)} sbx approve <id>)`);
  /** @type {{ exit: number, diff: { path: string }[] } | null} */
  let result = null;
  try {
    // SBX_OVERLAY_IGNORE extends the M4 ignore list (Q3) as comma names.
    const extraIgnore = (process.env.SBX_OVERLAY_IGNORE ?? '').split(',')
      .map((s) => s.trim()).filter(Boolean);
    result = await sandboxRun({
      runtime, proj: process.cwd(), command, mode, timeoutMs,
      unsafeTestOnly: { allowLoopback: process.env.SBX_UNSAFE_TEST_ALLOW_LOOPBACK === '1' },
      overlay,
      ...(extraIgnore.length ? { overlayIgnore: ['node_modules', ...extraIgnore] } : {}),
      onEvent: (e) => { if (e.type === 'ask') emitAsk(e.ask); else emitDecided(e); },
      // With --json stdout is a pure event stream: agent output goes to
      // stderr so a parser never trips over it.
      ...(json ? { stdout: process.stderr, stderr: process.stderr } : {}),
    });
  } catch (e) {
    err(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (json) out(JSON.stringify({ ev: 'done', exit: result.exit }));
  else out(`done exit ${result.exit}`);
  if (overlay) {
    const n = result.diff.length;
    err(n
      ? `overlay: ${n} change(s) — review with: SBX_RUNTIME=${runtime} sbx diff`
      : 'overlay: no changes');
  }
  process.exitCode = result.exit;
}

/** @param {string[]} rest @returns {Promise<void>} */
async function diff(rest) {
  const { runtime, agent } = overlayArgs(rest);
  let changes;
  try {
    changes = diffOverlay({ runtime, agent });
  } catch (e) {
    fail(e);
  }
  if (!changes.length) {
    out('no changes');
    return;
  }
  for (const c of changes) {
    out(`${letter(c.status)} ${c.path}${c.conflict ? ` (CONFLICT: ${c.reason})` : ''}`);
  }
}

/** @param {string[]} rest @returns {Promise<void>} */
async function commit(rest) {
  const { runtime, agent, skipConflicts } = overlayArgs(rest, { skipConflicts: true });
  let res;
  try {
    res = commitOverlay({ runtime, agent, onConflict: skipConflicts ? 'skip' : 'refuse' });
  } catch (e) {
    // Refusal is the product working, not a crash: name every conflict and
    // how to proceed on stderr, and exit 1 (never 0 — nothing was committed).
    if (e instanceof Error && /** @type {{code?: string}} */ (e).code === 'SBX_CONFLICT') {
      for (const c of /** @type {{conflicts: {path: string, reason: string}[]}} */ (/** @type {unknown} */ (e)).conflicts) {
        err(`conflict: ${c.path} (${c.reason})`);
      }
      err('commit refused: resolve the conflicts, or re-run with --skip-conflicts to commit the rest');
      process.exit(1);
    }
    fail(e);
  }
  for (const p of res.committed) out(`committed ${p}`);
  for (const s of res.skipped) out(`skipped (conflict): ${s.path} (${s.reason})`);
  if (!res.committed.length && !res.skipped.length) out('nothing to commit');
}

/** @param {string[]} rest @returns {Promise<void>} */
async function rollback(rest) {
  const { runtime, agent } = overlayArgs(rest);
  let res;
  try {
    res = rollbackOverlay({ runtime, agent });
  } catch (e) {
    fail(e);
  }
  if (!res.exact) {
    if (res.discarded.length) {
      out(`discarded ${res.discarded.length} entries, exact list unavailable: ${res.why}`);
    } else {
      out(`discarded (could not list: ${res.why})`);
    }
  } else if (!res.discarded.length) {
    out('nothing to discard');
    return;
  }
  for (const c of res.discarded) {
    out(c.status === 'unknown' ? `discarded ${c.path}` : `discarded ${letter(c.status)} ${c.path}`);
  }
}

/** @param {string[]} rest @returns {Promise<void>} */
async function pending(rest) {
  const { runtime } = decideArgs(rest);
  const paths = runtimePaths(runtime);
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
      out('nothing held');
      process.exit(0);
    }
    if (!(await runtimeLive(runtime))) {
      err(`no live proxy on ${runtime}: ${items.length} stale ask(s) can't be decided (cleared at the next start)`);
      process.exit(1);
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
      out(`${safe(h.id)} ${safe(h.agent)} ${safe(h.method)} ${safe(h.url)} (${waiting}s) rule=${safe(h.rule)} body=${body}`);
    }
    process.exit(0);
}

/**
 * @param {string[]} rest command args (`<id> [reason]`)
 * @returns {Promise<{ id: string, reason: string, paths: ReturnType<typeof runtimePaths> }>}
 */
async function answerTarget(rest) {
  const { runtime, positionals } = decideArgs(rest);
  const [id, ...ids] = positionals;
  // The id goes straight into `asks/<id>.json` and `answers/<id>.json`:
  // anything but `h<n>` is rejected here (exit 2) before any file is
  // touched, so `sbx approve ../asks/h9` cannot write outside `answers/`.
  if (id === undefined) usage();
  if (!HOLD_ID_RE.test(id)) {
    err(`bad hold id ${JSON.stringify(id)} (want h<n>, e.g. h1)`);
    process.exit(2);
  }
  const paths = runtimePaths(runtime);
  try {
    fs.readFileSync(paths.askFile(id), 'utf8');
  } catch {
    err(`unknown ${id}`);
    process.exit(1);
  }
  if (!(await runtimeLive(runtime))) {
    err(`no live proxy on ${runtime}: nothing reads answers`);
    process.exit(1);
  }
  return { id, reason: ids.join(' ') || 'denied by user', paths };
}

/** @param {string[]} rest @returns {Promise<void>} */
async function approve(rest) {
  const { id, paths } = await answerTarget(rest);
  writeFileAtomic(paths.answerFile(id), JSON.stringify({ decision: 'allow' }));
  out(`approved ${id}`);
}

/** @param {string[]} rest @returns {Promise<void>} */
async function deny(rest) {
  const { id, reason, paths } = await answerTarget(rest);
  writeFileAtomic(paths.answerFile(id), JSON.stringify({ decision: 'deny', reason }));
  out(`denied ${id}`);
}
