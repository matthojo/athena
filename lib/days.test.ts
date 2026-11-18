// Days: the pure parts (lib/days.ts, lib/day-imports.ts, lib/days-convert.ts).
// Run: npx tsx --test lib/days.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarLabel, calendarLabelOrder, cleanUrl, foldInto, heatFor, isMoodQuestion, linkRepair, matchKey, readEntry, readLine, readRating, sameThing, dayWords, splitLink, unlinkEntry } from "./days";
import { goodreadsEntries, netflixEntries, youtubeEntries } from "./day-imports";
import { lineFromTitle, parseLifeLogNote, readNoteLine, sourceOf } from "./days-convert";
import { episodeHash } from "./netflix-csv";
import { eventEnd } from "./db";

test("readEntry: checks every field and keeps only what's real", () => {
  const e = readEntry({
    kind: "watched",
    source: "Trakt",
    external_id: 98765,
    title: "  Severance\n",
    subtitle: "S2E3 · Who Is Alive?",
    at: "2026-11-06T21:40:00+00:00",
    url: "https://trakt.tv/shows/severance",
    rating: "8/10",
    count: 1,
    minutes: 52,
    group: "Severance",
  });
  assert.deepEqual(e, {
    kind: "watched",
    source: "trakt",
    external_id: "98765",
    title: "Severance",
    subtitle: "S2E3 · Who Is Alive?",
    at: "2026-11-06T21:40:00.000Z",
    url: "https://trakt.tv/shows/severance",
    rating: 4,
    minutes: 52,
    group: "Severance",
  });
  assert.equal(readEntry({ kind: "watched", source: "letterboxd", external_id: "x", title: "Dune", rating: "★★★★½" }).rating, 4.5);
  assert.equal(readEntry({ kind: "listened", source: "lastfm", external_id: "x", title: "Blackstar", count: 7 }).count, 7);
  // A link that isn't http(s) is dropped, never stored.
  assert.equal(readEntry({ kind: "saved", source: "reddit", external_id: "x", title: "A post", url: "javascript:alert(1)" }).url, undefined);
  for (const bad of [
    { kind: "binge", source: "trakt", external_id: "1", title: "X" },
    { kind: "watched", source: "Trakt TV!", external_id: "1", title: "X" },
    { kind: "watched", source: "trakt", external_id: "", title: "X" },
    { kind: "watched", source: "trakt", external_id: "1", title: "   " },
    { kind: "watched", source: "trakt", external_id: "1", title: "X", at: "last Tuesday" },
  ]) {
    assert.throws(() => readEntry(bad), JSON.stringify(bad));
  }
});

test("links written into an entry's words: the words stay, the link becomes url", () => {
  const track = "https://open.spotify.com/track/2KlukXYZ";
  const base = { kind: "listened", source: "spotify", external_id: "x" };
  // A Markdown link in the subtitle: url set, text clean.
  const a = readEntry({ ...base, title: "Showing Teeth", subtitle: `A Fate Worse Than Loneliness [A Fate Worse Than Loneliness](${track})` });
  assert.equal(a.url, track);
  assert.equal(a.subtitle, "A Fate Worse Than Loneliness A Fate Worse Than Loneliness");
  const b = readEntry({ ...base, title: "Showing Teeth", subtitle: `[A Fate Worse Than Loneliness](${track})` });
  assert.deepEqual([b.subtitle, b.url], ["A Fate Worse Than Loneliness", track]);
  // "[link](…)"-style labels go entirely, wherever they are.
  const c = readEntry({ ...base, title: `Showing Teeth [link](${track})`, subtitle: "A Fate Worse Than Loneliness", count: 2 });
  assert.deepEqual([c.title, c.subtitle, c.url, c.count], ["Showing Teeth", "A Fate Worse Than Loneliness", track, 2]);
  assert.equal(readEntry({ ...base, title: "Blackstar", note: `the whole album · [Listen on Spotify](${track})` }).note, "the whole album");
  assert.equal(readEntry({ ...base, title: "Blackstar", note: `[link](${track})` }).note, undefined);
  // A bare URL.
  const d = readEntry({ ...base, title: "Blackstar", subtitle: `David Bowie ${track}` });
  assert.deepEqual([d.subtitle, d.url], ["David Bowie", track]);
  assert.equal(readEntry({ ...base, title: "Blackstar", note: `(${track}).` }).url, track);
  // A real title with brackets is left alone.
  for (const title of ["[Untitled]", "Heroes [2017 Remaster] (Live)", "Song [feat. X]"]) assert.equal(readEntry({ ...base, title }).title, title);
  // A url it has is kept; the text still loses the link.
  const e = readEntry({ ...base, title: `Blackstar [link](${track})`, url: "https://www.last.fm/music/David+Bowie/Blackstar" });
  assert.deepEqual([e.title, e.url], ["Blackstar", "https://www.last.fm/music/David+Bowie/Blackstar"]);
  // A link longer than the cap is taken before the cap, never cut in half.
  const long = `https://example.com/${"a".repeat(400)}`;
  assert.equal(readEntry({ ...base, title: "Long", note: `[link](${long})` }).url, long);
  // A link cut off already ("…") is dropped from the words, never stored as url.
  assert.deepEqual(splitLink("Showing Teeth, 2 plays [link](https://open.spotify.com/track/2Kluk…"), { text: "Showing Teeth, 2 plays" });
  // Only http(s) is ever taken.
  assert.equal(splitLink("[x](javascript:alert(1))").url, undefined);
  // Only a link for a title: its site, rather than nothing.
  assert.equal(unlinkEntry({ title: `[link](${track})` }).title, "open.spotify.com");
});

