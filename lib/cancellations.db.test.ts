// Real path: the email agent's own save tools against Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… ATHENA_DATA_KEY=<64 hex> npx tsx --test lib/cancellations.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) process.env.NETLIFY_DB_URL = url;

test("a cancellation email always comes through; every other field you set stays", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { AthenaWriter } = await import("../netlify/lib/connectors/runner");
  const { addBooking, createPurchase, createTrip, editBooking, getBooking, getPurchase } = await import("./trips");
  const { qRaw } = await import("./db");

  const collection = { id: "c1", name: "Email", recipe: "email-digest", connector_ids: [], label: "", source: "email-digest", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
  const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as never;
  const writer = new AthenaWriter(collection, "run-1", stats, new Date("2026-11-06T09:00:00Z"), "Europe/London");
  const email = (fields: Record<string, unknown>) => ({ quote: "Your booking has been cancelled.", confidence: 0.97, ...fields });

  // A booking you added, with your own seat and notes.
  const trip = await createTrip({ title: "Lisbon", starts_on: "2026-11-20", ends_on: "2026-11-23" });
  const mine = await addBooking({ trip_id: trip.id, kind: "flight", title: "TP 1351", provider: "TAP", reference: "XK7P2Q", start_local: "2026-11-20T09:40", start_tz: "Europe/London", start_city: "London", end_local: "2026-11-20T12:30", end_tz: "Europe/Lisbon", end_city: "Lisbon", seat: "14A", details: "Window, by the wing" });
  const id = mine.booking!.id;

  const out = JSON.parse(await writer.run("athena_trip_booking", email({ external_id: "msg-cancel-1", kind: "flight", status: "cancelled", title: "TAP flight TP1351", reference: "xk7p2q", start_local: "2026-11-20T07:10", start_tz: "Europe/London", seat: "22C", details: "Refund in 7 days", email_link: "https://mail.google.com/mail/u/0/#inbox/cancel1" })));
  assert.equal(out.id, id, "matched your booking by reference");
  const b = (await getBooking(id))!;
  assert.equal(b.status, "cancelled");
  assert.equal(b.source, "manual", "still yours");
  assert.equal(b.title, "TP 1351");
  assert.equal(b.seat, "14A");
  assert.equal(b.details, "Window, by the wing");
  assert.equal(b.provider, "TAP");
  assert.equal(b.reference, "XK7P2Q");
  assert.equal(b.start_tz, "Europe/London");
  assert.equal(b.starts_at, "2026-11-20T09:40:00.000Z", "your time stays");
  assert.equal(b.end_city, "Lisbon");
  assert.ok(b.cancelled_at, "says when an email cancelled it");
  assert.equal(b.cancel_email_link, "https://mail.google.com/mail/u/0/#inbox/cancel1", "and which email");
  const [raw] = await qRaw<{ cancel_email_link: string }>(`SELECT cancel_email_link FROM trip_bookings WHERE id = $1`, [id]);
  assert.match(raw.cancel_email_link, /^enc:v1:/, "sealed at rest");

  // An email booking whose status you set: the cancellation still comes through, your seat stays.
  const fromEmail = JSON.parse(await writer.run("athena_trip_booking", email({ external_id: "msg-hotel-1", kind: "hotel", title: "Memmo Alfama", reference: "HTL998", start_local: "2026-11-20", start_tz: "Europe/Lisbon", end_local: "2026-11-23", quote: "Your stay is confirmed." })));
  await editBooking(fromEmail.id, { status: "confirmed", seat: "Room 4" });
  await editBooking(fromEmail.id, { status: "changed" });
  await writer.run("athena_trip_booking", email({ external_id: "msg-hotel-2", kind: "hotel", status: "cancelled", title: "Memmo Alfama", reference: "HTL998", start_local: "2026-11-20", start_tz: "Europe/Lisbon", seat: "Room 9" }));
  const hotel = (await getBooking(fromEmail.id))!;
  assert.equal(hotel.status, "cancelled");
  assert.equal(hotel.seat, "Room 4");
  assert.ok(hotel.cancelled_at);

  // Setting it back yourself clears "Cancelled by email".
  await editBooking(id, { status: "confirmed" });
  const back = (await getBooking(id))!;
  assert.equal(back.status, "confirmed");
  assert.equal(back.cancelled_at, null);
  assert.equal(back.cancel_email_link, "");

  // An order you added, already delivered: a cancellation still comes through, shop and items stay.
  const { purchase } = await createPurchase({ retailer: "John Lewis", items: ["Lego set"], order_number: "JL-55120", ordered_on: "2026-11-02", status: "delivered" });
  await writer.run("athena_purchase", email({ external_id: "msg-order-1", retailer: "johnlewis.com", order_number: "jl55120", items: ["Something else"], status: "cancelled", status_at: "2026-11-05T10:00:00Z", detail: "Cancelled by the shop", email_link: "https://mail.google.com/mail/u/0/#inbox/cancel2" }));
  const p = (await getPurchase(purchase.id))!;
  assert.equal(p.status, "cancelled");
  assert.equal(p.retailer, "John Lewis");
  assert.deepEqual(p.items, ["Lego set"]);
  assert.equal(p.order_number, "JL-55120");
  const step = p.updates.find((u) => u.status === "cancelled");
  assert.equal(step?.email_link, "https://mail.google.com/mail/u/0/#inbox/cancel2", "the step links the email");
});
