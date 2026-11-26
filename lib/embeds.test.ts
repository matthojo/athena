// Embeds (rich links): each provider's address shapes to its official embed address, and what's refused.
// Run: npx tsx --test lib/embeds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_FRAME_HOSTS, EMBED_PROVIDERS, embedFor, isEmbeddable, mapCoordinates, PROVIDER_NAMES, startSeconds } from "./embeds";

const url = (raw: string) => embedFor(raw)?.embedUrl;

test("YouTube: watch, short links, shorts, live, embed and playlists, always on youtube-nocookie.com", () => {
  const want = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  for (const raw of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share&si=abc",
    "http://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=tracking",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ])
    assert.equal(url(raw), want, raw);
  assert.equal(url("https://youtu.be/dQw4w9WgXcQ?t=90"), `${want}?start=90`);
  assert.equal(url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"), `${want}?start=90`);
  const short = embedFor("https://www.youtube.com/shorts/dQw4w9WgXcQ")!;
  assert.equal(short.embedUrl, want);
  assert.equal(short.aspect, 9 / 16);
  const e = embedFor("https://youtu.be/dQw4w9WgXcQ")!;
  assert.deepEqual([e.provider, e.kind, e.aspect], ["youtube", "video", 16 / 9]);
  assert.equal(url("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"), "https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
  assert.equal(embedFor("https://www.youtube.com/@somechannel"), null);
  assert.equal(embedFor("https://www.youtube.com/watch?v=short"), null, "a bad id");
  assert.equal(embedFor("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), null);
});

test("Vimeo: plain, unlisted with its hash, channels, showcases and the player address", () => {
  assert.equal(url("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(url("https://vimeo.com/76979871/abc123def4"), "https://player.vimeo.com/video/76979871?h=abc123def4");
  assert.equal(url("https://vimeo.com/channels/staffpicks/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(url("https://vimeo.com/showcase/123/video/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(url("https://player.vimeo.com/video/76979871?h=abc123def4&autoplay=1"), "https://player.vimeo.com/video/76979871?h=abc123def4");
  assert.equal(embedFor("https://vimeo.com/about"), null);
});

test("Loom: share and embed addresses", () => {
  const id = "0281766fa2d04bb788eaf19e65135184";
  assert.equal(url(`https://www.loom.com/share/${id}`), `https://www.loom.com/embed/${id}`);
  assert.equal(url(`https://loom.com/share/${id}?sid=x`), `https://www.loom.com/embed/${id}`);
  assert.equal(url(`https://www.loom.com/embed/${id}`), `https://www.loom.com/embed/${id}`);
  assert.equal(embedFor("https://www.loom.com/share/not-an-id"), null);
});

test("Spotify: tracks and episodes are compact rows, albums and playlists taller; intl paths too", () => {
  const track = embedFor("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc")!;
  assert.deepEqual([track.embedUrl, track.kind, track.aspect, track.height], ["https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT", "audio", null, 152]);
  assert.equal(track.openUrl, "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "tracking parameters dropped");
  assert.equal(url("https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3"), "https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3");
  assert.equal(embedFor("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")!.height, 352);
  assert.equal(url("https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ"), "https://open.spotify.com/embed/episode/512ojhOuo1ktJprKbVcKyQ");
  assert.equal(embedFor("https://open.spotify.com/user/someone"), null);
  assert.equal(embedFor("https://spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"), null);
});

test("Apple Music: albums, songs, a track in an album, playlists and music videos", () => {
  const album = embedFor("https://music.apple.com/gb/album/blue/1440818839")!;
  assert.deepEqual([album.embedUrl, album.height, album.title], ["https://embed.music.apple.com/gb/album/blue/1440818839", 450, "blue"]);
  const track = embedFor("https://music.apple.com/us/album/a-case-of-you/1440818839?i=1440819073&ls=1")!;
  assert.deepEqual([track.embedUrl, track.height], ["https://embed.music.apple.com/us/album/a-case-of-you/1440818839?i=1440819073", 175]);
  assert.equal(url("https://music.apple.com/gb/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"), "https://embed.music.apple.com/gb/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb");
  const video = embedFor("https://music.apple.com/gb/music-video/some-video/1234567890")!;
  assert.deepEqual([video.kind, video.aspect], ["video", 16 / 9]);
  assert.equal(embedFor("https://music.apple.com/gb/artist/joni-mitchell/30418"), null, "artists have no player");
  assert.equal(embedFor("https://music.apple.com/browse"), null);
});

test("Google Maps: places, views, searches and its own embed address; coordinates for the still, never a player", () => {
  const place = embedFor("https://www.google.com/maps/place/Dishoom+King's+Cross/@51.5362,-0.1259,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d51.536214!4d-0.125672")!;
  assert.equal(place.provider, "google-maps");
  assert.equal(place.embedUrl, null, "nothing loads from Google in a note");
  assert.deepEqual([place.kind, place.allow, place.aspect], ["map", "", 4 / 3]);
  assert.equal(place.title, "Dishoom King's Cross");
  assert.deepEqual(place.at, { lat: 51.536214, lng: -0.125672 }, "the pin's own spot beats the view's centre");
  assert.deepEqual(mapCoordinates("https://www.google.com/maps/@51.5,-0.12,15z"), { lat: 51.5, lng: -0.12 });
  assert.deepEqual(mapCoordinates("https://maps.google.com/?q=51.5,-0.12"), { lat: 51.5, lng: -0.12 });
  assert.deepEqual(mapCoordinates("https://www.google.co.uk/maps?q=51.5,-0.12"), { lat: 51.5, lng: -0.12 });
  const search = embedFor("https://www.google.com/maps/search/?api=1&query=British+Museum")!;
  assert.equal(search.embedUrl, null);
  assert.equal(search.title, "British Museum");
  assert.equal(search.at, undefined);
  const own = embedFor("https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2482.0!2d-0.1257!3d51.5362!2m3!1f0!2f0!3f0")!;
  assert.equal(own.embedUrl, null, "even Google's own embed address doesn't load Google's player");
  assert.equal(own.openUrl, "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2482.0!2d-0.1257!3d51.5362!2m3!1f0!2f0!3f0");
  assert.deepEqual(own.at, { lat: 51.5362, lng: -0.1257 });
  assert.equal(embedFor("https://www.google.com/search?q=maps"), null);
  assert.equal(embedFor("https://maps.app.goo.gl/abc123"), null, "a short link can't be read without fetching it");
  assert.equal(embedFor("https://www.google.com/maps"), null, "nothing to show");
});

test("Apple Maps: no player, so no embed address, but a title and coordinates for Athena's still", () => {
  const e = embedFor("https://maps.apple.com/?ll=51.5362,-0.1257&q=Dishoom")!;
  assert.deepEqual([e.provider, e.kind, e.embedUrl, e.title], ["apple-maps", "map", null, "Dishoom"]);
  assert.deepEqual(e.at, { lat: 51.5362, lng: -0.1257 });
  assert.deepEqual(mapCoordinates("https://maps.apple.com/place?coordinate=51.5,-0.12&name=Somewhere"), { lat: 51.5, lng: -0.12 });
  assert.equal(embedFor("https://maps.apple.com/?address=1%20Infinite%20Loop")!.title, "1 Infinite Loop");
  assert.equal(embedFor("https://maps.apple.com/"), null);
  assert.equal(mapCoordinates("https://maps.apple.com/?ll=95,0"), null, "out of range");
});

test("Figma: design, file (old), proto, board and slides on embed.figma.com", () => {
  const e = embedFor("https://www.figma.com/design/AbCdEf1234567890/My-Design?node-id=1-2&t=xyz")!;
  assert.equal(e.embedUrl, "https://embed.figma.com/design/AbCdEf1234567890/My-Design?node-id=1-2&embed-host=athena");
  assert.deepEqual([e.kind, e.title], ["canvas", "My Design"]);
  assert.equal(url("https://www.figma.com/file/AbCdEf1234567890/Old"), "https://embed.figma.com/design/AbCdEf1234567890/Old?embed-host=athena");
  assert.equal(url("https://figma.com/proto/AbCdEf1234567890"), "https://embed.figma.com/proto/AbCdEf1234567890?embed-host=athena");
  assert.equal(url("https://www.figma.com/board/AbCdEf1234567890/Jam"), "https://embed.figma.com/board/AbCdEf1234567890/Jam?embed-host=athena");
  assert.equal(embedFor("https://www.figma.com/community"), null);
});

test("Framer: published sites only", () => {
  const e = embedFor("https://studio-north.framer.website/work/?ref=x")!;
  assert.deepEqual([e.provider, e.embedUrl, e.kind], ["framer", "https://studio-north.framer.website/work", "canvas"]);
  assert.equal(url("https://studio-north.framer.app/"), "https://studio-north.framer.app");
  assert.equal(embedFor("https://www.framer.com/projects/abc"), null, "the editor isn't a site");
  assert.equal(embedFor("https://framer.website"), null);
});

test("refusals: pasted HTML, other sites, look-alike hosts, other schemes, credentials and odd ports", () => {
  for (const raw of [
    '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
    "https://www.youtube.com/embed/dQw4w9WgXcQ\"><script>",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://evil.example/?u=https://youtu.be/dQw4w9WgXcQ",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "ftp://vimeo.com/76979871",
    "https://user:pw@vimeo.com/76979871",
    "https://vimeo.com:8443/76979871",
    "youtu.be/dQw4w9WgXcQ",
    "",
    `https://youtu.be/${"a".repeat(3000)}`,
  ])
    assert.equal(embedFor(raw), null, raw);
  assert.equal(embedFor(42), null);
  assert.equal(embedFor(null), null);
  assert.equal(isEmbeddable("https://a.example"), false);
  assert.equal(isEmbeddable("https://youtu.be/dQw4w9WgXcQ"), true);
  assert.equal(mapCoordinates("https://youtu.be/dQw4w9WgXcQ"), null);
});

test("every embed address is https on a host the frame allowlist names; names for every provider", () => {
  const samples = [
    "https://youtu.be/dQw4w9WgXcQ",
    "https://vimeo.com/76979871",
    "https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184",
    "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    "https://music.apple.com/gb/album/blue/1440818839",
    "https://www.figma.com/design/AbCdEf1234567890/X",
    "https://studio-north.framer.website/",
  ];
  for (const raw of samples) {
    const u = new URL(url(raw)!);
    assert.equal(u.protocol, "https:");
    assert.ok(EMBED_FRAME_HOSTS.some((h) => (h.includes("*") ? u.hostname.endsWith(h.split("*")[1]) : `https://${u.hostname}` === h)), raw);
  }
  for (const p of EMBED_PROVIDERS) assert.ok(PROVIDER_NAMES[p]);
  assert.ok(!EMBED_FRAME_HOSTS.some((h) => h.includes("google")), "no Google frames: maps are Athena's still");
  for (const raw of ["https://www.google.com/maps/@51.5,-0.12,15z", "https://maps.apple.com/?ll=51.5,-0.12"]) assert.equal(embedFor(raw)!.embedUrl, null, raw);
});

test("start times", () => {
  assert.equal(startSeconds("90"), 90);
  assert.equal(startSeconds("90s"), 90);
  assert.equal(startSeconds("1h2m3s"), 3723);
  assert.equal(startSeconds("1:30"), 90);
  assert.equal(startSeconds("soon"), undefined);
  assert.equal(startSeconds(null), undefined);
});

test("Open map goes to the maps app picked for this device", async () => {
  const { mapAppUrl, mapPlatform, defaultMapApp, isMapApp } = await import("./embeds");
  assert.equal(mapPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "apple");
  assert.equal(mapPlatform("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)"), "apple");
  assert.equal(mapPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "apple");
  assert.equal(mapPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), "android");
  assert.equal(mapPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "web");
  assert.equal(mapPlatform(undefined), "web");
  // Before the owner picks: Apple Maps on Apple devices, OpenStreetMap everywhere else.
  assert.equal(defaultMapApp("apple"), "apple");
  assert.equal(defaultMapApp("android"), "osm");
  assert.equal(defaultMapApp("web"), "osm");
  assert.ok(isMapApp("google") && isMapApp("osm") && isMapApp("apple"));
  assert.ok(!isMapApp("android") && !isMapApp(null) && !isMapApp(""));

  const spot = { at: { lat: 51.5362, lng: -0.1257 }, query: "Dishoom (King's Cross)" };
  assert.equal(mapAppUrl(spot, "apple", "apple"), "maps://?ll=51.5362%2C-0.1257&q=Dishoom+King%27s+Cross", "the Maps app on an Apple device");
  assert.equal(mapAppUrl(spot, "apple", "web"), "https://maps.apple.com/?ll=51.5362%2C-0.1257&q=Dishoom+King%27s+Cross", "Apple Maps on the web elsewhere");
  assert.equal(mapAppUrl(spot, "google", "apple"), "https://www.google.com/maps/search/?api=1&query=51.5362%2C-0.1257");
  assert.equal(mapAppUrl(spot, "osm", "web"), "https://www.openstreetmap.org/?mlat=51.5362&mlon=-0.1257#map=17/51.5362/-0.1257");
  assert.equal(mapAppUrl({ query: "British Museum" }, "osm"), "https://www.openstreetmap.org/search?query=British+Museum");
  assert.equal(mapAppUrl({ query: "British Museum" }, "google", "android"), "https://www.google.com/maps/search/?api=1&query=British+Museum");
  assert.equal(mapAppUrl({ query: "British Museum" }, "apple", "apple"), "maps://?q=British+Museum");
  assert.equal(mapAppUrl({}, "apple", "apple"), null);
  assert.equal(mapAppUrl({ at: { lat: 120, lng: 0 } }, "osm"), null, "out of range and nothing else");
  // The Apple Maps embed has no player; its still opens the picked app instead.
  const e = embedFor("https://maps.apple.com/?ll=51.5362,-0.1257&q=Dishoom")!;
  assert.equal(mapAppUrl({ at: e.at, query: e.title }, "apple", "apple"), "maps://?ll=51.5362%2C-0.1257&q=Dishoom");
  // A Google Maps link opens like an Apple Maps one: the picked app, never Google's player.
  const g = embedFor("https://www.google.com/maps/place/Dishoom/@51.5362,-0.1257,17z")!;
  assert.equal(g.embedUrl, null);
  assert.equal(mapAppUrl({ at: g.at, query: g.title }, "apple", "apple"), "maps://?ll=51.5362%2C-0.1257&q=Dishoom");
  assert.equal(mapAppUrl({ at: g.at, query: g.title }, "osm", "android"), "https://www.openstreetmap.org/?mlat=51.5362&mlon=-0.1257#map=17/51.5362/-0.1257");
  assert.equal(mapAppUrl({ at: g.at, query: g.title }, "google", "web"), "https://www.google.com/maps/search/?api=1&query=51.5362%2C-0.1257");
});
