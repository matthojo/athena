// Run: npx tsx --test lib/art.test.ts
// Artwork without the database: the allowlist, redirects re-checked, internal hosts refused, the size cap,
// the timeout, only images kept, the two WebP sizes and their tone, and the keys that dedupe a source.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ART_SIZES, ArtFetchError, artDeps, artUrlAllowed, letterboxdPoster, MAX_SOURCE_BYTES, prepareArt, safeFetch, sniffImage, sourceKey, steamHeader, tmdbAuth } from "./art";

async function png(w: number, h: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

/** A stand-in network: each address answers from the table; every request is recorded. */
function network(table: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  artDeps.fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    const answer = table[url];
    if (!answer) return new Response("not found", { status: 404 });
    return answer();
  };
  artDeps.assertPublic = async (u: URL) => {
    if (u.hostname.endsWith(".internal-test")) throw new Error("internal address");
  };
  return calls;
}

test("the allowlist: https, known image hosts only, no credentials or odd ports", () => {
  assert.ok(artUrlAllowed("https://a.ltrbxd.com/resized/film-poster/1/2/3/4/5/6/123456-past-lives-0-500-0-750-crop.jpg"));
  assert.ok(artUrlAllowed("https://i.scdn.co/image/ab67616d0000b273abc"));
  assert.ok(artUrlAllowed("https://lastfm.freetls.fastly.net/i/u/300x300/abc.png"));
  assert.ok(artUrlAllowed(steamHeader(1145360)));
  assert.ok(artUrlAllowed("https://image.tmdb.org/t/p/w780/abc.jpg"));
  assert.ok(artUrlAllowed("https://ia800505.us.archive.org/view_archive.php?archive=x"));
  assert.ok(!artUrlAllowed("http://i.scdn.co/image/abc"), "plain http");
  assert.ok(!artUrlAllowed("https://example.com/poster.jpg"), "not on the list");
  assert.ok(!artUrlAllowed("https://i.scdn.co.evil.example/x.jpg"), "a look-alike");
  assert.ok(!artUrlAllowed("https://us.archive.org/x.jpg"), "the suffix needs a machine name");
  assert.ok(!artUrlAllowed("https://user:pass@i.scdn.co/x.jpg"), "credentials");
  assert.ok(!artUrlAllowed("https://i.scdn.co:8443/x.jpg"), "another port");
  assert.ok(!artUrlAllowed("not a url"));
  // The owner's own media server: only that host.
  assert.ok(artUrlAllowed("https://plex.example.net:32400/photo/x", "plex.example.net:32400"));
  assert.ok(!artUrlAllowed("https://i.scdn.co/x.jpg", "plex.example.net:32400"));
});

test("Letterboxd's poster from the diary RSS description", () => {
  const html = '<p><img src="https://a.ltrbxd.com/resized/film-poster/7/0/4/9/2/0/704920-past-lives-0-600-0-900-crop.jpg?v=abc&amp;k=1"/></p><p>Watched on Friday November 6, 2026.</p>';
  assert.equal(letterboxdPoster(html), "https://a.ltrbxd.com/resized/film-poster/7/0/4/9/2/0/704920-past-lives-0-600-0-900-crop.jpg?v=abc&k=1");
  assert.equal(letterboxdPoster('<img src="https://evil.example/x.jpg">'), null);
  assert.equal(letterboxdPoster("<p>No poster</p>"), null);
});

test("redirects are followed by hand and each hop is checked again", async () => {
  const img = await png(10, 10, [200, 30, 30]);
  const calls = network({
    "https://covers.openlibrary.org/b/isbn/9780593312476-L.jpg?default=false": () => new Response(null, { status: 302, headers: { location: "https://ia800505.us.archive.org/cover.jpg" } }),
    "https://ia800505.us.archive.org/cover.jpg": () => new Response(new Uint8Array(img), { headers: { "content-type": "image/png" } }),
    "https://i.scdn.co/bounce": () => new Response(null, { status: 301, headers: { location: "https://evil.example/x.png" } }),
    "https://i.scdn.co/inside": () => new Response(null, { status: 302, headers: { location: "https://image.tmdb.org.internal-test/x.png" } }),
  });
  const got = await safeFetch("https://covers.openlibrary.org/b/isbn/9780593312476-L.jpg?default=false");
  assert.equal(sniffImage(got), "image/png");
  assert.equal(calls.length, 2);
  await assert.rejects(safeFetch("https://i.scdn.co/bounce"), (e: ArtFetchError) => e.reason === "not_allowed");
  assert.ok(!calls.some((c) => c.url.includes("evil.example")), "the refused hop is never requested");
  await assert.rejects(safeFetch("https://example.com/x.png"), (e: ArtFetchError) => e.reason === "not_allowed");
  assert.equal(calls.filter((c) => c.url.includes("example.com")).length, 0);
});

