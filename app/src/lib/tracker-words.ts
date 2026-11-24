/**
 * Tracking, in words (lib/tracker-types.ts is the contract). Pure: no DOM,
 * no network, so the panel, Saved's cards, an assistant's page and the
 * sample fake all say the same thing about the same checks.
 *
 * Words first. Every tracker reads as one sentence before any picture:
 * "£34 at Smyths. You asked to hear at £30 or less." / "In stock at John
 * Lewis since Tuesday." Under it, a quieter line of where it started and how
 * many checks there are.
 *
 * Neutral language: only the price preset says "price", "saved price" or
 * "shop". A tracker the owner described is "it", its own label, and "since
 * you started".
 *
 * Honest numbers: a value is the page's own digits, never rounded or
 * converted. Sums and differences are done on whole units (no floating point)
 * at the tracker's own number of decimal places.
 */
import { TRACKER_LIMITS, type Tracker, type TrackerChecker, type TrackerDirection, type TrackerKind, type TrackerPoint, type TrackerSummary, type TrackerTarget, type TrackerView } from "../../../lib/tracker-types";
import { clockTime, uses12Hour } from "./clock";

const DAY_MS = 86_400_000;

// ---------- values ----------

const SYMBOL: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", AUD: "A$", CAD: "C$", NZD: "NZ$" };

/** How a currency is written: "£" before, or " SEK" after. */
export function currencyAffix(currency: string): { prefix: string; suffix: string } {
  const sym = SYMBOL[currency.toUpperCase()];
  return sym ? { prefix: sym, suffix: "" } : { prefix: "", suffix: ` ${currency.toUpperCase()}` };
}

type Written = Pick<Tracker, "kind" | "prefix" | "suffix" | "currency">;

/** Is this a number as a page writes it: "34", "34.99", "1,299", "-2.5"? */
export function isNumberText(raw: string): boolean {
  const s = raw.trim();
  return /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^-?\d{1,12}(\.\d{1,6})?$/.test(s);
}

