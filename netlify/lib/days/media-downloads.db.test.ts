// Real path for the Apple Music and BBC iPlayer imports: /api/days/import/apple_music and
// /api/days/import/iplayer through handleImportRoutes, importToDays, watch-read-sync and archive,
// on Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days/media-downloads.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties Days and Watch & read first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const fixtures = join(import.meta.dirname, "../../../lib/fixtures");
const opts = { tz: "Europe/London", today: "2026-11-08" };

const setup = async () => {
  const { handleImportRoutes } = await import("./import-routes");
  const { qRaw, q } = await import("../../../lib/db");
  for (const t of ["reading_items", "day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const call = async (format: string, method: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api/days/import${format ? `/${format}` : ""}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleImportRoutes(req, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s })))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  return { call, qRaw, q };
};

test("Apple Music: songs on days, Last.fm's own entry kept, nothing twice, Undo", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { call, qRaw, q } = await setup();
  const { parseAppleMusic, batchListenDays } = await import("../../../lib/apple-music-export");
  const { writeEntries } = await import("../../../lib/days");
  const dir = join(fixtures, "apple-music");
  const x = await parseAppleMusic(
    [
      { name: "a", text: readFileSync(join(dir, "play-activity.csv"), "utf8") },
      { name: "b", text: readFileSync(join(dir, "Apple Music - Play History Daily Tracks.csv"), "utf8") },
    ],
    opts,
  );

  // A Life log run already wrote Last.fm's Radiohead session on 14 March.
  await writeEntries([{ date: "2026-03-14", entry: { kind: "listened", source: "lastfm", external_id: "2026-03-14:radiohead", title: "In Rainbows", subtitle: "Radiohead", group: "Radiohead", count: 2 } }]);

  assert.equal((await call("apple_music", "GET")).json.last_import, null);
  const file = { items: 4, days: 3 };
  const ids: string[] = [];
  let added = 0;
  let skippedLastfm = 0;
  for (const b of batchListenDays(x.days)) {
    const r = await call("apple_music", "POST", { part: "days", days: b, file });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    added += r.json.added;
    skippedLastfm += r.json.skipped_lastfm;
    ids.push(...r.json.ids.entries);
  }
  assert.equal(added, 2, "Venom and Black Dog; Weird Fishes is Last.fm's");
  assert.equal(skippedLastfm, 1);
  const rows = await q<{ source: string; title: string; subtitle: string; minutes: number; count: number; date: string }>(
    `SELECT source, title, subtitle, minutes, count, to_char(date, 'YYYY-MM-DD') AS date FROM day_entries WHERE archived_at IS NULL ORDER BY date`,
  );
  assert.deepEqual(
    rows.map((r) => [r.date, r.source, r.title]),
    [
      ["2026-03-14", "lastfm", "In Rainbows"],
      ["2026-03-15", "apple_music", "Venom"],
      ["2026-03-16", "apple_music", "Black Dog - Live at Maida Vale"],
    ],
  );
  assert.equal(rows[2].minutes, 7);
  assert.equal(rows[2].count, 2);

  // The same export again: nothing new, same ids.
  for (const b of batchListenDays(x.days)) assert.equal((await call("apple_music", "POST", { part: "days", days: b, file })).json.added, 0);
  assert.equal((await call("", "GET")).json.imports.apple_music.items, 4, "remembered for Sources' From files");

  // Undo hides what it added; Last.fm's entry stays; a later import leaves them hidden.
  const undo = await call("apple_music", "POST", { part: "undo", entries: ids });
  assert.deepEqual(undo.json, { entries: 2, watch_read: 0 });
  assert.deepEqual((await qRaw<{ source: string }>(`SELECT source FROM day_entries WHERE archived_at IS NULL`)).map((r) => r.source), ["lastfm"]);
  for (const b of batchListenDays(x.days)) assert.equal((await call("apple_music", "POST", { part: "days", days: b, file })).json.added, 0);

  // Bad input is refused.
  assert.equal((await call("apple_music", "POST", { part: "days", days: [{ day: "2026-03-15", tracks: [{ key: "nope", title: "x" }] }] })).status, 400);
  assert.equal((await call("apple_music", "POST", { part: "else" })).status, 400);
});

test("iPlayer: programmes watched, series and films into Watch & read, news left out, nothing twice, Undo", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { call, qRaw, q } = await setup();
  const { parseIplayer, batchWatchDays } = await import("../../../lib/iplayer-export");
  const x = await parseIplayer([{ name: "v", text: readFileSync(join(fixtures, "iplayer/iPlayer Viewing History.csv"), "utf8") }], opts);
  const file = { items: 6, days: 4 };
  const r = await call("iplayer", "POST", { part: "days", days: batchWatchDays(x.days)[0], file });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.added, 5, "two Doctor Who episodes, Paddington, The Traitors, the news");
  assert.equal(r.json.watch_read.created, 3, "Doctor Who, Paddington, The Traitors; not the news");
  const { extKeys } = await import("../../../lib/days");
  const entry = (await q<{ kind: string; title: string; subtitle: string; url: string; minutes: number }>(`SELECT kind, title, subtitle, url, minutes FROM day_entries WHERE source = 'iplayer' AND ext_key = ANY($1::text[])`, [extKeys("iplayer", "2026-05-18:m001zgd2")]))[0];
  assert.deepEqual(entry, { kind: "watched", title: "Doctor Who", subtitle: "Series 14 · The Devil's Chord", url: "https://www.bbc.co.uk/iplayer/episode/m001zgd2", minutes: 45 });
  const items = (await q<{ title: string; kind: string; status: string }>(`SELECT title, kind, status FROM reading_items WHERE archived_at IS NULL`)).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(items, [
    { title: "Doctor Who", kind: "tv", status: "reading" },
    { title: "Paddington", kind: "film", status: "done" },
    { title: "The Traitors", kind: "tv", status: "reading" },
  ]);

  const again = await call("iplayer", "POST", { part: "days", days: batchWatchDays(x.days)[0], file });
  assert.equal(again.json.added, 0);
  assert.equal(again.json.watch_read.created, 0);

  const undo = await call("iplayer", "POST", { part: "undo", entries: r.json.ids.entries, watch_read: r.json.ids.watch_read });
  assert.deepEqual(undo.json, { entries: 5, watch_read: 3 });
  assert.equal((await qRaw(`SELECT 1 FROM day_entries WHERE archived_at IS NULL`)).length, 0);
  assert.equal((await qRaw(`SELECT 1 FROM reading_items WHERE archived_at IS NULL`)).length, 0);
});

