// Real path for history on connect (backfill.ts): connecting Trakt and YouTube through the real /api routes,
// the real adapters and sessions, Day entries and Watch & read on Postgres with every migration (0054 included).
// Trakt and YouTube are stubbed at fetch. Nothing calls a model.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/backfill.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties Days, Watch & read and the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

/** Trakt's history: three pages of two, oldest in March 2019. */
const HISTORY = [
  [
    { id: 106, watched_at: "2026-11-06T21:14:00.000Z", type: "episode", episode: { season: 2, number: 3, title: "Who Is Alive?" }, show: { title: "Severance", year: 2022, ids: { trakt: 2, slug: "severance" } } },
    { id: 105, watched_at: "2026-11-06T19:02:00.000Z", type: "movie", movie: { title: "Paddington in Peru", year: 2024, ids: { trakt: 3, slug: "paddington-in-peru-2024" } } },
  ],
  [
    { id: 104, watched_at: "2023-01-10T20:00:00.000Z", type: "episode", episode: { season: 1, number: 1, title: "Good News About Hell" }, show: { title: "Severance", year: 2022, ids: { trakt: 2, slug: "severance" } } },
    { id: 103, watched_at: "2021-06-01T20:00:00.000Z", type: "movie", movie: { title: "Arrival", year: 2016, ids: { trakt: 9, slug: "arrival-2016" } } },
  ],
  [
    { id: 102, watched_at: "2019-03-20T20:00:00.000Z", type: "movie", movie: { title: "Paddington 2", year: 2017, ids: { trakt: 10, slug: "paddington-2-2017" } } },
    { id: 101, watched_at: "2019-03-02T20:00:00.000Z", type: "movie", movie: { title: "Arrival", year: 2016, ids: { trakt: 9, slug: "arrival-2016" } } },
  ],
];
const RATINGS = [
  { rated_at: "2021-06-02T10:00:00.000Z", rating: 10, type: "movie", movie: { title: "Arrival", year: 2016, ids: { trakt: 9, slug: "arrival-2016" } } },
  { rated_at: "2023-02-01T10:00:00.000Z", rating: 9, type: "episode", episode: { season: 1, number: 1 }, show: { title: "Severance", ids: { trakt: 2 } } },
];
const WATCHLIST = [{ listed_at: "2024-05-04T10:00:00.000Z", type: "movie", movie: { title: "Dune: Part Two", year: 2024, ids: { trakt: 11, slug: "dune-part-two-2024" } } }];

function traktRoute(opts: { limited?: () => boolean } = {}): F.Route {
  return (u) => {
    if (u.host !== "api.trakt.tv") return undefined;
    if (u.pathname === "/users/settings") return { body: F.TRAKT_SETTINGS };
    if (opts.limited?.()) return { status: 429, body: { error: "rate limited" }, headers: { "Retry-After": "1" } };
    const page = Number(u.searchParams.get("page") ?? "1");
    const paged = (pages: unknown[][]) => ({ body: pages[page - 1] ?? [], headers: { "x-pagination-page": String(page), "x-pagination-page-count": String(pages.length) } });
    if (u.pathname === "/users/yourname/history/") return paged(HISTORY);
    if (u.pathname === "/users/yourname/ratings/") return paged([RATINGS]);
    if (u.pathname === "/users/yourname/watchlist/movie,show/added") return paged([WATCHLIST]);
    return { status: 404, body: {} };
  };
}

const yt = (id: string, title: string, at: string, channel = "Practical Engineering") => ({ snippet: { title, publishedAt: at, videoOwnerChannelTitle: channel, resourceId: { videoId: id } }, contentDetails: { videoId: id } });

function youtubeRoute(opts: { quota?: () => boolean } = {}): F.Route {
  return (u) => {
    if (u.host !== "www.googleapis.com") return undefined;
    const p = u.pathname.replace("/youtube/v3", "");
    if (p === "/channels") return { body: F.YT_CHANNEL };
    if (p === "/subscriptions" && opts.quota?.()) return { status: 403, body: { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } } };
    if (p === "/playlistItems" && u.searchParams.get("playlistId") === "LL") {
      return u.searchParams.get("pageToken") === "p2"
        ? { body: { items: [yt("bbbbbbbbbbb", "How locks work", "2019-03-14T09:00:00Z"), yt("ccccccccccc", "Deleted video", "2019-03-01T09:00:00Z")] } }
        : { body: { items: [yt("aaaaaaaaaaa", "Why bridges sing", "2026-10-01T09:00:00Z")], nextPageToken: "p2" } };
    }
    if (p === "/playlists") return { body: { items: [{ id: "PLcook", snippet: { title: "Cooking" } }] } };
    if (p === "/playlistItems" && u.searchParams.get("playlistId") === "PLcook") return { body: { items: [yt("ddddddddddd", "Bread at home", "2020-02-02T09:00:00Z", "Bake")] } };
    if (p === "/subscriptions") return { body: { items: [{ snippet: { title: "Tom Scott", publishedAt: "2016-07-01T09:00:00Z", resourceId: { channelId: "UCtomscott" } } }] } };
    return { status: 404, body: {} };
  };
}

