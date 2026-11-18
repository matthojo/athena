// Run: npx tsx --test netlify/lib/connectors/feeds-direct.test.ts
// Letterboxd's diary feed and Goodreads' shelf widgets, with fetch stubbed (fixtures/feeds-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { presetFor } from "../../../lib/connector-presets";
import * as F from "./fixtures/feeds-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./feeds-shared";
import { letterboxdFeedUrl, openLetterboxd } from "./feeds-letterboxd";
import { goodreadsMemoryStore, goodreadsProfileUrl, notice, openGoodreads, type ShelfMemory } from "./feeds-goodreads";
import { glance } from "./precheck";
import type { OpenConnector } from "./mcp-client";

beforeEach(() => {
  F.installFetch();
  lifeRetryWaits.ms = [1, 1];
});
afterEach(F.restoreFetch);

const connector = (provider: "letterboxd" | "goodreads", url: string): Connector => ({
  id: `00000000-0000-4000-8000-0000000000c${provider === "letterboxd" ? 1 : 2}`,
  name: presetFor(provider).label,
  provider,
  account_label: "",
  url,
  auth_type: "none",
  scope: "",
  status: "connected",
  status_detail: "",
  tools: [],
  allowed_tools: presetFor(provider).readTools,
  tools_checked_at: null,
  last_used_at: null,
  server_info: {},
  oauth: {},
  has_token: false,
  has_own_client: false,
  has_client_secret: false,
  created_at: "",
  updated_at: "",
});

const LB = "https://letterboxd.com/yourname/rss/";
const GR = "https://www.goodreads.com/user/show/12345";
const feed: F.Route = (url) => (url.toString() === LB ? { body: F.LETTERBOXD_RSS } : undefined);

// ---------- addresses ----------

