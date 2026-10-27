// Test-env setup, loaded via `node --test --import` before any test file.
//
// This sandbox injects egress `*_proxy` vars plus NODE_USE_ENV_PROXY=1, and
// this Node build snapshots proxy config at startup — before any module
// runs — so in-process scrubbing cannot stop `node:http` tunneling loopback
// upstreams into the egress proxy. The real scrub is `env -u` in the `npm
// test` script (which runs before node starts); this module repeats it for
// direct single-file runs, and the per-file loops cover curl children.
// Real machines and CI either don't set these or set a sane `no_proxy`.
for (const v of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'FTP_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy']) {
  delete process.env[v];
}
