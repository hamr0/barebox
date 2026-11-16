#!/usr/bin/env bash
# The scripted agent for the README GIF: runs INSIDE `sbx run`, passed as
# `bash -c "$(cat agent.sh)"`. Five requests to httpbin.org, each tagged ?step=N.
# Every line is <= 80 columns. httpbin echoes what it received, so the key swap shows.
B=https://httpbin.org/anything
req() { # req <n> <say> <curl args...>: a line before, the HTTP code after
  local n=$1 say=$2 out rc code body h
  shift 2
  echo "agent: $say"
  out=$(curl -m 120 -s -w '\n%{http_code}' "$@")
  rc=$?
  if ((rc != 0)); then echo "  -> curl failed ($rc)"; code=""; body=""
  else code=${out##*$'\n'}; body=${out%$'\n'*}; echo "  -> $code"; fi
  if [[ $n == 2 || $n == 4 ]]; then
    h=$(grep -o '"Authorization": "[^"]*"' <<<"$body" | head -1)
    if [[ -n $h ]]; then h=${h#*: \"}; echo "  httpbin got: ${h%\"}"
    else echo "  httpbin got: nothing (the request never left)"; fi
  fi
  sleep 3 # a pause so a viewer can read the caption for this step
}
J='Content-Type: application/json'
sleep 3 # a real agent thinks before its first call
req 1 "search flights LHR-BCN" "$B/search?from=LHR&to=BCN&step=1"
req 2 "pay for the flight" -X POST "$B/v1/payment_intents?step=2" \
  -H "Authorization: Bearer $STRIPE_API_KEY" -H "$J" \
  -d '{"amount":41200,"currency":"gbp","description":"LHR-BCN"}'
req 3 "email the itinerary" -X POST "$B/send-email?step=3" -H "$J" \
  -d '{"to":"me@example.com","itinerary":"LHR-BCN 09:15, 412 GBP"}'
req 4 "pay again (unexpected)" -X POST "$B/v1/payment_intents?step=4" \
  -H "Authorization: Bearer $STRIPE_API_KEY" -H "$J" \
  -d '{"amount":41200,"currency":"gbp","description":"LHR-BCN again"}'
req 5 "upload trip notes" -X POST "$B/upload?step=5" -H "$J" \
  -d '{"notes":"seat 14A, window"}'
echo "agent: done"
exit 0