test("internal hosts are refused, even on the list's owner's server", async () => {
  network({});
  await assert.rejects(safeFetch("https://media.internal-test/photo", { ownHost: "media.internal-test" }), (e: ArtFetchError) => e.reason === "internal");
});

test("the size cap: a declared length over it, and a body that runs over it, are both refused", async () => {
  const big = new Uint8Array(MAX_SOURCE_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  network({
    "https://i.scdn.co/declared": () => new Response(new Uint8Array(10), { headers: { "content-length": String(MAX_SOURCE_BYTES + 1) } }),
    "https://i.scdn.co/streamed": () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < big.length; i += 1 << 20) c.enqueue(big.subarray(i, i + (1 << 20)));
            c.close();
          },
        }),
      ),
  });
  await assert.rejects(safeFetch("https://i.scdn.co/declared"), (e: ArtFetchError) => e.reason === "too_big");
  await assert.rejects(safeFetch("https://i.scdn.co/streamed"), (e: ArtFetchError) => e.reason === "too_big");
});

test("the timeout", async () => {
  artDeps.fetch = (_input, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
  artDeps.assertPublic = async () => undefined;
  const before = artDeps.timeoutMs;
  artDeps.timeoutMs = 80;
  try {
    const t0 = Date.now();
    await assert.rejects(safeFetch("https://i.scdn.co/slow"), (e: ArtFetchError) => e.reason === "timeout");
    assert.ok(Date.now() - t0 < 2_000);
  } finally {
    artDeps.timeoutMs = before;
  }
});

test("only images: an HTML page labelled image/jpeg is refused", async () => {
  network({ "https://i.scdn.co/html": () => new Response("<html>nope</html>", { headers: { "content-type": "image/jpeg" } }) });
  await assert.rejects(safeFetch("https://i.scdn.co/html"), (e: ArtFetchError) => e.reason === "not_image");
});

test("the owner's server's token goes only to that server", async () => {
  const img = await png(4, 4, [1, 2, 3]);
  const calls = network({
    "https://plex.example.net:32400/photo/x": () => new Response(null, { status: 302, headers: { location: "https://i.scdn.co/elsewhere" } }),
    "https://plex.example.net:32400/photo/y": () => new Response(new Uint8Array(img)),
  });
  const own = { ownHost: "plex.example.net:32400", headers: { "X-Plex-Token": "secret" } };
  await assert.rejects(safeFetch("https://plex.example.net:32400/photo/x", own), (e: ArtFetchError) => e.reason === "not_allowed");
  await safeFetch("https://plex.example.net:32400/photo/y", own);
  assert.equal(calls.filter((c) => c.headers["x-plex-token"] === "secret").length, 2);
  assert.ok(!calls.some((c) => c.url.includes("scdn")), "never followed off the owner's server");
});

test("resize: two WebP sizes inside 240 and 800, never enlarged, with the tone", async () => {
  const poster = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: { r: 24, g: 80, b: 160 } } })
    .composite([{ input: await png(200, 200, [250, 250, 250]), left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
  const p = await prepareArt(poster);
  assert.equal(sniffImage(p.lg), "image/webp");
  assert.equal(sniffImage(p.sm), "image/webp");
  assert.deepEqual([p.w, p.h], [533, 800]);
  const sm = await sharp(p.sm).metadata();
  assert.deepEqual([sm.width, sm.height], [160, ART_SIZES.sm]);
  assert.match(p.tone, /^#[0-9a-f]{6}$/);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.tone.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, `the tone is the poster's blue, got ${p.tone}`);
  // A small Steam header isn't blown up.
  const header = await prepareArt(await png(460, 215, [10, 10, 10]));
  assert.deepEqual([header.w, header.h], [460, 215]);
  assert.ok(header.lg.length < 20_000);
});

test("resize refuses something that only looks like an image", async () => {
  await assert.rejects(prepareArt(Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3])));
});

test("source keys dedupe: the same cover, title or ISBN is one source", () => {
  assert.equal(sourceKey({ url: "https://i.scdn.co/image/abc#x" }), sourceKey({ url: "https://i.scdn.co/image/abc" }));
  assert.equal(sourceKey({ isbn: "978-0-593-31247-6" }), "isbn:9780593312476");
  assert.equal(sourceKey({ isbn: "12" }), null);
  assert.equal(sourceKey({ book: { title: "The Wager ", author: "David  Grann" } }), sourceKey({ book: { title: "the wager", author: "david grann" } }));
  assert.equal(sourceKey({ film: { title: "Past Lives", year: 2023 } }), "tmdb:movie:past lives|2023");
  assert.notEqual(sourceKey({ film: { title: "Dune" } }), sourceKey({ show: { title: "Dune" } }));
  assert.equal(sourceKey({ steam: 1145360 }), "steam:1145360");
  assert.equal(sourceKey({ steam: -1 }), null);
  assert.equal(sourceKey({ own: { url: "https://plex.example.net/x", key: "plex:m1:123", headers: { "X-Plex-Token": "t" } } }), "own:plex:m1:123", "no token in the key");
});

