import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { batchListenDays, bytesSource, findExportFiles, MIN_PLAY_MS, parseAppleMusic, sniffApple, splitDescription, trackKey } from "./apple-music-export";
import { appleMusicEntries, lastfmCovers, notOnLastfm } from "./day-imports";

const dir = join(import.meta.dirname, "fixtures/apple-music");
const activity = readFileSync(join(dir, "play-activity.csv"), "utf8");
const daily = readFileSync(join(dir, "Apple Music - Play History Daily Tracks.csv"), "utf8");
const opts = { tz: "Europe/London", today: "2026-11-08" };

test("finds both Apple Music files by their headers, whatever they're called", () => {
  assert.equal(sniffApple(activity.split("\n")[0].split(",")), "activity");
  assert.equal(sniffApple(daily.split("\n")[0].split(",")), "daily");
  // Newer Play Activity files name the artist "Container Artist Name" and the time "Event Received Timestamp".
  assert.equal(sniffApple(["Container Artist Name", "Song Name", "Event Received Timestamp", "Play Duration Milliseconds"]), "activity");
  assert.equal(sniffApple(["Item Description", "Purchase Date", "Price"]), null);
  assert.equal(sniffApple(["Track Name", "Last Played Date", "Is User Initiated"]), null);
});

test("Play Activity: a play per row, short plays, videos, lyrics and future rows left out", async () => {
  const x = await parseAppleMusic([{ name: "whatever.csv", text: activity }], opts);
  assert.deepEqual(x.days.map((d) => d.day), ["2026-03-14", "2026-03-15"]);
  const fish = x.days[0].tracks[0];
  assert.equal(fish.title, "Weird Fishes/Arpeggi");
  assert.equal(fish.artist, "Radiohead");
  assert.equal(fish.album, "In Rainbows");
  assert.equal(fish.plays, 2);
  assert.equal(fish.minutes, 11);
  assert.equal(x.days[0].tracks.length, 1, "the 12-second Florence skip isn't a listen");
  assert.equal(x.skipped.short, 1);
  assert.equal(x.skipped.video, 1);
  assert.equal(x.skipped.future, 1);
  assert.equal(x.days[1].tracks[0].title, "Venom");
});

test("Daily Tracks: artist and title from the description, plays averaging under 30 s skipped", async () => {
  const x = await parseAppleMusic([{ name: "a.csv", text: daily }], opts);
  assert.deepEqual(x.days.map((d) => d.day), ["2026-03-14", "2026-03-16"]);
  const black = x.days[1].tracks;
  assert.equal(black.length, 1, "Hurt: 50 s over 3 plays is skips");
  assert.equal(black[0].artist, "Arlo Parks");
  assert.equal(black[0].title, "Black Dog - Live at Maida Vale");
  assert.equal(black[0].minutes, 7);
  assert.equal(x.skipped.short, 2);
  assert.deepEqual(splitDescription("Solo"), { title: "Solo" });
  assert.ok(MIN_PLAY_MS === 30_000);
});

test("both shapes in one export: the same song on the same day counts once", async () => {
  const x = await parseAppleMusic([{ name: "a", text: activity }, { name: "b", text: daily }], opts);
  const d14 = x.days.find((d) => d.day === "2026-03-14")!;
  assert.equal(d14.tracks.length, 1);
  assert.equal(d14.tracks[0].plays, 2);
  assert.equal(d14.tracks[0].minutes, 11);
  assert.equal(x.counts.days, 3);
  assert.equal(x.top.artists[0].name, "Radiohead");
});

test("reads the privacy.apple.com zip, nested zip and all", async () => {
  const found = await findExportFiles(bytesSource(new Uint8Array(readFileSync(join(dir, "export.zip")))), sniffApple);
  assert.deepEqual(found.map((f) => f.kind).sort(), ["activity", "daily"]);
  const x = await parseAppleMusic(await Promise.all(found.map(async (f) => ({ name: f.name, text: await f.text() }))), opts);
  assert.equal(x.counts.days, 3);
});

test("ids are stable across imports and file shapes", async () => {
  const a = await parseAppleMusic([{ name: "a", text: activity }], opts);
  const b = await parseAppleMusic([{ name: "b", text: daily }], opts);
  const ida = appleMusicEntries(a.days[0]).map((e) => e.external_id);
  const idb = appleMusicEntries(b.days[0]).map((e) => e.external_id);
  assert.deepEqual(ida, idb);
  assert.match(ida[0], /^2026-03-14:t[0-9a-z]{7}$/);
  assert.equal(trackKey("Radiohead", "Weird Fishes/Arpeggi"), trackKey("radiohead", "Weird Fishes / Arpeggi"));
  const again = await parseAppleMusic([{ name: "a", text: activity }], opts);
  assert.deepEqual(again.days.flatMap(appleMusicEntries), a.days.flatMap(appleMusicEntries));
});

test("Last.fm's entry for the same song or artist that day wins", async () => {
  const x = await parseAppleMusic([{ name: "a", text: activity }, { name: "b", text: daily }], opts);
  const lastfm = new Map([
    ["2026-03-14", [{ title: "In Rainbows", subtitle: "Radiohead", group: "Radiohead" }]],
    ["2026-03-16", [{ title: "Something else", subtitle: "Other artist" }]],
  ]);
  const { days, skipped } = notOnLastfm(x.days, lastfm);
  assert.equal(skipped, 1);
  assert.equal(days.find((d) => d.day === "2026-03-14")!.tracks.length, 0);
  assert.equal(days.find((d) => d.day === "2026-03-16")!.tracks.length, 1);
  assert.ok(lastfmCovers({ title: "Venom", artist: "Little Simz" }, [{ title: "Venom" }]));
  assert.ok(!lastfmCovers({ title: "Venom", artist: "Little Simz" }, [{ title: "Venom", subtitle: "Someone Else" }]));
});

test("batches are whole days within the request limits", () => {
  const days = Array.from({ length: 5 }, (_, i) => ({ day: `2026-01-0${i + 1}`, tracks: Array.from({ length: 250 }, (_, j) => ({ key: `t${String(j).padStart(7, "0")}`, title: `S${j}`, minutes: 3, plays: 1 })) }));
  const b = batchListenDays(days);
  assert.deepEqual(b.map((x) => x.length), [2, 2, 1]);
});
