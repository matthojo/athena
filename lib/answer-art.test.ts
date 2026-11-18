import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceHints, watchDetail } from "./answer-art";

test("where a cited source's cover comes from: the id in its link, or its title, never its own address", () => {
  assert.deepEqual(sourceHints({ kind: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "A video" }), [{ youtube: "dQw4w9WgXcQ" }]);
  assert.deepEqual(sourceHints({ kind: "video", url: "https://vimeo.com/12345", title: "A video" }), []);
  assert.deepEqual(sourceHints({ kind: "track", url: "https://open.spotify.com/track/1EoDsNmgTLtmwe1BDAVxV5", title: "Starburster" }), [{ spotify: "https://open.spotify.com/track/1EoDsNmgTLtmwe1BDAVxV5" }]);
  assert.deepEqual(sourceHints({ kind: "album", url: "https://www.last.fm/music/Radiohead/In+Rainbows", title: "In Rainbows" }), []);
  assert.deepEqual(sourceHints({ kind: "film", url: "https://letterboxd.com/me/film/past-lives/", title: "Past Lives" }), [{ letterboxd: "https://letterboxd.com/me/film/past-lives/" }, { film: { title: "Past Lives" } }]);
  assert.deepEqual(sourceHints({ kind: "film", url: "https://trakt.tv/movies/dune-2021", title: "Dune" }), [{ film: { title: "Dune" } }]);
  assert.deepEqual(sourceHints({ kind: "episode", url: "https://trakt.tv/shows/severance/seasons/2/episodes/3", title: "Severance · S2E3 · Who Is Alive?" }), [{ show: { title: "Severance" } }]);
  assert.deepEqual(sourceHints({ kind: "show", url: null, title: "Slow Horses" }), [{ show: { title: "Slow Horses" } }]);
  assert.deepEqual(sourceHints({ kind: "episode", url: null, title: "Slow Horses, S4 E3" }), [{ show: { title: "Slow Horses" } }]);
  assert.deepEqual(sourceHints({ kind: "book", url: null, title: "The Wager" }), [{ book: { title: "The Wager" } }]);
  assert.deepEqual(sourceHints({ kind: "game", url: "https://store.steampowered.com/app/1145350/Hades_II/", title: "Hades II" }), [{ steam: 1145350 }]);
  assert.deepEqual(sourceHints({ kind: "game", url: null, title: "Hades II" }), []);
});

test("no cover is looked for where there's none to have: a person, a note, an email", () => {
  // An artist's picture is a person's photo.
  assert.deepEqual(sourceHints({ kind: "artist", url: "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb", title: "Radiohead" }), []);
  for (const kind of ["note", "person", "email", "meeting", "post", "day"] as const) assert.deepEqual(sourceHints({ kind, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "x" }), []);
});

test("a Watch & read title's detail: its kind and where it's up to", () => {
  assert.equal(watchDetail({ kind: "film", status: "queued", progress: null }), "Film · To watch");
  assert.equal(watchDetail({ kind: "book", status: "reading", progress: { unit: "page", done: 84, total: 136 } }), "Book · Page 84 of 136");
  assert.equal(watchDetail({ kind: "tv", status: "reading", progress: null }), "TV show · Watching");
  assert.equal(watchDetail({ kind: "book", status: "done", progress: { unit: "page", done: 136, total: 136 } }), "Book · Read");
});
