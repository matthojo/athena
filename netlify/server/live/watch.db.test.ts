// The live channel's queries against the real schema.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/server/live/watch.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) process.env.NETLIFY_DB_URL = url;

test("watermarks and changed ids read from every watched table", { skip: !url }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { readChanges, readWatermarks } = await import("./watch");
  const before = await readWatermarks(qRaw);
  assert.deepEqual(await readChanges(qRaw, before, await readWatermarks(qRaw)), []);

  const connector = "00000000-0000-4000-8000-0000000000aa";
  const [note] = await qRaw<{ id: string }>(`INSERT INTO notes (title, body) VALUES ('', '') RETURNING id`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO UPDATE SET updated_at = now()`, [`history_load.${connector}`]);
  try {
    const after = await readWatermarks(qRaw);
    const changes = await readChanges(qRaw, before, after);
    assert.deepEqual(changes.map((c) => c.kind).sort(), ["backfill", "note"]);
    assert.ok(changes.find((c) => c.kind === "note")!.ids.includes(note.id));
    assert.deepEqual(changes.find((c) => c.kind === "backfill")!.ids, [connector]);

    await qRaw(`DELETE FROM notes WHERE id = $1`, [note.id]);
    const gone = await readChanges(qRaw, after, await readWatermarks(qRaw));
    assert.deepEqual(gone.map((c) => c.kind), ["note"]);
  } finally {
    await qRaw(`DELETE FROM notes WHERE id = $1`, [note.id]);
    await qRaw(`DELETE FROM settings WHERE key = $1`, [`history_load.${connector}`]);
  }
});

test("Days, habits and recipes: each write is seen, with the day's date or the row's id", { skip: !url }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { readChanges, readWatermarks } = await import("./watch");
  const date = "1999-01-02";
  const before = await readWatermarks(qRaw);
  let habit: string | undefined;
  let recipe: string | undefined;
  try {
    await qRaw(`INSERT INTO days (date) VALUES ($1::date)`, [date]);
    [{ id: habit }] = await qRaw<{ id: string }>(`INSERT INTO habits (name) VALUES ('') RETURNING id`);
    await qRaw(`INSERT INTO day_entries (date, kind, source, external_id, ext_key, title) VALUES ($1::date, 'habit', 'athena', 'live-test', 'live-test', '')`, [date]);
    [{ id: recipe }] = await qRaw<{ id: string }>(`INSERT INTO recipes (title, body) VALUES ('', '') RETURNING id`);
    await qRaw(`INSERT INTO recipe_cooked (recipe_id, cooked_on) VALUES ($1, $2::date)`, [recipe, date]);
    await qRaw(`INSERT INTO meal_plan (day, recipe_id) VALUES ($1::date, $2)`, [date, recipe]);
    const after = await readWatermarks(qRaw);
    const changes = await readChanges(qRaw, before, after);
    const ids = (kind: string) => changes.find((c) => c.kind === kind)?.ids ?? [];
    assert.deepEqual(changes.map((c) => c.kind).sort(), ["day", "habit", "recipe"]);
    assert.ok(ids("day").includes(date));
    assert.ok(ids("habit").includes(habit!) && ids("habit").includes(date));
    assert.ok(ids("recipe").includes(recipe!) && ids("recipe").includes(date));

    // Unticking deletes the entry: both kinds move, with nothing to name.
    await qRaw(`DELETE FROM day_entries WHERE source = 'athena' AND ext_key = 'live-test'`);
    const gone = await readChanges(qRaw, after, await readWatermarks(qRaw));
    assert.deepEqual(gone.map((c) => c.kind).sort(), ["day", "habit"]);
  } finally {
    await qRaw(`DELETE FROM day_entries WHERE source = 'athena' AND ext_key = 'live-test'`);
    await qRaw(`DELETE FROM meal_plan WHERE day = $1::date`, [date]);
    if (recipe) await qRaw(`DELETE FROM recipes WHERE id = $1`, [recipe]);
    if (habit) await qRaw(`DELETE FROM habits WHERE id = $1`, [habit]);
    await qRaw(`DELETE FROM days WHERE date = $1::date`, [date]);
  }
});
