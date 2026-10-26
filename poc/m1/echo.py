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
        self._send(b'local-ok')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        self._send(self.rfile.read(n))

    def log_message(self, *a):
        pass


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert_pem, key_pem)
srv = http.server.HTTPServer(('127.0.0.1', port), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f'echo on {port}', flush=True)
srv.serve_forever()
