#!/usr/bin/env bash
# RED-TEAM ritual for M0: break each wall on purpose; PASS iff every break is DETECTED.
# SBXTEST mirrors run-m0.sh. Throwaway POC, not shipped.
set -u
R=/tmp/sbx-m0
PROJ=$R/proj
PROXY_PID=""; HTTPD_PID=""
TARGET_M0="http://127.0.0.1:18080"
RED_FAIL=0
detect() { echo "DETECTED: $1"; }
miss() { echo "MISSED: $1"; RED_FAIL=1; }

cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$HTTPD_PID" ] && kill "$HTTPD_PID" 2>/dev/null || true
  if [ -f "$R/red.pids" ]; then
    while read -r p; do kill "$p" 2>/dev/null || true; done < "$R/red.pids"
  fi
  rm -f "$HOME/nope-m0" "$PROJ/nope"
}
trap cleanup EXIT

HOST_SSH=$(ls -A ~/.ssh 2>/dev/null | wc -l)
echo "host ~/.ssh entries: $HOST_SSH"

node "$R/proxy.cjs" "$R/socks" net1 lock1 rw1 bravo mem1 >"$R/red-proxy.log" 2>&1 &
PROXY_PID=$!
for i in $(seq 1 100); do
  n=$(ls "$R/socks"/net1.sock "$R/socks"/lock1.sock "$R/socks"/rw1.sock "$R/socks"/bravo.sock "$R/socks"/mem1.sock 2>/dev/null | wc -l)
  [ "$n" = 5 ] && break
  [ "$i" = 100 ] && { miss "red proxy sockets (got $n/5)"; cat "$R/red-proxy.log"; exit 1; }
  sleep 0.1
done
echo "red proxy up pid=$PROXY_PID"

python3 -m http.server 18080 --bind 127.0.0.1 --directory "$PROJ" >"$R/red-httpd.log" 2>&1 &
HTTPD_PID=$!
for i in $(seq 1 100); do
  if curl -s -o /dev/null --noproxy "*" --max-time 1 "$TARGET_M0/" 2>/dev/null; then break; fi
  [ "$i" = 100 ] && { miss "local httpd up"; cat "$R/red-httpd.log"; exit 1; }
  sleep 0.1
done
echo "local httpd up pid=$HTTPD_PID"

read -r -d '' SBXTEST <<'EOF' || true
ok=0
for i in $(seq 1 50); do
  if curl -s -o /dev/null --noproxy "*" --max-time 1 http://127.0.0.1:3128/ 2>/dev/null; then ok=1; break; fi
  sleep 0.1
done
[ "$ok" = 1 ] || { echo "BRIDGE_TIMEOUT"; exit 9; }
echo "bridge=up"
echo -n "T1_through_proxy_http="; curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TARGET_M0/" 2>/dev/null; echo
echo -n "T3_ssh_visible_entries="; ls -A "$HOME/.ssh" 2>/dev/null | wc -l
if echo x > "$PROJ_M0/nope" 2>/dev/null; then echo "T4a_write_proj=ALLOWED"; else echo "T4a_write_proj=BLOCKED"; fi
if echo x > "$HOME/nope-m0" 2>/dev/null; then echo "T4b_write_home=ALLOWED"; else echo "T4b_write_home=BLOCKED"; fi
echo -n "B1_noproxy_exit="; curl -s -o /dev/null --noproxy "*" --max-time 5 http://example.com/ 2>/dev/null; echo "$?"
echo -n "B3_localhost_isolated_exit="; curl -s -o /dev/null --noproxy "*" --max-time 5 "$TARGET_M0/" 2>/dev/null; echo "$?"
echo -n "B4_default_route_lines="; awk 'NR>1 && $2=="00000000" {c++} END {print c+0}' /proc/net/route
echo -n "T5_identity_probe="; curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TARGET_M0/$AGENT_M0-probe" 2>/dev/null; echo
EOF

run_break() { # <socket> <marker> <break-mode-or-empty> <outfile>
  AGENT_M0=$2 PROJ_M0=$PROJ TARGET_M0=$TARGET_M0 SBX_BREAK=$3 "$R/launch.sh" "$R" "$1" "$PROJ" /usr/bin/bash -c "$SBXTEST" >"$4" 2>&1
  echo "--- $4 done ---"; cat "$4"
}
val() { grep "^$2=" "$1" | cut -d= -f2; }

