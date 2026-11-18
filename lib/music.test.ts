// Run: npx tsx --test lib/music.test.ts
// Music's aggregation (lib/music.ts): plays from count, the periods and the span before, new artists, the timeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artistDetail, buildMusic, change, mondayOf, periodArtists, playsOf, previousSpan, resolvePeriod, timelineTakeaway, type MusicRow } from "./music";

const TODAY = "2026-11-10";
const row = (date: string, artist: string | null, title: string | null, plays = 1, art: MusicRow["art"] = null): MusicRow => ({ date, artist, title, plays, art });

test("plays: count, else 1", () => {
  assert.equal(playsOf(7), 7);
  assert.equal(playsOf(1), 1);
  assert.equal(playsOf(0), 1);
  assert.equal(playsOf(null), 1);
  assert.equal(playsOf(undefined), 1);
});

test("periods: this month, this year, an earlier year, all time; anything else is this month", () => {
  assert.deepEqual(resolvePeriod("month", TODAY), { id: "month", kind: "month", label: "November 2026", from: "2026-11-01", to: TODAY });
  assert.deepEqual(resolvePeriod("year", TODAY), { id: "year", kind: "year", label: "2026", from: "2026-01-01", to: TODAY });
  assert.deepEqual(resolvePeriod("2024", TODAY), { id: "2024", kind: "past", label: "2024", from: "2024-01-01", to: "2024-12-31" });
  assert.equal(resolvePeriod("all", TODAY).from, null);
  for (const odd of ["2026", "2031", "1800", "week", "", null, undefined, "2024-01"]) assert.equal(resolvePeriod(odd, TODAY).id, "month", String(odd));
});

test("the span before: the same days last month, the same date last year, the whole year before", () => {
  assert.deepEqual(previousSpan(resolvePeriod("month", TODAY)), { from: "2026-10-01", to: "2026-10-10", label: "October" });
  assert.deepEqual(previousSpan(resolvePeriod("month", "2026-03-31")), { from: "2026-02-01", to: "2026-02-28", label: "February" });
  assert.deepEqual(previousSpan(resolvePeriod("month", "2026-01-15")), { from: "2025-12-01", to: "2025-12-15", label: "December" });
  assert.deepEqual(previousSpan(resolvePeriod("year", TODAY)), { from: "2025-01-01", to: "2025-11-10", label: "this point last year" });
  assert.deepEqual(previousSpan(resolvePeriod("2024", TODAY)), { from: "2023-01-01", to: "2023-12-31", label: "2023" });
  assert.equal(previousSpan(resolvePeriod("all", TODAY)), null);
  assert.equal(change(120, 100), 0.2);
  assert.equal(change(5, 0), null);
});

test("artists and albums ranked by plays, names matched without case, the chip against before", () => {
  const art = { id: "a".repeat(22), w: 600, h: 600 };
  const rows = [
    row("2026-11-02", "Mara Vell", "Tidal Hours", 12, art),
    row("2026-11-03", "mara vell ", "Tidal Hours", 3),
    row("2026-11-03", "Ostra", "Amber Signals", 9),
    row("2026-11-04", "Halden", "Halden", 2), // the artist as the title: tracks from many albums, not an album
    row("2026-10-05", "Ostra", null, 10), // last month, before the 10th
    row("2026-10-20", "Ostra", null, 50), // last month, after the 10th: not in the span before
  ];
  const m = buildMusic(rows, "month", TODAY);
  assert.equal(m.plays, 26);
  assert.equal(m.days, 3);
  assert.equal(m.artists, 3);
  assert.deepEqual(
    m.top_artists.map((a) => [a.name, a.plays]),
    [["Mara Vell", 15], ["Ostra", 9], ["Halden", 2]]
  );
  assert.deepEqual(m.top_artists[0].art, art, "the artist wears its most played album's cover");
  assert.deepEqual(
    m.top_albums.map((a) => [a.title, a.plays]),
    [["Tidal Hours", 15], ["Amber Signals", 9]]
  );
  assert.deepEqual(m.previous, { label: "October", plays: 10, change: 1.6 });
  assert.equal(m.recent[0].date, "2026-11-04");
  assert.deepEqual(m.recent[1], { date: "2026-11-03", plays: 12, artists: ["Ostra", "mara vell"] });
});

test("new this period: artists first played inside it, never for all time", () => {
  const rows = [row("2025-06-01", "Ostra", null, 4), row("2026-11-02", "Ostra", "Amber Signals", 5), row("2026-11-05", "Kaito Rhee", "Soft Neon", 3), row("2026-04-01", "Halden", "Winter Index", 1), row("2026-11-06", "Halden", "Winter Index", 8)];
  const month = buildMusic(rows, "month", TODAY);
  assert.deepEqual(
    month.new_artists.map((a) => [a.name, a.first]),
    [["Kaito Rhee", "2026-11-05"]]
  );
  assert.equal(month.new_count, 1);
  const year = buildMusic(rows, "year", TODAY);
  assert.deepEqual(year.new_artists.map((a) => a.name).sort(), ["Halden", "Kaito Rhee"]);
  assert.deepEqual(buildMusic(rows, "all", TODAY).new_artists, []);
  assert.equal(month.top_artists.find((a) => a.name === "Ostra")?.first, "2025-06-01");
});