test("unlinkEntry and linkRepair: clean rows untouched, the repair idempotent", () => {
  const clean = { title: "Blackstar", subtitle: "David Bowie" };
  assert.equal(unlinkEntry(clean), clean);
  assert.equal(linkRepair({ title: "Blackstar", subtitle: "David Bowie", url: null, note: null }), null);
  const row = { title: "Showing Teeth", subtitle: "A Fate Worse Than Loneliness", url: null, note: "2 plays [link](https://open.spotify.com/track/2KlukXYZ)" };
  const fixed = linkRepair(row);
  assert.deepEqual(fixed, { title: "Showing Teeth", subtitle: "A Fate Worse Than Loneliness", url: "https://open.spotify.com/track/2KlukXYZ", note: "2 plays" });
  // Run again on what it wrote: nothing to do.
  assert.equal(linkRepair(fixed!), null);
  const once = unlinkEntry({ title: "x https://a.example/1", note: "[y](https://b.example/2)" });
  assert.equal(unlinkEntry(once), once);
  assert.deepEqual(once, { title: "x", note: "y", url: "https://a.example/1" });
});

test("readLine: one sentence, at most 280 characters", () => {
  assert.equal(readLine("  Finished Severance\nand started The Wager "), "Finished Severance and started The Wager");
  assert.equal(readLine(null), "");
  assert.throws(() => readLine("x".repeat(281)));
  assert.throws(() => readLine(7));
});

test("readRating and cleanUrl", () => {
  assert.equal(readRating("8/10", "trakt"), 4);
  assert.equal(readRating(9, "trakt"), 4.5, "Trakt's numbers are out of 10");
  assert.equal(readRating(4, "goodreads"), 4);
  assert.equal(readRating("★★★", "letterboxd"), 3);
  assert.equal(readRating("", "trakt"), undefined);
  assert.equal(cleanUrl("http://example.com/a b"), "http://example.com/a%20b");
  assert.equal(cleanUrl("ftp://example.com"), undefined);
});

test("sameThing and foldInto: Trakt's episode joins Netflix's", () => {
  const netflix = { kind: "watched" as const, source: "netflix", external_id: "a", title: "Severance", subtitle: "Season 2 · Who Is Alive?", url: "https://www.netflix.com/search?q=Severance" };
  const trakt = { kind: "watched" as const, source: "trakt", external_id: "b", title: "The Severance", subtitle: "S2E3 · Who Is Alive?", url: "https://trakt.tv/x", rating: 4 };
  assert.ok(sameThing(netflix, trakt));
  assert.ok(!sameThing(netflix, { ...trakt, subtitle: "S2E4 · Woe's Hollow" }), "another episode");
  assert.ok(sameThing({ title: "Dune" }, { title: "Dune", subtitle: "2021" }), "a film with and without its year");
  assert.deepEqual(foldInto(netflix, trakt), { rating: 4, subtitle: "S2E3 · Who Is Alive?" }, "the numbered subtitle and rating; Netflix keeps its link");
  assert.equal(matchKey("The Wager: A Tale"), "wager a tale");
});

test("heatFor: one scale, 0 to 4", () => {
  const empty = { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0 };
  assert.equal(heatFor(empty), 0);
  assert.equal(heatFor(empty, { line: true }), 1, "a line alone is a day");
  assert.equal(heatFor({ ...empty, entries: 2 }), 1);
  assert.equal(heatFor({ ...empty, entries: 3, photos: 1 }), 2);
  assert.equal(heatFor({ ...empty, entries: 6, minutes: { listened: 180 } }), 3);
  assert.equal(heatFor({ ...empty, entries: 9, notes: 2, photos: 1 }), 4);
});

test("isMoodQuestion: only questions about feelings open mood and journal", () => {
  for (const q of ["How was I feeling last week?", "What did I write in my journal in March?", "When was my last bad day?"]) assert.ok(isMoodQuestion(q), q);
  for (const q of ["What was I watching in March?", "What did Gayle say about pricing?"]) assert.ok(!isMoodQuestion(q), q);
});

