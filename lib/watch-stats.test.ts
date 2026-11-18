import assert from "node:assert/strict";
import { test } from "node:test";
import { monthDays, monthStats, watchedAs } from "./watch-stats";

test("monthDays", () => {
  assert.equal(monthDays("2026-11").length, 30);
  assert.equal(monthDays("2024-02").pop(), "2024-02-29");
  assert.deepEqual(monthDays("2026-13"), []);
});

test("a watched entry is a video, an episode or a film", () => {
  assert.equal(watchedAs({ source: "youtube" }), "video");
  assert.equal(watchedAs({ source: "trakt", group: "Severance" }), "episode");
  assert.equal(watchedAs({ source: "plex", subtitle: "S2 · E3" }), "episode");
  assert.equal(watchedAs({ source: "letterboxd", subtitle: "Celine Song" }), "film");
});

test("a month: plays by day, time from the source or the title's running time, and what it covers", () => {
  const stats = monthStats(
    [
      { date: "2026-11-02", kind: "watched", source: "trakt", title: "Who Is Alive?", subtitle: "S2E3", group: "Severance", count: 2 },
      { date: "2026-11-02", kind: "watched", source: "letterboxd", title: "Past Lives" },
      { date: "2026-11-05", kind: "watched", source: "netflix", title: "Episode 4", group: "The Bear", minutes: 31 },
      { date: "2026-11-05", kind: "watched", source: "youtube", title: "How to board a loft" },
      { date: "2026-11-05", kind: "watched", source: "trakt", title: "A film nobody knows" },
      { date: "2026-11-05", kind: "listened", source: "spotify", title: "In Rainbows", minutes: 42 },
      { date: "2026-10-31", kind: "watched", source: "letterboxd", title: "Past Lives" },
    ],
    [
      { kind: "tv", title: "Severance", meta: { minutes: 50, genres: ["Drama"] } },
      { kind: "film", title: "Past Lives", meta: { minutes: 106, genres: ["Romance"] } },
      { kind: "video", title: "How to board a loft", meta: { minutes: 14, genres: ["How-to"] } },
      // A book of the same name isn't the film.
      { kind: "book", title: "A film nobody knows", meta: { pages: 300 } },
    ],
    "2026-11",
  );
  assert.equal(stats.days.length, 30);
  assert.deepEqual(stats.days[1], { date: "2026-11-02", minutes: 206, plays: 3 });
  assert.deepEqual(stats.days[4], { date: "2026-11-05", minutes: 45, plays: 3 });
  assert.deepEqual({ ...stats, days: [] }, { month: "2026-11", days: [], films: 2, episodes: 3, shows: 2, videos: 1, plays: 6, minutes: 251, timed: 5, genres: ["Drama", "How-to", "Romance"], mix: { genres: [{ genre: "Drama", plays: 2 }, { genre: "Romance", plays: 1 }], known: 3 } });
});

test("a month's genre mix: every genre a film or show has, TV's pairs split, videos left out", () => {
  const stats = monthStats(
    [
      { date: "2026-11-02", kind: "watched", source: "trakt", title: "E1", group: "Andor", count: 3 },
      { date: "2026-11-03", kind: "watched", source: "letterboxd", title: "Arrival" },
      { date: "2026-11-04", kind: "watched", source: "youtube", title: "A set" },
    ],
    [
      { kind: "tv", title: "Andor", meta: { genres: ["Sci-Fi & Fantasy", "Action & Adventure", "Drama"] } },
      { kind: "film", title: "Arrival", meta: { genres: ["science-fiction", "Drama"] } },
      { kind: "video", title: "A set", meta: { genres: ["Electronic"] } },
    ],
    "2026-11",
  );
  assert.deepEqual(stats.mix, {
    genres: [
      { genre: "Drama", plays: 4 },
      { genre: "Science fiction", plays: 4 },
      { genre: "Action", plays: 3 },
      { genre: "Adventure", plays: 3 },
      { genre: "Fantasy", plays: 3 },
    ],
    known: 4,
  });
});

test("screen time: a week against the week before, by day, part of day and kind", async () => {
  const { dayPart, screenTime, shiftDay } = await import("./watch-stats");
  assert.equal(shiftDay("2026-11-01", -1), "2026-10-31");
  assert.deepEqual([4, 5, 11, 12, 16, 17, 21, 22, 0].map(dayPart), ["night", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
  const st = screenTime(
    [
      { date: "2026-11-09", kind: "watched", source: "trakt", title: "x", group: "Severance", count: 3, at: "2026-11-09T20:30:00Z" },
      { date: "2026-11-08", kind: "watched", source: "letterboxd", title: "Past Lives", at: "2026-11-08T09:00:00Z" },
      { date: "2026-11-06", kind: "watched", source: "youtube", title: "Unknown video" },
      // The week before.
      { date: "2026-11-01", kind: "watched", source: "trakt", title: "x", group: "Severance", at: "2026-11-01T23:30:00Z" },
      // Outside both.
      { date: "2026-10-20", kind: "watched", source: "letterboxd", title: "Past Lives" },
    ],
    [
      { kind: "tv", title: "Severance", meta: { minutes: 50 } },
      { kind: "film", title: "Past Lives", meta: { minutes: 106 } },
    ],
    "2026-11-04",
    "2026-11-10",
    { tz: "UTC", today: "2026-11-10" },
  );
  assert.equal(st.days.length, 7);
  assert.deepEqual(st.days[5], { date: "2026-11-09", minutes: 150, plays: 3 });
  assert.deepEqual(st.parts, { morning: 1, afternoon: 0, evening: 3, night: 0 });
  assert.deepEqual({ total: st.total, average: st.average, waking: st.waking, films: st.films, shows: st.shows, videos: st.videos, plays: st.plays, timed: st.timed }, { total: 256, average: 37, waking: 4, films: 106, shows: 150, videos: 0, plays: 5, timed: 4 });
  assert.deepEqual(st.before, { total: 50, average: 7, waking: 1, films: 0, shows: 50, videos: 0, plays: 1 });
  // A usual week: Monday 9 Nov, three 50-minute episodes from 20:30, the only Monday in the span.
  assert.deepEqual(st.week[0].slice(41, 47), [30, 30, 30, 30, 30, 0]);
  assert.equal(st.weekPlays[0][41], 3);
  // Sunday 8 Nov, a 106-minute film from 09:00.
  assert.deepEqual(st.week[6].slice(18, 22), [30, 30, 30, 16]);
  assert.equal(st.week.flat().reduce((a, b) => a + b, 0), 256);
  // Over midnight it runs into the next day; two Saturdays in a fortnight halve the average.
  const late = screenTime([{ date: "2026-11-07", kind: "watched", source: "plex", title: "Late", minutes: 90, at: "2026-11-07T23:30:00Z" }], [], "2026-10-28", "2026-11-10", { tz: "UTC", today: "2026-11-10" });
  assert.equal(late.week[5][47], 15);
  assert.deepEqual(late.week[6].slice(0, 3), [15, 15, 0]);
  // Part-way through a span, the average is over the days that have come.
  assert.equal(screenTime([], [], "2026-11-04", "2026-11-10", { today: "2026-11-05" }).average, 0);
});
