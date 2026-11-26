// Run: npx tsx --test lib/health.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_HEADING,
  healthLine,
  hoursMinutes,
  isHealthLine,
  isHealthQuestion,
  lineIn,
  mergeSave,
  mergeSources,
  readHealthDay,
  readPrefs,
  sameWorkout,
  workoutLine,
  withHealthLine,
  withoutHealth,
  workoutKind,
  workoutPhrase,
} from "./health";

const today = "2026-11-07";

test("readHealthDay: the Shortcut's day, with yesterday and Apple Health by default", () => {
  assert.deepEqual(readHealthDay({ steps: "9,200", sleep_minutes: 460, resting_hr: "52 bpm" }, { today, source: "apple_health" }), {
    date: "2026-11-06",
    source: "apple_health",
    steps: 9200,
    sleep_minutes: 460,
    resting_hr: 52,
  });
  const d = readHealthDay(
    { date: "2026-11-01", source: "strava", workouts: [{ type: "Run", minutes: 27.6, distance_m: 5012.4, kcal: 380 }], weight_kg: 81.26 },
    { today },
  );
  assert.deepEqual(d.workouts, [{ type: "Run", minutes: 28, distance_m: 5012, kcal: 380 }]);
  assert.equal(d.weight_kg, 81.3);
});

test("readHealthDay: refuses what it can't trust, saying what to fix", () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ step: 9000 }, /Unknown field step/],
    [{ steps: "lots" }, /steps: send a number/],
    [{ steps: -1 }, /outside/],
    [{ resting_hr: 400 }, /outside 20 to 250/],
    [{ sleep_minutes: 2000 }, /outside/],
    [{ date: "2026-11-08", steps: 1 }, /hasn't happened yet/],
    [{ date: "2026-02-30", steps: 1 }, /YYYY-MM-DD/],
    [{ date: "2024-01-01", steps: 1 }, /days back/],
    [{ source: "fitbit", steps: 1 }, /source: one of/],
    [{ source: "apple_health" }, /at least one figure/],
    [{ workouts: [{ minutes: 30 }] }, /type/],
    [{ workouts: [{ type: "run" }] }, /minutes/],
    [{ workouts: [{ type: "run", minutes: 30, pace: 5 }] }, /unknown field pace/],
    [{ workouts: Array.from({ length: 21 }, () => ({ type: "run", minutes: 5 })) }, /at most 20/],
    [[], /JSON/],
  ];
  for (const [raw, re] of bad) assert.throws(() => readHealthDay(raw, { today, source: "apple_health" }), re, JSON.stringify(raw));
  // A collection must say which account the figures are from.
  assert.throws(() => readHealthDay({ date: "2026-11-06", steps: 1 }, { today }), /source/);
});

test("mergeSave: sending again replaces what's sent and keeps the rest", () => {
  assert.deepEqual(mergeSave({ steps: 9000, sleep_minutes: 400 }, { steps: 9200 }), { steps: 9200, sleep_minutes: 400 });
  const once = mergeSave({}, { steps: 1 });
  assert.deepEqual(mergeSave(once, { steps: 1 }), once);
});

test("mergeSources: by default, sleep from Oura, steps from Apple Health, weight from Withings; one workout from two places is one", () => {
  const m = mergeSources([
    { source: "apple_health", steps: 9200, sleep_minutes: 430, resting_hr: 55, workouts: [{ type: "Running", minutes: 28 }, { type: "Yoga", minutes: 45 }], weight_kg: 82 },
    { source: "oura", steps: 8700, sleep_minutes: 460, resting_hr: 52 },
    { source: "strava", workouts: [{ type: "Run", minutes: 27, distance_m: 5000 }] },
    { source: "withings", weight_kg: 81.4 },
  ]);
  assert.equal(m.steps, 9200);
  assert.equal(m.sleep_minutes, 460);
  assert.equal(m.resting_hr, 52);
  assert.equal(m.weight_kg, 81.4);
  assert.deepEqual(m.workouts, [
    { type: "Running", minutes: 28, distance_m: 5000 },
    { type: "Yoga", minutes: 45 },
  ]);
  // A second run that day is a second run.
  assert.equal(mergeSources([{ source: "strava", workouts: [{ type: "Run", minutes: 30 }, { type: "Run", minutes: 60 }] }]).workouts?.length, 2);
});

