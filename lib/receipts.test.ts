/**
 * Ride and takeaway receipts (lib/receipts.ts, lib/receipts-save.ts):
 * parsing each service's email, dedupe by the receipt's id, and sealing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyText, dateIn, dishes, endName, foodEntry, foodPurchase, itemsOf, parseReceipt, rideEntry, serviceOf, stopsOf, timeIn, totalOf, type FoodOrder, type Ride } from "./receipts";
import { AMOUNTS_DOMAIN, AMOUNTS_SOURCE, RIDES_DOMAIN, RIDES_SOURCE, saveReceipt, type ReceiptStore } from "./receipts-save";
import { isSealed, openStrict } from "./data-box";
import type { EntryInput } from "./days";
import type { PurchaseInput } from "./trips";
import * as F from "./receipts.fixtures";

process.env.ATHENA_DATA_KEY ??= "33".repeat(32);

const TZ = "Europe/London";
const HOME = { id: "00000000-0000-4000-8000-0000000000a1", name: "Home", address: "12 Example Road, London N1 2AB" };
const ride = (e: F_Email) => parseReceipt(e, { tz: TZ }) as Ride;
const food = (e: F_Email) => parseReceipt(e, { tz: TZ }) as FoodOrder;
type F_Email = typeof F.UBER_RIDE;

// ---------- Parsing ----------

test("Uber ride: trip id, day, times, minutes, ends and fare", () => {
  const r = ride(F.UBER_RIDE);
  assert.equal(r.type, "ride");
  assert.equal(r.service, "uber");
  assert.equal(r.ref, "7c1e9a52-3f6b-4d1e-9a0a-5b7f2e8c1d40");
  assert.equal(r.day, "2026-11-05");
  assert.equal(r.start, "2026-11-05T21:40:00.000Z");
  assert.equal(r.end, "2026-11-05T22:02:00.000Z");
  assert.equal(r.minutes, 22);
  assert.equal(r.from, "12 Example Road, London N1 2AB, UK");
  assert.equal(r.to, "Covent Garden, London WC2E 9DD, UK");
  assert.deepEqual(r.amount, { minor: 1482, currency: "GBP" });
});

test("Bolt ride: a ride just before midnight, receipted after it, belongs to the day before", () => {
  const r = ride(F.BOLT_RIDE);
  assert.equal(r.service, "bolt");
  assert.equal(r.ref, "1849302281");
  assert.equal(r.day, "2026-11-07");
  assert.equal(r.start, "2026-11-07T23:39:00.000Z");
  assert.equal(r.minutes, 19);
  assert.equal(r.to, "Highbury Corner, London N5 1RA");
  assert.deepEqual(r.amount, { minor: 1240, currency: "GBP" });
});

test("Uber Eats (HTML): order id from the link, restaurant, dishes without prices, total", () => {
  const o = food(F.UBER_EATS);
  assert.equal(o.service, "ubereats");
  assert.equal(o.ref, "3f2b8a10-77c4-4e0e-b0ad-0c5f6f9e2d11");
  assert.equal(o.day, "2026-11-06");
  assert.equal(o.at, "2026-11-06T19:21:00.000Z");
  assert.equal(o.restaurant, "Dishoom Covent Garden");
  assert.deepEqual(o.items, ["Chicken Ruby", "Garlic Naan", "Mango Lassi"]);
  assert.equal(o.status, "delivered");
  assert.deepEqual(o.amount, { minor: 2430, currency: "GBP" }, "the last Total, not the subtotal or a fee");
});

test("Deliveroo: placed, on its way and delivered are one order moving along", () => {
  const placed = food(F.DELIVEROO_PLACED);
  assert.equal(placed.service, "deliveroo");
  assert.equal(placed.ref, "4821");
  assert.equal(placed.day, "2026-11-07");
  assert.equal(placed.at, "2026-11-07T18:12:00.000Z");
  assert.equal(placed.restaurant, "Rosa's Thai Angel");
  assert.deepEqual(placed.items, ["Pad Thai with Chicken", "Chicken Satay", "Jasmine Rice"]);
  assert.equal(placed.status, "ordered");
  assert.deepEqual(placed.amount, { minor: 3093, currency: "GBP" });
  const way = food(F.DELIVEROO_ON_ITS_WAY);
  assert.equal(way.status, "out_for_delivery");
  assert.equal(way.ref, "4821");
  assert.equal(way.restaurant, "Rosa's Thai Angel");
  assert.equal(way.amount, undefined);
  const done = food(F.DELIVEROO_DELIVERED);
  assert.equal(done.status, "delivered");
  assert.equal(done.day, "2026-11-07");
});

test("Just Eat: order number, restaurant, sizes left off the dishes", () => {
  const o = food(F.JUST_EAT);
  assert.equal(o.service, "justeat");
  assert.equal(o.ref, "1288345671");
  assert.equal(o.day, "2026-11-04");
  assert.equal(o.at, "2026-11-04T20:02:00.000Z");
  assert.equal(o.restaurant, "Mamma Mia Pizzeria");
  assert.deepEqual(o.items, ["Margherita", "Garlic Bread", "San Pellegrino Limonata"]);
  assert.deepEqual(o.amount, { minor: 1999, currency: "GBP" });
});

test("not receipts: a promotion, a forward from a friend, an unknown sender", () => {
  assert.equal(parseReceipt(F.UBER_PROMO, { tz: TZ }), null);
  assert.equal(parseReceipt(F.FRIEND_ABOUT_UBER, { tz: TZ }), null);
  assert.equal(serviceOf({ from: "Uber <noreply@uber.com.example.net>", subject: "", text: "" }), null);
  assert.equal(serviceOf({ from: "Bolt Food <food@bolt.eu>", subject: "Your Bolt Food order", text: "" }), null, "Bolt Food isn't one of the five");
});

test("helpers: dates, times, totals, stops and dishes", () => {
  assert.equal(dateIn("Thursday, 5 November 2026"), "2026-11-05");
  assert.equal(dateIn("November 5, 2026 at 9:40 PM"), "2026-11-05");
  assert.equal(timeIn("9:40 PM"), "21:40");
  assert.equal(timeIn("12:05 am"), "00:05");
  assert.equal(timeIn("no time here"), undefined);
  assert.deepEqual(totalOf("Subtotal £10.00\nTotal £12.50"), { minor: 1250, currency: "GBP" });
  assert.deepEqual(totalOf("Total €8,40"), { minor: 840, currency: "EUR" }, "a decimal comma");
  assert.deepEqual(totalOf("Total £1,204.50"), { minor: 120450, currency: "GBP" });
  assert.deepEqual(stopsOf("9:40 PM | Kings Cross, London\n10:05 PM | Home Lane, London"), [
    { time: "21:40", place: "Kings Cross, London" },
    { time: "22:05", place: "Home Lane, London" },
  ]);
  assert.deepEqual(itemsOf("1x Falafel Wrap £7.50\nService fee £1.00\n2 × Chips  £5.00"), ["Falafel Wrap", "Chips"]);
  assert.equal(dishes(["A"]), "A");
  assert.equal(dishes(["A", "B"]), "A and B");
  assert.equal(dishes(["A", "B", "C"]), "A and 2 more");
  assert.equal(dishes(["A", "B", "C", "D", "E"], 3), "A, B and 3 more");
  assert.match(bodyText("<p>Total&nbsp;&pound;5.00</p><br>Next"), /Total £5\.00\nNext/);
});

// ---------- What the day shows ----------

test("a ride's ends: a known Place by name, a named spot, never a street address", () => {
  assert.equal(endName("12 Example Road, London N1 2AB, UK", [HOME]), "Home");
  assert.equal(endName("12 Example Road, London N1 2AB, UK", []), null, "a house number keeps it off the day");
  assert.equal(endName("Sample Grove, London", []), null, "a street without a number too");
  assert.equal(endName("Covent Garden, London WC2E 9DD, UK", []), "Covent Garden");
  assert.equal(endName("12 Example Rd, London N12AB", [HOME]), "Home", "same postcode and street, written differently");
});

test("ride entry: from and to, time and minutes, no fare and no address", () => {
  const e = rideEntry(ride(F.UBER_RIDE), [HOME], TZ);
  assert.deepEqual(e, {
    kind: "other",
    source: "uber",
    external_id: "7c1e9a52-3f6b-4d1e-9a0a-5b7f2e8c1d40",
    title: "Home → Covent Garden",
    subtitle: "21:40 · 22 min",
    at: "2026-11-05T21:40:00.000Z",
    minutes: 22,
    group: "Rides",
  });
  assert.equal(rideEntry(ride(F.BOLT_RIDE), [], TZ).title, "Ride to Highbury Corner");
  for (const s of [JSON.stringify(e), JSON.stringify(rideEntry(ride(F.BOLT_RIDE), [], TZ))]) {
    assert.doesNotMatch(s, /£|14\.82|12\.40|Example Road|Sample Street|N1 2AB|E8 1AA/);
  }
});

test("takeaway entry and purchase: restaurant, time, dishes in short; no total", () => {
  const o = food(F.DELIVEROO_PLACED);
  const e = foodEntry(o, TZ)!;
  assert.equal(e.title, "Takeaway from Rosa's Thai Angel");
  assert.equal(e.subtitle, "18:12 · Pad Thai with Chicken and 2 more");
  assert.equal(e.group, "Takeaway");
  assert.equal(e.external_id, "2026-11-07:4821", "a short order number carries its day");
  const p = foodPurchase(o, F.DELIVEROO_PLACED);
  assert.equal(p.retailer, "Rosa's Thai Angel");
  assert.equal(p.order_number, "2026-11-07:4821");
  assert.equal(p.detail, "Through Deliveroo");
  assert.equal(p.status, "ordered");
  for (const s of [JSON.stringify(e), JSON.stringify(p)]) assert.doesNotMatch(s, /£|30\.93|26\.45|Example Road/);
});

// ---------- Saving: dedupe and sealing ----------

/** The database's behaviour in memory: entries by (source, external_id), purchases by order number, sealed rows by (domain, source, day). */
function memoryStore() {
  const entries = new Map<string, { date: string; entry: EntryInput }>();
  const purchases = new Map<string, { id: string; input: PurchaseInput; updates: string[] }>();
  const sealed = new Map<string, { label: string; ciphertext: string }>();
  const store: ReceiptStore = {
    places: async () => [HOME],
    writeEntries: async (items) => {
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const it of items) {
        const key = `${it.entry.source}:${it.entry.external_id}`;
        const prev = entries.get(key);
        if (!prev) created++;
        else if (JSON.stringify(prev.entry) !== JSON.stringify(it.entry)) updated++;
        else unchanged++;
        // An entry keeps the day it was first saved on.
        entries.set(key, { date: prev?.date ?? it.date, entry: it.entry });
      }
      return { created, updated, unchanged, skipped: 0, folded: 0, new_days: [], changed_days: [], outcomes: [] };
    },
    savePurchase: async (input) => {
      const key = `${input.retailer}:${input.order_number}`;
      const prev = purchases.get(key);
      const id = prev?.id ?? `p${purchases.size + 1}`;
      purchases.set(key, { id, input: { ...prev?.input, ...input, items: input.items?.length ? input.items : prev?.input.items }, updates: [...(prev?.updates ?? []), input.status] });
      return { action: prev ? "updated" : "created", purchase: { id, status: input.status } as never };
    },
    readSealed: async (domain, source, day) => sealed.get(`${domain}/${source}/${day}`)?.ciphertext ?? null,
    writeSealed: async (row) => {
      sealed.set(`${row.domain}/${row.source}/${row.day}`, { label: row.label, ciphertext: row.ciphertext });
    },
  };
  return { store, entries, purchases, sealed };
}

