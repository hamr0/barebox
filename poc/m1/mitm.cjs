// mitm.cjs — M1 POC MITM proxy. Usage: node mitm.cjs PORT CERTDIR LOGFILE
// Parses requests for LOGGING, forwards RAW bytes. One exchange at a time
// per connection; closes after response framing completes (POC-grade).
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '3128', 10);
const CERTDIR = process.argv[3] || './certs';
const LOG = process.argv[4] || './mitm.log';
const UP_CA = process.argv[5] || null; // test-only local CA (echo server)
// System roots AND the test CA: real hosts verify as usual, echo verifies too.
const UP_CA_PEM = UP_CA ? [...tls.rootCertificates, fs.readFileSync(UP_CA).toString()] : null;
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');

const creds = (host) => ({
  key: fs.readFileSync(path.join(CERTDIR, host + '.key')),
  cert: fs.readFileSync(path.join(CERTDIR, host + '.pem')),
});

// Parse one HTTP request head from buf. Returns null if incomplete.
function parseReq(buf) {
  const i = buf.indexOf('\r\n\r\n');
  if (i < 0) return null;
  const lines = buf.subarray(0, i).toString('latin1').split('\r\n');
  const [method, target, ver] = lines[0].split(' ');
  const headers = {};
  for (const l of lines.slice(1)) {
    const c = l.indexOf(':');
    if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
  }
  let bodyLen = parseInt(headers['content-length'] || '0', 10) || 0;
  if (method === 'GET' || method === 'HEAD') bodyLen = 0;
  const total = i + 4 + bodyLen;
  if (buf.length < total) return null;
  return { method, target, ver, headers, headEnd: i + 4, total,
    body: buf.subarray(i + 4, total) };
}

// Response framing: total bytes of one response, or null if incomplete,
// or -1 when the head says framing the POC cannot do (loud, not silent).
function respLen(buf) {
  const i = buf.indexOf('\r\n\r\n');
  if (i < 0) return null;
  const head = buf.subarray(0, i).toString('latin1').toLowerCase();
  const m = head.match(/content-length:\s*(\d+)/);
  if (m) return i + 4 + parseInt(m[1], 10);
  if (head.includes('transfer-encoding: chunked')) {
    const end = buf.indexOf('0\r\n\r\n', i);
    if (end < 0) return null;
    return end + 5;
  }
  return -1;
}

function deny(sock, code, note) {
  log({ ev: 'deny', code, note });
  if (sock.destroyed) return; // second denier stays silent, log keeps one line
  sock.write(`HTTP/1.1 ${code} ${note}\r\nConnection: close\r\n\r\n`);
  sock.destroy();
}

// One decrypted request -> fresh upstream -> framed response -> raw back.
// Upstream is per-request (POC): the client tunnel stays open for reuse.
const isIP = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h || '');
function exchange(serverTls, buf, host, port, client, setCur) {
  const req = parseReq(buf);
  if (!req) return buf; // need more data
  const rest = buf.subarray(req.total);
  if (rest.length > 0) { deny(serverTls, 500, 'pipelining unsupported'); return null; }
  const url = req.target.startsWith('http') ? req.target : `https://${host}${req.target}`;
  log({ ev: 'req', client, method: req.method, url, headers: req.headers,
    body: req.body.toString('utf8') });
  const raw = buf.subarray(0, req.total);
  const up = tls.connect({ host, port,
    ...(isIP(host) ? {} : { servername: host }),
    ...(UP_CA_PEM ? { ca: UP_CA_PEM } : {}) }, () => { up.write(raw); });
  setCur(up);
  let done = false;
  let rbuf = Buffer.alloc(0);
  up.on('data', (chunk) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    const n = respLen(rbuf);
    if (n === null || rbuf.length < n) return; // need more
    done = true;
    setCur(null);
    if (n === -1) { deny(serverTls, 500, 'unframed response'); up.destroy(); return null; }
    const status = rbuf.subarray(0, rbuf.indexOf('\r\n')).toString('latin1');
    log({ ev: 'resp', client, url, status });
    const tail = rbuf.subarray(n);
    up.destroy();
    if (tail.length > 0) { deny(serverTls, 500, 'response tail'); return null; }
    serverTls.write(rbuf.subarray(0, n)); // tunnel stays open for reuse
    return null;
  });
  const failOnce = (note) => { if (!done) { done = true; deny(serverTls, 502, note); } };
  up.on('error', (e) => failOnce(`upstream ${host} failed: ${e.message || e.code}`));
  up.on('close', () => failOnce(`upstream ${host} closed early`));
  return null;
}

function handleConnect(sock, head, client) {
  const req = parseReq(head);
  if (!req || !req.target) { deny(sock, 400, 'bad connect line'); return; }
  const [host, port = '443'] = req.target.split(':');
  if (!/^[A-Za-z0-9.-]+$/.test(host || '')) { deny(sock, 400, `bad host`); return; }
  let c;
  try { c = creds(host); }
  catch { deny(sock, 502, `no cert for ${host}`); return; }
  // 200 now: per-request upstream errors surface on their own request
  sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
  const st = new tls.TLSSocket(sock, { isServer: true, ...c });
  let buf = Buffer.alloc(0);
  let cur = null;
  st.on('data', (ch) => {
    buf = Buffer.concat([buf, ch]);
    const r = exchange(st, buf, host, parseInt(port, 10), client, (u) => { cur = u; });
    if (r !== undefined) buf = r || Buffer.alloc(0);
  });
  const killCur = () => { if (cur) { cur.destroy(); cur = null; } };
  st.on('error', killCur);
  st.on('close', killCur);
  st.setTimeout(10000, () => st.destroy());
}

function handlePlain(sock, first, client) {
  const req = parseReq(first);
  if (!req) { deny(sock, 400, 'bad plain request'); return; }
  const u = new URL(req.target.startsWith('http') ? req.target : `http://${req.headers.host}${req.target}`);
  const up = net.connect(parseInt(u.port || '80', 10), u.hostname, () => {
    log({ ev: 'req', client, method: req.method, url: u.toString(),
      headers: req.headers, body: req.body.toString('utf8') });
    // origin servers vary on absolute-form; normalize to origin-form
    const lines = first.subarray(0, req.headEnd).toString('latin1').split('\r\n');
    lines[0] = `${req.method} ${u.pathname}${u.search} ${req.ver}`;
    up.write(Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'),
      first.subarray(req.headEnd, req.total)]));
    up.pipe(sock);
  });
  up.on('error', () => deny(sock, 502, `plain upstream ${u.hostname} failed`));
}

let n = 0;
net.createServer((sock) => {
  const client = `c${++n}`;
  let buf = Buffer.alloc(0);
  sock.on('data', (ch) => {
    buf = Buffer.concat([buf, ch]);
    const req = parseReq(buf);
    if (!req) return;
    sock.removeAllListeners('data');
    if (req.method === 'CONNECT') handleConnect(sock, buf, client);
    else handlePlain(sock, buf, client);
  });
  sock.on('error', () => {});
}).listen(PORT, () => console.log(`mitm on ${PORT}, certs ${CERTDIR}`));
