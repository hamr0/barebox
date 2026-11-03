#!/usr/bin/env bash
# Demo A: book a flight. Search runs free, payment stops for approval in every mode,
# the key is never in the agent. httpbin stands in for Stripe: its echo shows the key swap.
#   ./run.sh [--driver scripted|claude] [--mode ask|auto|trust|all] [--live]
# Default: --driver scripted --mode all. The scripted driver is the proof; the claude
# driver is a real agent, best effort. Exits 1 if any cell FAILs.
# Not part of `npm test`, not in the npm tarball. Needs real network (httpbin.org).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SBX=(node "$REPO/src/cli.js")
DRIVER=scripted MODE="" LIVE=0
while (($#)); do
  case $1 in
    --driver) DRIVER=${2:-}; shift 2 ;;
    --mode) MODE=${2:-}; shift 2 ;;
    --live) LIVE=1; shift ;;
    *) echo "usage: run.sh [--driver scripted|claude] [--mode ask|auto|trust|all] [--live]" >&2; exit 2 ;;
  esac
done
[[ $DRIVER == scripted || $DRIVER == claude ]] || { echo "bad --driver" >&2; exit 2; }
[[ -z $MODE || $MODE == all || $MODE == ask || $MODE == auto || $MODE == trust ]] || { echo "bad --mode" >&2; exit 2; }
[[ -z $MODE ]] && { [[ $DRIVER == claude ]] && MODE=auto || MODE=all; }
if [[ $MODE == all ]]; then MODES=(ask auto trust); else MODES=("$MODE"); fi

# Sockets cap at 107 bytes, so the runtimes live under a short /tmp path.
ROOT=$(mktemp -d /tmp/bbdemo.XXXXXX)
export XDG_CONFIG_HOME=$ROOT/xdg   # the demo never touches ~/.config
unset XDG_RUNTIME_DIR              # named sandboxes live under $TMPDIR/sbx-<uid>/<name>
unset SBX_RUNTIME                  # the demo addresses sandboxes by --name
export TMPDIR=$ROOT/t
mkdir -p "$XDG_CONFIG_HOME/barebox" "$TMPDIR"
rtdir() { echo "$TMPDIR/sbx-$(id -u)/$1"; }
cleanup() {
  touch "$ROOT"/stop 2>/dev/null
  local p; for p in $(jobs -p); do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A fresh real key per run: the agent must never be able to print it by luck.
REAL="sk_test_demoA_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
HOSTS='["httpbin.org"]'
write_config() { # write_config <mode>
  printf '{"mode":"%s","secrets":{"STRIPE_API_KEY":{"value":"%s","hosts":%s}}}\n' "$1" "$REAL" "$HOSTS" \
    >"$XDG_CONFIG_HOME/barebox/config.json"
}

declare -A EXP ACT STATUS
FAILS=0
NAMES=([1]="search (GET)" [2]="pay (floor)" [3]="email (x)" [4]="pay, denied" [5]="agent key != real" [6]="real key in echo only" [7]="real key in no file")
expect() { # expect <mode> <cell>
  case $2 in
    1) echo "free 200" ;;
    2) echo "held>approved>200" ;;
    3) [[ $1 == trust ]] && echo "free 200" || echo "held>approved>200" ;;
    4) echo "held>denied>403" ;;
    5|6|7) echo yes ;;
  esac
}

# Approve every hold except step 4 (the second payment). Log: step<TAB>id<TAB>decision<TAB>line
answer_loop() { # answer_loop <name> <log>
  local nm=$1 log=$2 end=$((SECONDS + 400)) out id rest n
  declare -A seen=()
  while [[ ! -e $ROOT/stop && $SECONDS -lt $end ]]; do
    out=$("${SBX[@]}" pending --name "$nm" 2>/dev/null)
    while read -r id rest; do
      [[ $id =~ ^h[0-9]+$ ]] || continue
      [[ -n ${seen[$id]:-} ]] && continue
      seen[$id]=1
      n=""; [[ $rest =~ step=([0-9]+) ]] && n=${BASH_REMATCH[1]}
      if [[ $n == 4 ]]; then
        "${SBX[@]}" deny "$id" "demo: second payment refused" --name "$nm" >/dev/null 2>&1
        printf '%s\t%s\t%s\t%s\n' "$n" "$id" denied "$id $rest" >>"$log"
      else
        "${SBX[@]}" approve "$id" --name "$nm" >/dev/null 2>&1
        printf '%s\t%s\t%s\t%s\n' "$n" "$id" approved "$id $rest" >>"$log"
      fi
    done <<<"$out"
    sleep 0.2
  done
}

