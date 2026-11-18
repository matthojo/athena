// Real path for the Netflix viewing import: the real /api routes, the real Life log save (AthenaWriter), Watch & read through watch-read-sync, and Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/netflix-history.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector, Life log and Watch & read tables first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const setup = async () => {
  const { handleConnectorRoutes } = await import("./routes");
  const { qRaw } = await import("../../../lib/db");
  for (const t of ["custom_values", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.%'`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  return async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    try {
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 400, json: { error: (error as Error).message } };
    }
  };
};

// One profile's "Download all", as Netflix writes it for the UK: newest first, day/month/year.
const PROFILE_ONE = [
  "Title,Date",
  '"Slow Horses: Season 4: Hello Goodbye","14/03/2024"',
  '"Slow Horses: Season 4: Identity Theft","14/03/2024"',
  '"Glass Onion: A Knives Out Mystery","14/03/2024"',
  '"Slow Horses: Season 4: Identity Theft","13/03/2024"',
  '"Baby Reindeer: Limited Series: Episode 1","02/05/2023"',
  '"Roma","01/05/2023"',
].join("\r\n");
// A second profile: one episode in common on the 14th, one it watched alone.
const PROFILE_TWO = ["Title,Date", '"Slow Horses: Season 4: Cleaners","14/03/2024"', '"Slow Horses: Season 4: Hello Goodbye","14/03/2024"'].join("\n");

