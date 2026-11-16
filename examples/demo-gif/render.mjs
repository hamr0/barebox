// Renders one take to the README GIF (module 2). Node stdlib + ffmpeg (librsvg) only.
//   ./record.sh                                   # one real take -> examples/demo-gif/take/
//   node examples/demo-gif/render.mjs examples/demo-gif/take examples/demo-gif/captions.json assets/demo.gif
// The GIF is 2x (1600 px wide); the README shows it with width="800".
// Replays take.log through a small VT emulator (80x30), draws each screen change as an SVG
// frame plus a caption bar, and encodes with ffmpeg. Any escape it does not know exits 1.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const COLS = 80, ROWS = 30, CW = 10, RH = 20, FS = 16.67, CAPH = 60;
const W = COLS * CW, H = ROWS * RH + CAPH; // the drawing's units
const SCALE = 2; // output pixels per unit: antialiased text stays legible when shown at width="800"
const IDLE = 4.0, END_HOLD = 6, FPS = 6, MAX_BYTES = 2_000_000;
const FONT = 'JetBrainsMono Nerd Font Mono';
const CAP_FS = 14, CAP_LINE = 22, CAP_COLS = 90; // caption chars per line, 2 lines max

const fail = (msg) => { console.error(`render: ${msg}`); process.exit(1); };

const [takeDir, capFile, outFile] = process.argv.slice(2);
if (!takeDir || !capFile || !outFile) fail('usage: render.mjs <takeDir> <captions.json> <out.gif>');

// ---- inputs
const log = readFileSync(join(takeDir, 'take.log'));
const timing = readFileSync(join(takeDir, 'take.timing'), 'utf8').trim().split('\n').map((l) => {
  const [d, n] = l.split(' ').map(Number);
  if (!Number.isFinite(d) || !Number.isInteger(n)) fail(`bad take.timing line: ${l}`);
  return [d, n];
});
const total = timing.reduce((s, [, n]) => s + n, 0);
if (log.length !== total) fail(`take.log is ${log.length} bytes but take.timing counts ${total}`);

