// The goal progress log (0041) and the week in review's server read, against Postgres with every migration
// applied: each way a goal changes (MCP and the API's upsertGoal, the app's PUT /api/goals/:id, Ask's save_item)
// logs a row only when progress changes, and GET /api/week-review reads "moved on" and "seen" from it.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/week-review.db.test.ts
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
const TZ = "Europe/London";

async function call(method: string, path: string, body?: unknown) {
  const api = (await import("../netlify/functions/api")).default;
  const res = await api(
    new Request(`https://athena.test/api/${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    {} as never,
  );
  return { status: res.status, json: await res.json() };
}

test("goal progress log: a row for each change, from every path, none for other edits", { skip }, async () => {
  const { upsertGoal } = await import("./memory");
  const { runRecordTool } = await import("./assistant-records");
  const { qRaw } = await import("./db");
  const log = async (id: string) => (await qRaw<{ progress: number }>(`SELECT progress FROM goal_progress WHERE goal_id = $1 ORDER BY at, id`, [id])).map((r) => r.progress);

  // A new goal's starting value is logged (MCP's save_goal and the API both call upsertGoal).
  const g = await upsertGoal({ title: "Run a half marathon", progress: 10 });
  assert.deepEqual(await log(g.id), [10]);
  // Same progress, or only the title and status: nothing new.
  await upsertGoal({ id: g.id, progress: 10, title: "Run a half marathon in spring" });
  await upsertGoal({ id: g.id, status: "active", notes: "Twice a week" });
  assert.deepEqual(await log(g.id), [10]);
  // A change is logged.
  await upsertGoal({ id: g.id, progress: 25 });
  assert.deepEqual(await log(g.id), [10, 25]);

  // The app's path: PATCH /api/goals/:id.
  const r = await call("PATCH", `goals/${g.id}`, { progress: 40 });
  assert.equal(r.status, 200);
  assert.equal(r.json.progress, 40);
  assert.deepEqual(await log(g.id), [10, 25, 40]);

  // Ask's path: save_item with a progress.
  await runRecordTool("save_item", { kind: "goal", id: g.id, progress: 55 }, { record: () => "ok", now: new Date(), tz: TZ, capture: false });
  assert.deepEqual(await log(g.id), [10, 25, 40, 55]);

  // Deleting the goal for good takes its log with it.
  await qRaw(`DELETE FROM goals WHERE id = $1`, [g.id]);
  assert.deepEqual(await log(g.id), []);
});

test("week review read: goals moved on this week, seen at a place, and places known before", { skip }, async () => {
  const { upsertGoal } = await import("./memory");
  const { linkEntities, upsertEvent, upsertPerson, upsertPlace, q, qRaw } = await import("./db");
  // Names are sealed, so earlier runs' rows are found by reading them back opened.
  for (const table of ["goals", "people", "places"]) {
    const col = table === "goals" ? "title" : "name";
    const rows = await q<{ id: string; v: string }>(`SELECT id, ${col} AS v FROM ${table}`);
    for (const r of rows) if (r.v.startsWith("WR ")) await qRaw(`DELETE FROM ${table} WHERE id = $1`, [r.id]);
  }
  const events = await q<{ id: string; v: string }>(`SELECT id, title AS v FROM events`);
  for (const r of events) if (["Lunch with Priya", "Call with Priya", "Gym", "Drinks", "Lunch again"].includes(r.v)) await qRaw(`DELETE FROM events WHERE id = $1`, [r.id]);
  const from = "2026-11-02";
  const to = "2026-11-08";
  const at = (date: string) => `${date}T12:00:00Z`;
  const backdate = (id: string, progress: number, date: string) => qRaw(`UPDATE goal_progress SET at = $3 WHERE goal_id = $1 AND progress = $2`, [id, progress, at(date)]);

  // Moved: 30 last week, 45 by Thursday, 50 by Saturday.
  const moved = await upsertGoal({ title: "WR Ship the memory layer", progress: 30, target: "Live on every device" });
  await upsertGoal({ id: moved.id, progress: 45 });
  await upsertGoal({ id: moved.id, progress: 50 });
  await backdate(moved.id, 30, "2026-10-28");
  await backdate(moved.id, 45, "2026-11-05");
  await backdate(moved.id, 50, "2026-11-07");
  // Still: logged last week, nothing since.
  const still = await upsertGoal({ title: "WR Read twelve books", progress: 60 });
  await backdate(still.id, 60, "2026-10-20");
  // Moved, but the week after: not this week.
  const later = await upsertGoal({ title: "WR Learn Portuguese", progress: 5 });
  await upsertGoal({ id: later.id, progress: 15 });
  await backdate(later.id, 5, "2026-10-01");
  await backdate(later.id, 15, "2026-11-10");
  // Started this week at 20 and never changed: not moved.
  const fresh = await upsertGoal({ title: "WR Sleep before midnight", progress: 20 });
  await backdate(fresh.id, 20, "2026-11-03");
  // Seeded by the migration this week, then moved.
  const seeded = await upsertGoal({ title: "WR Fix the bike", progress: 0 });
  await qRaw(`UPDATE goal_progress SET source = 'seed', progress = 50, at = $2 WHERE goal_id = $1`, [seeded.id, at("2026-11-04")]);
  await upsertGoal({ id: seeded.id, progress: 60 });
  await backdate(seeded.id, 60, "2026-11-06");
  // Archived goals stay out.
  const gone = await upsertGoal({ title: "WR Old goal", progress: 10 });
  await upsertGoal({ id: gone.id, progress: 90 });
  await backdate(gone.id, 10, "2026-10-01");
  await backdate(gone.id, 90, "2026-11-04");
  await qRaw(`UPDATE goals SET archived_at = now() WHERE id = $1`, [gone.id]);

  // Seen: Priya at Dishoom on Wednesday (person and place linked to the event).
  const priya = await upsertPerson({ name: "WR Priya Shah" });
  const dishoom = await upsertPlace({ name: "WR Dishoom King's Cross" });
  const lunch = await upsertEvent({ title: "Lunch with Priya", date: "2026-11-04", time: "13:00", tz: TZ });
  await linkEntities({ sourceType: "event", sourceId: lunch.id, targetType: "person", targetId: priya.id });
  await linkEntities({ sourceType: "place", sourceId: dishoom.id, targetType: "event", targetId: lunch.id });
  // Not seen: a person but no place; a place but no person; declined; the week after.
  const call1 = await upsertEvent({ title: "Call with Priya", date: "2026-11-05", time: "10:00", tz: TZ });
  await linkEntities({ sourceType: "event", sourceId: call1.id, targetType: "person", targetId: priya.id });
  const gym = await upsertEvent({ title: "Gym", date: "2026-11-05", time: "07:00", tz: TZ });
  await linkEntities({ sourceType: "event", sourceId: gym.id, targetType: "place", targetId: dishoom.id });
  const declined = await upsertEvent({ title: "Drinks", date: "2026-11-06", time: "19:00", tz: TZ });
  await linkEntities({ sourceType: "event", sourceId: declined.id, targetType: "person", targetId: priya.id });
  await linkEntities({ sourceType: "event", sourceId: declined.id, targetType: "place", targetId: dishoom.id });
  await qRaw(`UPDATE events SET rsvp = 'declined' WHERE id = $1`, [declined.id]);
  const next = await upsertEvent({ title: "Lunch again", date: "2026-11-11", time: "13:00", tz: TZ });
  await linkEntities({ sourceType: "event", sourceId: next.id, targetType: "person", targetId: priya.id });
  await linkEntities({ sourceType: "event", sourceId: next.id, targetType: "place", targetId: dishoom.id });

  const r = await call("GET", `week-review?from=${from}&to=${to}&tz=${TZ}`);
  assert.equal(r.status, 200);
  const mine = (r.json.goals as Array<{ title: string; was: number; now: number }>).filter((g) => g.title.startsWith("WR "));
  assert.deepEqual(
    mine.map((g) => [g.title, g.was, g.now]),
    [
      ["WR Ship the memory layer", 30, 50],
      ["WR Fix the bike", 50, 60],
    ],
  );
  const seen = (r.json.seen as Array<{ title: string; date: string; people: { name: string }[]; place: string }>).filter((s) => s.place.startsWith("WR "));
  assert.deepEqual(seen.map((s) => [s.title, s.date, s.people.map((p) => p.name), s.place]), [["Lunch with Priya", "2026-11-04", ["WR Priya Shah"], "WR Dishoom King's Cross"]]);
  assert.ok(Array.isArray(r.json.known_places));

  // Bad ranges are refused.
  assert.equal((await call("GET", `week-review?from=2026-11-08&to=2026-11-02`)).status, 400);
  assert.equal((await call("GET", `week-review?from=2026-01-01&to=2026-06-30`)).status, 400);
  assert.equal((await call("POST", `week-review?from=${from}&to=${to}`)).status, 405);
});