# audit_state <gate.jsonl> -> lines `N held|free allow|deny rule`, keyed by ?step=N or &step=N
audit_state() {
  node -e '
    const fs = require("fs"); const s = new Map();
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.phase !== "gate" || !j.action?.url) continue;
      const m = /[?&]step=(\d+)/.exec(j.action.url); if (!m) continue;
      const e = s.get(m[1]) ?? { held: false, final: "", rule: "" };
      if (j.decision === "askHuman") { e.held = true; e.rule = j.rule; } else { e.final = j.decision; if (!e.held) e.rule = j.rule ?? ""; }
      s.set(m[1], e);
    }
    for (const [n, e] of s) console.log(n, e.held ? "held" : "free", e.final || "none", e.rule || "-");
  ' "$1" 2>/dev/null
}

# live_summary <gate.jsonl>: one plain-words line per step, from audit_state
live_summary() {
  local n held final rule what who why
  while read -r n held final rule; do
    case $held in held) what="held, you"; [[ $final == allow* ]] && what+=" allowed" || what+=" denied" ;; *) what="free, no question" ;; esac
    case $rule in
      flags.paymentPath) why="  (payment rule, asks in every mode)" ;;
      rwx.ask) why="  (a change barebox can't undo)" ;;
      flags.cardLike) why="  (looks like a card number)" ;;
      *) why="" ;;
    esac
    [[ $held == free ]] && why=""
    printf '%s %-16s %-18s%s\n' "$n" "${NAMES[$n]:-step $n}" "$what" "$why"
  done < <(audit_state "$1" | sort -n)
}

run_agent() { # run_agent <name> <mode> <hlog> <outfile> <cmd...>
  local nm=$1 mode=$2 hlog=$3 outf=$4; shift 4
  : >"$hlog"
  mkdir -p "$ROOT/$mode/proj"
  if ((LIVE)); then
    (cd "$ROOT/$mode/proj" && "${SBX[@]}" run --name "$nm" --mode "$mode" --overlay -- "$@" \
      | grep --line-buffered -v -E '^decided h[0-9]+ '; exit "${PIPESTATUS[0]}")
    return $?
  fi
  answer_loop "$nm" "$hlog" &
  local lp=$!
  (cd "$ROOT/$mode/proj" && timeout 280 "${SBX[@]}" run --name "$nm" --mode "$mode" --overlay -- "$@" >"$outf" 2>&1)
  local rc=$?
  sleep 0.6
  kill $lp 2>/dev/null; wait $lp 2>/dev/null
  return $rc
}

set_cell() { # set_cell <mode> <cell> <actual> [note]
  local m=$1 n=$2 a=$3 note=${4:-}
  ACT[$m,$n]=$a
  EXP[$m,$n]=$(expect "$m" "$n")
  if [[ -n $note ]]; then STATUS[$m,$n]=$note; return; fi
  if [[ $a == "${EXP[$m,$n]}" ]]; then STATUS[$m,$n]=PASS; else STATUS[$m,$n]=FAIL; ((FAILS++)); fi
}

