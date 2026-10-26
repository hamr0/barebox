# client.py — python requests client: GET + POST through the MITM proxy.
# Usage: python3 client.py PROXY CA_PEM GET_URL POST_URL MARKER
import sys
import requests

proxy, ca, get_url, post_url, marker = sys.argv[1:6]
proxies = {'http': proxy, 'https': proxy}
g = requests.get(get_url, proxies=proxies, verify=ca, timeout=20)
print('python GET', g.status_code)
p = requests.post(post_url, data={'client': 'python', 'marker': marker},
                  proxies=proxies, verify=ca, timeout=20)
print('python POST', p.status_code)
