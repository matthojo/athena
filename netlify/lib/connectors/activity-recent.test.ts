// Your activity beyond plays and watches (activity-recent.ts, activity-metrics.ts, media-sync.ts), with each account
// faked at its own tools: what each read asks for, how its rows become entries (the Life log recipe's rules and ids),
// what never gets in (other people's names and words, highlight text, nsfw), counting, metrics and the recipe trim.
// The real path on Postgres is activity.db.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "./activity-recent";
import { METRICS, metricsFor } from "./activity-metrics";
import { eventbriteRows, raindropRows } from "./backfill-tools";
import { activityLine, countNew, tallyOf, wordOf, type RecentRead, type RecentStream, type StreamContext } from "./media-sync";
import type { EntryInput } from "../../../lib/days";
import { lifeLogPrompt, RECIPE_PROMPTS } from "./recipes";
import { activityLineFromStats } from "../../../lib/activity-words";

type Row = Record<string, unknown>;
const TZ = "Europe/London";
const NOW = Date.parse("2026-11-12T15:00:00Z");
const ctx = (state: Record<string, unknown> = {}, allowed: string[] = []): StreamContext => ({ tz: TZ, now: NOW, state, allowed: new Set(allowed) });

/** An account answering each tool from `answer`, recording every call. */
function fake(answer: (name: string, args: Row) => Row) {
  const calls: Array<{ name: string; args: Row }> = [];
  return {
    calls,
    async call(name: string, args: Row) {
      calls.push({ name, args });
      return { text: JSON.stringify(answer(name, args)), isError: false };
    },
  };
}

type Read = RecentRead & { entries: Array<{ date: string; entry: EntryInput & Row }> };
/** A source's streams over the stand-in account, each read typed loosely for the checks below. */
const all = (s: { streams(a: never): RecentStream[] }, account: unknown) => s.streams(account as never).map((x) => ({ id: x.id, read: (since: number, c: StreamContext) => x.read(since, c) as Promise<Read> }));
const titles = (r: { entries: Array<{ entry: { title: string } }> }) => r.entries.map((e) => e.entry.title);

// ---------- Goodreads ----------

test("Goodreads: each shelf from the cursor; finished, started and want to read on the day noticed, with the library's id shape", async () => {
  const acct = fake((_n, a) => ({
    books:
      a.shelf === "read"
        ? [{ title: "The Wager", author: "David Grann", rating: "4/5", link: "https://www.goodreads.com/review/show/555", noticed_on: "2026-11-12" }]
        : a.shelf === "currently-reading"
          ? [{ title: "Orbital", author: "Samantha Harvey", link: "https://www.goodreads.com/review/show/556", noticed_on: "2026-11-11" }]
          : [{ title: "Intermezzo", link: "https://www.goodreads.com/review/show/557", noticed_on: "2026-11-12" }, { title: "No link, no entry", noticed_on: "2026-11-12" }],
  }));
  const since = Date.parse("2026-11-12T12:00:00Z");
  const r = await all(A.goodreadsRecent, acct)[0].read(since, ctx());
  assert.deepEqual(acct.calls.map((c) => [c.args.shelf, c.args.after]), [["read", "2026-11-12T12:00:00.000Z"], ["currently-reading", "2026-11-12T12:00:00.000Z"], ["to-read", "2026-11-12T12:00:00.000Z"]]);
  assert.deepEqual(r.entries, [
    { date: "2026-11-12", entry: { kind: "read", source: "goodreads", external_id: "book:r555", title: "The Wager", subtitle: "David Grann", url: "https://www.goodreads.com/review/show/555", rating: 4, note: "finished" } },
    { date: "2026-11-11", entry: { kind: "read", source: "goodreads", external_id: "started:r556", title: "Orbital", subtitle: "Samantha Harvey", url: "https://www.goodreads.com/review/show/556", note: "started" } },
    { date: "2026-11-12", entry: { kind: "saved", source: "goodreads", external_id: "want:r557", title: "Intermezzo", url: "https://www.goodreads.com/review/show/557", note: "want to read" } },
  ]);
  assert.deepEqual(r.watchRead!.map((w) => [w.title, w.kind, w.status]), [["The Wager", "book", "done"], ["Orbital", "book", "reading"], ["Intermezzo", "book", "queued"]]);
  assert.equal(r.newest, NOW, "the cursor moves to the check's own time");
});

// ---------- Readwise ----------

