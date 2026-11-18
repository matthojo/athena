// Run: npx tsx --test netlify/lib/connectors/backfill.test.ts
// History on connect: what Trakt and YouTube rows become, and how the streams page. No database (backfill.db.test.ts has the engine).
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyRow, ratingRow, traktStreams, watchlistRow, type TraktRow } from "./trakt-backfill";
import { subscriptionEntry, videoEntry, youtubeStreams } from "./youtube-backfill";
import { directFor } from "./direct";

const TZ = "Europe/London";

test("Trakt history: an episode is the show with S·E and title on the owner's day; a film its title and year", () => {
  const ep = historyRow({ id: 901, watched_at: "2019-03-02T23:30:00.000Z", type: "episode", show: { title: "Severance", year: 2022, ids: { slug: "severance", trakt: 7 } }, episode: { season: 1, number: 3, title: "In Perpetuity" } }, "Asia/Tokyo");
  assert.equal(ep.entry!.date, "2019-03-03");
  assert.deepEqual(ep.entry!.entry, {
    kind: "watched", source: "trakt", external_id: "history:901", title: "Severance", subtitle: "S1E3 · In Perpetuity", at: "2019-03-02T23:30:00.000Z",
    url: "https://trakt.tv/shows/severance/seasons/1/episodes/3", group: "Severance",
  });
  assert.deepEqual(ep.item, { kind: "tv", title: "Severance", year: 2022, status: "reading", at: "2019-03-02T23:30:00.000Z", url: "https://trakt.tv/shows/severance", external_id: "show:7", source: "trakt" });

  const film = historyRow({ id: 902, watched_at: "2019-03-10T20:00:00.000Z", type: "movie", movie: { title: "Arrival", year: 2016, ids: { slug: "arrival-2016", trakt: 9 } } }, TZ);
  assert.equal(film.entry!.entry.subtitle, "2016");
  assert.equal(film.item!.status, "done");
  assert.equal(film.item!.external_id, "movie:9");
  // No id or date: nothing.
  assert.deepEqual(historyRow({ watched_at: "2019-03-10T20:00:00Z", movie: { title: "X" } }, TZ), {});
});

test("Trakt ratings: films and shows rated go into Watch & read as watched; episodes are left out", () => {
  assert.deepEqual(ratingRow({ type: "movie", rating: 9, rated_at: "2020-01-01T00:00:00Z", movie: { title: "Arrival", year: 2016, ids: { slug: "arrival-2016", trakt: 9 } } }), {
    kind: "film", title: "Arrival", year: 2016, status: "done", rating: 9, at: "2020-01-01T00:00:00Z", url: "https://trakt.tv/movies/arrival-2016", external_id: "movie:9", source: "trakt",
  });
  assert.equal(ratingRow({ type: "show", rating: 8, show: { title: "Andor", ids: { trakt: 3 } } })!.status, "done");
  assert.equal(ratingRow({ type: "episode", rating: 10, show: { title: "Andor" }, episode: { season: 1, number: 1 } }), null);
});

test("Trakt watchlist: a to-watch item and a saved entry on the day it was added", () => {
  const r = watchlistRow({ type: "movie", listed_at: "2021-05-04T10:00:00Z", movie: { title: "Dune", year: 2021, ids: { slug: "dune-2021", trakt: 11 } } }, TZ);
  assert.equal(r.item!.status, "queued");
  assert.equal(r.entry!.date, "2021-05-04");
  assert.equal(r.entry!.entry.kind, "saved");
  assert.equal(r.entry!.entry.external_id, "watchlist:movie:11");
});