test("dayWords", () => {
  assert.equal(dayWords("2026-11-06", "2026-11-07"), "Friday 6 November");
  assert.equal(dayWords("2025-03-14", "2026-11-07"), "Friday 14 March 2025");
});

test("imports: one id per thing, shared with the conversion", () => {
  const yt = youtubeEntries({ day: "2026-11-06", videos: [{ id: "dQw4w9WgXcQ", title: "Never Gonna", channel: "Rick", count: 3, music: false }, { id: "aaaaaaaaaaa", title: "Song", channel: "Band", count: 1, music: true }] });
  assert.deepEqual(yt.map((e) => [e.kind, e.source, e.external_id, e.count]), [["watched", "youtube", "2026-11-06:dQw4w9WgXcQ", 3], ["listened", "youtube_music", "2026-11-06:aaaaaaaaaaa", undefined]]);
  const nf = netflixEntries({ day: "2024-03-14", watched: [{ title: "Slow Horses", season: "S4", episodes: ["Hello Goodbye", "Identity Theft"] }, { title: "Roma" }] });
  assert.deepEqual(nf.map((e) => [e.external_id, e.subtitle ?? null, e.group ?? null]), [
    [`2024-03-14:${episodeHash("Slow Horses", "S4", "Hello Goodbye")}`, "S4 · Hello Goodbye", "Slow Horses"],
    [`2024-03-14:${episodeHash("Slow Horses", "S4", "Identity Theft")}`, "S4 · Identity Theft", "Slow Horses"],
    ["2024-03-14:film:roma", null, null],
  ]);
  const gr = goodreadsEntries({ day: "2026-01-02", books: [{ id: "123", title: "The Wager", author: "David Grann", rating: 5 }, { id: "9", title: "Dune", author: "", rating: 0, want: true }] });
  assert.deepEqual(gr.map((e) => [e.kind, e.external_id, e.rating ?? null, e.note]), [["read", "book:123", 5, "finished"], ["saved", "want:9", null, "want to read"]]);
});

const SAMPLE = `## Health
7h 40m sleep · 9,200 steps · 52 bpm resting

## Places
Work, lunch at Dishoom, then Hampstead Heath
14° and rain in London

## Watched
- [Severance S2E3 · Who Is Alive?](https://trakt.tv/shows/severance/seasons/2/episodes/3) · 8/10
- [Slow Horses S4](https://www.netflix.com/search?q=Slow%20Horses#e=${episodeHash("Slow Horses", "S4", "Hello Goodbye")}) · Hello Goodbye
- Started: [Dune (2021)](https://trakt.tv/movies/dune-2021) · paused at 40%

## Listened
- [Blackstar](https://www.last.fm/music/David+Bowie/Blackstar) · David Bowie · the whole album · 7 tracks · 41 min

## Read
- [The Wager](https://www.goodreads.com/book/show/123) · David Grann
- 3 highlights from [Tomorrow, and Tomorrow](https://readwise.io/bookreview/1) · Gabrielle Zevin (Kindle)

## Played
- [Balatro](https://store.steampowered.com/app/2379780) · 2h 10m
- Chess: 4 games on Lichess, 3 wins

## Liked and saved
- [How to build a boat](https://www.youtube.com/watch?v=dQw4w9WgXcQ) · Some Channel

## Posted
- [Finally finished Severance, what an ending](https://bsky.app/profile/me/post/1)

## Watched on YouTube
- [A video](https://www.youtube.com/watch?v=bbbbbbbbbbb) · A Channel · 2 times
`;