test("Readwise: added since the cursor names the days, each day is read whole, counts only, never a highlight's words", async () => {
  const acct = fake((_n, a) =>
    a.by === "added"
      ? { items: [{ title: "The Wager", highlights_count: 2 }], days: ["2026-11-09", "2026-11-12"] }
      : a.date === "2026-11-09"
        ? { items: [{ title: "The Wager", author: "David Grann", source: "Kindle", link: "https://readwise.io/bookreview/1", highlights_count: 3, highlights: [{ text: "A private sentence", note: "my note" }] }] }
        : { items: [{ title: "An Essay", source: "Reader", highlights_count: 1 }] },
  );
  const r = await all(A.readwiseRecent, acct)[0].read(Date.parse("2026-11-12T10:00:00Z"), ctx());
  assert.deepEqual(acct.calls.map((c) => c.args), [{ by: "added", after: "2026-11-12T10:00:00.000Z", text: false }, { date: "2026-11-09", text: false }, { date: "2026-11-12", text: false }]);
  assert.deepEqual(r.entries, [
    { date: "2026-11-09", entry: { kind: "highlight", source: "readwise", external_id: "2026-11-09:https://readwise.io/bookreview/1", title: "The Wager", subtitle: "David Grann", count: 3, note: "Kindle", url: "https://readwise.io/bookreview/1", group: "The Wager" } },
    { date: "2026-11-12", entry: { kind: "highlight", source: "readwise", external_id: "2026-11-12:an essay", title: "An Essay", note: "Reader", group: "An Essay" } },
  ]);
  assert.ok(!JSON.stringify(r).includes("private sentence") && !JSON.stringify(r).includes("my note"));
});

// ---------- Steam ----------

test("Steam: minutes from the total at the end of the day before; none without one; a private profile writes nothing", async () => {
  const game = (total: number, day: string) => ({ game: "Balatro", last_played_date: day, hours_total: total, link: "https://store.steampowered.com/app/2379780" });
  let rows: Row[] = [game(40.5, "2026-11-10"), { game: "Hades", last_played_date: "2026-11-12", hours_total: 12, link: "https://store.steampowered.com/app/1145360" }];
  const acct = fake((_n, a) => (a.after ? { items: rows.filter((g) => String(g.last_played_date) >= String(a.after).slice(0, 10)) } : { items: [game(40.5, "2026-11-10"), { game: "Hades", last_played_date: "2026-11-12", hours_total: 12, link: "https://store.steampowered.com/app/1145360" }] }));
  const state: Record<string, unknown> = {};
  const s = all(A.steamRecent, acct)[0];
  // First check, from yesterday: every game's total is remembered; Hades, played since, has no earlier figure.
  const r1 = await s.read(Date.parse("2026-11-11T00:00:00Z"), ctx(state));
  assert.deepEqual(r1.entries, [{ date: "2026-11-12", entry: { kind: "played", source: "steam", external_id: "2026-11-12:1145360", title: "Hades", note: "12 hours in total", url: "https://store.steampowered.com/app/1145360" } }]);
  // Balatro played today: 40.5 → 42 is 90 minutes. Read again later the same day at 42.5: still from 40.5.
  rows = [game(42, "2026-11-12")];
  const r2 = await s.read(Date.parse("2026-11-12T13:00:00Z"), ctx(state));
  assert.equal(r2.entries[0].entry.minutes, 90);
  rows = [game(42.5, "2026-11-12")];
  const r3 = await s.read(Date.parse("2026-11-12T14:00:00Z"), ctx(state));
  assert.deepEqual([r3.entries[0].entry.external_id, r3.entries[0].entry.minutes, r3.entries[0].entry.note], ["2026-11-12:2379780", 120, "42.5 hours in total"]);
  const hidden = fake(() => ({ items: [], private: true, note: "Steam returned no games: the profile's game details are private." }));
  const p = await all(A.steamRecent, hidden)[0].read(NOW - 3600_000, ctx());
  assert.deepEqual([p.entries.length, p.private], [0, true]);
});

// ---------- Chess ----------

