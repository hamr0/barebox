// Test-only `--import` patch: redirect unix-socket listens to 127.0.0.1 TCP.
//
// Where unix bind is blocked (this sandbox) a listening unix server cannot
// exist — but a test that needs "a listening server keeping the event loop
// alive" (the proxy-leak repro) would then pass for the wrong reason. This
// patch makes `net.createServer(...).listen(path, cb)` listen on
// 127.0.0.1:0 instead, so the test behaves identically where unix works (a
// real shell) and where it does not. Only the child under test imports it.
import net from 'node:net';

const origCreateServer = net.createServer;
net.createServer = function (...args) {
  const srv = origCreateServer.apply(this, args);
  const origListen = srv.listen;
  srv.listen = function (first, ...rest) {
    // Abstract names ('\0...') are the runtime claim lock: they bind fine here.
    if (typeof first === 'string' && !first.startsWith('\0')) {
      return origListen.call(this, 0, '127.0.0.1', ...rest);
    }
    return origListen.call(this, first, ...rest);
  };
  return srv;
};
