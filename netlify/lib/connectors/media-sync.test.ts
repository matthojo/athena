// The hourly check's streams and folding (media-sync.ts, media-recent.ts), with the accounts faked at their tools.
// The real path on Postgres is media-sync.db.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Collection, Connector } from "../../../lib/connectors";
import type { DayEntry, EntryInput } from "../../../lib/days";
import { albumDayId } from "../../../lib/day-imports";
import { lastfmStream, letterboxdRows, mediaServerRows } from "./backfill-tools";
import { recentPlaysStream, recentToolStream, traktRatingsSince, untilSeen, playSlot } from "./media-recent";
import { dropRepeats, foldPlays, hourlyOn, playsPerHour, playsWatchesLine, waitAfter } from "./media-sync";
import { historyRow, traktStreams, type TraktRow } from "./trakt-backfill";
import { youtubeStreams, type YtItem } from "./youtube-backfill";

type Row = Record<string, unknown>;

/** An account whose tool answers from `pages` by cursor ("" for the first), recording each call. */
function fakeAccount(pages: Record<string, { rows: Row[]; next?: string }>, list = "items") {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const p = pages[(args.cursor as string | undefined) ?? (args.page_token as string | undefined) ?? ""];
      return { text: JSON.stringify({ [list]: p.rows, ...(p.next ? { next_cursor: p.next } : {}) }), isError: false };
    },
  };
}

const play = (at: string, album: string, artist = "Khruangbin", track = "Time") => ({ track, artist, album, played_at: at, date: at.slice(0, 10), time: at.slice(11, 16) });
const TZ = "Europe/London";

test("plays: read from the cursor with after, follow the pages, and stop when the service has nothing older", async () => {
  const since = Date.parse("2026-11-10T13:00:00Z");
  const acct = fakeAccount({
    "": { rows: [play("2026-11-10T14:30:00Z", "Mordechai"), play("2026-11-10T13:10:00Z", "Mordechai")], next: "c2" },
    c2: { rows: [play("2026-11-10T13:05:00Z", "Con Todo El Mundo"), play("2026-11-10T12:50:00Z", "Con Todo El Mundo")] },
  });
  const r = await recentPlaysStream(acct, { tool: "list_scrobbles", source: "lastfm", limit: 200 }, TZ).read(since);
  assert.deepEqual(acct.calls.map((c) => c.args), [
    { limit: 200, after: "2026-11-10T13:00:00.000Z" },
    { limit: 200, after: "2026-11-10T13:00:00.000Z", cursor: "c2" },
  ]);
  // 12:50 is before the cursor: not counted, even if a service sends it.
  assert.equal(r.plays!.length, 3);
  assert.equal(r.newest, Date.parse("2026-11-10T14:30:00Z"));
  assert.equal(r.read, 4);
});

test("Spotify's played_at goes on the owner's own day and hour", async () => {
  const acct = fakeAccount({
    "": {
      rows: [
        // 00:30 on the 11th in Tokyo.
        play("2026-11-10T15:30:00Z", "Mordechai"),
        // 23:59 on the 10th in Tokyo.
        play("2026-11-10T14:59:00Z", "Mordechai"),
      ],
    },
  });
  const r = await recentPlaysStream(acct, { tool: "recently_played", source: "spotify", limit: 50 }, "Asia/Tokyo").read(0);
  assert.deepEqual(r.plays!.map((p) => p.date), ["2026-11-11", "2026-11-10"]);
  assert.match(r.plays![0].entry.external_id, /^2026-11-11:/);
  assert.equal(r.plays![0].entry.source, "spotify");
  assert.deepEqual(playSlot(Date.parse("2026-11-10T15:30:00Z"), "Asia/Tokyo"), { date: "2026-11-11", hour: 0 });
  // British Summer Time: 23:30Z on 1 July is 00:30 on the 2nd; in November it's still the 10th.
  assert.deepEqual(playSlot(Date.parse("2026-07-01T23:30:00Z"), TZ), { date: "2026-07-02", hour: 0 });
  assert.deepEqual(playSlot(Date.parse("2026-11-10T23:30:00Z"), TZ), { date: "2026-11-10", hour: 23 });
  const hours = playsPerHour([Date.parse("2026-11-10T14:05:00Z") / 1000, Date.parse("2026-11-10T14:55:00Z") / 1000, Date.parse("2026-11-10T09:00:00Z") / 1000], TZ);
  assert.equal(hours[14], 2);
  assert.equal(hours[9], 1);
  assert.equal(hours.reduce((a, b) => a + b, 0), 3);
});