test("Chess: each day the cursor touches, one entry a site with the count and the line; no opponent anywhere", async () => {
  const g = (date: string, result: string, opponent: string) => ({ date, time: "20:00", at: `${date}T20:00:00Z`, opponent, opponent_rating: 1600, colour: "white", result, speed: "blitz", rating_after: 1520, link: "https://lichess.org/abc" });
  const acct = fake((_n, a) => ({ items: a.date === "2026-11-11" ? [g("2026-11-11", "win", "MagnusFan"), g("2026-11-11", "loss", "Rival99")] : [] }));
  const r = await all(A.lichessRecent, acct)[0].read(Date.parse("2026-11-11T22:00:00Z"), ctx());
  assert.deepEqual(acct.calls.map((c) => c.args.date), ["2026-11-11", "2026-11-12"]);
  assert.deepEqual(r.entries, [{ date: "2026-11-11", entry: { kind: "chess", source: "lichess", external_id: "chess:2026-11-11", title: "Chess on Lichess", count: 2, note: "Chess: 2 games, 1 win, rating 1520" } }]);
  assert.ok(!/MagnusFan|Rival99/.test(JSON.stringify(r)));
  const c = await all(A.chesscomRecent, fake(() => ({ items: [g("2026-11-12", "draw", "x")] })))[0].read(NOW - 3600_000, ctx());
  assert.equal(c.entries[0].entry.title, "Chess on Chess.com");
});

// ---------- Raindrop.io, Eventbrite ----------

test("Raindrop and Eventbrite: the history load's own mappers and ids; past orders read two days further back, nothing still to come", async () => {
  const bookmark = { id: "901", title: "Slow web", site: "example.com", link: "https://example.com/slow", collection: "Reading", saved_on: "2026-11-12", time: "09:00", excerpt: "someone else's words" };
  const rd = fake(() => ({ items: [bookmark] }));
  const r = await all(A.raindropRecent, rd)[0].read(Date.parse("2026-11-12T08:00:00Z"), ctx());
  assert.deepEqual(r.entries, raindropRows([bookmark]).entries);
  assert.equal(r.entries[0].entry.external_id, "raindrop:901");
  assert.deepEqual(rd.calls[0].args, { after: "2026-11-12T08:00:00.000Z", limit: 50 });
  const order = (id: string, date: string) => ({ order_id: id, event: "Gig", date, time: "19:00", venue: "The Hall", town: "Leeds", link: "https://www.eventbrite.co.uk/e/1" });
  const eb = fake(() => ({ items: [order("o1", "2026-11-11"), order("o2", "2026-11-14")] }));
  const e = await all(A.eventbriteRecent, eb)[0].read(Date.parse("2026-11-12T08:00:00Z"), ctx());
  assert.deepEqual(eb.calls[0].args, { when: "past", after: "2026-11-10T08:00:00.000Z" });
  assert.deepEqual(e.entries, eventbriteRows([order("o1", "2026-11-11")]).entries);
});

// ---------- Habits ----------

test("Habits: Habitify done or not as count 1 or 0 with its note; Todoist's routines done only", async () => {
  const hb = fake((_n, a) => ({ items: [{ date: a.date, habit_id: "h1", name: "Read", done: true }, { date: a.date, habit_id: "h2", name: "Water", done: false, note: "3 of 5 glasses" }] }));
  const r = await all(A.habitifyRecent, hb)[0].read(NOW - 3600_000, ctx());
  assert.deepEqual(r.entries, [
    { date: "2026-11-12", entry: { kind: "habit", source: "habitify", external_id: "h1:2026-11-12", title: "Read", count: 1, group: "habits" } },
    { date: "2026-11-12", entry: { kind: "habit", source: "habitify", external_id: "h2:2026-11-12", title: "Water", count: 0, group: "habits", note: "3 of 5 glasses" } },
  ]);
  const td = fake((_n, a) => ({ items: [{ date: a.date, task_id: "t9", name: "Stretch", at: "2026-11-12T07:00:00Z", recurring: true, done: true }] }));
  const t = await all(A.todoistRecent, td)[0].read(NOW - 3600_000, ctx());
  assert.deepEqual(td.calls.map((c) => [c.name, c.args]), [["routines_on", { date: "2026-11-12" }]]);
  assert.deepEqual(t.entries[0], { date: "2026-11-12", entry: { kind: "habit", source: "todoist", external_id: "t9:2026-11-12", title: "Stretch", group: "habits", at: "2026-11-12T07:00:00Z" } });
});

// ---------- Reddit ----------

