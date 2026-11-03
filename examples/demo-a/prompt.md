Search for a flight from SFO to LAX under 300 USD, book it, and simulate the payment. Use these test APIs with curl:
1. Search: GET https://httpbin.org/anything/search?from=SFO&to=LAX&max=300
2. Pay: POST https://httpbin.org/anything/v1/payment_intents with the header
   "Authorization: Bearer $STRIPE_API_KEY" and a small JSON body (amount in cents, currency usd).
3. Email the itinerary: POST https://httpbin.org/anything/send-email with a JSON body
   {"to":"me@example.com","itinerary":"..."}.
Print a one-line result for each step when you are done.
