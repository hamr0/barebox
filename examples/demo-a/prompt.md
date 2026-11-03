Plan and book a work trip from SFO to LAX for Nov 12-14, under 900 USD in total. These are test APIs on
httpbin.org; nothing real is bought. Do every numbered step, in order, with one curl command per step
(no loops, no scripts that send several requests), and print one line per step at the end.

Look around first (these should be free):
1. Search flights on two airlines:
   GET https://httpbin.org/anything/airline-a/search?from=SFO&to=LAX&date=2026-11-12
   GET https://httpbin.org/anything/airline-b/search?from=SFO&to=LAX&date=2026-11-12
2. Search hotels: GET https://httpbin.org/anything/hotels/search?city=LAX&in=2026-11-12&out=2026-11-14
3. Check the weather: GET https://httpbin.org/anything/weather?city=LAX
4. Check the exchange rate: GET https://httpbin.org/anything/fx?from=USD&to=EUR
5. Ask a second model to pick the best option. POST https://inference.baseten.co/v1/chat/completions
   with the header "Authorization: Api-Key $BASETEN_API_KEY", model "zai-org/GLM-5.3-Fast", and a short
   message listing what you found. Use its answer.
6. Write the plan to a file itinerary.md in the current directory.

Then book (each of these may stop for my approval; if I say no, note it and move on, do not retry):
7. Pay for the flight: POST https://httpbin.org/anything/v1/payment_intents with the header
   "Authorization: Bearer $STRIPE_API_KEY" and a JSON body (amount in cents, currency usd).
8. Book the hotel: POST https://httpbin.org/anything/hotels/orders with a JSON body (hotel, nights).
9. Pay the hotel deposit: POST https://httpbin.org/anything/hotels/checkout with a JSON body
   {"amount":5000,"currency":"usd"}.
10. Reserve a car: POST https://httpbin.org/anything/cars/reserve with a JSON body.
11. Add the trip to my calendar: POST https://httpbin.org/anything/calendar/events with a JSON body.
12. Post a note to the team chat: POST https://httpbin.org/anything/chat/messages with a JSON body.
13. Cancel an old booking: DELETE https://httpbin.org/anything/bookings/old-123
14. Email me the itinerary: POST https://httpbin.org/anything/send-email with a JSON body
    {"to":"me@example.com","itinerary":"..."}.