test("Reddit: posts and comments by their link, never anyone's text; nsfw and private communities by name only", () => {
  assert.deepEqual(A.redditPosted({ kind: "post", community: "r/cycling", title: "My first century", link: "https://www.reddit.com/r/cycling/comments/a1/", date: "2026-11-12", text: "the owner's own" }), {
    date: "2026-11-12",
    entry: { kind: "posted", source: "reddit", external_id: "https://www.reddit.com/r/cycling/comments/a1/", title: "My first century", subtitle: "r/cycling", url: "https://www.reddit.com/r/cycling/comments/a1/" },
  });
  const comment = A.redditPosted({ kind: "comment", community: "r/books", on: "What are you reading?", text: "a long reply", link: "https://www.reddit.com/r/books/comments/b2/x/c3/", date: "2026-11-12" })!;
  assert.deepEqual([comment.entry.title, comment.entry.note], ["What are you reading?", "comment"]);
  assert.ok(!JSON.stringify(comment).includes("a long reply"));
  assert.deepEqual(A.redditPosted({ kind: "post", community: "r/x", title: "Spicy", link: "https://www.reddit.com/r/x/comments/n/", nsfw: true, date: "2026-11-12" })!.entry, { kind: "posted", source: "reddit", external_id: "https://www.reddit.com/r/x/comments/n/", title: "Posted in r/x" });
  assert.equal(A.redditPosted({ kind: "comment", community: "r/secret", private: true, date: "2026-11-12", time: "10:00" })!.entry.title, "Commented in r/secret");
  const saved = A.redditSaved({ kind: "post", community: "r/nsfwthing", title: "Not this", link: "https://www.reddit.com/r/nsfwthing/comments/z/", nsfw: true }, "saved", "2026-11-12")!;
  assert.deepEqual(saved.entry, { kind: "saved", source: "reddit", external_id: "saved:https://www.reddit.com/r/nsfwthing/comments/z/", title: "Saved a post in r/nsfwthing" });
  const c = A.redditSaved({ kind: "comment", community: "r/books", on: "A thread", text: "someone else's comment", link: "https://www.reddit.com/r/books/c/1/" }, "upvoted", "2026-11-12")!;
  assert.ok(!JSON.stringify(c).includes("someone else's"));
});

test("Reddit: saved and upvoted have no dates: the first check remembers what's there, a later one saves what's new on today", async () => {
  let items: Row[] = [{ kind: "post", community: "r/a", title: "Old one", link: "https://www.reddit.com/r/a/1/" }];
  const acct = fake((n, a) => (n === "my_saved" || n === "my_upvoted" ? { items } : { items: [] }));
  const state: Record<string, unknown> = {};
  const saved = all(A.redditRecent, acct).find((s) => s.id === "my_saved")!;
  assert.deepEqual((await saved.read(0, ctx(state))).entries, []);
  items = [{ kind: "post", community: "r/a", title: "New one", link: "https://www.reddit.com/r/a/2/" }, ...items];
  assert.deepEqual(titles(await saved.read(0, ctx(state))), ["New one"]);
  assert.ok(JSON.stringify(state).length < 400 && !JSON.stringify(state).includes("New one"), "hashes only");
  assert.deepEqual(acct.calls.at(-1)!.args, { limit: 25 });
});

// ---------- Bluesky, Mastodon ----------

test("Social: the owner's first words without handles or links; a reply with no name; quote posts; content warnings", () => {
  assert.equal(A.firstWords("@friend.bsky.social thanks! See https://example.com/x for more"), "thanks! See for more");
  assert.equal(A.postTitle({ kind: "reply", text: "@alice@mastodon.social agreed, that's the one" }), "Replied: agreed, that's the one");
  assert.equal(A.postTitle({ kind: "post", quote: true, text: "this" }), "Quoted a post");
  assert.equal(A.postTitle({ kind: "post", content_warning: "Spoilers for Severance", text: "the ending!" }), "Spoilers for Severance");
  assert.ok(A.firstWords("word ".repeat(40)).length <= 81);
});

test("Social: a busy day is one count entry plus the 3 most liked, the day's single posts go, and each post counts once", () => {
  const post = (i: number, likes = 0) => ({ kind: "post", text: `Post ${i}`, link: `https://bsky.app/profile/me/post/${i}`, likes });
  const quiet = A.socialDay("bluesky", "2026-11-12", [post(1), post(2)]);
  assert.deepEqual([titles(quiet), quiet.keep], [["Post 1", "Post 2"], undefined]);
  const busy = A.socialDay("bluesky", "2026-11-12", Array.from({ length: 12 }, (_, i) => post(i, i === 4 ? 50 : i === 7 ? 30 : i === 9 ? 20 : 1)));
  assert.deepEqual(titles(busy), ["12 posts on Bluesky", "Post 4", "Post 7", "Post 9"]);
  assert.deepEqual(busy.entries[0].entry, { kind: "posted", source: "bluesky", external_id: "posts:2026-11-12", title: "12 posts on Bluesky", count: 12 });
  assert.equal(busy.entries[1].entry.note, A.TOP_NOTE);
  assert.deepEqual(busy.keep, ["posts:2026-11-12", "https://bsky.app/profile/me/post/4", "https://bsky.app/profile/me/post/7", "https://bsky.app/profile/me/post/9"]);
  // Two posts already counted when it was quiet; the busy day's tally adds the other ten.
  const counted: Record<string, [number, string]> = {};
  countNew(quiet.tally, counted, "2026-10-01");
  assert.deepEqual(countNew(busy.tally, counted, "2026-10-01"), { post: 10 });
});

