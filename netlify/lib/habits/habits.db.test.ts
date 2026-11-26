// Real path for the owner's own habits: the real /api function on Postgres with every migration through 0036.
// Make, tick, count up a target, undo, rename, archive; the Shortcut with a capture key; the Habits page beside an imported habit;
// the evening nudge's owed habits and Ask's habits tool.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/habits/habits.db.test.ts
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

test("Own habits: sealed, ticked as athena entries, undone, logged by Shortcut, read by the Habits page, the nudge and Ask", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { getDay, readEntry, writeEntries } = await import("../../../lib/days");
  const { owedToday, habitDays } = await import("../../../lib/own-habits");
  const { createApiKey } = await import("../../../lib/api-keys");
  const TZ = "Europe/London";
  await qRaw(`DELETE FROM day_entries`);
  await qRaw(`DELETE FROM days`);
  await qRaw(`DELETE FROM habits`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const today = zonedToday(new Date(), TZ);
  const yesterday = addDays(today, -1);

  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, body: (await res.json()) as any };
  };

  // ---- the table refuses a habit due on no day ----
  await assert.rejects(qRaw(`INSERT INTO habits (name, days) VALUES ('x', 0)`));

  // ---- make three ----
  let r = await call("POST", "/habits", { name: "Read", days: 127 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const read = r.body;
  r = await call("POST", "/habits", { name: "Drink water", target: 8, unit: "glasses", icon: "cup" });
  const water = r.body;
  assert.equal(water.target, 8);
  r = await call("POST", "/habits", { name: "Gym", per_week: 3, icon: "heart" });
  const gym = r.body;
  r = await call("POST", "/habits", { name: "  read " });
  assert.equal(r.status, 400, "names are unique in any case");
  assert.match(r.body.error, /already have a habit called “Read”/);

  // Names and units are sealed at rest.
  const raw = await qRaw<{ name: string; unit: string | null }>(`SELECT name, unit FROM habits ORDER BY position`);
  assert.ok(raw.every((x) => x.name.startsWith("enc:v1:")), "names sealed");
  assert.ok(raw[1].unit?.startsWith("enc:v1:"), "unit sealed");

  // ---- tick, count up, undo ----
  r = await call("PUT", `/habits/${read.id}/days/${today}`, { progress: 1 });
  assert.deepEqual({ p: r.body.progress, d: r.body.done, prev: r.body.previous }, { p: 1, d: true, prev: 0 });
  r = await call("PUT", `/habits/${water.id}/days/${today}`, { progress: 3 });
  assert.equal(r.body.done, false);
  let day = await getDay(today);
  const entries = day!.entries.filter((e) => e.kind === "habit" && e.source === "athena");
  assert.deepEqual(entries.map((e) => [e.title, e.count ?? 1, e.note ?? null]).sort(), [["Drink water", 0, "3 of 8 glasses"], ["Read", 1, null]]);
  const sealed = await qRaw<{ title: string; note: string | null }>(`SELECT title, note FROM day_entries WHERE source = 'athena'`);
  assert.ok(sealed.every((x) => x.title.startsWith("enc:v1:") && (!x.note || x.note.startsWith("enc:v1:"))), "ticks sealed like any entry");
  r = await call("PUT", `/habits/${water.id}/days/${today}`, { progress: 8 });
  assert.equal(r.body.done, true);
  assert.equal(r.body.previous, 3);
  // Undo puts it back where it was.
  r = await call("PUT", `/habits/${water.id}/days/${today}`, { progress: 3 });
  assert.equal(r.body.progress, 3);
  // Undo of a first tick clears the day.
  r = await call("PUT", `/habits/${read.id}/days/${today}`, { progress: 0 });
  assert.equal(r.body.previous, 1);
  day = await getDay(today);
  assert.equal(day!.entries.filter((e) => e.title === "Read").length, 0);
  // A past day before it started moves the start back; a future day is refused.
  r = await call("PUT", `/habits/${read.id}/days/${addDays(today, -3)}`, { progress: 1 });
  assert.equal(r.status, 200);
  r = await call("PUT", `/habits/${read.id}/days/${addDays(today, 1)}`, { progress: 1 });
  assert.equal(r.status, 400);
  r = await call("PUT", `/habits/${read.id}/days/${yesterday}`, { progress: 1 });

  // ---- the Shortcut, with a capture key ----
  const capture = (await createApiKey("Habits Shortcut", "capture")).token;
  r = await call("POST", "/habits/log", { habit: "DRINK WATER", count: 2 }, capture);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, "Drink water: 5 of 8 glasses today.");
  r = await call("POST", "/habits/log", { habit: "read" }, capture);
  assert.equal(r.body.message, "Ticked Read for today.");
  r = await call("POST", "/habits/log", { habit: "meditate" }, capture);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No habit called “meditate”/);
  r = await call("GET", "/habits", undefined, capture);
  assert.equal(r.status, 401, "a capture key can't read habits");

  // ---- an imported habit beside them ----
  await writeEntries([{ date: today, entry: readEntry({ kind: "habit", source: "habitify", external_id: "h1", title: "Stretch", count: 1 }) }]);

  // ---- the Habits page ----
  r = await call("GET", "/life/habits");
  const names = r.body.habits.map((x: any) => `${x.source}:${x.name}`);
  assert.deepEqual(names, ["athena:Read", "athena:Drink water", "athena:Gym", "habitify:Stretch"]);
  const readSum = r.body.habits[0];
  assert.equal(readSum.streak, 2, "yesterday and today; three days ago is broken off by the missed day between");
  assert.equal(readSum.own.schedule, "Every day");
  assert.ok(readSum.days.some((d: any) => d.date === addDays(today, -2) && !d.done), "a due day left unticked is missed");
  assert.equal(r.body.habits[1].own.progress_today, 5);

  // ---- the day's list ----
  r = await call("GET", `/habits?date=${today}`);
  const on = Object.fromEntries(r.body.on.map((x: any) => [x.id, x]));
  assert.equal(on[water.id].progress, 5);
  assert.equal(on[gym.id].shows, true);

  // ---- rename keeps the history together ----
  r = await call("PATCH", `/habits/${read.id}`, { name: "Read 20 pages" });
  assert.equal(r.body.name, "Read 20 pages");
  day = await getDay(yesterday);
  assert.deepEqual(day!.entries.filter((e) => e.source === "athena").map((e) => e.title), ["Read 20 pages"]);

  // ---- the evening nudge: water still owed; Gym only once the week can't spare today ----
  const owed = await owedToday(today);
  assert.ok(owed.includes("Drink water"));
  assert.ok(!owed.includes("Read 20 pages"));

  // ---- Ask: did I read every day this week? ----
  const week = await habitDays(addDays(today, -6), today, today);
  const readWeek = week.find((x) => x.name === "Read 20 pages")!;
  assert.equal(readWeek.schedule, "Every day");
  assert.ok(readWeek.done.includes(today) && readWeek.missed.includes(addDays(today, -2)));
  assert.ok(week.some((x) => x.source === "habitify" && x.name === "Stretch"));

  // ---- archive keeps the history ----
  r = await call("PATCH", `/habits/${gym.id}`, { archived: true });
  assert.ok(r.body.archived_at);
  r = await call("PUT", `/habits/${gym.id}/days/${today}`, { progress: 1 });
  assert.equal(r.status, 400);
  r = await call("GET", "/life/habits");
  assert.equal(r.body.habits.at(-2).name, "Gym", "archived ones come after the live ones");
  r = await call("PATCH", `/habits/${gym.id}`, { archived: false });
  assert.equal(r.body.archived_at, null);

  // ---- an ambiguous Shortcut name goes to the habit due today ----
  const bit = 1 << ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7);
  await call("POST", "/habits", { name: "Read the news", days: 127 & ~bit });
  r = await call("POST", "/habits/log", { habit: "read" }, capture);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, "Read 20 pages", "the other isn't due today");
  await call("POST", "/habits", { name: "Read a poem", days: 127 });
  r = await call("POST", "/habits/log", { habit: "read" }, capture);
  assert.equal(r.status, 400, "two are due: ask");

  // ---- a weekly habit's short week is missed, and Patterns counts an unticked due day as 0 ----
  const lastMonday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) - 7);
  await call("PUT", `/habits/${gym.id}/days/${lastMonday}`, { progress: 1 });
  r = await call("GET", "/life/habits");
  const gymSum = r.body.habits.find((x: any) => x.name === "Gym");
  assert.ok(gymSum.days.some((d: any) => d.date === addDays(lastMonday, 1) && !d.done), "1 of 3 last week: the rest are missed");
  assert.equal(gymSum.streak, 0);
  const { habitRates } = await import("../../../lib/habits");
  const rates = await habitRates(addDays(today, -2), addDays(today, -2), today);
  assert.ok((rates.get(addDays(today, -2)) ?? 1) < 1, "Read's missed day lowers the rate");

  // Leave nothing behind for the other db tests (life.db.test.ts reads every habit).
  await qRaw(`DELETE FROM day_entries WHERE source IN ('athena', 'habitify')`);
  await qRaw(`DELETE FROM habits`);
});
