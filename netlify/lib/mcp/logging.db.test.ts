// MCP logging (netlify/lib/mcp/logging.ts) through the real /mcp function on Postgres with every migration: an
// MCP client has no card to tap, so log_spending, log_health, log_day_entry and log_meter_reading save straight
// away. Health is laid over what was typed in for the day; a wrong field comes back in words the client can fix.
// Other tests share the database: this one works on a day of its own and takes out what it added.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/mcp/logging.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
const MASTER = "master-token-for-tests";
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.MCP_BEARER_TOKEN = MASTER;
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

async function tool(name: string, args: unknown): Promise<{ error: boolean; value: any }> {
  const mcp = (await import("../../functions/mcp")).default;
  const res = await mcp(
    new Request("https://athena.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${MASTER}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    {} as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const text = body.result.content[0].text;
  return body.result.isError ? { error: true, value: text } : { error: false, value: JSON.parse(text) };
}

test("MCP logs spending, health, a day's entry and a meter reading straight away", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw, getOwnerTimeZone } = await import("../../../lib/db");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { MANUAL_HEALTH, readSourceDay, replaceManualHealthDay, clearManualHealthDay } = await import("../../../lib/health");
  const { manualPayments, removeManualPayment } = await import("../../../lib/money");
  const { loadReadings, removeReading } = await import("../../../lib/meter-readings");
  const { removeManualEntry } = await import("../../../lib/days");
  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(), tz);
  const day = addDays(today, -5);
  // A run that stopped part-way leaves its entry, and a second "Perfect Days" would fold into it: start the day clean.
  await qRaw(`DELETE FROM day_entries WHERE source = 'manual' AND date = $1::date`, [day]);
  const healthBefore = await readSourceDay(day, MANUAL_HEALTH);
  await replaceManualHealthDay({ date: day, source: MANUAL_HEALTH, steps: 8400, weight_kg: 72.4 }, { tz });

  const spent = await tool("log_spending", { amount: "£4", what: "Coffee", category: "eating_out", date: day });
  assert.equal(spent.error, false, spent.value);
  assert.equal(spent.value.amount_minor, 400);
  assert.ok((await manualPayments(day, day)).payments.some((p) => p.id === spent.value.id && p.merchant === "Coffee"));

  const health = await tool("log_health", { sleep_hours: 7, workout: { type: "run", minutes: 28, km: 5 }, date: day });
  assert.equal(health.error, false, health.value);
  assert.deepEqual(health.value.kept, ["steps", "weight"]);
  assert.deepEqual(await readSourceDay(day, MANUAL_HEALTH), { sleep_minutes: 420, steps: 8400, weight_kg: 72.4, workouts: [{ type: "run", minutes: 28, distance_m: 5000 }] }, "only what was said changed");

  const watched = await tool("log_day_entry", { kind: "watched", title: "Perfect Days", date: day });
  assert.equal(watched.error, false, watched.value);
  assert.ok(watched.value.id);
  const [row] = await qRaw<{ date: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date FROM day_entries WHERE source = 'manual' AND id = $1`, [watched.value.id]);
  assert.equal(row?.date, day);

  const read = await tool("log_meter_reading", { fuel: "electricity", value: 12345, date: day });
  assert.equal(read.error, false, read.value);
  const mine = (await loadReadings()).find((r) => r.fuel === "electricity" && r.date === day && r.value === 12345);
  assert.ok(mine);

  // A field the client got wrong: its own words back, nothing saved.
  const bad = await tool("log_meter_reading", { fuel: "electricity", value: 1, unit: "m3", date: day });
  assert.deepEqual(bad, { error: true, value: "unit: an electricity meter reads in kWh" });
  const future = await tool("log_spending", { amount: "£4", date: addDays(today, 1) });
  assert.deepEqual(future, { error: true, value: "date: that day hasn't happened yet" });

  // Tidy up for the tests that share this database.
  await removeManualPayment(day, spent.value.id, { today, tz });
  if (watched.value.id) await removeManualEntry(watched.value.id);
  await removeReading(mine!.id, { tz });
  if (healthBefore) await replaceManualHealthDay({ ...healthBefore, date: day, source: MANUAL_HEALTH }, { tz });
  else await clearManualHealthDay(day, { tz });
});
