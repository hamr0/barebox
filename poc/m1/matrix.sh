#!/bin/bash
# matrix.sh — curl + node + python (+ git) through the MITM proxy, asserts log.
# Env: PROXY CA GET_URL POST_URL GIT_URL(empty=skip) LOG. Exits nonzero on fail.
set -u
M1D="$(dirname "$0")"
FAIL=0
check() { # check DESC pattern...
  local desc="$1"; shift
  if grep -q "$1" "$LOG"; then echo "PASS $desc"; else echo "FAIL $desc"; FAIL=1; fi
}

echo "== curl =="
curl -s -o /dev/null -w 'curl GET %{http_code}\n' -x "$PROXY" --cacert "$CA" "$GET_URL"
curl -s -o /dev/null -w 'curl POST %{http_code}\n' -x "$PROXY" --cacert "$CA" \
  --data 'client=curl&marker=M1CURL' "$POST_URL"

echo "== node =="
NODE_EXTRA_CA_CERTS="$CA" node "$M1D/client.mjs" "$PROXY" "$CA" "$GET_URL" "$POST_URL" M1NODE

echo "== python =="
python3 "$M1D/client.py" "$PROXY" "$CA" "$GET_URL" "$POST_URL" M1PY

if [ -n "${GIT_URL:-}" ]; then
  echo "== git =="
  git -c "http.proxy=$PROXY" -c "http.sslCAInfo=$CA" ls-remote "$GIT_URL" HEAD
fi

echo "== log assertions =="
GHOST="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$GET_URL")"
check "curl GET visible" "\"method\":\"GET\".*$GHOST"
check "curl POST body visible" "M1CURL"
check "node POST body visible" "M1NODE"
check "python POST body visible" "M1PY"
if [ -n "${GIT_URL:-}" ]; then check "git visible" "git-upload-pack\|info/refs"; fi
[ "$FAIL" = 0 ] && echo "MATRIX PASS" || { echo "MATRIX FAIL"; exit 1; }
