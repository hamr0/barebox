#!/bin/bash
# hold.sh SCEN — one M2 hold scenario. Env: PROXY CA CTL ECHO M1D LOG RT.
# approve|two|cap|timeout|never|long. Exits nonzero on fail.
set -u
SCEN="$1"
FAIL=0
SBX="node $M1D/sbx.mjs $CTL"
CURL="curl -s --max-time 90 -x $PROXY --cacert $CA"

park() { # park MARKER OUTFILE (pid lands in $! for the caller)
  $CURL --data "m=$1" "$ECHO/hold" > "$2" 2>&1 &
}

case "$SCEN" in
approve)
  park M2A "$RT/a.out"; APID=$!
  sleep 1
  G="$($CURL "$ECHO/")"
  [ "$G" = "local-ok" ] || { echo "FAIL meanwhile GET: $G"; FAIL=1; }
  P="$($SBX pending)"
  echo "$P"
  echo "$P" | grep -q 'M2A' || { echo "FAIL not pending"; FAIL=1; }
  ID="$(echo "$P" | grep M2A | cut -d' ' -f1)"
  [ "$($SBX approve "$ID")" = "approved $ID" ] || { echo "FAIL approve"; FAIL=1; }
  wait "$APID"
  grep -q 'M2A' "$RT/a.out" \
    && echo "PASS approve forwards" || { echo "FAIL approve body"; FAIL=1; }
  ;;
two)
  park M2A "$RT/a.out"; sleep 1
  park M2B "$RT/b.out"; sleep 1
  P="$($SBX pending)"
  echo "$P"
  echo "$P" | grep -c '^h' | grep -q 2 || { echo "FAIL depth != 2"; FAIL=1; }
  IDA="$(echo "$P" | grep M2A | cut -d' ' -f1)"
  IDB="$(echo "$P" | grep M2B | cut -d' ' -f1)"
  $SBX approve "$IDA" >/dev/null
  $SBX deny "$IDB" 'test deny' >/dev/null
  wait
  grep -q 'M2A' "$RT/a.out" \
    && echo "PASS A approved" || { echo "FAIL A body"; FAIL=1; }
  grep -q 'denied: test deny' "$RT/b.out" \
    && echo "PASS B denied with reason" || { echo "FAIL B body"; FAIL=1; }
  [ "$($SBX pending)" = "nothing held" ] \
    && echo "PASS queue empty" || { echo "FAIL queue not empty"; FAIL=1; }
  ;;
cap)
  python3 -c "print('x'*2000000)" > "$RT/big.txt"
  R="$(curl -s --max-time 30 -w '\n%{http_code}' -x "$PROXY" --cacert "$CA" \
    --data-binary "@$RT/big.txt" "$ECHO/hold")"
  echo "$R" | grep -q 'too large to hold' \
    && echo "PASS cap denies loud" || { echo "FAIL cap"; FAIL=1; }
  echo "$R" | tail -1 | grep -q 403 \
    && echo "PASS cap is 403" || { echo "FAIL cap code"; FAIL=1; }
  [ "$($SBX pending)" = "nothing held" ] \
    && echo "PASS over-cap never queued" || { echo "FAIL queued"; FAIL=1; }
  ;;
timeout)
  park M2T "$RT/t.out"; sleep 7
  wait
  grep -q 'hold timeout' "$RT/t.out" \
    && echo "PASS timeout denies" || { echo "FAIL timeout body"; FAIL=1; }
  [ "$($SBX pending)" = "nothing held" ] \
    && echo "PASS timeout frees queue" || { echo "FAIL stuck"; FAIL=1; }
  ;;
never)
  park M2N "$RT/n.out"; sleep 3
  P="$($SBX pending)"
  echo "$P" | grep -q 'M2N' \
    && echo "PASS never-mode still held" || { echo "FAIL never expired"; FAIL=1; }
  ID="$(echo "$P" | grep M2N | cut -d' ' -f1)"
  $SBX approve "$ID" >/dev/null
  wait
  grep -q 'M2N' "$RT/n.out" \
    && echo "PASS never approves" || { echo "FAIL never body"; FAIL=1; }
  ;;
long)
  park M2L "$RT/l.out"; sleep 30
  P="$($SBX pending)"
  echo "$P" | grep -q 'M2L' \
    && echo "PASS 30s hold survives" || { echo "FAIL long hold"; FAIL=1; }
  ID="$(echo "$P" | grep M2L | cut -d' ' -f1)"
  $SBX approve "$ID" >/dev/null
  wait
  grep -q 'M2L' "$RT/l.out" \
    && echo "PASS long approves" || { echo "FAIL long body"; FAIL=1; }
  ;;
*) echo "unknown scenario $SCEN"; exit 2 ;;
esac
[ "$FAIL" = 0 ] && echo "HOLD $SCEN PASS" || { echo "HOLD $SCEN FAIL"; exit 1; }
