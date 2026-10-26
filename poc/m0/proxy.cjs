// M0 POC: dumb forward + CONNECT proxy on per-agent unix sockets. Allow-all, stdlib only.
// Usage: node proxy.js <sockdir> <agent...>
// Log: "<iso> <agent> <method> <url> -> <status|tunnel|error>"
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const [, , sockdir, ...agents] = process.argv;
if (!sockdir || agents.length === 0) {
  console.error('usage: node proxy.js <sockdir> <agent...>');
  process.exit(1);
}
fs.mkdirSync(sockdir, { recursive: true });
const log = (agent, msg) => console.log(`${new Date().toISOString()} ${agent} ${msg}`);

for (const agent of agents) {
  const sock = path.join(sockdir, `${agent}.sock`);
  try { fs.unlinkSync(sock); } catch { /* fresh start */ }
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad url (M0 POC expects absolute URI)\n');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('M0 POC forwards http only; https uses CONNECT\n');
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-connection'];
    const up = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        log(agent, `${req.method} ${req.url} -> ${upRes.statusCode}`);
      }
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy error: ${e.code || e.message}\n`);
      log(agent, `${req.method} ${req.url} -> error ${e.code || e.message}`);
    });
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(port || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      log(agent, `CONNECT ${req.url} -> tunnel`);
    });
    upstream.on('error', (e) => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      log(agent, `CONNECT ${req.url} -> error ${e.code || e.message}`);
    });
    socket.on('error', () => upstream.destroy());
  });
  server.listen(sock, () => log(agent, `listening on ${sock}`));
}
