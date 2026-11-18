// Patterns: the pure engine (lib/patterns.ts).
// Run: npx tsx --test lib/patterns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, adjustBH, digestOf, findPatterns, fitsDay, forOutcome, patternLabels, patternWords, permutationP, type Pattern, type PatternDay } from "./patterns";

const TODAY = "2026-11-07";

/** A seeded generator for made-up days. */
function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
/** Roughly normal noise. */
const noise = (r: () => number, sd: number) => (r() + r() + r() + r() - 2) * sd * 0.866;

/** `n` days ending today, oldest first, made by `make`. */
function days(n: number, make: (date: string, i: number) => Omit<PatternDay, "date">): PatternDay[] {
  return Array.from({ length: n }, (_, k) => {
    const date = addDays(TODAY, -(n - 1 - k));
    return { date, ...make(date, k) };
  });
}

test("a true pattern is found and said plainly: yoga, then a longer night", () => {
  const r = rand(11);
  const yoga = new Set<string>();
  const d = days(91, (date, i) => {
    if (i % 4 === 1 || i % 7 === 3) yoga.add(date);
    return { workouts: yoga.has(date) ? [{ kind: "yoga", minutes: 40 }] : [], steps: Math.round(8000 + noise(r, 1500)), mood: 3 };
  });
  // Sleep on a day is the night that ended that morning: a yoga day lifts the next day's figure.
  for (const day of d) day.sleep = Math.round(430 + noise(r, 25) + (yoga.has(addDays(day.date, -1)) ? 40 : 0));
  const found = findPatterns(d, { today: TODAY, window: 90 });
  const p = found.find((x) => x.id === "workout:yoga|sleep|0");
  assert.ok(p, `expected the yoga pattern, got ${found.map((x) => x.id).join(", ")}`);
  assert.ok(p.diff > 30 && p.diff < 50, `diff ${p.diff}`);
  assert.match(p.line, /^You sleep (35|40|45) min longer on days you do yoga$/);
  assert.match(p.evidence, /^Longer than usual on \d+ of \d+ days you do yoga$/);
  assert.ok(p.beat > p.n_with / 2);
  assert.ok(p.sure >= 2);
  assert.ok(p.dates.every((x) => yoga.has(x)));
  assert.equal(found[0].id, p.id, "the strongest comes first");
  // Nothing about steps or mood, which yoga doesn't touch here.
  assert.ok(!found.some((x) => x.factor === "workout:yoga" && x.outcome !== "sleep"));
  assert.equal(fitsDay(found, [...yoga].sort().at(-2)!)?.id, p.id);
  assert.equal(forOutcome(found, "sleep", "deep").length, found.filter((x) => x.outcome === "sleep" || x.outcome === "deep").length);
});

test("noise is rejected: many factors, no real link, nothing comes back", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = rand(seed * 977);
    const places = ["Dishoom", "Gym", "Office", "Mum's", "Hampstead Heath"];
    const d = days(365, () => ({
      sleep: Math.round(440 + noise(r, 45)),
      deep: Math.round(80 + noise(r, 18)),
      mood: 1 + Math.floor(r() * 5),
      steps: Math.round(8500 + noise(r, 3000)),
      resting_hr: Math.round(55 + noise(r, 3)),
      workouts: r() < 0.3 ? [{ kind: r() < 0.5 ? "run" : "yoga", minutes: 30 + Math.round(r() * 50), distance_m: r() < 0.3 ? 11000 : 5000 }] : [],
      meetings: Array.from({ length: Math.floor(r() * 7) }, () => 8 + r() * 12),
      places: places.filter(() => r() < 0.25),
      watch_minutes: r() < 0.3 ? Math.round(r() * 200) : 0,
    }));
    for (const window of [30, 90, 365] as const) {
      const found = findPatterns(d, { today: TODAY, window });
      assert.deepEqual(found.map((x) => x.id), [], `seed ${seed}, ${window} days`);
    }
  }
});

test("small samples are refused, however big the difference", () => {
  const r = rand(5);
  const yoga = new Set<string>();
  const d = days(90, (date, i) => {
    if (i % 13 === 0) yoga.add(date);
    return { workouts: yoga.has(date) ? [{ kind: "yoga", minutes: 40 }] : [] };
  });
  for (const day of d) day.sleep = Math.round(420 + noise(r, 10) + (yoga.has(addDays(day.date, -1)) ? 120 : 0));
  assert.ok(yoga.size < 8);
  assert.deepEqual(findPatterns(d, { today: TODAY, window: 90 }), []);
  // And a window too short to have 8 days on each side.
  const short = days(12, (_, i) => ({ sleep: 400 + i * 10, workouts: i % 2 ? [{ kind: "run", minutes: 30 }] : [] }));
  assert.deepEqual(findPatterns(short, { today: TODAY, window: 30 }), []);
});