test("Trakt streams page by number until Trakt's last page, and a page shows each title once", async () => {
  const calls: Array<{ path: string; page: unknown }> = [];
  const rows: TraktRow[] = [1, 2, 3].map((n) => ({ id: n, watched_at: `2019-0${n}-01T12:00:00Z`, type: "episode", show: { title: "Andor", ids: { trakt: 3 } }, episode: { season: 1, number: n } }));
  const session = {
    get: async <T>(path: string, params: Record<string, string | number | undefined> = {}) => {
      calls.push({ path, page: params.page });
      return { items: (path === "/users/me/history/" ? rows : []) as T, page: Number(params.page), pageCount: 2, bytes: 0 };
    },
  };
  const [history, watchedMovies, watchedShows, ratings, watchlist] = traktStreams(session as never, TZ);
  const p1 = await history.page(undefined);
  assert.equal(p1.read, 3);
  assert.equal(p1.next, "2");
  assert.equal(p1.entries.length, 3);
  assert.equal(p1.watchRead!.length, 1, "the show once, not once per episode");
  const p2 = await history.page("2");
  assert.equal(p2.next, undefined, "page 2 of 2 is the last");
  assert.equal((await watchedMovies.page(undefined)).read, 0, "history has items: the watched fallback isn't used");
  assert.equal((await watchedShows.page(undefined)).read, 0);
  assert.equal((await ratings.page(undefined)).next, undefined, "an empty page ends the stream");
  assert.equal((await watchlist.page(undefined)).read, 0);
  assert.deepEqual(calls.map((c) => `${c.path}#${c.page}`), ["/users/me/history/#1", "/users/me/history/#2", "/users/me/history/#1", "/users/me/history/#1", "/users/me/ratings/#1", "/users/me/watchlist/movie,show/added#1"]);
  await assert.rejects(history.page("x"), /lost its place/);
});

test("Trakt: when history comes back empty, films and shows load from /users/{id}/watched instead", async () => {
  const calls: string[] = [];
  const movies: TraktRow[] = [{ plays: 2, last_watched_at: "2018-02-03T20:00:00Z", movie: { title: "Arrival", year: 2016, ids: { slug: "arrival-2016", trakt: 7 } } }];
  const shows: TraktRow[] = [
    { plays: 2, last_watched_at: "2020-05-02T21:00:00Z", show: { title: "Andor", year: 2022, ids: { slug: "andor", trakt: 3 } }, seasons: [{ number: 1, episodes: [{ number: 1, plays: 1, last_watched_at: "2020-05-01T21:00:00Z" }, { number: 2, plays: 1, last_watched_at: "2020-05-02T21:00:00Z" }] }] },
    { plays: 1, last_watched_at: "2019-01-01T21:00:00Z", show: { title: "No seasons sent", ids: { trakt: 4 } } },
  ];
  const session = {
    get: async <T>(path: string, params: Record<string, string | number | undefined> = {}) => {
      calls.push(`${path}#${params.page}`);
      const items = path === "/users/me/watched/movies" ? movies : path === "/users/me/watched/shows" ? shows : [];
      return { items: items as T, page: 1, pageCount: 1, itemCount: path === "/users/me/history/" ? 0 : items.length, bytes: 0 };
    },
  };
  const [, watchedMovies, watchedShows] = traktStreams(session as never, TZ);
  const m = await watchedMovies.page(undefined);
  assert.equal(m.read, 1);
  assert.deepEqual(m.entries.map((e) => [e.date, e.entry.external_id]), [["2018-02-03", "watched:movie:7"]]);
  assert.equal(m.watchRead![0].status, "done");
  const s = await watchedShows.page(undefined);
  assert.deepEqual(s.entries.map((e) => [e.date, e.entry.external_id, e.entry.subtitle]), [
    ["2020-05-01", "watched:episode:3:1:1", "S1E1"],
    ["2020-05-02", "watched:episode:3:1:2", "S1E2"],
    ["2019-01-01", "watched:show:4", undefined],
  ]);
  assert.equal(s.next, undefined);
  assert.deepEqual(calls, ["/users/me/history/#1", "/users/me/watched/movies#1", "/users/me/history/#1", "/users/me/watched/shows#1"]);
});