test("music folds to the history load's entries exactly: same ids, titles and counts", async () => {
  const rows = [play("2026-11-10T14:30:00Z", "Mordechai"), play("2026-11-10T14:25:00Z", "Mordechai", "Khruangbin", "Pelota"), play("2026-11-10T09:00:00Z", "Blackstar", "David Bowie")];
  const history = await lastfmStream(fakeAccount({ "": { rows } })).page(undefined);
  const recent = await recentPlaysStream(fakeAccount({ "": { rows } }), { tool: "list_scrobbles", source: "lastfm", limit: 200 }, TZ).read(0);
  const folded = foldPlays(recent.plays!, {}, TZ).entries;
  const strip = (e: EntryInput) => ({ ...e, at: undefined });
  const byId = (a: { entry: EntryInput }, b: { entry: EntryInput }) => a.entry.external_id.localeCompare(b.entry.external_id);
  assert.deepEqual(folded.sort(byId).map((e) => ({ date: e.date, entry: strip(e.entry) })), history.entries.sort(byId).map((e) => ({ date: e.date, entry: strip(e.entry) })));
  // One id per album per day for every writer: the loads, the imports and this check.
  assert.equal(folded.find((e) => e.entry.title === "Mordechai")!.entry.external_id, albumDayId("2026-11-10", "Mordechai", "Khruangbin"));
  assert.equal(folded.find((e) => e.entry.title === "Mordechai")!.entry.external_id, "2026-11-10:mordechai khruangbin");
  // Each entry keeps when it started.
  assert.equal(folded.find((e) => e.entry.title === "Mordechai")!.entry.at, "2026-11-10T14:25:00Z");
});

test("a day's count is every play seen, however many checks saw it, and only hashes and times are kept", async () => {
  const stream = (rows: Row[]) => recentPlaysStream(fakeAccount({ "": { rows } }), { tool: "recently_played", source: "spotify", limit: 50 }, TZ).read(0);
  const first = await stream([play("2026-11-10T14:30:00Z", "Mordechai"), play("2026-11-10T14:25:00Z", "Mordechai")]);
  const a = foldPlays(first.plays!, {}, TZ);
  assert.equal(a.fresh, 2);
  assert.equal(a.entries[0].entry.count, 2);
  // The next check overlaps: the same two plays and three new ones.
  const second = await stream([play("2026-11-10T15:40:00Z", "Mordechai"), play("2026-11-10T15:35:00Z", "Mordechai"), play("2026-11-10T15:00:00Z", "Mordechai"), play("2026-11-10T14:30:00Z", "Mordechai"), play("2026-11-10T14:25:00Z", "Mordechai")]);
  const b = foldPlays(second.plays!, a.held, TZ);
  assert.equal(b.fresh, 3);
  assert.equal(b.entries[0].entry.count, 5);
  assert.equal(b.entries[0].entry.external_id, a.entries[0].entry.external_id);
  // Plays per local hour (GMT in November): 14:25, 14:30, 15:00, 15:35, 15:40.
  assert.equal(b.entries[0].entry.hours![14], 2);
  assert.equal(b.entries[0].entry.hours![15], 3);
  // Again: nothing new, the same count.
  const c = foldPlays(second.plays!, b.held, TZ);
  assert.equal(c.fresh, 0);
  assert.equal(c.entries[0].entry.count, 5);
  assert.doesNotMatch(JSON.stringify(c.held), /Mordechai|Khruangbin/);
});