test("the line: short, in the owner's words", () => {
  assert.equal(hoursMinutes(460), "7h 40m");
  assert.equal(hoursMinutes(420), "7h");
  assert.equal(hoursMinutes(45), "45m");
  assert.equal(workoutKind("HKWorkoutActivityTypeCycling"), "ride");
  assert.equal(workoutKind("TrailRun"), "run");
  assert.equal(workoutKind("TraditionalStrengthTraining"), "strength");
  assert.equal(workoutKind("Tennis"), "tennis");
  assert.equal(workoutKind("???"), "workout");
  assert.equal(workoutPhrase({ type: "run", minutes: 27, distance_m: 5000 }), "5k run");
  assert.equal(workoutPhrase({ type: "run", minutes: 110, distance_m: 21097 }), "21.1k run");
  assert.equal(workoutPhrase({ type: "Ride", minutes: 80, distance_m: 32400 }), "32 km ride");
  assert.equal(workoutPhrase({ type: "Walk", minutes: 40, distance_m: 3420 }), "3.4 km walk");
  assert.equal(workoutPhrase({ type: "Swim", minutes: 35, distance_m: 1500 }), "1,500 m swim");
  assert.equal(workoutPhrase({ type: "Yoga", minutes: 45 }), "45 min yoga");
  assert.equal(workoutPhrase({ type: "Hike", minutes: 150 }), "2h 30m hike");
  assert.equal(
    healthLine({ sleep_minutes: 460, steps: 9200, workouts: [{ type: "Run", minutes: 27, distance_m: 5000 }], resting_hr: 52, weight_kg: 81 }),
    "7h 40m sleep · 9,200 steps · 5k run · 52 bpm resting · 81 kg",
  );
  assert.equal(healthLine({}), null);
  assert.ok(isHealthLine("7h 40m sleep · 9,200 steps · 5k run · 52 bpm resting"));
  assert.ok(isHealthLine("45 min yoga"));
  assert.ok(!isHealthLine("Book the dentist"));
});

test("source choice: the owner's pick wins, the next source covers a gap, and two are never added", () => {
  const days = [
    { source: "apple_health" as const, steps: 9200, sleep_minutes: 430, resting_hr: 55 },
    { source: "oura" as const, steps: 8700, sleep_minutes: 460, resting_hr: 52 },
    { source: "withings" as const, steps: 9900, weight_kg: 72.4 },
  ];
  const mine = readPrefs({ sleep: "apple_health", steps: "withings" });
  const m = mergeSources(days, mine);
  assert.equal(m.sleep_minutes, 430, "sleep from Apple Health, as chosen");
  assert.equal(m.resting_hr, 55, "resting heart rate follows sleep");
  assert.equal(m.steps, 9900, "steps from Withings, never 9200 + 8700 + 9900");
  // Oura chosen for sleep, but the ring was charging: Withings has none, so Apple Health's night is used.
  assert.equal(mergeSources([{ source: "apple_health", sleep_minutes: 430 }]).sleep_minutes, 430);
  // Unknown or impossible choices fall back to the defaults.
  assert.deepEqual(readPrefs({ sleep: "strava", weight: "fitbit", steps: 3 }), { sleep: "oura", steps: "apple_health", weight: "withings", workouts: "apple_health", nutrition: "apple_health", mind: "apple_health" });
  assert.deepEqual(readPrefs(null).weight, "withings");
});

