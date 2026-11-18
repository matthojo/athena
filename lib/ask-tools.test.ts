// Ask's shared read tools (lib/ask-tools.ts): the pure parts. The queries and citations against a real
// database are in ask-tools.db.test.ts.
// Run: npx tsx --test lib/ask-tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPayments, healthAverages, healthDayText, matches, rangeOf, READ_TOOL_NAMES, READ_TOOLS, searchPayments } from "./ask-tools";
import { TOOLS } from "./assistant";

const days = new Map([
  ["2026-10-03", { currency: "GBP", payments: [{ merchant: "Tesco Express", time: "08:10", amount: 425, category: "groceries" as const }, { merchant: "Pret A Manger", time: "12:30", amount: 650, category: "eating_out" as const }] }],
  ["2026-10-17", { currency: "GBP", payments: [{ merchant: "TESCO STORES 2041", time: "18:02", amount: 5_230, category: "groceries" as const }] }],
  ["2026-11-02", { currency: "GBP", payments: [{ merchant: "Tesco", time: "19:00", amount: 1_200, category: "groceries" as const }, { merchant: "Netflix", time: "03:00", amount: 1_099, category: "entertainment" as const, kind: "debit" as const }] }],
]);

test("money: merchant matches part of the name, any case; totals cover every match", () => {
  const r = searchPayments(days, { merchant: "tesco" });
  assert.deepEqual(r.payments.map((p) => p.date), ["2026-10-03", "2026-10-17", "2026-11-02"]);
  assert.equal(r.total, 425 + 5_230 + 1_200);
  assert.equal(r.currency, "GBP");
  assert.equal(searchPayments(days, { merchant: "tesco stores" }).payments.length, 1);
});

test("money: category and an amount range in pounds narrow it", () => {
  assert.deepEqual(searchPayments(days, { category: "eating_out" }).payments.map((p) => p.merchant), ["Pret A Manger"]);
  assert.deepEqual(searchPayments(days, { min: 10, max: 20 }).payments.map((p) => p.merchant), ["Tesco", "Netflix"]);
  assert.equal(searchPayments(days, { merchant: "waitrose" }).payments.length, 0);
});

test("money: grouped by merchant (most first), category, month and day (in date order)", () => {
  const all = searchPayments(days, {}).payments;
  assert.deepEqual(groupPayments(all, "month"), [
    { key: "2026-10", total: 425 + 650 + 5_230, count: 3 },
    { key: "2026-11", total: 1_200 + 1_099, count: 2 },
  ]);
  assert.equal(groupPayments(all, "merchant")[0].key, "TESCO STORES 2041");
  assert.equal(groupPayments(all, "category")[0].key, "groceries");
  assert.deepEqual(groupPayments(all, "day").map((g) => g.key), ["2026-10-03", "2026-10-17", "2026-11-02"]);
});

test("ranges: defaults count back from today; backwards and too long are refused", () => {
  assert.deepEqual(rangeOf({}, "2026-11-09", 6), { from: "2026-11-03", to: "2026-11-09" });
  assert.deepEqual(rangeOf({ from: "2026-10-01", to: "2026-10-31" }, "2026-11-09", 6), { from: "2026-10-01", to: "2026-10-31" });
  assert.throws(() => rangeOf({ from: "2026-11-09", to: "2026-11-01" }, "2026-11-09", 6), /on or after/);
  assert.throws(() => rangeOf({ from: "2026-01-01", to: "2026-11-09" }, "2026-11-09", 6), /At most 92 days/);
  assert.doesNotThrow(() => rangeOf({ from: "2026-01-01", to: "2026-11-09" }, "2026-11-09", 6, 400));
});

test("matches: every word, accents and case folded", () => {
  assert.ok(matches("caffe nero", "Caffè Nero"));
  assert.ok(matches("CAFE NERO", "Café Nero"));
  assert.ok(!matches("cafe costa", "Café Nero"));
  assert.ok(matches("café", "Cafe Rouge"));
  assert.ok(matches(undefined, "anything"));
  assert.ok(matches("lisbon tap", "Lisbon", "TAP Air Portugal"));
});

test("health: a day in words, and averages over the figures some day has", () => {
  const d = { date: "2026-11-08", sleep_minutes: 452, sleep_stages: { deep: 84 }, steps: 9_210, resting_hr: 52, recovery: 71, workouts: [{ type: "Running", minutes: 31, distance_m: 5_020 }] };
  assert.deepEqual(healthDayText(d), { date: "2026-11-08", sleep: "7h 32m", deep_sleep: "1h 24m", steps: 9_210, resting_hr: 52, recovery: "71%", workouts: ["5k run"] });
  const avg = healthAverages([d, { sleep_minutes: 400, steps: 5_000 }, { weight_kg: 72.4 }]);
  assert.equal(avg.sleep, "7h 6m");
  assert.equal(avg.nights, 2);
  assert.equal(avg.steps, 7_105);
  assert.equal(avg.latest_weight_kg, 72.4);
  assert.equal(avg.workouts, 1);
  assert.deepEqual(healthAverages([]), { workouts: 0 });
});

test("one set: both back ends offer every read tool, with no name twice", () => {
  const names = READ_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["goals", "trips", "purchases", "habits", "days", "health", "places", "patterns", "taste", "money", "energy", "appliances", "weather", "work", "regular_payments", "tracker_history"]);
  for (const n of names) assert.ok(TOOLS.some((t) => t.name === n), `assistant lacks ${n}`);
  const all = TOOLS.map((t) => t.name);
  assert.equal(new Set(all).size, all.length);
  assert.equal(READ_TOOL_NAMES.size, names.length);
});

test("Let Ask read transactions off: the money tools aren't offered, and a call to one reads nothing", async () => {
  const { readToolsFor, ReadTools, MONEY_TOOL_NAMES, isSpendingQuestion } = await import("./ask-tools");
  const off = readToolsFor({ money: false }).map((t) => t.name);
  assert.ok(!off.includes("money") && !off.includes("regular_payments"));
  assert.deepEqual(off, READ_TOOLS.map((t) => t.name).filter((n) => !MONEY_TOOL_NAMES.has(n)));
  assert.ok(readToolsFor({ money: true }).some((t) => t.name === "money"));
  assert.ok(off.includes("energy"), "energy use isn't bank data: offered with the switch off");
  // Refused before any read: no database here, so a read would fail differently.
  const tools = new ReadTools({ cite: () => "", tz: "Europe/London" });
  await assert.rejects(tools.run("money", { merchant: "tesco" }), /Money search is off/);
  await assert.rejects(tools.run("regular_payments", {}), /Money search is off/);
  for (const q of ["How much did I spend at Tesco last month?", "what did I pay for the train", "my Monzo transactions this week", "list my subscriptions", "What did I spend on takeaways?"]) assert.ok(isSpendingQuestion(q), q);
  for (const q of ["When does my Amazon order arrive?", "How did I sleep this week?", "What did Gayle say about pricing?", "Am I free after lunch?"]) assert.ok(!isSpendingQuestion(q), q);
});

test("footer words: every read tool and find_recipes say what was searched", async () => {
  const { READ_SEARCHED } = await import("./ask-tools");
  for (const t of READ_TOOLS) assert.ok(READ_SEARCHED[t.name], `${t.name} has footer words`);
  assert.equal(READ_SEARCHED.money, "your transactions");
  assert.equal(READ_SEARCHED.taste, "your films, shows and music");
  assert.equal(READ_SEARCHED.find_recipes, "your recipes");
});
