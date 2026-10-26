// sbx.mjs — second-terminal CLI for the M2 hold queue.
// Usage: node sbx.mjs CTL_SOCK pending | approve <id> | deny <id> [reason]
import net from 'node:net';

const [sockPath, cmd, ...args] = process.argv.slice(2);
if (!sockPath || !cmd) {
  console.log('usage: node sbx.mjs CTL_SOCK pending | approve <id> | deny <id> [reason]');
  process.exit(2);
}
const s = net.connect(sockPath, () => { s.write([cmd, ...args].join(' ') + '\n'); });
let out = '';
s.on('data', (ch) => { out += ch.toString('latin1'); });
s.on('end', () => {
  if (cmd === 'pending') {
    const items = JSON.parse(out || '[]');
    if (!items.length) { console.log('nothing held'); return; }
    for (const h of items) {
      console.log(`${h.id} ${h.client} ${h.method} ${h.url} (${h.waitingSec}s) body=${h.body}`);
    }
    return;
  }
  console.log(out.trim());
});
s.on('error', (e) => { console.log(`ctl failed: ${e.message}`); process.exit(1); });
