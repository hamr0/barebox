// poc/m5/swap-micro.mjs: swap() alone, in-process, typical request headers (10 headers, one carries a placeholder).
import { swap, loadSecrets } from './swap.mjs';
const mk = (n) => loadSecrets(Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, { value: `real-${i}-${'x'.repeat(32)}`, hosts: ['api.stripe.com'] }])));
const N = 200000;
for (const n of [0, 1, 10]) {
  const s = mk(n || 1).slice(0, n);
  const h = { host: 'api.stripe.com', 'user-agent': 'curl/8.9', accept: '*/*', 'accept-encoding': 'gzip', 'content-type': 'application/json',
    'content-length': '42', 'x-request-id': 'abc123', connection: 'keep-alive', 'cache-control': 'no-cache',
    authorization: `Bearer ${(mk(1)[0]).placeholder}` };
  if (n) h.authorization = `Bearer ${s[0].placeholder}`;
  for (let i = 0; i < 20000; i++) swap(h, 'api.stripe.com', s);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) swap(h, 'api.stripe.com', s);
  console.log(`secrets=${n}: ${(Number(process.hrtime.bigint() - t0) / N / 1000).toFixed(2)} us per request`);
}
