/**
 * The week's dinners (Recipes, migration 0053): a suggested plan from the
 * owner's recipes around their calendar, by plain scoring, never a model.
 *
 *  - An evening with something late on (an event between 17:30 and 21:00)
 *    or travel gets a quick recipe (30 minutes or less).
 *  - A free evening gets something longer, or a batch cook.
 *  - Nothing cooked in the last 7 days, and nothing twice in one week.
 *  - A day away on a trip gets no dinner.
 *
 * Pure and shared with the app. Ties break on a hash of the recipe and the
 * week, so the same week always gets the same plan and next week's differs.
 */
import { addDays, zonedParts } from "./dates";
import { QUICK_MINUTES } from "./recipe-rules";

export type EveningKind = "free" | "late" | "travel" | "away" | "normal";

export interface Evening {
  date: string;
  kind: EveningKind;
  /** Why, in a few words: "Book club at 19:00", "Train home", "In Lisbon". */
  why: string | null;
}

export interface PlanRecipe {
  id: string;
  title: string;
  minutes: number | null;
  tags: string[];
  /** YYYY-MM-DD, newest first. */
  cooked: string[];
}

export interface PlanPick {
  date: string;
  recipe_id: string | null;
  /** In words: "Quick: Book club at 19:00", "Free evening: time for something slow". */
  reason: string;
}

/** A busy time (ms since the epoch), as lib/availability.ts gives them. */
export interface BusyTime {
  start: number;
  end: number;
  kind: "event" | "travel" | string;
  title?: string | null;
}

const EVENING_START = 17 * 60 + 30;
const EVENING_END = 21 * 60;
/** The whole evening for "free": nothing from 17:00 to 22:00. */
const FREE_FROM = 17 * 60;
const FREE_TO = 22 * 60;

const BATCH = /\b(batch|make[- ]ahead|freezer|freezable|slow[- ]cook(?:er)?|meal prep|stew|braise|roast)\b/i;

/** Minutes past local midnight on `date`, clipped to that day. */
function localSpan(b: BusyTime, date: string, tz: string): [number, number] | null {
  const s = zonedParts(new Date(b.start), tz);
  const e = zonedParts(new Date(b.end - 1), tz);
  if (e.date < date || s.date > date) return null;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return [s.date < date ? 0 : mins(s.time), e.date > date ? 24 * 60 : mins(e.time) + 1];
}

/**
 * Each evening of the week: away (a trip day with no travel), travel (a
 * flight or train that day), late (something on in the evening), free
 * (nothing from 17:00 to 22:00) or normal.
 */
export function classifyEvenings(dates: string[], busy: BusyTime[], travelDays: string[], awayDays: string[], tz: string): Evening[] {
  return dates.map((date) => {
    if (travelDays.includes(date)) {
      const leg = busy.find((b) => b.kind === "travel" && localSpan(b, date, tz));
      return { date, kind: "travel", why: leg?.title ?? "Travelling" };
    }
    if (awayDays.includes(date)) return { date, kind: "away", why: "Away" };
    const spans = busy.map((b) => ({ b, span: localSpan(b, date, tz) })).filter((x): x is { b: BusyTime; span: [number, number] } => !!x.span);
    const late = spans.find(({ span }) => span[1] > EVENING_START && span[0] < EVENING_END);
    if (late) {
      const at = Math.max(late.span[0], 0);
      const hhmm = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
      return { date, kind: late.b.kind === "travel" ? "travel" : "late", why: late.b.title ? `${late.b.title} at ${hhmm}` : `Busy from ${hhmm}` };
    }
    const free = !spans.some(({ span }) => span[1] > FREE_FROM && span[0] < FREE_TO);
    return { date, kind: free ? "free" : "normal", why: null };
  });
}