async function setup() {
  const { handleConnectorRoutes } = await import("./routes");
  const B = await import("./backfill");
  const C = await import("../../../lib/connectors");
  const { qRaw, q } = await import("../../../lib/db");
  const { lifeRetryWaits } = await import("./feeds-shared");
  lifeRetryWaits.ms = [1, 1];
  for (const t of ["custom_values", "day_entries", "days", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'history_load.%' OR key LIKE 'import.%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const triggered: string[] = [];
  B.backfillTrigger.send = async (_origin, ids) => void triggered.push(...ids);
  const api = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  const fresh = { access_token: "at", refresh_token: "rt", expires_in: 86400, obtained_at: Date.now() };
  /** Add an account, sign it in, and check it, as Settings does: the check starts the history load. */
  const connect = async (body: Record<string, unknown>) => {
    const made = await api("POST", "/connectors", { account_label: "personal", ...body });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    await C.updateConnectorSecrets(made.json.id, (s) => void (s.tokens = { ...fresh } as never));
    const checked = await api("POST", `/connectors/${made.json.id}/check`);
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    return made.json.id as string;
  };
  const entries = (source: string) =>
    q<{ date: string; kind: string; title: string; external_id: string; backfilled: boolean }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, title, external_id, backfilled FROM day_entries WHERE source = $1`,
      [source],
    ).then((rows) => rows.sort((a, b) => a.date.localeCompare(b.date) || a.external_id.localeCompare(b.external_id)));
  const watchRead = () =>
    q<{ title: string; kind: string; status: string; backfilled: boolean; created: string; finished: string | null }>(
      `SELECT title, kind, status, backfilled, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS finished FROM reading_items`,
    ).then((rows) => rows.sort((a, b) => a.title.localeCompare(b.title)));
  return { api, B, connect, entries, watchRead, triggered, q };
}

test("Trakt: connecting loads the whole history, once, and it never shows as new", { skip }, async () => {
  F.installFetch();
  try {
    let limited = false;
    F.stub(traktRoute({ limited: () => limited }));
    const { api, B, connect, entries, watchRead, triggered } = await setup();
    const id = await connect({ provider: "trakt", name: "Trakt", client_id: "trakt-app", client_secret: "trakt-secret" });
    assert.deepEqual(triggered, [id], "connecting starts the load in the background");
    assert.equal((await api("GET", `/connectors/${id}/backfill`)).json.progress.state, "running");

    const done = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(done.state, "done");
    assert.equal(done.items, 6 + 2 + 1, "every page of history, ratings and the watchlist");
    assert.equal(done.oldest, "2019-03-02");
    const days = await entries("trakt");
    assert.equal(days.filter((d) => d.kind === "watched").length, 6, "one entry per watch, a rewatch too");
    assert.equal(days.filter((d) => d.kind === "saved").length, 1);
    assert.ok(days.every((d) => d.backfilled), "marked as backfilled");
    const items = await watchRead();
    assert.deepEqual(items.map((i) => [i.title, i.kind, i.status]), [
      ["Arrival", "film", "done"],
      ["Dune: Part Two", "film", "queued"],
      ["Paddington 2", "film", "done"],
      ["Paddington in Peru", "film", "done"],
      ["Severance", "tv", "reading"],
    ]);
    assert.ok(items.every((i) => i.backfilled));
    // Dated when it happened, so nothing sits at the top as added today.
    assert.equal(items.find((i) => i.title === "Dune: Part Two")!.created, "2024-05-04");
    assert.equal(items.find((i) => i.title === "Paddington 2")!.created, "2019-03-20");
    // No push, no model, nothing but Trakt.
    assert.ok(F.calls.every((c) => c.url.host === "api.trakt.tv"), F.calls.map((c) => c.url.host).join(","));

    // Ask's taste tool reads it: the rated film, and the one watched twice.
    const { tasteProfile } = await import("../../../lib/taste");
    const taste = await tasteProfile({ area: "films" });
    assert.equal(taste.from, "2019-03-02");
    assert.deepEqual(taste.films!.rated, [{ title: "Arrival", stars: 5, finished: "2021-06-01" }]);
    assert.deepEqual(taste.films!.watched_most, [{ title: "Arrival", times: 2 }]);
    assert.equal((await tasteProfile({ area: "tv" })).tv!.watched_most[0].show, "Severance");

    const shown = (await api("GET", `/connectors/${id}/backfill`)).json;
    assert.equal(shown.progress.oldest, "2019-03-02");
    assert.equal(shown.progress.cursor, undefined, "the cursor stays on the server");

    // Load history again: the same history changes nothing.
    const again = await api("POST", `/connectors/${id}/backfill`);
    assert.equal(again.status, 202);
    const second = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(second.state, "done");
    assert.equal(second.items, 9);
    assert.equal(second.added, 0, "nothing new the second time");
    assert.equal((await entries("trakt")).length, days.length);
    assert.equal((await watchRead()).length, items.length);

    // A run that times out after one page carries on from the next one.
    await api("POST", `/connectors/${id}/backfill`);
    let now = Date.parse("2026-11-09T12:00:00Z");
    const clock = () => now;
    const before = F.calls.length;
    // Each page Trakt answers takes 800ms on this clock: the second page is past the 1s budget.
    const slow = () => now + 800 * F.calls.slice(before).filter((c) => c.url.pathname.startsWith("/users/yourname/")).length;
    const first = (await B.runBackfill(id, { budgetMs: 1000, clock: slow }))!;
    assert.equal(first.state, "running");
    assert.ok(first.items > 0 && first.items < 9, `stopped part-way at ${first.items}`);
    assert.deepEqual(await B.dueBackfills(new Date(now)), [id], "the tick picks it up");
    const resumed = (await B.runBackfill(id, { budgetMs: 60_000, clock }))!;
    assert.equal(resumed.state, "done");
    assert.equal(resumed.items, 9, "no page read twice in the count, none skipped");
    // The watched_* streams first ask history for one row (limit 1) to see whether it's empty: those aren't pages of it.
    const historyPages = F.calls.slice(before).filter((c) => c.url.pathname === "/users/yourname/history/" && c.url.searchParams.get("limit") !== "1").map((c) => c.url.searchParams.get("page"));
    assert.deepEqual(historyPages, ["1", "2", "3"], "each page once across the two runs");

    // The cap is per stream: history stops at the first page past it, ratings and the watchlist still load.
    await api("POST", `/connectors/${id}/backfill`);
    const capped = (await B.runBackfill(id, { budgetMs: 60_000, cap: 3 }))!;
    assert.equal(capped.state, "done");
    assert.equal(capped.capped, true);
    assert.equal(capped.items, 4 + 2 + 1, "history capped at its second page, the others whole");

    // Trakt says slow down: wait, then carry on.
    await api("POST", `/connectors/${id}/backfill`);
    limited = true;
    const waiting = (await B.runBackfill(id, { budgetMs: 60_000, clock: () => now }))!;
    assert.equal(waiting.state, "waiting");
    assert.deepEqual(await B.dueBackfills(new Date(now)), [], "not before it's time");
    limited = false;
    now += B.WAIT_AFTER_LIMIT_MS + 1000;
    assert.deepEqual(await B.dueBackfills(new Date(now)), [id]);
    assert.equal((await B.runBackfill(id, { budgetMs: 60_000, clock: () => now }))!.state, "done");
    assert.equal((await entries("trakt")).length, days.length, "still no duplicates");
  } finally {
    F.restoreFetch();
  }
});

test("What Athena can read: a stream whose tool isn't allowed doesn't load; with none allowed, the load waits for a choice", { skip }, async () => {
  F.installFetch();
  try {
    F.stub(traktRoute());
    const { api, B, connect, entries, triggered } = await setup();
    const id = await connect({ provider: "trakt", name: "Trakt", client_id: "trakt-app", client_secret: "trakt-secret" });
    // Only the watch history allowed: ratings and the watchlist aren't read at all.
    await api("PATCH", `/connectors/${id}`, { allowed_tools: ["list_history"] });
    const done = (await B.runBackfill(id, { budgetMs: 60_000 }))!;
    assert.equal(done.state, "done");
    assert.equal(done.items, 6);
    assert.deepEqual([...new Set(F.calls.map((c) => c.url.pathname).filter((p) => p.startsWith("/users/yourname/")))], ["/users/yourname/history/"]);
    assert.equal((await entries("trakt")).filter((e) => e.kind === "saved").length, 0, "no watchlist entries");

    // Nothing allowed: loading again says what to do and starts nothing.
    await api("PATCH", `/connectors/${id}`, { allowed_tools: [] });
    triggered.length = 0;
    const blocked = await api("POST", `/connectors/${id}/backfill`);
    assert.equal(blocked.json.progress.state, "blocked");
    assert.equal(blocked.json.progress.error, "Choose what Athena can read to load your history");
    assert.deepEqual(triggered, [], "no background run");
    assert.equal((await B.runBackfill(id, { budgetMs: 60_000 }))!.state, "blocked", "a run started anyway reads nothing");
    assert.deepEqual(await B.dueBackfills(), [], "the tick leaves it");

    // Allowing a read starts it.
    await api("PATCH", `/connectors/${id}`, { allowed_tools: ["list_history", "list_ratings"] });
    assert.deepEqual(triggered, [id]);
    assert.equal((await api("GET", `/connectors/${id}/backfill`)).json.progress.state, "running");
  } finally {
    F.restoreFetch();
  }
});

test("YouTube: likes, playlists and subscriptions load, the quota pauses it, and the Takeout import is named", { skip }, async () => {
  F.installFetch();
  try {
    let quota = true;
    F.stub(youtubeRoute({ quota: () => quota }));
    const { api, B, connect, entries, watchRead, q } = await setup();
    const id = await connect({ provider: "youtube", name: "YouTube", client_id: "x.apps.googleusercontent.com", client_secret: "s" });
    // A Life log run already wrote YouTube's saves for 1 October: that day stays the run's.
    const { writeEntries } = await import("../../../lib/days");
    await writeEntries([{ date: "2026-10-01", entry: { kind: "saved", source: "youtube", external_id: "run-chose-this", title: "Why bridges sing", note: "liked" } }], { collection: "life-log-personal" });
    let now = Date.parse("2026-11-09T12:00:00Z");
    const first = (await B.runBackfill(id, { budgetMs: 60_000, clock: () => now }))!;
    assert.equal(first.state, "waiting", "YouTube's allowance ran out at subscriptions");
    assert.match(first.error ?? "", /allowance/);
    quota = false;
    now += B.WAIT_AFTER_LIMIT_MS + 1000;
    const done = (await B.runBackfill(id, { budgetMs: 60_000, clock: () => now }))!;
    assert.equal(done.state, "done");
    assert.equal(done.oldest, "2016-07-01");
    const rows = await entries("youtube");
    assert.deepEqual(rows.map((r) => [r.date, r.external_id]), [
      ["2016-07-01", "sub:UCtomscott"],
      ["2019-03-14", "like:bbbbbbbbbbb"],
      ["2020-02-02", "playlist:PLcook:ddddddddddd"],
      ["2026-10-01", "run-chose-this"],
    ]);
    assert.ok(rows.every((r) => r.kind === "saved" && (r.backfilled || r.external_id === "run-chose-this")));
    // Liked videos are watched, playlist videos to watch, in Watch & read too; the covered day's Days entry stays the run's, the video still goes in.
    assert.deepEqual((await watchRead()).map((w) => [w.title, w.kind, w.status, w.backfilled]), [
      ["Bread at home", "video", "queued", true],
      ["How locks work", "video", "done", true],
      ["Why bridges sing", "video", "done", true],
    ]);
    // Pages already read weren't read again after the pause.
    assert.equal(F.calls.filter((c) => c.url.searchParams.get("playlistId") === "LL").length, 2);

    // A Takeout import already in: the page says so.
    await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [`import.${id}`, JSON.stringify({ at: "2026-11-01T10:00:00Z", items: 39251, days: 2100 })]);
    const status = (await api("GET", `/connectors/${id}/backfill`)).json;
    assert.equal(status.takeout.items, 39251);
    assert.ok(F.calls.every((c) => c.url.host === "www.googleapis.com"));
  } finally {
    F.restoreFetch();
  }
});
