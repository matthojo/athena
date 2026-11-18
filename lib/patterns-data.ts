/**
 * Patterns from the owner's real days: opens the sealed health, places, mood
 * and calendar for the last year, in the Function, and hands them to the
 * pure engine (lib/patterns.ts).
 *
 * Nothing here is stored or logged. The opened days are kept in this
 * Function's memory for a few minutes (so the Days, Health and Ask calls
 * that follow one another don't open the same year again), never in a
 * table. No migration: there's no cache table to seal.
 */
import { ownMissedDays } from "./own-habits";
import { addDays, zonedParts, zonedToday } from "./dates";
import { getOwnerTimeZone, q, qRaw } from "./db";
import { daysRange, ownerToday } from "./days";
import { healthDays, valenceMood, workoutKind } from "./health";
import { placeDays } from "./places-visits";
import { eatingOut, eveningShare, loadMoneyPrefs, readHomeDays, readMoneyDays } from "./money";
import { digestOf, findPatterns, type Outcome, type Pattern, type PatternDay, type PatternWindow, type WeeklyDigest } from "./patterns";

export * from "./patterns";

/** How far back the engine ever reads: the longest window and one day for "the night after". */
const SPAN = 366;
const TTL_MS = 5 * 60_000;
let cache: { key: string; at: number; days: Promise<PatternDay[]> } | null = null;

/** Forget the opened days (tests, and after a write that should show at once). */
export function forgetPatternDays(): void {
  cache = null;
}

/** Every day in [from, to] as the engine reads it. */
export async function loadPatternDays(from: string, to: string, tz: string): Promise<PatternDay[]> {
  // Money and home only when the owner turned them on (Settings → Days): sealed and personal, they stay out of patterns otherwise.
  const prefs = await loadMoneyPrefs();
  const [health, range, places, events, habits, money, home, timed] = await Promise.all([
    // Health and mood refuse without the key (DataBoxError): the route says so, rather than showing no patterns.
    healthDays(from, to),
    daysRange(from, to, { tz }),
    placeDays(from, to).catch(() => null),
    // Meetings: timed events with someone else on them (an edge to a person; owner, 7 Nov), when each starts, in the owner's zone. Solo appointments don't count. Titles stay sealed and unread.
    qRaw<{ starts_at: string }>(
      `SELECT ev.starts_at FROM events ev WHERE ev.archived_at IS NULL AND ev.starts_at >= $1::timestamptz AND ev.starts_at < $2::timestamptz
         AND EXISTS (SELECT 1 FROM edges e WHERE e.source_type = 'event' AND e.source_id = ev.id AND e.target_type = 'person')`,
      [
      new Date(Date.parse(`${addDays(from, -1)}T00:00:00Z`)).toISOString(),
      new Date(Date.parse(`${addDays(to, 2)}T00:00:00Z`)).toISOString(),
    ]).catch(() => [] as Array<{ starts_at: string }>),
    // Entry titles are sealed at rest; q() opens them.
    q<{ date: string; title: string; done: boolean }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, title, count > 0 AS done FROM day_entries
       WHERE kind = 'habit' AND date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL`,
      [from, to],
    )
      // An Athena habit's unticked due day is "not done", not "nothing logged" (lib/own-habits.ts, owner 8 Nov).
      .then(async (rows) => [...rows, ...(await ownMissedDays(from, to, await ownerToday()).catch(() => [])).map((m) => ({ ...m, done: false }))])
      .catch(() => [] as Array<{ date: string; title: string; done: boolean }>),
    prefs.money ? readMoneyDays(from, to).catch(() => null) : null,
    prefs.home ? readHomeDays(from, to).catch(() => null) : null,
    // Commute (TfL journeys) and listening (Overcast podcasts, music): minutes per day and source; titles and groups are sealed and stay unread (a TfL entry is always the commute group).
    qRaw<{ date: string; source: string; commute: boolean; minutes: number | null; gaps: boolean }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, source, kind = 'other' AS commute, sum(minutes)::int AS minutes, bool_or(minutes IS NULL) AS gaps FROM day_entries
       WHERE date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL AND source <> 'places'
         AND ((kind = 'other' AND source = 'tfl') OR kind = 'listened')
       GROUP BY 1, 2, 3`,
      [from, to],
    ).catch(() => [] as Array<{ date: string; source: string; commute: boolean; minutes: number | null; gaps: boolean }>),
  ]);
  const out = new Map<string, PatternDay>();
  for (let d = from; d <= to; d = addDays(d, 1)) out.set(d, { date: d });

  /** State of Mind's mood on Athena's 1–5, for days the owner left without one (theirs always wins). */
  const healthMood = new Map<string, number>();
  for (const h of health.days) {
    const day = out.get(h.date);
    if (!day) continue;
    if (h.sleep_minutes) day.sleep = h.sleep_minutes;
    if (h.sleep_stages?.deep) day.deep = h.sleep_stages.deep;
    if (h.steps) day.steps = h.steps;
    if (h.resting_hr) day.resting_hr = h.resting_hr;
    day.workouts = (h.workouts ?? []).map((w) => ({ kind: workoutKind(w.type), minutes: w.minutes, ...(w.distance_m ? { distance_m: w.distance_m } : {}) }));
    // Food and drink: a day that sent any of it counts what it didn't send as none (no drinks, no late caffeine).
    const fed = h.kcal !== undefined || h.caffeine_mg !== undefined || h.water_ml !== undefined || h.alcohol_drinks !== undefined;
    if (fed) day.drinks = h.alcohol_drinks ?? 0;
    if (h.caffeine_mg !== undefined) day.caffeine_late_mg = h.caffeine_after_14_mg ?? 0;
    if (h.last_meal) day.last_meal = Number(h.last_meal.slice(0, 2)) + Number(h.last_meal.slice(3, 5)) / 60;
    if (h.water_ml !== undefined) day.water_ml = h.water_ml;
    if (h.mindful_minutes !== undefined) day.mindful_minutes = h.mindful_minutes;
    if (h.mood_valence !== undefined) healthMood.set(h.date, valenceMood(h.mood_valence));
  }
  // Mindful minutes, once any have come in: a day with health but none had none.
  if (health.days.some((h) => h.mindful_minutes)) {
    for (const h of health.days) {
      const day = out.get(h.date);
      if (day && day.mindful_minutes === undefined) day.mindful_minutes = 0;
    }
  }

  const watching = range.days.some((s) => s.counts.minutes.watched);
  if (watching) for (const day of out.values()) day.watch_minutes = 0;
  for (const s of range.days) {
    const day = out.get(s.date);
    if (!day) continue;
    if (s.mood) day.mood = s.mood;
    if (watching) day.watch_minutes = s.counts.minutes.watched ?? 0;
  }
  for (const [date, mood] of healthMood) {
    const day = out.get(date);
    if (day && day.mood === undefined) day.mood = mood;
  }

  for (const [date, p] of places ?? []) {
    const day = out.get(date);
    if (day) day.places = [...new Set(p.places.map((x) => x.name))];
  }

  if (events.length) {
    for (const day of out.values()) day.meetings = [];
    for (const e of events) {
      const parts = zonedParts(new Date(e.starts_at), tz);
      const day = out.get(parts.date);
      if (day) day.meetings!.push(parts.hour + parts.minute / 60);
    }
  }
  // A habit twice on one day (two sources): done wins.
  for (const h of habits) {
    const day = out.get(h.date);
    if (day) (day.habits ??= {})[h.title] = (day.habits[h.title] ?? false) || h.done;
  }
  // Money: a day with no spending is known (0) only once the bank's history covers it.
  if (money?.days.size) {
    const first = [...money.days.keys()].sort()[0];
    for (const day of out.values()) if (day.date >= first) day.eating_out = eatingOut(money.days.get(day.date));
  }
  for (const [date, d] of home?.days ?? []) {
    const day = out.get(date);
    if (day && (d.kwh ?? 0) > 0) day.home_evening = eveningShare(d);
  }
  // Commute and podcasts are known from their first day to their last (0 between); a day with a journey or episode of unknown length stays unknown.
  const span = (rows: typeof timed, set: (day: PatternDay, minutes: number | undefined) => void) => {
    if (!rows.length) return;
    const by = new Map<string, { minutes: number; gaps: boolean }>();
    for (const r of rows) {
      const was = by.get(r.date) ?? { minutes: 0, gaps: false };
      by.set(r.date, { minutes: was.minutes + (r.minutes ?? 0), gaps: was.gaps || r.gaps });
    }
    const dates = [...by.keys()].sort();
    for (const day of out.values()) {
      if (day.date < dates[0] || day.date > dates.at(-1)!) continue;
      const v = by.get(day.date);
      set(day, v?.gaps ? undefined : (v?.minutes ?? 0));
    }
  };
  span(timed.filter((r) => r.commute), (day, m) => (day.commute_minutes = m));
  const listened = timed.filter((r) => !r.commute);
  span(listened.filter((r) => r.source === "overcast"), (day, m) => (day.podcast_minutes = m));
  // Listening (music and podcasts) only once music minutes have come in: otherwise it's the podcasts again.
  if (listened.some((r) => r.source !== "overcast" && (r.minutes ?? 0) > 0)) span(listened, (day, m) => (day.listen_minutes = m));
  return [...out.values()];
}