test("a difference too small to notice is left out even when it's steady", () => {
  const r = rand(9);
  const d = days(365, (date) => {
    const we = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    return { steps: Math.round(8000 + (we ? 400 : 0) + noise(r, 150)) };
  });
  assert.deepEqual(findPatterns(d, { today: TODAY, window: 365 }), []);
});

test("lagged pairs: a long run, then a better day; a short night, then a lower mood", () => {
  const r = rand(21);
  const long = new Set<string>();
  const d = days(120, (date, i) => {
    if (i % 5 === 2) long.add(date);
    return {
      workouts: long.has(date) ? [{ kind: "run", minutes: 75, distance_m: 14000 }] : i % 5 === 4 ? [{ kind: "run", minutes: 30, distance_m: 5000 }] : [],
      sleep: Math.round(i % 3 === 0 ? 330 + noise(r, 15) : 460 + noise(r, 20)),
    };
  });
  for (const day of d) {
    const after = long.has(addDays(day.date, -1));
    const short = day.sleep! < 380;
    const m = 3 + (after ? 1.2 : 0) - (short ? 1.1 : 0) + noise(r, 0.4);
    day.mood = Math.max(1, Math.min(5, Math.round(m)));
  }
  const found = findPatterns(d, { today: TODAY, window: 90 });
  const ids = found.map((x) => x.id);
  const run = found.find((x) => x.id === "long_run|mood|1");
  assert.ok(run, ids.join(", "));
  assert.equal(run.line, "Your mood is better the day after a long run");
  assert.match(run.evidence, /^Good or Great on \d+ of \d+ days after a long run$/);
  const night = found.find((x) => x.id === "short_sleep|mood|0");
  assert.ok(night, ids.join(", "));
  assert.match(night.line, /^Your mood is lower after a night under \dh( \d+m)?$/);
  // A short night is never paired with sleep itself.
  assert.ok(!ids.some((x) => x.startsWith("short_sleep|sleep") || x.startsWith("short_sleep|deep")));
});

test("days where a factor can't be known are on neither side; everyday places and Ask's place rule", () => {
  const r = rand(3);
  const dishoom = new Set<string>();
  const d = days(90, (date, i) => {
    if (i % 3 === 0) dishoom.add(date);
    // Places known only on even days.
    return { places: i % 2 === 0 ? ["Home", ...(dishoom.has(date) ? ["Dishoom"] : [])] : undefined, mood: 3 };
  });
  for (const day of d) day.steps = Math.round(7000 + noise(r, 800) + (dishoom.has(day.date) ? 3000 : 0));
  const found = findPatterns(d, { today: TODAY, window: 90 });
  const p = found.find((x) => x.factor === "place:Dishoom" && x.outcome === "steps" && x.lag === 0);
  assert.ok(p, found.map((x) => x.id).join(", "));
  assert.equal(p.n_with + p.n_without, 45, "only the days with places");
  assert.match(p.line, /^You walk [\d,]+ more steps on days you go to Dishoom$/);
  assert.ok(!found.some((x) => x.factor === "place:Home"), "home is the backdrop");
  assert.ok(!findPatterns(d, { today: TODAY, window: 90, places: false }).some((x) => x.factor_kind === "place"));
});

test("windows: an old pattern shows over a year but not in the last month", () => {
  const r = rand(77);
  const d = days(365, (date, i) => {
    const late = i % 3 === 0;
    return { meetings: late ? [10, 19] : [10], mood: Math.max(1, Math.min(5, Math.round(3.5 - (late && i < 300 ? 1.3 : 0) + noise(r, 0.5)))) };
  });
  assert.ok(findPatterns(d, { today: TODAY, window: 365 }).some((x) => x.id === "late_meeting|mood|0"));
  assert.ok(!findPatterns(d, { today: TODAY, window: 30 }).some((x) => x.id === "late_meeting|mood|0"));
});

