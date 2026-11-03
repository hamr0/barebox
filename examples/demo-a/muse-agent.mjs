// A minimal agent loop in plain Node, no deps. Runs INSIDE `sbx run`.
// Calls Baseten's OpenAI-compatible chat endpoint with one tool, bash(command).
// $BASETEN_API_KEY is the barebox placeholder here; the proxy swaps the real key after the gate.
// Prints: agent sees key, server received, model call <n> (free), agent: <text>, TOOL <n> <command>, USAGE <calls> <prompt_tokens> <completion_tokens>, FINAL <one line>.
import { spawnSync } from 'node:child_process';

const URL_ = 'https://inference.baseten.co/v1/chat/completions';
const MODEL = process.env.MUSE_MODEL || 'meta-models/muse-spark-open-1026';
const KEY = process.env.BASETEN_API_KEY;
const MAX_TURNS = 40;
const prompt = process.argv[1]; // run inline: node -e "$(cat muse-agent.mjs)" -- "<task>" puts the task at argv[1]
if (!KEY || !prompt) { console.error('usage: BASETEN_API_KEY=... node --input-type=module -e "$(cat muse-agent.mjs)" -- "<task>"'); process.exit(2); }

// results(stdout) -> [{kind, text, pos}] sorted by pos: one per httpbin JSON echo and one per barebox refusal.
// An echo is httpbin's pretty-printed top-level object: its own "headers" block, then its own "url"/"method".
// Its Authorization is read inside that block only, so a second echo or a trailer never leaks into it.
function results(so) {
  const out = [], spans = [];
  const hs = [...so.matchAll(/^  "headers":\s*\{([^{}]*)\}/gm)];
  hs.forEach((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1].index : so.length;
    const rest = so.slice(h.index + h[0].length, end);
    const au = /"Authorization":\s*"([^"]*)"/i.exec(h[1]);
    const um = /^  "url":\s*"([^"]*)"/m.exec(rest), mm = /^  "method":\s*"([^"]*)"/m.exec(rest);
    spans.push([Math.max(0, so.lastIndexOf('\n{', h.index) + 1), h.index + h[0].length + (um ? um.index + um[0].length : 0)]);
    let text;
    if (au && /^Bearer sk_test_/.test(au[1])) text = `server received: Authorization: ${au[1]}`;
    else if (au) text = 'server received: Authorization: (the agent masked the key in its own output; the audit below has the swap)';
    else {
      let path = um?.[1] ?? '?'; try { path = new URL(path).pathname; } catch { /* keep raw */ }
      text = `server received: ${mm?.[1] ?? '?'} ${path} (no key in it)`;
    }
    out.push({ kind: 'echo', text, pos: h.index });
  });
  for (const d of so.matchAll(/denied: [^\n"\\]*/g)) {
    if (spans.some(([a, b]) => d.index >= a && d.index < b)) continue;
    out.push({ kind: 'denied', text: `server received: nothing (the request never left; barebox said "${d[0]}")`, pos: d.index });
  }
  return out.sort((x, y) => x.pos - y.pos);
}

const tools = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command with bash -c. Returns stdout and stderr.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}];
const messages = [
  { role: 'system', content: "You are an agent with a bash tool, running inside a sandbox that is being tested: the user is watching which network calls you send and how the sandbox checks them. Start with step 1 of the task; do not inspect the environment, variables or files first. Do the steps with curl, one request per tool call. When done, reply with a short final answer and no tool call." },
  { role: 'user', content: prompt },
];
console.log(`agent sees key:  ${process.env.STRIPE_API_KEY ?? '$STRIPE_API_KEY'}`);
let retries = 0, calls = 0, ptok = 0, ctok = 0, n = 0, final = '';

for (let turn = 0; turn < MAX_TURNS; turn++) {
  calls++;
  console.log(`model call ${calls} (free)`);
  let j;
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools, max_tokens: 8192, temperature: 0.2 }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    if (!r.ok) { final = `model call failed ${r.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`; break; }
    j = JSON.parse(text);
  } catch (e) { final = `model call error ${e.message}`; break; }
  ptok += j.usage?.prompt_tokens ?? 0; ctok += j.usage?.completion_tokens ?? 0;
  const msg = j.choices?.[0]?.message;
  if (!msg) { final = 'no message in reply'; break; }
  // muse reasons first: finish_reason "length" with no tool call means the budget ran out, not an answer
  if (j.choices[0].finish_reason === 'length' && !msg.tool_calls?.length) {
    if (++retries > 2) { final = 'gave up (model hit its token limit)'; break; }
    continue;
  }
  retries = 0;
  messages.push(msg);
  if (!msg.tool_calls?.length) { final = msg.content ?? ''; break; }
  if (typeof msg.content === 'string' && msg.content.trim()) console.log(`agent: ${msg.content.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
  for (const tc of msg.tool_calls) {
    let cmd = '';
    try { cmd = JSON.parse(tc.function.arguments).command ?? ''; } catch { /* bad args: run nothing */ }
    n++;
    console.log(`TOOL ${n} ${cmd.split('\n')[0].slice(0, 120)}`);
    const p = cmd ? spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 60000 }) : null;
    const out = p ? `${p.stdout ?? ''}${p.stderr ?? ''}` : 'error: no command';
    // the key moment: what the server saw. One line per request result in stdout, in order.
    if (cmd.includes('httpbin.org')) for (const r of results(p?.stdout ?? '')) console.log(r.text);
    messages.push({ role: 'tool', tool_call_id: tc.id, content: out.slice(0, 4096) });
  }
  if (turn === MAX_TURNS - 1) final = `stopped at ${MAX_TURNS} turns`;
}
console.log(`USAGE ${calls} ${ptok} ${ctok}`);
console.log(`FINAL ${final.replace(/\s+/g, ' ').slice(0, 300)}`);
