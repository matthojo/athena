// Adding things by hand, through the real /api function and Postgres with every migration: spending, health,
// a day's entries and meter readings, each for someone with no connector, and each read back where a connector's would be.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/life/manual-entry.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Manual entry: spending, health, day entries and meter readings without any connector", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { getOwnerTimeZone } = await import("../../../lib/db");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  await qRaw(`DELETE FROM sensitive_blobs WHERE source IN ('manual', 'readings')`);
  await qRaw(`DELETE FROM day_entries WHERE source = 'manual'`);
  const today = zonedToday(new Date(), await getOwnerTimeZone());
  const yesterday = addDays(today, -1);

  // ---- Spending ----
  // Other tests share this database and may leave a bank's days: count what's added on top.
  const spentIn = async () => (await call("GET", "/life/money")).json.months.find((m: { month: string }) => m.month === yesterday.slice(0, 7))?.spent ?? 0;
  const spentBefore = await spentIn();
  const added = await call("POST", "/life/spending", { date: yesterday, amount: 450, category: "eating_out", merchant: "Coffee" });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.amount, 450);
  const second = await call("POST", "/life/spending", { date: yesterday, amount: 2000, category: "groceries", merchant: "Market" });
  assert.equal(second.status, 201);
  assert.equal((await call("POST", "/life/spending", { amount: -1 })).status, 400);
  const listed = await call("GET", "/life/spending");
  assert.deepEqual(listed.json.payments.map((p: { merchant: string }) => p.merchant).sort(), ["Coffee", "Market"]);
  const months = await call("GET", "/life/money");
  const month = months.json.months.find((m: { month: string }) => m.month === yesterday.slice(0, 7));
  assert.equal(month.spent - spentBefore, 2450);
  assert.ok(month.merchants.some((m: { name: string }) => m.name === "Coffee"));
  // Sealed like a bank's day: the label carries no amount or merchant.
  const [row] = await qRaw<{ label: string; ciphertext: string }>(`SELECT label, ciphertext FROM sensitive_blobs WHERE domain = 'money' AND source = 'manual'`);
  assert.match(row.ciphertext, /^enc:v1:/);
  assert.doesNotMatch(row.label, /Coffee|4\.50|£/);
  assert.equal((await call("DELETE", `/life/spending?date=${yesterday}&id=${added.json.id}`)).status, 200);
  assert.equal((await call("DELETE", `/life/spending?date=${yesterday}&id=${added.json.id}`)).status, 404);
  assert.equal((await call("GET", "/life/spending")).json.payments.length, 1);

  // ---- Health ----
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND day = $1::date`, [yesterday]);
  const { saveHealthDay } = await import("../../../lib/health");
  await saveHealthDay({ date: yesterday, source: "apple_health", steps: 8000, sleep_minutes: 400 });
  const put = await call("PUT", "/health/manual", { date: yesterday, sleep_minutes: 480, weight_kg: 72.4 });
  assert.equal(put.status, 200, put.text);
  let days = (await call("GET", `/health/days?from=${yesterday}&to=${yesterday}`)).json.days;
  assert.equal(days[0].sleep_minutes, 480, "what's typed in wins");
  assert.equal(days[0].steps, 8000, "the app fills the rest");
  assert.equal(days[0].weight_kg, 72.4);
  // Replaced whole: a figure left out is gone.
  await call("PUT", "/health/manual", { date: yesterday, weight_kg: 72.1 });
  assert.deepEqual((await call("GET", `/health/manual?date=${yesterday}`)).json.figures, { weight_kg: 72.1 });
  assert.equal((await call("DELETE", `/health/manual?date=${yesterday}`)).status, 200);
  days = (await call("GET", `/health/days?from=${yesterday}&to=${yesterday}`)).json.days;
  assert.equal(days[0].sleep_minutes, 400);
  assert.equal(days[0].weight_kg, undefined);

  // ---- A day's entries ----
  const entry = await call("POST", `/days/${yesterday}/entries`, { kind: "watched", title: "Perfect Days", subtitle: "2023", minutes: 124 });
  assert.equal(entry.status, 201, entry.text);
  assert.ok(entry.json.id);
  assert.equal((await call("POST", `/days/${yesterday}/entries`, { kind: "habit", title: "x" })).status, 400);
  assert.equal((await call("POST", `/days/${addDays(today, 2)}/entries`, { kind: "read", title: "x" })).status, 400);
  const day = (await call("GET", `/days/${yesterday}`)).json;
  const mine = day.entries.find((e: { id: string }) => e.id === entry.json.id);
  assert.equal(mine.title, "Perfect Days");
  assert.equal(mine.source, "manual");
  assert.equal((await call("DELETE", `/days/${yesterday}/entries/${entry.json.id}`)).status, 200);
  assert.ok(!(await call("GET", `/days/${yesterday}`)).json.entries.some((e: { id: string }) => e.id === entry.json.id));

  // ---- Meter readings ----
  const r1 = await call("POST", "/life/readings", { fuel: "electricity", date: addDays(today, -10), value: 1000 });
  assert.equal(r1.status, 201, r1.text);
  const r2 = await call("POST", "/life/readings", { fuel: "electricity", date: today, value: 1080 });
  assert.equal(r2.json.readings.length, 2);
  assert.equal((await call("POST", "/life/readings", { fuel: "electricity", value: 1, unit: "m3" })).status, 400);
  const house = (await call("GET", "/life/house")).json;
  assert.equal(house.readings.length, 2);
  // The typed days themselves: ten days at 8 kWh.
  const { openStrict } = await import("../../../lib/data-box");
  const typed = await qRaw<{ day: string; ciphertext: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, ciphertext FROM sensitive_blobs WHERE domain = 'home' AND source = 'manual' ORDER BY day`);
  assert.equal(typed.length, 10);
  assert.deepEqual(JSON.parse(openStrict(typed[typed.length - 1].ciphertext)), { kwh: 8 });
  // Another test in this database may have left a smart meter, whose days win; with none, the page is the readings'.
  // A meter account, or a meter's days left behind without one, both win over the typed days.
  const [{ meters }] = await qRaw<{ meters: string }>(
    `SELECT (SELECT count(*) FROM connectors WHERE provider = 'octopus') + (SELECT count(*) FROM sensitive_blobs WHERE domain = 'home' AND day IS NOT NULL AND source NOT IN ('manual', 'readings', 'tariff')) AS meters`,
  );
  if (Number(meters) === 0) {
    assert.equal(house.meter_account, false);
    const point = house.energy.daily.find((p: { date: string }) => p.date === yesterday);
    assert.equal(point.kwh, 8);
  }
  // Taking one out takes its days with it.
  const removed = await call("DELETE", `/life/readings?id=${r2.json.readings[0].id}`);
  assert.equal(removed.json.readings.length, 1);
  const [{ n }] = await qRaw<{ n: string }>(`SELECT count(*) AS n FROM sensitive_blobs WHERE domain = 'home' AND source = 'manual'`);
  assert.equal(Number(n), 0);
  if (Number(meters) === 0) assert.equal((await call("GET", "/life/house")).json.energy, null);
});