test("words: each outcome, the day after and the morning after, and no jargon", () => {
  const base = { beat: 14, beat_without: 9, n_with: 21, n_without: 40 } as const;
  assert.deepEqual(patternWords({ ...base, factor_kind: "workout", factor_name: "yoga", outcome: "sleep", lag: 0, diff: 41 }), {
    line: "You sleep 40 min longer on days you do yoga",
    evidence: "Longer than usual on 14 of 21 days you do yoga",
  });
  assert.equal(patternWords({ ...base, factor_kind: "late_meeting", outcome: "sleep", lag: 0, diff: -72 }).line, "You sleep 1h 10m less on days with a meeting after 6pm");
  assert.equal(patternWords({ ...base, factor_kind: "weekend", outcome: "steps", lag: 0, diff: 2340 }).line, "You walk 2,300 more steps at weekends");
  assert.equal(patternWords({ ...base, factor_kind: "workout", factor_name: "run", outcome: "resting_hr", lag: 0, diff: -2.4 }).line, "Your resting heart rate is 2 bpm lower the morning after you run");
  assert.equal(patternWords({ ...base, factor_kind: "watching", amount: 120, outcome: "deep", lag: 0, diff: -9 }).line, "You get 9 min less deep sleep on days with 2 hours or more of watching");
  assert.equal(patternWords({ ...base, factor_kind: "busy_calendar", amount: 5, outcome: "mood", lag: 1, diff: -0.6 }).line, "Your mood is lower the day after 5 or more meetings");
  assert.equal(patternWords({ ...base, factor_kind: "tag", factor_name: "alcohol-free", outcome: "sleep", lag: 0, diff: 25 }).line, "You sleep 25 min longer on alcohol-free days");
  for (const outcome of ["sleep", "deep", "mood", "steps", "resting_hr"] as const) {
    const w = patternWords({ ...base, factor_kind: "any_workout", outcome, lag: 0, diff: 30 });
    assert.doesNotMatch(`${w.line} ${w.evidence}`, /\b(p-value|significan|correlat|caus|because|should|risk)\w*/i);
  }
});

test("the statistics: permutation and the correction", () => {
  const p = permutationP([10, 11, 12, 13, 14, 15, 16, 17], [1, 2, 3, 4, 5, 6, 7, 8], 1);
  assert.ok(p < 0.002);
  const same = permutationP([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8], 1);
  assert.ok(same > 0.9);
  assert.deepEqual(adjustBH([0.01, 0.04, 0.03, 0.5]).map((x) => Math.round(x * 1000) / 1000), [0.04, 0.053, 0.053, 0.5]);
});

test("the weekly digest: new, stronger, weaker and faded", () => {
  const mk = (id: string, diff: number, sure: 1 | 2 | 3 = 2, score = 1): Pattern =>
    ({ id, diff, sure, score, line: id, evidence: "", factor: id, factor_kind: "weekend", outcome: "steps", lag: 0, with_avg: 0, without_avg: 0, n_with: 10, n_without: 10, beat: 5, beat_without: 5, dates: [] });
  const before = [mk("a", 40), mk("b", 40), mk("c", 40), mk("gone", 30)];
  const now = [mk("a", 41), mk("b", 60), mk("c", 20), mk("new", 25, 1, 0.5)];
  const dg = digestOf(now, before, TODAY, 90);
  assert.equal(dg.week_of, "2026-11-02");
  assert.deepEqual(dg.items.map((x) => [x.change, x.pattern.id]), [["new", "new"], ["stronger", "b"], ["weaker", "c"]]);
  assert.deepEqual(dg.faded, [{ id: "gone", line: "gone" }]);
});