test("Plex, Jellyfin and Letterboxd: asked with after, paged, mapped by the history load's mapper", async () => {
  const rows: Row[] = [
    { kind: "film", title: "Arrival", year: 2016, date: "2026-11-10", time: "20:00", at: "2026-11-10T20:00:00Z", id: "41", link: "https://app.plex.tv/x/41" },
    { kind: "episode", show: "Severance", season: 2, episode: 3, title: "Who Is Alive?", date: "2026-11-10", time: "18:00", at: "2026-11-10T18:00:00Z", show_id: "7", link: "https://app.plex.tv/x/9", show_link: "https://app.plex.tv/x/7" },
  ];
  const acct = fakeAccount({ "": { rows: rows.slice(0, 1), next: "n2" }, n2: { rows: rows.slice(1) } });
  const since = Date.parse("2026-11-10T12:00:00Z");
  const r = await recentToolStream(acct, { tool: "watch_history", args: { limit: 100 }, list: "items", map: mediaServerRows("plex") }, TZ).read(since);
  assert.deepEqual(acct.calls.map((c) => c.args), [{ limit: 100, after: "2026-11-10T12:00:00.000Z" }, { limit: 100, after: "2026-11-10T12:00:00.000Z", cursor: "n2" }]);
  const history = mediaServerRows("plex")(rows);
  assert.deepEqual(r.entries, history.entries);
  assert.deepEqual(r.watchRead, history.watchRead);
  assert.equal(r.newest, Date.parse("2026-11-10T20:00:00Z"));

  const diary = [{ title: "Anora", year: 2024, watched_on: "2026-11-09", rating: "★★★★", link: "https://letterboxd.com/me/film/anora/" }];
  const lb = await recentToolStream(fakeAccount({ "": { rows: diary } }, "films"), { tool: "list_diary", args: { limit: 50 }, list: "films", map: letterboxdRows }, TZ).read(since);
  assert.deepEqual(lb.entries, letterboxdRows(diary).entries);
  assert.equal(lb.entries[0].entry.external_id, "2026-11-09:https://letterboxd.com/me/film/anora/");
});

test("Trakt history: pages from the newest until one reaches past the cursor, never the page after", async () => {
  const row = (id: number, at: string, title: string): TraktRow => ({ id, watched_at: at, type: "movie", movie: { title, year: 2020, ids: { trakt: id, slug: `film-${id}` } } });
  const pages: TraktRow[][] = [
    [row(9, "2026-11-10T20:00:00.000Z", "Nine"), row(8, "2026-11-10T08:00:00.000Z", "Eight")],
    [row(7, "2026-11-09T22:00:00.000Z", "Seven"), row(6, "2026-11-08T10:00:00.000Z", "Six")],
    [row(5, "2026-01-01T10:00:00.000Z", "Five")],
  ];
  const asked: number[] = [];
  const session = {
    async get<T>(_path: string, params: Record<string, string | number | undefined> = {}) {
      const page = Number(params.page ?? 1);
      asked.push(page);
      return { items: pages[page - 1] as unknown as T, page, pageCount: pages.length, bytes: 1 };
    },
  };
  const history = traktStreams(session, TZ).find((s) => s.id === "history")!;
  const r = await untilSeen(history).read(Date.parse("2026-11-09T12:00:00Z"));
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(r.entries.map((e) => e.entry.external_id), ["history:9", "history:8", "history:7"]);
  // The history load's own ids for the same watches.
  assert.deepEqual(r.entries[0], historyRow(pages[0][0], TZ).entry);
  assert.equal(r.newest, Date.parse("2026-11-10T20:00:00Z"));
});

test("YouTube likes: stop at the first page that reaches past the cursor", async () => {
  const yt = (id: string, at: string): YtItem => ({ snippet: { title: `Video ${id}`, publishedAt: at, videoOwnerChannelTitle: "Practical Engineering", resourceId: { videoId: id } }, contentDetails: { videoId: id } });
  const tokens: Array<string | undefined> = [];
  const get = async <T>(path: string, params: Record<string, string | number | undefined>) => {
    assert.equal(path, "/playlistItems");
    tokens.push(params.pageToken as string | undefined);
    const body = params.pageToken === "p2" ? { items: [yt("bbbbbbbbbbb", "2026-11-01T09:00:00Z")], nextPageToken: "p3" } : { items: [yt("aaaaaaaaaaa", "2026-11-10T09:00:00Z")], nextPageToken: "p2" };
    return body as T;
  };
  const likes = youtubeStreams(get, "LL", TZ).find((s) => s.id === "likes")!;
  const r = await untilSeen(likes).read(Date.parse("2026-11-09T00:00:00Z"));
  assert.deepEqual(tokens, [undefined, "p2"]);
  assert.deepEqual(r.entries.map((e) => e.entry.external_id), ["like:aaaaaaaaaaa"]);
  assert.deepEqual(r.watchRead!.map((w) => w.external_id), ["video:aaaaaaaaaaa"]);
});

