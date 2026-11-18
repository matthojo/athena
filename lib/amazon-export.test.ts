// Run: npx tsx --test lib/amazon-export.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AmazonExportError,
  batchMediaDays,
  batchOrders,
  bytesSource,
  findAmazonFiles,
  itemLabel,
  parseAmazonExport,
  readDay,
  readInstant,
  readMoney,
  sniff,
  splitShow,
} from "./amazon-export";
import { amazonEntries } from "./day-imports";

const dir = join(import.meta.dirname, "fixtures/amazon");
const zip = new Uint8Array(readFileSync(join(dir, "export.zip")));
const src = (p: string) => ({ name: p, text: readFileSync(join(dir, "src", p), "utf8") });
const OPTS = { tz: "Europe/London", today: "2026-11-08", locale: "en-GB" };

async function fromZip() {
  const found = await findAmazonFiles(bytesSource(zip));
  return { found, parsed: await parseAmazonExport(await Promise.all(found.map(async (f) => ({ name: f.name, kind: f.kind, text: await f.text() }))), OPTS) };
}

test("finds files by their columns, inside nested zips too, and skips the rest", async () => {
  const { found } = await fromZip();
  const kinds = Object.fromEntries(found.map((f) => [f.name.split("/").pop(), f.kind]));
  assert.deepEqual(kinds, {
    "Kindle.Finished.csv": "library",
    "Retail.OrderHistory.1.csv": "orders",
    "ViewingHistory.csv": "prime",
    "Audible.Listening.csv": "audible",
    "Retail.CustomerReturns.1.1.csv": "returns",
    "Kindle.Devices.ReadingSession.csv": "kindle",
    "Digital Items.csv": "digital",
  });
  assert.ok(found.some((f) => f.name === "Digital-Ordering.zip/Digital-Ordering.1/Digital Items.csv"), "nested zip path kept");
  assert.ok(!found.some((f) => /Addresses/.test(f.name)), "addresses never read");
});

test("sniff: renamed files still match; unrelated ones don't", () => {
  assert.equal(sniff(["order id", "order date", "product name", "order status"], "whatever.csv"), "orders");
  assert.equal(sniff(["OrderId", "Title", "DigitalOrderItemId"]), "digital");
  assert.equal(sniff(["Order ID", "Return Reason"]), "returns");
  assert.equal(sniff(["ASIN", "start_timestamp", "total_reading_millis"]), "kindle");
  assert.equal(sniff(["Start Date", "Event Duration Milliseconds", "Product Name"]), "audible");
  assert.equal(sniff(["Title", "Episode Name", "Playback Start Datetime (UTC)"]), "prime");
  assert.equal(sniff(["ASIN", "Product Name"]), "titles");
  assert.equal(sniff(["Address Line 1", "City"]), null);
  assert.equal(sniff(["Order ID", "Payment Method"]), null);
});

test("orders: items, prices, statuses, returns, cancelled, future left out", async () => {
  const { parsed } = await fromZip();
  const retail = parsed.orders.filter((o) => !o.digital);
  assert.deepEqual(
    retail.map((o) => [o.id, o.day, o.status]),
    [
      ["202-1111111-1111111", "2026-03-14", "returned"],
      ["202-2222222-2222222", "2026-04-02", "delivered"],
      ["202-3333333-3333333", "2026-05-21", "cancelled"],
      ["202-4444444-4444444", "2026-11-06", "dispatched"],
    ],
  );
  const kettle = retail[0];
  assert.equal(kettle.statusAt, "2026-03-25T12:00:00.000Z", "returned on the refund day");
  assert.deepEqual(kettle.items, [{ key: "B0KETTLE01", name: "Russell Hobbs Kettle, 1.7L", asin: "B0KETTLE01", quantity: 1, price: { amount: 24.99, currency: "GBP" }, returned: true }]);
  const two = retail[1];
  assert.equal(two.shippedOn, "2026-04-03");
  assert.deepEqual(two.items.map(itemLabel), ["2 × Merino Socks, Grey", "Enamel Camping Mug (returned)"]);
  assert.deepEqual(two.items[0].price, { amount: 17, currency: "GBP" });
  assert.equal(retail[2].day, "2026-05-21", "23:30 UTC in May is the next day in London");
  assert.equal(parsed.skipped.future, 1);
  assert.equal(parsed.counts.orders, 4);
  assert.equal(parsed.counts.returned, 2);
  // Never an address, card or tracking number.
  const s = JSON.stringify(parsed);
  for (const bad of ["Example Road", "Visa", "QQ123"]) assert.ok(!s.includes(bad), bad);
});

test("digital: paid items become orders; free ones are left out", async () => {
  const { parsed } = await fromZip();
  const d = parsed.orders.filter((o) => o.digital);
  assert.equal(d.length, 1);
  assert.equal(d[0].status, "delivered");
  assert.equal(d[0].items[0].name, "Tomorrow and Tomorrow and Tomorrow");
  assert.equal(parsed.skipped.free, 1);
});

test("Kindle: minutes per book per day, short sessions dropped, unnamed books counted", async () => {
  const { parsed } = await fromZip();
  const kindle = parsed.days.flatMap((d) => d.items.filter((x) => x.source === "kindle").map((x) => [d.day, x.minutes]));
  assert.deepEqual(kindle, [
    ["2026-02-02", 55],
    ["2026-02-04", 40],
  ]);
  assert.equal(parsed.skipped.untitled, 1);
  assert.equal(parsed.counts.kindleBooks, 1);
});

