// Logging from a sentence (lib/ask-logging.ts, lib/assistant-logging.ts): the fields a tool gets, read into
// the cards the owner confirms, what each card says, and that Ask's tools only prepare one. No database.
// Run: npx tsx --test lib/ask-logging.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryCard, healthCard, LogInputError, logWords, mergeHealth, readLoggedHealth, readSpendAmount, readingCard, spendingCard } from "./ask-logging";
import { confirmWords, type ConfirmCard } from "./assistant-confirm";
import { isSpendingLog } from "./ask-tools";

const today = "2026-11-14";

test("an amount as said: symbol, pence, a bare number", () => {
  assert.deepEqual(readSpendAmount("£4"), { amount: 400, currency: "GBP" });
  assert.deepEqual(readSpendAmount("4.50"), { amount: 450, currency: "GBP" });
  assert.deepEqual(readSpendAmount("€12,50"), { amount: 1250, currency: "EUR" });
  assert.deepEqual(readSpendAmount("$3"), { amount: 300, currency: "USD" });
  assert.deepEqual(readSpendAmount("1,200"), { amount: 120000, currency: "GBP" });
  assert.deepEqual(readSpendAmount(4), { amount: 400, currency: "GBP" });
  assert.deepEqual(readSpendAmount("12", "usd"), { amount: 1200, currency: "USD" });
  for (const bad of ["", "free", "£0", "-4", "£2,000,000"]) assert.throws(() => readSpendAmount(bad), LogInputError, bad);
  assert.throws(() => readSpendAmount("4", "pounds"), /currency/);
});

