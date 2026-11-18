import assert from "node:assert/strict";
import { test } from "node:test";
import { artistKey, filmGenres, genreRadar, mixOf, musicFamilies, musicFamily } from "./genre-mix";

test("film genres: TMDB's and Trakt's names agree, TV's pairs split", () => {
  assert.deepEqual(filmGenres(["Sci-Fi & Fantasy", "Drama"]), ["Science fiction", "Fantasy", "Drama"]);
  assert.deepEqual(filmGenres(["science-fiction", "Science Fiction", "TV Movie"]), ["Science fiction", "TV film"]);
  assert.deepEqual(filmGenres(["War & Politics"]), ["War", "Politics"]);
  assert.deepEqual(filmGenres(undefined), []);
});

test("music families: the most particular first, and tags that aren't a sound left out", () => {
  const cases: Array<[string, string | null]> = [
    ["indie rock", "Indie"],
    ["uk alternative hip hop", "Hip hop"],
    ["trip hop", "Electronic"],
    ["dance pop", "Pop"],
    ["synthpop", "Pop"],
    ["electropop", "Electronic"],
    ["pop punk", "Punk"],
    ["garage rock", "Rock"],
    ["uk garage", "Electronic"],
    ["neo soul", "Soul & R&B"],
    ["contemporary r&b", "Soul & R&B"],
    ["new jack swing", "Soul & R&B"],
    ["chamber pop", "Indie"],
    ["drum and bass", "Electronic"],
    ["progressive house", "Electronic"],
    ["progressive rock", "Rock"],
    ["k-pop", "World"],
    ["death metal", "Metal"],
    ["singer-songwriter", null],
    ["baroque pop", "Indie"],
    ["baroque", "Classical"],
    ["shoegaze", "Indie"],
    ["seen live", null],
    ["british", null],
  ];
  for (const [raw, family] of cases) assert.equal(musicFamily(raw), family, raw);
  // Weighed by place, strongest first; two at most.
  assert.deepEqual(musicFamilies(["indie folk", "folk", "indie rock", "psychedelic rock", "art rock", "seen live"]), ["Folk & country", "Rock"]);
  assert.deepEqual(musicFamilies(["trip hop", "electronica", "art rock"]), ["Electronic", "Rock"]);
  assert.deepEqual(musicFamilies(["pop", "country", "country pop", "singer/songwriter", "female vocals"]), ["Pop", "Folk & country"]);
  assert.deepEqual(musicFamilies(["alternative rock", "art rock", "rock", "electronic", "british"]), ["Rock", "Electronic"]);
  assert.deepEqual(musicFamilies([]), []);
});

test("artist keys: case, accents, punctuation and a leading The aside", () => {
  assert.equal(artistKey("The Beatles"), artistKey("beatles"));
  assert.equal(artistKey("Sigur Rós"), artistKey("Sigur Ros"));
  assert.equal(artistKey("Simon & Garfunkel"), artistKey("Simon and Garfunkel"));
});

test("a radar: the period's top genres as spokes, the one before on the same spokes", () => {
  const now = mixOf(new Map([["Rock", 6], ["Indie", 4], ["Pop", 2], ["Jazz", 1]]), 10);
  const before = mixOf(new Map([["Rock", 2], ["Electronic", 5]]), 5);
  assert.deepEqual(genreRadar(now, before, 3), { axes: ["Rock", "Indie", "Pop"], now: [0.6, 0.4, 0.2], before: [0.4, 0, 0] });
  assert.equal(genreRadar(now, null)?.before, null);
  // Too few genres to make a shape.
  assert.equal(genreRadar(mixOf(new Map([["Rock", 3], ["Pop", 1]]), 4)), null);
  assert.equal(genreRadar(null), null);
});
