// labels.js — the only reader of rwxmap label folders (`labels` in the config).
// Per vendor the rwxmap CLI writes `<v>.rwxmap.json` (the gate file: the
// letters barebox uses) and `<v>.rwxmap.review.json` (the sidecar the matcher
// reads). Letters come from the gate file only, never from the sidecar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matcherFrom } from 'rwxmap/match';

const REVIEW = '.rwxmap.review.json';
const GATE = '.rwxmap.json';

/** @param {string} file @returns {any} parsed JSON, errors naming the file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Load every label folder: the matcher for request keys and the tools table
 * (key to `{ letter, marker }`) from the gate files. Call once at startup so a
 * bad file fails the run before any agent starts.
 *
 * @param {object} cfg
 * @param {string[]} [cfg.labels] folders the rwxmap CLI wrote (`~/` means `$HOME`)
 * @param {Record<string, string[]>} [cfg.tenants] vendor to tenant base URLs, replacing the sidecar's `servers`
 * @param {NodeJS.ProcessEnv} [env] environment for `$HOME`
 * @returns {{ matcher: ReturnType<typeof matcherFrom>, tools: Record<string, any>, dirs: string[] }} `dirs` are the absolute folders (the launcher masks them)
 * @throws {Error} naming the file or folder on a missing gate or review file, a duplicate key, an unknown tenant vendor or a bad sidecar
 */
export function loadLabels({ labels = [], tenants = {} }, env = process.env) {
  const home = env.HOME || os.homedir();
  /** @type {Record<string, any>} */
  const tools = {};
  /** @type {Record<string, string>} key to the gate file that defined it */
  const origin = {};
  /** @type {any[]} */
  const sidecars = [];
  /** @type {Map<string, string>} sidecar vendor to review file path */
  const vendors = new Map();
  /** @type {string[]} */
  const dirs = [];
  for (const raw of labels) {
    const dir = path.resolve(raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
    dirs.push(dir);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(REVIEW)).sort();
    } catch (e) {
      throw new Error(`labels folder ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!names.length) throw new Error(`labels folder ${dir}: no *${REVIEW} file`);
    for (const n of names) {
      const review = path.join(dir, n);
      const gateFile = path.join(dir, n.slice(0, -REVIEW.length) + GATE);
      if (!fs.existsSync(gateFile)) throw new Error(`${review}: missing its gate file ${gateFile}`);
      const side = readJson(review);
      const gate = readJson(gateFile);
      const t = gate?.bareguard?.tools;
      if (t === null || typeof t !== 'object' || Array.isArray(t)) {
        throw new Error(`${gateFile}: no bareguard.tools object`);
      }
      for (const [k, v] of Object.entries(t)) {
        if (Object.hasOwn(tools, k)) throw new Error(`${gateFile}: key "${k}" is also defined in ${origin[k]}`);
        tools[k] = v;
        origin[k] = gateFile;
      }
      const tenant = side?.vendor !== undefined ? tenants[side.vendor] : undefined;
      if (tenant) side.servers = tenant;
      if (side?.vendor !== undefined) vendors.set(side.vendor, review);
      sidecars.push({ side, review });
    }
  }
  for (const v of Object.keys(tenants)) {
    if (!vendors.has(v)) throw new Error(`tenants: vendor "${v}" is in no labels folder`);
  }
  let matcher;
  try {
    matcher = matcherFrom(sidecars.map((s) => s.side));
  } catch (e) {
    // matcherFrom does not say which file; name the files (pre-0.8.0 message passes through).
    throw new Error(`${sidecars.map((s) => s.review).join(', ')}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { matcher, tools, dirs };
}