async function yearOfDays(now: Date): Promise<{ today: string; tz: string; days: PatternDay[] }> {
  const tz = await getOwnerTimeZone();
  const today = zonedToday(now, tz);
  const key = `${tz}|${today}`;
  if (!cache || cache.key !== key || Date.now() - cache.at > TTL_MS) {
    const days = loadPatternDays(addDays(today, -SPAN), today, tz);
    cache = { key, at: Date.now(), days };
    days.catch(() => {
      if (cache?.days === days) cache = null;
    });
  }
  return { today, tz, days: await cache.days };
}

export interface PatternsReply {
  window: number;
  from: string;
  to: string;
  patterns: Pattern[];
}

/** The owner's patterns over the last `window` days (30, 90 or 365). */
export async function getPatterns(opts: { window?: PatternWindow; outcomes?: Outcome[]; places?: boolean; max?: number; now?: Date } = {}): Promise<PatternsReply> {
  const window = opts.window ?? 90;
  const { today, days } = await yearOfDays(opts.now ?? new Date());
  const patterns = findPatterns(days, { today, window, outcomes: opts.outcomes, places: opts.places, max: opts.max });
  return { window, from: addDays(today, -(window - 1)), to: today, patterns };
}

/**
 * This week's top new or changed patterns against a week ago, over the last
 * 90 days: what a weekly nudge can say. Nothing is sent from here.
 */
export async function getWeeklyDigest(opts: { now?: Date; window?: PatternWindow } = {}): Promise<WeeklyDigest> {
  const window = opts.window ?? 90;
  const { today, days } = await yearOfDays(opts.now ?? new Date());
  const now = findPatterns(days, { today, window });
  const before = findPatterns(days, { today: addDays(today, -7), window });
  return digestOf(now, before, today, window);
}