test("workout merge: matched by start time and kind, Apple Health's version with Strava's name, climb and route", () => {
  const apple = { type: "HKWorkoutActivityTypeRunning", minutes: 41, distance_m: 8050, start: "07:02" };
  const strava = { type: "trail run", minutes: 39, distance_m: 8100, start: "07:04", name: "Hill reps", elevation_m: 212, route: "_p~iF~ps|U_ulLnnqC", kcal: 610 };
  assert.ok(sameWorkout(apple, strava), "two minutes apart, both runs");
  assert.ok(!sameWorkout(apple, { ...strava, start: "07:12" }), "ten minutes apart is another run");
  assert.ok(!sameWorkout(apple, { ...strava, type: "Ride" }), "a ride isn't a run");
  const m = mergeSources([
    { source: "strava", workouts: [strava, { type: "ride", minutes: 55, distance_m: 21000, start: "17:30", name: "Evening Ride" }] },
    { source: "apple_health", workouts: [{ type: "Yoga", minutes: 30, start: "06:15" }, apple] },
  ]);
  assert.deepEqual(m.workouts, [
    { type: "Yoga", minutes: 30, start: "06:15" },
    { ...apple, kcal: 610, name: "Hill reps", elevation_m: 212, route: "_p~iF~ps|U_ulLnnqC" },
    { type: "ride", minutes: 55, distance_m: 21000, start: "17:30", name: "Evening Ride" },
  ]);
  assert.equal(
    healthLine(m),
    "30 min yoga · “Hill reps” 8.1k run, 212 m up · 21 km ride",
    "one line per workout; Strava's default names and kcal stay off the line",
  );
  assert.ok(isHealthLine(healthLine(m)));
  assert.equal(workoutLine({ type: "walk", minutes: 30, distance_m: 2400, elevation_m: 8 }), "2.4 km walk", "a small climb isn't worth saying");
  // Two runs one morning from one source stay two, even near each other.
  assert.equal(mergeSources([{ source: "apple_health", workouts: [{ ...apple }, { ...apple, start: "07:05" }] }]).workouts?.length, 2);
  // Start times come in as Shortcuts sends them.
  assert.equal(readHealthDay({ workouts: [{ type: "run", minutes: 30, start: "2026-11-06T07:02:41+00:00" }] }, { today, source: "apple_health" }).workouts?.[0].start, "07:02");
  assert.equal(readHealthDay({ workouts: [{ type: "run", minutes: 30, start: "6 Nov 2026 at 7:02" }] }, { today, source: "apple_health" }).workouts?.[0].start, "07:02");
  assert.throws(() => readHealthDay({ workouts: [{ type: "run", minutes: 30, start: "breakfast" }] }, { today, source: "apple_health" }), /start: a time/);
});

test("weight: in the line only on a day with a weigh-in", () => {
  assert.equal(healthLine({ steps: 9200, weight_kg: 72.4 }), "9,200 steps · 72.4 kg");
  assert.equal(healthLine({ steps: 9200 }), "9,200 steps");
  assert.equal(healthLine({ weight_kg: 80 }), "80 kg");
  assert.ok(isHealthLine("7h 40m sleep · 9,200 steps · 72.4 kg"));
  assert.equal(withoutHealth("Health 7h 40m sleep · 72.4 kg Watched Severance"), "Watched Severance");
});

