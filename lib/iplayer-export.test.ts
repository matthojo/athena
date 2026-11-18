import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIplayer, programmeKey, readMinutes, sniffIplayer, splitProgramme } from "./iplayer-export";
import { iplayerEntries } from "./day-imports";

const dir = join(import.meta.dirname, "fixtures/iplayer");
const viewing = readFileSync(join(dir, "iPlayer Viewing History.csv"), "utf8");
const account = readFileSync(join(dir, "Account Information.csv"), "utf8");
const opts = { tz: "Europe/London", today: "2026-11-08" };

test("finds the viewing file by its headers, not the account file", () => {
  assert.equal(sniffIplayer(viewing.split("\n")[0].split(",")), "iplayer");
  assert.equal(sniffIplayer(account.split("\n")[0].split(",")), null);
  assert.equal(sniffIplayer(["Title", "Watched At", "Minutes Watched"]), "iplayer");
});

test("programmes per day: series and episode, minutes, iPlayer rows only, short and future left out", async () => {
  const x = await parseIplayer([{ name: "a.csv", text: viewing }, { name: "b.csv", text: account }], opts);
  assert.deepEqual(x.files, ["a.csv"]);
  assert.deepEqual(x.days.map((d) => d.day), ["2026-05-18", "2026-05-24", "2026-05-25", "2026-05-26"]);
  const who = x.days[0].programmes[0];
  assert.equal(who.title, "Doctor Who");
  assert.equal(who.series, "Series 14");
  assert.equal(who.episode, "The Devil's Chord");
  assert.equal(iplayerEntries(x.days[0])[0].subtitle, "Series 14 · The Devil's Chord");
  assert.equal(who.minutes, 45);
  assert.equal(who.key, "m001zgd2");
  // Two sittings of one episode on one day: one entry, the minutes added up.
  assert.equal(x.days[2].programmes.length, 1);
  assert.equal(x.days[2].programmes[0].minutes, 53);
  assert.equal(x.days[1].programmes[0].title, "Paddington");
  assert.equal(x.days[1].programmes[0].film, true);
  assert.equal(x.skipped.other, 1, "Desert Island Discs is Sounds");
  assert.equal(x.skipped.short, 1, "30 seconds of Gavin & Stacey");
  assert.equal(x.skipped.future, 1);
  assert.equal(x.top[0].title, "Doctor Who");
});

test("ids: the BBC's PID, else a stable hash; the same file twice gives the same entries", async () => {
  const a = await parseIplayer([{ name: "a", text: viewing }], opts);
  const b = await parseIplayer([{ name: "a", text: viewing }], opts);
  const ea = a.days.flatMap(iplayerEntries);
  assert.deepEqual(ea, b.days.flatMap(iplayerEntries));
  assert.equal(ea[0].external_id, "2026-05-18:m001zgd2");
  assert.equal(ea[0].url, "https://www.bbc.co.uk/iplayer/episode/m001zgd2");
  assert.equal(programmeKey("Doctor Who", "Boom"), programmeKey("doctor who", "BOOM!"));
  const noPid = await parseIplayer([{ name: "c", text: "Title,Date,Duration\nLuther: Series 1: Episode 1,2026-04-02T20:00:00Z,58:30\n" }], opts);
  assert.equal(noPid.days[0].programmes[0].title, "Luther");
  assert.equal(noPid.days[0].programmes[0].series, "Series 1");
  assert.equal(noPid.days[0].programmes[0].episode, "Episode 1");
  assert.equal(noPid.days[0].programmes[0].minutes, 59);
  assert.match(iplayerEntries(noPid.days[0])[0].external_id, /^2026-04-02:p[0-9a-z]{7}$/);
});

test("durations in any unit", () => {
  assert.equal(readMinutes("2700", "Duration Watched (seconds)"), 45);
  assert.equal(readMinutes("45", "Minutes Watched"), 45);
  assert.equal(readMinutes("1:05:00", "Duration"), 65);
  assert.equal(readMinutes("1h 5m", "Time"), 65);
  assert.equal(readMinutes("2700000", "Watch time ms"), 45);
  assert.equal(readMinutes("", "Duration"), undefined);
  assert.deepEqual(splitProgramme("Gavin & Stacey"), { title: "Gavin & Stacey" });
});