declare -A HOLDS
evaluate() { # evaluate <mode> <name> <hlog> <agentout>
  local m=$1 nm=$2 hlog=$3 aout=$4 n r held final rule dec act
  declare -A res=() aud=() hdec=()
  while read -r _ n _ r; do [[ -n ${n:-} ]] && res[$n]=$r; done < <(grep '^STEP ' "$aout")
  while read -r n held final rule; do [[ -n ${n:-} ]] && aud[$n]="$held $final"; done < <(audit_state "$(rtdir "$nm")/gate.jsonl")
  while IFS=$'\t' read -r n _ dec _; do [[ -n $n ]] && hdec[$n]=$dec; done <"$hlog"
  HOLDS[$m]=$(wc -l <"$hlog" | tr -d ' ')
  for n in 1 2 3 4; do
    r=${res[$n]:-missing}
    if [[ $DRIVER == claude && -z ${aud[$n]:-} ]]; then set_cell "$m" "$n" "-" "NOT RUN (model)"; continue; fi
    read -r held final <<<"${aud[$n]:-none none}"
    if [[ $held == held ]]; then act="held>${hdec[$n]:-unanswered}>$r"
    elif [[ $held == free && -z ${hdec[$n]:-} ]]; then act="free $r"
    else act="audit=${aud[$n]:-none} loop=${hdec[$n]:-none} http=$r"; fi
    set_cell "$m" "$n" "$act"
  done
  # 5: what the agent printed as its key is neither the real value nor empty
  local key; key=$(sed -n 's/^agent sees key:  //p' "$aout" | head -1)
  if [[ $DRIVER == claude ]]; then set_cell "$m" 5 "-" "NOT CHECKED"
  else [[ -n $key && $key != *"$REAL"* ]] && act=yes || act="no (agent saw: ${key:-nothing})"; set_cell "$m" 5 "$act"; fi
  # 6: the real value is in the payment echo (step 2), and in no other line the agent printed
  local echoes other
  echoes=$(grep -c "^server received: .*Bearer $REAL" "$aout")
  other=$(grep -v '^server received: ' "$aout" | grep -c "$REAL")
  if [[ $DRIVER == claude ]]; then set_cell "$m" 6 "-" "NOT CHECKED"
  else [[ $echoes == 1 && $other == 0 ]] && act=yes || act="no (echoes=$echoes elsewhere=$other)"; set_cell "$m" 6 "$act"; fi
  # 7: the real value is in no file the agent could read: the project, its overlay, the whole sandbox runtime
  # (the config file holds it by design; the agent cannot read it, it is masked)
  local hits
  hits=$(grep -rlF "$REAL" "$ROOT/$m" "$(rtdir "$nm")" 2>/dev/null | grep -v -e 'out.txt$' -e 'holds.log$' -e '/gate.jsonl$' -e '/audit' || true)
  [[ -z $hits ]] && act=yes || act="no: $(echo $hits | head -c 120)"
  set_cell "$m" 7 "$act"
}

for m in "${MODES[@]}"; do
  d=$ROOT/$m; mkdir -p "$d/proj"
  nm=$m-agent
  write_config "$m"
  echo "=== mode $m ($DRIVER driver) ==="
  if ((LIVE)); then
    echo "LIVE: sbx asks here. Allow the first payment and the email; DENY the second payment (the one with step=4)."
  fi
  if [[ $DRIVER == scripted ]]; then
    run_agent "$nm" "$m" "$d/holds.log" "$d/out.txt" bash -c "$(cat "$HERE/agent.sh")"
  else
    run_agent "$nm" "$m" "$d/holds.log" "$d/out.txt" env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p "$(cat "$HERE/prompt.md")" --permission-mode bypassPermissions
  fi
  rc=$?
  echo "(agent run exit $rc)"
  if ((LIVE)); then
    echo "-- what barebox decided:"; live_summary "$(rtdir "$nm")/gate.jsonl"
    continue
  fi
  sed 's/^/  | /' "$d/out.txt" | head -40
  echo "holds answered by the loop:"; cut -f1,3,4 "$d/holds.log" | sed 's/^/  /'
  evaluate "$m" "$nm" "$d/holds.log" "$d/out.txt"
  if [[ $rc -ne 0 ]]; then echo "FAIL: agent run exited $rc"; ((FAILS++)); fi
  if [[ $DRIVER == claude ]]; then
    ran=0; for n in 1 2 3 4; do [[ ${STATUS[$m,$n]:-} == PASS || ${STATUS[$m,$n]:-} == FAIL ]] && ((ran++)); done
    ((ran == 0)) && { echo "FAIL: no step ran (hollow green)"; ((FAILS++)); }
  fi
done

((LIVE)) && exit 0

echo; echo "=== RESULT TABLE ($DRIVER driver) ==="
printf '%-6s %-3s %-22s %-20s %-30s %s\n' MODE '#' CELL EXPECTED ACTUAL STATUS
for m in "${MODES[@]}"; do
  for n in 1 2 3 4 5 6 7; do
    printf '%-6s %-3s %-22s %-20s %-30s %s\n' "$m" "$n" "${NAMES[$n]}" "${EXP[$m,$n]:-}" "${ACT[$m,$n]:-}" "${STATUS[$m,$n]:-}"
  done
  echo "  -> $m: holds asked ${HOLDS[$m]:-0}"
done
if ((FAILS)); then echo "RESULT: $FAILS FAIL"; exit 1; fi
echo "RESULT: all PASS"
exit 0
