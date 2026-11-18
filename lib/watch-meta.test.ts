import assert from "node:assert/strict";
import { test } from "node:test";
import { bookGenres, isoMinutes, mergeMeta, minutesWords, parseTags, readMeta, seasonFit, seasonOn, SEASONS, themesFromKeywords, youtubeGenres, youtubeId } from "./watch-meta";

test("readMeta keeps what's well-formed and drops the rest", () => {
  assert.deepEqual(readMeta(null), {});
  assert.deepEqual(readMeta("not json"), {});
  assert.deepEqual(readMeta(JSON.stringify({ year: 2021, minutes: 155, genres: ["Science Fiction", " science fiction ", ""], lists: ["Watch later"], tags: ["cosy"], themes: ["christmas", "made-up"], music: true, checked: "2026-11-10T10:00:00.000Z", extra: 1 })), {
    year: 2021,
    minutes: 155,
    genres: ["Science Fiction"],
    lists: ["Watch later"],
    themes: ["christmas"],
    tags: ["cosy"],
    music: true,
    checked: "2026-11-10T10:00:00.000Z",
  });
  assert.deepEqual(readMeta({ year: 12, minutes: -4, pages: 1.5, checked: "soon" }), {});
});

test("a source fills gaps and adds playlists, and never touches tags", () => {
  const kept = { year: 1999, genres: ["Drama"], lists: ["Watch later"], tags: ["mine"] };
  assert.deepEqual(mergeMeta(kept, { year: 2001, minutes: 120, genres: ["Comedy"], lists: ["watch later", "Sets"], tags: ["theirs"], checked: "2026-11-10T10:00:00.000Z" }), {
    year: 1999,
    minutes: 120,
    genres: ["Drama"],
    lists: ["Watch later", "Sets"],
    tags: ["mine"],
    checked: "2026-11-10T10:00:00.000Z",
  });
});

test("youtubeId reads every link shape and nothing else", () => {
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?t=4", "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://m.youtube.com/embed/dQw4w9WgXcQ"]) assert.equal(youtubeId(url), "dQw4w9WgXcQ", url);
  for (const url of ["", "https://www.youtube.com/channel/UCabc", "https://vimeo.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short", "javascript:alert(1)", "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ"]) assert.equal(youtubeId(url), null, url);
});

test("isoMinutes", () => {
  assert.equal(isoMinutes("PT1H2M30S"), 63);
  assert.equal(isoMinutes("PT45S"), 1);
  assert.equal(isoMinutes("PT3M"), 3);
  assert.equal(isoMinutes("P1DT1H"), 1500);
  assert.equal(isoMinutes("P0D"), undefined);
  assert.equal(isoMinutes("1:02:03"), undefined);
  assert.equal(isoMinutes(63), undefined);
});

test("YouTube topics become genres; music genres lose their 'music'", () => {
  assert.deepEqual(youtubeGenres(["https://en.wikipedia.org/wiki/Electronic_music", "https://en.wikipedia.org/wiki/Music", "https://en.wikipedia.org/wiki/Hip_hop_music"], "10"), { genres: ["Electronic", "Hip-hop"], music: true });
  assert.deepEqual(youtubeGenres(["https://en.wikipedia.org/wiki/Lifestyle_(sociology)", "https://en.wikipedia.org/wiki/Food"], "26"), { genres: ["Food"], music: false });
  // Only a vague topic: the category says more.
  assert.deepEqual(youtubeGenres(["https://en.wikipedia.org/wiki/Knowledge"], "27"), { genres: ["Education"], music: false });
  assert.deepEqual(youtubeGenres(["https://en.wikipedia.org/wiki/Lifestyle_(sociology)"], "22"), { genres: ["Lifestyle"], music: false });
  assert.deepEqual(youtubeGenres(undefined, "10"), { genres: [], music: true });
  assert.deepEqual(youtubeGenres(["https://en.wikipedia.org/wiki/Music_of_Latin_America"], undefined), { genres: ["Latin America"], music: true });
});

