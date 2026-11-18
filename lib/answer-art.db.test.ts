// Covers on an answer's sources, on Postgres with every migration applied: a cited Watch & read title gets its
// kind and state, an archived or unknown one is left as it was, and nothing is fetched for a source with no cover to find.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/answer-art.db.test.ts
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

test("a cited Watch & read title carries its kind and where it's up to", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { upsertReadingItem } = await import("./memory");
  const { sourceCovers } = await import("./answer-art");
  await qRaw(`DELETE FROM reading_items`);
  // An article has no cover to look for, so nothing leaves the machine.
  const article = await upsertReadingItem({ title: "How to do great work", kind: "article", status: "reading", progress: { unit: "percent", done: 40, total: null } });
  const gone = await upsertReadingItem({ title: "Archived", kind: "article" });
  await qRaw(`UPDATE reading_items SET archived_at = now() WHERE id = $1`, [gone.id]);
  const base = { url: null, date: null, account: null };
  const out = await sourceCovers([
    { n: 1, kind: "watch", id: article.id, title: "How to do great work", ...base },
    { n: 2, kind: "watch", id: gone.id, title: "Archived", ...base },
    { n: 3, kind: "note", id: "00000000-0000-4000-8000-000000000001", title: "A note", ...base },
    { n: 4, kind: "artist", id: null, title: "Radiohead", url: "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb", date: null, account: "Spotify" },
  ]);
  assert.equal(out[0].detail, "Article · 40%");
  assert.equal(out[0].art, undefined);
  assert.deepEqual(out.slice(1).map((s) => [s.detail, s.art]), [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  await qRaw(`DELETE FROM reading_items`);
});
