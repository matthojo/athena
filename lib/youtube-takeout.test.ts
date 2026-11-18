// Run: npx tsx --test lib/youtube-takeout.test.ts
// The Takeout parser and the day-note merge, on small synthetic fixtures (lib/fixtures/takeout-watch-history.*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  batchDays,
  dayTitle,
  daySummary,
  groupByDay,
  IMPORT_TITLE,
  keepImported,
  LISTENED_HEADING,
  mergeDay,
  parseTakeoutDate,
  parseWatchHistory,
  readImported,
  TakeoutError,
  videoIdFrom,
  WATCHED_HEADING,
} from "./youtube-takeout";

const fixture = (ext: string) => readFileSync(new URL(`./fixtures/takeout-watch-history.${ext}`, import.meta.url), "utf8");

test("JSON: watches kept, ads, removed videos, visits and Music twins dropped", () => {
  const r = parseWatchHistory(fixture("json"));
  assert.equal(r.format, "json");
  assert.deepEqual(r.skipped, { ads: 1, removed: 1, music_duplicates: 1, other: 1 });
  assert.equal(r.watches.length, 5);
  // Oldest first; "Watched " stripped; a private video's link-as-title is dropped.
  assert.deepEqual(r.watches[0], { id: "eeeeeeeeee5", title: "", channel: "", at: "2026-01-15T09:00:00.000Z", music: false });
  const music = r.watches.find((w) => w.id === "dddddddddd4")!;
  assert.equal(music.music, true, "the Music copy is the one kept");
  assert.equal(r.watches.filter((w) => w.id === "dddddddddd4").length, 1);
  assert.equal(r.watches.find((w) => w.id === "bbbbbbbbbb2")!.title, "Sharpening [chisels] *properly*");
});

test("HTML: the same rules, entities decoded, UK and US dates, unknown zones skipped", () => {
  const r = parseWatchHistory(fixture("html"));
  assert.equal(r.format, "html");
  assert.deepEqual(r.skipped, { ads: 1, removed: 1, music_duplicates: 1, other: 1 });
  assert.equal(r.watches.length, 3);
  const bench = r.watches.find((w) => w.id === "bbbbbbbbbb2")!;
  assert.equal(bench.title, `Tom & Jo's "bench" build`);
  assert.equal(bench.channel, "Fixture Benches");
  assert.equal(bench.at, "2026-07-03T21:59:59.000Z", "2:59:59 PM PDT, with a narrow no-break space");
  assert.equal(r.watches.find((w) => w.id === "aaaaaaaaaa1")!.at, "2026-07-03T23:30:00.000Z", "00:30 BST is the evening before in UTC");
});

test("dates and links", () => {
  assert.equal(parseTakeoutDate("6 Nov 2026, 21:14:03 GMT")?.toISOString(), "2026-11-06T21:14:03.000Z");
  assert.equal(parseTakeoutDate("Nov 6, 2026, 9:14:03 PM EST")?.toISOString(), "2026-11-07T02:14:03.000Z");
  assert.equal(parseTakeoutDate("Nov 6, 2026, 12:05:00 AM GMT+05:30")?.toISOString(), "2026-11-05T18:35:00.000Z");
  assert.equal(parseTakeoutDate("6 November 2026, 09:00 CET")?.toISOString(), "2026-11-06T08:00:00.000Z");
  assert.equal(parseTakeoutDate("6 Nov 2026, 21:14:03 IST"), null, "IST is ambiguous");
  assert.equal(parseTakeoutDate("yesterday"), null);
  assert.equal(videoIdFrom("https://youtu.be/aaaaaaaaaa1"), "aaaaaaaaaa1");
  assert.equal(videoIdFrom("https://www.youtube.com/watch?feature=share&v=aaaaaaaaaa1"), "aaaaaaaaaa1");
  assert.equal(videoIdFrom("https://www.youtube.com/channel/UCx"), null);
  assert.throws(() => parseWatchHistory("[not json"), TakeoutError);
});

test("zones: a day is the owner's day", () => {
  const { watches } = parseWatchHistory(fixture("json"));
  const london = groupByDay(watches, "Europe/London");
  assert.deepEqual(london.map((d) => d.day), ["2026-01-15", "2026-07-03", "2026-07-04"]);
  const jul3 = london[1];
  assert.deepEqual(jul3.videos.map((v) => [v.id, v.count, v.music]), [["dddddddddd4", 1, true], ["aaaaaaaaaa1", 1, false], ["bbbbbbbbbb2", 1, false]]);
  const utc = groupByDay(watches, "UTC");
  assert.deepEqual(utc.map((d) => d.day), ["2026-01-15", "2026-07-03"]);
  assert.equal(utc[1].videos.find((v) => v.id === "aaaaaaaaaa1")!.count, 2, "both plays fall on one UTC day");
  const tokyo = groupByDay(watches, "Asia/Tokyo");
  assert.deepEqual(tokyo.map((d) => d.day), ["2026-01-15", "2026-07-04"]);
});

