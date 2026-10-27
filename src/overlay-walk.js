// overlay-walk.js — merged-view walker entry for bwrap mounts (see overlay.js).
//
// Runs INSIDE the overlay mount as `/usr/bin/node <this file> <merged>
// <ignore-json> [stage-dir]`: `src/` is bound read-only at its own path, so
// this imports the one walker (`walkLocal`) instead of duplicating it. Prints
// the manifest as JSON on stdout (an array of `[rel, entry]` pairs). With a
// stage dir, also copies every regular file and recreates every symlink under
// it — the host commit then renames them into the project, never copying.
// Exotic kinds (fifos, sockets, devices) and non-UTF-8 names are refused
// loudly by `walkLocal`, never mangled: the mount exits nonzero instead.
import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { walkLocal } from './overlay.js';

const [, , mergedDir, ignoreJson, stageDir] = process.argv;
if (!mergedDir || !ignoreJson) {
  console.error('usage: overlay-walk.js <merged-dir> <ignore-json> [stage-dir]');
  process.exit(2);
}
/** @type {string[]} */
const ignore = JSON.parse(ignoreJson);

const manifest = walkLocal(mergedDir, new Set(ignore));

if (stageDir) {
  for (const [rel, e] of manifest) {
    if (e.type !== 'f' && e.type !== 'l') continue;
    const dst = join(stageDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (e.type === 'f') copyFileSync(join(mergedDir, rel), dst);
    else symlinkSync(/** @type {string} */ (e.target), dst);
  }
}

process.stdout.write(JSON.stringify([...manifest]));
