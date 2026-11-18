// Run: npx tsx --test lib/sleep-stages.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as H from "./health";
import { readHealthDay, readHealthDayNoting, mergeSources, stagesLine, stagesWords } from "./health";
import { readLength, readStages, readWhen, stageOf, StagesWithoutTimes } from "./sleep-stages";

const today = "2026-11-07";
const ctx = { today, source: "apple_health" as const };

// What the owner's Shortcut sent on 7 Nov: the Sleep Analysis samples dropped into the sleep_minutes Number field.
const OWNER_SLEEP = "Deep\nCore\nREM\nCore\nAwake\nCore\nIn Bed\nDeep\nCore\nREM\nCore\nAwake\nCore\nREM\nCore";
const OWNER = { steps: 9213.0, sleep_minutes: OWNER_SLEEP, resting_hr: 52 };

test("the owner's exact payload: once refused, now the day saves and says what to change", () => {
  // Before: `sleep_minutes: send a number, not "Deep\nCore\nREM\nCore\nAwake\nCore\nIn Bed\nDee"`. The same text that refused it:
  assert.equal(JSON.stringify(OWNER_SLEEP.slice(0, 40)), JSON.stringify("Deep\nCore\nREM\nCore\nAwake\nCore\nIn Bed\nDee"));
  const { day, skipped } = readHealthDayNoting(OWNER, ctx);
  assert.deepEqual(day, { date: "2026-11-06", source: "apple_health", steps: 9213, resting_hr: 52 });
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /Sleep wasn't saved: Athena got the stage names but not their times\. In the Shortcut, send sleep_stages as the Stages text \(Settings → From your iPhone → Health, step 3\)\./);
  // Nothing but the names: a plain error naming the fix.
  assert.throws(() => readHealthDay({ sleep_minutes: OWNER_SLEEP }, ctx), /stage names but not their times\. In the Shortcut/);
  // A real number in sleep_minutes is still read, and nonsense is still refused.
  assert.equal(readHealthDay({ sleep_minutes: "461.5" }, ctx).sleep_minutes, 462);
  assert.throws(() => readHealthDay({ sleep_minutes: "lots" }, ctx), /sleep_minutes: send a number, not "lots"/);
});

test("the new Shortcut's Stages text: one sample a line, with the phone's own dates", () => {
  const stages = [
    "In Bed,6 Nov 2026 at 23:20,7 Nov 2026 at 07:10",
    "Core,6 Nov 2026 at 23:35,7 Nov 2026 at 00:20",
    "Deep,7 Nov 2026 at 00:20,7 Nov 2026 at 01:05",
    "Core,7 Nov 2026 at 01:05,7 Nov 2026 at 02:30",
    "REM,7 Nov 2026 at 02:30,7 Nov 2026 at 03:20",
    "Awake,7 Nov 2026 at 03:20,7 Nov 2026 at 03:35",
    "Core,7 Nov 2026 at 03:35,7 Nov 2026 at 05:00",
    "Deep,7 Nov 2026 at 05:00,7 Nov 2026 at 05:40",
    "REM,7 Nov 2026 at 05:40,7 Nov 2026 at 06:40",
    "Core,7 Nov 2026 at 06:40,7 Nov 2026 at 07:00",
  ].join("\n");
  const d = readHealthDay({ steps: 9213, sleep_stages: stages }, ctx);
  assert.deepEqual(d.sleep_stages, { deep: 85, core: 235, rem: 110, awake: 15, in_bed: 470 });
  // sleep_minutes is the time asleep: deep + core + REM, never awake or in bed.
  assert.equal(d.sleep_minutes, 430);
  // ISO 8601 and US dates read the same.
  assert.deepEqual(readStages("Core,2026-11-07T01:05:00Z,2026-11-07T02:30:00Z\nDeep,Nov 7, 2026 at 12:20 AM,Nov 7, 2026 at 1:05 AM"), { core: 85, deep: 45, in_bed: 130 });
});

