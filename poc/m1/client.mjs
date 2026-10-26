// client.mjs — node client: GET + POST through the MITM proxy. Stdlib only
// (net + tls): CONNECT by hand, wrap the tunnel, minimal HTTP/1.1.
// Usage: node client.mjs PROXY CA_PEM GET_URL POST_URL MARKER
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

const [proxy, caPem, getUrl, postUrl, marker] = process.argv.slice(2);
const ca = fs.readFileSync(caPem);
const isIP = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);

function viaProxy(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const [ph, pp] = proxy.replace('http://', '').split(':');
    const s = net.connect(parseInt(pp, 10), ph, () => {
      s.write(`CONNECT ${u.hostname}:${u.port || 443} HTTP/1.1\r\nHost: ${u.hostname}\r\n\r\n`);
    });
    let head = Buffer.alloc(0);
    s.on('data', (ch) => {
      head = Buffer.concat([head, ch]);
      if (head.indexOf('\r\n\r\n') < 0) return;
      s.removeAllListeners('data');
      if (!head.toString('latin1').startsWith('HTTP/1.1 200')) {
        reject(new Error('connect refused: ' + head.toString('latin1').split('\r\n')[0]));
        s.destroy();
        return;
      }
      const t = tls.connect({
        socket: s, ca, host: u.hostname,
        ...(isIP(u.hostname) ? {} : { servername: u.hostname }),
      }, () => {
        let req = `${method} ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nConnection: close\r\nX-M1-Probe: HDRNODE\r\n`;
        if (body) req += `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
        t.write(req + '\r\n' + (body || ''));
      });
      let resp = Buffer.alloc(0);
      t.on('data', (c) => { resp = Buffer.concat([resp, c]); });
      t.on('end', () => resolve(resp.toString('latin1')));
      t.on('error', reject);
    });
    s.on('error', reject);
  });
}

const body = `client=node&marker=${marker}`;
console.log('node GET', await viaProxy(getUrl, 'GET'));
console.log('node POST', await viaProxy(postUrl, 'POST', body));