test("food, drink and mind: late caffeine and a shorter night, drinks and a higher resting heart rate, mindful days and mood", () => {
  const r = rand(29);
  const late = new Set<string>();
  const drink = new Set<string>();
  const mindful = new Set<string>();
  const d = days(120, (date, i) => {
    if (i % 3 === 0) late.add(date);
    if (i % 5 === 1 || i % 7 === 2) drink.add(date);
    if (i % 2 === 0) mindful.add(date);
    return {
      caffeine_late_mg: late.has(date) ? 95 : 0,
      drinks: drink.has(date) ? 2 : 0,
      mindful_minutes: mindful.has(date) ? 10 : 0,
      water_ml: Math.round(1600 + noise(r, 300)),
      last_meal: 19 + noise(r, 0.6),
      steps: Math.round(8000 + noise(r, 1500)),
      mood: Math.min(5, Math.max(1, Math.round(3 + noise(r, 0.6) + (mindful.has(date) ? 1 : 0)))),
    };
  });
  // Sleep and resting heart rate belong to the next morning.
  for (const day of d) {
    const eve = addDays(day.date, -1);
    day.sleep = Math.round(440 + noise(r, 20) - (late.has(eve) ? 35 : 0));
    day.resting_hr = Math.round(54 + noise(r, 1) + (drink.has(eve) ? 4 : 0));
  }
  const found = findPatterns(d, { today: TODAY, window: 90, max: 20 });
  const ids = found.map((x) => x.id);
  const caf = found.find((x) => x.id === "caffeine_late|sleep|0");
  assert.ok(caf, ids.join(", "));
  assert.match(caf.line, /^You sleep (30|35|40) min less on days you have caffeine after 2pm$/);
  assert.ok(caf.n_with >= 20, "never under ~20 paired days for a claim this sure");
  const hr = found.find((x) => x.id === "drinks|resting_hr|0");
  assert.ok(hr, ids.join(", "));
  assert.match(hr.line, /^Your resting heart rate is \d bpm higher the morning after a drink$/);
  const mood = found.find((x) => x.id === "mindful|mood|0");
  assert.ok(mood, ids.join(", "));
  assert.equal(mood.line, "Your mood is better on days with a mindful session");
  // Only the spec's pairings: no "late caffeine → steps" or "water → sleep" is even tried.
  assert.ok(!found.some((x) => (x.factor === "caffeine_late" && !["sleep", "deep", "resting_hr"].includes(x.outcome)) || (x.factor === "water" && (x.outcome === "sleep" || x.lag === 0))));
  // Never advice, never cause.
  for (const p of found) assert.doesNotMatch(p.line, /\b(should|try|because|causes?|leads? to)\b/i);
});

test("food, drink and mind: unknown days are on neither side; too few days says nothing; water's threshold is the owner's own", () => {
  const r = rand(5);
  // Food known on only 10 days: no food factor can be paired.
  const d = days(60, (_date, i) => ({ sleep: Math.round(440 + noise(r, 30)), ...(i < 10 ? { drinks: i % 2, caffeine_late_mg: i % 2 ? 95 : 0 } : {}) }));
  const found = findPatterns(d, { today: TODAY, window: 90 });
  assert.ok(!found.some((x) => x.factor === "drinks" || x.factor === "caffeine_late"));
  assert.equal(patternWords({ factor_kind: "water", outcome: "steps", lag: 1, diff: 1200, beat: 20, beat_without: 10, n_with: 30, n_without: 30, amount: 1800 }).line, "You walk 1,200 more steps the day after you drink 1.8 L of water or more");
  assert.equal(patternWords({ factor_kind: "late_meal", outcome: "deep", lag: 0, diff: -14, beat: 20, beat_without: 10, n_with: 25, n_without: 40 }).line, "You get 14 min less deep sleep on days you eat after 8pm");
});

const weekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

test("commute: a long commute and a shorter night, said plainly; weekends on neither side", () => {
  const r = rand(41);
  const long = new Set<string>();
  const d = days(120, (date, i) => {
    const off = weekend(date);
    if (!off && (i % 3 === 0 || i % 7 === 4)) long.add(date);
    return {
      commute_minutes: off ? 0 : long.has(date) ? Math.round(95 + noise(r, 8)) : Math.round(40 + noise(r, 6)),
      steps: Math.round(8000 + noise(r, 1500)),
      mood: Math.min(5, Math.max(1, Math.round(3.5 + noise(r, 0.7)))),
    };
  });
  // Weekends sleep longer, a long commute's night shorter: the night after belongs to the next morning.
  for (const day of d) {
    const eve = addDays(day.date, -1);
    day.sleep = Math.round(430 + noise(r, 20) + (weekend(eve) ? 40 : 0) - (long.has(eve) ? 25 : 0));
  }
  const found = findPatterns(d, { today: TODAY, window: 90, max: 20 });
  const ids = found.map((x) => x.id);
  const p = found.find((x) => x.id === "commute|sleep|0");
  assert.ok(p, ids.join(", "));
  assert.match(p.line, /^You sleep (20|25|30) min less on days with 1h 30m or more of commuting$/);
  assert.match(p.evidence, /^Shorter than usual on \d+ of \d+ days with 1h 30m or more of commuting$/);
  assert.ok(p.dates.every((x) => long.has(x)));
  // The other side is weekdays only, so weekend lie-ins don't make it look bigger.
  assert.ok(p.n_with + p.n_without <= 66, `${p.n_with} + ${p.n_without}`);
  assert.deepEqual(patternLabels(p), { factor: "Long commutes", with: "Long-commute days", without: "Other weekdays" });
  // Only the spec's pairings: steps, mood and that night's sleep; never deep sleep, resting HR or the day after.
  assert.ok(!found.some((x) => x.factor === "commute" && (!["sleep", "steps", "mood"].includes(x.outcome) || x.lag)));
  for (const x of found) assert.doesNotMatch(x.line, /\b(should|try|because|causes?|leads? to)\b/i);
});