test("other forms: minutes per stage, 'Stage,minutes', a list, JSON, parallel lists", () => {
  const want = { deep: 85, core: 265, rem: 110, awake: 20, in_bed: 480 };
  assert.deepEqual(readStages({ deep: 85, core: "265", rem: "1h 50m", awake: 20, in_bed: 480 }), want);
  // Added up by an app: kept as sent, even beside unstaged sleep or a short time in bed.
  assert.deepEqual(readStages({ deep: 86, core: 247, rem: 99, asleep_unspecified: 4, awake: 45, in_bed: 448 }), { deep: 86, core: 247, rem: 99, asleep_unspecified: 4, awake: 45, in_bed: 448 });
  assert.deepEqual(readStages({ deep: 85, light: 265, rem: 110, awake: 20, in_bed: 480 }), want);
  assert.deepEqual(readStages("Deep,85\nCore,200\nREM,110\nCore,65\nAwake,20\nIn Bed,480"), want);
  assert.deepEqual(readStages("Deep,85,Core,265,REM,110,Awake,20,In Bed,480"), want);
  assert.deepEqual(readStages(["deep,85", "CORE,265", "rem,110", "awake,20", "in bed,480"]), want);
  assert.deepEqual(readStages('[{"stage":"Deep","minutes":85},{"value":"Asleep Core","duration":"4:25"},{"stage":"REM","minutes":110},{"stage":"Awake","minutes":20},{"stage":"In Bed","minutes":480}]'), want);
  // Parallel lists, as the Shortcut sends a samples variable's Value and Duration.
  assert.deepEqual(readStages("Deep\nCore\nREM\nAwake\nIn Bed", { durations: "85\n265\n110\n20\n480" }), want);
  // Duration in seconds: a "night" of more than a day was seconds.
  assert.deepEqual(readStages(["Deep", "Core", "REM", "Awake", "In Bed"], { durations: [5100, 15900, 6600, 1200, 28800] }), want);
  assert.deepEqual(
    readStages("Core,Deep", { starts: "2026-11-07T00:00:00Z\n2026-11-07T01:00:00Z", ends: "2026-11-07T01:00:00Z\n2026-11-07T01:30:00Z" }),
    { core: 60, deep: 30, in_bed: 90 },
  );
  // Without in_bed, the time in bed is at least the night it holds.
  assert.deepEqual(readStages("Deep,60\nCore,200\nAwake,10"), { deep: 60, core: 200, awake: 10, in_bed: 270 });
  // Through the contract, in a form or JSON.
  const d = readHealthDay({ sleep_stages: "Deep\nCore", sleep_durations: "60, 300" }, ctx);
  assert.deepEqual(d, { date: "2026-11-06", source: "apple_health", sleep_minutes: 360, sleep_stages: { deep: 60, core: 300, in_bed: 360 } });
  // A sleep_minutes that's sent wins over the sum.
  assert.equal(readHealthDay({ sleep_minutes: 400, sleep_stages: { deep: 60, core: 300 } }, ctx).sleep_minutes, 400);
});

test("overlaps: In Bed around the stages, and two apps writing the same night, count each minute once", () => {
  const t = (hm: string) => `2026-11-07T${hm}:00Z`;
  const line = (s: string, a: string, b: string) => `${s},${t(a)},${t(b)}`;
  const night = [
    line("In Bed", "00:00", "08:00"), // the iPhone
    line("Asleep", "00:30", "07:30"), // Oura through Health: unstaged
    line("Core", "00:30", "02:00"), // the Watch
    line("Deep", "02:00", "03:00"),
    line("Awake", "03:00", "03:15"),
    line("REM", "03:15", "04:30"),
    line("Core", "04:15", "07:00"), // overlaps REM by 15 min
    line("Core", "06:00", "07:00"), // a duplicate
  ].join("\n");
  const s = readStages(night);
  // Deep 60, REM 75, Core 90 + 150 (REM keeps 4:15-4:30), unstaged only where nothing staged (7:00-7:30), awake 15, in bed 8h.
  assert.deepEqual(s, { deep: 60, core: 240, rem: 75, awake: 15, in_bed: 480, asleep_unspecified: 30 });
  // Without times, unstaged "Asleep" beside staged sleep is the same night: dropped.
  assert.deepEqual(readStages("Asleep,420\nCore,240\nDeep,60\nREM,90"), { core: 240, deep: 60, rem: 90, in_bed: 390 });
  // Unstaged alone stays.
  assert.deepEqual(readStages("Asleep,420\nIn Bed,450"), { asleep_unspecified: 420, in_bed: 450 });
});

