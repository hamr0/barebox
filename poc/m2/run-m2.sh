#!/bin/bash
# run-m2.sh — M2 hold-and-ask POC. Local only: holds park before upstream
# contact, so real internet adds zero evidence (echo doubles as upstream).
set -u
M1="poc/m1"; M2="poc/m2"
RT="/tmp/sbx-m2-$$"; rm -rf "$RT"; mkdir -p "$RT"
LOG="$RT/mitm.log"; : > "$LOG"
PORT=3129
bash "$M1/mkcerts.sh" "$RT/certs" 127.0.0.1 || exit 1
python3 "$M1/echo.py" "$RT/certs/127.0.0.1.pem" "$RT/certs/127.0.0.1.key" 8443 &
ECHO_PID=$!
sleep 0.5
export PROXY="http://127.0.0.1:$PORT" CA="$RT/certs/ca.pem" LOG
export ECHO="https://127.0.0.1:8443" M1D="$M1" RT CTL="$RT/ctl.sock"
cleanup() {
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null
  kill "$ECHO_PID" 2>/dev/null
}
trap cleanup EXIT
start_proxy() { # start_proxy TIMEOUT_MS
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null
  sleep 0.5
  HOLD_MATCH=/hold HOLD_TIMEOUT_MS="$1" HOLD_MAX_BODY=1048576 \
    node "$M1/mitm.cjs" "$PORT" "$RT/certs" "$LOG" "$RT/certs/ca.pem" "$CTL" &
  PROXY_PID=$!
  sleep 0.5
}
start_proxy 120000
bash "$M2/hold.sh" approve || exit 1
bash "$M2/hold.sh" two || exit 1
bash "$M2/hold.sh" cap || exit 1
start_proxy 5000
bash "$M2/hold.sh" timeout || exit 1
start_proxy never
bash "$M2/hold.sh" never || exit 1
start_proxy 120000
bash "$M2/hold.sh" long || exit 1
echo "M2 local PASS"