test("the switch offers earlier years with music, newest first; nothing at all is no music", () => {
  const rows = [row("2023-02-01", "A", "x"), row("2025-02-01", "B", "y"), row("2026-11-01", "C", "z")];
  assert.deepEqual(
    buildMusic(rows, "month", TODAY).periods.map((p) => p.id),
    ["month", "year", "2025", "2023", "all"]
  );
  const none = buildMusic([], "year", TODAY);
  assert.equal(none.has_music, false);
  assert.equal(none.plays, 0);
  assert.equal(none.timeline.takeaway, "");
  assert.equal(buildMusic([row("2025-02-01", "B", "y")], "month", TODAY).has_music, true, "music before this month is still music");
});

test("timeline: days for a month (the rest of it as empty slots), months for a year, years past three years of months", () => {
  assert.equal(mondayOf("2026-11-01"), "2026-10-26");
  const m = buildMusic([row("2026-11-02", "A", "x", 4), row("2026-11-07", "A", "x", 10), row("2026-11-10", "B", "y", 1)], "month", TODAY);
  assert.equal(m.timeline.unit, "day");
  assert.equal(m.timeline.points.length, 30);
  assert.deepEqual(m.timeline.points.slice(0, 3).map((p) => [p.from, p.plays]), [["2026-11-01", 0], ["2026-11-02", 4], ["2026-11-03", 0]]);
  assert.equal(m.timeline.points[9].ahead, undefined, "today is not ahead");
  assert.equal(m.timeline.points[10].ahead, true, "tomorrow is an empty slot");
  assert.equal(m.timeline.takeaway, "The busiest day was Sat 7 Nov, with 10 plays.");
  assert.equal(buildMusic([row("2026-11-04", "A", "x", 9)], "month", TODAY).timeline.takeaway, "All 9 plays came on Wed 4 Nov.");

  const y = buildMusic([row("2025-03-04", "A", "x", 30), row("2025-07-04", "A", "x", 12)], "2025", TODAY);
  assert.equal(y.timeline.unit, "month");
  assert.equal(y.timeline.points.length, 12);
  assert.equal(y.timeline.takeaway, "March was the busiest month, with 30 plays.");

  const all = buildMusic([row("2021-03-04", "A", "x", 3), row("2026-07-04", "A", "x", 12)], "all", TODAY);
  assert.equal(all.timeline.unit, "year");
  assert.deepEqual(all.timeline.points.map((p) => p.from.slice(0, 4)), ["2021", "2022", "2023", "2024", "2025", "2026"]);
  assert.equal(buildMusic([row("2025-03-04", "A", "x", 30)], "2025", TODAY).timeline.takeaway, "All 30 plays came in March.");
});

test("the takeaway notices a running stretch already above the usual", () => {
  const p = resolvePeriod("year", TODAY);
  const t = { unit: "month" as const, points: [{ from: "2026-01-01", plays: 100 }, { from: "2026-02-01", plays: 200 }, { from: "2026-03-01", plays: 100 }, { from: "2026-04-01", plays: 190 }] };
  assert.equal(timelineTakeaway(t, p), "February was the busiest month, with 200 plays. This month is already above the usual 133.");
});

test("tracks stay out of Top albums, and stand in only when a period has no albums", () => {
  const t = (date: string, artist: string, title: string, plays: number): MusicRow => ({ ...row(date, artist, title, plays), track: true });
  const mixed = buildMusic([row("2026-11-02", "Ostra", "Amber Signals", 3), t("2026-11-03", "Halden", "Frostline Pt. 2", 40)], "month", TODAY);
  assert.equal(mixed.albums_are, "albums");
  assert.deepEqual(mixed.top_albums.map((a) => a.title), ["Amber Signals"]);
  assert.deepEqual(mixed.top_artists.map((a) => [a.name, a.plays]), [["Halden", 40], ["Ostra", 3]], "track plays still count for artists");
  assert.equal(mixed.plays, 43);
  const only = buildMusic([t("2026-11-03", "Halden", "Frostline Pt. 2", 4), t("2026-11-04", "Ostra", "Glow", 9)], "month", TODAY);
  assert.equal(only.albums_are, "tracks");
  assert.deepEqual(only.top_albums.map((a) => a.title), ["Glow", "Frostline Pt. 2"]);
  assert.equal(artistDetail([t("2026-11-03", "Halden", "Frostline Pt. 2", 4)], "Halden")?.albums_are, "tracks");
});