test("the day note: one Health section at the top, replaced in place, everything else untouched", () => {
  const day = "## Watched\n- [Severance S2E3](https://example.com)\n\n## Watched on YouTube\n- [Desk](https://www.youtube.com/watch?v=aaaaaaaaaa1) · Shop";
  const once = withHealthLine(day, "7h 40m sleep · 9,200 steps");
  assert.equal(once, `${HEALTH_HEADING}\n7h 40m sleep · 9,200 steps\n\n${day}`);
  assert.equal(lineIn(once), "7h 40m sleep · 9,200 steps");
  assert.equal(withHealthLine(once, "7h 40m sleep · 9,200 steps"), once, "same line, same body");
  const twice = withHealthLine(once, "7h 40m sleep · 9,200 steps · 5k run");
  assert.equal(twice.split(HEALTH_HEADING).length, 2, "never two sections");
  assert.ok(twice.endsWith(day));
  assert.equal(withHealthLine(twice, null), day);
  assert.equal(withHealthLine("", "45 min yoga"), `${HEALTH_HEADING}\n45 min yoga`);
  // A section a run wrote in the middle is replaced by the real one at the top.
  const wrote = `## Watched\n- x\n\n${HEALTH_HEADING}\n8h sleep\n\n## Read\n- y`;
  assert.equal(withHealthLine(wrote, "7h sleep"), `${HEALTH_HEADING}\n7h sleep\n\n## Watched\n- x\n\n## Read\n- y`);
});

test("withoutHealth: Ask and searches don't see it; other notes keep their own Health heading", () => {
  const note = withHealthLine("## Watched\n- Severance", "7h 40m sleep · 9,200 steps · 5k run");
  assert.equal(withoutHealth(note), "## Watched\n- Severance");
  assert.equal(withoutHealth("Health 7h 40m sleep · 9,200 steps · 5k run Watched Severance"), "Watched Severance");
  assert.equal(withoutHealth("…sleep · 9,200 steps · 5k run · 52 bpm resting Watched Severance").includes("steps"), false);
  const own = "## Health\nRenew the insurance by March\n\n## Car\nMOT due";
  assert.equal(withoutHealth(own), own);
  assert.equal(withoutHealth(""), "");
});

test("isHealthQuestion: health, sleep and exercise questions only", () => {
  for (const q of ["How did I sleep last week?", "how many steps on Saturday", "When did I last go for a run?", "what's my resting heart rate", "Did I work out on Monday?", "my weight this month"]) {
    assert.ok(isHealthQuestion(q), q);
  }
  for (const q of ["What did I watch on Friday?", "What did Priya say about the launch?", "Where's my Lego order?"]) {
    assert.ok(!isHealthQuestion(q), q);
  }
});

test("steps sent as samples (Find Health Samples without Group By) are added up; readings are averaged", () => {
  const ctx = { today: "2026-11-07", source: "apple_health" as const };
  // An iPhone Shortcut sending a list: `steps: send a number, not "12\n10\n12\n8\n104\n19\n117\n44\n7\n326\n58\n58\n300"`.
  const steps = "12\n10\n12\n8\n104\n19\n117\n44\n7\n326\n58\n58\n300";
  assert.equal(readHealthDay({ steps }, ctx).steps, 1075);
  assert.equal(readHealthDay({ steps: [1200, "3,400", 400] }, ctx).steps, 5000);
  assert.equal(readHealthDay({ steps: "12\r\n10\n\n" }, ctx).steps, 22);
  assert.equal(readHealthDay({ resting_hr: "52\n54" }, ctx).resting_hr, 53);
  assert.equal(readHealthDay({ weight_kg: ["68.1", 68.4] }, ctx).weight_kg, 68.3);
  assert.throws(() => readHealthDay({ steps: "12\nlots" }, ctx), /steps: send a number, not "lots"/);
  // The total is still checked against the range.
  assert.throws(() => readHealthDay({ steps: "150000\n150000" }, ctx), /steps: 300000 is outside/);
});

// ---------- Food, drink and mind ----------

import { foodLine, valenceMood, valenceWord } from "./health";

/** The sample day from the brief (connectors-research-2, Batch A). */
const FOOD_DAY = { kcal: 1950, caffeine_mg: 285, caffeine_last: "15:40", caffeine_after_14_mg: 95, alcohol_drinks: 2, water_ml: 1800, mindful_minutes: 10 };