const captions = JSON.parse(readFileSync(capFile, 'utf8'));
function wrap(text) { // greedy word wrap
  const lines = []; let cur = '';
  for (const w of text.split(' ')) {
    if (cur && cur.length + 1 + w.length > CAP_COLS) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  lines.push(cur);
  return lines;
}
for (const c of captions) {
  c.lines = wrap(c.text);
  if (c.lines.length > 2) fail(`caption needs ${c.lines.length} lines (max 2): "${c.text}"`);
}

// ---- VT subset: SGR, \r \n \b, deferred wrap, scroll
const PAL = { 30: '#45475a', 31: '#f38ba8', 32: '#a6e3a1', 33: '#f9e2af', 34: '#89b4fa', 35: '#cba6f7', 36: '#94e2d5', 37: '#bac2de',
  90: '#6c7086', 91: '#f38ba8', 92: '#a6e3a1', 93: '#f9e2af', 94: '#89b4fa', 95: '#cba6f7', 96: '#94e2d5', 97: '#cdd6f4' };
const FG = '#cdd6f4', BG = '#1e1e2e', DIMFG = '#7f849c';
let grid = Array.from({ length: ROWS }, () => []);
let cx = 0, cy = 0, wrapPending = false, fg = null, bold = false, dim = false;
const lf = () => { if (cy === ROWS - 1) { grid.shift(); grid.push([]); } else cy++; };
function put(ch) {
  if (wrapPending) { cx = 0; lf(); wrapPending = false; }
  grid[cy][cx] = { ch, fg, bold, dim };
  if (cx === COLS - 1) wrapPending = true; else cx++;
}
function sgr(params) {
  for (const code of params === '' ? [0] : params.split(';').map(Number)) {
    if (code === 0) { fg = null; bold = false; dim = false; }
    else if (code === 1) bold = true;
    else if (code === 2) dim = true;
    else if (code === 22) { bold = false; dim = false; }
    else if (code === 39) fg = null;
    else if (PAL[code]) fg = PAL[code];
    else fail(`unknown escape: SGR ${code} (ESC[${params}m)`);
  }
}
const show = (s) => JSON.stringify(s);
let mode = 0, esc = ''; // 0 text, 1 after ESC, 2 inside CSI
function feed(s) {
  for (const ch of s) {
    if (mode === 1) {
      if (ch === '[') { mode = 2; esc = ''; } else fail(`unknown escape: ESC ${show(ch)}`);
    } else if (mode === 2) {
      if (ch >= '@' && ch <= '~') {
        if (ch === 'm' && /^[0-9;]*$/.test(esc)) sgr(esc); else fail(`unknown escape: ESC[${esc}${ch}`);
        mode = 0;
      } else esc += ch;
    } else if (ch === '\x1b') mode = 1;
    else if (ch === '\r') { cx = 0; wrapPending = false; }
    else if (ch === '\n') { lf(); wrapPending = false; }
    else if (ch === '\b') { if (cx > 0) cx--; wrapPending = false; }
    else if (ch < ' ' || ch === '\x7f') fail(`unknown control character ${show(ch)}`);
    else put(ch);
  }
}

// ---- replay: one snapshot per screen or caption change, on the capped timeline
const dec = new TextDecoder('utf-8');
const snaps = [];
let off = 0, vt = 0, capIdx = -1, lastKey = null, seen = '', prevAt = -1;
for (const [d, n] of timing) {
  const live = capIdx >= 0 && captions[capIdx].realtime;
  vt += live ? d : Math.min(d, IDLE);
  const part = dec.decode(log.subarray(off, off + n), { stream: true });
  feed(part);
  off += n;
  seen += part;
  // an anchor counts at its first appearance in the output, after the previous anchor's
  for (let at; capIdx + 1 < captions.length && (at = seen.indexOf(captions[capIdx + 1].when, prevAt + 1)) >= 0;) {
    capIdx++; prevAt = at; captions[capIdx].start = vt;
  }
  const key = JSON.stringify(grid) + cx + ',' + cy + ':' + capIdx;
  if (key !== lastKey) { snaps.push({ t: vt, cap: capIdx, cx, cy, grid: JSON.parse(JSON.stringify(grid)) }); lastKey = key; }
}
if (mode !== 0) fail('take.log ends inside an escape sequence');
if (capIdx + 1 < captions.length) {
  fail(`caption anchor not found (or out of order): "${captions[capIdx + 1].when}" (caption ${capIdx + 2} of ${captions.length})`);
}
const t0 = snaps[0].t;
for (const s of snaps) s.t -= t0;
for (const c of captions) c.start -= t0;
snaps.forEach((s, i) => { s.dur = (snaps[i + 1]?.t ?? s.t + END_HOLD) - s.t; });
if (snaps[snaps.length - 1].dur !== END_HOLD) fail('internal: last frame hold');

// ---- SVG frames
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function svg(f) {
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${BG}"/>`;
  o += `<g font-family="${FONT}" font-size="${FS}">`;
  for (let y = 0; y < ROWS; y++) {
    const runs = [];
    for (let x = 0; x < COLS; x++) {
      const c = f.grid[y][x] ?? { ch: ' ', fg: null, bold: false, dim: false };
      const col = c.dim ? (c.fg || DIMFG) : (c.fg || FG);
      const last = runs[runs.length - 1];
      if (last && last.col === col && last.b === c.bold) last.s += c.ch; else runs.push({ col, b: c.bold, s: c.ch });
    }
    while (runs.length && /^ *$/.test(runs[runs.length - 1].s)) runs.pop();
    if (!runs.length) continue;
    o += `<text x="0" y="${y * RH + 15}" xml:space="preserve">` +
      runs.map((r) => `<tspan fill="${r.col}"${r.b ? ' font-weight="bold"' : ''}>${xml(r.s)}</tspan>`).join('') + '</text>';
  }
  o += `<rect x="${Math.min(f.cx, COLS - 1) * CW}" y="${f.cy * RH + 2}" width="${CW}" height="16" fill="${FG}" opacity="0.5"/>`;
  o += `</g><rect y="${ROWS * RH}" width="${W}" height="${CAPH}" fill="#11111b"/>`;
  if (f.cap >= 0) {
    const ls = captions[f.cap].lines, y0 = ROWS * RH + (CAPH - ls.length * CAP_LINE) / 2 + 16;
    o += `<g font-family="${FONT}" font-size="${CAP_FS}" fill="#f5e0dc" text-anchor="middle">` +
      ls.map((l, i) => `<text x="${W / 2}" y="${y0 + i * CAP_LINE}" xml:space="preserve">${xml(l)}</text>`).join('') + '</g>';
  }
  return o + '</svg>';
}

const tmp = mkdtempSync(join(tmpdir(), 'bbgifr.'));
try {
  let list = 'ffconcat version 1.0\n';
  snaps.forEach((f, i) => {
    const p = join(tmp, `f${String(i).padStart(5, '0')}.svg`);
    writeFileSync(p, svg(f));
    list += `file '${p}'\nduration ${(i === snaps.length - 1 ? END_HOLD / 2 : f.dur).toFixed(3)}\n`;
  });
  list += `file '${join(tmp, `f${String(snaps.length - 1).padStart(5, '0')}.svg`)}'\n`; // concat gives this repeat the previous duration: the hold is split in two halves
  writeFileSync(join(tmp, 'list.txt'), list);
  const t1 = Date.now();
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'),
    '-vf', `fps=${FPS},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0', outFile], { encoding: 'utf8' });
  if (r.error) fail(`cannot run ffmpeg: ${r.error.message}`);
  if (r.status !== 0) fail(`ffmpeg exited ${r.status}: ${r.stderr}`);
  var encodeSec = (Date.now() - t1) / 1000;
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---- self-check on the GIF itself: header, then walk the blocks for frames and delays
const gif = readFileSync(outFile);
if (gif.subarray(0, 3).toString('latin1') !== 'GIF') fail('output is not a GIF');
const gw = gif.readUInt16LE(6), gh = gif.readUInt16LE(8);
let p = 13 + ((gif[10] & 0x80) ? 3 * (1 << ((gif[10] & 7) + 1)) : 0), frames = 0, cs = 0;
const skipSub = () => { while (gif[p] !== 0) p += gif[p] + 1; p++; };
while (p < gif.length && gif[p] !== 0x3b) {
  if (gif[p] === 0x21) {
    if (gif[p + 1] === 0xf9) cs += gif.readUInt16LE(p + 4);
    p += 2; skipSub();
  } else if (gif[p] === 0x2c) {
    frames++;
    const packed = gif[p + 9]; p += 10;
    if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
    p++; skipSub();
  } else fail(`bad GIF block 0x${gif[p].toString(16)}`);
}
const dur = cs / 100;
console.log(`${outFile}: ${gif.length} bytes, ${gw}x${gh}, ${dur.toFixed(1)} s, ${frames} frames, ${snaps.length} snapshots, encode ${encodeSec.toFixed(1)} s`);
for (const c of captions) console.log(`caption @ ${c.start.toFixed(2)} s: ${c.lines.join(' / ')}`);
if (gw !== W * SCALE) fail(`width is ${gw}, expected ${W * SCALE}`);
if (gif.length > MAX_BYTES) fail(`output is ${gif.length} bytes, over the ${MAX_BYTES} cap`);
