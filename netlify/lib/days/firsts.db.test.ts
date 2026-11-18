// Home's memory, server side, through the real /api function and Postgres: GET /api/days/firsts finds a
// place's first visit, a person's first logged catch-up, the first run over 5 km and the first finished book
// when their anniversary is within three days, and says who and where on the candidate days (archived people
// flagged, calls marked); GET/PATCH /api/days/memories keeps the switch and the hidden days for every device.
// Run: npm run -s test:db (needs ATHENA_TEST_DB_URL). Empties places, people, interactions, reading items,
// health and location rows, and the days_memories setting first.
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
const AROUND = "2026-11-09";

async function call(method: string, path: string, body?: unknown) {
  const api = (await import("../../functions/api")).default;
  const res = await api(
    new Request(`https://athena.test/api/${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    {} as never,
  );
  return { status: res.status, json: await res.json() };
}

test("firsts: anniversaries within three days, a year ago or more, with who and where on the candidate days", { skip }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { sealText } = await import("../../../lib/data-box");
  const { upsertPerson } = await import("../../../lib/db");
  const { logInteraction } = await import("../../../lib/memory");

  for (const t of ["interaction_people", "interactions", "place_geo", "reading_items"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM places`);
  await qRaw(`DELETE FROM people`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('location', 'health')`);
  await qRaw(`DELETE FROM facts WHERE subject_kind = 'me'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  // ---- places: first visits ----
  const place = async (name: string, seen: string[], archived = false) => {
    const [p] = await qRaw<{ id: string }>(`INSERT INTO places (name, archived_at) VALUES ($1, $2) RETURNING id`, [name, archived ? new Date().toISOString() : null]);
    await qRaw(`INSERT INTO place_geo (place_id, sealed) VALUES ($1, $2)`, [p.id, sealText(JSON.stringify({ seen: Object.fromEntries(seen.map((d) => [d, { n: 1, minutes: 60 }])) }))]);
  };
  await place("Barbican Centre", ["2025-12-01", "2025-11-07", "2026-02-03"]); // first 7 Nov 2025: two days off, back twice since
  await place("Old Haunt", ["2025-06-01"]); // months away
  await place("Home", ["2024-11-09", "2026-11-01"]); // home is never a first
  await place("Closed Café", ["2025-11-09"], true); // archived

  // ---- people: first logged catch-ups ----
  const ana = await upsertPerson({ name: "Ana Ruiz" });
  const tom = await upsertPerson({ name: "Tom Ellis" });
  const sam = await upsertPerson({ name: "Sam Okafor" });
  const priya = await upsertPerson({ name: "Priya Shah" });
  for (const at of ["2024-11-10T13:00:00Z", "2025-03-01T13:00:00Z", "2026-01-01T13:00:00Z"]) await logInteraction({ channel: "in_person", at, summary: "Coffee", person_ids: [ana.id] });
  await logInteraction({ channel: "in_person", at: "2025-11-09T12:30:00Z", summary: "Lunch", person_ids: [tom.id, sam.id] });
  await logInteraction({ channel: "call", at: "2025-11-11T19:00:00Z", summary: "Call", person_ids: [tom.id] });
  await logInteraction({ channel: "message", at: "2025-11-08T19:00:00Z", summary: "Texts", person_ids: [priya.id] }); // a message isn't seeing someone
  await logInteraction({ channel: "in_person", at: "2026-10-01T12:00:00Z", summary: "First lunch", person_ids: [priya.id] }); // too recent for a first
  await qRaw(`UPDATE people SET archived_at = now() WHERE id = $1`, [sam.id]);

  // ---- health: the first run over 5 km ----
  const health = async (day: string, workouts: unknown[]) =>
    qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source) VALUES ('health', $1, $2, $3::timestamptz, $4::date, 'strava')`, [`Health · ${day}`, sealText(JSON.stringify({ workouts })), `${day}T12:00:00Z`, day]);
  await health("2024-06-01", [{ type: "Run", minutes: 20, distance_m: 3000 }]);
  await health("2024-09-01", [{ type: "Ride", minutes: 60, distance_m: 20000 }]);
  await health("2024-11-09", [{ type: "Run", minutes: 31, distance_m: 5420 }]);
  await health("2025-11-09", [{ type: "Run", minutes: 40, distance_m: 8000 }]);

  // ---- books: the first finished ----
  await qRaw(`INSERT INTO reading_items (title, kind, status, finished_at) VALUES ('Small Hours', 'book', 'done', '2023-11-12T20:00:00Z'), ('Later Book', 'book', 'done', '2024-11-09T20:00:00Z'), ('A Film', 'film', 'done', '2022-11-09T20:00:00Z')`);

  // ---- where: the day a year ago ----
  await qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source) VALUES ('location', 'Places · 2025-11-09 · Merged', $1, '2025-11-09T12:00:00Z', '2025-11-09', 'day')`, [
    sealText(JSON.stringify({ visits: [
      { start: "2025-11-09T09:00:00Z", end: "2025-11-09T12:00:00Z", lat: 51.52, lng: -0.1, name: "Work" },
      { start: "2025-11-09T12:20:00Z", end: "2025-11-09T13:30:00Z", lat: 51.52, lng: -0.12, name: "Dishoom" },
      { start: "2025-11-09T15:00:00Z", end: "2025-11-09T16:30:00Z", lat: 51.56, lng: -0.16, name: "Hampstead Heath" },
    ], line: "Work, lunch at Dishoom, then Hampstead Heath", weather: null, places: {} })),
  ]);
  // Never nudge about: money.
  await qRaw(`INSERT INTO facts (subject_kind, key, value) VALUES ('me', 'Never nudge about', 'Money, weight')`);

  const r = await call("GET", `days/firsts?around=${AROUND}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const firsts = r.json.firsts as Array<{ kind: string; date: string; name: string; since?: number; km?: number }>;
  const by = (kind: string) => firsts.filter((f) => f.kind === kind);
  assert.deepEqual(by("place"), [{ kind: "place", date: "2025-11-07", name: "Barbican Centre", since: 2 }]);
  // Tom's first catch-up was a year ago today (the call since counts); Priya's first was a message, and her first lunch is too recent.
  assert.deepEqual(by("person"), [
    { kind: "person", date: "2025-11-09", name: "Tom Ellis", since: 1 },
    { kind: "person", date: "2024-11-10", name: "Ana Ruiz", since: 2 },
  ]);
  // Sam was archived: no first for Sam.
  assert.deepEqual(by("run"), [{ kind: "run", date: "2024-11-09", name: "run", km: 5.4 }]);
  assert.deepEqual(by("book"), [{ kind: "book", date: "2023-11-12", name: "Small Hours" }]);
  // Nearest anniversary first.
  assert.deepEqual(firsts.slice(0, 2).map((f) => f.kind).sort(), ["person", "run"]);
  assert.equal(firsts[firsts.length - 1].kind, "book");

  const days = r.json.days as Array<{ date: string; people: Array<{ name: string; archived: boolean }>; call?: boolean; line?: string; places: string[] }>;
  const yearAgo = days.find((d) => d.date === "2025-11-09")!;
  assert.ok(yearAgo, JSON.stringify(days));
  assert.deepEqual(yearAgo.people.sort((a, b) => a.name.localeCompare(b.name)), [{ name: "Sam Okafor", archived: true }, { name: "Tom Ellis", archived: false }]);
  assert.equal(yearAgo.call, undefined);
  assert.equal(yearAgo.line, "Work, lunch at Dishoom, then Hampstead Heath");
  assert.deepEqual(yearAgo.places, ["Dishoom", "Hampstead Heath"]);
  assert.deepEqual(days.find((d) => d.date === "2025-11-11"), { date: "2025-11-11", people: [{ name: "Tom Ellis", archived: false }], call: true, places: [] });
  assert.equal(days.find((d) => d.date === "2025-11-08"), undefined, "a message isn't a catch-up");
  // Ana's first catch-up day is a candidate day too, with her there.
  assert.deepEqual(days.find((d) => d.date === "2024-11-10")?.people, [{ name: "Ana Ruiz", archived: false }]);
  assert.deepEqual(r.json.never, ["money", "weight"]);

  // A bad date is refused; a different week finds nothing.
  assert.equal((await call("GET", "days/firsts?around=2026-13-01")).status, 400);
  const far = await call("GET", "days/firsts?around=2026-05-20");
  assert.deepEqual(far.json.firsts, []);
  assert.equal((await call("POST", "days/firsts")).status, 405);
});

test("memories on Home: on by default; the switch and Not this one are kept for every device", { skip }, async () => {
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM settings WHERE key = 'days_memories'`);
  let r = await call("GET", "days/memories");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { on: true, hidden: [] });

  // The phone hides a day; the laptop sees it hidden.
  r = await call("PATCH", "days/memories", { hide: "2025-11-09" });
  assert.deepEqual(r.json, { on: true, hidden: ["2025-11-09"] });
  await call("PATCH", "days/memories", { hide: "2024-11-10" });
  await call("PATCH", "days/memories", { hide: "2025-11-09" });
  assert.deepEqual((await call("GET", "days/memories")).json, { on: true, hidden: ["2024-11-10", "2025-11-09"] });
  // Undo brings one back.
  r = await call("PATCH", "days/memories", { show: "2024-11-10" });
  assert.deepEqual(r.json.hidden, ["2025-11-09"]);
  // Off, and the hidden days stay hidden.
  r = await call("PATCH", "days/memories", { on: false });
  assert.deepEqual(r.json, { on: false, hidden: ["2025-11-09"] });
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'days_memories'`);
  assert.deepEqual(row.value, { on: false, hidden: ["2025-11-09"] });
  // Wrong shapes change nothing.
  for (const bad of [{}, { on: "yes" }, { hide: "9 Nov" }, { show: 3 }]) assert.equal((await call("PATCH", "days/memories", bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call("GET", "days/memories")).json, { on: false, hidden: ["2025-11-09"] });
  assert.equal((await call("DELETE", "days/memories")).status, 405);
});
