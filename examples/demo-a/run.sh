#!/usr/bin/env bash
# Demo A: book a flight. Search runs free, payment stops for approval in every mode,
# the key is never in the agent. httpbin stands in for Stripe: its echo shows the key swap.
#   ./run.sh [--driver scripted|claude|muse] [--mode ask|auto|trust|all] [--live] [--runs N]
# Default: --driver scripted --mode all. The scripted driver is the proof; the claude
# and muse drivers are real agents, best effort. Exits 1 if any cell FAILs.
# Demo agent's system prompt (muse): "You book travel using the HTTP APIs in the user's message. Do exactly
# the numbered steps, in order, with one curl command per step. Do not explore the machine, read files or
# print the environment. After the last step, reply with one short line and no tool call." (temperature 0.2)
# The script runs inline (node -e), never as a file in the project, so the model cannot read it.
# --driver muse: examples/demo-a/muse-agent.mjs (plain Node, a bash tool) calls Baseten's
# chat endpoint from inside the sandbox. Needs BASETEN_API_KEY in the host env (the proxy
# swaps it in after the gate; the agent holds a placeholder). MUSE_MODEL picks the model
# (default meta-models/muse-spark-open-1026). --runs N repeats each mode N times and prints
# one PROMPTS line per run: stock = shell commands the agent ran (what an ask-before-every-
# command setup would prompt), barebox = the holds it asked (askHuman in gate.jsonl).
# labels/baseten: rwxmap graded POST /v1/chat/completions "x"; baseten.rwxmap.json was edited
# to "r" by hand (a model call is free in every mode). That edit is the user's review.
# Not part of `npm test`, not in the npm tarball. Needs real network (httpbin.org).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SBX=(node "$REPO/src/cli.js")
DRIVER=scripted MODE="" LIVE=0 RUNS=1
while (($#)); do
  case $1 in
    --driver) DRIVER=${2:-}; shift 2 ;;
    --mode) MODE=${2:-}; shift 2 ;;
    --live) LIVE=1; shift ;;
    --runs) RUNS=${2:-}; shift 2 ;;
    *) echo "usage: run.sh [--driver scripted|claude|muse] [--mode ask|auto|trust|all] [--live] [--runs N]" >&2; exit 2 ;;
  esac
done
[[ $DRIVER == scripted || $DRIVER == claude || $DRIVER == muse ]] || { echo "bad --driver" >&2; exit 2; }
[[ $RUNS =~ ^[1-9][0-9]*$ ]] || { echo "bad --runs" >&2; exit 2; }
if [[ $DRIVER == muse && -z ${BASETEN_API_KEY:-} ]]; then
  echo "the muse driver needs BASETEN_API_KEY in the environment (a Baseten API key); run: BASETEN_API_KEY=... $0 --driver muse" >&2; exit 2
fi
[[ -z $MODE || $MODE == all || $MODE == ask || $MODE == auto || $MODE == trust ]] || { echo "bad --mode" >&2; exit 2; }
[[ -z $MODE ]] && { [[ $DRIVER == scripted ]] && MODE=all || MODE=auto; }
if [[ $DRIVER == muse && $LIVE == 1 && ( $MODE == all || $RUNS != 1 ) ]]; then
  echo "--driver muse --live runs one mode once: give --mode ask|auto|trust and no --runs" >&2; exit 2
fi
if [[ $MODE == all ]]; then MODES=(ask auto trust); else MODES=("$MODE"); fi

