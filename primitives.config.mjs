import { basename } from 'node:path';

function inferCategory(file) { // file is POSIX-normalized, relative to repo root
  const b = basename(file, '.js');
  if (b === 'index' || b === 'types') return 'core';
  if (b === 'gate') return 'gate';
  return b; // fallback: file name
}

export default { inferCategory, sourceRoots: ['src'], receivers: {} };