test("merge: sections render, re-importing adds nothing, the rest of the note is untouched", () => {
  const { watches } = parseWatchHistory(fixture("json"));
  const [day] = groupByDay(watches, "UTC").slice(1);
  const lifeLog = "## Watched\n- Severance S2E3 · Who Is Alive? · [Trakt](https://trakt.tv/x)\n\n## Liked and saved\n- Liked [A video](https://www.youtube.com/watch?v=zzzzzzzzzz9)";
  const first = mergeDay(lifeLog, day.videos);
  assert.ok(first.body.startsWith(lifeLog), "the Life log's own sections stay as they were");
  assert.ok(first.body.includes(`${WATCHED_HEADING}\n- [Making a walnut desk](https://www.youtube.com/watch?v=aaaaaaaaaa1) · Fixture Workshop · 2 times`));
  assert.ok(first.body.includes("- [Sharpening \\[chisels\\] \\*properly\\*](https://www.youtube.com/watch?v=bbbbbbbbbb2) · Fixture Workshop"));
  assert.ok(first.body.includes(`${LISTENED_HEADING}\n- [Low Tide](https://www.youtube.com/watch?v=dddddddddd4) · Fixture Band - Topic`));
  assert.equal(first.added, 3);
  assert.equal(first.added_tracks, 1);
  assert.equal(first.watched, 3);
  assert.equal(first.listened, 1);

  const again = mergeDay(first.body, day.videos);
  assert.equal(again.changed, false, "the same file twice changes nothing");
  assert.equal(again.added, 0);
  assert.equal(again.body, first.body);

  // A newer export with one more play of the desk video adds just that.
  const more = day.videos.map((v) => (v.id === "aaaaaaaaaa1" ? { ...v, count: 3 } : v));
  const newer = mergeDay(first.body, more);
  assert.equal(newer.added, 1);
  assert.equal(newer.watched, 4);
  assert.deepEqual(readImported(newer.body).map((v) => [v.id, v.count]), [["aaaaaaaaaa1", 3], ["bbbbbbbbbb2", 1], ["dddddddddd4", 1]]);
  assert.deepEqual(readImported(newer.body)[1].title, "Sharpening [chisels] *properly*", "titles survive the round trip");
});

test("keepImported: a Life log rewrite keeps the import's sections, and only those", () => {
  const imported = mergeDay("## Watched\n- Old line", [{ id: "aaaaaaaaaa1", title: "Desk", channel: "Shop", count: 2, music: false }]).body;
  const rewrite = "## Watched\n- Severance S2E4\n\n## Listened\n- Blackstar, David Bowie: the whole album";
  const kept = keepImported(imported, rewrite);
  assert.ok(kept.startsWith(rewrite));
  assert.ok(kept.endsWith(`${WATCHED_HEADING}\n- [Desk](https://www.youtube.com/watch?v=aaaaaaaaaa1) · Shop · 2 times`));
  assert.ok(!kept.includes("Old line"));
  // A run that copied the heading itself gets the import's version, once.
  const copied = keepImported(imported, `${rewrite}\n\n${WATCHED_HEADING}\n- [Desk](https://www.youtube.com/watch?v=aaaaaaaaaa1) · Shop`);
  assert.equal(copied.split(WATCHED_HEADING).length, 2);
  assert.ok(copied.includes("2 times"));
  // No import, no change.
  assert.equal(keepImported("## Watched\n- x", rewrite), rewrite);
});

test("batches never split a day; titles", () => {
  const days = Array.from({ length: 70 }, (_, i) => ({ day: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, videos: Array.from({ length: 100 }, (_, j) => ({ id: `v${String(j).padStart(10, "0")}`, title: "", channel: "", count: 1, music: false })) }));
  const batches = batchDays(days, 31, 2500);
  assert.equal(batches.flat().length, 70);
  assert.ok(batches.every((b) => b.length <= 25 && b.reduce((n, d) => n + d.videos.length, 0) <= 2500));
  assert.equal(batchDays([{ day: "2025-01-01", videos: days[0].videos.concat(days[1].videos, days[2].videos).concat(...days.slice(3, 30).map((d) => d.videos)) }]).length, 1, "one huge day is still one batch");
  assert.equal(dayTitle("2026-11-06", "2026-11-07"), "Friday 6 November");
  assert.equal(dayTitle("2023-03-01", "2026-11-07"), "Wednesday 1 March 2023");
  assert.equal(daySummary(12, 0), "12 YouTube videos");
  assert.equal(daySummary(1, 3), "1 YouTube video and 3 tracks on YouTube Music");
  assert.ok(IMPORT_TITLE.test(`Friday 6 November · ${daySummary(1, 3)}`));
  assert.ok(!IMPORT_TITLE.test("Friday 6 November · Severance, a film and a book"));
});
