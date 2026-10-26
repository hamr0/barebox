# echo.py — local TLS echo server for the no-internet self-test.
# GET -> 200 "local-ok"; POST -> 200 echo of the body. Stdlib only.
# Usage: python3 echo.py CERT_PEM KEY_PEM PORT
import http.server
import ssl
import sys

cert_pem, key_pem, port = sys.argv[1], sys.argv[2], int(sys.argv[3])


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body: bytes):
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/chunked':
            body = b'chunk-one-chunk-two'
            self.send_response(200)
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            half = len(body) // 2
            for part in (body[:half], body[half:]):
                self.wfile.write(b'%X\r\n%s\r\n' % (len(part), part))
            self.wfile.write(b'0\r\n\r\n')
            return
        if self.path == '/close':
            body = b'close-delimited'
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True
            return
        self._send(b'local-ok')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        self._send(self.rfile.read(n))

    def log_message(self, *a):
        pass

class S(http.server.ThreadingHTTPServer):
    def handle_error(self, *a):
        pass  # dead-client resets are expected (proxy closes idle upstreams)


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert_pem, key_pem)
srv = S(('127.0.0.1', port), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f'echo on {port}', flush=True)
srv.serve_forever()
