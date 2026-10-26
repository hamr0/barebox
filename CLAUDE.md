## Dev Rules

**Spec first — quality of questions over quantity.** Interview to find the decision, not the task. Ask in batched rounds, only questions whose prerequisites are settled, each with your recommended answer under it; find facts yourself and ask me only the choices that are mine. Pin module 0 down to the decision, sketch later modules only enough to know they don't change it, and ask what's out of scope for the whole build. One round is not an interview; never build on an assumed prerequisite. Write a PRD with problem/goal, go/no-go, out-of-scope, modules, open questions. POCs refine it.

**Reuse before you add.** Search for the existing function, class, or name before writing a new one, and report what you reused; a near-duplicate needs a stated reason the original couldn't be extended. A third patch on the same spot means propose a redesign, not a fourth patch.

**POC first, one module at a time.** Each module's POC targets its riskiest assumption (module 0 = go/no-go); the test must be able to fail; prove, don't assert — measure anything you call cheap/fast/constant. No fitting to pass. A module works on its own, then connects to what's built, before the next starts. Never ship the POC.

**Dependency hierarchy — follow strictly:** vanilla language → standard library → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Express over NestJS, Flask over Django, unless the project genuinely needs the framework. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code earns its place — if you can't say what breaks when it's deleted, delete it. No speculative code, no premature abstractions.

**One writer per piece of state.** One function assigns each field; everything else calls it. Grep who writes it before you write it — and if a write can land from a callback, thread, or lifecycle, the reader must tell stale from fresh.

**Surgical changes only.** Touch what the task requires. Dead code, nits, bugs you pass: if it's inside or affects the code you're already changing and the fix changes no behavior, fix it and say so — otherwise report it and say what it costs to leave it. A problem you don't fix goes in the report, never in a comment.

**Responsive web UI is mandatory.** Any web UI must work on mobile by default — fluid layouts, viewport meta, breakpoints, no horizontal scroll. Verify in DevTools device emulation before claiming a UI task is done. POCs exempt; real projects are not.

For full development and testing standards, see `.claude/remember/AGENT_RULES.md`.
