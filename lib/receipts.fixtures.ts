/**
 * Receipt emails for lib/receipts.test.ts, written from each service's
 * current layout (late 2026) as Gmail hands them to a collection run.
 * Anonymised: the rider is "Alex", the driver "Sam" or "Maria", every
 * address, card, order and trip id is made up.
 */
import type { ReceiptEmail } from "./receipts";

/** Uber ride, plain text: a Thursday evening trip from a street address to Covent Garden. */
export const UBER_RIDE: ReceiptEmail = {
  id: "18c2f0a1b2c3d4e5",
  from: "Uber Receipts <noreply@uber.com>",
  subject: "Your Thursday evening trip with Uber",
  date: "2026-11-05T22:03:41Z",
  text: `Uber
Total £14.82
Thursday, 5 November 2026
Thanks for riding, Alex
We hope you enjoyed your ride this evening.
Total £14.82
Trip fare £12.31
Subtotal £12.31
Booking fee £2.51
Payments
Visa ••••1234
05/11/2026 22:03
£14.82
You rode with Sam
4.93 Rating
UberX   3.12 miles | 22 min
21:40
12 Example Road, London N1 2AB, UK
22:02
Covent Garden, London WC2E 9DD, UK
Report lost item › https://riders.uber.com/trips/7c1e9a52-3f6b-4d1e-9a0a-5b7f2e8c1d40
Uber London Limited, 1 Example Place, London`,
};

/** Bolt ride, plain text: just before midnight, receipted just after it. */
export const BOLT_RIDE: ReceiptEmail = {
  id: "18c3a9e0f1a2b3c4",
  from: "Bolt <receipts-uk@bolt.eu>",
  subject: "Your Bolt ride receipt",
  date: "2026-11-08T00:04:12Z",
  text: `Bolt
Thanks for riding with Bolt!
Total charged £12.40
Pickup
23:39 · 10 Sample Street, London E8 1AA
Drop-off
23:58 · Highbury Corner, London N5 1RA
Distance 4.1 km · Duration 19 min
Bolt
Driver: Maria · Toyota Prius Hybrid
Payment: Visa •••• 4242
Ride ID: 1849302281
Bolt Operations OÜ`,
};

/** Uber Eats order, as HTML (the receipt is a table layout). */
export const UBER_EATS: ReceiptEmail = {
  id: "18c2a7b6c5d4e3f2",
  from: "Uber Receipts <noreply@uber.com>",
  subject: "Your Friday evening order with Uber Eats",
  date: "2026-11-06T19:59:03Z",
  text: `<html><head><style>td{font-family:sans-serif}</style></head><body>
<table><tr><td>Uber Eats</td></tr>
<tr><td>Total</td><td>&pound;24.30</td></tr>
<tr><td>Friday, 6 November 2026</td></tr>
<tr><td><p>Thanks for ordering, Alex</p><p>Here&rsquo;s your receipt for Dishoom Covent Garden.</p></td></tr>
<tr><td>You ordered from Dishoom Covent Garden</td></tr>
<tr><td>1</td><td>Chicken Ruby</td><td>&pound;13.90</td></tr>
<tr><td>1</td><td>Garlic Naan</td><td>&pound;4.50</td></tr>
<tr><td>1</td><td>Mango Lassi</td><td>&pound;4.95</td></tr>
<tr><td>Subtotal</td><td>&pound;23.35</td></tr>
<tr><td>Delivery Fee</td><td>&pound;0.99</td></tr>
<tr><td>Service Fee</td><td>&pound;1.46</td></tr>
<tr><td>Promotion</td><td>-&pound;1.50</td></tr>
<tr><td>Total</td><td>&pound;24.30</td></tr>
<tr><td>Order placed 19:21</td></tr>
<tr><td>Delivered to 12 Example Road, London N1 2AB</td></tr>
<tr><td><a href="https://www.ubereats.com/orders/3f2b8a10-77c4-4e0e-b0ad-0c5f6f9e2d11">View order</a></td></tr>
</table></body></html>`,
};

/** Deliveroo: the order placed, then on its way, then delivered (three emails, one order). */
export const DELIVEROO_PLACED: ReceiptEmail = {
  id: "18c3b1c2d3e4f5a6",
  from: "Deliveroo <noreply@t.deliveroo.co.uk>",
  subject: "Your order's been placed",
  date: "2026-11-07T18:12:30Z",
  text: `Deliveroo
Thanks for your order, Alex. Rosa's Thai Angel has your order.
Order number: 4821
Order placed: 7 November 2026, 18:12
Your order
1x Pad Thai with Chicken £11.95
1x Chicken Satay £7.50
2x Jasmine Rice £7.00
Subtotal £26.45
Delivery fee £2.49
Service fee £1.99
Total £30.93
Paid with Apple Pay
Delivering to: 12 Example Road, London N1 2AB`,
};

export const DELIVEROO_ON_ITS_WAY: ReceiptEmail = {
  id: "18c3b1c2d3e4f5a6",
  from: "Deliveroo <noreply@t.deliveroo.co.uk>",
  subject: "Your order is on its way",
  date: "2026-11-07T18:38:02Z",
  text: `Deliveroo
Good news, your rider is heading your way with your order from Rosa's Thai Angel.
Order number: 4821
Order placed: 7 November 2026, 18:12
Estimated arrival 18:50`,
};

export const DELIVEROO_DELIVERED: ReceiptEmail = {
  id: "18c3b1c2d3e4f5a6",
  from: "Deliveroo <noreply@t.deliveroo.co.uk>",
  subject: "Your order has been delivered",
  date: "2026-11-07T18:49:44Z",
  text: `Deliveroo
Enjoy your meal! Your order from Rosa's Thai Angel was delivered at 18:49.
Order number: 4821
Order placed: 7 November 2026, 18:12
Rate your order`,
};

/** Just Eat order confirmation. */
export const JUST_EAT: ReceiptEmail = {
  id: "18c39a8b7c6d5e4f",
  from: "Just Eat <orders@t.just-eat.co.uk>",
  subject: "Order confirmation from Mamma Mia Pizzeria",
  date: "2026-11-04T20:02:51Z",
  text: `Just Eat
Thanks for your order, Alex!
Mamma Mia Pizzeria has received your order.
Order number: 1288345671
Placed at 20:02 on 4 November 2026
Estimated delivery: 20:40 - 20:55
1 x Margherita (12")  £10.50
1 x Garlic Bread  £4.20
1 x San Pellegrino Limonata  £1.80
Delivery fee  £2.50
Service charge  £0.99
Total  £19.99
Paid by card
Delivering to: Flat 3, 8 Sample Grove, London N4 3AB`,
};

/** Not receipts: an Uber promotion, and an email from someone else that talks about Uber. */
export const UBER_PROMO: ReceiptEmail = {
  id: "18c1f0e0d0c0b0a0",
  from: "Uber <uber@uber.com>",
  subject: "50% off your next 3 rides this weekend",
  date: "2026-11-03T09:00:00Z",
  text: `Uber
Weekend plans? Get 50% off your next 3 rides, up to £5 off each.
Terms apply. Unsubscribe`,
};

export const FRIEND_ABOUT_UBER: ReceiptEmail = {
  id: "18c1f0e0d0c0b0a1",
  from: "Jo <jo@example.com>",
  subject: "Fwd: Your Thursday evening trip with Uber",
  date: "2026-11-05T23:00:00Z",
  text: UBER_RIDE.text,
};
