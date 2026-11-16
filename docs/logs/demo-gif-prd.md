# PRD: README demo GIF, v0.12.0 layout (2026-11-16)

## Problem / goal
The README's top GIF (`assets/demo-a.gif`, 930×264, a cropped screen recording of the Nov 3
muse take) is wide and 13 lines tall, and shows the pre-0.12.0 prompt (`✓ allowed` on its own
line, no `→ sent`). Goal: a new GIF, normal terminal shape (~800 px wide), that shows the
current prompt doing four things: allow, deny, auto-deny on timeout, and the end-of-run report,
with a one-sentence caption per beat.

## Decisions (user, 2026-11-16)
- Agent: **scripted** (a bash script inside a real `sbx run`). Every prompt, verdict, HTTP code
  and summary line in the GIF is real barebox output from one take. README says "scripted agent,
  real barebox".
- Auto-deny: one run with **`--hold 8`**; one prompt is left unanswered and shows
  `✗ timed out (denied)` + 403. Caption: unattended runs default to 180 s.
- Report: the **end-of-run summary** ("what barebox decided"), read from the run's `gate.jsonl`.
- Size: **~800 px wide, 80 cols × 30 rows**, plus a caption bar; target ≤ 1.5 MB.
- Story, auto mode, 5 beats: (1) flight search GET, free; (2) payment, `y` → `→ sent ✓ allowed`,
  httpbin echo shows the real key arrived only after the yes; (3) itinerary email, `y` → allowed;
  (4) an unexpected second payment, `n` → `✗ denied`, 403, nothing left; (5) upload to an unknown
  host, no answer → `✗ timed out (denied)` after 8 s. Then the summary.
- Commentary: **caption bar** under the terminal; the terminal shows only real output.
- Assets: new GIF at `assets/demo.gif` takes the README top slot; `assets/demo-a.gif` deleted;
  `assets/demo-a.webm` (live muse take) stays linked as the live run with a real model.
- Tooling: Node (stdlib only) emulates the terminal and writes SVG frames; ffmpeg (librsvg,
  palettegen) makes the GIF. No new dependency; nothing goes in the npm tarball (`examples/`).

## Out of scope
- A DeepSeek / model-driven take.
- A Demo B (injection) GIF.
- In scope if needed: a `src/` fix if the GIF exposes a real problem (ledger first, the user
  decides), and a release; `assets/` is not in the tarball, so the GIF alone needs no version bump.

## Go / no-go (module 0)
A GIF rendered from a real `script --timing` transcript at 800 px is **readable** (text crisp at
1:1 on GitHub, colours right, `✓ ✗ → ⏸` glyphs drawn) and **≤ 1.5 MB** for ~50 s.
No-go → change frame rate/palette/colours; if still over, revisit size with the user.

## Modules
0. **POC (throwaway, scratchpad)**: render the existing Nov 3 take
   (`docs/logs/m7-muse-runs/2026-11-03-demo-a-take.log` + `.timing`, first ~50 s) to an 800 px GIF;
   measure size, inspect frames. Must be able to fail: report bytes and show frames.
1. **Recorder** `examples/demo-gif/`: scripted agent + `record.sh` that runs one real
   `sbx run --mode auto --hold 8` in a pty (`script --timing`), answers y, y, n, (none) with
   human pauses, prints the summary, and **exits 1 unless gate.jsonl shows exactly the 5 beats**
   (free, allowed, allowed, denied, timed out) and the real key appears only in the step-2 echo.
2. **Renderer** `examples/demo-gif/render.mjs`: VT subset (SGR colours/bold/dim, `\r`, `\n`,
   backspace, scroll) on 80×30, captions file with times, SVG frames → ffmpeg → `assets/demo.gif`.
   Idle gaps capped (except the 8 s timeout, shown real-time or marked as sped up in its caption).
3. **README**: swap the image, rewrite the line under it honestly, keep the webm link and the
   reproduce command; delete `assets/demo-a.gif`.

## Module 0 result (2026-11-16): GO
POC on the Nov 3 take, 52 s window: 800×660 (600 terminal + 60 caption), 54.7 s, 328 frames,
**1,278,709 bytes**; orchestrator re-measured and viewed a frame: legible at 1:1, colours right,
`✓ ✗ ⏸` drawn (font family "JetBrainsMono Nerd Font Mono" via fontconfig). Renders in ~12 s.
- The brief's recipe failed the cap: antialiased text, 10 fps → 3.73 MB (VFR 5.5 MB).
- What fits: **crisp text** (`text-rendering="optimizeSpeed" shape-rendering="crispEdges"`),
  **`fps=6`**, `palettegen=stats_mode=diff`, `paletteuse=dither=none:diff_mode=rectangle`.
  Measured: crisp+VFR 2.23 MB, +10 fps 1.51, +8 fps 1.49, +6 fps 1.28, 4 fps 1.12. Colours 32 vs
  256: no gain. Cost: slashed zeros look slightly jagged; antialiasing back costs ~2.5× size.
- Escapes in a real take are SGR only (0,1,2,22,31,32,33,36) plus `\r\n` and UTF-8; no cursor moves.
- The Nov 3 take was 210 cols, so its long lines wrap at 80: **record the new take at 80×30**
  and keep agent lines short.
- Captions follow real elapsed time; frame durations use the capped time. A real-time 8 s static
  wait costs almost nothing at 6 fps. Headroom ~0.22 MB: re-measure the final clip.

## Module 2 finding (2026-11-16): captions need real gaps
Worker stopped on a wrong brief: the scripted agent sends its next request ~0.02-0.05 s after a
verdict, so captions 4, 7 and 9 showed for under 0.1 s (orchestrator re-measured on the take:
0.05, 0.04, 0.02 s). The 2.5 s idle cap also cut the 4 s answer pause.
**Decision (user):** real time, no renderer stretching. `agent.sh` sleeps ~3 s after each step
(as a real agent thinks between calls); the idle cap rises to 4 s, so the 4 s answer pause plays
as recorded. The GIF is the take as it ran, long gaps capped at 4 s.

## Readability decision (user, 2026-11-16)
The crisp 800 px draft looked pixelated (text antialiasing off, and 2× upscaling on HiDPI
screens). Measured on the final take: crisp 800 px 240 KB; antialiased 800 px 545 KB;
**antialiased 1600×1320, shown at `width="800"` in the README, 1,261,026 bytes**: sharp on every
screen. User: "readable, size is not a big issue, just 2MB" → **2× antialiased, cap 2,000,000 bytes**.

## Open questions
- Exact caption wording (drafted in module 1, shown to the user with frames before the README swap).
- Whether the 8 s timeout plays in real time or is sped up with a marked caption (decided from the
  module 2 frames).
