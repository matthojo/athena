// Watch & read meta (0063) on Postgres with every migration applied: tags through upsertReadingItem, a playlist and
// a year from a sync, and what the lookups learn written back sealed without moving updated_at.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/watch-meta.db.test.ts
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

test("0063: tags are kept in the sealed meta, set, kept and cleared", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { getReadingItem, listReading, upsertReadingItem } = await import("./memory");
  await qRaw(`DELETE FROM reading_items`);

  const made = await upsertReadingItem({ title: "Elf", kind: "film", tags: ["Festive", " festive ", "with the kids"] });
  assert.deepEqual(made.meta, { tags: ["Festive", "with the kids"] });
  // Sealed at rest: the stored value isn't the JSON.
  const [raw] = await qRaw<{ meta: unknown }>(`SELECT meta FROM reading_items WHERE id = $1`, [made.id]);
  assert.equal(typeof raw.meta, "string");
  assert.ok(!String(raw.meta).includes("Festive"));

  // Another edit leaves them alone; an empty list clears them.
  assert.deepEqual((await upsertReadingItem({ id: made.id, notes: "Watch in December" })).meta, { tags: ["Festive", "with the kids"] });
  assert.deepEqual((await upsertReadingItem({ id: made.id, tags: [] })).meta, {});
  await assert.rejects(upsertReadingItem({ id: made.id, tags: "festive" as unknown as string[] }), /tags/);

  const plain = await upsertReadingItem({ title: "No tags", kind: "book" });
  assert.deepEqual(plain.meta, {});
  assert.deepEqual((await listReading()).map((r) => r.meta), [{}, {}]);
  assert.deepEqual((await getReadingItem(made.id))?.meta, {});
});

test("a sync adds the playlist and the year; the lookups' answer is written sealed and tags survive it", { skip }, async () => {
  const { q, qRaw } = await import("./db");
  const { listReading, upsertReadingItem } = await import("./memory");
  const { syncWatchRead } = await import("./watch-read-sync");
  const { enrichRows } = await import("../netlify/lib/watch-enrich");
  await qRaw(`DELETE FROM reading_items`);

  const video = { kind: "video" as const, title: "How to board a loft", maker: "Homebuilding", status: "queued" as const, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", external_id: "video:aaaaaaaaaaa", source: "youtube" as const };
  await syncWatchRead([{ ...video, list: "Loft" }], { collection: "youtube", backfilled: true });
  await syncWatchRead([{ ...video, list: "DIY" }, { kind: "film", title: "Dune", year: 2021, status: "queued", source: "trakt", url: "https://trakt.tv/movies/dune-2021" }], { collection: "youtube", backfilled: true });
  let items = await listReading();
  const loft = items.find((r) => r.kind === "video")!;
  assert.deepEqual(loft.meta, { lists: ["Loft", "DIY"] });
  assert.deepEqual(items.find((r) => r.kind === "film")!.meta, { year: 2021 });

  await upsertReadingItem({ id: loft.id, tags: ["loft"] });
  const [before] = await qRaw<{ updated_at: string }>(`SELECT updated_at::text FROM reading_items WHERE id = $1`, [loft.id]);
  const { sealer } = await import("./db");
  const s = await sealer();
  const rows = await q<{ id: string; kind: string; title: string; author: string; url: string; sync: unknown; meta: unknown }>(`SELECT id, kind, title, author, url, sync, meta FROM reading_items`);
  const result = await enrichRows(rows, {
    now: new Date("2026-11-10T10:00:00.000Z"),
    sources: {
      youtubeSaves: async () => [],
      youtubeVideos: async () => [{ id: "aaaaaaaaaaa", snippet: { publishedAt: "2024-03-01T00:00:00Z", categoryId: "26" }, contentDetails: { duration: "PT14M" } }],
      tmdb: async () => ({ genres: [{ name: "Science Fiction" }], runtime: 155, release_date: "2021-09-15" }),
      trakt: async () => undefined,
      openLibrary: async () => [],
    },
    write: async (id, meta) => void (await q(`UPDATE reading_items SET meta = $2::jsonb WHERE id = $1`, [id, s.json(meta)])),
  });
  assert.deepEqual(result, { due: 2, looked: 2, learned: 2 });
  items = await listReading();
  assert.deepEqual(items.find((r) => r.kind === "video")!.meta, { year: 2024, minutes: 14, genres: ["How-to"], lists: ["Loft", "DIY"], tags: ["loft"], checked: "2026-11-10T10:00:00.000Z" });
  assert.deepEqual(items.find((r) => r.kind === "film")!.meta, { year: 2021, minutes: 155, genres: ["Science Fiction"], checked: "2026-11-10T10:00:00.000Z" });
  const [after] = await qRaw<{ updated_at: string }>(`SELECT updated_at::text FROM reading_items WHERE id = $1`, [loft.id]);
  assert.equal(after.updated_at, before.updated_at);
  await qRaw(`DELETE FROM reading_items`);
});
