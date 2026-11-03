#!/usr/bin/env bash
# The scripted agent: runs INSIDE `sbx run`, passed as `bash -c "$(cat agent.sh)"`.
# It books a flight: search, pay (Stripe-style API), email the itinerary.
# One line per step: `STEP <n> <name> <http code | curl<exit>>`. It prints the key it was
# given (`agent sees key:`) and what httpbin echoed back as the Authorization header (`server received:`).
# Every request carries ?step=N so holds and audit lines map to steps exactly.
echo "agent sees key:  $STRIPE_API_KEY"
req() { # req <n> <name> <curl args...> ; prints STEP, and `server received:` for the payment steps
  local n=$1 name=$2 out rc code body
  shift 2
  out=$(curl -m 20 -s -w '\n%{http_code}' "$@")
  rc=$?
  if ((rc != 0)); then echo "STEP $n $name curl$rc"; return; fi
  code=${out##*$'\n'}; body=${out%$'\n'*}
  echo "STEP $n $name $code"
  if [[ $name == pay ]]; then
    local h; h=$(grep -o '"Authorization": "[^"]*"' <<<"$body" | head -1)
    if [[ -n $h ]]; then h=${h#*: \"}; echo "server received: Authorization: ${h%\"}"
    else echo "server received: nothing (the request never left)"; fi
  fi
}
pay() { req "$1" pay -X POST "https://httpbin.org/anything/v1/payment_intents?step=$1" \
  -H "Authorization: Bearer $STRIPE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"amount":41200,"currency":"gbp","description":"LHR-BCN"}'; }
req 1 search 'https://httpbin.org/anything/search?from=LHR&to=BCN&max=450&step=1'
pay 2
req 3 email -X POST 'https://httpbin.org/anything/send-email?step=3' -H 'Content-Type: application/json' \
  -d '{"to":"me@example.com","itinerary":"LHR-BCN 09:15, 412 GBP"}'
pay 4
exit 0
