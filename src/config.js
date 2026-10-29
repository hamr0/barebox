// barebox's one config file: `${XDG_CONFIG_HOME:-$HOME/.config}/barebox/config.json`.
// Only the CLI reads it; library callers (`run`, `createProxy`) pass options.
// Later modules add keys here, not a second file. The sandbox never sees it
// (the launcher masks the directory this file lives in).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODES } from './policy.js';

const DEFAULTS = { mode: 'auto', holdTimeoutSec: 120, localLlm: [] };

/** One `host:port` (host without a colon, port 1-65535). @param {unknown} v @returns {boolean} */
const isHostPort = (v) => {
  if (typeof v !== 'string') return false;
  const m = /^([^\s:/@]+):(\d{1,5})$/.exec(v);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535;
};

/** Validators by key; each returns an error string or null. */
const KEYS = {
  mode: (v) => (MODES.includes(v) ? null : `must be one of ${MODES.join(', ')}`),
  holdTimeoutSec: (v) => (v === 'never' || (Number.isInteger(v) && v > 0)
    ? null : 'must be a positive integer or "never"'),
  heldBodyMaxMB: (v) => (Number.isInteger(v) && v > 0 ? null : 'must be a positive integer'),
  localLlm: (v) => (Array.isArray(v) && v.every(isHostPort)
    ? null : 'must be an array of "host:port" strings (port 1-65535)'),
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
 * @returns {{ mode: string, holdTimeoutSec: number|string, localLlm: string[], heldBodyMaxMB?: number }} effective settings (`heldBodyMaxMB` absent means the library default)
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
  return { ...DEFAULTS, ...data };
}

/**
 * Settings for one `sbx run`: a CLI flag beats the file, the file beats the default.
 *
 * @param {object} [flags] values given on the command line
 * @param {string} [flags.mode] `--mode`
 * @param {NodeJS.ProcessEnv} [env] environment to read (default `process.env`)
 * @returns {{ mode: string, holdTimeoutSec: number|string, localLlm: string[], heldBodyMaxMB?: number }} effective settings (`heldBodyMaxMB` absent means the library default)
 * @throws {Error} as {@link loadConfig}
 */
export function resolveConfig(flags = {}, env = process.env) {
  const cfg = loadConfig(env);
  return { ...cfg, ...(flags.mode !== undefined ? { mode: flags.mode } : {}) };
}