test("podcasts and listening: more podcasts, better mood; music and podcasts together; the words", () => {
  const r = rand(53);
  const lots = new Set<string>();
  const d = days(120, (date, i) => {
    if (i % 3 === 1 || i % 5 === 0) lots.add(date);
    return {
      podcast_minutes: lots.has(date) ? Math.round(75 + noise(r, 10)) : i % 2 ? 0 : 20,
      mood: Math.min(5, Math.max(1, Math.round(3 + noise(r, 0.6) + (lots.has(date) ? 1 : 0)))),
      sleep: Math.round(440 + noise(r, 25)),
    };
  });
  const found = findPatterns(d, { today: TODAY, window: 90 });
  const p = found.find((x) => x.id === "podcasts|mood|0");
  assert.ok(p, found.map((x) => x.id).join(", "));
  assert.equal(p.line, "Your mood is better on days with an hour or more of podcasts");
  assert.match(p.evidence, /^Good or Great on \d+ of \d+ days with an hour or more of podcasts$/);
  assert.ok(!found.some((x) => x.factor === "podcasts" && x.outcome !== "mood"));
  assert.equal(patternWords({ factor_kind: "listening", outcome: "mood", lag: 0, diff: -0.6, beat: 9, beat_without: 4, n_with: 14, n_without: 60, amount: 120 }).line, "Your mood is lower on days with 2 hours or more of listening");
  assert.equal(patternWords({ factor_kind: "podcasts", outcome: "mood", lag: 0, diff: 0.5, beat: 9, beat_without: 4, n_with: 14, n_without: 60, amount: 30 }).line, "Your mood is better on days with 30 min or more of podcasts");
  assert.equal(patternWords({ factor_kind: "commute", outcome: "steps", lag: 0, diff: -1400, beat: 9, beat_without: 4, n_with: 14, n_without: 40, amount: 60 }).line, "You walk 1,400 fewer steps on days with an hour or more of commuting");
});

test("commute, podcasts and listening: noise is rejected; too few known days say nothing; unknown days on neither side", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = rand(seed * 389);
    const d = days(365, (date) => ({
      sleep: Math.round(440 + noise(r, 45)),
      mood: 1 + Math.floor(r() * 5),
      steps: Math.round(8500 + noise(r, 3000)),
      commute_minutes: weekend(date) || r() < 0.2 ? 0 : Math.round(30 + r() * 80),
      podcast_minutes: r() < 0.4 ? Math.round(r() * 120) : 0,
      listen_minutes: Math.round(r() * 240),
    }));
    for (const window of [30, 90, 365] as const) {
      const found = findPatterns(d, { today: TODAY, window });
      assert.deepEqual(found.map((x) => x.id), [], `seed ${seed}, ${window} days`);
    }
  }
  // TfL history covers only 15 days: under MIN_KNOWN, so no commute factor at all, however big the gap.
  const r = rand(7);
  const short = days(90, (date, i) => ({ sleep: 440, ...(i >= 75 && !weekend(date) ? { commute_minutes: i % 2 ? 100 : 30 } : {}) }));
  for (const day of short) if ((short.find((x) => x.date === addDays(day.date, -1))?.commute_minutes ?? 0) > 60) day.sleep = Math.round(380 + noise(r, 5));
  assert.ok(!findPatterns(short, { today: TODAY, window: 90 }).some((x) => x.factor === "commute"));
});

test("an evening at home pairs with that same night's sleep, not the night before", () => {
  const r = rand(61);
  const home = new Set<string>();
  const d = days(120, (date, i) => {
    if (i % 3 === 0 || i % 7 === 2) home.add(date);
    return { home_evening: home.has(date) ? 0.6 + r() * 0.2 : 0.2 + r() * 0.2 };
  });
  // The night after an evening in is longer: it ends the next morning.
  for (const day of d) day.sleep = Math.round(430 + noise(r, 20) + (home.has(addDays(day.date, -1)) ? 35 : 0));
  const p = findPatterns(d, { today: TODAY, window: 90 }).find((x) => x.id === "home_evening|sleep|0");
  assert.ok(p, "expected the evenings-at-home pattern");
  assert.ok(p.diff > 25 && p.diff < 45, `diff ${p.diff}`);
  assert.match(p.line, /longer on evenings at home$/);
});
