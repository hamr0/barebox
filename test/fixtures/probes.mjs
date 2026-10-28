// probes.mjs — one place that decides whether the sandbox tools exist.
// bwrap is found by PATH lookup, so a /usr/local source build counts as
// well as /usr/bin; a hardcoded path made every bwrap test skip there.
import { execFileSync, spawnSync } from 'node:child_process';

/** True when `name` is on PATH. @param {string} name @returns {boolean} */
export function hasBin(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/**
 * True when bwrap runs: `bwrap --version` must exit 0. This checks it is
 * usable, not just present.
 *
 * @returns {boolean}
 */
export function bwrapUsable() {
  try {
    return spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