test("YouTube: a like and a playlist add are saved entries; deleted and private videos are left out", () => {
  const like = videoEntry({ snippet: { title: "How rivers move", publishedAt: "2019-03-14T09:00:00Z", videoOwnerChannelTitle: "Practical Engineering", resourceId: { videoId: "abcdefghijk" } } }, TZ, { id: "LL", likes: true });
  assert.deepEqual(like, {
    date: "2019-03-14",
    entry: { kind: "saved", source: "youtube", external_id: "like:abcdefghijk", title: "How rivers move", subtitle: "Practical Engineering", at: "2019-03-14T09:00:00Z", url: "https://www.youtube.com/watch?v=abcdefghijk", note: "liked" },
  });
  const added = videoEntry({ snippet: { title: "Bread", publishedAt: "2020-01-02T09:00:00Z", resourceId: { videoId: "zzzzzzzzzzz" } } }, TZ, { id: "PL1", title: "Cooking", likes: false })!;
  assert.equal(added.entry.external_id, "playlist:PL1:zzzzzzzzzzz");
  assert.equal(added.entry.group, "Cooking");
  assert.equal(added.entry.note, "added to Cooking");
  assert.equal(videoEntry({ snippet: { title: "Deleted video", publishedAt: "2020-01-02T09:00:00Z", resourceId: { videoId: "zzzzzzzzzzz" } } }, TZ, { id: "LL", likes: true }), null);
  const sub = subscriptionEntry({ snippet: { title: "Tom Scott", publishedAt: "2016-07-01T09:00:00Z", resourceId: { channelId: "UCBa659QWEk1AI4Tg--mrJ2A" } } }, TZ)!;
  assert.equal(sub.entry.external_id, "sub:UCBa659QWEk1AI4Tg--mrJ2A");
  assert.equal(sub.entry.note, "subscribed");
});

test("YouTube streams: likes follow page tokens; playlists go through each list, then end", async () => {
  const seen: string[] = [];
  const item = (id: string) => ({ snippet: { title: `v${id}`, publishedAt: "2020-01-02T09:00:00Z", resourceId: { videoId: id.padEnd(11, "x") } } });
  const get = async <T>(path: string, p: Record<string, string | number | undefined>): Promise<T> => {
    seen.push(`${path}:${p.playlistId ?? ""}:${p.pageToken ?? ""}`);
    if (path === "/playlists") return { items: [{ id: "LL" }, { id: "PLa", snippet: { title: "A" } }, { id: "PLb", snippet: { title: "B" } }] } as T;
    if (path === "/playlistItems" && p.playlistId === "LL") return (p.pageToken ? { items: [item("2")] } : { items: [item("1")], nextPageToken: "t2" }) as T;
    if (path === "/playlistItems") return { items: [item(String(p.playlistId))] } as T;
    return { items: [] } as T;
  };
  const [likes, playlists, subs] = youtubeStreams(get, "LL", TZ);
  const a = await likes.page(undefined);
  assert.equal(a.next, "t2");
  assert.equal((await likes.page("t2")).next, undefined);
  const p1 = await playlists.page(undefined);
  assert.equal(p1.entries[0].entry.group, "A");
  const p2 = await playlists.page(p1.next);
  assert.equal(p2.entries[0].entry.group, "B");
  assert.equal(p2.next, undefined, "the likes list isn't read twice");
  assert.equal((await subs.page(undefined)).read, 0);
  await assert.rejects(likes.page("bad token!"), /lost its place/);
  await assert.rejects(playlists.page("{not json"), /lost its place/);
});

test("Trakt and YouTube offer a history load; a service without one doesn't", () => {
  assert.ok(directFor({ provider: "trakt", auth_type: "oauth", oauth: {} } as never)?.backfill);
  assert.ok(directFor({ provider: "youtube", auth_type: "oauth", oauth: {} } as never)?.backfill);
  assert.equal(directFor({ provider: "netflix", auth_type: "none", oauth: {} } as never)?.backfill, undefined);
});