test("Netflix: each episode and film a Day entry, folded with Trakt, Watch & read filled, idempotent", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = await setup();
  const { AthenaWriter } = await import("./runner");
  const C = await import("../../../lib/connectors");
  const { q, qRaw } = await import("../../../lib/db");
  const { upsertReadingItem } = await import("../../../lib/memory");
  const N = await import("../../../lib/netflix-csv");

  // An import-only account: no address, no key, and it checks out with no tools.
  const nf = (await api("POST", "/connectors", { provider: "netflix", name: "Netflix", account_label: "personal" })).json;
  assert.ok(nf.id, JSON.stringify(nf));
  assert.equal(nf.url, "https://www.netflix.com/");
  const checked = await api("POST", `/connectors/${nf.id}/check`);
  assert.equal(checked.status, 200, JSON.stringify(checked.json));
  assert.equal(checked.json.status, "connected");
  assert.deepEqual(checked.json.tools, []);
  const gr = (await api("POST", "/connectors", { provider: "goodreads", name: "Goodreads", account_label: "personal", url: "https://www.goodreads.com/user/show/12345-jordan" })).json;

  // Only Netflix accounts have it.
  assert.equal((await api("GET", `/connectors/${gr.id}/viewing`)).status, 404);
  assert.equal((await api("GET", `/connectors/${nf.id}/library`)).status, 404);

  // No Life log yet: the days wait under the source one would get.
  assert.deepEqual((await api("GET", `/connectors/${nf.id}/viewing`)).json, { collection: null, source: "life-log-personal", last_import: null });
  const life = (await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [gr.id], schedule: "daily", run_at: "23:30" })).json;
  assert.deepEqual((await api("GET", `/connectors/${nf.id}/viewing`)).json, { collection: { id: life.id, name: "Life log" }, source: life.source, last_import: null });

  // Bad input is refused before anything is written.
  for (const days of [[], [{ day: "2024-03-14", watched: [] }], [{ day: "14/03/2024", watched: [{ title: "Roma" }] }], [{ day: "2024-03-14", watched: [{ title: "" }] }], [{ day: "2024-03-14", watched: [{ title: "X", episodes: [] }] }]]) {
    assert.equal((await api("POST", `/connectors/${nf.id}/viewing`, { days })).status, 400, JSON.stringify(days));
  }

  // A Life log run already wrote 14 March from Trakt: two episodes of Slow Horses, rated, and a book.
  const writer = (now: Date) => new AthenaWriter(life, "00000000-0000-0000-0000-000000000000", { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0, skipped_dismissed: 0 } as never, now, "Europe/London");
  const traktDay = {
    date: "2024-03-14",
    entries: [
      { kind: "watched", source: "trakt", external_id: "h-1", title: "Slow Horses", subtitle: "S4E1 · Hello Goodbye", rating: "8/10", url: "https://trakt.tv/shows/slow-horses", group: "Slow Horses" },
      { kind: "watched", source: "trakt", external_id: "h-2", title: "Slow Horses", subtitle: "S4E2 · Identity Theft", url: "https://trakt.tv/shows/slow-horses", group: "Slow Horses" },
      { kind: "read", source: "goodreads", external_id: "book:1", title: "Dune", subtitle: "Frank Herbert", url: "https://www.goodreads.com/review/show/1" },
    ],
  };
  const save14 = () => writer(new Date("2024-03-15T09:00:00Z")).run("athena_day_entry", traktDay);
  await save14();

  // The owner already has Roma in Watch & read, marked "watching" by hand, and Glass Onion to watch.
  const roma = await upsertReadingItem({ title: "Roma", kind: "film", status: "reading" });
  await upsertReadingItem({ title: "Glass Onion: A Knives Out Mystery", kind: "film", status: "queued" });

  // Parsed and grouped the way the app does it.
  const one = N.parseViewingActivity(PROFILE_ONE, { locale: "en-GB", today: "2026-11-07" });
  const days = N.groupViewsByDay(one.views);
  assert.deepEqual(days.map((d) => d.day), ["2023-05-01", "2023-05-02", "2024-03-13", "2024-03-14"]);
  const file = { items: one.views.length, days: days.length };
  const first = await api("POST", `/connectors/${nf.id}/viewing`, { days, file });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json, { days_created: 3, days_updated: 1, days_unchanged: 0, days_skipped: 0, added: 6, added_films: 2, watch_read: { created: 2, updated: 1 } });

  const { getDay } = await import("../../../lib/days");
  const entriesOn = async (day: string) => (await getDay(day, { tz: "Europe/London", health: false, places: false }))!.entries;
  const show = (e: { source: string; title: string; subtitle?: string; rating?: number }) => [e.source, e.title, e.subtitle ?? null, e.rating ?? null];
  // 14 March: Trakt's two episodes stay one each (Netflix's copies fold into them), Netflix adds the film.
  assert.deepEqual((await entriesOn("2024-03-14")).map(show), [
    ["trakt", "Slow Horses", "S4E1 · Hello Goodbye", 4],
    ["trakt", "Slow Horses", "S4E2 · Identity Theft", null],
    ["goodreads", "Dune", "Frank Herbert", null],
    ["netflix", "Glass Onion: A Knives Out Mystery", null, null],
  ]);
  assert.deepEqual((await entriesOn("2024-03-13")).map(show), [["netflix", "Slow Horses", "S4 · Identity Theft", null]]);
  assert.deepEqual((await entriesOn("2023-05-02")).map(show), [["netflix", "Baby Reindeer", "Episode 1", null]]);
  assert.deepEqual((await entriesOn("2023-05-01")).map(show), [["netflix", "Roma", null, null]]);
  assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE source LIKE 'life-log%'`))[0].n, 0, "no day notes");
  // Sealed at rest.
  for (const r of await qRaw<{ title: string; subtitle: string | null }>(`SELECT title, subtitle FROM day_entries`)) {
    assert.match(r.title, /^enc:v1:/);
    assert.ok(!r.subtitle || r.subtitle.startsWith("enc:v1:"));
  }

  // Watch & read: one item per show and film, no rating: films watched, shows watching; the owner's "watching" Roma stands.
  type R = { id: string; title: string; kind: string; status: string; finished_at: Date | null };
  // Titles are sealed, so sorted here rather than in SQL.
  const items = async () => (await q<R>(`SELECT id, title, kind, status, finished_at FROM reading_items`)).sort((a, b) => a.title.localeCompare(b.title));
  const wr = await items();
  assert.deepEqual(
    wr.map((r) => [r.title, r.kind, r.status]),
    [["Baby Reindeer", "tv", "reading"], ["Glass Onion: A Knives Out Mystery", "film", "done"], ["Roma", "film", "reading"], ["Slow Horses", "tv", "reading"]],
  );
  assert.equal(wr.find((r) => r.id === roma.id)?.status, "reading", "the owner's edit stands");
  assert.equal(wr.find((r) => r.title === "Slow Horses")?.finished_at, null, "watching, not finished");
  assert.equal(wr.find((r) => r.title === "Glass Onion: A Knives Out Mystery")?.finished_at?.toISOString(), "2024-03-14T12:00:00.000Z");
  assert.equal(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM custom_values`))[0].n), 0, "no rating from Netflix");

  // A Life log run saves 14 March again: nothing changes.
  assert.deepEqual(JSON.parse(await save14()).unchanged, 3);

  // The same file again: nothing.
  const again = await api("POST", `/connectors/${nf.id}/viewing`, { days, file });
  assert.deepEqual(again.json, { days_created: 0, days_updated: 0, days_unchanged: 4, days_skipped: 0, added: 0, added_films: 0, watch_read: { created: 0, updated: 0 } });
  assert.deepEqual((await items()).map((r) => [r.title, r.status]), wr.map((r) => [r.title, r.status]));

  // The owner marks Slow Horses watched; no import moves it back.
  await upsertReadingItem({ id: wr.find((r) => r.title === "Slow Horses")!.id, status: "done" });
  // A second profile: only its new episode is added.
  const two = N.groupViewsByDay(N.parseViewingActivity(PROFILE_TWO, { locale: "en-GB" }).views);
  const second = await api("POST", `/connectors/${nf.id}/viewing`, { days: two, file: { items: 2, days: 1 } });
  assert.deepEqual(second.json, { days_created: 0, days_updated: 1, days_unchanged: 0, days_skipped: 0, added: 1, added_films: 0, watch_read: { created: 0, updated: 0 } });
  assert.ok((await entriesOn("2024-03-14")).some((e) => e.source === "netflix" && e.subtitle === "S4 · Cleaners"));
  assert.equal((await items()).length, 4);
  assert.equal((await items()).find((r) => r.title === "Slow Horses")?.status, "done", "the owner's Watched stands");

  // An entry the owner hid stays hidden.
  const { hideEntry } = await import("../../../lib/days");
  await hideEntry((await entriesOn("2024-03-13"))[0].id);
  const hidden = await api("POST", `/connectors/${nf.id}/viewing`, { days: [{ day: "2024-03-13", watched: [{ title: "Slow Horses", season: "S4", episodes: ["Identity Theft"] }] }] });
  assert.equal(hidden.json.days_skipped, 1);
  assert.deepEqual(await entriesOn("2024-03-13"), []);

  // Every device sees when it last imported.
  const last = (await api("GET", `/connectors/${nf.id}/viewing`)).json.last_import;
  assert.equal(last.items, 2);
  assert.ok(Date.now() - Date.parse(last.at) < 60_000);
});
