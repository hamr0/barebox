// Acceptance test: bareguard rwx.askUnheld as the barebox mode switch.
// check() returns a Decision: { outcome, severity, rule, reason, aid, ... } (allow|deny).
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate } from "bareguard";

const dir = mkdtempSync(join(tmpdir(), "askunheld-"));
const TOOLS = { "http.GET": "r", "intercom.updateDraft": "w", "http.POST": "x", "stripe.createPaymentIntent": "x" };
const act = (tool, extra = {}) => ({ type: "net", tool, url: "https://example.test/", method: tool?.split(".")[1], agent: "a", ...extra });
let n = 0;

async function mk({ letters, askUnheld, answers = [], agent = "a", agents, flags }) {
  const asks = [];
  const file = join(dir, `audit-${++n}.jsonl`);
  const gate = new Gate({
    audit: { path: file },
    rwx: { agent, agents: agents ?? { a: letters }, tools: TOOLS, ...(askUnheld !== undefined ? { askUnheld } : {}) },
    ...(flags ? { flags } : {}),
    humanChannel: async (ev) => { asks.push(ev); return { decision: answers.shift() ?? "deny" }; },
  });
  await gate.init();
  return { gate, asks, file };
}

let fails = 0;
async function item(name, fn) {
  let last;
  try { await fn((d) => { last = d; return d; }); console.log(`PASS ${name}`); }
  catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}\n  last decision: ${JSON.stringify(last)}`); }
}
const eq = (d, outcome, rule) => { assert.equal(d.outcome, outcome, `outcome ${d.outcome}`); if (rule) assert.equal(d.rule, rule, `rule ${d.rule}`); };

// 1. Modes
await item("1 ask: GET allows without asking", async (R) => {
  const { gate, asks } = await mk({ letters: "r--", askUnheld: ["w", "x"] });
  eq(R(await gate.check(act("http.GET"))), "allow"); assert.equal(asks.length, 0);
});
for (const tool of ["intercom.updateDraft", "http.POST"]) {
  await item(`1 ask: ${tool} asks, human allow -> allow`, async (R) => {
    const { gate, asks } = await mk({ letters: "r--", askUnheld: ["w", "x"], answers: ["allow"] });
    eq(R(await gate.check(act(tool))), "allow"); assert.equal(asks.length, 1); assert.equal(asks[0].rule, "rwx.ask");
  });
  await item(`1 ask: ${tool} asks, human deny -> deny`, async (R) => {
    const { gate, asks } = await mk({ letters: "r--", askUnheld: ["w", "x"], answers: ["deny"] });
    eq(R(await gate.check(act(tool))), "deny"); assert.equal(asks.length, 1);
  });
}
await item("1 auto: GET + updateDraft allow, no ask; POST asks", async (R) => {
  const { gate, asks } = await mk({ letters: "rw-", askUnheld: ["x"], answers: ["allow"] });
  eq(R(await gate.check(act("http.GET"))), "allow");
  eq(R(await gate.check(act("intercom.updateDraft"))), "allow");
  assert.equal(asks.length, 0);
  eq(R(await gate.check(act("http.POST"))), "allow"); assert.equal(asks.length, 1);
});
await item("1 trust: all three allow, never asked", async (R) => {
  const { gate, asks } = await mk({ letters: "rwx", askUnheld: [] });
  for (const t of ["http.GET", "intercom.updateDraft", "http.POST"]) eq(R(await gate.check(act(t))), "allow");
  assert.equal(asks.length, 0);
});

// 2. Still denied, never asked
await item("2 unheld letter not in askUnheld -> rwx.denied, no ask", async (R) => {
  const { gate, asks } = await mk({ letters: "r--", askUnheld: ["x"] });
  eq(R(await gate.check(act("intercom.updateDraft"))), "deny", "rwx.denied"); assert.equal(asks.length, 0);
});
await item("2 unlisted tool -> rwx.unlisted, no ask", async (R) => {
  const { gate, asks } = await mk({ letters: "r--", askUnheld: ["w", "x"] });
  eq(R(await gate.check(act("nope.unlisted"))), "deny", "rwx.unlisted"); assert.equal(asks.length, 0);
});
await item("2 tool null, no row for type -> rwx.unlisted (identity falls back to type), no ask", async (R) => {
  const { gate, asks } = await mk({ letters: "r--", askUnheld: ["w", "x"] });
  const d = R(await gate.check(act(null)));
  console.log(`  note: tool=null rule=${d.rule}`);
  eq(d, "deny", "rwx.unlisted"); assert.equal(asks.length, 0);
});
await item("2 agent not in agents map -> rwx.unlisted, no ask", async (R) => {
  const { gate, asks } = await mk({ letters: "rwx", askUnheld: ["w", "x"], agent: "ghost", agents: { a: "rwx" } });
  eq(R(await gate.check(act("http.POST"))), "deny", "rwx.unlisted"); assert.equal(asks.length, 0);
});

// 3. Floor
await item("3 trust + flags cardLike:ask", async (R) => {
  const { gate, asks } = await mk({ letters: "rwx", askUnheld: [], flags: { cardLike: { true: "ask" } }, answers: ["allow"] });
  eq(R(await gate.check(act("http.GET", { cardLike: false }))), "allow"); assert.equal(asks.length, 0);
  eq(R(await gate.check(act("http.GET", { cardLike: true }))), "allow"); assert.equal(asks.length, 1);
  assert.equal(asks[0].rule, "flags.cardLike");
});

// 4. Audit lines
await item("4 audit: ask line + human reply", async (R) => {
  const { gate, file } = await mk({ letters: "rw-", askUnheld: ["x"], answers: ["allow"] });
  R(await gate.check(act("http.POST")));
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ask = lines.find((l) => l.phase === "gate" && l.decision === "askHuman");
  const reply = lines.find((l) => l.phase === "approval");
  assert.ok(ask && reply, "missing ask or approval line");
  assert.equal(ask.rule, "rwx.ask"); assert.equal(ask.rwxLetters, "rw-"); assert.equal(ask.rwxLetter, "x");
  assert.ok(lines.indexOf(reply) > lines.indexOf(ask));
  console.log("  ASK  :", JSON.stringify(ask)); console.log("  REPLY:", JSON.stringify(reply));
});

// 5. Bad config
for (const bad of [["q"], "x"]) {
  await item(`5 askUnheld ${JSON.stringify(bad)} throws`, async () => {
    let err;
    try { await mk({ letters: "r--", askUnheld: bad }); } catch (e) { err = e; }
    assert.ok(err, "did not throw");
    console.log(`  error: ${err.message}`);
  });
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