# A. NET: no net namespace. Expect the host-localhost leak to be SEEN (B3==0);
# front door must stay intact (T1==200).
run_break net1 net1 nonet "$R/red-net.txt"
B3=$(val "$R/red-net.txt" B3_localhost_isolated_exit)
B4=$(val "$R/red-net.txt" B4_default_route_lines)
T1=$(val "$R/red-net.txt" T1_through_proxy_http)
[ "$B3" = 0 ] && detect "NET broken: host-localhost leak visible (B3=0)" || miss "NET broken but B3=$B3 (leak NOT seen)"
[ "$T1" = 200 ] && detect "NET broken: front door still works (T1=200)" || miss "NET broken and T1=$T1"
echo "info NET: B4=$B4 routes; B1_noproxy_exit=$(val "$R/red-net.txt" B1_noproxy_exit) (internet-dependent, not asserted)"

# B. LOCK: no tmpfs masks. Expect the real dir to show through (T3 == host count).
run_break lock1 lock1 nolock "$R/red-lock.txt"
T3=$(val "$R/red-lock.txt" T3_ssh_visible_entries)
if [ "$T3" = "$HOST_SSH" ] && [ "$HOST_SSH" != 0 ]; then detect "LOCK broken: real ~/.ssh shows through (T3=$T3)"; else miss "LOCK broken but T3=$T3 (want $HOST_SSH)"; fi

# C. RW: writable binds. Expect writes to succeed (ALLOWED + ALLOWED).
# Canary in the REAL $HOME; removed below and by trap.
run_break rw1 rw1 rw "$R/red-rw.txt"
R4A=$(val "$R/red-rw.txt" T4a_write_proj); R4B=$(val "$R/red-rw.txt" T4b_write_home)
if [ "$R4A" = ALLOWED ] && [ "$R4B" = ALLOWED ]; then detect "RW broken: writes succeed (proj+home ALLOWED)"; else miss "RW broken but T4a=$R4A T4b=$R4B"; fi

# D. ID: marker alpha through socket bravo (miswired launcher). Default path otherwise,
# which also proves the hooked launcher still builds working sandboxes (T1==200).
run_break bravo alpha "" "$R/red-id.txt"
T1D=$(val "$R/red-id.txt" T1_through_proxy_http)
[ "$T1D" = 200 ] && detect "default path intact after hook edit (T1=200)" || miss "hook edit broke default path (T1=$T1D)"
if grep -q "alpha GET http://127.0.0.1:18080/alpha-probe" "$R/red-proxy.log"; then miss "miswire: marker accepted as identity"; else detect "miswire: main identity assertion correctly FAILS"; fi
if grep -q "bravo GET http://127.0.0.1:18080/alpha-probe" "$R/red-proxy.log"; then detect "miswire: traffic attributed to socket owner (bravo)"; else miss "miswire: probe missing from log entirely"; fi

# E. MEM: meter must see a fat sandbox (50 MB anon alloc). Default path.
"$R/launch.sh" "$R" mem1 "$PROJ" /usr/bin/python3 -c 'import time; x = bytearray(50*1024*1024); time.sleep(600)' >"$R/red-mem.log" 2>&1 &
MEMPID=$!
echo "$MEMPID" > "$R/red.pids"
ready=0
for i in $(seq 1 100); do
  MID=$(pgrep -P "$MEMPID" | head -1)
  if [ -n "$MID" ] && pgrep -P "$MID" -x python3 >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
[ "$ready" = 1 ] || miss "MEM: python allocator never appeared"
node "$R/measure.cjs" "$R/red.pids" "$PROXY_PID" | tee "$R/red-mem.txt"
FAT=$(grep '^count=' "$R/red-mem.txt" | sed 's/.*sum-total=//;s/MB.*//')
echo "fat-sandbox total: ${FAT}MB (gate would fire iff > 10)"
if awk "BEGIN {exit !($FAT > 10)}"; then detect "MEM: meter sees fat sandbox (${FAT}MB > 10MB bar)"; else miss "MEM: meter blind (total ${FAT}MB)"; fi

rm -f "$HOME/nope-m0" "$PROJ/nope"
if [ -e "$HOME/nope-m0" ] || [ -e "$PROJ/nope" ]; then echo "CANARY LEFTOVER PRESENT"; RED_FAIL=1; else echo "canaries clean"; fi
echo "--- red proxy identity lines ---"; grep -- 'probe' "$R/red-proxy.log"
echo "REDTEAM_FAIL=$RED_FAIL"
exit $RED_FAIL
