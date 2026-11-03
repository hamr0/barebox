// A minimal agent loop in plain Node, no deps. Runs INSIDE `sbx run`.
// Calls Baseten's OpenAI-compatible chat endpoint with one tool, bash(command).
// $BASETEN_API_KEY is the barebox placeholder here; the proxy swaps the real key after the gate.
// Prints: agent sees key, server received, model call <n> (free), agent: <text>, TOOL <n> <command>, USAGE <calls> <prompt_tokens> <completion_tokens>, FINAL <one line>.
import { spawnSync } from 'node:child_process';

const URL_ = 'https://inference.baseten.co/v1/chat/completions';
const MODEL = process.env.MUSE_MODEL || 'meta-models/muse-spark-open-1026';
const KEY = process.env.BASETEN_API_KEY;
const MAX_TURNS = 25;
const prompt = process.argv[1]; // run inline: node -e "$(cat muse-agent.mjs)" -- "<task>" puts the task at argv[1]
if (!KEY || !prompt) { console.error('usage: BASETEN_API_KEY=... node --input-type=module -e "$(cat muse-agent.mjs)" -- "<task>"'); process.exit(2); }

const tools = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command with bash -c. Returns stdout and stderr.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}];
const messages = [
  { role: 'system', content: "You are an agent with a bash tool, running inside a sandbox that is being tested: the user wants to see which network calls you send and whether the sandbox spots and checks them. Do the task with curl, one step at a time. When done, reply with a short final answer and no tool call." },
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
    // the key moment: what the server saw as the Authorization header (httpbin echoes it)
    // Only httpbin's own reply on stdout counts: its JSON echo lists the headers it got
    // ("Authorization": "..."), whatever else the agent's command prints around it.
    // "Never left" is said only when barebox's refusal ("denied: ...") is in the reply.
    if (cmd.includes('httpbin.org')) {
      const so = p?.stdout ?? '';
      const auth = /^\s*"Authorization":\s*"([^"]*)"/im.exec(so);
      const denied = /denied: [^\n"]*/.exec(so);
      if (auth && /^Bearer sk_test_/.test(auth[1])) console.log(`server received: Authorization: ${auth[1]}`);
      else if (auth) console.log(`server received: Authorization: (the agent masked the key in its own output; the audit below has the swap)`);
      else if (denied) console.log(`server received: nothing (the request never left; barebox said "${denied[0]}")`);
    }
    messages.push({ role: 'tool', tool_call_id: tc.id, content: out.slice(0, 4096) });
  }
  if (turn === MAX_TURNS - 1) final = `stopped at ${MAX_TURNS} turns`;
}
console.log(`USAGE ${calls} ${ptok} ${ctok}`);
console.log(`FINAL ${final.replace(/\s+/g, ' ').slice(0, 300)}`);