/** The digits alone: thousands commas dropped, leading zeros trimmed. Throws for anything that isn't a plain number. */
export function cleanNumber(raw: string): string {
  const s = raw.trim().replace(/^−/, "-");
  if (!isNumberText(s)) throw new Error("value: a number as the page shows it, like 34.99");
  const neg = s.startsWith("-");
  const digits = s.replace(/^-/, "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
  return `${neg && /[1-9]/.test(digits) ? "-" : ""}${digits}`;
}

const decimals = (v: string) => (v.split(".")[1] ?? "").length;

/** A value as whole units at `scale` decimal places: "34.5" at 2 is 3450. Exact. */
export function toUnits(v: string, scale: number): number {
  const s = v.replace(/,/g, "").trim();
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace(/^-/, "").split(".");
  const n = Number(whole || "0") * 10 ** scale + Number((frac + "0".repeat(scale)).slice(0, scale) || "0");
  return neg ? -n : n;
}

/** The scale a tracker's numbers share: the most decimal places any of them was written with (a price is always 2). */
export function scaleOf(t: Pick<Tracker, "currency">, values: string[]): number {
  return Math.min(6, Math.max(t.currency ? 2 : 0, ...values.map(decimals)));
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A value as the owner reads it: "£34", "£34.50" (the page's "34.5"),
 * "24.86p/kWh", "1,204 followers", "in stock". The same digits the page gave.
 */
export function valueWords(t: Written, v: string): string {
  if (t.kind === "state") return v;
  const s = v.trim();
  const neg = s.startsWith("-");
  const [whole, frac] = s.replace(/^-/, "").replace(/,/g, "").split(".");
  const tail = frac === undefined ? "" : `.${t.currency ? frac.padEnd(2, "0") : frac}`;
  return `${neg ? "−" : ""}${t.prefix}${group(whole)}${tail}${t.suffix}`;
}

/** Whole units back to a value: 450 at 2 → "4.50" for money, "4.5" otherwise. */
function unitsText(units: number, scale: number, money: boolean): string {
  const neg = units < 0;
  const abs = Math.abs(units);
  const whole = Math.floor(abs / 10 ** scale);
  let frac = scale ? String(abs % 10 ** scale).padStart(scale, "0") : "";
  frac = money ? (/^0+$/.test(frac) ? "" : frac) : frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** A difference as a value: 800 at 2 → "£8". Always positive: the words say which way. */
export function diffWords(t: Written, units: number, scale: number): string {
  return valueWords(t, unitsText(Math.abs(units), scale, !!t.currency));
}

// ---------- days ----------

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysBetween = (iso: string, now: Date) => Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY_MS);

/** "3 Nov", or "3 Nov 2025" in another year. */
export function shortDay(iso: string, now = new Date()): string {
  const t = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(t.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }).format(t);
}

/** "today", "yesterday", "Tuesday", "3 Nov": for "since …". */
export function sinceWords(iso: string, now = new Date(), hour12 = uses12Hour()): string {
  const days = daysBetween(iso, now);
  if (days <= 0) return clockTime(iso, { hour12 });
  if (days === 1) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(Date.parse(iso));
  return shortDay(iso, now);
}

/** "today", "yesterday", "on Tuesday", "on 3 Nov": for "checked …". */
export function onDayWords(iso: string, now = new Date()): string {
  const days = daysBetween(iso, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `on ${days < 7 ? new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(Date.parse(iso)) : shortDay(iso, now)}`;
}

/** "Today", "Yesterday", "Tue 11 Nov", "3 Oct": a row in the list of checks. */
export function rowDay(iso: string, now = new Date()): string {
  const days = daysBetween(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(Date.parse(iso));
  return shortDay(iso, now);
}

/** "42 minutes ago", "3 hours ago", else "today", "yesterday", "on Tuesday". */
export function agoWords(iso: string, now = new Date(), short = false): string {
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  const hours = Math.round(mins / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return short ? `${mins} min ago` : `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  if (mins < 6 * 60) return short ? `${hours} hr ago` : `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return onDayWords(iso, now);
}

// ---------- words about a tracker ----------

export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "smyths.co.uk" from a link. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
}

/** Where a check was read: the site's own name, else its host. Null when neither is known. */
export const sourceOf = (p: Pick<TrackerPoint, "source" | "url">): string | null => p.source?.trim() || hostOf(p.url);

/** Who checked: "When you saved it", "You", "Ask", "Moss". */
export function checkerWords(p: Pick<TrackerPoint, "checked_by" | "who">): string {
  if (p.checked_by === "save") return "When you saved it";
  if (p.checked_by === "owner") return "You";
  if (p.checked_by === "ask") return "Ask";
  return p.who ?? "An assistant";
}

/** "Moss checked 42 minutes ago", "You checked yesterday". Null for the save itself. */
export function checkedLine(p: TrackerPoint, now = new Date()): string | null {
  if (p.checked_by === "save") return null;
  return `${p.checked_by === "owner" ? "You" : checkerWords(p)} checked ${agoWords(p.checked_at, now)}`;
}

/** What the tracker is called in a heading: "Price", "Stock", "Unit rate". */
export const labelWords = (t: Pick<Tracker, "label">) => cap(t.label);

const isPrice = (t: Pick<Tracker, "preset">) => t.preset === "price";
const isStock = (t: Pick<Tracker, "preset">) => t.preset === "stock";

// ---------- reading the checks ----------

export type TargetState = "none" | "set" | "reached";

/** Everything the words and the picture need, worked out once from the points. */
export interface TrackerRead {
  tracker: TrackerView;
  points: TrackerPoint[];
  first: TrackerPoint;
  latest: TrackerPoint;
  /** The check the sentence leads with: a price's best now across shops (each shop's latest within 14 days), else the latest. */
  now: TrackerPoint;
  /** The point kept when the item was saved. */
  saved: TrackerPoint | null;
  /** A number's best so far by its direction, and the last time it was seen. Null for a state or "change". */
  best: TrackerPoint | null;
  bestLast: TrackerPoint | null;
  /** The first check of the run the latest value belongs to: "since Tuesday". */
  runStart: TrackerPoint;
  /** The run before it, for "sold out before that". */
  before: { value: string; from: TrackerPoint } | null;
  scale: number;
  sources: number;
  target: TargetState;
}

const byTime = (a: TrackerPoint, b: TrackerPoint) => Date.parse(a.checked_at) - Date.parse(b.checked_at) || (a.checked_by === "save" ? -1 : b.checked_by === "save" ? 1 : 0);
const same = (t: Pick<Tracker, "kind">, a: string, b: string, scale: number) => (t.kind === "state" ? a.trim().toLowerCase() === b.trim().toLowerCase() : toUnits(a, scale) === toUnits(b, scale));

/** Does this value meet the target? A state: exactly that state. A number: at or under, at or over, or exactly. "change" is never "reached": it's news each time. */
export function meets(t: Pick<Tracker, "kind" | "currency">, target: Pick<TrackerTarget, "op" | "value"> | null, value: string, scale: number): boolean {
  if (!target || target.op === "change") return false;
  if (t.kind === "state") return target.op === "eq" && same(t, value, target.value, scale);
  if (!isNumberText(target.value) || !isNumberText(value)) return false;
  const v = toUnits(value, scale);
  const g = toUnits(target.value, scale);
  return target.op === "lte" ? v <= g : target.op === "gte" ? v >= g : v === g;
}

/** The server's summary, with what it adds after the contract (owner, 16 Nov 2026): the check that met the target. */
type ServerSummary = TrackerSummary & { reached_by?: TrackerPoint | null };

/**
 * Which check meets the target, if any (owner, 16 Nov 2026: "When any shop's current price meets it"). Each
 * source's latest check counts while it's within 14 days of the newest; of those that meet the target, the best
 * by the tracker's direction (or the newest). The server works this out (`summary.reached_by`); sample mode and
 * an older answer use this, the same rule.
 */
export function reachedBy(view: Pick<Tracker, "kind" | "currency" | "target" | "direction">, points: TrackerPoint[], scale: number): TrackerPoint | null {
  if (!view.target || view.target.op === "change" || !points.length) return null;
  const sorted = [...points].sort(byTime);
  const last = new Map<string, TrackerPoint>();
  for (const p of sorted) last.set((sourceOf(p) ?? "").toLowerCase(), p);
  const newest = Date.parse(sorted[sorted.length - 1].checked_at);
  const hits = [...last.values()].filter((p) => newest - Date.parse(p.checked_at) <= TRACKER_LIMITS.freshDays * DAY_MS && meets(view, view.target, p.value, scale));
  if (!hits.length) return null;
  const u = (p: TrackerPoint) => toUnits(p.value, scale);
  return hits.reduce((a, b) => {
    if (view.kind === "number" && view.direction !== "change" && u(a) !== u(b)) return (view.direction === "lower" ? u(b) < u(a) : u(b) > u(a)) ? b : a;
    return byTime(b, a) > 0 ? b : a;
  });
}

/** Read a tracker's points. Null with no checks yet. Pure. */
export function readTracker(view: TrackerView): TrackerRead | null {
  if (!view.points.length) return null;
  const points = [...view.points].sort(byTime);
  const first = points[0];
  const latest = points[points.length - 1];
  const scale = view.kind === "number" ? scaleOf(view, [...points.map((p) => p.value), ...(view.target?.value && isNumberText(view.target.value) ? [view.target.value] : [])]) : 0;
  const u = (p: TrackerPoint) => toUnits(p.value, scale);
  const saved = points.find((p) => p.checked_by === "save") ?? null;
  const keyOf = (p: TrackerPoint) => (sourceOf(p) ?? "").toLowerCase();
  const sources = new Set(points.map(keyOf)).size;

  // A price's best now: each shop's own latest check, among those close to the newest one. The server says
  // which check that is (summary.now); without it (an older answer), the same rule is worked out here.
  let now = (view.summary?.now && points.find((p) => p.id === view.summary!.now!.id)) || latest;
  if (!view.summary?.now && view.kind === "number" && isPrice(view) && sources > 1 && view.direction !== "change") {
    const last = new Map<string, TrackerPoint>();
    for (const p of points) last.set(keyOf(p), p);
    const newest = Date.parse(latest.checked_at);
    const current = [...last.values()].filter((p) => newest - Date.parse(p.checked_at) <= TRACKER_LIMITS.freshDays * DAY_MS);
    const better = (a: TrackerPoint, b: TrackerPoint) => (view.direction === "lower" ? u(b) < u(a) : u(b) > u(a)) || (u(b) === u(a) && byTime(b, a) > 0);
    now = current.reduce((a, b) => (better(a, b) ? b : a), latest);
  }

  let best: TrackerPoint | null = null;
  let bestLast: TrackerPoint | null = null;
  if (view.kind === "number" && view.direction !== "change") {
    const pick = view.direction === "lower" ? Math.min : Math.max;
    const top = pick(...points.map(u));
    const at = points.filter((p) => u(p) === top);
    best = at[0];
    bestLast = at[at.length - 1];
  }

  // The run the latest value belongs to, and the one before it.
  let i = points.length - 1;
  while (i > 0 && same(view, points[i - 1].value, latest.value, scale)) i--;
  const runStart = points[i];
  let before: TrackerRead["before"] = null;
  if (i > 0) {
    const prev = points[i - 1];
    let j = i - 1;
    while (j > 0 && same(view, points[j - 1].value, prev.value, scale)) j--;
    before = { value: prev.value, from: points[j] };
  }

  // Reached: the server's word when it gave one, else the same rule here. The sentence then leads with the check that met it.
  const server = view.summary as ServerSummary | null;
  const hit = server && typeof server.target_reached === "boolean" ? (server.target_reached ? (server.reached_by && points.find((p) => p.id === server.reached_by!.id)) || reachedBy(view, points, scale) || now : null) : reachedBy(view, points, scale);
  const target: TargetState = !view.target ? "none" : hit ? "reached" : "set";
  if (hit) now = hit;
  return { tracker: view, points, first, latest, now, saved, best, bestLast, runStart, before, scale, sources, target };
}

/** The summary the server sends, worked out the same way: the sample fake uses it. */
export function summaryOf(view: TrackerView, now = new Date()): ServerSummary | null {
  const r = readTracker({ ...view, summary: null });
  if (!r) return null;
  const changed = r.runStart === r.first ? null : r.runStart.checked_at;
  return {
    first: r.first,
    latest: r.latest,
    best: r.best,
    changed_at: changed,
    target_reached: r.target === "reached",
    reached_by: r.target === "reached" ? r.now : null,
    fresh: now.getTime() - Date.parse(r.latest.checked_at) <= TRACKER_LIMITS.freshDays * DAY_MS,
    checks: r.points.length,
    sources: r.sources,
  };
}

// ---------- the sentence ----------

/** "£30 or less", "1,500 or more", "in stock", "any change": the target, short. */
export function targetWords(t: Written, target: Pick<TrackerTarget, "op" | "value">): string {
  if (target.op === "change") return "any change";
  if (t.kind === "state") return target.value;
  const v = valueWords(t, target.value);
  return target.op === "lte" ? `${v} or less` : target.op === "gte" ? `${v} or more` : `exactly ${v}`;
}

/**
 * The one sentence, said before any picture. `lead` is the value (and where,
 * when that matters) for the app to set apart; `lead + rest` is the sentence.
 *
 *  - "£34 at Smyths, the lowest since you saved it."
 *  - "£34 at Smyths. You asked to hear at £30 or less."
 *  - "£27 at John Lewis, under the £28 you asked for."
 *  - "In stock at John Lewis since Tuesday."
 *  - "24.86p/kWh, 0.24p lower than on 3 Oct. It was 22.86p/kWh on 14 Nov."
 */
export function trackerSentence(r: TrackerRead, now = new Date()): { lead: string; rest: string; text: string } {
  const t = r.tracker;
  const where = sourceOf(r.now);
  const showWhere = !!where && (isPrice(t) || isStock(t) || r.sources > 1);
  const lead = t.kind === "state" ? `${cap(r.now.value)}${showWhere ? ` at ${where}` : ""}` : `${valueWords(t, r.now.value)}${showWhere ? ` ${isPrice(t) || isStock(t) ? "at" : "on"} ${where}` : ""}`;
  const rest = t.kind === "state" ? stateRest(r, now) : numberRest(r, now);
  return { lead, rest, text: lead + rest };
}

function stateRest(r: TrackerRead, now: Date): string {
  const t = r.tracker;
  let rest: string;
  if (r.points.length === 1) rest = `, checked ${onDayWords(r.latest.checked_at, now)}.`;
  else if (r.runStart === r.first) rest = `, every check since ${shortDay(r.first.checked_at, now)}.`;
  else rest = ` since ${sinceWords(r.runStart.checked_at, now)}.`;
  if (!t.target) return rest;
  if (t.target.op === "change") return `${rest} You'll hear when it changes.`;
  return r.target === "reached" ? `${rest} You asked to hear when it was.` : `${rest} You asked to hear when it's ${t.target.value}.`;
}

function numberRest(r: TrackerRead, now: Date): string {
  const t = r.tracker;
  const price = isPrice(t);
  const u = (p: TrackerPoint) => toUnits(p.value, r.scale);
  // A target says first whether it's been reached.
  if (t.target && t.target.op !== "change") {
    const goal = valueWords(t, t.target.value);
    if (r.target === "set") return t.target.op === "lte" ? `. You asked to hear at ${goal} or less.` : t.target.op === "gte" ? `. You asked to hear at ${goal} or more.` : `. You asked to hear at exactly ${goal}.`;
    const exact = toUnits(t.target.value, r.scale) === u(r.now);
    return exact ? `, the ${goal} you asked for.` : t.target.op === "lte" ? `, under the ${goal} you asked for.` : `, over the ${goal} you asked for.`;
  }
  const tail = t.target?.op === "change" ? " You'll hear when it changes." : "";
  if (r.points.length === 1) return (r.saved ? (price ? ", the price when you saved it." : ", when you saved it.") : `, checked ${onDayWords(r.latest.checked_at, now)}.`) + tail;

  if (t.direction === "change") {
    if (r.before) {
      const d = u(r.latest) - toUnits(r.before.value, r.scale);
      return `, ${d < 0 ? "down" : "up"} ${diffWords(t, d, r.scale)} since ${sinceWords(r.runStart.checked_at, now)}.${tail}`;
    }
    return `, the same at every check since ${shortDay(r.first.checked_at, now)}.${tail}`;
  }

  const lower = t.direction === "lower";
  const word = lower ? "lowest" : "highest";
  const atBest = r.best !== null && u(r.now) === u(r.best);
  const ref = r.saved ?? r.first;
  const d = u(r.now) - u(ref);
  // The best so far, when it isn't where it started (that's said already).
  const bestWas = r.best && r.bestLast && u(r.best) !== u(ref) ? ` It was ${valueWords(t, r.best.value)} on ${shortDay(r.bestLast.checked_at, now)}.` : "";
  if (atBest) {
    if (d === 0) return `${r.saved ? ", the same as when you saved it." : `, the same at every check since ${shortDay(r.first.checked_at, now)}.`}${tail}`;
    return `, the ${word} ${r.saved ? "since you saved it" : "so far"}.${tail}`;
  }
  if (d === 0) return `, the same as ${r.saved ? "when you saved it" : `on ${shortDay(ref.checked_at, now)}`}.${bestWas}${tail}`;
  const more = d > 0;
  const by = diffWords(t, d, r.scale);
  if (price && r.saved) return `, ${by} ${more ? "more than when you saved it" : "under the saved price"}.${bestWas}${tail}`;
  if (r.saved) return `, ${by} ${more ? "higher" : "lower"} than when you saved it.${bestWas}${tail}`;
  return `, ${by} ${more ? "higher" : "lower"} than on ${shortDay(ref.checked_at, now)}.${bestWas}${tail}`;
}

/**
 * The quieter line under the sentence. "Lowest £32 on 10 Oct · Saved at £42
 * on 7 Oct · 12 checks at 4 shops", "Sold out from 3 Nov to 10 Nov ·
 * 6 checks". Null with one check.
 */
export function trackerDetail(r: TrackerRead, now = new Date()): string | null {
  if (r.points.length < 2) return null;
  const t = r.tracker;
  const parts: string[] = [];
  const checks = `${r.points.length} checks`;
  if (t.kind === "state") {
    if (r.before) {
      const from = shortDay(r.before.from.checked_at, now);
      const to = shortDay(r.runStart.checked_at, now);
      parts.push(from === to ? `${cap(r.before.value)} earlier on ${from}` : `${cap(r.before.value)} from ${from} to ${to}`);
    }
    parts.push(checks);
    return parts.join(" · ");
  }
  const u = (p: TrackerPoint) => toUnits(p.value, r.scale);
  // With a target, the sentence gives up the best so far: it goes here when it's better than now.
  if (t.target && t.target.op !== "change" && r.best && r.bestLast && u(r.best) !== u(r.now)) parts.push(`${t.direction === "lower" ? "Lowest" : "Highest"} ${valueWords(t, r.best.value)} on ${shortDay(r.bestLast.checked_at, now)}`);
  if (r.saved && u(r.saved) !== u(r.now)) parts.push(`Saved at ${valueWords(t, r.saved.value)} on ${shortDay(r.saved.checked_at, now)}`);
  else if (!r.saved) parts.push(`Started at ${valueWords(t, r.first.value)} on ${shortDay(r.first.checked_at, now)}`);
  parts.push(r.sources > 1 ? `${checks} ${isPrice(t) ? `at ${r.sources} shops` : `from ${r.sources} places`}` : checks);
  return parts.join(" · ");
}

/** A glance for a card or a row, in two parts: the value now, and a quieter note. "£34" / "Smyths", "In stock" / "since Tuesday", "24.86p/kWh" / "lowest so far". */
export function trackerGlanceParts(r: TrackerRead, now = new Date()): { value: string; note: string } {
  const t = r.tracker;
  const value = t.kind === "state" ? cap(r.now.value) : valueWords(t, r.now.value);
  const since = r.points.length === 1 ? `checked ${onDayWords(r.latest.checked_at, now)}` : r.runStart === r.first ? `since ${shortDay(r.first.checked_at, now)}` : `since ${sinceWords(r.runStart.checked_at, now)}`;
  if (t.kind === "state") return { value, note: since };
  if (r.target === "reached" && t.target) return { value, note: `at or ${t.target.op === "gte" ? "over" : "under"} your ${valueWords(t, t.target.value)}` };
  if (r.points.length === 1) return { value, note: since };
  if (r.best && toUnits(r.best.value, r.scale) === toUnits(r.now.value, r.scale) && toUnits(r.first.value, r.scale) !== toUnits(r.now.value, r.scale)) return { value, note: `${t.direction === "lower" ? "lowest" : "highest"} so far` };
  const where = sourceOf(r.now);
  if (isPrice(t) && where) return { value, note: where };
  // Otherwise, which way it last moved: "up 0.32p/kWh since Friday".
  if (r.before) {
    const d = toUnits(r.latest.value, r.scale) - toUnits(r.before.value, r.scale);
    return { value, note: `${d < 0 ? "down" : "up"} ${diffWords(t, d, r.scale)} ${since}` };
  }
  return { value, note: `the same ${since}` };
}

/** The same glance on one line: "£34 · Smyths", "In stock · since Tuesday". */
export function trackerGlance(r: TrackerRead, now = new Date()): string {
  const g = trackerGlanceParts(r, now);
  return `${g.value} · ${g.note}`;
}

/** What the picture draws for a number: one value per check, in time order. */
export function numberSeries(r: TrackerRead): Array<{ t: number; v: number; point: TrackerPoint; best: boolean }> {
  const top = r.best ? toUnits(r.best.value, r.scale) : null;
  return r.points.map((p) => ({ t: Date.parse(p.checked_at), v: toUnits(p.value, r.scale), point: p, best: top !== null && toUnits(p.value, r.scale) === top }));
}

/** What the picture draws for a state: each run of one state, from its first check to the next run (or now). */
export function stateRuns(r: TrackerRead, nowMs = Date.now()): Array<{ value: string; from: number; to: number; points: TrackerPoint[] }> {
  const runs: Array<{ value: string; from: number; to: number; points: TrackerPoint[] }> = [];
  for (const p of r.points) {
    const last = runs[runs.length - 1];
    if (last && same(r.tracker, last.value, p.value, 0)) last.points.push(p);
    else runs.push({ value: p.value, from: Date.parse(p.checked_at), to: 0, points: [p] });
  }
  runs.forEach((run, i) => (run.to = i + 1 < runs.length ? runs[i + 1].from : Math.max(nowMs, run.from + 1)));
  return runs;
}

// ---------- making one ----------

/** What "Track this" offers for a saved item: price when it has one, stock, and "Something else". */
export function presetsFor(item: { facts?: { price?: string; currency?: string } | null; thing?: string | null }, existing: Pick<Tracker, "preset">[]): Array<"price" | "stock"> {
  const has = new Set(existing.map((t) => t.preset));
  const out: Array<"price" | "stock"> = [];
  if (item.facts?.price && item.facts.currency && !has.has("price")) out.push("price");
  if ((item.thing === "product" || item.facts?.price) && !has.has("stock")) out.push("stock");
  return out;
}

/** A label as the contract keeps it: lower case, one line, at most 24 characters. Throws when empty. */
export function cleanLabel(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, TRACKER_LIMITS.label).trim();
  if (!s) throw new Error("label: what it is, like followers");
  return s;
}

/** States as the owner typed them: unique, short, at most six, the hoped-for one first. */
export function cleanStates(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    const v = s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, TRACKER_LIMITS.state).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length < 2) throw new Error("states: at least two, like in stock and sold out");
  return out.slice(0, TRACKER_LIMITS.states);
}

/** The text before or after a number, as typed: keeps one space if the owner typed one ("kWh" after "12" reads "12 kWh" only if they asked). */
export const cleanAffix = (raw: string): string => raw.replace(/\s+/g, " ").slice(0, TRACKER_LIMITS.affix);

/** The target to suggest first, from the direction: "at or under" for lower, "at or over" for higher. */
export const defaultOp = (kind: TrackerKind, direction: TrackerDirection): TrackerTarget["op"] => (kind === "state" ? "eq" : direction === "lower" ? "lte" : direction === "higher" ? "gte" : "change");

export type { TrackerChecker };

// ---------- who checks it ----------

/** The checker as the block needs it: its name, and whether it can check right now. */
export interface CheckerFacts {
  id: string;
  name: string;
  /** "Can look things up online". */
  web: boolean;
  paused: boolean;
  /** When its schedule next runs ("Friday at 17:00"), or null when that isn't knowable. */
  next: string | null;
}

/** Who checks a tracker, and why it can't when it can't. */
export type WhoState =
  | { kind: "assistant"; id: string; name: string; blocked: null | "web" | "paused" | "ask-web"; next: string | null }
  /** The owner chose "Just me". */
  | { kind: "owner" }
  /** Nobody chose, or the assistant it had has gone. */
  | { kind: "nobody" };

/**
 * Who checks it: its assistant (and whether it can check now), the owner's own "Just me", or nobody. `askWeb` is
 * "Let Ask search the web" (null until it's read: not blocked).
 */
export function whoState(t: Pick<Tracker, "assistant_id" | "assistant_set_by">, checker: CheckerFacts | null | undefined, askWeb: boolean | null): WhoState {
  if (t.assistant_id && checker && checker.id === t.assistant_id) {
    const blocked = checker.paused ? "paused" : !checker.web ? "web" : askWeb === false ? "ask-web" : null;
    return { kind: "assistant", id: checker.id, name: checker.name, blocked, next: blocked ? null : checker.next };
  }
  if (!t.assistant_id && t.assistant_set_by === "owner") return { kind: "owner" };
  return { kind: "nobody" };
}

/** "Moss checks this", "You check this", "Nobody is checking this yet". */
export function whoWords(s: WhoState): string {
  if (s.kind === "assistant") return `${s.name} checks this`;
  return s.kind === "owner" ? "You check this" : "Nobody is checking this yet";
}

/** When: the next check where her schedule says ("Next check Friday at 17:00"), else the last ("Checked 42 minutes ago"). */
export function whenWords(s: WhoState, latest: TrackerPoint | null, now = new Date()): string | null {
  if (s.kind === "assistant" && s.blocked) return null;
  if (s.kind === "assistant" && s.next) return `Next check ${s.next}`;
  if (!latest || latest.checked_by === "save") return null;
  const mine = (s.kind === "assistant" && latest.checked_by === "assistant" && latest.assistant_id === s.id) || (s.kind === "owner" && latest.checked_by === "owner");
  return mine ? `Checked ${agoWords(latest.checked_at, now)}` : checkedLine(latest, now);
}

/** Why its checker can't check it, in one line, and the one tap that fixes it. Null when it can. */
export function cantWords(s: WhoState): { line: string; fix: string } | null {
  if (s.kind !== "assistant" || !s.blocked) return null;
  if (s.blocked === "paused") return { line: `${s.name} is paused, so nothing is checking this.`, fix: "Resume" };
  if (s.blocked === "web") return { line: `${s.name} can't look things up online, so nothing is checking this.`, fix: "Turn on" };
  return { line: "Web search is off for every assistant, so nothing is checking this.", fix: "Open Settings" };
}
