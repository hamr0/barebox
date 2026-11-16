# Brief: demo GIF module 2 — renderer and captions (2026-11-16)

Worker: code-developer (Sonnet). Spec: `docs/logs/demo-gif-prd.md` (read all, esp. "Module 0
result"). Branch `demo-gif`. Do **not** commit, do not spawn agents. Rules:
`.claude/remember/AGENT_RULES.md`. Module 1 (`examples/demo-gif/record.sh`, `agent.sh`) is built
and verified: read both, change `record.sh` only where this brief says.

## Build
1. `examples/demo-gif/render.mjs` (Node, stdlib only; ffmpeg as a child process with an argv
   array, no shell): `node examples/demo-gif/render.mjs <takeDir> <captions.json> <out.gif>`.
   Production version of the POC renderer
   (`/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/5c5f0d3d-f125-4ca7-aef2-a9a8f8929e98/scratchpad/gif-poc/render2.mjs`
   — read it; rewrite cleanly, do not copy POC shortcuts). Settings proven in module 0:
   80×30 grid, 800 px wide, ~60 px caption bar, font family "JetBrainsMono Nerd Font Mono",
   crisp text (`text-rendering="optimizeSpeed" shape-rendering="crispEdges"`), `fps=6`,
   `palettegen=stats_mode=diff`, `paletteuse=dither=none:diff_mode=rectangle`. VT subset: SGR
   (0,1,2,22,30-37,39,90-97), `\r`, `\n`, `\b`, deferred wrap at col 80, scroll, UTF-8 streaming
   decode; any other escape → **exit 1 naming it** (a take that needs more must fail loudly).
   take.log has no script header/footer (module 1 cuts them): check, and fail if its length ≠
   the timing total.
2. Pacing: idle gaps capped at 2.5 s, **except while a caption with `"realtime": true` is
   active** (the 8 s timeout plays in real time). End: hold the last frame 6 s. The GIF loops.
3. `examples/demo-gif/captions.json`: array of `{ "when": "<text that first appears in the
   output>", "text": "<caption>", "realtime"?: true }`. A caption shows from the moment its
   `when` text first appears on screen until the next caption's. Every `when` must be found, in
   order, else **exit 1 naming it** (re-takes must not drift silently). Max 2 lines in the bar;
   a caption that would need 3 lines → exit 1. Use these captions exactly (the user will review
   them on frames; do not reword):
   ```
   when "$ sbx run"              A scripted agent books a trip inside barebox: auto mode, real proxy, 8 s hold.
   when "agent: search flights"  Reading is free: the search goes out with no question.
   when "(hold h1)"              A payment always stops for a person, in every mode.
   when "httpbin got: Bearer"    After the yes, the real key goes in. The agent only ever had a placeholder.
   when "(hold h2)"              Sending data barebox can't undo: it asks first. Yes.
   when "(hold h3)"              A second payment nobody expected...
   when "✗ denied"               No: a 403, and nothing left the machine.
   when "(hold h4)"              Nobody answers this one.            realtime: true
   when "timed out"              No answer in 8 s means No. Unattended runs deny after 180 s.
   when "what barebox decided"   The report: every request and what barebox decided, from its audit log.
   ```
4. Reading time: with `PAUSE=2.5` each prompt is answered before its caption can be read. Make
   the answer pause a real person's: run takes with `PAUSE=4` (record.sh already reads `PAUSE`;
   change its default to 4 and say so). Do not stretch time in the renderer.
5. Self-check in render.mjs, **exit 1** on: output > 1,500,000 bytes, width ≠ 800, any caption
   anchor missing/out of order, unknown escape. Print size, dims, duration, frame count.
6. `examples/demo-gif/README.md`? **No** — put the two commands in a header comment of
   `record.sh` and `render.mjs` instead (record, then render to `assets/demo.gif`).

## Prove (paste real output)
- A fresh take (`record.sh`, exit 0 with its checks) rendered to `assets/demo.gif`: size, dims,
  duration, frames; render time.
- One PNG per caption (10), the frame just before the next caption starts: absolute paths in the
  scratchpad (`/tmp/claude-1000/-home-hamr-PycharmProjects-barebox/5c5f0d3d-f125-4ca7-aef2-a9a8f8929e98/scratchpad/gif-m2/`).
- Each self-check going **red** once in a scratch copy (oversize via a forced low cap, a missing
  anchor, an unknown escape injected into a copy of take.log, a 3-line caption): the exit code
  and message.
- The real-time segment: frame timestamps showing ~8 s between the h4 prompt and `timed out`.
- `git status --porcelain`: expected `examples/demo-gif/*`, `assets/demo.gif`, `.gitignore`, the
  docs/logs briefs. Do not touch README.md or delete `assets/demo-a.gif` (module 3).