test("parseLifeLogNote: every section becomes entries; Health and Places stay in their sealed rows", () => {
  const p = parseLifeLogNote("2026-11-06", "11111111-1111-1111-1111-111111111111", "Friday 6 November · Severance, Bowie and a book", SAMPLE);
  assert.equal(p.line, "Severance, Bowie and a book");
  const by = (k: string) => p.entries.filter((e) => e.kind === k);
  // Nothing from Health or Places.
  assert.ok(!p.entries.some((e) => /sleep|steps|Dishoom|rain/i.test(JSON.stringify(e))), JSON.stringify(p.entries));
  // YouTube's import lines keep the import's id.
  const yt = p.entries.find((e) => e.source === "youtube" && e.kind === "watched");
  assert.equal(yt?.external_id, "2026-11-06:bbbbbbbbbbb");
  assert.equal(yt?.count, 2);
  // Netflix's line keeps the import's episode id.
  assert.equal(p.entries.find((e) => e.source === "netflix")?.external_id, `2026-11-06:${episodeHash("Slow Horses", "S4", "Hello Goodbye")}`);
  const sev = by("watched").find((e) => e.title === "Severance")!;
  assert.equal(sev.subtitle, "S2E3 · Who Is Alive?");
  assert.equal(sev.source, "trakt");
  assert.equal(sev.rating, 4);
  const dune = by("watched").find((e) => e.title.startsWith("Dune"))!;
  assert.equal(dune.note, "started");
  assert.equal(dune.subtitle, "paused at 40%");
  const bowie = by("listened")[0];
  assert.deepEqual([bowie.title, bowie.subtitle, bowie.count, bowie.minutes, bowie.note, bowie.source], ["Blackstar", "David Bowie", 7, 41, "the whole album", "lastfm"]);
  assert.equal(by("read")[0].title, "The Wager");
  assert.equal(by("highlight")[0].title, "Tomorrow, and Tomorrow");
  assert.equal(by("highlight")[0].count, 3);
  assert.equal(by("highlight")[0].source, "readwise");
  assert.equal(by("played")[0].minutes, 130);
  assert.equal(by("chess")[0].title, "Chess: 4 games on Lichess, 3 wins");
  assert.equal(by("saved")[0].subtitle, "Some Channel");
  assert.equal(by("posted")[0].source, "bluesky");
  // The same note again gives the same ids: the conversion is idempotent.
  const again = parseLifeLogNote("2026-11-06", "11111111-1111-1111-1111-111111111111", "x", SAMPLE);
  assert.deepEqual(again.entries.map((e) => e.external_id), p.entries.map((e) => e.external_id));
});

test("lineFromTitle: the run's description, not an import's count", () => {
  assert.equal(lineFromTitle("Friday 6 November · Severance, a film and a book"), "Severance, a film and a book");
  assert.equal(lineFromTitle("Friday 6 November · 12 YouTube videos"), null);
  assert.equal(lineFromTitle("Wednesday 13 March 2024 · Slow Horses on Netflix"), null);
  assert.equal(lineFromTitle("Friday 6 November"), null);
});

test("readNoteLine and sourceOf", () => {
  assert.equal(readNoteLine("- just some words", "other")?.title, "just some words");
  assert.equal(readNoteLine("- ", "other"), null);
  assert.equal(sourceOf("https://letterboxd.com/me/film/dune/"), "letterboxd");
  assert.equal(sourceOf("https://mastodon.social/@me/1"), "life_log");
  assert.equal(sourceOf(undefined), "life_log");
});

test("markMatches: matching words in « », a run marked once", async () => {
  const { markMatches, parseQuery } = await import("./text-search");
  assert.equal(markMatches("A Bowie afternoon and two games", parseQuery("bowie afternoon")!), "A «Bowie afternoon» and two games");
  assert.equal(markMatches("The Wager · David Grann", parseQuery("wager")!), "The «Wager» · David Grann");
  assert.equal(markMatches("Nothing here", parseQuery("wager")!), "Nothing here");
});

test("calendarLabel: the owner's label, else work or personal from the source, else none", () => {
  assert.equal(calendarLabel("Family", "calendar-meetings"), "family");
  assert.equal(calendarLabel("", "calendar-meetings-personal"), "personal");
  assert.equal(calendarLabel(null, "calendar-meetings-work"), "work");
  assert.equal(calendarLabel(null, "calendar-meetings"), null);
  assert.equal(calendarLabel(null, null), null);
});

test("calendarLabelOrder: work, personal, then the rest alphabetically, lowercased and once each", () => {
  assert.deepEqual(calendarLabelOrder(["Family", "personal", "band", "", null, "WORK", "family"]), ["work", "personal", "band", "family"]);
  assert.deepEqual(calendarLabelOrder(["family"]), ["family"]);
});

test("eventEnd: the end given if it's after the start; none given keeps the stored one, moved with the start", () => {
  const start = "2026-11-06T09:00:00.000Z";
  assert.equal(eventEnd(start, "2026-11-06T10:30:00+01:00", null), "2026-11-06T09:30:00.000Z");
  assert.equal(eventEnd(start, "2026-11-06T08:00:00Z", null), null, "before the start");
  assert.equal(eventEnd(start, null, { starts_at: start, ends_at: "2026-11-06T10:00:00Z" }), null, "cleared");
  assert.equal(eventEnd(start, undefined, null), null);
  assert.equal(eventEnd(start, undefined, { starts_at: start, ends_at: null }), null, "an event with no end keeps none");
  assert.equal(eventEnd("2026-11-06T11:00:00.000Z", undefined, { starts_at: start, ends_at: "2026-11-06T09:45:00Z" }), "2026-11-06T11:45:00.000Z", "moved an hour later, same length");
  assert.equal(eventEnd(null, "2026-11-06T10:00:00Z", null), null, "all-day");
});
