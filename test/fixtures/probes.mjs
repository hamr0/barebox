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
 * True when bwrap is on `PATH` and runs `bwrap --version` with exit 0.
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