test("Last.fm: one listened entry per album a day, and a day split across two pages is still one entry", async () => {
  const { lastfmStream } = await import("./backfill-tools");
  const pages: Record<string, unknown> = {
    first: { items: [
      { track: "a", artist: "Bowie", album: "Low", date: "2019-03-03" },
      { track: "b", artist: "Bowie", album: "Low", date: "2019-03-02" },
    ], next_cursor: "c2" },
    c2: { items: [
      { track: "c", artist: "Bowie", album: "Low", date: "2019-03-02" },
      { track: "d", artist: "Eno", date: "2019-03-01" },
    ] },
  };
  const account = { call: async (_n: string, args: Record<string, unknown>) => ({ text: JSON.stringify(pages[(args.cursor as string) ?? "first"]), isError: false }) };
  const s = lastfmStream(account);
  const p1 = await s.page(undefined);
  assert.deepEqual(p1.entries.map((e) => [e.date, e.entry.title, e.entry.count]), [["2019-03-03", "Low", undefined]], "2 March waits for the next page");
  const p2 = await s.page(p1.next);
  assert.deepEqual(p2.entries.map((e) => [e.date, e.entry.title, e.entry.count ?? 1]), [["2019-03-02", "Low", 2], ["2019-03-01", "Eno", 1]]);
  assert.equal(p2.next, undefined);
  assert.equal(p2.entries[0].entry.kind, "listened");
  assert.equal(p2.entries[0].entry.group, "Bowie");
});

test("Last.fm: each scrobble's local hour is kept on the folded entry, across a page break too", async () => {
  const { lastfmStream } = await import("./backfill-tools");
  const pages: Record<string, unknown> = {
    first: { items: [
      { track: "a", artist: "Bowie", album: "Low", date: "2019-03-03", time: "21:40" },
      { track: "b", artist: "Bowie", album: "Low", date: "2019-03-02", time: "08:15" },
    ], next_cursor: "c2" },
    c2: { items: [
      { track: "c", artist: "Bowie", album: "Low", date: "2019-03-02", time: "08:05" },
      { track: "d", artist: "Bowie", album: "Low", date: "2019-03-02", time: "23:59" },
      { track: "e", artist: "Eno", date: "2019-03-01" },
    ] },
  };
  const account = { call: async (_n: string, args: Record<string, unknown>) => ({ text: JSON.stringify(pages[(args.cursor as string) ?? "first"]), isError: false }) };
  const s = lastfmStream(account);
  const p1 = await s.page(undefined);
  assert.equal(p1.entries[0].entry.hours?.[21], 1);
  const p2 = await s.page(p1.next);
  const low = p2.entries[0].entry;
  assert.equal(low.count, 3);
  assert.equal(low.hours?.[8], 2, "two plays at 8am, one of them held over from the first page");
  assert.equal(low.hours?.[23], 1);
  assert.equal(low.hours?.reduce((a, b) => a + b, 0), 3, "the hours add up to the count");
  assert.equal(p2.entries[1].entry.hours, undefined, "no time, no hours");
});

