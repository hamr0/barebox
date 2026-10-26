#!/bin/bash
# matrix.sh — curl + node + python (+ git) through the MITM proxy, asserts log.
# Env: PROXY CA GET_URL POST_URL GIT_URL(empty=skip) LOG. Exits nonzero on fail.
set -u
M1D="$(dirname "$0")"
FAIL=0
curl() { command curl --max-time 15 "$@"; } # hangs become failures, never silence
check() { # check DESC pattern...
  local desc="$1"; shift
  if grep -q "$1" "$LOG"; then echo "PASS $desc"; else echo "FAIL $desc"; FAIL=1; fi
}

echo "== curl =="
CG="$(curl -s -o /dev/null -w '%{http_code}' -x "$PROXY" --cacert "$CA" \
  -H 'X-M1-Probe: HDRCURL' "$GET_URL?m=curl")"
echo "curl GET $CG"
[ "$CG" = "200" ] || { echo "FAIL curl GET $CG"; FAIL=1; }
CP="$(curl -s -x "$PROXY" --cacert "$CA" \
  --data 'client=curl&marker=M1CURL' "$POST_URL")"
echo "$CP" | grep -q 'M1CURL' \
  && echo "PASS curl POST wire body" || { echo "FAIL curl POST body"; FAIL=1; }

echo "== node =="
NOUT="$(NODE_EXTRA_CA_CERTS="$CA" node "$M1D/client.mjs" "$PROXY" "$CA" "$GET_URL?m=node" "$POST_URL" M1NODE)"
echo "$NOUT"
echo "$NOUT" | grep -q '200' \
  && echo "PASS node status" || { echo "FAIL node status"; FAIL=1; }
echo "$NOUT" | grep -q 'M1NODE' \
  && echo "PASS node POST wire body" || { echo "FAIL node POST body"; FAIL=1; }

echo "== python =="
POUT="$(python3 "$M1D/client.py" "$PROXY" "$CA" "$GET_URL?m=py" "$POST_URL" M1PY)"
echo "$POUT"
echo "$POUT" | grep -q ' 200' \
  && echo "PASS python status" || { echo "FAIL python status"; FAIL=1; }
echo "$POUT" | grep -q 'M1PY' \
  && echo "PASS python POST wire body" || { echo "FAIL python POST body"; FAIL=1; }

if [ -n "${GIT_URL:-}" ]; then
  echo "== git =="
  git -c "http.proxy=$PROXY" -c "http.sslCAInfo=$CA" ls-remote "$GIT_URL" HEAD \
    || { echo "FAIL git ls-remote"; FAIL=1; }
fi

echo "== log assertions =="
GHOST="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$GET_URL")"
[ -n "$GHOST" ] || { echo "FAIL empty GET host"; exit 1; }
check "curl GET visible" "m=curl"
check "node GET visible" "m=node"
check "python GET visible" "m=py"
check "curl header visible" "HDRCURL"
check "node header visible" "HDRNODE"
check "python header visible" "HDRPY"
check "curl POST body visible" "M1CURL"
check "node POST body visible" "M1NODE"
check "python POST body visible" "M1PY"
if [ -n "${GIT_URL:-}" ]; then check "git visible" "git-upload-pack\|info/refs"; fi

echo "== negatives =="
curl -s -o /dev/null -w '%{http_code}' -x "$PROXY" --cacert "$CA" "$ECHO/" | grep -q 200 \
  || { echo "FAIL echo server not usable; aborting negatives"; exit 1; }
echo "PASS echo liveness gate"
curl -s -o /dev/null -x "$PROXY" --cacert "$CA" https://unknown.invalid/ 2>/dev/null \
  && { echo "FAIL unknown host went through"; FAIL=1; } || echo "PASS unknown host refused"
check "unknown host denied in log" "no cert for unknown.invalid"
D="$(curl -s -o /dev/null -w '%{http_code}' -x "$PROXY" --cacert "$CA" https://127.0.0.1:9/ 2>/dev/null)"
[ "$D" = "502" ] \
  && echo "PASS dead upstream 502" || { echo "FAIL dead upstream: $D"; FAIL=1; }
check "dead upstream denied in log" "upstream 127.0.0.1 failed"
curl -s -o /dev/null -x "$PROXY" "$ECHO/" 2>/dev/null \
  && { echo "FAIL no-CA client went through"; FAIL=1; } || echo "PASS no-CA client refused"
curl -s -x "$PROXY" "$PLAIN/" | grep -q 'Directory listing' \
  && echo "PASS plain HTTP forwarded" || { echo "FAIL plain HTTP"; FAIL=1; }
check "plain HTTP visible" "127.0.0.1:18080"
B="$(curl -s -x "$PROXY" --cacert "$CA" "$ECHO/chunked")"
[ "$B" = "chunk-one-chunk-two" ] \
  && echo "PASS chunked body intact" || { echo "FAIL chunked body: $B"; FAIL=1; }
check "chunked URL logged" "/chunked"
C="$(curl -s -o /dev/null -w '%{http_code}' -x "$PROXY" --cacert "$CA" "$ECHO/close")"
[ "$C" = "500" ] \
  && echo "PASS close-delimited fails loud" || { echo "FAIL close-delimited: $C"; FAIL=1; }
check "close-delimited deny logged" "unframed response"
[ "$FAIL" = 0 ] && echo "MATRIX PASS" || { echo "MATRIX FAIL"; exit 1; }