test("Social: each day from the cursor is read whole with date", async () => {
  const acct = fake((_n, a) => ({ items: a.date === "2026-11-12" ? [{ kind: "post", text: "Hello", link: "https://mastodon.social/@me/1", favourites: 2 }] : [] }));
  const r = await all(A.mastodonRecent, acct)[0].read(Date.parse("2026-11-11T23:30:00Z"), ctx());
  assert.deepEqual(acct.calls.map((c) => c.args), [{ date: "2026-11-11" }, { date: "2026-11-12" }]);
  assert.deepEqual(r.entries, [{ date: "2026-11-12", entry: { kind: "posted", source: "mastodon", external_id: "https://mastodon.social/@me/1", title: "Hello", url: "https://mastodon.social/@me/1" } }]);
});

// ---------- Health ----------

test("Health: the last 3 days every check, Polar's changed days when allowed, sealed days only (no entries), empty days skipped", async () => {
  const acct = fake((n, a) =>
    n === "changed_days" ? { items: ["2026-11-01", "2026-11-12"] } : a.date === "2026-11-11" ? { date: a.date, source: "polar", sleep_minutes: 420, workouts: [{ type: "run", minutes: 30, start: "07:00" }] } : { date: a.date, source: "polar", workouts: [] },
  );
  const r = await all(A.polarRecent, acct)[0].read(NOW - 3600_000, ctx({}, ["day_summary", "changed_days"]));
  assert.deepEqual(acct.calls.map((c) => c.args.date ?? c.name), ["changed_days", "2026-11-01", "2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.health, [{ date: "2026-11-11", source: "polar", sleep_minutes: 420, workouts: [{ type: "run", minutes: 30, start: "07:00" }] }]);
  assert.deepEqual(r.tally!.map((t) => t.word), ["workout", "health day"]);
  // Without changed_days allowed, Polar's new-data list is left alone.
  const quiet = fake((_n, a) => ({ date: a.date, source: "polar" }));
  await all(A.polarRecent, quiet)[0].read(NOW - 3600_000, ctx({}, ["day_summary"]));
  assert.ok(!quiet.calls.some((c) => c.name === "changed_days"));
  assert.equal(A.healthDayOf({ date: "2026-11-12", nonsense: 1 }, "oura", "2026-11-12"), null, "a day that won't read is skipped, not saved");
});

// ---------- Counting, the line, metrics ----------

test("Counting: each thing once however many checks see it, a count that grows adds the difference, and the line says each kind", () => {
  const counted: Record<string, [number, string]> = {};
  const chess = { date: "2026-11-12", entry: { kind: "chess" as const, source: "lichess", external_id: "chess:2026-11-12", title: "Chess on Lichess", count: 2 } };
  assert.deepEqual(countNew([tallyOf(chess)], counted, "2026-10-01"), { "chess game": 2 });
  assert.deepEqual(countNew([tallyOf(chess)], counted, "2026-10-01"), {});
  assert.deepEqual(countNew([tallyOf({ ...chess, entry: { ...chess.entry, count: 3 } })], counted, "2026-10-01"), { "chess game": 1 });
  assert.equal(tallyOf({ date: "2026-11-12", entry: { kind: "habit", source: "habitify", external_id: "h:2026-11-12", title: "Read", count: 0 } }).n, 0, "a missed habit isn't new");
  assert.deepEqual([wordOf({ kind: "saved", source: "goodreads" }), wordOf({ kind: "saved", source: "raindrop" }), wordOf({ kind: "other", source: "eventbrite" })], ["book", "bookmark", "event"]);
  assert.equal(activityLine({ plays: 6, watches: 1, likes: 0, counts: { book: 2, workout: 1 } }), "6 plays, 1 watch, 2 books, 1 workout");
  assert.equal(activityLineFromStats({ plays_new: 6, watches_new: 1, books_new: 2, workouts_new: 1, chess_games_new: 1 }), "6 plays, 1 watch, 2 books, 1 chess game, 1 workout");
  assert.equal(activityLine({ plays: 0, watches: 0, likes: 0 }), "Nothing new");
});

test("Metrics: worked out from the day's entries, the recipe's names, and only for sources that are read", () => {
  const row = (kind: string, source: string, extra: Row = {}) => ({ id: `${source}${kind}${Math.random()}`, date: "2026-11-12", kind, source, count: 1, minutes: null, note: null, grp: null, folded_into: null, ...extra }) as never;
  const value = (name: string, rows: never[]) => METRICS.find((m) => m.name === name)!.value(rows);
  assert.equal(value("books_finished_day", [row("read", "goodreads", { note: "finished" }), row("read", "goodreads", { note: "started" })]), 1);
  assert.equal(value("highlights_made_day", [row("highlight", "readwise", { count: 3 }), row("highlight", "readwise")]), 4);
  assert.equal(value("game_minutes_day", [row("played", "steam", { minutes: 90 }), row("played", "steam", { minutes: 30 })]), 120);
  assert.equal(value("game_minutes_day", [row("played", "steam", { minutes: 90 }), row("played", "steam")]), undefined, "a game with no earlier total leaves the day out");
  assert.equal(value("game_minutes_day", []), 0, "read, nothing played: 0");
  assert.equal(value("chess_games_day", [row("chess", "lichess", { count: 2 }), row("chess", "chesscom")]), 3);
  assert.equal(value("posts_made_day", [row("posted", "bluesky", { count: 12 }), row("posted", "bluesky", { note: A.TOP_NOTE }), row("posted", "reddit")]), 13);
  const film = row("watched", "trakt", { id: "f1" });
  assert.equal(value("films_watched_day", [film, row("watched", "letterboxd", { folded_into: "f1" })]), 1, "one film from two sources");
  assert.equal(value("episodes_watched_day", [row("watched", "plex", { grp: "Severance", count: 2 })]), 2);
  assert.deepEqual(metricsFor(["goodreads", "strava"]), ["books_finished_day"], "health makes no metric");
  assert.deepEqual(metricsFor(["bluesky"]), ["posts_made_day"]);
});

// ---------- The evening run's recipe ----------

test("Recipe: a source read whole loses its rules, health and places keep theirs, counted metrics go; with nothing covered it's unchanged", () => {
  assert.equal(lifeLogPrompt(new Set()), RECIPE_PROMPTS["life-log"]);
  const t = lifeLogPrompt(new Set(["goodreads", "steam", "strava", "oura", "withings", "whoop", "polar"]), new Set(["books_finished_day", "game_minutes_day"]));
  assert.ok(!t.includes("   - Goodreads:") && !t.includes("   - Games (Steam):") && !t.includes("   - Whoop and Polar:"));
  assert.ok(t.includes("   - Health (Strava, Oura, Withings, Whoop, Polar):"), "the rule never to write a health figure stays");
  assert.ok(t.includes("   - Readwise:") && t.includes("   - Places"));
  assert.ok(!t.includes('"books_finished_day"') && !t.includes('"game_minutes_day"') && t.includes('"chess_games_day"'));
  assert.match(t, /Your activity already saved everything from goodreads, oura, polar, steam, strava, whoop, withings/);
  assert.match(t, /Athena counts books_finished_day, game_minutes_day itself/);
  // Media too: every source with a direct adapter is read whole.
  const media = lifeLogPrompt(new Set(["trakt", "letterboxd", "plex", "jellyfin", "youtube", "spotify", "lastfm", "listenbrainz"]));
  for (const rule of ["   - Trakt:", "   - Letterboxd:", "   - Plex, Jellyfin:", "   - YouTube:", "   - Music (Spotify, Last.fm):", "   - ListenBrainz:"]) assert.ok(!media.includes(rule), rule);
  assert.ok(media.includes("   - Netflix (no API):"), "Netflix (a file import, no adapter) keeps its rule");
  // Chess stays while only one of its sites is covered.
  assert.ok(lifeLogPrompt(new Set(["lichess"])).includes("   - Chess (Lichess, Chess.com):"));
  // Unless the Life log reads only Lichess.
  assert.ok(!lifeLogPrompt(new Set(["lichess"]), new Set(), new Set(["lichess", "trakt"])).includes("   - Chess (Lichess, Chess.com):"));
  assert.ok(lifeLogPrompt(new Set(["lichess"]), new Set(), new Set(["lichess", "chesscom"])).includes("   - Chess (Lichess, Chess.com):"));
});
