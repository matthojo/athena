// Run: npx tsx --test netlify/lib/connectors/life-b-direct.test.ts
// ListenBrainz, Raindrop.io and Eventbrite, with fetch stubbed and recorded replies (fixtures/life-b-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, HISTORY_LOADS, classifyTool, directApi } from "../../../lib/connector-presets";
import * as F from "./fixtures/life-b-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { listenbrainzAdapter, listenbrainzAddress, openListenbrainz } from "./listenbrainz-direct";
import { openRaindrop, raindropAdapter } from "./raindrop-direct";
import { eventbriteAdapter, openEventbrite } from "./eventbrite-direct";
import { eventbriteRows, lastfmStream, raindropRows } from "./backfill-tools";
import type { BackfillPage } from "./backfill";

const TZ = "Europe/London";
const conn = (provider: string, auth_type: string, url = "") => ({ id: `${provider}1`, name: provider, provider, auth_type, url, scope: "", allowed_tools: [] }) as unknown as Connector;
const token: ConnectorSecrets = { token: "tok_0123456789" };
const parse = async (p: Promise<{ text: string; isError: boolean }>) => {
  const r = await p;
  return { ...JSON.parse(r.text), isError: r.isError };
};

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
});
afterEach(() => F.unstub());

// ---------- Presets ----------

test("presets: three Life log sources, read-only tools only, called directly, history loaded on connect", () => {
  const cases: Array<[string, string, typeof listenbrainzAdapter]> = [
    ["listenbrainz", "none", listenbrainzAdapter],
    ["raindrop", "token", raindropAdapter],
    ["eventbrite", "token", eventbriteAdapter],
  ];
  for (const [id, auth, adapter] of cases) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id)!;
    assert.equal(p.auth, auth, id);
    assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"], id);
    assert.deepEqual(p.readTools, adapter.tools(conn(id, auth)).map((t) => t.name), id);
    for (const t of adapter.tools(conn(id, auth))) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(classifyTool(id, t.name, t.annotations), "read", `${id} ${t.name}`);
    }
    assert.equal(directFor(conn(id, auth)), adapter, id);
    assert.ok(directApi(conn(id, auth)), id);
    assert.ok(adapter.backfill, id);
    assert.ok((HISTORY_LOADS as readonly string[]).includes(id), id);
    assert.ok(!/monzo|starling|octopus|barclays|hsbc|lloyds|natwest|edf|british gas|ovo/i.test(`${p.help} ${JSON.stringify(p.setup ?? {})}`), `${id} copy names a bank or energy company`);
  }
  // Keys only: the token path never goes through MCP, and a ListenBrainz account with a key isn't this adapter's.
  assert.equal(directFor(conn("listenbrainz", "token")), undefined);
});

// ---------- ListenBrainz ----------

test("ListenBrainz address: a username or a profile link becomes the profile; anything else is refused", () => {
  assert.equal(listenbrainzAddress("someone"), "https://listenbrainz.org/user/someone");
  assert.equal(listenbrainzAddress("https://listenbrainz.org/user/some_one/stats"), "https://listenbrainz.org/user/some_one");
  assert.throws(() => listenbrainzAddress("https://last.fm/user/someone"), /ListenBrainz address/);
  assert.throws(() => listenbrainzAddress("two words"), /ListenBrainz username/);
});

test("ListenBrainz: listens for one day, newest first, with the window's end as max_ts and no key", async () => {
  F.stub(
    F.at("api.listenbrainz.org", "/1/user/someone/listen-count", F.LISTEN_COUNT),
    F.at("api.listenbrainz.org", "/1/user/someone/listens", { payload: { count: 6, listens: [...F.LISTENS, F.LISTEN_DAY_BEFORE] } }),
  );
  const out = await parse(openListenbrainz({ url: "https://listenbrainz.org/user/someone" }, TZ).then((a) => a.call("list_listens", { date: "2026-02-18" })));
  const req = F.calls.find((c) => c.url.pathname.endsWith("/listens"))!;
  assert.equal(req.init.method, "GET");
  assert.equal(new Headers(req.init.headers).get("authorization"), null);
  assert.equal(req.url.searchParams.get("count"), "100");
  assert.equal(req.url.searchParams.get("max_ts"), String(Date.UTC(2026, 1, 19) / 1000));
  assert.equal(req.url.searchParams.get("min_ts"), null);
  // The 17 Feb listen is before the window: left out, and nothing more to read.
  assert.equal(out.count, 5);
  assert.equal(out.next_cursor, undefined);
  assert.deepEqual(out.items[0], {
    track: "Some Resolve",
    artist: "Röyksopp",
    album: "Profound Mysteries II",
    date: "2026-02-18",
    time: "11:28",
    played_at: "2026-02-18T11:28:29Z",
    minutes: 7,
    link: "https://musicbrainz.org/recording/30d08f4c-d825-4ae1-b79c-44242cddd7c0",
  });
  assert.deepEqual(out.top_artists[0], { artist: "Röyksopp", plays: 3 });
});

