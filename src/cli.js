#!/usr/bin/env node
// sbx — second-terminal CLI for the hold queue:
// sbx pending | approve <id> | deny <id> [reason]
// Talks to the proxy over its unix control socket. The socket path comes
// from SBX_SOCK, defaulting to ./sbx-ctl.sock.
import net from 'node:net';

const USAGE = 'usage: sbx [--help] | pending | approve <id> | deny <id> [reason]';
// Exit codes: 0 ok, 1 unknown id / refused / socket failure, 2 usage.
const sockPath = process.env.SBX_SOCK || './sbx-ctl.sock';
const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(cmd ? 0 : 2);
}
if (!['pending', 'approve', 'deny'].includes(cmd) || ((cmd !== 'pending') && !args[0])) {
  console.log(USAGE);
  process.exit(2);
}

const s = net.connect(sockPath, () => { s.write([cmd, ...args].join(' ') + '\n'); });
s.setTimeout(5000, () => {
  console.log('ctl timed out waiting for the proxy');
  s.destroy();
  process.exit(1);
});
let out = '';
s.on('data', (ch) => { out += ch.toString('latin1'); });
s.on('end', () => {
  if (cmd === 'pending') {
    const items = JSON.parse(out || '[]');
    if (!items.length) { console.log('nothing held'); return; }
    for (const h of items) {
      console.log(`${h.id} ${h.agent} ${h.method} ${h.url} (${h.waitingSec}s) body=${h.body}`);
    }
    return;
  }
  console.log(out.trim());
  if (/^unknown /.test(out.trim())) process.exit(1);
});
s.on('error', (e) => { console.log(`ctl failed: ${e.message}`); process.exit(1); });
