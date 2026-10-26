#!/usr/bin/env bash
# M0 POC harness: proxy + 20 idle + functional + bypass. Prints evidence, exits nonzero on fail.
set -u
R=/tmp/sbx-m0
PROJ=$R/proj
PROXY_PID=""
mkdir -p "$R/socks" "$PROJ"
echo "real-file" > "$PROJ/a.txt"
IDLE=$(printf 'a%02d ' $(seq 1 20))
ALL="$IDLE fx fy"
FAIL=0
fail() { echo "FAIL: $1"; FAIL=1; }
pass() { echo "PASS: $1"; }

HTTPD_PID=""
TARGET_M0="http://127.0.0.1:18080"
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$HTTPD_PID" ] && kill "$HTTPD_PID" 2>/dev/null || true
  if [ -f "$R/bwrap.pids" ]; then
    while read -r p; do kill "$p" 2>/dev/null || true; done < "$R/bwrap.pids"
  fi
}
trap cleanup EXIT

echo "host ~/.ssh entries: $(ls -A ~/.ssh 2>/dev/null | wc -l) (if 0, T3 is vacuous)"

node "$R/proxy.cjs" "$R/socks" $ALL >"$R/proxy.log" 2>&1 &
PROXY_PID=$!
for i in $(seq 1 100); do
  n=$(ls "$R/socks"/*.sock 2>/dev/null | wc -l)
  [ "$n" = 22 ] && break
  [ "$i" = 100 ] && { fail "proxy sockets (got $n/22)"; cat "$R/proxy.log"; exit 1; }
  sleep 0.1
done
echo "proxy up pid=$PROXY_PID"
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$PROJ" >"$R/httpd.log" 2>&1 &
HTTPD_PID=$!
for i in $(seq 1 100); do
  if curl -s -o /dev/null --noproxy "*" --max-time 1 "$TARGET_M0/" 2>/dev/null; then break; fi
  [ "$i" = 100 ] && { fail "local httpd up"; cat "$R/httpd.log"; exit 1; }
  sleep 0.1
done
echo "local httpd up pid=$HTTPD_PID (tool sandbox has no outbound internet; upstream is local)"

S=$(date +%s%3N)
"$R/launch.sh" "$R" fx "$PROJ" true
E=$(date +%s%3N)
echo "cold start+exit: $((E - S)) ms"

: >"$R/bwrap.pids"
SOCAT_BASE=$(pgrep -c -x socat || true)
[ -z "$SOCAT_BASE" ] && SOCAT_BASE=0
echo "baseline socat procs on box: $SOCAT_BASE"
for a in $IDLE; do
  "$R/launch.sh" "$R" "$a" "$PROJ" sleep 600 >"$R/idle-$a.log" 2>&1 &
  echo $! >>"$R/bwrap.pids"
done
for i in $(seq 1 100); do
  n=$(pgrep -c -x socat || true)
  [ -z "$n" ] && n=0
  [ "$((n - SOCAT_BASE))" = 20 ] && break
  if [ "$i" = 100 ]; then
    fail "20 socat bridges (got $((n - SOCAT_BASE)) new, $n total, base $SOCAT_BASE)"
    echo "--- procs named socat ---"; pgrep -ax socat | head -30
    echo "--- full-cmdline matches (old gate saw these) ---"; pgrep -af "UNIX-CONNECT:/run/sbx/agent.sock" | head -70
    echo "--- comm histogram of full-cmdline matches ---"
    for p in $(pgrep -f "UNIX-CONNECT:/run/sbx/agent.sock"); do cat /proc/"$p"/comm 2>/dev/null; done | sort | uniq -c
    echo "--- bwrap pid file lines: $(wc -l < "$R/bwrap.pids"), liveness: ---"
    while read -r p; do if kill -0 "$p" 2>/dev/null; then echo alive; else echo DEAD; fi; done < "$R/bwrap.pids" | sort | uniq -c
    head -5 "$R"/idle-*.log
    exit 1
  fi
  sleep 0.1
done
echo "20 idle sandboxes up"
echo "--- settled composition (full-cmdline matches by comm) ---"
for p in $(pgrep -f "UNIX-CONNECT:/run/sbx/agent.sock"); do cat /proc/"$p"/comm 2>/dev/null; done | sort | uniq -c
sleep 2
node "$R/measure.cjs" "$R/bwrap.pids" "$PROXY_PID" | tee "$R/measure.txt"

# --- functional + bypass test, runs INSIDE one sandbox ---
read -r -d '' SBXTEST <<'EOF' || true
ok=0
for i in $(seq 1 50); do
  if curl -s -o /dev/null --noproxy "*" --max-time 1 http://127.0.0.1:3128/ 2>/dev/null; then ok=1; break; fi
  sleep 0.1
done
[ "$ok" = 1 ] || { echo "BRIDGE_TIMEOUT"; exit 9; }
echo "bridge=up"
echo -n "T1_through_proxy_http="; curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TARGET_M0/" 2>/dev/null; echo
echo -n "T2_connect_exit="; curl -s -o /dev/null -k --max-time 10 "https://127.0.0.1:18080/" 2>/dev/null; echo "$?"
echo -n "T3_ssh_visible_entries="; ls -A "$HOME/.ssh" 2>/dev/null | wc -l
if echo x > "$PROJ_M0/nope" 2>/dev/null; then echo "T4a_write_proj=ALLOWED"; else echo "T4a_write_proj=BLOCKED"; fi
if echo x > "$HOME/nope-m0" 2>/dev/null; then echo "T4b_write_home=ALLOWED"; else echo "T4b_write_home=BLOCKED"; fi
echo -n "B1_noproxy_exit="; curl -s -o /dev/null --noproxy "*" --max-time 5 http://example.com/ 2>/dev/null; echo "$?"
echo -n "B2_noenv_exit="; env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl -s -o /dev/null --max-time 5 http://example.com/ 2>/dev/null; echo "$?"
echo -n "B3_localhost_isolated_exit="; curl -s -o /dev/null --noproxy "*" --max-time 5 "$TARGET_M0/" 2>/dev/null; echo "$?"
echo -n "B3b_directip_exit="; curl -s -o /dev/null --noproxy "*" --max-time 5 http://93.184.216.34/ 2>/dev/null; echo "$?"
echo -n "B4_default_route_lines="; awk 'NR>1 && $2=="00000000" {c++} END {print c+0}' /proc/net/route
echo -n "T5_identity_probe="; curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TARGET_M0/$AGENT_M0-probe" 2>/dev/null; echo
EOF

run_probe() {
  AGENT_M0=$1 PROJ_M0=$PROJ TARGET_M0=$TARGET_M0 "$R/launch.sh" "$R" "$1" "$PROJ" /usr/bin/bash -c "$SBXTEST" >"$R/func-$1.txt" 2>&1
  echo "--- func $1 ---"; cat "$R/func-$1.txt"
}
run_probe fx
run_probe fy

check() {
  v=$(grep "^$2=" "$1" | cut -d= -f2)
  if [ "$v" = "$3" ]; then pass "$4 ($2=$v)"; else fail "$4 ($2=$v, want $3)"; fi
}
check "$R/func-fx.txt" T1_through_proxy_http 200 "fx http via proxy"
if grep -q "CONNECT 127.0.0.1:18080 -> tunnel" "$R/proxy.log"; then pass "CONNECT tunnel mechanics (see log)"; else fail "CONNECT tunnel mechanics (no tunnel in log)"; fi
check "$R/func-fx.txt" T3_ssh_visible_entries 0 "fx ~/.ssh masked"
check "$R/func-fx.txt" T4a_write_proj BLOCKED "fx project read-only"
check "$R/func-fx.txt" T4b_write_home BLOCKED "fx home read-only"
check "$R/func-fx.txt" B4_default_route_lines 0 "fx no default route"
for t in B1_noproxy_exit B2_noenv_exit B3_localhost_isolated_exit B3b_directip_exit; do
  v=$(grep "^$t=" "$R/func-fx.txt" | cut -d= -f2)
  if [ "$v" != 0 ]; then pass "fx $t=$v (blocked)"; else fail "fx $t=0 (LEAKED)"; fi
done
grep -q "fx GET http://127.0.0.1:18080/fx-probe" "$R/proxy.log" && pass "identity fx" || fail "identity fx"
grep -q "fy GET http://127.0.0.1:18080/fy-probe" "$R/proxy.log" && pass "identity fy" || fail "identity fy"
if grep "fx-probe" "$R/proxy.log" | grep -vq " fx "; then fail "cross-attribution on fx-probe"; else pass "no cross-attribution"; fi

MEAN=$(grep '^sum-no-sleep=' "$R/measure.txt" | sed 's/.*mean-no-sleep=//;s/MB.*//')
MAXV=$(grep '^sum-no-sleep=' "$R/measure.txt" | sed 's/.*max-no-sleep=//;s/MB//')
echo "walls-only overhead: mean=${MEAN}MB max=${MAXV}MB (target: each <= 10MB)"
if awk "BEGIN {exit !($MAXV <= 10)}"; then pass "memory target (max ${MAXV} <= 10)"; else fail "memory target (max ${MAXV} > 10)"; fi

echo "--- proxy log (first 15) ---"; head -15 "$R/proxy.log"
echo "RESULT_FAIL=$FAIL"
exit $FAIL
