// Run: npx tsx --test netlify/lib/connectors/answer-sources.test.ts
// Ask's Life log sources: each service's tool output (stubbed, in the shapes the adapters return) becomes links named for what they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareRedditLink, itemKinds, withoutNsfw } from "./answer-sources";
import { media } from "./trakt-direct";
import { redditItem } from "./reddit-direct";

const json = (v: unknown) => JSON.stringify(v);
const kinds = (provider: string, v: unknown) => Object.fromEntries(Object.entries(itemKinds(provider, typeof v === "string" ? v : json(v))).map(([url, i]) => [url, i.kind]));

test("Trakt: films, episodes and shows, each with its own link", () => {
  const tz = "Europe/London";
  const watched = [
    media({ type: "movie", movie: { title: "Past Lives", year: 2023, ids: { slug: "past-lives-2023" } } } as never, "2026-03-07T20:00:00Z", tz),
    media({ type: "episode", show: { title: "Slow Horses", ids: { slug: "slow-horses" } }, episode: { season: 4, number: 3, title: "Hello Goodbye" } } as never, "2026-03-08T21:00:00Z", tz),
    media({ type: "show", show: { title: "Severance", year: 2022, ids: { slug: "severance" } } } as never, "2026-03-01T10:00:00Z", tz),
  ];
  assert.deepEqual(kinds("trakt", { watched, count: 3 }), {
    "https://trakt.tv/movies/past-lives-2023": "film",
    "https://trakt.tv/shows/slow-horses/seasons/4/episodes/3": "episode",
    "https://trakt.tv/shows/severance": "show",
  });
});

test("YouTube: videos are videos; playlists and channels stay pages", () => {
  assert.deepEqual(
    kinds("youtube", {
      videos: [{ title: "How espresso works", channel: "James Hoffmann", day: "2026-03-02", link: "https://www.youtube.com/watch?v=abc123" }],
      playlists: [{ id: "PL1", title: "Coffee", videos: 12, link: "https://www.youtube.com/playlist?list=PL1" }],
      subscriptions: [{ channel: "James Hoffmann", link: "https://www.youtube.com/channel/UC1" }],
    }),
    {
      "https://www.youtube.com/watch?v=abc123": "video",
      "https://www.youtube.com/playlist?list=PL1": "page",
      "https://www.youtube.com/channel/UC1": "page",
    },
  );
});

test("Letterboxd diary entries are films; Goodreads shelves are books", () => {
  assert.deepEqual(kinds("letterboxd", { profile: "jordan", films: [{ title: "Past Lives", year: 2023, watched_on: "2026-03-07", rating: "★★★★½ (4.5/5)", link: "https://letterboxd.com/jordan/film/past-lives/" }] }), {
    "https://letterboxd.com/jordan/film/past-lives/": "film",
  });
  assert.deepEqual(kinds("goodreads", { shelf: "read", books: [{ id: "1", title: "Tomorrow, and Tomorrow, and Tomorrow", author: "Gabrielle Zevin", link: "https://www.goodreads.com/book/show/1" }] }), {
    "https://www.goodreads.com/book/show/1": "book",
  });
});

test("Spotify and Last.fm: tracks, albums and artists", () => {
  const spotify = {
    items: [
      { track: "Starburster", artist: "Fontaines D.C.", album: "Romance", minutes: 3.6, link: "https://open.spotify.com/track/1" },
      { album: "Romance", artist: "Fontaines D.C.", released: "2024-08-23", link: "https://open.spotify.com/album/2" },
      { rank: 1, artist: "Fontaines D.C.", genres: ["post-punk"], link: "https://open.spotify.com/artist/3" },
    ],
  };
  assert.deepEqual(kinds("spotify", spotify), { "https://open.spotify.com/track/1": "track", "https://open.spotify.com/album/2": "album", "https://open.spotify.com/artist/3": "artist" });
  const lastfm = {
    items: [{ track: "Starburster", artist: "Fontaines D.C.", album: "Romance", link: "https://www.last.fm/music/Fontaines+D.C./_/Starburster" }],
    top_artists: [{ artist: "Fontaines D.C.", plays: 41, link: "https://www.last.fm/music/Fontaines+D.C." }],
  };
  assert.deepEqual(kinds("lastfm", lastfm), { "https://www.last.fm/music/Fontaines+D.C./_/Starburster": "track", "https://www.last.fm/music/Fontaines+D.C.": "artist" });
});

