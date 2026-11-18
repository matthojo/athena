import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchMeta } from "../../lib/watch-meta";
import { due, enrichRows, openLibraryMeta, playlistsByVideo, RECHECK_MS, tmdbMeta, traktMeta, traktPath, youtubeVideoMeta, type EnrichRow, type EnrichSources } from "./watch-enrich";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const row = (over: Partial<EnrichRow>): EnrichRow => ({ id: "1", kind: "video", title: "A title", author: "", url: "", sync: null, meta: null, ...over });

const none: EnrichSources = {
  youtubeVideos: async () => null,
  youtubeSaves: async () => [],
  tmdb: async () => undefined,
  trakt: async () => undefined,
  openLibrary: async () => [],
};

async function run(rows: EnrichRow[], sources: Partial<EnrichSources>) {
  const written = new Map<string, WatchMeta>();
  const result = await enrichRows(rows, { sources: { ...none, ...sources }, now: NOW, write: async (id, meta) => void written.set(id, meta) });
  return { written, result };
}

test("what each source's reply says", () => {
  assert.deepEqual(youtubeVideoMeta({ id: "x", snippet: { publishedAt: "2019-07-21T12:00:00Z", categoryId: "10" }, contentDetails: { duration: "PT1H1M" }, topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Electronic_music"] } }), {
    year: 2019,
    minutes: 61,
    genres: ["Electronic"],
    music: true,
  });
  assert.deepEqual(tmdbMeta({ genres: [{ name: "Comedy" }, { name: "Family" }], runtime: 97, release_date: "2003-11-07", keywords: { keywords: [{ name: "christmas" }, { name: "elf" }] } }), { year: 2003, minutes: 97, genres: ["Comedy", "Family"], themes: ["christmas"] });
  assert.deepEqual(tmdbMeta({ genres: [{ name: "Drama" }], episode_run_time: [58], first_air_date: "2022-02-18", keywords: { results: [{ name: "office" }] } }), { year: 2022, minutes: 58, genres: ["Drama"] });
  assert.deepEqual(traktMeta({ year: 2021, runtime: 155, genres: ["science-fiction", "adventure"] }), { year: 2021, minutes: 155, genres: ["Science fiction", "Adventure"] });
  assert.deepEqual(openLibraryMeta([{ title: "A Summary of The Wager" }, { title: "The Wager: A Tale of Shipwreck, Mutiny and Murder", first_publish_year: 2023, number_of_pages_median: 352, subject: ["History", "Shipwrecks"] }], "The Wager"), { year: 2023, pages: 352, genres: ["History"] });
  assert.equal(openLibraryMeta([{ title: "Something else" }], "The Wager"), null);
});

test("traktPath comes from a source key or the link, and nothing else", () => {
  assert.equal(traktPath({ url: "", sync: JSON.stringify({ keys: ["letterboxd:film:dune", "trakt:movies:dune-2021"] }) }), "/movies/dune-2021");
  assert.equal(traktPath({ url: "https://trakt.tv/shows/severance/seasons/1", sync: null }), "/shows/severance");
  assert.equal(traktPath({ url: "https://example.com/movies/dune", sync: { keys: ["trakt:movies:../users/me"] } }), null);
});

test("playlists come from the saved entries Days holds", () => {
  const lists = playlistsByVideo([
    { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", grp: "DIY" },
    { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", grp: "Loft" },
    { url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", grp: "playlist" },
    { url: null, grp: "DIY" },
  ]);
  assert.deepEqual([...lists], [["aaaaaaaaaaa", ["DIY", "Loft"]]]);
});

test("due: never asked, or bare and asked a fortnight ago", () => {
  const then = new Date(NOW.getTime() - RECHECK_MS - 1).toISOString();
  assert.equal(due({}, NOW.getTime()), true);
  assert.equal(due({ checked: NOW.toISOString() }, NOW.getTime()), false);
  assert.equal(due({ checked: then }, NOW.getTime()), true);
  assert.equal(due({ checked: then, minutes: 12 }, NOW.getTime()), false);
});

test("a video learns its length, genres and playlists in one request for many", async () => {
  const asked: string[][] = [];
  const { written, result } = await run(
    [row({ id: "a", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }), row({ id: "b", url: "https://youtu.be/bbbbbbbbbbb", meta: JSON.stringify({ tags: ["mine"] }) }), row({ id: "c", url: "https://youtu.be/ccccccccccc", meta: { checked: NOW.toISOString() } })],
    {
      youtubeSaves: async () => [{ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", grp: "DIY" }],
      youtubeVideos: async (ids) => {
        asked.push(ids);
        return [{ id: "aaaaaaaaaaa", snippet: { publishedAt: "2024-01-02T00:00:00Z", categoryId: "26" }, contentDetails: { duration: "PT12M" }, topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Hobby"] } }];
      },
    },
  );
  assert.deepEqual(asked, [["aaaaaaaaaaa", "bbbbbbbbbbb"]]);
  assert.deepEqual(written.get("a"), { year: 2024, minutes: 12, genres: ["How-to"], lists: ["DIY"], checked: NOW.toISOString() });
  // A video YouTube no longer has: looked at, tags untouched.
  assert.deepEqual(written.get("b"), { tags: ["mine"], checked: NOW.toISOString() });
  assert.equal(written.has("c"), false);
  assert.deepEqual(result, { due: 2, looked: 2, learned: 1 });
});

test("no YouTube account, or a failed request: playlists land and the video stays due", async () => {
  for (const youtubeVideos of [async () => null, async () => Promise.reject(new Error("quota"))]) {
    const { written, result } = await run([row({ id: "a", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }), row({ id: "b", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" })], {
      youtubeSaves: async () => [{ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", grp: "DIY" }],
      youtubeVideos,
    });
    assert.deepEqual([...written], [["a", { lists: ["DIY"] }]]);
    assert.equal(result.looked, 0);
  }
});

test("films ask TMDB with the year a source knew, then Trakt, and books ask Open Library", async () => {
  const tmdbAsked: unknown[] = [];
  const withKey = await run([row({ id: "f", kind: "film", title: "Elf", sync: JSON.stringify({ keys: [], year: 2003 }) }), row({ id: "t", kind: "tv", title: "Nothing known" })], {
    tmdb: async (kind, title, year) => {
      tmdbAsked.push([kind, title, year]);
      return title === "Elf" ? { genres: [{ name: "Comedy" }], runtime: 97, release_date: "2003-11-07", keywords: { keywords: [{ name: "christmas" }] } } : null;
    },
  });
  assert.deepEqual(tmdbAsked, [
    ["movie", "Elf", 2003],
    ["tv", "Nothing known", undefined],
  ]);
  assert.deepEqual(withKey.written.get("f"), { year: 2003, minutes: 97, genres: ["Comedy"], themes: ["christmas"], checked: NOW.toISOString() });
  assert.deepEqual(withKey.written.get("t"), { checked: NOW.toISOString() });

  const traktAsked: string[] = [];
  const noKey = await run([row({ id: "f", kind: "film", title: "Dune", url: "https://trakt.tv/movies/dune-2021" }), row({ id: "g", kind: "film", title: "By hand" }), row({ id: "b", kind: "book", title: "The Wager", author: "David Grann" })], {
    trakt: async (path) => {
      traktAsked.push(path);
      return { year: 2021, runtime: 155, genres: ["science-fiction"] };
    },
    openLibrary: async () => [{ title: "The Wager", first_publish_year: 2023, number_of_pages_median: 352, subject: ["History"] }],
  });
  assert.deepEqual(traktAsked, ["/movies/dune-2021"]);
  assert.deepEqual(noKey.written.get("f"), { year: 2021, minutes: 155, genres: ["Science fiction"], checked: NOW.toISOString() });
  assert.deepEqual(noKey.written.get("g"), { checked: NOW.toISOString() });
  assert.deepEqual(noKey.written.get("b"), { year: 2023, pages: 352, genres: ["History"], checked: NOW.toISOString() });
});

test("a lookup that can't be reached leaves the item due; kinds with no source are just marked", async () => {
  const { written } = await run([row({ id: "b", kind: "book", title: "The Wager" }), row({ id: "a", kind: "article", title: "An essay" })], {
    openLibrary: async () => Promise.reject(new Error("timeout")),
  });
  assert.deepEqual([...written], [["a", { checked: NOW.toISOString() }]]);
});