test("food and mind: the fixture day reads in, as text numbers and units the Shortcut sends", () => {
  const d = readHealthDay(
    { kcal: "1,950 kcal", caffeine_mg: "285 mg", caffeine_last: "15:40", caffeine_after_14_mg: 95, alcohol_drinks: "2", water_ml: "1.8 L", mindful_minutes: "10 min" },
    { today, source: "apple_health" },
  );
  assert.deepEqual(d, { date: "2026-11-06", source: "apple_health", ...FOOD_DAY });
  // Samples, one per line: added up. Energy in kJ, a session as seconds or a clock.
  const s = readHealthDay({ kcal: "2000 kJ\n2184 kJ", water_ml: "250 ml\n0.5 L\n8 fl oz", mindful_minutes: "600 s\n0:05:00", protein_g: "40 g\n35.4", carbs_g: 210, fat_g: "70 g" }, { today, source: "apple_health" });
  assert.equal(s.kcal, 1000);
  assert.equal(s.water_ml, 987);
  assert.equal(s.mindful_minutes, 15);
  assert.deepEqual([s.protein_g, s.carbs_g, s.fat_g], [75, 210, 70]);
  // The last time in a list counts; "7 Nov 2026 at 21:10" as Shortcuts writes a date.
  assert.equal(readHealthDay({ kcal: 500, last_meal: "6 Nov 2026 at 08:05\n6 Nov 2026 at 21:10\n6 Nov 2026 at 13:00" }, { today, source: "apple_health" }).last_meal, "21:10");
});

test("food and mind: caffeine samples with their times give the last cup and what came after 2pm", () => {
  const d = readHealthDay({ caffeine_mg: "95\n95\n95 mg", caffeine_times: "6 Nov 2026 at 07:30\n6 Nov 2026 at 11:00\n6 Nov 2026 at 15:40" }, { today, source: "apple_health" });
  assert.equal(d.caffeine_mg, 285);
  assert.equal(d.caffeine_last, "15:40");
  assert.equal(d.caffeine_after_14_mg, 95);
  // Nothing after 2pm is a figure too: 0 mg.
  assert.equal(readHealthDay({ caffeine_mg: [80, 60], caffeine_times: ["08:00", "13:59"] }, { today, source: "apple_health" }).caffeine_after_14_mg, 0);
  // Sent itself, it isn't worked out again.
  assert.equal(readHealthDay({ caffeine_mg: [80, 60], caffeine_times: ["08:00", "15:00"], caffeine_after_14_mg: 10 }, { today, source: "apple_health" }).caffeine_after_14_mg, 10);
});

test("food and mind: refusals say what to fix", () => {
  const no = (raw: unknown, re: RegExp) => assert.throws(() => readHealthDay(raw, { today, source: "apple_health" }), re);
  no({ kcal: -5 }, /kcal: -5 is outside 0 to 20000/);
  no({ water_ml: "2 pints" }, /water_ml: .*unit Athena knows/);
  no({ caffeine_mg: "lots" }, /caffeine_mg: send a number/);
  no({ alcohol_drinks: 80 }, /alcohol_drinks/);
  no({ mood_valence: 1.5 }, /mood_valence: 1.5 is outside -1 to 1/);
  no({ kcal: 10, caffeine_last: "quarter past" }, /caffeine_last.start: a time/);
  no({ caffeine_mg: "95\n95", caffeine_times: "08:00" }, /caffeine_times: send one time per caffeine_mg sample/);
  no({ mood_labels: [1, 2] }, /mood_labels: send words/);
  no({ caffein_mg: 95 }, /Unknown field caffein_mg/);
});

test("State of Mind: valence and labels, tidy; mood words and Athena's 1–5", () => {
  const d = readHealthDay({ mood_valence: "0.4", mood_labels: "Calm\nGrateful, Calm" }, { today, source: "apple_health" });
  assert.equal(d.mood_valence, 0.4);
  assert.deepEqual(d.mood_labels, ["Calm", "Grateful"]);
  assert.equal(valenceWord(0.4), "Pleasant");
  assert.equal(valenceWord(-0.8), "Very unpleasant");
  assert.equal(valenceWord(0), "Neutral");
  assert.deepEqual([-1, -0.5, 0, 0.4, 1].map(valenceMood), [1, 2, 3, 4, 5]);
});