test("the evening run's entries for what's already in Days are left out; anything else is written", () => {
  const onDay: DayEntry[] = [{ id: "e1", kind: "listened", source: "spotify", title: "Mordechai", subtitle: "Khruangbin", count: 12 }];
  const model = (source: string, title: string, external_id: string) => ({ date: "2026-11-10", entry: { kind: "listened" as const, source, external_id, title, subtitle: "Khruangbin" } });
  const r = dropRepeats([model("spotify", "Mordechai", "run-chosen-id"), model("spotify", "Con Todo El Mundo", "x2"), model("lastfm", "Mordechai", "x3")], onDay, new Set(["spotify"]));
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.keep.map((e) => e.entry.external_id), ["x2", "x3"]);
});

test("a rating the evening run gives a repeat still lands on the hourly entry, unless it has one", () => {
  const onDay: DayEntry[] = [
    { id: "w1", kind: "watched", source: "trakt", title: "Arrival", subtitle: "2016" },
    { id: "w2", kind: "watched", source: "trakt", title: "Anora", subtitle: "2024", rating: 4 },
  ];
  const e = (title: string, year: string, rating: number) => ({ date: "2026-11-10", entry: { kind: "watched" as const, source: "trakt", external_id: `run:${title}`, title, subtitle: year, rating } });
  const r = dropRepeats([e("Arrival", "2016", 5), e("Anora", "2024", 3)], onDay, new Set(["trakt"]));
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.ratings, [{ id: "w1", rating: 5 }]);
});

test("read only when connected, in an enabled Plays and watches collection, and something is allowed", () => {
  const c = { id: "c1", provider: "spotify", auth_type: "oauth", oauth: {}, status: "connected", allowed_tools: ["recently_played"] } as unknown as Connector;
  const pw = { id: "p1", recipe: "plays-watches", enabled: true, connector_ids: ["c1"] } as unknown as Collection;
  const lifeLog = { id: "l1", recipe: "life-log", enabled: true, connector_ids: ["c1"] } as unknown as Collection;
  assert.equal(hourlyOn(c, [pw, lifeLog]), true);
  assert.equal(hourlyOn(c, [{ ...pw, enabled: false }, lifeLog]), false, "switched off: no reads");
  assert.equal(hourlyOn(c, [{ ...pw, connector_ids: [] }, lifeLog]), false, "the account taken out: no reads");
  assert.equal(hourlyOn(c, [lifeLog]), false, "a Life log alone isn't Plays and watches");
  assert.equal(hourlyOn({ ...c, allowed_tools: ["top_items"] }, [pw]), false, "What Athena can read allows none of its reads");
  assert.equal(hourlyOn({ ...c, status: "needs_auth" }, [pw]), false);
  assert.equal(hourlyOn({ ...c, provider: "tripit" } as Connector, [pw]), false, "nothing to read");
});

test("a run's line is plain counts", () => {
  assert.equal(playsWatchesLine({ plays: 6, watches: 1, likes: 0 }), "6 plays, 1 watch");
  assert.equal(playsWatchesLine({ plays: 1, watches: 2, likes: 3 }), "1 play, 2 watches, 3 likes");
  assert.equal(playsWatchesLine({ plays: 0, watches: 0, likes: 0 }), "Nothing new");
});

test("a 429 waits an hour, anything else 15 minutes", () => {
  assert.deepEqual(waitAfter(Object.assign(new Error("slow down"), { status: 429 }), "Spotify"), { ms: 60 * 60_000, status: 429, message: "Spotify asked Athena to wait" });
  // A sign-in the owner has to fix isn't waited out: the run names the account.
  assert.equal(waitAfter(Object.assign(new Error("expired"), { status: 401 }), "Spotify").owner, true);
  assert.equal(waitAfter(Object.assign(new Error("busy"), { status: 503 }), "Spotify").ms, 15 * 60_000);
  assert.equal(waitAfter(new Error("socket hang up"), "Spotify").ms, 15 * 60_000);
});