test("Steam games are games", () => {
  assert.deepEqual(kinds("steam", { items: [{ game: "Balatro", hours_total: 41, link: "https://store.steampowered.com/app/2379780" }] }), { "https://store.steampowered.com/app/2379780": "game" });
});

const ctx = { name: "jordan", tz: "Europe/London" };
const post = (over: Record<string, unknown>) =>
  redditItem({ kind: "t3", data: { name: "t3_a", created_utc: 1_773_000_000, author: "jordan", subreddit_name_prefixed: "r/espresso", permalink: "/r/espresso/comments/a/grind/", title: "Grind size for a Flair 58?", is_self: true, selftext: "How fine?", score: 4, num_comments: 2, ...over } }, ctx);

test("Reddit: posts and comments, each with its link", () => {
  const comment = redditItem({ kind: "t1", data: { name: "t1_b", created_utc: 1_773_000_100, author: "jordan", subreddit_name_prefixed: "r/espresso", permalink: "/r/espresso/comments/a/grind/b/", link_title: "Grind size", body: "Finer." } }, ctx);
  assert.deepEqual(kinds("reddit", { items: [post({}), comment] }), {
    "https://www.reddit.com/r/espresso/comments/a/grind/": "post",
    "https://www.reddit.com/r/espresso/comments/a/grind/b/": "comment",
  });
});

test("Reddit NSFW items: Claude sees the community, date and link only, and the source is named by community", () => {
  const nsfw = post({ name: "t3_n", subreddit_name_prefixed: "r/somewhere", permalink: "/r/somewhere/comments/n/x/", title: "A private title", selftext: "Private text", over_18: true });
  const raw = json({ items: [post({}), nsfw], count: 2 });
  const seen = withoutNsfw("reddit", raw);
  assert.ok(!seen.includes("A private title") && !seen.includes("Private text"));
  assert.ok(seen.includes("Grind size for a Flair 58?"), "other posts are left alone");
  assert.ok(seen.includes("https://www.reddit.com/r/somewhere/comments/n/_/"), "the link stays, without its title slug, so it can be cited");
  assert.deepEqual(itemKinds("reddit", raw)["https://www.reddit.com/r/somewhere/comments/n/_/"], { kind: "post", title: "Post in r/somewhere" });
  assert.equal(itemKinds("reddit", raw)["https://www.reddit.com/r/espresso/comments/a/grind/"].title, undefined);
  assert.equal(withoutNsfw("spotify", raw), raw, "only Reddit is cut");
});

test("A result cut short still names what came before the cut, and drops a Reddit item the cut fell in", () => {
  const nsfwLate = post({ name: "t3_z", permalink: "/r/somewhere/comments/z/y/", title: "Cut title", over_18: true });
  const full = json({ items: [post({}), nsfwLate] });
  // Cut inside the second item, before its nsfw flag.
  const cut = `${full.slice(0, full.indexOf("Cut title") + 3)}\n\n[truncated: 900 more characters — narrow the query to see the rest]`;
  const seen = withoutNsfw("reddit", cut);
  assert.ok(!seen.includes("Cut"), "the partial item is dropped");
  assert.ok(seen.includes("Grind size for a Flair 58?"));
  assert.deepEqual(kinds("reddit", cut), { "https://www.reddit.com/r/espresso/comments/a/grind/": "post" });
  const tracks = json({ items: [{ track: "A", link: "https://open.spotify.com/track/a" }, { track: "B", link: "https://open.spotify.com/track/b" }] });
  assert.deepEqual(kinds("spotify", tracks.slice(0, tracks.indexOf('"B"'))), { "https://open.spotify.com/track/a": "track" });
});

test("Other accounts and non-JSON results give no kinds", () => {
  assert.deepEqual(itemKinds("gmail", json({ link: "https://mail.google.com/x" })), {});
  assert.deepEqual(itemKinds("trakt", "Trakt isn't answering"), {});
});

test("bareRedditLink swaps the title slug for _ and leaves other links alone", () => {
  assert.equal(bareRedditLink("https://www.reddit.com/r/x/comments/abc/some_title_words/"), "https://www.reddit.com/r/x/comments/abc/_/");
  assert.equal(bareRedditLink("https://www.reddit.com/r/x/comments/abc/some_title/def/"), "https://www.reddit.com/r/x/comments/abc/_/def/");
  assert.equal(bareRedditLink("https://open.spotify.com/track/1"), "https://open.spotify.com/track/1");
});