test("presets: Entertainment, no sign-in, no fixed address but a hint, Life log", () => {
  for (const id of ["letterboxd", "goodreads"]) {
    const p = presetFor(id);
    assert.equal(p.category, "entertainment");
    assert.equal(p.auth, "none");
    assert.equal(p.url, "");
    assert.match(p.urlHint!, /^https:\/\/(letterboxd\.com|goodreads\.com)\//);
    assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
    assert.equal(directFor({ provider: id, auth_type: "none", oauth: {} })?.id, id);
  }
});

test("Letterboxd: a profile, diary or feed link, or a username, becomes the diary feed", () => {
  for (const raw of ["https://letterboxd.com/YourName/", "letterboxd.com/yourname/films/diary/", "https://www.letterboxd.com/yourname/rss/", "yourname", "@yourname"]) {
    assert.equal(letterboxdFeedUrl(raw), LB, raw);
  }
});

test("a bad address is refused when the account is added, saying what to paste", () => {
  const check = (provider: string, url: string) => {
    try {
      directFor({ provider, auth_type: "none", oauth: {} })!.checkAddress!(url);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  assert.match(check("letterboxd", "https://evil.example/yourname/rss/"), /^That isn't a Letterboxd link\. Paste your profile link, like https:\/\/letterboxd\.com\/yourname\//);
  assert.match(check("letterboxd", "https://letterboxd.com.evil.example/yourname/"), /isn't a Letterboxd link/);
  assert.match(check("letterboxd", "https://letterboxd.com/film/heat-1995/"), /isn't a Letterboxd profile/);
  assert.match(check("letterboxd", ""), /^Paste your profile link/);
  assert.match(check("goodreads", "https://www.goodreads.co/user/show/12345"), /^That isn't a Goodreads link/);
  assert.match(check("goodreads", "https://www.goodreads.com/book/show/1"), /isn't a Goodreads profile/);
  assert.match(check("goodreads", "javascript:alert(1)"), /isn't a Goodreads link/);
  assert.equal(goodreadsProfileUrl("https://www.goodreads.com/user/show/12345-your-name"), GR);
  assert.equal(goodreadsProfileUrl("goodreads.com/review/list/12345?shelf=read"), GR);
  assert.equal(goodreadsProfileUrl("https://www.goodreads.com/review/list_rss/12345?key=abc&shelf=read"), GR);
});

// ---------- Letterboxd ----------

test("list_diary: films with the watched day, stars, like, rewatch and review; lists left out", async () => {
  F.stub(feed);
  const account = await openLetterboxd(connector("letterboxd", LB), { tz: "Europe/London" });
  const r = JSON.parse((await account.call("list_diary", { after: "2026-11-05", before: "2026-11-07" })).text);
  assert.deepEqual(r, {
    profile: "https://letterboxd.com/yourname/",
    films: [
      { title: "Paddington in Peru", year: 2024, watched_on: "2026-11-06", rating: "★★★★½ (4.5/5)", liked: true, review: "Olivia Colman singing & the marmalade bit. Took Mum.", link: "https://letterboxd.com/yourname/film/paddington-in-peru/" },
      { title: "Heat", year: 1995, watched_on: "2026-11-05", rewatch: true, link: "https://letterboxd.com/yourname/film/heat-1995/1/" },
    ],
    count: 2,
    total_count: 2,
  });
  const page = JSON.parse((await account.call("list_diary", { limit: 2 })).text);
  assert.equal(page.next_page_token, "2");
  const rest = JSON.parse((await account.call("list_diary", { limit: 2, page_token: "2" })).text);
  assert.deepEqual(rest.films.map((f: { title: string }) => f.title), ["Past Lives"]);
  assert.equal(F.calls.length, 1, "the feed is read once per run");
});

test("Letterboxd: no such member, or a redirect off letterboxd.com, is the owner's to fix", async () => {
  F.stub((url) => (url.host === "letterboxd.com" ? { status: 404, body: "<html>Not found</html>" } : undefined));
  const missing = await openLetterboxd(connector("letterboxd", LB), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(missing), { status: "needs_auth", detail: "Letterboxd has no public diary at that address. Check the username under Edit, and that your profile isn't private." });
  F.stub((url) => (url.host === "letterboxd.com" ? { status: 302, body: "", headers: { Location: "https://evil.example/rss" } } : undefined));
  const away = await openLetterboxd(connector("letterboxd", LB), { tz: "UTC" }).catch((e) => e);
  assert.equal(directFailure(away)?.status, "needs_auth");
  assert.ok(!F.calls.some((c) => c.url.host === "evil.example"));
});

test("Letterboxd down is passing, not the owner's problem", async () => {
  F.stub((url) => (url.host === "letterboxd.com" ? { status: 503, body: "" } : undefined));
  const err = await openLetterboxd(connector("letterboxd", LB), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "error", detail: "Couldn't reach Letterboxd right now. Athena will try again next run." });
});

// ---------- Goodreads ----------

const widgets: F.Route = (url) => {
  if (url.host !== "www.goodreads.com") return undefined;
  if (url.pathname === "/review/grid_widget/12345") return { body: url.searchParams.get("shelf") === "currently-reading" ? F.GOODREADS_GRID_READING : F.GOODREADS_GRID_READ };
  if (url.pathname === "/review/custom_widget/12345") return { body: F.GOODREADS_DETAIL };
  return undefined;
};

async function goodreads(memory: ShelfMemory | undefined, now = "2026-11-06T20:00:00Z") {
  const saved: Array<{ shelf: string; seen: Record<string, string> }> = [];
  goodreadsMemoryStore.save = async (_id, shelf, seen) => void saved.push({ shelf, seen });
  const secrets = { goodreadsSeen: memory } as ConnectorSecrets;
  const account = await openGoodreads(connector("goodreads", GR), secrets, { tz: "Europe/London", now: () => new Date(now) });
  return { account, saved, secrets };
}

test("Goodreads: the first look remembers what's already on the shelf, so none of it is logged as today", async () => {
  F.stub(widgets);
  const { account, saved } = await goodreads(undefined);
  const r = JSON.parse((await account.call("list_books", { after: "2026-11-06" })).text);
  assert.deepEqual(r, { shelf: "read", count: 0, total_count: 0, just_noticed: 0 });
  assert.deepEqual(saved, [{ shelf: "read", seen: { "9048955118": "", "9034889193": "", "9034813988": "" } }]);
  // Without a window, everything on the shelf, with author, rating and review where Goodreads gave them.
  const all = JSON.parse((await account.call("list_books", {})).text);
  assert.deepEqual(all.books[0], { title: "Tell Me Everything (Amgash, #5)", link: "https://www.goodreads.com/review/show/9048955118", author: "Elizabeth Strout", rating: "4/5", review: "Lucy and Bob again. I'd read the next one tomorrow." });
  assert.deepEqual(all.books[1], { title: "Orbital", link: "https://www.goodreads.com/review/show/9034889193", author: "Samantha Harvey" });
});

test("Goodreads: a book that's new on a shelf gets today as noticed_on, once", async () => {
  F.stub(widgets);
  const { account, saved } = await goodreads({ read: { "9034889193": "", "9034813988": "" }, "currently-reading": {} });
  const read = JSON.parse((await account.call("list_books", { after: "2026-11-06", before: "2026-11-07" })).text);
  assert.deepEqual(read.books.map((b: { title: string; noticed_on: string }) => [b.title, b.noticed_on]), [["Tell Me Everything (Amgash, #5)", "2026-11-06"]]);
  const reading = JSON.parse((await account.call("list_books", { shelf: "currently-reading", after: "2026-11-06" })).text);
  assert.deepEqual(reading.books, [{ title: "The Wager", link: "https://www.goodreads.com/review/show/9032334492", noticed_on: "2026-11-06" }]);
  assert.deepEqual(saved.map((s) => s.shelf).sort(), ["currently-reading", "read"]);
  // Seen again later: the first sighting stands.
  const again = notice([{ id: "9048955118", title: "x" }], saved.find((s) => s.shelf === "read")!.seen, new Date("2026-11-09T00:00:00Z"));
  assert.equal(again.books[0].noticed, "2026-11-06T20:00:00.000Z");
  assert.equal(again.changed, false);
});

test("Goodreads: a read book the library import already logged on its finish day isn't logged again, and doesn't wake the run", async () => {
  F.stub(widgets);
  goodreadsMemoryStore.save = async () => undefined;
  const secrets = { goodreadsSeen: { read: { "9034889193": "", "9034813988": "" }, "currently-reading": { "9032334492": "" } }, goodreadsImported: { "tell me everything": "2026-10-30" } } as ConnectorSecrets;
  const account = await openGoodreads(connector("goodreads", GR), secrets, { tz: "Europe/London", now: () => new Date("2026-11-06T20:00:00Z") });
  const read = JSON.parse((await account.call("list_books", { after: "2026-11-06", before: "2026-11-07" })).text);
  assert.deepEqual(read, { shelf: "read", count: 0, total_count: 0, just_noticed: 0 });
  assert.equal((await glance(opened(connector("goodreads", GR), account), new Set(["list_books"]), new Date("2026-11-06T00:00:00Z"), "UTC")).count, 0);
});

test("Goodreads: a to-read book the library import already logged isn't logged again", async () => {
  F.stub(widgets);
  goodreadsMemoryStore.save = async () => undefined;
  const secrets = { goodreadsSeen: { "to-read": {} }, goodreadsWanted: { "tell me everything": "2026-10-30" } } as unknown as ConnectorSecrets;
  const account = await openGoodreads(connector("goodreads", GR), secrets, { tz: "Europe/London", now: () => new Date("2026-11-06T20:00:00Z") });
  const all = JSON.parse((await account.call("list_books", { shelf: "to-read" })).text);
  assert.ok(!all.books.some((b: { title: string }) => b.title.startsWith("Tell Me Everything")));
  assert.ok(all.books.length > 0);
});

test("Goodreads: no such member (the real 'widget is not correct' reply) is the owner's to fix", async () => {
  F.stub((url) => (url.host === "www.goodreads.com" ? { body: F.GOODREADS_NOT_CORRECT } : undefined));
  const err = await goodreads(undefined).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Goodreads has no public shelves at that address. Check the link under Edit, and that your profile is public." });
  assert.ok(F.calls.every((c) => c.url.host === "www.goodreads.com" && (c.init.method ?? "GET") === "GET"));
});

// ---------- precheck ----------

const opened = (c: Connector, direct: OpenConnector["direct"]): OpenConnector => ({ connector: c, direct: direct!, close: async () => undefined }) as OpenConnector;

test("precheck: Letterboxd is asked by day, so a film logged late the evening of the last run still counts", async () => {
  F.stub(feed);
  const account = await openLetterboxd(connector("letterboxd", LB), { tz: "Europe/London" });
  const open = opened(connector("letterboxd", LB), account);
  assert.equal((await glance(open, new Set(["list_diary"]), new Date("2026-11-07T21:30:00Z"), "Europe/London")).count, 0);
  assert.equal((await glance(open, new Set(["list_diary"]), new Date("2026-11-06T21:30:00Z"), "Europe/London")).count, 1);
});

test("precheck: Goodreads with nothing new on read or reading counts 0", async () => {
  F.stub(widgets);
  const { account } = await goodreads({ read: { "9048955118": "", "9034889193": "", "9034813988": "" }, "currently-reading": { "9032334492": "" } });
  const open = opened(connector("goodreads", GR), account);
  assert.equal((await glance(open, new Set(["list_books"]), new Date("2026-11-06T00:00:00Z"), "UTC")).count, 0);
});

test("precheck: a book Goodreads shows for the first time wakes the run, once", async () => {
  F.stub(widgets);
  const memory = { read: { "9034889193": "", "9034813988": "" }, "currently-reading": { "9032334492": "" }, "to-read": { "9048955118": "", "9034889193": "", "9034813988": "" } };
  const first = await goodreads(memory);
  const open = opened(connector("goodreads", GR), first.account);
  assert.equal((await glance(open, new Set(["list_books"]), new Date("2026-11-06T00:00:00Z"), "UTC")).count, 1);
  // The next run's look has it remembered.
  const next = await goodreads((first.secrets as { goodreadsSeen?: ShelfMemory }).goodreadsSeen);
  assert.equal((await glance(opened(connector("goodreads", GR), next.account), new Set(["list_books"]), new Date(), "UTC")).count, 0);
});