test("ListenBrainz paging: a full page gives a cursor, which becomes the next call's max_ts", async () => {
  F.stub(
    F.at("api.listenbrainz.org", "/1/user/someone/listen-count", F.LISTEN_COUNT),
    F.at("api.listenbrainz.org", "/1/user/someone/listens", (url) => ({ payload: { listens: url.searchParams.get("max_ts") ? F.LISTENS.slice(3) : F.LISTENS.slice(0, 3) } })),
  );
  const acct = await openListenbrainz({ url: "someone" }, TZ);
  const one = await parse(acct.call("list_listens", { limit: 3 }));
  assert.equal(one.items.length, 3);
  assert.ok(one.next_cursor);
  const two = await parse(acct.call("list_listens", { limit: 3, cursor: one.next_cursor }));
  const last = F.calls.at(-1)!;
  assert.equal(last.url.searchParams.get("max_ts"), String(F.LISTENS[2].listened_at));
  assert.deepEqual(two.items.map((i: { track: string }) => i.track), ["It Was a Good Thing", "Control"]);
  assert.equal(two.next_cursor, undefined);
});

test("ListenBrainz: an unknown username is the owner's to fix", async () => {
  F.stub(F.at("api.listenbrainz.org", "/1/user/nosuchuser/listen-count", F.LISTENBRAINZ_NO_USER, 404));
  const error = await openListenbrainz({ url: "nosuchuser" }, TZ).catch((e) => e);
  assert.deepEqual(directFailure(error), { status: "needs_auth", detail: "ListenBrainz can't find that username. Check the spelling." });
});

test("ListenBrainz backfill: listens folded per album per day, a day split over pages held back until it's whole", async () => {
  F.stub(
    F.at("api.listenbrainz.org", "/1/user/someone/listen-count", F.LISTEN_COUNT),
    F.at("api.listenbrainz.org", "/1/user/someone/listens", (url) => {
      const max = Number(url.searchParams.get("max_ts")) || Infinity;
      return { payload: { listens: [...F.LISTENS, F.LISTEN_DAY_BEFORE].filter((l) => l.listened_at < max).slice(0, 3) } };
    }),
  );
  const acct = await openListenbrainz({ url: "someone" }, TZ);
  const stream = lastfmStream(acct, { tool: "list_listens", source: "listenbrainz", limit: 3 });
  assert.deepEqual(stream.tools, ["list_listens"]);
  const first = await stream.page(undefined);
  // 18 Feb may go on into the next page: nothing written yet.
  assert.deepEqual(first.entries, []);
  assert.equal(first.read, 3);
  assert.ok(first.next);
  const rest: BackfillPage["entries"] = [];
  for (let next: string | undefined = first.next; next; ) {
    const page = await stream.page(next);
    rest.push(...page.entries);
    next = page.next;
  }
  // Folded by album and artist, as Last.fm's are: a featured artist is a session of its own.
  assert.deepEqual(
    rest.map((e) => [e.date, e.entry.title, e.entry.subtitle, e.entry.count]),
    [
      ["2026-02-18", "Profound Mysteries II", "Röyksopp", 3],
      ["2026-02-18", "Profound Mysteries II", "Röyksopp feat. Susanne Sundfør", undefined],
      ["2026-02-18", "Profound Mysteries II", "Röyksopp feat. Pixx", undefined],
      ["2026-02-17", "The Understanding", "Röyksopp", undefined],
    ],
  );
  for (const e of rest) assert.equal(e.entry.kind, "listened"), assert.equal(e.entry.source, "listenbrainz");
});

// ---------- Raindrop.io ----------

