# Brief: demo GIF module 0 POC — render a real transcript to an 800 px GIF (2026-11-16)

Worker: code-developer (Sonnet). Spec: `docs/logs/demo-gif-prd.md` (read it). This is a
**throwaway POC**: write everything under
`/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/5c5f0d3d-f125-4ca7-aef2-a9a8f8929e98/scratchpad/gif-poc/`.
Touch nothing in the repo. Do not commit. Do not spawn agents.

## Question it answers (go / no-go)
Can Node (stdlib only) + ffmpeg (librsvg SVG decoder + palettegen) turn a real `script --timing`
transcript into an **~800 px wide, 80 cols × 30 rows** GIF with a caption bar that is
**readable** and **≤ 1.5 MB for ~50 s**? Report the real numbers; do not tune toward a pass
by dropping content (no fewer rows/cols, no shorter clip than 45 s of content).

## Input
- Transcript: `docs/logs/m7-muse-runs/2026-11-03-demo-a-take.log` (raw bytes from `script`,
  with ANSI) and `.timing` (classic `script -t` format: `<delay seconds> <byte count>` per line).
  Check the .log's first line: `script` writes a "Script started on ..." header line that is not
  counted in the timing; skip it.
- Captions: `docs/logs/m7-muse-runs/2026-11-03-demo-a-take.srt`; use the ones overlapping the
  clip window (any 45-60 s window with a prompt in it, e.g. starting just before the first
  `Allow?`).
- Font: `/home/hamr/.local/share/fonts/JetBrainsMono/JetBrainsMonoNerdFontMono-Regular.ttf`
  and `-Bold.ttf` (family name: check with `fc-list`). librsvg resolves fonts via fontconfig.

## Build (POC quality, but correct)
1. `render.mjs`: replay the bytes with their delays into a tiny VT: 80×30 grid, scroll on
   overflow; handle SGR (0, 1, 2, 22, 30-37, 90-97, 39, and anything else ignored), `\r`, `\n`,
   `\b`, `\x1b[K`-family erase if present (grep the .log for the escape set first and list it in
   the report), UTF-8 multi-byte decode across chunk boundaries. Lines longer than 80 cols wrap
   (like a terminal) — say which you chose.
2. Snapshot the grid whenever it changes; cap idle gaps at 2.5 s; one frame per snapshot with its
   duration.
3. Each snapshot → SVG: dark background, monospace text with `xml:space="preserve"`, per-cell
   colour runs as `<tspan>`, caption bar (~60 px) under the terminal with the active caption
   centred, max 2 lines.
4. ffmpeg: rasterize SVGs (`-f image2 -c:v svg` or `-i frame%05d.svg`), concat with per-frame
   durations (concat demuxer `duration` lines), `palettegen=stats_mode=diff` +
   `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle` (or better), output `poc.gif`.

## Report (paste real output)
- `ls -l poc.gif` bytes, `ffprobe` width/height/duration/frame count.
- 3 frames as PNG (a prompt, an `✓ allowed`, a caption change): give the absolute paths; the
  orchestrator will look at them.
- The escape-sequence set found in the .log and how each is handled.
- Time taken to render.
- Anything that fails readability (glyph boxes for `⏸ ✓ ✗ →`, blurry text, colour banding).
- Verdict: GO / NO-GO against ≤ 1.5 MB and readable, with the numbers. If NO-GO, the one
  change you would try next and its measured effect if you tried it.
