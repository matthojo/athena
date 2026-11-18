// Watch & read progress (0042) on Postgres with every migration applied: the columns and their check, and the
// round trip through upsertReadingItem (set, keep, change, clear), listReading, and Ask's Undo putting a position back.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/watch-read-progress.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties Watch & read first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const skip = !url && "set ATHENA_TEST_DB_URL";

test("0042: progress columns and their check", { skip }, async () => {
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM reading_items`);
  const cols = await qRaw<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'reading_items' AND column_name LIKE 'progress_%' ORDER BY column_name`,
  );
  assert.deepEqual(cols, [
    { column_name: "progress_done", data_type: "integer" },
    { column_name: "progress_total", data_type: "integer" },
    { column_name: "progress_unit", data_type: "text" },
  ]);
  type Row = [string | null, number | null, number | null];
  const insert = ([unit, done, total]: Row) =>
    qRaw(`INSERT INTO reading_items (title, progress_unit, progress_done, progress_total) VALUES ('x', $1, $2, $3)`, [unit, done, total]);
  const good: Row[] = [[null, null, null], ["page", 120, 300], ["episode", 4, null], ["percent", 100, null]];
  for (const row of good) await insert(row);
  const bad: Row[] = [["page", null, null], ["page", 310, 300], ["percent", 101, null], ["percent", 40, 100], ["chapter", 1, null], [null, 1, null], ["episode", 1, 0]];
  const byCheck = (e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string; constraint?: string } };
    return /reading_items_progress_check/.test(`${err.message} ${err.cause?.message ?? ""} ${err.cause?.constraint ?? ""}`);
  };
  for (const row of bad) await assert.rejects(insert(row), byCheck, JSON.stringify(row));
  await qRaw(`DELETE FROM reading_items`);
});

test("progress round trip: set, keep, change, clear, Undo", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { upsertReadingItem, getReadingItem, listReading } = await import("./memory");
  const { applyUndo } = await import("./assistant");
  await qRaw(`DELETE FROM reading_items`);

  const book = await upsertReadingItem({ title: "The Mom Test", kind: "book", status: "reading", progress: { unit: "page", done: 84, total: 136 } });
  assert.deepEqual(book.progress, { unit: "page", done: 84, total: 136 });
  assert.equal((await upsertReadingItem({ title: "Severance", kind: "tv" })).progress, null, "none unless given");

  const kept = await upsertReadingItem({ id: book.id, notes: "Good on questions" });
  assert.deepEqual(kept.progress, { unit: "page", done: 84, total: 136 }, "left out: kept");

  const moved = await upsertReadingItem({ id: book.id, progress: { unit: "percent", done: 70, total: null } });
  assert.deepEqual(moved.progress, { unit: "percent", done: 70, total: null });
  assert.deepEqual((await listReading()).find((r) => r.id === book.id)?.progress, { unit: "percent", done: 70, total: null });

  await assert.rejects(upsertReadingItem({ id: book.id, progress: { unit: "page", done: 400, total: 136 } }), /more than the total/);
  await assert.rejects(upsertReadingItem({ id: book.id, progress: { unit: "percent", done: 140, total: null } }), /up to 100/);

  const cleared = await upsertReadingItem({ id: book.id, progress: null });
  assert.equal(cleared.progress, null);

  // Ask's Undo puts the old position back; an Undo from before 0042 (no progress) leaves it alone.
  await applyUndo({ op: "restore_watch_read", id: book.id, title: "The Mom Test", kind: "book", status: "reading", author: "", progress: { unit: "page", done: 84, total: 136 } });
  assert.deepEqual((await getReadingItem(book.id))?.progress, { unit: "page", done: 84, total: 136 });
  await applyUndo({ op: "restore_watch_read", id: book.id, title: "The Mom Test", kind: "book", status: "reading", author: "" });
  assert.deepEqual((await getReadingItem(book.id))?.progress, { unit: "page", done: 84, total: 136 });
  await qRaw(`DELETE FROM reading_items`);
});
