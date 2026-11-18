// Ask's shared read tools (lib/ask-tools.ts) and today's context (lib/ask-context.ts) on a real database:
// each tool's query, and the refs it cites, from data saved the way the app and collections save it
// (sealed health, places and money days included). Then the context block with and without data.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-tools.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the tables it reads first.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";

const TABLES = ["goal_progress", "goals", "trip_bookings", "trips", "purchase_updates", "purchases", "habits", "day_files", "day_entries", "days", "events", "commitments", "reminders", "place_geo", "location_cache", "location_todo", "places", "edges"];

async function wipe() {
  const { qRaw } = await import("./db");
  for (const t of TABLES) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('health', 'location', 'money', 'home')`);
  await qRaw(`DELETE FROM settings WHERE key IN ('health_sources', 'recurring')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

/** A ReadTools with a cite that records what was cited. */
async function tools(now: Date) {
  const { ReadTools } = await import("./ask-tools");
  const cited = new Map<string, { kind: string; id: string; title: string; date: string | null }>();
  const t = new ReadTools({
    tz: TZ,
    now,
    // "Let Ask read transactions" on; the off state is in ask-tools.test.ts and ask-real.db.test.ts.
    money: true,
    cite: (kind, id, title, date = null) => {
      const ref = `${kind}:${id}`;
      cited.set(ref, { kind, id, title, date });
      return ref;
    },
  });
  return { run: async (name: string, input: unknown = {}) => t.run(name, input), cited };
}

const json = (s: string) => JSON.parse(s) as unknown;

before(async () => {
  if (url) await wipe();
});

test("each read tool reads through lib/ and cites what it returns", { skip }, async () => {
  const { zonedToday, addDays, zonedToInstant } = await import("./dates");
  const { upsertGoal } = await import("./memory");
  const { createTrip, addBooking, createPurchase } = await import("./trips");
  const { createOwnHabit, setHabitDay } = await import("./own-habits");
  const { patchDay } = await import("./days");
  const { saveHealthDay } = await import("./health");
  const { saveCheckins } = await import("./places-visits");
  const { moneyDays, saveMoneyDays } = await import("./money");
  await wipe();

  const now = new Date();
  const today = zonedToday(now, TZ);
  const day = (n: number) => addDays(today, -n);

  // ---- seed, the way the app and collections do ----
  const goal = await upsertGoal({ title: "Run a half marathon", target: "21k under 2 hours", progress: 40, due_on: addDays(today, 60) });
  await upsertGoal({ title: "Read 20 books", progress: 100, status: "done" });
  const trip = await createTrip({ title: "Lisbon", starts_on: addDays(today, 10), ends_on: addDays(today, 14) });
  await addBooking({ trip_id: trip.id, kind: "flight", title: "LHR to LIS", provider: "TAP Air Portugal", reference: "ABC123", start_local: `${addDays(today, 10)}T07:10`, start_tz: TZ, start_city: "London", end_city: "Lisbon" });
  const { purchase } = await createPurchase({ retailer: "John Lewis", items: ["Anglepoise lamp"], ordered_on: day(2), status: "dispatched", expected_on: addDays(today, 1) });
  const habit = await createOwnHabit({ name: "Read" }, today);
  await setHabitDay(habit.id, day(1), 1, today);
  await patchDay(day(1), { mood: 4, journal: "A slow Sunday. Long walk on the heath." }, { tz: TZ });
  for (const [n, sleep, rec] of [[2, 400, 55], [1, 452, 71], [0, 430, 64]] as const) {
    await saveHealthDay({ date: day(n), source: "oura", sleep_minutes: sleep, sleep_stages: { deep: 80 }, resting_hr: 52, steps: 9_000 + n }, { tz: TZ });
    await saveHealthDay({ date: day(n), source: "whoop", recovery: rec }, { tz: TZ });
  }
  await saveCheckins(new Map([[day(1), [{ id: "ck1", at: zonedToInstant(day(1), "12:40", TZ).toISOString(), lat: 51.5124, lng: -0.127, venue: "Dishoom Covent Garden", venue_id: "4ac5dishoom", category: "Indian Restaurant" }]]]), "merge", { tz: TZ, lookups: false });
  const at = (n: number, time: string) => zonedToInstant(day(n), time, TZ).toISOString();
  await saveMoneyDays(
    "monzo",
    moneyDays(
      [
        { id: "t1", at: at(3, "08:10"), amount: 425, currency: "GBP", category: "groceries", merchant: "Tesco Express" },
        { id: "t2", at: at(3, "12:30"), amount: 650, currency: "GBP", category: "eating_out", merchant: "Pret A Manger" },
        { id: "t3", at: at(1, "18:00"), amount: 5_230, currency: "GBP", category: "groceries", merchant: "TESCO STORES 2041" },
      ],
      TZ,
    ),
    { tz: TZ },
  );

  const { run, cited } = await tools(now);

  // goals: the match, its ref, and done goals only when asked
  let out = json(await run("goals", { query: "marathon" })) as Array<{ ref: string; progress: string }>;
  assert.equal(out.length, 1);
  assert.equal(out[0].ref, `goal:${goal.id}`);
  assert.equal(out[0].progress, "40%");
  assert.equal(cited.get(`goal:${goal.id}`)?.title, "Run a half marathon");
  assert.equal((json(await run("goals", { status: "done" })) as unknown[]).length, 1);

  // trips: found by a booking's provider, with its bookings
  const tr = json(await run("trips", { query: "tap" })) as Array<{ ref: string; bookings: Array<{ provider: string; reference: string }> }>;
  assert.equal(tr[0].ref, `trip:${trip.id}`);
  assert.equal(tr[0].bookings[0].provider, "TAP Air Portugal");
  assert.match(await run("trips", { query: "rome" }), /No trip matches/);

  // purchases: by an item, never a price
  const p = await run("purchases", { query: "lamp" });
  assert.equal((json(p) as Array<{ ref: string }>)[0].ref, `purchase:${purchase.id}`);
  assert.doesNotMatch(p, /£/);

  // habits: done days cited as days
  const h = json(await run("habits", { from: day(6), to: today })) as { habits: Array<{ name: string; done: string[] }> };
  assert.deepEqual(h.habits.find((x) => x.name === "Read")?.done, [day(1)]);
  assert.ok(cited.has(`day:${day(1)}`));

  // days: one day in full opens its mood, journal, health line, places and spending (no keyword gate)
  const d = json(await run("days", { date: day(1) })) as Record<string, unknown>;
  assert.equal(d.ref, `day:${day(1)}`);
  assert.equal(d.mood, "4 of 5");
  assert.match(String(d.journal), /heath/);
  assert.match(String(d.health), /7h 32m sleep/);
  assert.deepEqual(d.places, ["Dishoom Covent Garden"]);
  assert.match(String(d.money), /£52/);
  // and a search finds the journal
  assert.match(await run("days", { query: "heath" }), new RegExp(`day:${day(1)}`));

  // health: each day with its figures, the averages, and the span before for a trend
  const he = json(await run("health", { from: day(2), to: today })) as { days: Array<{ ref: string; sleep: string; recovery: string }>; averages: Record<string, unknown>; before: { from: string } };
  assert.deepEqual(he.days.map((x) => x.ref), [day(2), day(1), today].map((x) => `day:${x}`));
  assert.equal(he.days[1].sleep, "7h 32m");
  assert.equal(he.days[1].recovery, "71%");
  assert.equal(he.averages.sleep, "7h 7m");
  assert.equal(he.before.from, day(5));

  // places: days at a place matching the query
  const pl = json(await run("places", { query: "dishoom" })) as { days: Array<{ ref: string; places: string[] }> };
  assert.equal(pl.days.length, 1);
  assert.equal(pl.days[0].ref, `day:${day(1)}`);
  assert.match(await run("places", { query: "nando" }), /No days at a place/);

  // money: by merchant, the exact total over every match, each payment's day cited
  const m = json(await run("money", { merchant: "tesco", from: day(7), to: today, group_by: "merchant" })) as { total: string; count: number; payments: Array<{ ref: string; merchant: string; amount: string }>; by_merchant: Array<{ key: string; total: string }> };
  assert.equal(m.total, "£56.55");
  assert.equal(m.count, 2);
  assert.deepEqual(m.payments.map((x) => x.ref), [`day:${day(1)}`, `day:${day(3)}`]);
  assert.equal(m.payments[1].amount, "£4.25");
  assert.equal(m.by_merchant[0].key, "TESCO STORES 2041");
  assert.ok(cited.has(`day:${day(3)}`));
  assert.equal((json(await run("money", { category: "eating_out", from: day(7) })) as { total: string }).total, "£6.50");
  assert.match(await run("money", { merchant: "waitrose" }), /No payments at "waitrose"/);
  await assert.rejects(run("money", { from: "2020-01-01", to: today }), /At most 400 days/);

  // patterns and regular payments: they answer plainly when there's too little to say
  assert.match(await run("patterns", { outcome: "sleep" }), /No clear patterns/);
  assert.match(await run("regular_payments"), /No regular payments/);
});

test("today's context: with data it has the day; without, just now; never notes, references or money", { skip }, async () => {
  const { zonedToday, addDays, zonedToInstant } = await import("./dates");
  const { loadAskContextData, renderAskContext, askContext, clearAskContextCache } = await import("./ask-context");
  const { qRaw } = await import("./db");
  const { upsertCommitment } = await import("./memory");
  const { createTrip, addBooking } = await import("./trips");
  const { saveHealthDay } = await import("./health");
  await wipe();

  const now = new Date();
  const today = zonedToday(now, TZ);

  // Without data
  const bare = renderAskContext(await loadAskContextData(now, TZ));
  assert.match(bare, /^Now: /);
  assert.match(bare, /- Nothing in the calendar/);
  assert.doesNotMatch(bare, /Last night|to-dos|Travel/);

  // With data
  const late = (t: string) => zonedToInstant(today, t, TZ).toISOString();
  await qRaw(`INSERT INTO events (title, kind, date, starts_at, notes) VALUES ('Standup', 'other', $1::date, $2::timestamptz, 'Dial-in PIN 99887766 and the secret plan')`, [today, late("23:30")]);
  await qRaw(`INSERT INTO events (title, kind, date) VALUES ('Dentist', 'appointment', $1::date)`, [addDays(today, 1)]);
  await upsertCommitment({ title: "Send the Q4 deck", kind: "todo", due_on: today });
  await upsertCommitment({ title: "Book the boiler service", kind: "todo" });
  await saveHealthDay({ date: today, source: "oura", sleep_minutes: 452, resting_hr: 51 }, { tz: TZ });
  const trip = await createTrip({ title: "Bristol", starts_on: today, ends_on: addDays(today, 2) });
  await addBooking({ trip_id: trip.id, kind: "train", title: "Paddington to Bristol", provider: "GWR", reference: "REF9X7Q2", seat: "C42", start_local: `${today}T23:50`, start_tz: TZ });

  const text = renderAskContext(await loadAskContextData(now, TZ));
  assert.match(text, /23:30 Standup/);
  assert.match(text, /Tomorrow .*:\n- All day Dentist \(appointment\)/);
  assert.match(text, /Last night: 7h 32m asleep, 51 bpm resting/);
  assert.match(text, /Due or overdue:\n- Send the Q4 deck \(due today\)/);
  assert.match(text, /Other open to-dos:\n- Book the boiler service/);
  assert.match(text, /On a trip: Bristol/);
  assert.match(text, /Travel today:\n- 23:50 /);
  for (const never of ["PIN", "secret plan", "REF9X7Q2", "C42", "£"]) assert.ok(!text.includes(never), `${never} in the block`);
  assert.ok(text.length <= 2_400);

  // Cached per minute: a change inside the same minute isn't seen; after clearing, it is.
  clearAskContextCache();
  const first = await askContext({ now, tz: TZ });
  await upsertCommitment({ title: "A brand new to-do", kind: "todo" });
  assert.equal(await askContext({ now, tz: TZ }), first);
  assert.notEqual(await askContext({ now: new Date(now.getTime() + 60_000), tz: TZ }), first);
});