test("food line: the brief's wording, and each figure left out when missing", () => {
  assert.equal(foodLine(FOOD_DAY), "1,950 kcal · 3 coffees, last 15:40 · 2 drinks · 1.8 L water · 10 min mindful");
  assert.equal(foodLine(FOOD_DAY, { mindful: false }), "1,950 kcal · 3 coffees, last 15:40 · 2 drinks · 1.8 L water");
  assert.equal(foodLine({ kcal: 1950 }), "1,950 kcal");
  assert.equal(foodLine({ caffeine_mg: 95 }), "1 coffee");
  assert.equal(foodLine({ caffeine_mg: 30, caffeine_last: "09:10" }), "30 mg caffeine, last 09:10");
  assert.equal(foodLine({ alcohol_drinks: 1 }), "1 drink");
  assert.equal(foodLine({ alcohol_drinks: 1.5 }), "1.5 drinks");
  assert.equal(foodLine({ water_ml: 450 }), "450 ml water");
  assert.equal(foodLine({ mindful_minutes: 10 }), "10 min mindful");
  assert.equal(foodLine({ mindful_minutes: 10 }, { mindful: false }), null);
  assert.equal(foodLine({ steps: 9000 }), null);
  // The body line is unchanged by food figures.
  assert.equal(healthLine({ steps: 9200, ...FOOD_DAY }), "9,200 steps");
});

test("food and mind merge: per source, the owner's choice first; times and labels come with their figure", () => {
  const apple = { source: "apple_health" as const, kcal: 1950, last_meal: "20:30", caffeine_mg: 285, caffeine_last: "15:40", mindful_minutes: 10, mood_valence: 0.4, mood_labels: ["Calm"] };
  const oura = { source: "oura" as const, caffeine_mg: 190, caffeine_last: "10:00", alcohol_drinks: 2, mindful_minutes: 25 };
  const m = mergeSources([apple, oura]);
  assert.deepEqual(
    { kcal: m.kcal, last_meal: m.last_meal, caffeine_mg: m.caffeine_mg, caffeine_last: m.caffeine_last, alcohol_drinks: m.alcohol_drinks, mindful_minutes: m.mindful_minutes, mood_labels: m.mood_labels },
    { kcal: 1950, last_meal: "20:30", caffeine_mg: 285, caffeine_last: "15:40", alcohol_drinks: 2, mindful_minutes: 10, mood_labels: ["Calm"] },
  );
  const prefs = { ...readPrefs({}), nutrition: "oura" as const, mind: "oura" as const };
  const o = mergeSources([apple, oura], prefs);
  assert.deepEqual([o.caffeine_mg, o.caffeine_last, o.mindful_minutes, o.kcal, o.mood_valence], [190, "10:00", 25, 1950, 0.4]);
  // A second save of the same source keeps what wasn't sent.
  assert.deepEqual(mergeSave({ kcal: 1950, water_ml: 1800 }, { water_ml: 2100 }), { kcal: 1950, water_ml: 2100 });
  // Saved choices: unknown or missing food and mind fall back to Apple Health.
  assert.deepEqual([readPrefs({ nutrition: "strava" }).nutrition, readPrefs({}).mind], ["apple_health", "apple_health"]);
});

test("isHealthQuestion: food, coffee, alcohol and meditation open the figures too", () => {
  for (const q of ["How much coffee did I have the week I slept badly?", "calories yesterday", "How many drinks on Friday?", "Did I meditate this week?", "caffeine after lunch", "mindful minutes in October"]) assert.ok(isHealthQuestion(q), q);
  assert.ok(!isHealthQuestion("What did Sam say about the launch?"));
});
