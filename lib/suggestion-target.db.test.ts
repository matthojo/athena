// What an Inbox card would update (lib/suggestion-target-db.ts), against Postgres with every migration applied:
// a delivery email for an order already saved names that order and where it's got to, as does a booking with a
// saved reference and a detail with a saved value; anything new names nothing.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/suggestion-target.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

test("an Inbox find names the saved order, booking or detail it would update", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { propose, addFact } = await import("./memory");
  const { upsertPerson } = await import("./db");
  const { savePurchase, saveBooking } = await import("./trips");
  const { withTargets } = await import("./suggestion-target-db");
  const tag = `target-test-${Date.now()}`;
  const order = `ORD-${Date.now()}`;
  const ref = `REF${Date.now()}`;
  const person = await upsertPerson({ name: `${tag} Ada` });
  try {
    const saved = await savePurchase({ retailer: "Larkspur Home", order_number: order, items: ["Desk organiser"], status: "dispatched", source: tag });
    const booked = await saveBooking({ kind: "train", title: "York to Leeds", reference: ref, start_local: "2026-12-12T07:05", start_tz: "Europe/London", source: tag });
    await addFact({ subject_kind: "person", subject_id: person.id, key: "Moving", value: "To Lisbon", source: tag });

    const file = (op: "purchase" | "booking" | "fact", n: number, payload: Record<string, unknown>) =>
      propose({ op, summary: `${tag} ${op} ${n}`, payload, source: tag, source_ref: `${tag}:${n}` });
    const finds = [
      await file("purchase", 1, { retailer: "Larkspur Home", order_number: order.toLowerCase(), status: "delivered" }),
      await file("purchase", 2, { retailer: "Larkspur Home", order_number: `${order}-9`, status: "ordered" }),
      await file("booking", 3, { kind: "train", title: "York to Leeds", reference: ref, start_local: "2026-12-12T08:05", start_tz: "Europe/London" }),
      await file("booking", 4, { kind: "train", title: "Leeds to York", reference: `${ref}X`, start_local: "2026-12-14T17:00", start_tz: "Europe/London" }),
      await file("fact", 5, { subject_kind: "person", subject_id: person.id, key: "moving", value: "To Porto" }),
      // The same value as saved: accepting changes nothing, so it's not an update.
      await file("fact", 6, { subject_kind: "person", subject_id: person.id, key: "Moving", value: "to lisbon" }),
    ];
    const [moved, newOrder, rebooked, newBooking, replaced, same] = await withTargets(finds);
    assert.deepEqual(moved.existing, { id: saved.purchase!.id, status: "dispatched" });
    assert.equal(newOrder.existing, null);
    assert.deepEqual(rebooked.existing, { id: booked.booking!.id, name: "York to Leeds", status: "confirmed" });
    assert.equal(newBooking.existing, null);
    assert.equal(replaced.existing?.value, "To Lisbon");
    assert.equal(same.existing, null);

    // The Inbox's list carries it.
    const api = (await import("../netlify/functions/api")).default;
    const res = await api(new Request("https://athena.test/api/suggestions", { headers: { Authorization: "Bearer master-token-for-tests" } }), {} as never);
    const listed = ((await res.json()) as { items: Array<{ id: string; existing?: unknown }> }).items.find((s) => s.id === moved.id);
    assert.deepEqual(listed?.existing, { id: saved.purchase!.id, status: "dispatched" });
  } finally {
    await qRaw(`DELETE FROM suggestions WHERE source = $1`, [tag]);
    await qRaw(`DELETE FROM purchases WHERE source = $1`, [tag]);
    await qRaw(`DELETE FROM trips WHERE id IN (SELECT trip_id FROM trip_bookings WHERE source = $1)`, [tag]);
    await qRaw(`DELETE FROM facts WHERE source = $1`, [tag]);
    await qRaw(`DELETE FROM people WHERE id = $1`, [person.id]);
  }
});
