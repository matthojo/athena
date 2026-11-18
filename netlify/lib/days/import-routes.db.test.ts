// Real path for the backfill imports: the /api/days/import routes, Days writes and sealing, on Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days/import-routes.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the Days tables and Bearable's health rows first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const FIX = join(import.meta.dirname, "../../../lib/fixtures/backfill");
const read = (n: string) => readFileSync(join(FIX, n), "utf8");
function zip(dir: string, prefix = ""): Array<{ name: string; text: string }> {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? zip(join(dir, n), `${prefix}${n}/`) : [{ name: `${prefix}${n}`, text: readFileSync(join(dir, n), "utf8") }]));
}

const setup = async () => {
  const { handleImportRoutes } = await import("./import-routes");
  const { qRaw } = await import("../../../lib/db");
  for (const t of ["day_entries", "day_files", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = 'bearable'`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.file-%'`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const call = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleImportRoutes(req, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s })))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  return { call, qRaw };
};

test("backfill imports: idempotent, sealed, and the owner's mood wins", { skip: !url }, async () => {
  const { call, qRaw } = await setup();
  const { patchDay, getDay } = await import("../../../lib/days");
  const { parseLoopExport } = await import("../../../lib/loop-csv");
  const { parseDaylio } = await import("../../../lib/daylio-csv");
  const { parseBearable } = await import("../../../lib/bearable-csv");
  const { parseOvercast } = await import("../../../lib/overcast-opml");
  const { parseTfl } = await import("../../../lib/tfl-csv");
  const now = { today: "2026-11-07" };

  assert.equal((await call("GET", "/days/import/strava")).status, 404);
  assert.equal((await call("GET", "/days/import/loop")).json.last_import, null);
  assert.equal((await call("POST", "/days/import/loop", { days: [{ day: "2026-13-01", habits: [] }] })).status, 400);
  assert.equal((await call("POST", "/days/import/daylio", { days: [{ day: "2026-11-01", mood: 7 }] })).status, 400);

  // Loop: ticks and a skip, then the same file again.
  const loop = parseLoopExport(zip(join(FIX, "loop")), now);
  const file = { items: loop.marks, days: loop.days.length };
  const a = await call("POST", "/days/import/loop", { days: loop.days, file });
  assert.equal(a.status, 200);
  assert.equal(a.json.added, 14);
  const again = await call("POST", "/days/import/loop", { days: loop.days, file });
  assert.equal(again.json.added, 0);
  assert.equal(again.json.days_unchanged, loop.days.length);
  const nov2 = (await getDay("2026-11-02"))!;
  const meditate = nov2.entries.find((e) => e.source === "loop" && e.title === "Meditate")!;
  assert.equal(meditate.note, "skipped");
  assert.equal(meditate.count, 0, "a skipped habit counts 0");
  assert.equal(meditate.kind, "habit");
  assert.equal(meditate.group, "habit");
  const [raw] = await qRaw<{ title: string }>(`SELECT title FROM day_entries WHERE source = 'loop' LIMIT 1`);
  assert.match(raw.title, /^enc:v1:/, "entry titles are sealed at rest");
  assert.equal((await call("GET", "/days/import")).json.imports.loop.items, 14);

  // Daylio: the owner's mood on 3 Nov stays; empty days get the file's; notes go in once.
  await patchDay("2026-11-03", { mood: 2, journal: "My own words." });
  const daylio = parseDaylio(read("daylio.csv"), now);
  const d1 = await call("POST", "/days/import/daylio", { days: daylio.days, file: { items: daylio.marks, days: daylio.days.length } });
  assert.equal(d1.status, 200);
  assert.equal(d1.json.moods_kept, 1);
  assert.equal(d1.json.moods_set, 2, "2 Nov rad and 1 Nov awful; 31 Oct's mood isn't one Athena knows");
  assert.equal(d1.json.journals_added, 4);
  const nov3 = (await getDay("2026-11-03"))!;
  assert.equal(nov3.mood, 2);
  assert.equal(nov3.journal, "My own words.\n\nFrom Daylio\n21:40 · A slow evening\nMade soup.\nCalled Mum.");
  assert.equal((await getDay("2026-11-02"))!.mood, 5);
  const d2 = await call("POST", "/days/import/daylio", { days: daylio.days, file: { items: daylio.marks, days: daylio.days.length } });
  assert.deepEqual([d2.json.added, d2.json.moods_set, d2.json.journals_added], [0, 0, 0]);
  assert.equal((await getDay("2026-11-03"))!.journal, nov3.journal);
  const [priv] = await qRaw<{ private: string }>(`SELECT private FROM days WHERE date = '2026-11-02'`);
  assert.match(priv.private, /^enc:v1:/);

  // Bearable: symptoms and energy sealed with health, never in Days; its mood waits behind the owner's and Daylio's.
  const bear = parseBearable(read("bearable.csv"), now);
  const b1 = await call("POST", "/days/import/bearable", { days: bear.days, file: { items: bear.marks, days: bear.days.length } });
  assert.equal(b1.status, 200);
  assert.equal(b1.json.health_days, 2);
  assert.equal(b1.json.moods_set, 0);
  const [blob] = await qRaw<{ ciphertext: string; label: string }>(`SELECT ciphertext, label FROM sensitive_blobs WHERE domain = 'health' AND source = 'bearable' AND day = '2026-11-03'`);
  assert.match(blob.ciphertext, /^enc:v1:/);
  assert.equal(blob.label, "Health · 2026-11-03 · Bearable");
  assert.ok(!(await getDay("2026-11-03"))!.entries.some((e) => /headache/i.test(e.title)));
  assert.equal((await call("POST", "/days/import/bearable", { days: bear.days })).json.health_days, 0, "the same file again seals nothing");

  // Overcast and TfL.
  const pod = parseOvercast(read("overcast.opml"), { tz: "Europe/London", ...now });
  const o1 = await call("POST", "/days/import/overcast", { days: pod.days });
  assert.equal(o1.json.added, 3);
  assert.equal((await call("POST", "/days/import/overcast", { days: pod.days })).json.added, 0);
  const tfl = parseTfl(read("tfl.csv"), now);
  const t1 = await call("POST", "/days/import/tfl", { days: tfl.days });
  assert.equal(t1.json.added, 5);
  assert.equal((await call("POST", "/days/import/tfl", { days: tfl.days })).json.added, 0);
  const day3 = (await getDay("2026-11-03"))!;
  assert.ok(day3.entries.some((e) => e.source === "overcast" && e.kind === "listened" && e.minutes === 25));
  const commute = day3.entries.filter((e) => e.source === "tfl");
  assert.equal(commute.length, 3);
  assert.ok(commute.every((e) => e.group === "commute" && e.kind === "other"));

  // A hidden entry stays hidden on re-import.
  const { hideEntry } = await import("../../../lib/days");
  await hideEntry(commute[0].id);
  assert.equal((await call("POST", "/days/import/tfl", { days: tfl.days })).json.added, 0);
  assert.equal((await getDay("2026-11-03"))!.entries.filter((e) => e.source === "tfl").length, 2);
});