/** How well one recipe suits one evening. Higher is better; below zero it shouldn't be picked. */
export function scoreRecipe(r: PlanRecipe, evening: Evening, opts: { usedThisWeek?: Set<string> } = {}): number {
  if (evening.kind === "away") return -Infinity;
  let score = 0;
  const m = r.minutes;
  const quick = m !== null && m <= QUICK_MINUTES;
  const batch = BATCH.test(r.tags.join(" ")) || BATCH.test(r.title);
  if (evening.kind === "late" || evening.kind === "travel") {
    if (quick) score += 10;
    else if (m === null) score -= 4;
    else if (m <= 45) score -= 2;
    else score -= 12;
  } else if (evening.kind === "free") {
    if (batch) score += 8;
    if (m !== null && m > 60) score += 6;
    else if (m !== null && m > QUICK_MINUTES) score += 3;
  } else {
    if (m !== null && m <= 60) score += 3;
    if (m !== null && m > 90) score -= 3;
  }
  // Not again so soon: anything cooked in the 7 days before this evening is out; the week before that, a little down.
  const last = r.cooked.find((d) => d < evening.date) ?? null;
  if (last) {
    const days = Math.round((Date.parse(`${evening.date}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 86_400_000);
    if (days <= 7) score -= 30;
    else if (days <= 14) score -= 3;
    else score += 1;
  } else score += 1;
  if (opts.usedThisWeek?.has(r.id)) score -= 40;
  return score;
}

/** A small stable hash: the tie-break that makes a week's plan the same each time it's asked for. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function reasonFor(evening: Evening, r: PlanRecipe | null): string {
  if (!r) return evening.kind === "away" ? `${evening.why ?? "Away"}: no dinner planned` : "Nothing fits: pick one";
  if (evening.kind === "late" || evening.kind === "travel") return r.minutes !== null && r.minutes <= QUICK_MINUTES ? `Quick: ${evening.why ?? "busy evening"}` : `Busy evening: ${evening.why ?? "nothing quick left"}`;
  if (evening.kind === "free") return BATCH.test(r.tags.join(" ")) || BATCH.test(r.title) ? "Free evening: batch cook" : r.minutes && r.minutes > 60 ? "Free evening: time for something slow" : "Free evening";
  return "Ordinary evening";
}

/**
 * The plan: hardest evenings first (late and travel need quick recipes, and
 * there are fewer of those), each taking its best recipe not already used.
 * `keep` holds days the owner already chose; they aren't changed and their
 * recipes count as used.
 */
export function suggestPlan(evenings: Evening[], recipes: PlanRecipe[], opts: { weekStart: string; keep?: Record<string, string | null> } = { weekStart: "" }): PlanPick[] {
  const keep = opts.keep ?? {};
  const used = new Set(Object.values(keep).filter((v): v is string => !!v));
  const order = [...evenings].sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date));
  const picks = new Map<string, PlanPick>();
  for (const e of order) {
    if (e.date in keep) {
      const r = recipes.find((x) => x.id === keep[e.date]) ?? null;
      picks.set(e.date, { date: e.date, recipe_id: keep[e.date] ?? null, reason: r ? "Your pick" : reasonFor(e, null) });
      continue;
    }
    if (e.kind === "away") {
      picks.set(e.date, { date: e.date, recipe_id: null, reason: reasonFor(e, null) });
      continue;
    }
    let best: { r: PlanRecipe; score: number; tie: number } | null = null;
    for (const r of recipes) {
      const score = scoreRecipe(r, e, { usedThisWeek: used });
      const tie = hash(`${r.id}\u0000${opts.weekStart}`);
      if (!best || score > best.score || (score === best.score && tie < best.tie)) best = { r, score, tie };
    }
    const pick = best && best.score > -20 ? best.r : null;
    if (pick) used.add(pick.id);
    picks.set(e.date, { date: e.date, recipe_id: pick?.id ?? null, reason: reasonFor(e, pick) });
  }
  return evenings.map((e) => picks.get(e.date)!);
}

const rank = (e: Evening) => ({ travel: 0, late: 1, free: 2, normal: 3, away: 4 })[e.kind];

/** The seven dates from a Monday. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
