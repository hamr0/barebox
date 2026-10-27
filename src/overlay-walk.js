// overlay-walk.js — merged-view walker entry for bwrap mounts (see overlay.js).
//
// Runs INSIDE the overlay mount as `<node> <this file> <merged>
// <ignore-json> <manifest-file> <stage-dir-or-empty> <upper-paths-or-empty>`
// (`<node>` is the node running barebox now): `src/` is bound read-only at
// its own path, so this imports the one walker (`walkLocal`) instead of
// duplicating it. Prints nothing on stdout: the manifest (an array of
// `[rel, entry]` pairs) goes to `<manifest-file>` inside a folder bound
// read-write at `/sbx-out`, so trees of any size travel without an output
// cap. The upper-paths file (also in `/sbx-out`) lists the upper's relative
// paths: only those get full entries (hashes, link targets) and staging —
// every other merged path is the lower entry unchanged (opaque folders and
// copy-up both land the path in the upper), so the host fills it from the
// lower without a second hash. With a stage dir, only listed files/symlinks
// are copied under it — the host commit then renames them into the project,
// never copying. Exotic kinds (fifos, sockets, devices) and non-UTF-8 names
// are refused loudly by `walkLocal`, never mangled: the mount exits nonzero
// instead.
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { walkLocal } from './overlay.js';

const [, , mergedDir, ignoreJson, manifestFile, stageArg, upperPathsArg] = process.argv;
if (!mergedDir || !ignoreJson || !manifestFile) {
  console.error('usage: overlay-walk.js <merged-dir> <ignore-json> <manifest-file> [stage-dir] [upper-paths-file]');
  process.exit(2);
}
/** @type {string[]} */
const ignore = JSON.parse(ignoreJson);
const stageDir = stageArg || null;
/** @type {Set<string>|null} */
const upperPaths = upperPathsArg
  ? new Set(/** @type {string[]} */ (JSON.parse(readFileSync(upperPathsArg, 'utf8'))))
  : null;

const manifest = walkLocal(mergedDir, new Set(ignore), upperPaths);

if (stageDir) {
  for (const [rel, e] of manifest) {
    if (e.type !== 'f' && e.type !== 'l') continue;
    if (upperPaths && !upperPaths.has(rel)) continue;
    const dst = join(stageDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (e.type === 'f') copyFileSync(join(mergedDir, rel), dst);
    else symlinkSync(/** @type {string} */ (e.target), dst);
  }
}

writeFileSync(manifestFile, JSON.stringify([...manifest]));