test("bookGenres keeps subjects that are genres, first found first", () => {
  assert.deepEqual(bookGenres(["Fiction", "Science Fiction", "Dune (Imaginary place)", "Fiction, fantasy, general", "New York Times bestseller"]), ["Science fiction", "Fantasy"]);
  assert.deepEqual(bookGenres(["Biographies", "Shipwrecks", "History"]), ["Biography", "History"]);
  assert.deepEqual(bookGenres(["Artists"]), []);
  assert.deepEqual(bookGenres(undefined), []);
});

test("one season at a time, by the local date", () => {
  assert.equal(seasonOn(new Date(2026, 9, 31))?.id, "halloween");
  assert.equal(seasonOn(new Date(2026, 10, 1))?.id, "christmas");
  assert.equal(seasonOn(new Date(2026, 11, 31))?.id, "christmas");
  assert.equal(seasonOn(new Date(2026, 0, 1)), null);
  assert.equal(seasonOn(new Date(2026, 1, 14))?.id, "valentines");
  assert.equal(seasonOn(new Date(2026, 6, 4))?.id, "summer");
  assert.equal(seasonOn(new Date(2026, 8, 30)), null);
});

test("an item suits a season by its own words, or only by its genre", () => {
  const christmas = SEASONS.find((s) => s.id === "christmas")!;
  const halloween = SEASONS.find((s) => s.id === "halloween")!;
  assert.equal(seasonFit({ title: "The Muppet Christmas Carol", kind: "film" }, christmas), "named");
  assert.equal(seasonFit({ title: "Die Hard", kind: "film", meta: { themes: ["christmas"] } }, christmas), "named");
  assert.equal(seasonFit({ title: "Fairytale of New York", kind: "video", meta: { lists: ["Xmas bangers"] } }, christmas), "named");
  assert.equal(seasonFit({ title: "Elf", kind: "film", meta: { tags: ["festive"] } }, christmas), "named");
  assert.equal(seasonFit({ title: "Heat", kind: "film" }, christmas), null);
  assert.equal(seasonFit({ title: "Hereditary", kind: "film", meta: { genres: ["Horror", "Drama"] } }, halloween), "genre");
  // A genre alone only counts for films and shows.
  assert.equal(seasonFit({ title: "A horror podcast", kind: "podcast", meta: { genres: ["Horror"] } }, halloween), null);
  assert.equal(seasonFit({ title: "Ghostbusters", kind: "film" }, halloween), null);
  assert.equal(seasonFit({ title: "Ghost stories for the fire", kind: "book" }, halloween), "named");
});

test("themesFromKeywords, minutesWords, parseTags", () => {
  assert.deepEqual(themesFromKeywords(["christmas", "new york city", "halloween"]), ["halloween", "christmas"]);
  assert.deepEqual(themesFromKeywords(["heist"]), []);
  assert.equal(minutesWords(48), "48m");
  assert.equal(minutesWords(120), "2h");
  assert.equal(minutesWords(135), "2h 15m");
  assert.deepEqual(parseTags(" cosy, Cosy ,  rainy   day ,,"), ["cosy", "rainy day"]);
});

test("music, music videos and Shorts", async () => {
  const { isMusic, isMusicVideo, isShort } = await import("./watch-meta");
  assert.equal(isShort({ url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" }), true);
  assert.equal(isShort({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", meta: { minutes: 1 } }), true);
  assert.equal(isShort({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", meta: { minutes: 4 } }), false);
  // Length not known yet: not called a Short.
  assert.equal(isShort({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), false);
  assert.equal(isMusicVideo({ kind: "video", meta: { music: true, minutes: 4 } }), true);
  assert.equal(isMusicVideo({ kind: "video", meta: { music: true, minutes: 1 } }), false);
  assert.equal(isMusicVideo({ kind: "video", meta: { minutes: 4 } }), false);
  assert.equal(isMusicVideo({ kind: "music", meta: { music: true } }), false);
  assert.equal(isMusic({ kind: "music" }), true);
  assert.equal(isMusic({ kind: "video", meta: { music: true, minutes: 61 } }), true);
  assert.equal(isMusic({ kind: "video", url: "https://www.youtube.com/shorts/dQw4w9WgXcQ", meta: { music: true } }), false);
  assert.equal(isMusic({ kind: "film" }), false);
});
