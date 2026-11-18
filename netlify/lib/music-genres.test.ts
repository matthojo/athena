import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtFetchError } from "../../lib/art";
import { due } from "../../lib/music-genre-store";
import { learnGenres, mbPhrase, musicbrainzGenres, spotifyGenres, type GenreSources } from "./music-genres";

const NOW = new Date("2026-11-15T12:00:00Z");

test("Spotify: only an exact name match counts, genres as given", () => {
  const items = [
    { name: "Bicep Tribute", genres: ["tribute"] },
    { name: "BICEP", genres: ["Electronica", " house "] },
  ];
  assert.deepEqual(spotifyGenres(items, "Bicep"), ["electronica", "house"]);
  assert.deepEqual(spotifyGenres([{ name: "Bicep", genres: [] }], "Bicep"), []);
  assert.equal(spotifyGenres(items, "Floating Points"), null);
  assert.equal(spotifyGenres(undefined, "Bicep"), null);
});

test("MusicBrainz: the best-scoring name or alias match, tags by votes, no zero votes", () => {
  const artists = [
    { name: "Radical Bicep", score: 76, tags: [{ name: "metal", count: 9 }] },
    { name: "Bicep", score: 100, tags: [{ name: "house", count: 1 }, { name: "electronic", count: 3 }, { name: "nope", count: 0 }] },
  ];
  assert.deepEqual(musicbrainzGenres(artists, "bicep"), ["electronic", "house"]);
  assert.deepEqual(musicbrainzGenres([{ name: "クルアンビン", score: 95, aliases: [{ name: "Khruangbin" }], tags: [{ name: "funk", count: 1 }] }], "Khruangbin"), ["funk"]);
  // A low score isn't trusted, even with the name.
  assert.equal(musicbrainzGenres([{ name: "Bicep", score: 60, tags: [{ name: "house", count: 1 }] }], "Bicep"), null);
  assert.equal(mbPhrase('The "Best" \\ Band'), '"The \\"Best\\" \\\\ Band"');
});

test("due: never asked, or asked over a month ago and nobody knew", () => {
  assert.equal(due(undefined, NOW.getTime()), true);
  assert.equal(due({ name: "A", genres: ["rock"], checked: "2020-01-01T00:00:00Z" }, NOW.getTime()), false);
  assert.equal(due({ name: "A", genres: [], checked: "2026-11-01T00:00:00Z" }, NOW.getTime()), false);
  assert.equal(due({ name: "A", genres: [], checked: "2026-09-01T00:00:00Z" }, NOW.getTime()), true);
});

function fake(over: Partial<GenreSources> = {}) {
  const asked: string[] = [];
  const waits: number[] = [];
  const src: GenreSources = {
    spotify: async (n) => (asked.push(`spotify:${n}`), n === "Khruangbin" ? ["psychedelic soul"] : n === "Unknown" ? null : []),
    musicbrainz: async (n) => (asked.push(`mb:${n}`), n === "Unknown" ? null : ["indie rock"]),
    wait: async (ms) => void waits.push(ms),
    ...over,
  };
  return { src, asked, waits };
}

test("Spotify first; MusicBrainz when Spotify has no genres; nobody knowing is remembered too", async () => {
  const { src, asked } = fake();
  const { run, learned } = await learnGenres(["Khruangbin", "Radiohead", "Unknown", "radiohead"], {}, { sources: src, now: NOW });
  assert.deepEqual(asked, ["spotify:Khruangbin", "spotify:Radiohead", "mb:Radiohead", "spotify:Unknown", "mb:Unknown"]);
  assert.deepEqual(run, { due: 3, looked: 3, learned: 2 });
  assert.deepEqual(learned.khruangbin, { name: "Khruangbin", genres: ["psychedelic soul"], from: "spotify", checked: NOW.toISOString() });
  assert.deepEqual(learned.radiohead, { name: "Radiohead", genres: ["indie rock"], from: "musicbrainz", checked: NOW.toISOString() });
  assert.deepEqual(learned.unknown, { name: "Unknown", genres: [], checked: NOW.toISOString() });
});

test("no Spotify account: MusicBrainz alone, spaced a second apart; already known artists aren't asked", async () => {
  const { src, asked } = fake({ spotify: async () => undefined });
  const book = { "little simz": { name: "Little Simz", genres: ["hip hop"], checked: NOW.toISOString() } };
  const { run } = await learnGenres(["Little Simz", "Bicep", "Floating Points"], book, { sources: src, now: NOW });
  assert.deepEqual(asked, ["mb:Bicep", "mb:Floating Points"]);
  assert.deepEqual(run, { due: 2, looked: 2, learned: 2 });
});

test("Spotify refusing turns it off for the run; MusicBrainz unreachable leaves the artist due", async () => {
  let spotifyCalls = 0;
  const { src } = fake({
    spotify: async () => {
      spotifyCalls++;
      throw new Error("403");
    },
    musicbrainz: async (n) => {
      if (n === "Busy") throw new ArtFetchError("http", "503");
      if (n === "Gone") throw new ArtFetchError("http", "404");
      return ["house"];
    },
  });
  const { run, learned } = await learnGenres(["Busy", "Gone", "Bicep"], {}, { sources: src, now: NOW });
  assert.equal(spotifyCalls, 1);
  assert.equal(learned.busy, undefined, "couldn't be reached: asked again next time");
  assert.deepEqual(learned.gone?.genres, [], "MusicBrainz said no such thing");
  assert.deepEqual(run, { due: 3, looked: 2, learned: 1 });
});

test("a run stops at its cap", async () => {
  const { src } = fake();
  const { run } = await learnGenres(["A", "B", "C", "D"], {}, { sources: src, now: NOW, most: 2 });
  assert.deepEqual(run, { due: 4, looked: 2, learned: 2 });
});