const save = (email: F_Email, m: ReturnType<typeof memoryStore>) => saveReceipt(email, { tz: TZ, source: "email-digest-personal", sourceRef: `email-digest-personal:${email.id}`, store: m.store });

test("the same receipt twice: one entry, one sealed amount, nothing new the second time", async () => {
  const m = memoryStore();
  const first = await save(F.UBER_RIDE, m);
  assert.equal(first.action, "saved");
  assert.deepEqual(first.entry, { title: "Home → Covent Garden", subtitle: "21:40 · 22 min", action: "created" });
  assert.deepEqual(first.sealed, { amount: "saved", places: "saved" });
  const again = await save(F.UBER_RIDE, m);
  assert.equal(again.entry?.action, "unchanged");
  assert.deepEqual(again.sealed, { amount: "unchanged", places: "unchanged" });
  assert.equal(m.entries.size, 1);
  assert.equal(m.sealed.size, 2);
});

test("a takeaway's three emails: one entry, one purchase moved to delivered, one amount", async () => {
  const m = memoryStore();
  await save(F.DELIVEROO_PLACED, m);
  await save(F.DELIVEROO_ON_ITS_WAY, m);
  const last = await save(F.DELIVEROO_DELIVERED, m);
  assert.equal(m.entries.size, 1);
  assert.equal(m.purchases.size, 1);
  const p = [...m.purchases.values()][0];
  assert.deepEqual(p.updates, ["ordered", "out_for_delivery", "delivered"]);
  assert.deepEqual(p.input.items, ["Pad Thai with Chicken", "Chicken Satay", "Jasmine Rice"], "a status email with no dishes keeps the order's");
  assert.equal(last.purchase?.status, "delivered");
  const entry = [...m.entries.values()][0];
  assert.equal(entry.entry.title, "Takeaway from Rosa's Thai Angel");
  assert.equal(entry.entry.subtitle, "18:12 · Pad Thai with Chicken and 2 more", "the later emails don't blank the dishes on the day");
  assert.equal(m.sealed.size, 1, "only the placed email has a total");
});