test("Spotify streaming history: an album a day with hours, Last.fm's kept, a Life log day only gains times, nothing twice, Undo", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { call, qRaw, q } = await setup();
  const { parseSpotifyHistory } = await import("../../../lib/spotify-history");
  const { writeEntries } = await import("../../../lib/days");
  const play = (ts: string, track: string, artist: string, album: string) => ({ ts, ms_played: 200_000, master_metadata_track_name: track, master_metadata_album_artist_name: artist, master_metadata_album_album_name: album });
  const x = await parseSpotifyHistory(
    [
      {
        name: "Streaming_History_Audio_2026_0.json",
        text: JSON.stringify([
          play("2026-07-01T07:10:00Z", "Low Tide", "Mara Vell", "Tidal Hours"),
          play("2026-07-01T07:15:00Z", "Glass Hours", "Mara Vell", "Tidal Hours"),
          play("2026-07-01T19:00:00Z", "Undertow", "Ostra", "Amber Signals"),
          play("2026-07-02T20:00:00Z", "Soft", "Kaito Rhee", "Soft Neon"),
          play("2026-07-02T20:10:00Z", "Softer", "Kaito Rhee", "Soft Neon"),
        ]),
      },
    ],
    opts,
  );
  // Last.fm has Ostra on the 1st; a Life log run wrote Soft Neon on the 2nd under its own id.
  await writeEntries([
    { date: "2026-07-01", entry: { kind: "listened", source: "lastfm", external_id: "lf1", title: "Amber Signals", subtitle: "Ostra", group: "Ostra", count: 4 } },
    { date: "2026-07-02", entry: { kind: "listened", source: "spotify", external_id: "run-soft-neon", title: "Soft Neon", subtitle: "Kaito Rhee", group: "Kaito Rhee", count: 2 } },
  ]);
  const r = await call("spotify_history", "POST", { part: "days", days: x.days, file: { items: 5, days: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.added, 1, "only Tidal Hours on the 1st is new");
  assert.equal(r.json.skipped_lastfm, 1);
  const rows = await q<{ date: string; title: string; count: number; hours: string | null }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, title, count, hours FROM day_entries WHERE source = 'spotify' AND archived_at IS NULL ORDER BY date`);
  assert.deepEqual(rows.map((r) => [r.date, r.title, r.count]), [["2026-07-01", "Tidal Hours", 2], ["2026-07-02", "Soft Neon", 2]], "the run's row stays the only one on the 2nd, its count untouched");
  assert.equal(JSON.parse(rows[0].hours!)[8], 2, "8am in London");
  assert.equal(JSON.parse(rows[1].hours!)[21], 2, "the run's row gained its hours");
  const sealed = await qRaw<{ hours: string }>(`SELECT hours FROM day_entries WHERE source = 'spotify' AND hours IS NOT NULL LIMIT 1`);
  assert.match(sealed[0].hours, /^enc:v1:/);

  const again = await call("spotify_history", "POST", { part: "days", days: x.days, file: { items: 5, days: 2 } });
  assert.equal(again.json.added, 0, "the same file again adds nothing");
  assert.equal((await q<{ n: string }>(`SELECT count(*) AS n FROM day_entries WHERE source = 'spotify'`))[0].n, "2");

  const undo = await call("spotify_history", "POST", { part: "undo", entries: r.json.ids.entries });
  assert.equal(undo.json.entries, 1);
  assert.equal((await q<{ n: string }>(`SELECT count(*) AS n FROM day_entries WHERE source = 'spotify' AND archived_at IS NULL`))[0].n, "1", "the run's own entry stays");
  assert.equal((await call("spotify_history", "POST", { part: "days", days: [{ day: "2026-07-01", albums: [{ title: "", plays: 1 }] }] })).status, 400);
});
