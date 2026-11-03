Book me a flight from LHR to BCN under 450 GBP. Use these APIs with curl:
1. Search: GET https://httpbin.org/anything/search?from=LHR&to=BCN&max=450
2. Pay: POST https://httpbin.org/anything/v1/payment_intents with the header
   "Authorization: Bearer $STRIPE_API_KEY" and a small JSON body (amount in pence, currency gbp).
3. Email the itinerary: POST https://httpbin.org/anything/send-email with a JSON body
   {"to":"me@example.com","itinerary":"..."}.
Print a one-line result for each step when you are done.