test("Trakt ratings for the evening run: films and shows rated since then, on the owner's day, from every page", async () => {
  const rows: TraktRow[][] = [
    [
      { type: "movie", rating: 9, rated_at: "2026-11-09T23:30:00.000Z", movie: { title: "Arrival", year: 2016 } },
      { type: "episode", rating: 7, rated_at: "2026-11-09T20:00:00.000Z", show: { title: "Severance" } },
    ],
    [
      { type: "show", rating: 8, rated_at: "2026-11-08T10:00:00.000Z", show: { title: "Slow Horses" } },
      { type: "movie", rating: 6, rated_at: "2026-10-01T10:00:00.000Z", movie: { title: "Old Film" } },
    ],
  ];
  const session = {
    async get<T>(_path: string, params: Record<string, string | number | undefined> = {}) {
      const page = Number(params.page ?? 1);
      return { items: rows[page - 1] as unknown as T, page, pageCount: rows.length, bytes: 1 };
    },
  };
  const r = await traktRatingsSince({} as Connector, { tokens: {} }, Date.parse("2026-11-03T00:00:00Z"), "Asia/Tokyo", session);
  // 23:30Z on the 9th is the 10th in Tokyo; episodes and anything older than the week are left out.
  assert.deepEqual(r, [
    { date: "2026-11-10", title: "Arrival", rating: 9 },
    { date: "2026-11-08", title: "Slow Horses", rating: 8 },
  ]);
});

test("Trakt in progress: a watched entry 'started, paused at 40%' on the day paused, a film partway through is reading; older pauses left", async () => {
  const { inProgressRows } = await import("./media-recent");
  const rows = [
    { id: 13, type: "movie", progress: 41.6, paused_at: "2026-11-06T22:40:00.000Z", movie: { title: "Dune", year: 2021, ids: { slug: "dune-2021", trakt: 1 } } },
    { id: 14, type: "episode", progress: 10, paused_at: "2026-11-01T20:00:00.000Z", show: { title: "Slow Horses", ids: { slug: "slow-horses" } }, episode: { season: 4, number: 2, title: "Hello Goodbye" } },
  ];
  const r = inProgressRows(rows, Date.parse("2026-11-06T00:00:00Z"), TZ);
  assert.deepEqual(r.entries, [{ date: "2026-11-06", entry: { kind: "watched", source: "trakt", external_id: "progress:13", title: "Dune", subtitle: "2021", at: "2026-11-06T22:40:00.000Z", url: "https://trakt.tv/movies/dune-2021", note: "started, paused at 42%" } }]);
  assert.deepEqual(r.watchRead!.map((w) => [w.title, w.status]), [["Dune", "reading"]]);
});

test("a whole read keeps only what's dated since the cursor, and waits its interval before reading again", async () => {
  const { fullRead } = await import("./media-recent");
  let pages = 0;
  const stream = {
    id: "subscriptions",
    tools: ["list_subscriptions"],
    async page(cursor?: string) {
      pages++;
      const e = (t: string, at: string) => ({ date: at.slice(0, 10), entry: { kind: "saved" as const, source: "youtube", external_id: `sub:${t}`, title: t, at } });
      return cursor ? { entries: [e("Old", "2025-01-01T00:00:00Z")], read: 1 } : { entries: [e("New", "2026-11-06T09:00:00Z")], read: 1, next: "p2" };
    },
  };
  const state: Record<string, unknown> = {};
  const now = Date.parse("2026-11-06T12:00:00Z");
  const s = fullRead(stream, { everyMs: 6 * 3600_000 });
  const r = await s.read(Date.parse("2026-11-06T00:00:00Z"), { tz: TZ, now, state, allowed: new Set() });
  assert.deepEqual(r.entries.map((x) => x.entry.title), ["New"]);
  assert.equal(pages, 2, "every page: no order to stop on");
  const again = await s.read(Date.parse("2026-11-06T00:00:00Z"), { tz: TZ, now: now + 3600_000, state, allowed: new Set() });
  assert.deepEqual([again.read, pages, again.newest], [0, 2, undefined], "an hour later it waits, and the cursor stays");
});

test("every media source is read whole: the evening run writes nothing for them but the line", async () => {
  const { directFor } = await import("./direct");
  for (const provider of ["spotify", "lastfm", "listenbrainz", "trakt", "youtube", "plex", "jellyfin", "letterboxd"]) {
    const auth = provider === "letterboxd" || provider === "listenbrainz" ? "none" : provider === "lastfm" || provider === "plex" || provider === "jellyfin" ? "token" : "oauth";
    const sync = directFor({ provider, auth_type: auth, oauth: {} } as Connector)?.recent;
    assert.equal(sync?.whole, true, provider);
  }
  const trakt = directFor({ provider: "trakt", auth_type: "oauth", oauth: {} } as Connector)!.recent!;
  assert.deepEqual(trakt.tools, ["list_history", "list_ratings", "list_watchlist", "list_in_progress"]);
});
