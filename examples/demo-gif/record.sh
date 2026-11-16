#!/usr/bin/env bash
# One real take for the README GIF: a scripted agent (agent.sh) inside a real
# `sbx run --mode auto --hold 8`, recorded in a pty with `script --timing`.
#   ./record.sh [outdir]      default outdir: examples/demo-gif/take/ (gitignored)
#   node examples/demo-gif/render.mjs examples/demo-gif/take examples/demo-gif/captions.json assets/demo.gif
# PAUSE (default 4 s) is how long each answer waits after its prompt appears, so a viewer can read.
# A feeder types the answers like a person: y, y, n, and nothing (hold 4 times out).
# Writes take.log, take.timing, gate.jsonl, take.feed (answer times) to outdir, then
# self-checks gate.jsonl and take.log; exits 1 on any miss. Needs httpbin.org.
# Patterns copied from examples/demo-a/run.sh: temp root + XDG config, short /tmp path
# (sockets cap at 107 bytes), rtdir, the audit_state node reader, live_summary colours.
# Pattern copied from the scratchpad live-drive.sh: the feeder watches the log for Allow?.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PAUSE=${PAUSE:-4}
ANSWERS=(${ANSWERS:-y y n -})   # `-` = type nothing (overridable: the self-check must be able to fail)

B='' D='' R='' G='' X=''
rtdir() { echo "$TMPDIR/sbx-$(id -u)/$1"; }

# audit_state <gate.jsonl> -> one line per ?step=N: `N held|free allow|deny reason-key rule`
# reason-key: the verdict's reason text with spaces turned to _ (`-` when none).
audit_state() {
  node -e '
    const fs = require("fs"); const s = new Map();
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.phase !== "gate" || !j.action?.url) continue;
      const m = /[?&]step=(\d+)/.exec(j.action.url); if (!m) continue;
      const e = s.get(m[1]) ?? { held: false, final: "", rule: "", reason: "" };
      if (j.decision === "askHuman") { e.held = true; e.rule = j.rule ?? ""; }
      else { e.final = j.decision; e.reason = j.reason ?? ""; if (!e.held) e.rule = j.rule ?? ""; }
      s.set(m[1], e);
    }
    for (const [n, e] of s) console.log(n, e.held ? "held" : "free", e.final || "none", e.reason.replace(/ /g, "_") || "-", e.rule || "-");
  ' "$1" 2>/dev/null
}

NAMES=([1]="search" [2]="pay" [3]="email" [4]="pay again" [5]="upload")
live_summary() { # live_summary <gate.jsonl>: a header, then one line per step
  local n held final reason rule what c why
  printf '%swhat barebox decided%s\n' "$B" "$X"
  while read -r n held final reason rule; do
    c=$G
    if [[ $held == free ]]; then what="free"
    elif [[ $final == allow* ]]; then what="allowed"
    elif [[ $reason == hold_timeout ]]; then what="timed out"; c=$R
    else what="denied"; c=$R; fi
    why=""
    if [[ $held == held ]]; then
      case $rule in
        flags.paymentPath) why="payment rule, asks in every mode" ;;
        rwx.ask) why="a change barebox can't undo" ;;
        flags.cardLike) why="looks like a card number" ;;
      esac
    fi
    printf '%s  %-10s %s%-10s%s %s%s%s\n' "$n" "${NAMES[$n]:-step $n}" "$c" "$what" "$X" "$D" "$why" "$X"
  done < <(audit_state "$1" | sort -n)
}

