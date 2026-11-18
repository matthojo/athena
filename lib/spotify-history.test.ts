// Run: npx tsx --test lib/spotify-history.test.ts
// Spotify's extended streaming history (lib/spotify-history.ts): plays folded to one entry per album a local day,
// with minutes and plays per hour; skips, podcasts and audiobooks left out; ids that meet the Last.fm load's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchSpotifyDays, parseSpotifyHistory, sniffSpotifyName } from "./spotify-history";
import { albumDayId, spotifyHistoryEntries } from "./day-imports";

const play = (ts: string, track: string, artist: string, album: string | null, ms = 200_000, extra: Record<string, unknown> = {}) => ({
  ts,
  ms_played: ms,
  master_metadata_track_name: track,
  master_metadata_album_artist_name: artist,
  master_metadata_album_album_name: album,
  spotify_track_uri: `spotify:track:${track}`,
  skipped: false,
  ...extra,
});

const FIXTURE = [
  play("2026-07-03T07:10:00Z", "Low Tide", "Mara Vell", "Tidal Hours"), // 08:10 in London (BST)
  play("2026-07-03T07:14:00Z", "Glass Hours", "Mara Vell", "Tidal Hours"),
  play("2026-07-03T19:40:00Z", "Northwind", "Mara Vell", "Tidal Hours", 260_000),
  play("2026-07-03T23:30:00Z", "Undertow", "Ostra", "Amber Signals"), // 00:30 on the 4th in London
  play("2026-07-03T20:00:00Z", "A skip", "Ostra", "Amber Signals", 9_000),
  play("2026-07-03T20:05:00Z", "Single", "Kaito Rhee", null),
  { ts: "2026-07-03T06:00:00Z", ms_played: 1_500_000, master_metadata_track_name: null, episode_name: "Episode 4", spotify_episode_uri: "spotify:episode:1" },
  { ts: "2026-07-03T06:30:00Z", ms_played: 900_000, master_metadata_track_name: null, audiobook_title: "A long book" },
  play("2031-01-01T10:00:00Z", "Later", "Halden", "Winter Index"),
  { ts: "2026-07-03T10:00:00Z", ms_played: 200_000, master_metadata_track_name: null },
];

test("the audio files are known by name, nothing else in the zip", () => {
  assert.equal(sniffSpotifyName("Spotify Extended Streaming History/Streaming_History_Audio_2023-2024_3.json"), "audio");
  assert.equal(sniffSpotifyName("Streaming_History_Video_2024.json"), null);
  assert.equal(sniffSpotifyName("Spotify Account Data/StreamingHistory_music_0.json"), null);
  assert.equal(sniffSpotifyName("ReadMeFirst_ExtendedStreamingHistory.pdf"), null);
});

test("plays fold to one album a local day, with plays, minutes and hours; skips, podcasts and audiobooks stay out", async () => {
  const x = await parseSpotifyHistory([{ name: "Streaming_History_Audio_2026_0.json", text: JSON.stringify(FIXTURE) }, { name: "Userdata.json", text: "{}" }], { tz: "Europe/London", today: "2026-11-10" });
  assert.deepEqual(x.days.map((d) => d.day), ["2026-07-03", "2026-07-04"]);
  const [d3, d4] = x.days;
  const tidal = d3.albums.find((a) => a.title === "Tidal Hours")!;
  assert.equal(tidal.artist, "Mara Vell");
  assert.equal(tidal.plays, 3);
  assert.equal(tidal.minutes, 11, "200 + 200 + 260 seconds");
  assert.equal(tidal.hours[8], 2);
  assert.equal(tidal.hours[20], 1);
  assert.equal(tidal.hours.reduce((a, b) => a + b, 0), tidal.plays);
  assert.deepEqual(d3.albums.find((a) => a.artist === "Kaito Rhee")?.title, "Kaito Rhee", "no album: the artist stands in, as the Last.fm load does");
  assert.deepEqual(d4.albums.map((a) => [a.title, a.hours[0]]), [["Amber Signals", 1]], "after midnight in the owner's zone is the next day");
  assert.deepEqual(x.skipped, { short: 1, podcasts: 2, unnamed: 1, future: 1 });
  assert.equal(x.counts.plays, 5);
  assert.equal(x.counts.artists, 3);
  assert.equal(x.top.artists[0].name, "Mara Vell");
  assert.deepEqual(x.range, { first: "2026-07-03", last: "2026-07-04" });
});

test("entries: the album-and-day id the Last.fm load uses, count only above one, hours carried", async () => {
  const x = await parseSpotifyHistory([{ name: "Streaming_History_Audio_2026_0.json", text: JSON.stringify(FIXTURE) }], { tz: "Europe/London", today: "2026-11-10" });
  const [tidal] = spotifyHistoryEntries(x.days[0]);
  assert.equal(tidal.kind, "listened");
  assert.equal(tidal.source, "spotify");
  assert.equal(tidal.external_id, "2026-07-03:tidal hours mara vell");
  assert.equal(tidal.external_id, albumDayId("2026-07-03", "Tidal Hours", "Mara Vell"));
  assert.equal(tidal.count, 3);
  assert.equal(tidal.subtitle, "Mara Vell");
  assert.equal(tidal.group, "Mara Vell");
  assert.equal(tidal.hours?.[8], 2);
  assert.equal(spotifyHistoryEntries(x.days[1])[0].count, undefined, "one play: no count");
});

test("a file that isn't JSON is passed over; batches keep whole days", async () => {
  const x = await parseSpotifyHistory([{ name: "Streaming_History_Audio_bad.json", text: "not json" }]);
  assert.equal(x.range, null);
  const days = Array.from({ length: 5 }, (_, i) => ({ day: `2026-01-0${i + 1}`, albums: Array.from({ length: 3 }, (_, j) => ({ title: `A${j}`, plays: 1, minutes: 3, hours: [] })) }));
  assert.deepEqual(batchSpotifyDays(days, 120, 7).map((b) => b.map((d) => d.day.slice(-1))), [["1", "2"], ["3", "4"], ["5"]]);
});
