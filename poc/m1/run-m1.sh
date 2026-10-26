#!/bin/bash
# run-m1.sh [local|real] — full M1 run: certs, MITM proxy, matrix, RSS, verdict.
set -u
MODE="${1:-local}"
M1="$(dirname "$0")"
RT="/tmp/sbx-m1"
rm -rf "$RT"; mkdir -p "$RT"
LOG="$RT/mitm.log"; : > "$LOG"
PORT=3129
PROXY="http://127.0.0.1:$PORT"

if [ "$MODE" = local ]; then
  HOSTS="127.0.0.1"
  bash "$M1/mkcerts.sh" "$RT/certs" $HOSTS || exit 1
  python3 "$M1/echo.py" "$RT/certs/127.0.0.1.pem" "$RT/certs/127.0.0.1.key" 8443 &
  ECHO_PID=$!
  sleep 0.5
  export GET_URL="https://127.0.0.1:8443/" POST_URL="https://127.0.0.1:8443/" GIT_URL=""
else
  HOSTS="example.com httpbin.org github.com"
  bash "$M1/mkcerts.sh" "$RT/certs" $HOSTS || exit 1
  export GET_URL="https://example.com/" POST_URL="https://httpbin.org/post"
  export GIT_URL="https://github.com/hamr0/barebox.git"
fi

UPCA=""
[ "$MODE" = local ] && UPCA="$RT/certs/ca.pem"
node "$M1/mitm.cjs" "$PORT" "$RT/certs" "$LOG" "$UPCA" &
PROXY_PID=$!
sleep 0.5
cleanup() { kill "$PROXY_PID" 2>/dev/null; [ -n "${ECHO_PID:-}" ] && kill "$ECHO_PID" 2>/dev/null; }
trap cleanup EXIT

export PROXY CA="$RT/certs/ca.pem" LOG
bash "$M1/matrix.sh" || exit 1
echo "== proxy RSS =="
RSS=$(awk '/VmRSS/{print $2}' /proc/$PROXY_PID/status)
echo "proxy RSS ${RSS} kB (target <= 81920)"
[ "$RSS" -le 81920 ] && echo "RSS PASS" || { echo "RSS FAIL"; exit 1; }
echo "M1 $MODE PASS"
