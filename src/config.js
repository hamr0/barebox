// barebox's one config file: `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`.
// Only the CLI reads it; library callers (`run`, `createProxy`) pass options.
// Later modules add keys here, not a second file. The sandbox never sees it
// (the launcher masks the directory this file lives in).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODES } from './policy.js';

const DEFAULTS = { mode: 'auto', holdTimeoutSec: 'never', localLlm: [], labels: [], tenants: {} };

/** One `host:port` (host without a colon, port 1-65535). @param {unknown} v @returns {boolean} */
const isHostPort = (v) => {
  if (typeof v !== 'string') return false;
  const m = /^([^\s:/@]+):(\d{1,5})$/.exec(v);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535;
};

/** An absolute http(s) URL. @param {unknown} v @returns {boolean} */
const isHttpUrl = (v) => {
  if (typeof v !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
};

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD/i;
/** A plain object. @param {unknown} v @returns {boolean} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `env`: `{ pass?: names, set?: name -> string }`. @param {unknown} v @returns {string|null} */
const checkEnv = (v) => {
  if (!isObj(v)) return 'must be an object of { pass?, set? }';
  const o = /** @type {Record<string, any>} */ (v);
  for (const k of Object.keys(o)) if (k !== 'pass' && k !== 'set') return `has unknown field "${k}"`;
  if (o.pass !== undefined) {
    if (!Array.isArray(o.pass) || !o.pass.every((n) => typeof n === 'string' && NAME_RE.test(n))) {
      return 'env.pass must be an array of variable names';
    }
    const bad = o.pass.find((n) => SECRET_LIKE.test(n));
    if (bad !== undefined) return `env.pass: "${bad}" looks like a secret; use "secrets" for it`;
  }
  if (o.set !== undefined) {
    if (!isObj(o.set) || !Object.entries(o.set).every(([n, x]) => NAME_RE.test(n) && typeof x === 'string')) {
      return 'env.set must be an object of variable name -> string';
    }
  }
  return null;
};

/** `secrets`: NAME -> `{ fromEnv | value, hosts }`. @param {unknown} v @returns {string|null} */
const checkSecrets = (v) => {
  if (!isObj(v)) return 'must be an object of NAME -> { fromEnv or value, hosts }';
  for (const [name, s] of Object.entries(/** @type {Record<string, any>} */ (v))) {
    if (!NAME_RE.test(name)) return `secret name "${name}" is not a variable name`;
    if (!isObj(s)) return `secret ${name} must be an object`;
    for (const k of Object.keys(s)) if (!['fromEnv', 'value', 'hosts'].includes(k)) return `secret ${name} has unknown field "${k}"`;
    if ((s.fromEnv === undefined) === (s.value === undefined)) return `secret ${name} needs exactly one of fromEnv or value`;
    if (s.fromEnv !== undefined && (typeof s.fromEnv !== 'string' || !NAME_RE.test(s.fromEnv))) return `secret ${name}: fromEnv must be a variable name`;
    if (s.value !== undefined && (typeof s.value !== 'string' || s.value === '')) return `secret ${name}: value must be a non-empty string`;
    if (!Array.isArray(s.hosts) || !s.hosts.length
      || !s.hosts.every((h) => typeof h === 'string' && /^[^\s:/@]+$/.test(h))) {
      return `secret ${name}: hosts must be a non-empty array of hostnames (no scheme, no port)`;
    }
  }
  return null;
};

/** Validators by key; each returns an error string or null. */
const KEYS = {
  mode: (v) => (MODES.includes(v) ? null : `must be one of ${MODES.join(', ')}`),
  holdTimeoutSec: (v) => (v === 'never' || (Number.isInteger(v) && v > 0)
    ? null : 'must be a positive integer or "never"'),
  heldBodyMaxMB: (v) => (Number.isInteger(v) && v > 0 ? null : 'must be a positive integer'),
  localLlm: (v) => (Array.isArray(v) && v.every(isHostPort)
    ? null : 'must be an array of "host:port" strings (port 1-65535)'),
  labels: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
    ? null : 'must be an array of folder paths (strings)'),
  tenants: (v) => (v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every((a) => Array.isArray(a) && a.length > 0 && a.every(isHttpUrl))
    ? null : 'must be an object of vendor -> non-empty array of http(s) URLs'),
  env: checkEnv,
  secrets: checkSecrets,
};

/**
 * Where the config file lives.
 *
 * @param {NodeJS.ProcessEnv} [env] environment to read (default `process.env`)
 * @returns {string} absolute path of `config.json`
 */
export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'barebox', 'config.json');
}

/**
 * Read the config file over the defaults. No file means defaults.
 *
 * @param {NodeJS.ProcessEnv} [env] environment to read (default `process.env`)
 * @returns {{ mode: string, holdTimeoutSec: number|string, localLlm: string[], labels: string[], tenants: Record<string, string[]>, heldBodyMaxMB?: number, env?: { pass?: string[], set?: Record<string, string> }, secrets?: Record<string, { fromEnv?: string, value?: string, hosts: string[] }> }} effective settings (`heldBodyMaxMB` absent means the library default)
 * @throws {Error} naming the file (and the key) on invalid JSON, an unknown key or a bad value
 */
export function loadConfig(env = process.env) {
  const file = configPath(env);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file}: must be a JSON object`);
  }
  for (const [k, v] of Object.entries(data)) {
    if (!Object.hasOwn(KEYS, k)) throw new Error(`${file}: unknown key "${k}"`);
    const bad = KEYS[/** @type {keyof typeof KEYS} */ (k)](v);
    if (bad) throw new Error(`${file}: key "${k}" ${bad}`);
  }
  // A secret read from the host environment must be there at startup (the name, never a value).
  for (const [name, s] of Object.entries(data.secrets ?? {})) {
    if (s.fromEnv !== undefined && !env[s.fromEnv]) {
      throw new Error(`${file}: secret ${name}: host variable ${s.fromEnv} is not set`);
    }
  }
  return { ...DEFAULTS, ...data };
}

/**
 * Settings for one `sbx run`: a CLI flag beats the file, the file beats the default.
 *
 * @param {object} [flags] values given on the command line
 * @param {string} [flags.mode] `--mode`
 * @param {string} [flags.hold] `--hold` (`"never"` or a positive integer of seconds, as typed)
 * @param {NodeJS.ProcessEnv} [env] environment to read (default `process.env`)
 * @returns {{ mode: string, holdTimeoutSec: number|string, localLlm: string[], labels: string[], tenants: Record<string, string[]>, heldBodyMaxMB?: number, env?: { pass?: string[], set?: Record<string, string> }, secrets?: Record<string, { fromEnv?: string, value?: string, hosts: string[] }> }} effective settings (`heldBodyMaxMB` absent means the library default)
 * @throws {Error} as {@link loadConfig}
 */
export function resolveConfig(flags = {}, env = process.env) {
  const cfg = loadConfig(env);
  let hold;
  if (flags.hold !== undefined) {
    hold = flags.hold === 'never' ? 'never' : /^\d+$/.test(flags.hold) ? Number(flags.hold) : flags.hold;
    const bad = KEYS.holdTimeoutSec(hold);
    if (bad) throw new Error(`--hold ${bad}`);
  }
  return {
    ...cfg,
    ...(flags.mode !== undefined ? { mode: flags.mode } : {}),
    ...(hold !== undefined ? { holdTimeoutSec: hold } : {}),
  };
}