B='' D='' R='' G='' C='' X=''
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' G=$'\e[32m' C=$'\e[36m' X=$'\e[0m'; fi

# live_filter: drop the `decided` lines; on a terminal also color the agent's STEP and key lines
# (the agent prints plain, so the scripted run's parsers never see escapes). Line-buffered.
live_filter() {
  if [[ -n $G ]]; then
    awk -v D="$D" -v R="$R" -v G="$G" -v C="$C" -v Y=$'\e[33m' -v X="$X" '
      /^decided h[0-9]+ / { next }
      /^TOOL [0-9]+ / { print C $0 X; fflush(); next }
      /^model call [0-9]+ / { print D $0 X; fflush(); next }
      /^USAGE [0-9]+ / { next }
      /^FINAL / {
        t = substr($0, 7); n = length(t); e = n
        for (i = 1; i <= n; i++) if (substr(t, i, 1) ~ /[.!?]/ && (i == n || substr(t, i + 1, 1) == " ") && (i == 1 || substr(t, i - 1, 1) !~ /[0-9]/)) { e = i; break }
        t = substr(t, 1, e)
        if (length(t) > 160) { t = substr(t, 1, 160); sub(/ [^ ]*$/, "", t); t = t "..." }
        if (t ~ /^gave up/) print "agent: " t; else print "agent: done" (t == "" ? "" : " — " t)
        fflush(); next
      }
      /^STEP / { c = ($NF == "200") ? G : R; print substr($0, 1, length($0) - length($NF)) c $NF X; fflush(); next }
      /^agent sees key:  / { print D "agent sees key:" X "  " Y substr($0, 18) X; fflush(); next }
      /^server received: / { r = substr($0, 18); print D "server received:" X " " ((r ~ /^nothing/) ? R : G) r X; fflush(); next }
      { print; fflush() }'
  else
    grep --line-buffered -v -E '^decided h[0-9]+ |^USAGE [0-9]+ '
  fi
}

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
MUSE_MODEL=${MUSE_MODEL:-meta-models/muse-spark-open-1026}
write_config() { # write_config <mode>
  if [[ $DRIVER == muse ]]; then
    printf '{"mode":"%s","labels":["%s"],"env":{"set":{"MUSE_MODEL":"%s"}},"secrets":{"STRIPE_API_KEY":{"value":"%s","hosts":%s},"BASETEN_API_KEY":{"fromEnv":"BASETEN_API_KEY","hosts":["inference.baseten.co"]}}}\n' \
      "$1" "$HERE/labels/baseten" "$MUSE_MODEL" "$REAL" "$HOSTS" >"$XDG_CONFIG_HOME/barebox/config.json"
    return
  fi
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
  local nm=$1 log=$2 end=$((SECONDS + 400)) out id rest n pays=0
  declare -A seen=()
  while [[ ! -e $ROOT/stop && $SECONDS -lt $end ]]; do
    out=$("${SBX[@]}" pending --name "$nm" 2>/dev/null)
    while read -r id rest; do
      [[ $id =~ ^h[0-9]+$ ]] || continue
      [[ -n ${seen[$id]:-} ]] && continue
      seen[$id]=1
      n=""; [[ $rest =~ step=([0-9]+) ]] && n=${BASH_REMATCH[1]}
      if [[ $DRIVER == muse ]]; then # no ?step=: first payment is 2, any later one is 4, the email is 3
        if [[ $rest == *payment_intents* ]]; then ((pays++)); ((pays > 1)) && n=4 || n=2
        elif [[ $rest == *send-email* ]]; then n=3; fi
      fi
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
  if [[ $DRIVER == muse ]]; then live_summary_muse "$1"; return; fi
  local n held final rule what who why
  while read -r n held final rule; do
    case $held in held) what="held, you"; [[ $final == allow* ]] && what+=" allowed" || what+=" denied" ;; *) what="free, no question" ;; esac
    local c=$G; [[ $what == *denied ]] && c=$R
    case $rule in
      flags.paymentPath) why="  (payment rule, asks in every mode)" ;;
      rwx.ask) why="  (a change barebox can't undo)" ;;
      flags.cardLike) why="  (looks like a card number)" ;;
      *) why="" ;;
    esac
    [[ $held == free ]] && why=""
    printf '%s %-16s %s%s%s%s\n' "$n" "${NAMES[$n]:-step $n}" "$c" "$(printf '%-18s' "$what")" "$X" "${D}${why}${X}"
  done < <(audit_state "$1" | sort -n)
}