const raindropRoutes = (pages: Record<string, unknown> = { "0": F.RAINDROP_PAGE_0, "1": F.RAINDROP_PAGE_1 }) => [
  F.at("api.raindrop.io", "/rest/v1/user", F.RAINDROP_USER),
  F.at("api.raindrop.io", "/rest/v1/collections", F.RAINDROP_COLLECTIONS),
  F.at("api.raindrop.io", "/rest/v1/collections/childrens", F.RAINDROP_CHILDREN),
  F.at("api.raindrop.io", "/rest/v1/raindrops/0", (url) => pages[url.searchParams.get("page") ?? "0"] ?? { result: true, items: [] }),
];

test("Raindrop.io: one day's bookmarks, Bearer token, newest first, collection names filled in", async () => {
  F.stub(...raindropRoutes());
  const out = await parse(openRaindrop(conn("raindrop", "token"), token, TZ).then((a) => a.call("list_bookmarks", { date: "2026-11-07" })));
  const req = F.calls.find((c) => c.url.pathname === "/rest/v1/raindrops/0")!;
  assert.equal(req.init.method, "GET");
  assert.equal(new Headers(req.init.headers).get("authorization"), "Bearer tok_0123456789");
  assert.equal(req.url.searchParams.get("sort"), "-created");
  assert.equal(req.url.searchParams.get("perpage"), "50");
  assert.equal(req.url.searchParams.get("page"), "0");
  assert.equal(out.count, 2);
  assert.deepEqual(out.items[0], {
    id: "900",
    title: "How to make sourdough",
    site: "seriouseats.com",
    kind: "article",
    collection: "Weeknight",
    tags: ["bread"],
    favourite: true,
    saved_on: "2026-11-07",
    time: "19:30",
    link: "https://www.seriouseats.com/sourdough",
  });
  assert.equal(out.items[1].collection, "Unsorted");
  assert.equal(out.items[1].kind, "video");
  // Page 0 reached past the window's start: no second page asked for.
  assert.equal(F.calls.filter((c) => c.url.pathname === "/rest/v1/raindrops/0").length, 1);
});

test("Raindrop.io paging: with no window, a full page gives a cursor for the next page", async () => {
  F.stub(...raindropRoutes());
  const acct = await openRaindrop(conn("raindrop", "token"), token, TZ);
  const one = await parse(acct.call("list_bookmarks", {}));
  assert.equal(one.items.length, 50);
  assert.ok(one.next_cursor);
  const two = await parse(acct.call("list_bookmarks", { cursor: one.next_cursor }));
  assert.equal(F.calls.at(-1)!.url.searchParams.get("page"), "1");
  assert.deepEqual(two.items.map((i: { id: string }) => i.id), ["850", "849"]);
  assert.equal(two.next_cursor, undefined);
});

test("Raindrop.io search uses Raindrop's own search and pages by count", async () => {
  F.stub(...raindropRoutes());
  const out = await parse(openRaindrop(conn("raindrop", "token"), token, TZ).then((a) => a.call("search_bookmarks", { query: "#bread" })));
  assert.equal(F.calls.at(-1)!.url.searchParams.get("search"), "#bread");
  assert.equal(out.count, 52);
  assert.ok(out.next_cursor);
});

