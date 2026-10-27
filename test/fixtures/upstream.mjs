// Upstream fixtures: in-process Node HTTP/HTTPS servers. Replaces poc/m1/echo.py:
// no Python dependency, no fixed ports, no stale processes — close() in
// after() always frees the port, even when a test failed.
import http from 'node:http';
import https from 'node:https';

function routes() {
  /** @type {Map<string, number>} */
  const hits = new Map();
  const hit = (p) => hits.set(p, (hits.get(p) ?? 0) + 1);
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    hit(u.pathname);
    if (u.pathname === '/slow') {
      const ms = Math.min(parseInt(u.searchParams.get('ms') || '1000', 10) || 1000, 60000);
      setTimeout(() => res.end('slow-ok'), ms);
      return;
    }
    if (u.pathname === '/chunked') {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write('chunk-one-');
      res.end('chunk-two');
      return;
    }
    if (u.pathname === '/close') {
      // Close-delimited: no length, connection closes. The old hand-rolled
      // framing called this "unframed" (500); stdlib reads it to EOF.
      res.useChunkedEncodingByDefault = false;
      res.shouldKeepAlive = false;
      res.end('close-delimited');
      return;
    }
    if (u.pathname === '/204') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (u.pathname === '/304') {
      res.writeHead(304);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res.end(Buffer.concat(chunks)));
      return;
    }
    res.end('local-ok');
  };
  return { handler, hits };
}

// /hold echoes the POST body back, so tests can match their markers.
function holdAware(handler) {
  return (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/hold') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res.end(Buffer.concat(chunks)));
      return;
    }
    handler(req, res);
  };
}

/**
 * Start a TLS upstream on 127.0.0.1:0.
 *
 * @param {{ key: Buffer, cert: Buffer }} tlsKeyCert from `certFor('127.0.0.1')`
 * @returns {Promise<{ url: string, port: number, hits: Map<string, number>, close: () => Promise<void> }>}
 */
export async function startHttps({ key, cert }) {
  const { handler, hits } = routes();
  const srv = https.createServer({ key, cert }, holdAware(handler));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  return {
    url: `https://127.0.0.1:${port}/`,
    port,
    hits,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/**
 * Start a plain-HTTP upstream on 127.0.0.1:0.
 *
 * @returns {Promise<{ url: string, port: number, hits: Map<string, number>, close: () => Promise<void> }>}
 */
export async function startHttp() {
  const { handler, hits } = routes();
  const srv = http.createServer(holdAware(handler));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    hits,
    close: () => new Promise((r) => srv.close(r)),
  };
}
