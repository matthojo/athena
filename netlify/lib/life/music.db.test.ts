// Real path for Music: listened entries written through Days' own writeEntries (sealed at rest), then read
// through the real /api function: GET /api/life/music for each period and one artist, and Ask's taste tool
// with a period; the genre radar's book and its background lookup. Postgres with every migration; nothing outside is called.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/life/music.db.test.ts
// Empties day_entries and days first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

async function call(path: string, token = "master-token-for-tests") {
  const api = (await import("../../functions/api")).default;
  const res = await api(new Request(`https://athena.test/api${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } }), {} as never);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("Music: sealed listened entries grouped by artist and album, per period, with the span before", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { writeEntries } = await import("../../../lib/days");
  const { zonedToday } = await import("../../../lib/dates");
  const { tasteProfile } = await import("../../../lib/taste");
  for (const t of ["day_files", "day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  // Nothing yet: the empty state.
  let r = await call("/life/music?period=month");
  assert.equal(r.status, 200);
  assert.equal(r.json.has_music, false);

  const today = zonedToday(new Date(), "Europe/London");
  const month = today.slice(0, 7);
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  const thisMonth = `${month}-01`;
  const listened = (date: string, source: string, id: string, title: string, artist: string, count?: number) => ({ date, entry: { kind: "listened" as const, source, external_id: id, title, subtitle: artist, group: artist, ...(count ? { count } : {}) } });
  const res = await writeEntries([
    listened(thisMonth, "lastfm", "a1", "Tidal Hours", "Mara Vell", 12),
    listened(today, "lastfm", "a2", "Tidal Hours", "Mara Vell", 3),
    listened(today, "apple_music", "b1", "Amber Signals", "Ostra"), // no count: one play
    listened(today, "lastfm", "c1", "Soft Neon", "Kaito Rhee", 5), // first ever play: new this month
    listened(`${lastYear}-03-04`, "lastfm", "d1", "Field Notes", "Ostra", 40),
    listened(`${lastYear}-06-04`, "lastfm", "d2", "Lowlight", "Mara Vell", 7),
    listened(today, "overcast", "ep:1", "The fall of Rome", "History Hour"), // a podcast: not music
    listened(today, "lastfm", "e1", "Hidden Album", "Hidden Artist", 99), // archived below
    { date: today, entry: { kind: "watched" as const, source: "trakt", external_id: "w1", title: "Northern Lines", subtitle: "Mara Vell" } },
  ]);
  assert.equal(res.created, 9);
  await qRaw(`UPDATE day_entries SET archived_at = now() WHERE source = 'lastfm' AND kind = 'listened' AND count = 99`);

  // Sealed at rest: the artist and album are ciphertext in the table.
  const raw = await qRaw<{ title: string; subtitle: string; grp: string }>(`SELECT title, subtitle, grp FROM day_entries WHERE kind = 'listened' LIMIT 1`);
  for (const v of Object.values(raw[0])) assert.match(v, /^enc:v1:/);

  r = await call("/life/music?period=month");
  assert.equal(r.status, 200);
  const m = r.json as { plays: number; artists: number; top_artists: Array<{ name: string; plays: number; first: string }>; top_albums: Array<{ title: string; plays: number }>; new_artists: Array<{ name: string }>; recent: Array<{ date: string; plays: number }>; periods: Array<{ id: string }>; previous: { plays: number } };
  assert.equal(m.plays, 21, "12 + 3 + 1 + 5; no podcast, no archived, no film");
  assert.deepEqual(
    m.top_artists.map((a) => [a.name, a.plays]),
    [["Mara Vell", 15], ["Kaito Rhee", 5], ["Ostra", 1]]
  );
  assert.equal(m.top_artists[2].first, `${lastYear}-03-04`);
  assert.equal(m.top_albums[0].title, "Tidal Hours");
  assert.ok(!m.top_albums.some((x) => x.title === "Amber Signals"), "Apple Music's rows are tracks, not albums");
  assert.deepEqual(m.new_artists.map((a) => a.name), ["Kaito Rhee"]);
  assert.equal(m.recent[0].date, today);
  assert.ok(m.periods.some((p) => p.id === lastYear));
  assert.equal(m.previous.plays, 0);

  const past = (await call(`/life/music?period=${lastYear}`)).json as { plays: number; top_artists: Array<{ name: string }>; new_artists: Array<{ name: string }>; timeline: { unit: string; points: unknown[] } };
  assert.equal(past.plays, 47);
  assert.deepEqual(past.top_artists.map((a) => a.name), ["Ostra", "Mara Vell"]);
  assert.equal(past.timeline.unit, "month");
  assert.equal(past.timeline.points.length, 12);
  const all = (await call("/life/music?period=all")).json as { plays: number; new_artists: unknown[] };
  assert.equal(all.plays, 68);
  assert.deepEqual(all.new_artists, []);

  // One artist, for the sheet; a name never played is 404; a capture key can't read it.
  const a = await call(`/life/music?artist=${encodeURIComponent("mara vell")}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.plays, 22);
  assert.equal(a.json.first, `${lastYear}-06-04`);
  assert.equal(a.json.last, today);
  assert.equal((await call("/life/music?artist=Nobody")).status, 404);
  assert.equal((await call("/life/music?artist=")).status, 400);
  assert.equal((await call("/life/music?period=month", "wrong-token")).status, 401);

  // ---- when: plays per hour, written, reloaded and filled in ----
  const { fillEntryHours, readEntry } = await import("../../../lib/days");
  const hrs = (h: Record<number, number>) => Array.from({ length: 24 }, (_, i) => h[i] ?? 0);
  // A history load wrote Tidal Hours on the 1st without times; loading again brings them, count untouched, no new row.
  const before = (await qRaw<{ n: string }>(`SELECT count(*) AS n FROM day_entries`))[0].n;
  const again = await writeEntries([listened(thisMonth, "lastfm", "a1", "Tidal Hours", "Mara Vell", 12)].map((x) => ({ ...x, entry: { ...x.entry, hours: hrs({ 8: 4, 20: 8 }) } })), { backfilled: true });
  assert.equal(again.updated, 1);
  assert.equal((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM day_entries`))[0].n, before, "no duplicates");
  const sealedHours = await qRaw<{ hours: string; count: number }>(`SELECT hours, count FROM day_entries WHERE source = 'lastfm' AND date = $1::date AND count = 12`, [thisMonth]);
  assert.match(sealedHours[0].hours, /^enc:v1:/, "hours are sealed like the entry's words");
  assert.equal(sealedHours[0].count, 12);
  // The same again: nothing changes.
  const same = await writeEntries([listened(thisMonth, "lastfm", "a1", "Tidal Hours", "Mara Vell", 12)].map((x) => ({ ...x, entry: { ...x.entry, hours: hrs({ 8: 4, 20: 8 }) } })));
  assert.equal(same.unchanged, 1);
  // A Life log run's own row (its own id) gains hours from the history load's matching entry; the count stays the run's.
  await writeEntries([listened(today, "lastfm", "run-scrobble-77", "Soft Neon", "Kaito Rhee", 6)]);
  const filled = await fillEntryHours([listened(today, "lastfm", `${today}:soft-neon`, "soft neon", "KAITO RHEE", 5)].map((x) => ({ ...x, entry: { ...x.entry, hours: hrs({ 21: 5 }) } })));
  assert.equal(filled, 1, "one row per item: an entry from the history load fills one of the day's rows");
  assert.equal((await fillEntryHours([listened(today, "lastfm", "zz", "Nothing Like It", "Nobody", 1)].map((x) => ({ ...x, entry: { ...x.entry, hours: hrs({ 1: 1 }) } })))), 0, "no match, no row");
  const counts = await qRaw<{ count: number }>(`SELECT count FROM day_entries WHERE source = 'lastfm' AND date = $1::date AND kind = 'listened' AND archived_at IS NULL ORDER BY count`, [today]);
  assert.deepEqual(counts.map((c) => c.count), [3, 5, 6], "counts untouched");
  // The run's tool takes hours only on music, and only well formed.
  assert.deepEqual(readEntry({ kind: "listened", source: "lastfm", external_id: "x", title: "Low", hours: hrs({ 9: 2 }) }).hours, hrs({ 9: 2 }));
  assert.equal(readEntry({ kind: "watched", source: "trakt", external_id: "x", title: "Andor", hours: hrs({ 9: 2 }) }).hours, undefined);
  assert.equal(readEntry({ kind: "listened", source: "lastfm", external_id: "x", title: "Low", hours: [1, 2] }).hours, undefined);

  const withTimes = (await call("/life/music?period=month")).json as { plays: number; when: { timed: number; cells: number[][]; takeaway: string } };
  assert.equal(withTimes.when.timed, 12 + 5, "Tidal Hours on the 1st and Soft Neon today");
  const dow = (new Date(`${thisMonth}T12:00:00Z`).getUTCDay() + 6) % 7;
  assert.equal(withTimes.when.cells[dow][20], 8);
  assert.ok(withTimes.when.takeaway.startsWith("You play most"));

  // Ask's taste tool, narrowed to a stretch of time.
  const t = await tasteProfile({ area: "music", from: `${lastYear}-01-01`, to: `${lastYear}-12-31` });
  assert.deepEqual(t.music?.artists_played_most, [{ artist: "Ostra", plays: 40 }, { artist: "Mara Vell", plays: 7 }]);
  const whole = await tasteProfile({ area: "music" });
  assert.deepEqual(whole.music?.artists_played_most.slice(0, 2), [{ artist: "Ostra", plays: 41 }, { artist: "Mara Vell", plays: 22 }]);
});

test("Music genres: the book sealed in one settings row, folded into families on read, lookups only after the reply", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { writeEntries } = await import("../../../lib/days");
  const { zonedToday } = await import("../../../lib/dates");
  const { saveGenres, loadGenreBook, GENRES_KEY } = await import("../../../lib/music-genre-store");
  for (const t of ["day_files", "day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key = $1`, [GENRES_KEY]);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const today = zonedToday(new Date(), "Europe/London");
  const listened = (id: string, title: string, artist: string, count: number) => ({ date: today, entry: { kind: "listened" as const, source: "lastfm", external_id: id, title, subtitle: artist, group: artist, count } });
  await writeEntries([listened("g1", "In Rainbows", "Radiohead", 6), listened("g2", "Promises", "Floating Points", 3), listened("g3", "Grey Area", "Little Simz", 2), listened("g4", "Isles", "Bicep", 1)]);

  const now = new Date().toISOString();
  await saveGenres({
    radiohead: { name: "Radiohead", genres: ["alternative rock", "art rock", "electronic"], from: "musicbrainz", checked: now },
    "floating points": { name: "Floating Points", genres: ["electronic", "jazz"], from: "spotify", checked: now },
  });
  // A second write adds to the book rather than replacing it.
  await saveGenres({ "little simz": { name: "Little Simz", genres: ["hip hop", "neo soul"], from: "musicbrainz", checked: now } });
  assert.equal(Object.keys(await loadGenreBook()).length, 3);
  const [row] = await qRaw<{ value: { sealed: string } }>(`SELECT value FROM settings WHERE key = $1`, [GENRES_KEY]);
  assert.match(row.value.sealed, /^enc:v1:/, "sealed at rest");
  assert.ok(!JSON.stringify(row.value).includes("Radiohead"));

  // The lookup is handed only the artists not known yet, and only through waitUntil (after the reply).
  // Nothing leaves the machine: no Spotify account, and MusicBrainz is stubbed at fetch.
  const { artDeps } = await import("../../../lib/art");
  const was = { fetch: artDeps.fetch, assertPublic: artDeps.assertPublic };
  const sent: string[] = [];
  artDeps.assertPublic = async () => undefined;
  artDeps.fetch = async (input) => {
    // Covers are asked of Deezer in the same background turn: nothing there here.
    if (new URL(String(input)).host !== "musicbrainz.org") return new Response("not found", { status: 404 });
    sent.push(String(input));
    return new Response(JSON.stringify({ artists: [{ name: "Bicep", score: 100, tags: [{ name: "electronic", count: 4 }, { name: "house", count: 2 }] }] }), { headers: { "content-type": "application/json" } });
  };
  const asked: Promise<unknown>[] = [];
  const api = (await import("../../functions/api")).default;
  const res = await api(new Request("https://athena.test/api/life/music?period=month", { headers: { Authorization: "Bearer master-token-for-tests" } }), { waitUntil: (p: Promise<unknown>) => void asked.push(p) } as never);
  const m = (await res.json()) as { genres: { now: { genres: Array<{ genre: string; plays: number }>; known: number }; covered: number; learning: number } };
  assert.deepEqual(m.genres.now.genres, [
    { genre: "Electronic", plays: 9 },
    { genre: "Rock", plays: 6 },
    { genre: "Jazz", plays: 3 },
    { genre: "Hip hop", plays: 2 },
    { genre: "Soul & R&B", plays: 2 },
  ]);
  assert.equal(m.genres.now.known, 11);
  assert.equal(m.genres.covered, 11 / 12);
  assert.equal(m.genres.learning, 1, "Bicep isn't looked up yet");
  assert.equal(asked.length, 2, "genres and covers, both in the background");
  await Promise.all(asked);
  artDeps.fetch = was.fetch;
  artDeps.assertPublic = was.assertPublic;
  assert.equal(sent.length, 1);
  const q = new URL(sent[0]);
  assert.equal(q.host, "musicbrainz.org");
  assert.equal(q.searchParams.get("query"), 'artist:"Bicep"', "only the artist's name is sent");
  assert.deepEqual((await loadGenreBook()).bicep?.genres, ["electronic", "house"]);
  // The next load has it.
  const again = (await (await api(new Request("https://athena.test/api/life/music?period=month", { headers: { Authorization: "Bearer master-token-for-tests" } }), {} as never)).json()) as typeof m;
  assert.equal(again.genres.learning, 0);
  assert.equal(again.genres.covered, 1);
  await qRaw(`DELETE FROM settings WHERE key = $1`, [GENRES_KEY]);
});

test("Music covers: plays with none get their album's from Deezer after the reply, an artist with none their best-known album's", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { writeEntries } = await import("../../../lib/days");
  const { zonedToday } = await import("../../../lib/dates");
  const sharp = (await import("sharp")).default;
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const A = await import("../../../lib/art");
  const dir = mkdtempSync(join(tmpdir(), "athena-blobs-"));
  const server = new BlobsServer({ directory: dir, token: "blobs-token" });
  const { port } = await server.start();
  A.useArtStore(() => getStore({ name: "athena-art", siteID: "athena-test", token: "blobs-token", edgeURL: `http://localhost:${port}` }));
  const was = { fetch: A.artDeps.fetch, assertPublic: A.artDeps.assertPublic };
  try {
    for (const t of ["day_files", "day_entries", "days", "art_sources", "art"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const today = zonedToday(new Date(), "Europe/London");
    const listened = (source: string, id: string, title: string, artist: string, count: number) => ({ date: today, entry: { kind: "listened" as const, source, external_id: id, title, subtitle: artist, group: artist, count } });
    await writeEntries([
      listened("spotify_history", "c1", "Untrue", "Burial", 9), // an album with no cover from its source
      listened("apple_music", "c2", "Glue", "Bicep", 4), // a track: its album's cover
      listened("lastfm", "c3", "Khruangbin", "Khruangbin", 3), // titled with the artist: their best-known album
      listened("overcast", "c4", "Episode 1", "A Podcast", 2), // a podcast: never
    ]);

    const cover = (colour: string) => sharp({ create: { width: 300, height: 300, channels: 3, background: colour } }).jpeg().toBuffer();
    const images: Record<string, Buffer> = { untrue: await cover("#203040"), glue: await cover("#702030"), khruangbin: await cover("#305020") };
    const img = (id: string) => `https://cdn-images.dzcdn.net/images/cover/${id}/1000x1000-000000-80-0-0.jpg`;
    const sent: string[] = [];
    A.artDeps.assertPublic = async () => undefined;
    A.artDeps.fetch = async (input) => {
      const u = new URL(String(input));
      sent.push(u.host === "api.deezer.com" ? `${u.pathname} ${u.searchParams.get("q")}` : u.pathname);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (u.pathname === "/search/album" && /Burial/.test(u.searchParams.get("q")!)) return reply({ data: [{ title: "Untrue", artist: { name: "Burial" }, cover_xl: img("untrue") }] });
      if (u.pathname === "/search/track") return reply({ data: [{ title: "Glue", artist: { name: "Bicep" }, album: { title: "Glue", cover_xl: img("glue") } }] });
      if (u.pathname === "/search/album" && /Khruangbin/.test(u.searchParams.get("q")!)) return reply({ data: [{ title: "Mordechai", artist: { name: "Khruangbin" }, cover_xl: img("khruangbin") }] });
      const id = /\/cover\/(\w+)\//.exec(u.pathname)?.[1];
      if (id && images[id]) return new Response(new Uint8Array(images[id]), { headers: { "content-type": "image/jpeg" } });
      return new Response("not found", { status: 404 });
    };
    const api = (await import("../../functions/api")).default;
    type Page = { top_artists: Array<{ name: string; art?: { id: string } }>; top_albums: Array<{ title: string; art?: { id: string } }> };
    const load = async (waitUntil?: (p: Promise<unknown>) => void) => (await (await api(new Request("https://athena.test/api/life/music?period=month", { headers: { Authorization: "Bearer master-token-for-tests" } }), (waitUntil ? { waitUntil } : {}) as never)).json()) as Page;

    // First load: nothing yet, and the lookups go after the reply.
    const later: Promise<unknown>[] = [];
    const first = await load((p) => void later.push(p));
    assert.ok(first.top_artists.every((a) => !a.art));
    assert.equal(sent.length, 0, "nothing fetched before the reply");
    await Promise.all(later);
    assert.ok(sent.some((x) => x.startsWith("/search/album") && x.includes('artist:"Burial" album:"Untrue"')));
    assert.ok(sent.some((x) => x.startsWith("/search/track") && x.includes('track:"Glue"')));
    assert.ok(sent.some((x) => x.startsWith("/search/album") && x.includes('artist:"Khruangbin"') && !x.includes("album:")));
    assert.ok(!sent.some((x) => x.includes("Podcast")), "a podcast is never looked up");

    // Next load: every artist wears a cover, from what was kept; nothing is fetched again.
    const before = sent.length;
    const next = await load(() => assert.fail("nothing left to look up"));
    assert.deepEqual(next.top_artists.map((a) => [a.name, !!a.art]), [["Burial", true], ["Bicep", true], ["Khruangbin", true]]);
    assert.ok(next.top_albums.find((a) => a.title === "Untrue")?.art);
    assert.equal(sent.length, before);
    // The artist's sheet has its stand-in too.
    const sheet = (await (await api(new Request("https://athena.test/api/life/music?artist=Khruangbin", { headers: { Authorization: "Bearer master-token-for-tests" } }), {} as never)).json()) as { art?: { id: string } };
    assert.ok(sheet.art?.id);
  } finally {
    A.artDeps.fetch = was.fetch;
    A.artDeps.assertPublic = was.assertPublic;
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