test("an artist: plays over time, top albums, first and last played", () => {
  const rows = [row("2025-01-05", "Ostra", "Amber Signals", 4), row("2025-03-05", "Ostra", "Field Notes", 9), row("2025-03-06", "OSTRA", "Amber Signals", 6), row("2025-04-01", "Halden", "Winter Index", 3)];
  const a = artistDetail(rows, "ostra")!;
  assert.equal(a.plays, 19);
  assert.equal(a.days, 3);
  assert.equal(a.first, "2025-01-05");
  assert.equal(a.last, "2025-03-06");
  assert.equal(a.unit, "month");
  assert.deepEqual(a.points.map((p) => p.plays), [4, 0, 15]);
  assert.deepEqual(a.albums.map((x) => [x.title, x.plays]), [["Amber Signals", 10], ["Field Notes", 9]]);
  assert.equal(artistDetail(rows, "Nobody"), null);
});

test("when: plays by day of the week and hour, and one plain line", async () => {
  const { listeningTimes, timesTakeaway, hourRange, clockHour } = await import("./music");
  const at = (hourPlays: Record<number, number>) => Array.from({ length: 24 }, (_, h) => hourPlays[h] ?? 0);
  // 2026-11-02 is a Monday, 2026-11-07 a Saturday.
  const rows: MusicRow[] = [
    { ...row("2026-11-02", "A", "x", 5), hours: at({ 20: 3, 21: 2 }) },
    { ...row("2026-11-03", "A", "x", 4), hours: at({ 20: 2, 21: 2 }) },
    { ...row("2026-11-07", "B", "y", 1), hours: at({ 14: 1 }) },
    row("2026-11-04", "C", "z", 9), // no times
  ];
  const w = listeningTimes(rows);
  assert.equal(w.cells.length, 7);
  assert.equal(w.cells[0][20], 3, "Monday 8pm");
  assert.equal(w.cells[5][14], 1, "Saturday 2pm");
  assert.equal(w.timed, 10);
  assert.equal(w.max, 3);
  assert.equal(w.takeaway, "You play most on weekday evenings, 8–10pm.");
  assert.equal(buildMusic(rows, "month", TODAY).when.timed, 10);
  assert.equal(buildMusic([row("2026-11-04", "C", "z", 9)], "month", TODAY).when.timed, 0);

  const weekend = Array.from({ length: 7 }, (_, d) => at(d >= 5 ? { 14: 6, 15: 5 } : { 8: 1 }));
  assert.equal(timesTakeaway(weekend), "You play most on weekend afternoons, 2–4pm.");
  const even = Array.from({ length: 7 }, () => at({ 23: 4, 0: 3 }));
  assert.equal(timesTakeaway(even), "You play most late at night, 11pm–1am, weekdays and weekends alike.");
  assert.equal(timesTakeaway(Array.from({ length: 7 }, () => at({}))), "");
  assert.equal(clockHour(0), "12am");
  assert.equal(clockHour(12), "12pm");
  assert.equal(hourRange(11, 13), "11am–1pm");
});

test("genres: the period's plays by family against the span before; artists not looked up yet counted apart", () => {
  const families = (a: string) => ({ ostra: ["Electronic"], "mara vell": ["Folk & country", "Indie"], halden: [] as string[] })[a.toLowerCase().trim()];
  const rows = [
    row("2026-11-02", "Mara Vell", "Tidal Hours", 6),
    row("2026-11-03", "Ostra", "Amber Signals", 2),
    row("2026-11-04", "Halden", "Winter Index", 1), // looked up, nothing known
    row("2026-11-05", "Severin", "Monochrome Summer", 1), // not looked up yet
    row("2026-10-05", "Ostra", null, 4),
  ];
  const g = buildMusic(rows, "month", TODAY, { families }).genres!;
  assert.deepEqual(g.now, { genres: [{ genre: "Folk & country", plays: 6 }, { genre: "Indie", plays: 6 }, { genre: "Electronic", plays: 2 }], known: 8 });
  assert.deepEqual(g.before, { genres: [{ genre: "Electronic", plays: 4 }], known: 4 });
  assert.equal(g.covered, 0.8);
  assert.equal(g.learning, 1);
  assert.equal(buildMusic(rows, "month", TODAY).genres, undefined, "no genres handed in: none on the page");
  assert.equal(buildMusic(rows, "all", TODAY, { families }).genres!.before, null);
  // Who to ask about: the period's artists, then the span before's, most played first, once each.
  assert.deepEqual(periodArtists([...rows, row("2026-10-06", "Kestrel", null, 9), row("2026-11-06", "mara vell", "Lowlight", 1)], "month", TODAY), ["Mara Vell", "Ostra", "Halden", "Severin", "Kestrel"]);
});