test("TMDB: a v3 key goes as a parameter, a v4 token as a bearer header", () => {
  assert.deepEqual(tmdbAuth("0123456789abcdef0123456789abcdef"), { params: { api_key: "0123456789abcdef0123456789abcdef" }, headers: {} });
  assert.deepEqual(tmdbAuth("eyJhbGciOiJIUzI1NiJ9.x.y"), { params: {}, headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.x.y" } });
});

test("day entries: hints from what the entry says, never for posts or saves", async () => {
  const { dayEntryHints, ART_KINDS } = await import("./art");
  assert.deepEqual(dayEntryHints({ id: "1", kind: "watched", source: "letterboxd", title: "Past Lives" }, { image: "https://a.ltrbxd.com/p.jpg", year: 2023 }), [
    { url: "https://a.ltrbxd.com/p.jpg" },
    { film: { title: "Past Lives", year: 2023 } },
  ]);
  assert.deepEqual(dayEntryHints({ id: "2", kind: "watched", source: "trakt", title: "Severance", subtitle: "S2E3 · Who Is Alive?" }), [{ show: { title: "Severance" } }]);
  assert.deepEqual(dayEntryHints({ id: "3", kind: "watched", source: "youtube", title: "A video" }), [], "YouTube isn't TMDB");
  assert.deepEqual(dayEntryHints({ id: "4", kind: "read", source: "goodreads", title: "The Wager", subtitle: "David Grann" }, { isbn: "9780385534260" }), [
    { isbn: "9780385534260" },
    { book: { title: "The Wager", author: "David Grann" } },
  ]);
  assert.deepEqual(dayEntryHints({ id: "5", kind: "played", source: "steam", title: "Hades", url: "https://store.steampowered.com/app/1145360/" }), [{ steam: 1145360 }]);
  assert.deepEqual(dayEntryHints({ id: "6", kind: "listened", source: "spotify", title: "Blackstar" }, { image: "https://evil.example/x.jpg" }), [], "an image off the allowlist is dropped");
  for (const kind of ["posted", "saved", "chess", "workout", "other"]) {
    assert.ok(!ART_KINDS.includes(kind));
    assert.deepEqual(dayEntryHints({ id: "7", kind, source: "bluesky", title: "x" }, { image: "https://i.scdn.co/a.jpg" }), [], `${kind} never gets art`);
  }
});

test("links that carry art without a key: Spotify and Letterboxd", async () => {
  const { spotifyPath, letterboxdFilm, letterboxdPagePoster, dayEntryHints, sourceKey } = await import("./art");
  assert.equal(spotifyPath("https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5?si=abc"), "album/1EoDsNmgTLtmwe1BDAVxV5");
  assert.equal(spotifyPath("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC"), "track/4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(spotifyPath("https://open.spotify.com/user/someone"), null, "never a profile");
  assert.equal(spotifyPath("https://evil.example/album/1EoDsNmgTLtmwe1BDAVxV5"), null);
  assert.equal(letterboxdFilm("https://letterboxd.com/jordan/film/past-lives/1/"), "past-lives");
  assert.equal(letterboxdFilm("https://letterboxd.com/film/past-lives/"), "past-lives");
  assert.equal(letterboxdFilm("https://letterboxd.com/jordan/"), null, "never a member page");
  assert.equal(sourceKey({ letterboxd: "https://letterboxd.com/jordan/film/past-lives/" }), sourceKey({ letterboxd: "https://letterboxd.com/film/past-lives/" }), "the diary link and the film page are one source");
  const page = '<script type="application/ld+json">{"image":"https://a.ltrbxd.com/resized/film-poster/5/9/1/0/5/3/591053-past-lives-0-600-0-900-crop.jpg?v=c600b7854e","name":"Past Lives"}</script><meta property="og:image" content="https://a.ltrbxd.com/resized/sm/upload/backdrop.jpg">';
  assert.equal(letterboxdPagePoster(page), "https://a.ltrbxd.com/resized/film-poster/5/9/1/0/5/3/591053-past-lives-0-600-0-900-crop.jpg?v=c600b7854e", "the poster, not the backdrop");
  assert.equal(letterboxdPagePoster('"image":"https://evil.example/x.jpg"'), null);
  assert.deepEqual(dayEntryHints({ id: "1", kind: "listened", source: "spotify", title: "Red", url: "https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5" }), [{ spotify: "https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5" }]);
  assert.deepEqual(dayEntryHints({ id: "2", kind: "watched", source: "letterboxd", title: "Past Lives", url: "https://letterboxd.com/jordan/film/past-lives/" }), [{ letterboxd: "https://letterboxd.com/jordan/film/past-lives/" }, { film: { title: "Past Lives" } }]);
  assert.deepEqual(dayEntryHints({ id: "3", kind: "posted", source: "bluesky", title: "x", url: "https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5" }), [], "a post linking an album still gets nothing");
});

test("the finder: art for entries that can have it, written back through the store; never throws", async () => {
  const { fillDayArt, artDeps } = await import("./art");
  const written: Array<[string, unknown]> = [];
  const store = {
    entriesWithoutArt: async () => [
      { id: "p", kind: "posted", source: "bluesky", title: "A post" },
      { id: "w", kind: "workout", source: "strava", title: "Run" },
    ],
    setEntryArt: async (id: string, art: unknown) => void written.push([id, art]),
  };
  artDeps.fetch = async () => {
    throw new Error("nothing should be fetched");
  };
  assert.deepEqual(await fillDayArt(store), { looked: 2, eligible: 0, found: 0 });
  assert.equal(written.length, 0);
  const broken = { entriesWithoutArt: async () => Promise.reject(new Error("db down")), setEntryArt: async () => undefined };
  assert.deepEqual(await fillDayArt(broken), { looked: 0, eligible: 0, found: 0 });
});

test("Deezer: the album that is this one, by the same artist; editions and \"The\" aside; never the blank cover", async () => {
  const { deezerCoverOf, albumHint, sourceKey, dayEntryHints } = await import("./art");
  const A = (artist: string, title: string, id: string) => ({ artist: { name: artist }, title, cover_xl: `https://cdn-images.dzcdn.net/images/cover/${id}/1000x1000-000000-80-0-0.jpg` });
  const carrie = [A("Sufjan Stevens", "Carrie & Lowell Live", "live"), A("Sufjan Stevens", "Carrie & Lowell (10th Anniversary Edition)", "tenth")];
  assert.match(deezerCoverOf(carrie, "Sufjan Stevens", "Carrie & Lowell")!, /\/tenth\//, "the edition over the live album");
  assert.match(deezerCoverOf([A("Bicep", "Isles (Deluxe)", "deluxe"), A("Bicep", "Isles", "plain")], "Bicep", "Isles")!, /\/plain\//, "the exact title first");
  assert.match(deezerCoverOf([A("The xx", "xx", "xx")], "xx", "XX")!, /\/xx\//);
  assert.equal(deezerCoverOf([A("Bicep Tribute Band", "Isles", "nope")], "Bicep", "Isles"), null, "another artist's album never");
  assert.equal(deezerCoverOf([A("Bicep", "Something Else", "nope")], "Bicep", "Isles"), null);
  assert.equal(deezerCoverOf([{ artist: { name: "Bicep" }, title: "Isles", cover_xl: "https://cdn-images.dzcdn.net/images/cover//1000x1000-000000-80-0-0.jpg" }], "Bicep", "Isles"), null, "Deezer's blank cover");
  // No title: the artist's first album, as Deezer ranks them.
  assert.match(deezerCoverOf([A("Someone", "Theirs", "x"), A("Burial", "Untrue", "untrue"), A("Burial", "Rival Dealer", "rd")], "Burial")!, /\/untrue\//);

  // Which entries ask: an album, a track's album (Apple Music), an artist's best-known album; never a podcast.
  assert.deepEqual(albumHint({ source: "spotify_history", title: "Isles", subtitle: "Bicep" }), { album: { artist: "Bicep", title: "Isles" } });
  assert.deepEqual(albumHint({ source: "apple_music", title: "Glue", subtitle: "Bicep" }), { album: { artist: "Bicep", title: "Glue", track: true } });
  assert.deepEqual(albumHint({ source: "lastfm", title: "Bicep", subtitle: "Bicep" }), { album: { artist: "Bicep" } });
  assert.equal(albumHint({ source: "overcast", title: "Episode 4", subtitle: "A Podcast" }), null);
  assert.equal(albumHint({ source: "lastfm", title: "Isles" }), null, "no artist, nothing to ask");
  assert.equal(sourceKey({ album: { artist: "The xx", title: "Coexist" } }), "deezer:album:xx|coexist");
  assert.equal(sourceKey({ album: { artist: "Bicep", title: "Glue", track: true } }), "deezer:track:bicep|glue");
  assert.equal(sourceKey({ album: { artist: "Bicep" } }), "deezer:artist:bicep");
  // Last in line: a source's own image and a Spotify link come first.
  const hints = dayEntryHints({ id: "e", kind: "listened", source: "spotify", title: "Isles", subtitle: "Bicep", url: "https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5" }, { image: "https://i.scdn.co/image/abc" });
  assert.deepEqual(hints.map((h) => Object.keys(h)[0]), ["url", "spotify", "album"]);
});