if [[ ${1:-} == --inner ]]; then # runs inside the recorded pty
  shift; OUT=$1
  if [[ -z ${NO_COLOR:-} ]]; then B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' G=$'\e[32m' X=$'\e[0m'; fi
  stty cols 80 rows 30
  printf '$ sbx run --mode auto --hold 8 -- bash book-trip.sh\n'
  mkdir -p "$ROOT/proj"; cd "$ROOT/proj" || exit 1
  node "$REPO/src/cli.js" run --name gif --mode auto --hold 8 -- bash -c "$(cat "$HERE/agent.sh")"
  echo
  live_summary "$(rtdir gif)/gate.jsonl"
  exit 0
fi

OUT=${1:-$HERE/take}
mkdir -p "$OUT" || exit 2
OUT=$(cd "$OUT" && pwd)
rm -f "$OUT"/take.log "$OUT"/take.timing "$OUT"/gate.jsonl "$OUT"/take.feed

ROOT=$(mktemp -d /tmp/bbgif.XXXXXX)
export ROOT REPO HERE
export XDG_CONFIG_HOME=$ROOT/xdg   # the take never touches ~/.config
unset XDG_RUNTIME_DIR SBX_RUNTIME
export TMPDIR=$ROOT/t
mkdir -p "$XDG_CONFIG_HOME/barebox" "$TMPDIR"
FEEDPID=""
cleanup() {
  [[ -n $FEEDPID ]] && kill "$FEEDPID" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

REAL="sk_test_gif_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '{"mode":"auto","secrets":{"STRIPE_API_KEY":{"value":"%s","hosts":["httpbin.org"]}}}\n' "$REAL" \
  >"$XDG_CONFIG_HOME/barebox/config.json"

LOG=$OUT/take.log
: >"$LOG"
feeder() { # types each answer PAUSE s after the next new `Allow? [y/N]` appears in the log
  local i=0 n
  while ((i < ${#ANSWERS[@]})); do
    n=$(grep -ao 'Allow? \[y/N\]' "$LOG" 2>/dev/null | wc -l)
    if ((n > i)); then
      echo "$(date -u +%T.%N) prompt $((i + 1)) seen" >>"$OUT/take.feed"
      sleep "$PAUSE"
      if [[ ${ANSWERS[$i]} == - ]]; then echo "$(date -u +%T.%N) typed nothing" >>"$OUT/take.feed"
      else printf '%s\r' "${ANSWERS[$i]}"; echo "$(date -u +%T.%N) typed ${ANSWERS[$i]}" >>"$OUT/take.feed"; fi
      ((i++))
    fi
    sleep 0.2
  done
  sleep 600 # keep script's stdin open until record.sh ends this
}
FIFO=$ROOT/in; mkfifo "$FIFO"
feeder >"$FIFO" &
FEEDPID=$!

START=$(date +%s.%N)
script -q -f -T "$OUT/take.timing" -O "$LOG" -c "bash $HERE/record.sh --inner $OUT" <"$FIFO" >/dev/null
SRC=$?
END=$(date +%s.%N)
kill "$FEEDPID" 2>/dev/null; FEEDPID=""
cp "$(rtdir gif)/gate.jsonl" "$OUT/gate.jsonl" 2>/dev/null
# script adds a "Script started" header line and a "Script done" footer to the log; the timing
# file counts neither. Cut both so take.log holds exactly the bytes the timing file times.
TBYTES=$(awk '{ s += $2 } END { print s + 0 }' "$OUT/take.timing")
HLEN=$(head -n 1 "$LOG" | wc -c)
tail -c +$((HLEN + 1)) "$LOG" | head -c "$TBYTES" >"$LOG.cut" && mv "$LOG.cut" "$LOG"

# --- self-check: every line must be able to fail ---
FAILS=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
[[ $(wc -c <"$LOG") -eq $TBYTES ]] && ok "take.log is $TBYTES bytes, as take.timing counts" || bad "take.log and take.timing disagree"
head -c 14 "$LOG" | grep -q '^\$ sbx run' && ok "take.log starts at the prompt line" || bad "take.log has a header"
((SRC == 0)) && ok "script exited 0" || bad "script exited $SRC"
[[ -s $OUT/gate.jsonl ]] || bad "no gate.jsonl"
declare -A ST=()
while read -r n held final reason rule; do ST[$n]="$held $final $reason"; done < <(audit_state "$OUT/gate.jsonl")
expect() { # expect <step> <held> <final-glob> <reason-glob> <what>
  local got=${ST[$1]:-missing} h f r
  read -r h f r <<<"$got"
  if [[ $h == "$2" && $f == $3 && $r == $4 ]]; then ok "step $1 $5 ($h $f $r)"; else bad "step $1 expected $5, got: $got"; fi
}
expect 1 free 'allow*' '*' "free allow"
expect 2 held 'allow*' '*' "held, allowed"
expect 3 held 'allow*' '*' "held, allowed"
expect 4 held 'deny*' '*' "held, denied"
expect 5 held 'deny*' hold_timeout "held, denied by hold timeout"
REALN=$(grep -aoF "$REAL" "$LOG" | wc -l)
((REALN == 1)) && ok "real key in take.log exactly once" || bad "real key in take.log $REALN times"
HITS=$(grep -rlaF "$REAL" "$ROOT" 2>/dev/null | grep -v -e "^$ROOT/xdg/" -e '/gate.jsonl$' -e '/audit' || true)
[[ -z $HITS ]] && ok "real key in no file under the run (config aside)" || bad "real key in: $HITS"
if grep -qaF "$REAL" "$OUT/gate.jsonl"; then
  echo "NOTE real key IS in gate.jsonl (finding)"
else echo "ok   real key not in gate.jsonl"; fi
WIDE=$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | tr -d '\r' | awk '{ n = length($0); if (n > m) m = n } END { print m + 0 }')
((WIDE <= 80)) && ok "widest take.log line: $WIDE cols" || bad "take.log has a line of $WIDE cols"
printf 'elapsed %.1f s\n' "$(echo "$END - $START" | bc -l)"
if ((FAILS)); then echo "RESULT: $FAILS FAIL"; exit 1; fi
echo "RESULT: take ok ($OUT)"
exit 0
