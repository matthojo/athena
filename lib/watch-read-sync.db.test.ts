// Real path for Watch & read from sources: a Life log run's athena_watch_read (the real AthenaWriter), the
// owner's own edits through the app's code (upsertReadingItem, setValue), and the Goodreads CSV import through
// the real /api route, on Postgres with every migration applied (0029 included).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/watch-read-sync.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties Watch & read and the connector tables first.
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

async function setup() {
  const { handleConnectorRoutes } = await import("../netlify/lib/connectors/routes");
  const { qRaw } = await import("./db");
  for (const t of ["custom_values", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const api = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    try {
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 400, json: { error: (error as Error).message } };
    }
  };
  const gr = (await api("POST", "/connectors", { provider: "goodreads", name: "Goodreads", account_label: "personal", url: "https://www.goodreads.com/user/show/12345-jordan" })).json;
  const life = (await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [gr.id], schedule: "daily", run_at: "23:30" })).json;
  const { AthenaWriter } = await import("../netlify/lib/connectors/runner");
  const stats = { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0, skipped_dismissed: 0 };
  const writer = (now = new Date("2026-11-07T23:30:00Z")) => new AthenaWriter(life, "00000000-0000-0000-0000-000000000000", stats as never, now, "Europe/London");
  const tool = async (args: Record<string, unknown>, now?: Date) => JSON.parse(await writer(now).run("athena_watch_read", args));
  return { api, gr, life, tool, stats };
}

/** Every item, opened, with its Rating. */
async function list() {
  const { q } = await import("./db");
  const { listValues } = await import("./custom-fields");
  const { ratingField } = await import("./watch-read-sync");
  const field = await ratingField({ create: false });
  const values = field ? (await listValues("reading")).filter((v) => v.field_id === field.id) : [];
  const rows = await q<{ id: string; title: string; kind: string; status: string; author: string; url: string; finished_at: string | null; sync: unknown }>(
    `SELECT id, title, kind, status, author, url, finished_at, sync FROM reading_items ORDER BY created_at`,
  );
  return rows.map((r) => ({ ...r, rating: values.find((v) => v.entity_id === r.id)?.value ?? null }));
}

