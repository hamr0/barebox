// Shared extractor for fenced js blocks in the context doc, used by the
// doc test and its unit test. Info-string rules: the first token must be
// `js`; a `no-run` token among the rest marks the block skipped.
/**
 * @param {string} text markdown source
 * @returns {{ code: string, run: boolean }[]} every fenced js block, in order
 */
export function jsBlocks(text) {
  const out = [];
  const re = /^```([^\n]*)\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(text))) {
    const [lang, ...flags] = m[1].trim().split(/\s+/);
    if (lang !== 'js') continue;
    out.push({ code: m[2], run: !flags.includes('no-run') });
  }
  return out;
}