test("sealing: amounts and ride ends only in sealed rows, labels with no figure or place", async () => {
  const m = memoryStore();
  for (const e of [F.UBER_RIDE, F.BOLT_RIDE, F.UBER_EATS, F.DELIVEROO_PLACED, F.JUST_EAT]) await save(e, m);
  // Two receipts on 7 Nov (Bolt, Deliveroo) share that day's amounts row.
  const amounts = m.sealed.get(`${AMOUNTS_DOMAIN}/${AMOUNTS_SOURCE}/2026-11-07`)!;
  assert.ok(isSealed(amounts.ciphertext));
  assert.equal(amounts.label, "Receipts · 2026-11-07");
  assert.deepEqual(JSON.parse(openStrict(amounts.ciphertext)), {
    "bolt:1849302281": { service: "bolt", type: "ride", minor: 1240, currency: "GBP" },
    "deliveroo:2026-11-07:4821": { service: "deliveroo", type: "food", minor: 3093, currency: "GBP" },
  });
  const ends = JSON.parse(openStrict(m.sealed.get(`${RIDES_DOMAIN}/${RIDES_SOURCE}/2026-11-05`)!.ciphertext));
  assert.deepEqual(ends["uber:7c1e9a52-3f6b-4d1e-9a0a-5b7f2e8c1d40"], {
    service: "uber",
    from: "12 Example Road, London N1 2AB, UK",
    to: "Covent Garden, London WC2E 9DD, UK",
    from_place: HOME.id,
    start: "2026-11-05T21:40:00.000Z",
    end: "2026-11-05T22:02:00.000Z",
  });
  for (const row of m.sealed.values()) {
    assert.ok(isSealed(row.ciphertext));
    assert.doesNotMatch(row.ciphertext, /£|Example|Covent|1482|1240/);
    assert.doesNotMatch(row.label, /\d+\.\d{2}|£|\$|€|Road|Street|London/);
  }
  // Nothing readable carries a figure or an address.
  const readable = JSON.stringify([...m.entries.values(), ...[...m.purchases.values()].map((p) => p.input)]);
  assert.doesNotMatch(readable, /£|14\.82|12\.40|24\.30|30\.93|19\.99|Example Road|Sample Street|Sample Grove|N1 2AB|E8 1AA/);
});

test("not a receipt: nothing is written", async () => {
  const m = memoryStore();
  const r = await save(F.UBER_PROMO, m);
  assert.equal(r.action, "not_a_receipt");
  assert.equal(m.entries.size + m.purchases.size + m.sealed.size, 0);
});
