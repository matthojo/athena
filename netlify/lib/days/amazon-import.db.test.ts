// Real path for the Amazon export import: /api/days/import/amazon through handleImportRoutes, savePurchase,
// importToDays, watch-read-sync and archive, on Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days/amazon-import.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties purchases, Days, Watch & read and finance rows first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const fixtures = join(import.meta.dirname, "../../../lib/fixtures/amazon");

const setup = async () => {
  const { handleImportRoutes } = await import("./import-routes");
  const { qRaw, q } = await import("../../../lib/db");
  for (const t of ["purchase_updates", "purchases", "custom_values", "reading_items", "day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'finance'`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const call = async (method: string, body?: unknown) => {
    const u = new URL("https://athena.test/api/days/import/amazon");
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleImportRoutes(req, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s })))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  return { call, qRaw, q };
};

test("Amazon export: orders, returns, prices encrypted, Days, Watch & read, idempotent, Undo", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { call, qRaw, q } = await setup();
  const { bytesSource, findAmazonFiles, parseAmazonExport, batchMediaDays } = await import("../../../lib/amazon-export");
  const { savePurchase, listPurchases } = await import("../../../lib/trips");
  const { openStrict } = await import("../../../lib/data-box");

  const found = await findAmazonFiles(bytesSource(new Uint8Array(readFileSync(join(fixtures, "export.zip")))));
  const x = await parseAmazonExport(await Promise.all(found.map(async (f) => ({ name: f.name, kind: f.kind, text: await f.text() }))), { tz: "Europe/London", today: "2026-11-08" });

  // The order-confirmation email already saved the socks order, with July 2026's placeholder name.
  await savePurchase({ retailer: "Amazon", order_number: "202-2222222-2222222", items: ["Household item"], status: "ordered", status_at: "2026-04-02T18:41:00Z", source: "collect:email", source_ref: "email-1" });

  const get = await call("GET");
  assert.equal(get.status, 200);
  assert.equal(get.json.last_import, null);

  const file = { items: 20, days: 10 };
  const orders = await call("POST", { part: "orders", orders: x.orders, file });
  assert.equal(orders.status, 200, JSON.stringify(orders.json));
  assert.equal(orders.json.created, 4, "kettle, lamp, paperback, digital book");
  assert.equal(orders.json.existing, 1, "the email's order");
  assert.equal(orders.json.ids.purchases.length, 4);
  assert.ok(orders.json.prices_sealed >= 4);

  const all = await listPurchases({ limit: 50 });
  const socks = all.find((p) => p.order_number === "202-2222222-2222222")!;
  assert.deepEqual(socks.items, ["Household item", "2 × Merino Socks, Grey", "Enamel Camping Mug (returned)"], "email's purchase gets the real names; the mug is marked");
  assert.equal(socks.status, "delivered");
  const kettle = all.find((p) => p.order_number === "202-1111111-1111111")!;
  assert.equal(kettle.status, "returned");
  assert.equal(kettle.source, "amazon_export");
  assert.equal(all.find((p) => p.order_number === "202-3333333-3333333")!.status, "cancelled");

  // Prices: never on a purchase, encrypted in one finance row per order day, label without an amount.
  const cols = await qRaw<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'purchases'`);
  assert.ok(!cols.some((c) => /price|amount|total/.test(c.column_name)));
  const fin = await qRaw<{ label: string; ciphertext: string; day: string }>(`SELECT label, ciphertext, to_char(day, 'YYYY-MM-DD') AS day FROM sensitive_blobs WHERE domain = 'finance' AND source = 'amazon' ORDER BY day`);
  assert.ok(fin.every((r) => r.ciphertext.startsWith("enc:v1:") && !/\d+\.\d{2}|£/.test(r.label)));
  const march = JSON.parse(openStrict(fin.find((r) => r.day === "2026-03-14")!.ciphertext));
  assert.deepEqual(march.orders["202-1111111-1111111"].items.B0KETTLE01, { name: "Russell Hobbs Kettle, 1.7L", quantity: 1, amount: 24.99, currency: "GBP", returned: true });

  // A re-import changes nothing and creates nothing.
  const again = await call("POST", { part: "orders", orders: x.orders, file });
  assert.equal(again.json.created, 0);
  assert.equal(again.json.ids.finance.length, 0);
  assert.deepEqual((await listPurchases({ limit: 50 })).find((p) => p.order_number === "202-2222222-2222222")!.items, socks.items);

  // Days.
  let media = { added: 0, entries: [] as Array<{ source: string; external_id: string }> };
  for (const b of batchMediaDays(x.days)) {
    const r = await call("POST", { part: "media", days: b, file });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    media.added += r.json.added;
    media.entries.push(...r.json.ids.entries);
  }
  assert.equal(media.added, 7, "2 Kindle days, 2 Audible days, 3 Prime Video");
  const rows = await q<{ kind: string; source: string; title: string; grp: string; minutes: number; date: string }>(
    `SELECT kind, source, title, grp, minutes, to_char(date, 'YYYY-MM-DD') AS date FROM day_entries WHERE archived_at IS NULL ORDER BY date, source`,
  );
  assert.deepEqual(rows.find((r) => r.source === "kindle" && r.date === "2026-02-02"), { kind: "read", source: "kindle", title: "Tomorrow and Tomorrow and Tomorrow", grp: "Tomorrow and Tomorrow and Tomorrow", minutes: 55, date: "2026-02-02" });
  assert.equal(rows.filter((r) => r.source === "prime_video" && r.kind === "watched").length, 3);
  assert.equal(rows.find((r) => r.source === "audible")!.kind, "listened");
  for (const b of batchMediaDays(x.days)) assert.equal((await call("POST", { part: "media", days: b, file })).json.added, 0, "same days again: nothing new");

  // Watch & read: finished books as read.
  const fin1 = await call("POST", { part: "finished", finished: x.finished });
  assert.equal(fin1.status, 200, JSON.stringify(fin1.json));
  assert.equal(fin1.json.created, 2);
  // Titles are encrypted at rest, so ORDER BY would sort ciphertext: sort after they're opened.
  const books = (await q<{ title: string; kind: string; status: string }>(`SELECT title, kind, status FROM reading_items WHERE archived_at IS NULL`)).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(books, [
    { title: "Project Hail Mary", kind: "book", status: "done" },
    { title: "Tomorrow and Tomorrow and Tomorrow", kind: "book", status: "done" },
  ]);
  assert.equal((await call("POST", { part: "finished", finished: x.finished })).json.created, 0);

  assert.equal((await call("GET")).json.last_import.items, 20, "the import is remembered for Sources");

  // Undo: what this import made goes away; the email's order stays, filled in.
  const undo = await call("POST", { part: "undo", entries: media.entries, purchases: orders.json.ids.purchases, watch_read: fin1.json.ids.watch_read, finance: orders.json.ids.finance });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.deepEqual(undo.json, { entries: 7, purchases: 4, watch_read: 2, finance: orders.json.ids.finance.length });
  const left = await listPurchases({ limit: 50 });
  assert.deepEqual(left.map((p) => p.order_number), ["202-2222222-2222222"]);
  assert.equal((await qRaw(`SELECT 1 FROM day_entries WHERE archived_at IS NULL`)).length, 0);
  assert.equal((await qRaw(`SELECT 1 FROM reading_items WHERE archived_at IS NULL`)).length, 0);

  // Bad input is refused.
  assert.equal((await call("POST", { part: "orders", orders: [{ id: "x", day: "2026-01-01" }] })).status, 400);
  assert.equal((await call("POST", { part: "nope" })).status, 400);
});