test("spending: today and other unless said, never ahead of today", () => {
  assert.deepEqual(spendingCard({ amount: "£4", what: "Coffee", category: "eating_out" }, { today }), { kind: "log_spending", date: today, amount: 400, currency: "GBP", category: "eating_out", merchant: "Coffee" });
  assert.deepEqual(spendingCard({ amount: "32", date: "2026-11-13" }, { today }), { kind: "log_spending", date: "2026-11-13", amount: 3200, currency: "GBP", category: "general" });
  assert.throws(() => spendingCard({ amount: "£4", date: "2026-11-15" }, { today }), /hasn't happened/);
  assert.throws(() => spendingCard({ amount: "£4", category: "coffee" }, { today }), /category/);
  assert.throws(() => spendingCard({ amount: "£4", date: "14/11/2026" }, { today }), /YYYY-MM-DD/);
});

test("health in the words people use becomes the figures Athena keeps", () => {
  assert.deepEqual(readLoggedHealth({ sleep_hours: 7 }), { sleep_minutes: 420 });
  assert.deepEqual(readLoggedHealth({ sleep_hours: 7.5, steps: "9,200", coffees: 3, water_litres: 1.5 }), { sleep_minutes: 450, steps: 9200, water_ml: 1500, caffeine_mg: 285 });
  assert.deepEqual(readLoggedHealth({ workout: { type: "Run", minutes: 28, km: 5 } }), { workouts: [{ type: "run", minutes: 28, distance_m: 5000 }] });
  assert.deepEqual(readLoggedHealth({ weight_kg: 72.44, alcohol_drinks: 2 }), { weight_kg: 72.4, alcohol_drinks: 2 });
  assert.throws(() => readLoggedHealth({}), /at least one figure/);
  assert.throws(() => readLoggedHealth({ sleep_hours: 30 }), /sleep_hours: between 0 and 24/);
  assert.throws(() => readLoggedHealth({ resting_hr: 5 }), /resting_hr/);
  assert.throws(() => readLoggedHealth({ workout: { type: "run" } }), /workout.minutes/);
});

test("health is laid over what was typed in: only what was said changes", () => {
  const before = { sleep_minutes: 360, steps: 8400, weight_kg: 72.4, workouts: [{ type: "walk", minutes: 40 }] };
  const merged = mergeHealth(before, { sleep_minutes: 420, workouts: [{ type: "run", minutes: 28, distance_m: 5000 }] });
  assert.deepEqual(merged, { sleep_minutes: 420, steps: 8400, weight_kg: 72.4, workouts: [{ type: "walk", minutes: 40 }, { type: "run", minutes: 28, distance_m: 5000 }] });
  // The same workout said twice isn't added twice.
  assert.equal(mergeHealth(merged, { workouts: [{ type: "run", minutes: 28, distance_m: 5000 }] }).workouts!.length, 2);
  // Nothing typed in before: just what was said.
  assert.deepEqual(mergeHealth(null, { steps: 9000 }), { steps: 9000 });
  // Only the figures the form covers are carried over: what's sent back is what the form would send.
  assert.deepEqual(mergeHealth({ steps: 1, sleep_stages: [] as never, caffeine_last: "09:00" } as never, { kcal: 2000 }), { steps: 1, kcal: 2000 });

  const card = healthCard({ sleep_hours: 7 }, { today }, before);
  assert.deepEqual(card, { kind: "log_health", date: today, figures: { sleep_minutes: 420 }, keeps: ["steps", "workouts", "weight"] });
  assert.deepEqual(healthCard({ steps: 100, date: "2026-11-13" }, { today }, null).keeps, []);
  assert.throws(() => healthCard({ steps: 100, date: "2025-01-01" }, { today }, null), /400 days back/);
});

test("a day's entry: kind and title, yesterday when said", () => {
  assert.deepEqual(entryCard({ kind: "watched", title: " Perfect  Days ", date: "2026-11-13" }, { today }), { kind: "log_entry", date: "2026-11-13", entry: { kind: "watched", title: "Perfect Days" } });
  assert.deepEqual(entryCard({ kind: "listened", title: "Romance", subtitle: "Fontaines D.C.", minutes: 41 }, { today }).entry, { kind: "listened", title: "Romance", subtitle: "Fontaines D.C.", minutes: 41 });
  assert.throws(() => entryCard({ kind: "habit", title: "Gym" }, { today }), /kind: one of watched/);
  assert.throws(() => entryCard({ kind: "read", title: "  " }, { today }), /title/);
});

test("a meter reading, with what was used since the one before", () => {
  const readings = [
    { id: "a", fuel: "electricity" as const, date: "2026-11-01", value: 12_200, unit: "kwh" as const },
    { id: "b", fuel: "electricity" as const, date: "2026-10-01", value: 11_900, unit: "kwh" as const },
    { id: "c", fuel: "gas" as const, date: "2026-11-01", value: 4500, unit: "m3" as const },
  ];
  assert.deepEqual(readingCard({ fuel: "electricity", value: 12345 }, { today }, readings), { kind: "log_reading", date: today, fuel: "electricity", value: 12345, unit: "kwh", since: { date: "2026-11-01", kwh: 145 } });
  // 10 m³ of gas, as a bill works it out: × 1.02264 × 39.5 ÷ 3.6.
  assert.equal(readingCard({ fuel: "gas", value: 4510, unit: "m3" }, { today }, readings).since?.kwh, 112);
  // Gone backwards, or another unit: nothing to say about the use.
  assert.equal(readingCard({ fuel: "electricity", value: 100 }, { today }, readings).since, undefined);
  assert.equal(readingCard({ fuel: "gas", value: 4510 }, { today }, readings).since, undefined);
  assert.throws(() => readingCard({ fuel: "electricity", value: 1, unit: "m3" }, { today }), /kWh/);
  assert.throws(() => readingCard({ fuel: "water", value: 1 }, { today }), /fuel/);
  assert.throws(() => readingCard({ fuel: "gas" }, { today }), /value/);
});

test("what each card says: the parsed values, a day that doesn't go stale, Add or Save", () => {
  const cards: ConfirmCard[] = [
    { kind: "log_spending", date: today, amount: 400, currency: "GBP", category: "eating_out", merchant: "Coffee" },
    { kind: "log_health", date: today, figures: { sleep_minutes: 420, workouts: [{ type: "run", minutes: 28, distance_m: 5000 }], caffeine_mg: 190 }, keeps: ["steps", "weight"] },
    { kind: "log_entry", date: "2026-11-13", entry: { kind: "watched", title: "Perfect Days" } },
    { kind: "log_reading", date: today, fuel: "electricity", value: 12345, unit: "kwh", since: { date: "2026-11-01", kwh: 145 } },
  ];
  assert.deepEqual(
    cards.map((c) => confirmWords(c)),
    [
      { title: "£4.00 · Coffee", meta: "Eating out · Sat 14 Nov · Money", action: "Add", label: "Add spending: £4.00 on Coffee, Sat 14 Nov" },
      { title: "Sleep 7h · Run 28 min, 5 km · 2 coffees", meta: "Sat 14 Nov · keeps your steps and weight", action: "Save", label: "Log health for Sat 14 Nov: Sleep 7h, Run 28 min, 5 km, 2 coffees" },
      { title: "Perfect Days", meta: "Watched · Fri 13 Nov", action: "Add", label: "Add to Fri 13 Nov: watched Perfect Days" },
      { title: "Electricity meter: 12,345 kWh", meta: "Sat 14 Nov · 145 kWh since Sun 1 Nov", action: "Add", label: "Add an electricity meter reading: 12,345 kWh, Sat 14 Nov" },
    ],
  );
  assert.equal(logWords({ kind: "log_health", date: today, figures: { sleep_minutes: 450 }, keeps: [] }).title, "Sleep 7h 30m");
  assert.equal(logWords({ kind: "log_reading", date: today, fuel: "gas", value: 4510.5, unit: "m3" }).title, "Gas meter: 4,510.5 m³");
});

test("a payment to keep, told apart from a question about spending", () => {
  for (const s of ["I spent £4 on coffee", "spent 12.50 at the corner shop", "I paid £32 for a taxi yesterday", "£4 on coffee", "log £12 at Pret", "just spent 6 on lunch"]) assert.ok(isSpendingLog(s), s);
  for (const s of ["How much have I spent on coffee?", "what did I pay for the train", "I spent the day in Bath", "When did I pay Sam back?"]) assert.ok(!isSpendingLog(s), s);
});

test("Ask's logging tools only prepare a card: nothing is queued or saved, and spending is gated on the switch", async () => {
  const { Session, actTools } = await import("./assistant");
  const { PlanDraft } = await import("./ask-plans");
  const names = (money: boolean) => actTools({ files: false, money }).map((t) => t.name);
  for (const t of ["log_health", "log_day_entry", "log_meter_reading"]) {
    assert.ok(names(false).includes(t), t);
    assert.ok(names(true).includes(t), t);
  }
  assert.ok(!names(false).includes("log_spending"), "not offered with Let Ask read transactions off");
  assert.ok(names(true).includes("log_spending"));

  const now = new Date("2026-11-14T09:00:00Z");
  const session = new Session(now, "Europe/London", { client: null as never, capture: false, money: false });
  session.draft = new PlanDraft("auto");
  const result = JSON.parse(await session.run("log_day_entry", { kind: "watched", title: "Perfect Days", date: "2026-11-13" })) as { shown: string };
  assert.match(result.shown, /Nothing has been sent or saved yet/);
  assert.equal(session.draft.steps.length, 0, "a card isn't a step in a plan");
  assert.equal(session.changes.length, 0);
  assert.deepEqual(session.confirm, [{ kind: "log_entry", date: "2026-11-13", entry: { kind: "watched", title: "Perfect Days" } }]);
  // Called anyway with the switch off: refused in code, no card.
  await assert.rejects(session.run("log_spending", { amount: "£4" }), /Spending from Ask is off/);
  assert.equal(session.confirm.length, 1);
});