test("Plex and Jellyfin plays, Letterboxd diary and Spotify saves map to entries and Watch & read", async () => {
  const { mediaServerRows, letterboxdRows, spotifySavedRows } = await import("./backfill-tools");
  const plex = mediaServerRows("plex")([
    { kind: "film", title: "Arrival", year: 2016, date: "2019-03-02", id: "55", link: "https://app.plex.tv/x/55" },
    { kind: "episode", show: "Andor", season: 1, episode: 2, title: "That Would Be Me", date: "2019-03-03", show_id: "7", link: "https://app.plex.tv/x/9", show_link: "https://app.plex.tv/x/7" },
    { kind: "episode", show: "Andor", season: 1, episode: 3, date: "2019-03-03", show_id: "7", link: "https://app.plex.tv/x/10" },
  ]);
  assert.equal(plex.entries.length, 3);
  assert.equal(plex.entries[1].entry.subtitle, "S1E2 · That Would Be Me");
  assert.deepEqual(plex.watchRead!.map((w) => [w.kind, w.title, w.status, w.external_id]), [["film", "Arrival", "done", "55"], ["tv", "Andor", "reading", "7"]]);

  const lb = letterboxdRows([{ title: "Arrival", year: 2016, watched_on: "2019-03-02", rating: "★★★★½ (4.5/5)", rewatch: true, link: "https://letterboxd.com/me/film/arrival/1/" }]);
  assert.equal(lb.entries[0].entry.note, "rewatch");
  assert.equal(lb.watchRead![0].rating, "★★★★½ (4.5/5)");

  const sp = spotifySavedRows("tracks")([{ track: "Heroes", artist: "David Bowie", link: "https://open.spotify.com/track/abc123", saved_date: "2018-01-01" }, { track: "No date", link: "https://open.spotify.com/track/x" }]);
  assert.deepEqual(sp.entries.map((e) => [e.date, e.entry.external_id, e.entry.note]), [["2018-01-01", "saved:tracks:abc123", "liked song"]]);
});

test("the app's list of accounts that load history matches the adapters", async () => {
  const { HISTORY_LOADS, presetFor } = await import("../../../lib/connector-presets");
  const { DIRECT_ADAPTERS } = await import("./direct");
  const withBackfill = DIRECT_ADAPTERS.filter((a) => a.backfill).map((a) => a.id).sort();
  assert.deepEqual([...HISTORY_LOADS].sort(), withBackfill);
  for (const p of HISTORY_LOADS) assert.ok(presetFor(p), p);
});

test("every stream names the reads it needs, and each is one of the account's own tools", async () => {
  const { DIRECT_ADAPTERS } = await import("./direct");
  for (const a of DIRECT_ADAPTERS.filter((x) => x.backfill)) {
    const own = new Set(a.tools({ provider: a.id, scope: "" } as never).map((t) => t.name));
    assert.ok(a.backfill!.tools.length, a.id);
    for (const t of a.backfill!.tools) assert.ok(own.has(t), `${a.id}: ${t}`);
  }
  const session = { get: async () => ({ items: [], page: 1, pageCount: 1 }) };
  assert.deepEqual(traktStreams(session as never, TZ).map((s) => s.tools), [["list_history"], ["list_history"], ["list_history"], ["list_ratings"], ["list_watchlist"]]);
  assert.deepEqual(youtubeStreams((async () => ({})) as never, "LL", TZ).map((s) => s.tools), [["list_liked_videos"], ["list_playlists", "list_playlist_videos"], ["list_subscriptions"]]);
});

test("Last.fm reads up to 100,000 scrobbles; other streams keep the 20,000 default", async () => {
  const { lastfmStream, LASTFM_CAP } = await import("./backfill-tools");
  const { HISTORY_CAP } = await import("./backfill");
  assert.equal(LASTFM_CAP, 100_000);
  assert.equal(lastfmStream({ call: async () => ({ text: "{}", isError: false }) }).cap, 100_000);
  assert.equal(HISTORY_CAP, 20_000);
  assert.equal(traktStreams({ get: async () => ({}) } as never, TZ)[0].cap, undefined);
});

test("YouTube: a liked video is watched and a playlist video is to watch, in Watch & read", async () => {
  const { videoItem } = await import("./youtube-backfill");
  const like = videoEntry({ snippet: { title: "How rivers move", publishedAt: "2019-03-14T09:00:00Z", videoOwnerChannelTitle: "Practical Engineering", resourceId: { videoId: "abcdefghijk" } } }, TZ, { id: "LL", likes: true })!;
  assert.deepEqual(videoItem(like, true), {
    kind: "video", title: "How rivers move", maker: "Practical Engineering", status: "done", at: "2019-03-14T09:00:00Z",
    url: "https://www.youtube.com/watch?v=abcdefghijk", external_id: "video:abcdefghijk", source: "youtube",
  });
  assert.equal(videoItem(like, false).status, "queued");
});