test("Raindrop.io: a bad token is the owner's to fix", async () => {
  F.stub(F.at("api.raindrop.io", "/rest/v1/user", F.RAINDROP_BAD_TOKEN, 401));
  const error = await openRaindrop(conn("raindrop", "token"), token, TZ).catch((e) => e);
  assert.equal(directFailure(error)?.status, "needs_auth");
  assert.match(directFailure(error)!.detail, /didn't accept the token/);
});

test("Raindrop.io backfill: a saved entry per bookmark on the day it was saved", () => {
  const { entries } = raindropRows([
    { id: "900", title: "How to make sourdough", site: "seriouseats.com", collection: "Weeknight", saved_on: "2026-11-07", link: "https://www.seriouseats.com/sourdough" },
    { id: "1", title: "", saved_on: "2026-11-07" },
  ]);
  assert.deepEqual(entries, [
    { date: "2026-11-07", entry: { kind: "saved", source: "raindrop", external_id: "raindrop:900", title: "How to make sourdough", subtitle: "seriouseats.com", url: "https://www.seriouseats.com/sourdough", note: "Weeknight" } },
  ]);
});

// ---------- Eventbrite ----------

const eventbriteRoutes = () => [
  F.at("www.eventbriteapi.com", "/v3/users/me/", F.EVENTBRITE_ME),
  F.at("www.eventbriteapi.com", "/v3/users/me/orders/", (url) => (url.searchParams.get("continuation") ? F.EVENTBRITE_ORDERS_2 : F.EVENTBRITE_ORDERS_1)),
];

test("Eventbrite: orders with the event and venue expanded, refunds left out, never a price, name or address", async () => {
  F.stub(...eventbriteRoutes());
  const out = await parse(openEventbrite(conn("eventbrite", "token"), token, TZ).then((a) => a.call("list_orders", { when: "past" })));
  const req = F.calls.find((c) => c.url.pathname === "/v3/users/me/orders/")!;
  assert.equal(req.init.method, "GET");
  assert.equal(new Headers(req.init.headers).get("authorization"), "Bearer tok_0123456789");
  assert.equal(req.url.searchParams.get("expand"), "event,event.venue");
  assert.equal(req.url.searchParams.get("time_filter"), "past");
  assert.equal(out.count, 1);
  assert.deepEqual(out.items[0], {
    order_id: "5001",
    event: "Late night at the museum",
    date: "2026-10-24",
    time: "19:00",
    minutes: 240,
    venue: "Natural History Museum",
    town: "London",
    link: "https://www.eventbrite.co.uk/e/5001",
    start_utc: "2026-10-24T18:00:00Z",
  });
  assert.doesNotMatch(JSON.stringify(out), /£|2450|sam@example|Sam Example|Cromwell|SW7/);
  assert.ok(out.next_cursor);
});

test("Eventbrite paging: the continuation token carries on; an online event says Online", async () => {
  F.stub(...eventbriteRoutes());
  const acct = await openEventbrite(conn("eventbrite", "token"), token, TZ);
  const one = await parse(acct.call("list_orders", {}));
  assert.equal(F.calls.at(-1)!.url.searchParams.get("time_filter"), "all");
  const two = await parse(acct.call("list_orders", { cursor: one.next_cursor }));
  assert.equal(F.calls.at(-1)!.url.searchParams.get("continuation"), "dGhlIG5leHQgcGFnZQ");
  assert.deepEqual(two.items.map((i: { event: string }) => i.event), ["Supper club", "Talk: the history of maps"]);
  assert.equal(two.items[1].venue, "Online");
  assert.equal(two.items[1].town, undefined);
  assert.equal(two.next_cursor, undefined);
});

test("Eventbrite: a date window filters by when the event starts", async () => {
  F.stub(...eventbriteRoutes());
  const out = await parse(openEventbrite(conn("eventbrite", "token"), token, TZ).then((a) => a.call("list_orders", { date: "2026-10-24" })));
  assert.deepEqual(out.items.map((i: { order_id: string }) => i.order_id), ["5001"]);
});

test("Eventbrite: a bad token is the owner's to fix", async () => {
  F.stub(F.at("www.eventbriteapi.com", "/v3/users/me/", F.EVENTBRITE_BAD_TOKEN, 401));
  const error = await openEventbrite(conn("eventbrite", "token"), token, TZ).catch((e) => e);
  assert.equal(directFailure(error)?.status, "needs_auth");
  assert.match(directFailure(error)!.detail, /private token/);
});

test("Eventbrite backfill: an other entry per event on its day, the venue in the subtitle", () => {
  const { entries } = eventbriteRows([
    { order_id: "5001", event: "Late night at the museum", date: "2026-10-24", time: "19:00", minutes: 240, venue: "Natural History Museum", town: "London", link: "https://www.eventbrite.co.uk/e/5001" },
    { order_id: "5003", event: "Talk: the history of maps", date: "2026-09-30", time: "18:30", venue: "Online" },
  ]);
  assert.deepEqual(entries[0], {
    date: "2026-10-24",
    entry: { kind: "other", source: "eventbrite", external_id: "eventbrite:5001", title: "Late night at the museum", subtitle: "19:00 · Natural History Museum, London", url: "https://www.eventbrite.co.uk/e/5001", minutes: 240, group: "Events" },
  });
  assert.equal(entries[1].entry.subtitle, "18:30 · Online");
});