test("Audible: minutes, finished from position; Prime Video: shows and films, trailers dropped", async () => {
  const { parsed } = await fromZip();
  const audible = parsed.days.flatMap((d) => d.items.filter((x) => x.source === "audible").map((x) => [d.day, x.minutes]));
  assert.deepEqual(audible, [
    ["2026-06-10", 45],
    ["2026-06-11", 15],
  ]);
  assert.deepEqual(
    parsed.finished.map((f) => [f.source, f.title, f.day]),
    [
      ["kindle", "Tomorrow and Tomorrow and Tomorrow", "2026-02-20"],
      ["audible", "Project Hail Mary", "2026-06-11"],
    ],
  );
  const prime = parsed.days.flatMap((d) => d.items.filter((x) => x.source === "prime_video").map((x) => ({ day: d.day, ...x })));
  assert.equal(prime.length, 3);
  assert.deepEqual(prime[0], { day: "2026-07-01", source: "prime_video", key: "B0PRIME001", title: "The Boys", subtitle: "Season 2 · Proper Preparation and Planning", minutes: 55, show: true });
  assert.deepEqual(prime[2], { day: "2026-07-03", source: "prime_video", key: "B0PRIME004", title: "Knives Out", minutes: 120 });
  assert.equal(parsed.counts.primeTitles, 2);
  assert.deepEqual(parsed.range, { first: "2026-02-01", last: "2026-11-06" });
});

test("entries: stable ids, the title as group, minutes", async () => {
  const { parsed } = await fromZip();
  const day = parsed.days.find((d) => d.day === "2026-07-01")!;
  const e = amazonEntries(day);
  assert.deepEqual(e[0], {
    kind: "watched",
    source: "prime_video",
    external_id: "2026-07-01:B0PRIME001",
    title: "The Boys",
    subtitle: "Season 2 · Proper Preparation and Planning",
    group: "The Boys",
    minutes: 55,
  });
  const k = amazonEntries(parsed.days.find((d) => d.day === "2026-02-02")!)[0];
  assert.deepEqual(k, { kind: "read", source: "kindle", external_id: "2026-02-02:B0KINDLE01", title: "Tomorrow and Tomorrow and Tomorrow", subtitle: "Gabrielle Zevin", group: "Tomorrow and Tomorrow and Tomorrow", minutes: 55 });
  // The same export again gives the same ids.
  const again = (await fromZip()).parsed;
  assert.deepEqual(again.days.flatMap(amazonEntries).map((x) => x.external_id), parsed.days.flatMap(amazonEntries).map((x) => x.external_id));
});

test("loose files work without a zip, and parsing yields as it goes", async () => {
  let pauses = 0;
  const p = await parseAmazonExport([src("Retail.OrderHistory.1/Retail.OrderHistory.1.csv")], { ...OPTS, pause: async () => void pauses++ });
  assert.equal(p.counts.orders, 4);
  assert.ok(pauses >= 1);
  const empty = await parseAmazonExport([src("Retail.Addresses/Retail.Addresses.csv")], OPTS);
  assert.equal(empty.range, null);
});

test("not a zip", async () => {
  await assert.rejects(findAmazonFiles(bytesSource(new TextEncoder().encode("hello, not a zip at all"))), (e: unknown) => e instanceof AmazonExportError && e.reason === "not-zip");
});

test("money, dates and titles", () => {
  assert.deepEqual(readMoney("£12.99"), { amount: 12.99, currency: "GBP" });
  assert.deepEqual(readMoney("1,234.56", "usd"), { amount: 1234.56, currency: "USD" });
  assert.deepEqual(readMoney("12,99 €"), { amount: 12.99, currency: "EUR" });
  assert.deepEqual(readMoney("EUR 1.234,50"), { amount: 1234.5, currency: "EUR" });
  assert.equal(readMoney("Not Available"), undefined);
  assert.equal(readInstant("2026-03-14T09:12:00Z", "dmy")?.toISOString(), "2026-03-14T09:12:00.000Z");
  assert.equal(readInstant("2026-03-14 9:05:00", "dmy")?.toISOString(), "2026-03-14T09:05:00.000Z");
  assert.equal(readDay("14/03/2026", { tz: "Europe/London", order: "dmy" }), "2026-03-14");
  assert.equal(readDay("03/14/2026 10:00:00", { tz: "UTC", order: "mdy" }), "2026-03-14");
  assert.equal(readDay("nonsense", { tz: "UTC", order: "dmy" }), null);
  assert.deepEqual(splitShow("The Boys: Season 2"), { title: "The Boys", season: "Season 2" });
  assert.deepEqual(splitShow("Knives Out"), { title: "Knives Out" });
});

test("batches: orders by count, media by whole days", async () => {
  const { parsed } = await fromZip();
  assert.equal(batchOrders(parsed.orders, 2).length, 3);
  const b = batchMediaDays(parsed.days, 2);
  assert.ok(b.every((x) => x.length <= 2));
  assert.equal(b.flat().length, parsed.days.length);
});

test("csvInSteps reads like parseCsv, across slice edges", async () => {
  const { parseCsv } = await import("./netflix-csv");
  const { csvInSteps } = await import("./amazon-export");
  const text = '﻿a,b\r\n"x, ""y""",2\n"multi\nline",3\n\nlast,\n"q"tail,1\n,,\nend';
  for (const slice of [1, 2, 3, 7, 1000]) assert.deepEqual(await csvInSteps(text, async () => undefined, slice), parseCsv(text));
});