test("Life log run: one item per title across Letterboxd and Trakt, half stars, Trakt halved, newer rating wins, re-runs change nothing", { skip }, async () => {
  const { tool, stats } = await setup();
  const { q, qRaw } = await import("./db");

  // Letterboxd: a diary entry with a half star.
  const a = await tool({ kind: "film", title: "Dune: Part Two", year: 2024, maker: "Denis Villeneuve", status: "done", rating: "★★★★½ (4.5/5)", at: "2026-11-01", url: "https://letterboxd.com/jordan/film/dune-part-two/", source: "letterboxd" });
  assert.equal(a.action, "created");
  assert.equal(a.rating, 4.5);

  // The Rating field was made once, as a rating.
  const fields = await q<{ label: string; type: string }>(`SELECT label, type FROM custom_fields WHERE kind = 'reading'`);
  assert.deepEqual(fields, [{ label: "Rating", type: "rating" }]);

  // Trakt sees the same film (other link, other slug), rated earlier: one item, and the older 8/10 doesn't win.
  const b = await tool({ kind: "film", title: "Dune: Part Two", year: 2024, status: "done", rating: "8/10", at: "2026-10-20T21:00:00Z", url: "https://trakt.tv/movies/dune-part-two-2024", source: "trakt" });
  assert.equal(b.id, a.id);
  assert.equal(b.rating, 4.5);
  // A newer Trakt rating does: 10/10 is five stars.
  const c = await tool({ kind: "film", title: "Dune: Part Two", year: 2024, status: "done", rating: "10/10", at: "2026-11-05T20:00:00Z", external_id: "dune-part-two-2024", source: "trakt" });
  assert.equal(c.id, a.id);
  assert.equal(c.rating, 5);
  // A Trakt seven is three and a half.
  const d = await tool({ kind: "film", title: "The Holdovers", year: 2023, status: "done", rating: "7/10", at: "2026-11-02", url: "https://trakt.tv/movies/the-holdovers-2023", source: "trakt" });
  assert.equal(d.rating, 3.5);
  // A show: the episode link becomes the show's, it's in progress, and no rating means no value (never 0).
  const e = await tool({ kind: "tv", title: "Severance", status: "reading", at: "2026-11-06", url: "https://trakt.tv/shows/severance/seasons/2/episodes/3", source: "trakt" });
  assert.equal(e.action, "created");
  assert.equal(e.rating, null);
  // Same name, other year: another film.
  const f = await tool({ kind: "film", title: "Dune", year: 1984, status: "queued", url: "https://trakt.tv/movies/dune-1984", source: "trakt" });
  const g = await tool({ kind: "film", title: "Dune", year: 2021, status: "done", rating: 4, url: "https://letterboxd.com/jordan/film/dune-2021/", source: "letterboxd" });
  assert.notEqual(f.id, g.id);

  let items = await list();
  assert.equal(items.length, 5);
  const dune2 = items.find((i) => i.id === a.id)!;
  assert.deepEqual({ status: dune2.status, author: dune2.author, url: dune2.url, rating: dune2.rating }, { status: "done", author: "Denis Villeneuve", url: "https://letterboxd.com/jordan/film/dune-part-two/", rating: 5 });
  assert.equal(dune2.finished_at && new Date(dune2.finished_at).toISOString(), "2026-11-01T12:00:00.000Z");
  const sev = items.find((i) => i.id === e.id)!;
  assert.deepEqual({ kind: sev.kind, status: sev.status, url: sev.url, rating: sev.rating }, { kind: "tv", status: "reading", url: "https://trakt.tv/shows/severance", rating: null });
  assert.equal((stats as { watch_read_created?: number }).watch_read_created, 5);

  // Sealed at rest: titles, links and the sync state.
  const raw = await qRaw<{ title: string; url: string; sync: unknown }>(`SELECT title, url, sync FROM reading_items`);
  for (const r of raw) {
    assert.match(r.title, /^enc:v1:/);
    assert.match(String(r.sync), /^enc:v1:/);
  }
  const rawValues = await qRaw<{ value: string }>(`SELECT value FROM custom_values`);
  for (const v of rawValues) assert.match(v.value, /^enc:v1:/);

  // A watchlist entry for a film already watched doesn't move it back.
  const back = await tool({ kind: "film", title: "The Holdovers", status: "queued", url: "https://trakt.tv/movies/the-holdovers-2023", source: "trakt" });
  assert.equal(back.action, "unchanged");
  // Severance finished: forward is fine.
  assert.equal((await tool({ kind: "tv", title: "Severance", status: "done", rating: "9/10", at: "2026-11-07", source: "trakt", url: "https://trakt.tv/shows/severance" })).rating, 4.5);

  // The whole run again: nothing changes.
  const before = JSON.stringify(await list());
  for (const args of [
    { kind: "film", title: "Dune: Part Two", year: 2024, status: "done", rating: "★★★★½ (4.5/5)", at: "2026-11-01", url: "https://letterboxd.com/jordan/film/dune-part-two/", source: "letterboxd" },
    { kind: "film", title: "Dune: Part Two", year: 2024, status: "done", rating: "10/10", at: "2026-11-05T20:00:00Z", external_id: "dune-part-two-2024", source: "trakt" },
    { kind: "film", title: "The Holdovers", year: 2023, status: "done", rating: "7/10", at: "2026-11-02", url: "https://trakt.tv/movies/the-holdovers-2023", source: "trakt" },
  ]) {
    const r = await tool(args);
    assert.equal(r.action, "unchanged", JSON.stringify(r));
  }
  assert.equal(JSON.stringify(await list()), before);
  items = await list();
  assert.equal(items.length, 5);
});

