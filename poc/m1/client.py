# client.py — python requests client: GET + POST through the MITM proxy.
# Usage: python3 client.py PROXY CA_PEM GET_URL POST_URL MARKER
import sys
import requests

proxy, ca, get_url, post_url, marker = sys.argv[1:6]
s = requests.Session()  # one tunnel reused: exercises sequential exchanges
s.trust_env = False  # sandbox exports proxy env; explicit config must win
s.proxies.update({'http': proxy, 'https': proxy})
s.verify = ca
g = s.get(get_url, timeout=20)
print('python GET', g.status_code)
p = s.post(post_url, data={'client': 'python', 'marker': marker},
           headers={'X-M1-Probe': 'HDRPY'}, timeout=20)
print('python POST', p.status_code, p.text[:200])