test("names: Apple's in any case and spelling", () => {
  const cases: Array<[string, string | null]> = [
    ["Deep", "deep"], ["deep sleep", "deep"], ["Asleep Deep", "deep"], ["HKCategoryValueSleepAnalysisAsleepDeep", "deep"],
    ["CORE", "core"], ["Light", "core"], ["REM", "rem"], ["rem sleep", "rem"], ["Awake", "awake"],
    ["In Bed", "in_bed"], ["inBed", "in_bed"], ["Asleep", "asleep_unspecified"], ["Asleep Unspecified", "asleep_unspecified"],
    ["Napping", null],
  ];
  for (const [n, want] of cases) assert.equal(stageOf(n), want, n);
  assert.equal(readLength("1:15"), 75);
  assert.equal(readLength("75 min"), 75);
  assert.equal(readLength("4500 s"), 75);
  assert.equal(readLength("soon"), null);
  assert.equal(readWhen("7 Nov 2026 at 01:23"), Date.UTC(2026, 10, 7, 1, 23));
  assert.equal(readWhen("Nov 7, 2026 at 1:23 PM"), Date.UTC(2026, 10, 7, 13, 23));
});

test("plain errors that name what to change in the Shortcut", () => {
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ sleep_stages: "Napping,30" }, /“?"Napping"”? isn't a sleep stage\. Use Apple's names: Deep, Core, REM, Awake, In Bed or Asleep\. In the Shortcut/],
    [{ sleep_stages: "Core,soon" }, /can't read "soon" as minutes/],
    [{ sleep_stages: "Core,Monday,Tuesday" }, /can't read "Monday" as a date\. In the Shortcut, set each date's Date Format to ISO 8601/],
    [{ sleep_stages: "Deep\nCore", sleep_durations: "60" }, /sleep_durations: 1 duration for 2 stages\. Send one for each sample/],
    [{ sleep_durations: "60" }, /sleep_stages: send the stage names/],
    [{ sleep_stages: { naps: 30 } }, /unknown stage naps/],
    [{ sleep_stages: { deep: 2000 } }, /more than a day/],
    [{ sleep_stages: "Core,2026-11-07T05:00:00Z,2026-11-07T01:00:00Z" }, /ends before it starts/],
  ];
  for (const [raw, re] of bad) assert.throws(() => readHealthDay(raw, ctx), re, JSON.stringify(raw));
  assert.throws(() => readStages("Deep\nCore"), StagesWithoutTimes);
});

test("across sources: the breakdown comes from the app sleep comes from, never mixed", () => {
  const oura = { source: "oura" as const, sleep_minutes: 450, sleep_stages: { deep: 80, core: 260, rem: 110, awake: 30, in_bed: 480 } };
  const apple = { source: "apple_health" as const, sleep_minutes: 430, sleep_stages: { deep: 60, core: 280, rem: 90 } };
  const prefs = { sleep: "oura", steps: "apple_health", weight: "withings", workouts: "apple_health" } as const;
  assert.deepEqual(mergeSources([apple, oura], prefs).sleep_stages, oura.sleep_stages);
  assert.deepEqual(mergeSources([apple, oura], { ...prefs, sleep: "apple_health" }).sleep_stages, apple.sleep_stages);
  // The chosen app has sleep but no stages: none, rather than another app's night.
  assert.equal(mergeSources([{ source: "oura", sleep_minutes: 450 }, apple], prefs).sleep_stages, undefined);
  assert.equal(stagesLine(oura.sleep_stages), "1h 20m deep · 1h 50m REM");
  assert.equal(stagesWords(oura.sleep_stages), "1h 20m deep · 4h 20m core · 1h 50m REM · 30m awake · 8h in bed");
});

test("the day's line names deep sleep when the night has it (owner, 7 Nov), and still reads as a health line", () => {
  const { healthLine, isHealthLine, withoutHealth } = H;
  const staged = { sleep_minutes: 460, sleep_stages: { deep: 85, core: 265, rem: 110 }, steps: 6241, resting_hr: 52 };
  const line = healthLine(staged)!;
  assert.equal(line, "7h 40m sleep (1h 25m deep) · 6,241 steps · 52 bpm resting");
  // A night without stages, or stages without deep, keeps the plain words.
  assert.equal(healthLine({ sleep_minutes: 460, steps: 6241 }), "7h 40m sleep · 6,241 steps");
  assert.equal(healthLine({ sleep_minutes: 460, sleep_stages: { asleep_unspecified: 460 } }), "7h 40m sleep");
  assert.equal(healthLine({ sleep_minutes: 45, sleep_stages: { deep: 20 } }), "45m sleep (20m deep)");
  // Ask and search still recognise and strip it.
  assert.ok(isHealthLine(line));
  assert.equal(withoutHealth(`Health ${line} and then dinner`).trim(), "and then dinner");
});