test("owner edits are kept: a rating or status set by hand stays, and an owner-added item is filled in, not doubled", { skip }, async () => {
  const { tool } = await setup();
  const { upsertReadingItem } = await import("./memory");
  const { archiveEntity } = await import("./db");
  const { setValue, defineField } = await import("./custom-fields");

  // The owner's own field, called something else: Athena uses theirs rather than adding another.
  const { field: mine } = await defineField({ kind: "reading", label: "Stars", type: "rating" });
  // The owner added a film by hand, to watch, with no link.
  const hand = await upsertReadingItem({ title: "Past Lives", kind: "film" });
  const r1 = await tool({ kind: "film", title: "Past Lives", year: 2023, maker: "Celine Song", status: "done", rating: "★★★★", at: "2026-11-03", url: "https://letterboxd.com/jordan/film/past-lives/", source: "letterboxd" });
  assert.equal(r1.id, hand.id);
  assert.equal(r1.action, "updated");
  assert.equal(r1.rating, 4);
  let item = (await list()).find((i) => i.id === hand.id)!;
  assert.deepEqual({ status: item.status, author: item.author, url: item.url }, { status: "done", author: "Celine Song", url: "https://letterboxd.com/jordan/film/past-lives/" });
  const { q } = await import("./db");
  assert.deepEqual(await q(`SELECT label FROM custom_fields WHERE kind = 'reading'`), [{ label: "Stars" }]);
  const { listValues } = await import("./custom-fields");
  assert.equal((await listValues("reading")).find((v) => v.entity_id === hand.id)?.field_id, mine.id);

  // The owner changes the rating to 3 stars and marks it "watching" again.
  await setValue({ field_id: mine.id, entity_id: hand.id, value: 3 });
  await upsertReadingItem({ id: hand.id, status: "reading" });
  // A newer source rating and status don't overwrite either; the answer says so.
  const r2 = await tool({ kind: "film", title: "Past Lives", year: 2023, status: "done", rating: "10/10", at: "2026-11-06", url: "https://trakt.tv/movies/past-lives-2023", source: "trakt" });
  assert.equal(r2.id, hand.id);
  assert.deepEqual(r2.kept?.sort(), ["rating", "status"]);
  item = (await list()).find((i) => i.id === hand.id)!;
  assert.deepEqual({ status: item.status, rating: item.rating }, { status: "reading", rating: 3 });

  // The owner clears a rating a source gave: it stays empty.
  const r3 = await tool({ kind: "film", title: "Aftersun", status: "done", rating: "★★★★★", at: "2026-10-01", url: "https://letterboxd.com/jordan/film/aftersun/", source: "letterboxd" });
  await setValue({ field_id: mine.id, entity_id: r3.id, value: null });
  const r4 = await tool({ kind: "film", title: "Aftersun", status: "done", rating: "★★★★★", at: "2026-10-09", url: "https://letterboxd.com/jordan/film/aftersun/1/", source: "letterboxd" });
  assert.deepEqual(r4.kept, ["rating"]);
  assert.equal((await list()).find((i) => i.id === r3.id)!.rating, null);

  // An item the owner already rated by hand before any source saw it keeps that rating.
  const rated = await upsertReadingItem({ title: "Perfect Days", kind: "film", status: "done" });
  await setValue({ field_id: mine.id, entity_id: rated.id, value: 5 });
  const r5 = await tool({ kind: "film", title: "Perfect Days", status: "done", rating: "★★★", at: "2026-11-04", url: "https://letterboxd.com/jordan/film/perfect-days/", source: "letterboxd" });
  assert.deepEqual(r5.kept, ["rating"]);
  assert.equal((await list()).find((i) => i.id === rated.id)!.rating, 5);

  // Archived by the owner: left alone, not made again.
  await archiveEntity("reading", rated.id);
  const r6 = await tool({ kind: "film", title: "Perfect Days", status: "done", rating: "★★★", url: "https://letterboxd.com/jordan/film/perfect-days/", source: "letterboxd" });
  assert.equal(r6.action, "skipped");
  assert.equal((await list()).filter((i) => i.title === "Perfect Days").length, 1);
});