# live_summary_muse <gate.jsonl>: no ?step= markers, so classify by URL kind (audit_kinds)
live_summary_muse() {
  local k held final label g
  local -A fr=() al=() de=() seen=()
  local -a order=(search pay email)
  while read -r k held final label; do
    [[ $k == other ]] && { k=${label/_httpbin.org/ }; k=${k//_/ }; }
    if [[ -z ${seen[$k]:-} ]]; then seen[$k]=1; [[ $k != model && $k != search && $k != pay && $k != email ]] && order+=("$k"); fi
    if [[ $held != held ]]; then fr[$k]=$(( ${fr[$k]:-0} + 1 ))
    elif [[ $final == allow* ]]; then al[$k]=$(( ${al[$k]:-0} + 1 ))
    else de[$k]=$(( ${de[$k]:-0} + 1 )); fi
  done < <(audit_kinds "$1")
  order+=(model)
  local tf=0 ta=0 td=0
  for g in "${order[@]}"; do tf=$((tf + ${fr[$g]:-0})); ta=$((ta + ${al[$g]:-0})); td=$((td + ${de[$g]:-0})); done
  # one line: counts plain, "N denied" red when any, whole line green when none
  grp_line() { # grp_line <name> <free> <allowed> <denied> <note>
    local nm=$1 f=$2 a=$3 d=$4 note=${5:-} h=$(( $3 + $4 )) txt=""
    ((f)) && txt="$f free"
    if ((h)); then
      ((f)) && txt+=", "
      if ((d)); then txt+="$h held: $a allowed, ${R}$d denied${X}"; else txt+="$h held: $a allowed"; fi
    fi
    if ((d)); then printf '%-16s %s%s\n' "$nm" "$txt" "${note:+ ${D}${note}${X}}"
    else printf '%-16s %s%s%s%s\n' "$nm" "$G" "$txt" "$X" "${note:+ ${D}${note}${X}}"; fi
  }
  local tn=$(( tf + ta + td ))
  if ((td)); then printf '%-16s %s requests to the network: %s free, %s held for you (%s allowed, %s%s denied%s) %s\n' total "$tn" "$tf" "$((ta + td))" "$ta" "$R" "$td" "$X" "${D}(model calls included)${X}"
  else printf '%-16s %s%s requests to the network: %s free, %s held for you (%s allowed, %s denied)%s %s\n' total "$G" "$tn" "$tf" "$((ta + td))" "$ta" "$td" "$X" "${D}(model calls included)${X}"; fi
  for g in "${order[@]}"; do
    [[ -n ${seen[$g]:-} ]] || continue
    if [[ $g == model ]]; then grp_line "model calls" "${fr[model]:-0}" 0 0 "(labelled read-only)"
    else grp_line "$g" "${fr[$g]:-0}" "${al[$g]:-0}" "${de[$g]:-0}"; fi
  done
  # The key swap, from barebox's own audit (the agent can mask its output, not this):
  # one `secret` line per request that carried the Stripe placeholder.
  local sw nosw
  sw=$(grep -c '"verdict":"secret".*"name":"STRIPE_API_KEY".*"swapped":true' "$1")
  nosw=$(grep -c '"verdict":"secret".*"name":"STRIPE_API_KEY".*"swapped":false' "$1")
  if ((sw)); then
    printf '%-16s %s%s%s %s\n' "key swaps" "$G" "$sw" "$X" "${D}(the real test key went into the header only after your yes; the agent only ever had the placeholder)${X}"
  else
    printf '%-16s %s%s%s %s\n' "key swaps" "$R" "0" "$X" "${D}(no key left the machine; the agent only ever had the placeholder)${X}"
  fi
  ((nosw)) && printf '%-16s %s%s%s\n' "" "$R" "$nosw request(s) carrying the placeholder were refused or denied: no key sent" "$X"
  return 0
}

run_agent() { # run_agent <name> <mode> <hlog> <outfile> <cmd...>
  local nm=$1 mode=$2 hlog=$3 outf=$4; shift 4
  : >"$hlog"
  mkdir -p "$ROOT/$mode/proj"
  if ((LIVE)); then
    (cd "$ROOT/$mode/proj" && "${SBX[@]}" run --name "$nm" --mode "$mode" --overlay -- "$@" \
      | live_filter; exit "${PIPESTATUS[0]}")
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
  EXP[$m,$n]=$(expect "${m%%.*}" "$n")
  # the muse agent's curl codes are not captured: compare the audit and the answer only
  [[ $DRIVER == muse ]] && EXP[$m,$n]=$(sed -E 's/[ >](200|403)$//' <<<"${EXP[$m,$n]}")
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

# audit_kinds <gate.jsonl> -> one line per request: `kind held|free final`, in request order.
# kind: model (Baseten), search, pay, email, other. Real agents add no ?step=, so the URL says what it is.
audit_kinds() {
  node -e '
    const fs = require("fs"); const s = new Map();
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.phase !== "gate" || !j.action?.url) continue;
      const u = j.action.url;
      const kind = /inference\.baseten\.co/.test(u) ? "model" : /payment_intents/.test(u) ? "pay"
        : /send-email/.test(u) ? "email" : /\/search/.test(u) ? "search" : "other";
      const e = s.get(j.aid) ?? { kind, held: false, final: "", label: (j.action.method ?? "") + " " + u.replace(/^https?:\/\//, "").replace(/\?.*/, "") };
      if (j.decision === "askHuman") e.held = true; else e.final = j.decision;
      s.set(j.aid, e);
    }
    for (const e of s.values()) console.log(e.kind, e.held ? "held" : "free", e.final || "none", e.label.replace(/ /g, "_"));
  ' "$1" 2>/dev/null
}

# muse_cell <key> <cell> <kind> <occurrence> <hlog>: cells 1-4 from the audit, not from curl codes
muse_cell() {
  local key=$1 n=$2 kind=$3 occ=$4 hlog=$5 k held final dec i=0 act
  while read -r k held final _; do
    [[ $k == "$kind" ]] || continue
    ((++i == occ)) || continue
    if [[ $held == held ]]; then
      dec=$(awk -F'\t' -v n="$n" '$1 == n { print $3; exit }' "$hlog")
      act="held>${dec:-unanswered}"
    else act="free"; fi
    set_cell "$key" "$n" "$act"; return
  done < <(audit_kinds "$MUSE_GATE")
  set_cell "$key" "$n" "-" "NOT RUN (model)"
}

declare -A MP_STOCK MP_BB MP_CALLS MP_STATE MP_TOK
muse_all() {
  local m i nm key d out hlog stock bb calls
  for m in "${MODES[@]}"; do
    for ((i = 1; i <= RUNS; i++)); do
      key=$m.$i; nm=$m-agent-$i; d=$ROOT/$m
      mkdir -p "$d/proj"
      write_config "$m"
      echo "=== mode $m run $i ($DRIVER driver, $MUSE_MODEL) ==="
      out=$d/out-$i.txt hlog=$d/holds-$i.log
      if ((LIVE)); then
        echo "LIVE: Meta muse books a flight inside barebox. You answer each question: allow the payment and the email; say no to anything you didn't expect."
        run_agent "$nm" "$m" "$hlog" "$out" node --no-warnings --input-type=module -e "$(cat "$HERE/muse-agent.mjs")" -- "$(cat "$HERE/prompt.md")"
        echo "(agent run exit $?)"
        echo "${B}-- what barebox decided:${X}"; live_summary "$(rtdir "$nm")/gate.jsonl"
        [[ -n $(grep -rlF "$BASETEN_API_KEY" "$ROOT" 2>/dev/null) ]] && echo "${R}FAIL: the Baseten key's value is in a file under the run${X}"
        continue
      fi
      run_agent "$nm" "$m" "$hlog" "$out" node --no-warnings --input-type=module -e "$(cat "$HERE/muse-agent.mjs")" -- "$(cat "$HERE/prompt.md")"
      local rc=$?
      echo "(agent run exit $rc)"
      sed 's/^/  | /' "$out" | head -40
      echo "holds answered by the loop:"; cut -f1,3,4 "$hlog" | sed 's/^/  /'
      MUSE_GATE=$(rtdir "$nm")/gate.jsonl
      stock=$(grep -c '^TOOL ' "$out")
      bb=$(audit_kinds "$MUSE_GATE" | grep -c ' held ')
      calls=$(audit_kinds "$MUSE_GATE" | grep -c '^model ')
      echo "model calls in gate.jsonl (free/held): $(audit_kinds "$MUSE_GATE" | awk '$1 == "model" { c[$2]++ } END { printf "%d/%d", c["free"], c["held"] }')"
      MP_STOCK[$key]=$stock MP_BB[$key]=$bb MP_CALLS[$key]=$calls
      MP_TOK[$key]=$(sed -n 's/^USAGE [0-9]* //p' "$out" | head -1)
      # hollow-green guard: no payment request means the run proves nothing
      if ! audit_kinds "$MUSE_GATE" | grep -q '^pay '; then
        MP_STATE[$key]=INCOMPLETE; echo "INCOMPLETE: the agent never made the payment request ($key not counted)"
      else
        MP_STATE[$key]=ok
        muse_cell "$key" 1 search 1 "$hlog"; muse_cell "$key" 2 pay 1 "$hlog"
        muse_cell "$key" 3 email 1 "$hlog"; muse_cell "$key" 4 pay 2 "$hlog"
        set_cell "$key" 5 "-" "NOT CHECKED"; set_cell "$key" 6 "-" "NOT CHECKED"
        local hits act
        hits=$(grep -rlF "$REAL" "$ROOT/$m" "$(rtdir "$nm")" 2>/dev/null | grep -v -e 'out-[0-9]*\.txt$' -e 'holds-[0-9]*\.log$' -e '/gate.jsonl$' -e '/audit' || true)
        [[ -z $hits ]] && act=yes || act="no: $(echo $hits | head -c 120)"
        set_cell "$key" 7 "$act"
      fi
      if [[ $rc -ne 0 && ${MP_STATE[$key]} == ok ]]; then echo "FAIL: agent run exited $rc"; ((FAILS++)); fi
      # the Baseten key's real value in no file at all: runtime, project, output, audit
      if [[ -n $(grep -rlF "$BASETEN_API_KEY" "$ROOT" 2>/dev/null) ]]; then echo "FAIL: the Baseten key's value is in a file under the run"; ((FAILS++)); fi
      HOLDS[$key]=$bb
    done
  done
}

if [[ $DRIVER == muse ]]; then muse_all; fi

for m in "${MODES[@]}"; do
  [[ $DRIVER == muse ]] && continue
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
    echo "${B}-- what barebox decided:${X}"; live_summary "$(rtdir "$nm")/gate.jsonl"
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
if [[ $DRIVER == muse ]]; then
  declare -A LO=() HI=() LON=() HIN=() CNT=()
  for m in "${MODES[@]}"; do
    for ((i = 1; i <= RUNS; i++)); do
      key=$m.$i
      if [[ ${MP_STATE[$key]} == ok ]]; then
        for n in 1 2 3 4 5 6 7; do
          printf '%-6s %-3s %-22s %-20s %-30s %s\n' "$m.$i" "$n" "${NAMES[$n]}" "${EXP[$key,$n]:-}" "${ACT[$key,$n]:-}" "${STATUS[$key,$n]:-}"
        done
      else printf '%-6s %-3s %s\n' "$m.$i" - "INCOMPLETE (no payment request; not counted)"; fi
    done
  done
  echo; echo "=== PROMPTS ==="
  for m in "${MODES[@]}"; do
    for ((i = 1; i <= RUNS; i++)); do
      key=$m.$i
      if [[ ${MP_STATE[$key]} == ok ]]; then
        echo "PROMPTS mode=$m run=$i stock=${MP_STOCK[$key]} barebox=${MP_BB[$key]} model_calls=${MP_CALLS[$key]}"
        v=${MP_STOCK[$key]}; b=${MP_BB[$key]}
        ((${CNT[$m]:-0} == 0)) && { LO[$m]=$v HI[$m]=$v LON[$m]=$b HIN[$m]=$b; }
        ((v < LO[$m])) && LO[$m]=$v; ((v > HI[$m])) && HI[$m]=$v
        ((b < LON[$m])) && LON[$m]=$b; ((b > HIN[$m])) && HIN[$m]=$b
        CNT[$m]=$(( ${CNT[$m]:-0} + 1 ))
      else echo "PROMPTS mode=$m run=$i INCOMPLETE"; fi
    done
  done
  echo "SUMMARY (model $MUSE_MODEL; INCOMPLETE runs not counted)"
  for m in "${MODES[@]}"; do
    if ((${CNT[$m]:-0} == 0)); then echo "  $m: no complete run"; echo "FAIL: $m had no complete run (hollow green)"; ((FAILS++))
    else echo "  $m: runs=${CNT[$m]}/$RUNS stock=${LO[$m]}-${HI[$m]} barebox=${LON[$m]}-${HIN[$m]}"; fi
  done
  echo "tokens per run (from the API usage field):"
  for m in "${MODES[@]}"; do for ((i = 1; i <= RUNS; i++)); do echo "  $m.$i calls=${MP_CALLS[$m.$i]} tokens(prompt completion)="${MP_TOK[$m.$i]:-?}""; done; done
  if ((FAILS)); then echo "RESULT: $FAILS FAIL"; exit 1; fi
  echo "RESULT: all PASS"; exit 0
fi
for m in "${MODES[@]}"; do
  for n in 1 2 3 4 5 6 7; do
    printf '%-6s %-3s %-22s %-20s %-30s %s\n' "$m" "$n" "${NAMES[$n]}" "${EXP[$m,$n]:-}" "${ACT[$m,$n]:-}" "${STATUS[$m,$n]:-}"
  done
  echo "  -> $m: holds asked ${HOLDS[$m]:-0}"
done
if ((FAILS)); then echo "RESULT: $FAILS FAIL"; exit 1; fi
echo "RESULT: all PASS"
exit 0