test("Goodreads: the CSV import fills ratings, the nightly shelf meets the same books, a newer re-rating wins", { skip }, async () => {
  const { api, gr, tool } = await setup();
  const days = [
    { day: "2023-01-15", books: [{ id: "44767458", title: "Dune (Dune, #1)", author: "Frank Herbert", rating: 5 }] },
    { day: "2026-07-03", books: [{ id: "11", title: "Piranesi", author: "Susanna Clarke", rating: 4 }, { id: "12", title: "Unrated Book", author: "A. Writer", rating: 0 }] },
    { day: "2026-10-01", books: [{ id: "13", title: "Tomorrow, and Tomorrow, and Tomorrow", author: "Gabrielle Zevin", rating: 0, want: true }] },
  ];
  const r = await api("POST", `/connectors/${gr.id}/library`, { days, metrics: false, file: { items: 4, days: 3, to_read: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.watch_read, { created: 4, updated: 0 });
  let items = await list();
  const by = (t: string) => items.find((i) => i.title === t)!;
  assert.deepEqual(
    items.map((i) => [i.title, i.kind, i.status, i.author, i.rating]),
    [
      ["Dune (Dune, #1)", "book", "done", "Frank Herbert", 5],
      ["Piranesi", "book", "done", "Susanna Clarke", 4],
      ["Unrated Book", "book", "done", "A. Writer", null],
      ["Tomorrow, and Tomorrow, and Tomorrow", "book", "queued", "Gabrielle Zevin", null],
    ],
  );
  assert.equal(by("Piranesi").url, "https://www.goodreads.com/book/show/11");
  assert.equal(new Date(by("Piranesi").finished_at!).toISOString(), "2026-07-03T12:00:00.000Z");

  // Same file again: nothing changes.
  const again = await api("POST", `/connectors/${gr.id}/library`, { days, metrics: false, file: { items: 4, days: 3, to_read: 1 } });
  assert.deepEqual(again.json.watch_read, { created: 0, updated: 0 });

  // The nightly shelf (widget titles, review links, "4/5"): the same books, not new ones.
  const s1 = await tool({ kind: "book", title: "Dune (Dune #1)", maker: "Frank Herbert", status: "done", rating: "5/5", url: "https://www.goodreads.com/review/show/900", source: "goodreads" });
  assert.equal(s1.id, by("Dune (Dune, #1)").id);
  assert.equal(s1.action, "unchanged");
  // Started the to-read book: it moves along.
  const s2 = await tool({ kind: "book", title: "Tomorrow, and Tomorrow, and Tomorrow", status: "reading", url: "https://www.goodreads.com/review/show/901", source: "goodreads" });
  assert.equal(s2.id, by("Tomorrow, and Tomorrow, and Tomorrow").id);
  // Re-rated Piranesi on Goodreads since the export: the shelf's rating is newer.
  const s3 = await tool({ kind: "book", title: "Piranesi", status: "done", rating: "5/5", url: "https://www.goodreads.com/review/show/902", source: "goodreads" });
  assert.equal(s3.rating, 5);
  items = await list();
  assert.equal(items.length, 4);
  assert.equal(items.find((i) => i.id === s2.id)!.status, "reading");
  // An older export doesn't take Piranesi back to 4.
  const older = await api("POST", `/connectors/${gr.id}/library`, { days: [days[1]], metrics: false, file: { items: 2, days: 1, to_read: 0 } });
  assert.deepEqual(older.json.watch_read, { created: 0, updated: 0 });
  assert.equal((await list()).find((i) => i.title === "Piranesi")!.rating, 5);
});
