/**
 * Tracking: the pure rules (the contract is lib/tracker-types.ts). Shared by the server
 * (lib/trackers-store.ts, the routes, Ask's tools) and the app. No database, no network.
 *
 * A tracker follows one thing over time: a number with a label and a prefix or suffix ("£34", "12,400
 * followers"), or one of a short list of states ("in stock", "sold out"). It sits on a saved item or on its own,
 * and a thing can have several. A price is a preset (label "price", a currency, lower is better); so is stock (a
 * state). Every check is kept, the same value too.
 *
 * Honest values. A value is kept exactly as the page wrote it ("34.99", "12,400" as "12400"), never rounded,
 * estimated or converted, with the link of the page it was read on. A price tracker has one currency, and a check
 * in another is refused, so two currencies are never compared.
 */
import type { Tracker, TrackerChecker, TrackerDirection, TrackerInput, TrackerKind, TrackerNews, TrackerPoint, TrackerPreset, TrackerSummary, TrackerTarget, TrackerView } from "./tracker-types";
import { TRACKER_LIMITS } from "./tracker-types";

export type { Tracker, TrackerChecker, TrackerDirection, TrackerInput, TrackerKind, TrackerNews, TrackerPoint, TrackerPreset, TrackerSummary, TrackerTarget, TrackerView };
export { TRACKER_LIMITS };

export class TrackerInputError extends Error {}

export const TRACKER_CHECKERS = ["save", "owner", "ask", "assistant"] as const satisfies readonly TrackerChecker[];
export const TARGET_OPS = ["lte", "gte", "eq", "change"] as const;
export const MAX_URL_CHARS = 2_000;
/** A shop's or site's name is the page's own words: plain, one line, short. */
export const MAX_SOURCE_CHARS = 60;
export const MAX_NAME_CHARS = 80;
/** One tracker's points sent at once. The store keeps every one. */
export const MAX_POINTS_SHOWN = 400;

const DAY_MS = 86_400_000;

// ---------- cleaning what comes in ----------

/** Plain text on one line: no markup, no control or direction characters. Someone else's words, or the owner's. */
export function plainLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/[*_`#>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Where a value was read ("Smyths"), or null. */
export const cleanSource = (raw: unknown): string | null => plainLine(raw, MAX_SOURCE_CHARS) || null;

/** A page's link: http(s), no credentials. Null for nothing given; throws for something that isn't one. */
export function cleanUrl(raw: unknown, what = "url: the link of the page it was read on"): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new TrackerInputError(what);
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || s.length > MAX_URL_CHARS) throw new TrackerInputError(what);
  return u.toString();
}

/** A three-letter ISO 4217 code ("GBP"). */
export function cleanCurrency(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(s)) throw new TrackerInputError("currency: the page's own three-letter code, like GBP (never converted)");
  return s;
}

/** The owner's word for what's tracked: lower case, one line, at most 24 characters ("price", "followers"). */
export function cleanLabel(raw: unknown): string {
  const s = plainLine(raw, 200).toLowerCase();
  if (!s) throw new TrackerInputError("label: what the value is, in a word or two, like followers");
  if (s.length > TRACKER_LIMITS.label) throw new TrackerInputError(`label: at most ${TRACKER_LIMITS.label} characters`);
  return s;
}

/** A prefix or suffix ("£", "%", " kWh"): kept with its spaces, at most 8 characters, no digits. */
export function cleanAffix(raw: unknown, which: "prefix" | "suffix"): string {
  if (raw === null || raw === undefined) return "";
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>]/g, "").replace(/\s+/g, " ") : "";
  if (s.length > TRACKER_LIMITS.affix || /\d/.test(s)) throw new TrackerInputError(`${which}: at most ${TRACKER_LIMITS.affix} characters, no digits, like £ or %`);
  return which === "prefix" ? s.trimStart() : s.trimEnd();
}

/** A state tracker's states, the good one first: two to six, each lower case and short, no repeats. */
export function cleanStates(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const r of list) {
    const s = plainLine(r, 200).toLowerCase();
    if (!s) continue;
    if (s.length > TRACKER_LIMITS.state) throw new TrackerInputError(`states: each at most ${TRACKER_LIMITS.state} characters`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length < 2 || out.length > TRACKER_LIMITS.states) throw new TrackerInputError(`states: two to ${TRACKER_LIMITS.states}, the good one first, like ["in stock", "sold out"]`);
  return out;
}

/**
 * A number exactly as the page wrote it, as digits: "34.99", "12400" (from "12,400"), "-3.5". Thousands commas are
 * dropped; anything else (a symbol, a range, "about", "1.2k") is refused, never guessed at. A price has at most two
 * decimals and is never negative.
 */
export function cleanNumber(raw: unknown, opts: { money?: boolean } = {}): string {
  const s = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : "";
  const neg = !opts.money && /^-/.test(s);
  const body = neg ? s.slice(1) : s;
  const digits = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body) ? body.replace(/,/g, "") : body;
  const decimals = opts.money ? 2 : 6;
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${decimals}})?$`).test(digits)) {
    throw new TrackerInputError(
      opts.money
        ? "value: the price as the page shows it, digits only, like 34.99 (no symbol, range or estimate)"
        : "value: the number as the page shows it, digits only, like 12400 or 3.5 (no symbol, unit, range or estimate)",
    );
  }
  const clean = digits.replace(/^0+(?=\d)/, "");
  return neg && /[1-9]/.test(clean) ? `-${clean}` : clean;
}

/** "34.99" as a whole number of millionths, so comparing never meets floating point. */
function scaled(v: string): bigint {
  const neg = v.startsWith("-");
  const [whole, frac = ""] = (neg ? v.slice(1) : v).split(".");
  const n = BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0");
  return neg ? -n : n;
}

/** -1, 0 or 1: a before, the same as, or after b, as numbers. */
export function compareNumbers(a: string, b: string): number {
  const d = scaled(a) - scaled(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** a − b, as digits ("-8", "4.5"), exact. */
export function subtractNumbers(a: string, b: string): string {
  const d = scaled(a) - scaled(b);
  const neg = d < 0n;
  const abs = neg ? -d : d;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// ---------- presets ----------

const SYMBOL: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", AUD: "A$", CAD: "C$", NZD: "NZ$" };

/** A currency's prefix and suffix: "£" before for GBP, " SEK" after for one without a symbol here. */
export function currencyAffix(currency: string): { prefix: string; suffix: string } {
  const sym = SYMBOL[currency];
  return sym ? { prefix: sym, suffix: "" } : { prefix: "", suffix: ` ${currency}` };
}

/** What a preset fills in. */
export const PRESETS = {
  price: { label: "price", kind: "number", direction: "lower", states: [] as string[], defaultOp: "lte" },
  stock: { label: "stock", kind: "state", direction: "change", states: ["in stock", "sold out"], defaultOp: "eq" },
} as const satisfies Record<Exclude<TrackerPreset, null>, { label: string; kind: TrackerKind; direction: TrackerDirection; states: string[]; defaultOp: TrackerTarget["op"] }>;

/** Everything about a tracker but its id, target and dates: what `planTracker` works out from an input. */
export type TrackerShape = Pick<Tracker, "saved_id" | "name" | "url" | "label" | "kind" | "prefix" | "suffix" | "currency" | "states" | "direction" | "preset" | "assistant_id">;

/** The saved item a tracker goes on, as planTracker needs it. */
export interface TrackedItem {
  id: string;
  name: string;
  url: string | null;
  currency?: string | null;
}

/**
 * A tracker from what the owner, Ask or an assistant asked for: a preset filled in, or one described by its label
 * and kind. On a saved item, the item's link is the default page and its name the tracker's; on its own, a name is
 * needed. Throws TrackerInputError, saying what's missing. Pure.
 */
export function planTracker(input: TrackerInput, item: TrackedItem | null): TrackerShape {
  const preset = input.preset === "price" || input.preset === "stock" ? input.preset : null;
  if (input.preset !== undefined && input.preset !== null && !preset) throw new TrackerInputError('preset: "price", "stock", or leave it out to describe one');
  if (input.saved_id && !item) throw new TrackerInputError("That saved item isn't there. Use find_saved for its id.");
  const name = item ? "" : plainLine(input.name, MAX_NAME_CHARS);
  if (!item && !name) throw new TrackerInputError('name: what is being followed, like "Octopus tariff", when it isn\'t on a saved item');
  const url = input.url === undefined ? (item?.url ?? null) : cleanUrl(input.url, "url: the link of the page to check");
  const assistant_id = typeof input.assistant_id === "string" && UUID.test(input.assistant_id) ? input.assistant_id : null;
  const base = { saved_id: item?.id ?? null, name, url, assistant_id };
  if (preset === "price") {
    const currency = cleanCurrency(input.currency ?? item?.currency ?? "");
    return { ...base, ...currencyAffix(currency), label: "price", kind: "number", currency, states: [], direction: "lower", preset };
  }
  if (preset === "stock") return { ...base, label: "stock", kind: "state", prefix: "", suffix: "", currency: null, states: [...PRESETS.stock.states], direction: "change", preset };
  const label = cleanLabel(input.label);
  const kind = input.kind === "number" || input.kind === "state" ? input.kind : null;
  if (!kind) throw new TrackerInputError('kind: "number" (with a prefix or suffix) or "state" (one of a few states)');
  if (kind === "state") return { ...base, label, kind, prefix: "", suffix: "", currency: null, states: cleanStates(input.states), direction: "change", preset: null };
  const direction = input.direction === "lower" || input.direction === "higher" || input.direction === "change" ? input.direction : null;
  if (!direction) throw new TrackerInputError('direction: "lower" (lower is better), "higher" (higher is better) or "change" (any change is news)');
  const currency = input.currency ? cleanCurrency(input.currency) : null;
  const affix = currency && input.prefix === undefined && input.suffix === undefined ? currencyAffix(currency) : { prefix: cleanAffix(input.prefix, "prefix"), suffix: cleanAffix(input.suffix, "suffix") };
  return { ...base, label, kind, ...affix, currency, states: [], direction, preset: null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The link a run may open for a tracker (lib/run-links.ts): its own link when the owner typed or approved it, or when
 * it's the saved item's own; else, for a saved item's tracker, the item's own link; else none, and the run looks it
 * up by name. A link a model chose that the owner hasn't approved is never given. Pure.
 */
export function runUrlOf(t: Pick<Tracker, "url" | "url_set_by" | "saved_id">, itemUrl: string | null): string | null {
  if (t.url && (t.url_set_by === "owner" || t.url_set_by === "item")) return t.url;
  return t.saved_id && itemUrl ? itemUrl : null;
}

/** A check's value for this tracker: a number as written, or one of its states. Throws TrackerInputError. Pure. */
export function cleanValue(t: Pick<Tracker, "kind" | "states" | "currency" | "label">, raw: unknown): string {
  if (t.kind === "number") return cleanNumber(raw, { money: !!t.currency });
  const s = plainLine(raw, 200).toLowerCase();
  const hit = t.states.find((x) => x === s);
  if (!hit) throw new TrackerInputError(`value: one of ${t.states.map((x) => `"${x}"`).join(", ")}, as the page says it`);
  return hit;
}

/**
 * The target, cleaned: the op defaults by the tracker (a price "at or under", stock "is in stock", a number by its
 * direction), and its value is a number as written or one of the states. Throws TrackerInputError. Pure.
 */
export function cleanTarget(t: Pick<Tracker, "kind" | "states" | "currency" | "direction" | "preset" | "label">, raw: { op?: unknown; value?: unknown }): Pick<TrackerTarget, "op" | "value"> {
  const given = typeof raw.op === "string" ? raw.op : undefined;
  if (given !== undefined && !(TARGET_OPS as readonly string[]).includes(given)) throw new TrackerInputError('op: "lte" (at or under), "gte" (at or over), "eq" (exactly), or "change" (whenever it changes)');
  const op = (given ?? (t.preset ? PRESETS[t.preset].defaultOp : t.kind === "state" ? "eq" : t.direction === "higher" ? "gte" : t.direction === "lower" ? "lte" : "change")) as TrackerTarget["op"];
  if (op === "change") return { op, value: "" };
  if (t.kind === "state") {
    if (op !== "eq") throw new TrackerInputError('op: a state\'s target is "eq" (when it\'s one state) or "change"');
    return { op, value: raw.value === undefined || raw.value === null || raw.value === "" ? t.states[0] : cleanValue(t, raw.value) };
  }
  return { op, value: cleanValue(t, raw.value) };
}

// ---------- words ----------

/** "£34", "£34.50" (the page's "34.5"), "12,400 followers", "24.5p", "In stock". The same digits, never rounded. Pure. */
export function valueWords(t: Pick<Tracker, "kind" | "prefix" | "suffix" | "currency" | "label">, value: string): string {
  if (t.kind === "state") return value;
  const neg = value.startsWith("-");
  const [whole, frac] = (neg ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const n = `${neg ? "−" : ""}${frac === undefined ? grouped : `${grouped}.${t.currency ? frac.padEnd(2, "0") : frac}`}`;
  if (t.prefix || t.suffix) return `${t.prefix}${n}${t.suffix}`;
  return `${n} ${t.label}`;
}

export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Price", "Stock", "Followers": the label as a receipt starts with it. */
export const labelWords = (t: Pick<Tracker, "label">): string => cap(t.label);

/** "smyths.co.uk" from a link. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
}

/** Where a check was read: its source, else its page's site. Null with neither. */
export const sourceOf = (p: Pick<TrackerPoint, "source" | "url">): string | null => p.source ?? hostOf(p.url);

/** "12 Nov", or "12 Nov 2025" in another year. */
export function shortDay(iso: string, opts: { tz?: string; now?: Date } = {}): string {
  const t = Date.parse(iso);
  const year = (d: number) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: opts.tz }).format(d);
  const sameYear = year(t) === year((opts.now ?? new Date()).getTime());
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: opts.tz }).format(t);
}

/** "Price", "Followers": what a check list calls the value. "When you saved it", "You", "Ask", "Moss": who checked. */
export function checkerWords(p: Pick<TrackerPoint, "checked_by" | "who">): string {
  if (p.checked_by === "save") return "When you saved it";
  if (p.checked_by === "owner") return "You";
  if (p.checked_by === "ask") return "Ask";
  return p.who ?? "An assistant";
}

/** "£30 or less", "10,000 followers or more", "exactly 3", "when it's in stock", "when it changes". Pure. */
export function targetWords(t: Pick<Tracker, "kind" | "prefix" | "suffix" | "currency" | "label">, target: Pick<TrackerTarget, "op" | "value">): string {
  if (target.op === "change") return "when it changes";
  if (t.kind === "state") return `when it's ${target.value}`;
  const v = valueWords(t, target.value);
  return target.op === "lte" ? `${v} or less` : target.op === "gte" ? `${v} or more` : `exactly ${v}`;
}

/** "Tracking the price", "Tracking stock", "Tracking followers". */
export const trackingWords = (t: Pick<Tracker, "label" | "preset">): string => (t.preset === "price" ? "Tracking the price" : `Tracking ${t.label}`);

// ---------- what the points add up to ----------

const time = (p: TrackerPoint) => Date.parse(p.checked_at);
/** Oldest first; at the same moment, the save point first. */
export const byTime = (a: TrackerPoint, b: TrackerPoint): number => time(a) - time(b) || (a.checked_by === "save" ? -1 : b.checked_by === "save" ? 1 : 0);
const sourceKey = (p: TrackerPoint) => (sourceOf(p) ?? "").toLowerCase();

/** Is a better than b by this tracker's direction? Only for numbers with a direction. */
function better(t: Pick<Tracker, "direction">, a: string, b: string): boolean {
  const c = compareNumbers(a, b);
  return t.direction === "lower" ? c < 0 : t.direction === "higher" ? c > 0 : false;
}

/** Does a number or state have a best by its direction? A state, or a number for "change", doesn't. */
export const hasBest = (t: Pick<Tracker, "kind" | "direction">): boolean => t.kind === "number" && t.direction !== "change";

/** Does this value meet the target? `previous` is the check before, for "change". Pure. */
export function meetsTarget(t: Pick<Tracker, "kind">, target: Pick<TrackerTarget, "op" | "value"> | null | undefined, value: string, previous?: string | null): boolean {
  if (!target) return false;
  if (target.op === "change") return previous !== undefined && previous !== null && previous !== value;
  if (t.kind === "state") return target.op === "eq" && value === target.value;
  const c = compareNumbers(value, target.value);
  return target.op === "lte" ? c <= 0 : target.op === "gte" ? c >= 0 : c === 0;
}

/**
 * The check that counts as "now": for a number with a direction, the best of each source's latest check, among
 * those within 14 days of the newest ("Best price now"); otherwise the latest check. Pure.
 */
/** Each source's latest check, among those within 14 days of the newest: what each source says now. Oldest first. Pure. */
export function currentPoints(sorted: TrackerPoint[]): TrackerPoint[] {
  if (!sorted.length) return [];
  const lastBySource = new Map<string, TrackerPoint>();
  for (const p of sorted) lastBySource.set(sourceKey(p), p);
  const newest = time(sorted[sorted.length - 1]);
  return [...lastBySource.values()].filter((p) => newest - time(p) <= TRACKER_LIMITS.freshDays * DAY_MS).sort(byTime);
}

export function nowPoint(t: Pick<Tracker, "kind" | "direction">, sorted: TrackerPoint[]): TrackerPoint {
  const latest = sorted[sorted.length - 1];
  if (!hasBest(t)) return latest;
  const current = currentPoints(sorted);
  return current.reduce((a, b) => (better(t, b.value, a.value) || (compareNumbers(b.value, a.value) === 0 && byTime(b, a) > 0) ? b : a), latest);
}

/** The summary plus what the server adds beyond the contract's fields (see the notes): `now`. */
export interface TrackerSummaryFull extends TrackerSummary {
  /** The check that counts as now (nowPoint): the best current one across sources for a number with a direction, else the latest. */
  now: TrackerPoint;
  /** The current check that meets the target (reachedBy), or null. */
  reached_by: TrackerPoint | null;
}

/**
 * The check that meets the target: a target is reached while any source's current value meets
 * it, so a dearer check at another shop doesn't clear it. The best such check for a number with a direction, else
 * the newest. "change": the latest check, when it differs from the one before. Null when it isn't reached. Pure.
 */
export function reachedBy(t: Pick<Tracker, "kind" | "direction" | "target">, sorted: TrackerPoint[]): TrackerPoint | null {
  if (!t.target || !sorted.length) return null;
  const latest = sorted[sorted.length - 1];
  if (t.target.op === "change") return sorted.length > 1 && sorted[sorted.length - 2].value !== latest.value ? latest : null;
  const meeting = currentPoints(sorted).filter((p) => meetsTarget(t, t.target, p.value));
  if (!meeting.length) return null;
  if (hasBest(t)) return meeting.reduce((a, b) => (better(t, b.value, a.value) || (compareNumbers(b.value, a.value) === 0 && byTime(b, a) > 0) ? b : a));
  return meeting[meeting.length - 1];
}

/** One tracker's points summed up. Null with no points. `now` is the clock, for `fresh`. Pure. */
export function summarise(t: Pick<Tracker, "kind" | "direction" | "target">, points: TrackerPoint[], opts: { now?: Date } = {}): TrackerSummaryFull | null {
  if (!points.length) return null;
  const sorted = [...points].sort(byTime);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  let best: TrackerPoint | null = null;
  if (hasBest(t)) for (const p of sorted) if (!best || better(t, p.value, best.value)) best = p;
  let changed_at: string | null = null;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].value !== sorted[i - 1].value) changed_at = sorted[i].checked_at;
  const now = nowPoint(t, sorted);
  const reached_by = reachedBy(t, sorted);
  const clock = (opts.now ?? new Date()).getTime();
  return {
    first,
    latest,
    best,
    changed_at,
    target_reached: !!reached_by,
    reached_by,
    fresh: clock - time(latest) <= TRACKER_LIMITS.freshDays * DAY_MS,
    checks: sorted.length,
    sources: new Set(sorted.map(sourceKey)).size,
    now,
  };
}

/** A tracker with its points and summary, as the API gives it. Pure. */
export function trackerView(t: Tracker, points: TrackerPoint[], opts: { now?: Date } = {}): TrackerView & { summary: TrackerSummaryFull | null } {
  const sorted = [...points].sort(byTime);
  return { ...t, points: sorted, summary: summarise(t, sorted, opts) };
}

/**
 * What a check, just kept, says was new: a number's new best by its direction (better than every check before), a
 * value that differs from the check before, and the target met. `before` is the tracker's checks before this one.
 * Pure.
 */
export function newsFor(t: Pick<Tracker, "kind" | "direction" | "target">, before: TrackerPoint[], point: Pick<TrackerPoint, "value">): TrackerNews {
  const sorted = [...before].sort(byTime);
  const prev = sorted.length ? sorted[sorted.length - 1].value : null;
  const best = hasBest(t) && sorted.length > 0 && sorted.every((p) => better(t, point.value, p.value));
  const changed = prev !== null && prev !== point.value;
  return { best, changed, target_reached: meetsTarget(t, t.target, point.value, prev) };
}

/**
 * Is it news the owner is always told? A number's new best, any change of a state or of a
 * number followed for "change", and a reached target. A dearer price, or a count that dipped, is only kept. Pure.
 */
export function isNews(t: Pick<Tracker, "kind" | "direction">, n: TrackerNews): boolean {
  return n.best || n.target_reached || (n.changed && (t.kind === "state" || t.direction === "change"));
}

/** The receipt's marks after the value: "Lowest yet", "Was sold out", "At your target". Pure. */
export function newsMarks(t: Pick<Tracker, "kind" | "direction" | "prefix" | "suffix" | "currency" | "label">, n: TrackerNews, previous: string | null): string[] {
  const marks: string[] = [];
  if (n.best) marks.push(t.direction === "higher" ? "Highest yet" : "Lowest yet");
  else if (n.changed && previous !== null && (t.kind === "state" || t.direction === "change")) marks.push(`Was ${valueWords(t, previous)}`);
  if (n.target_reached) marks.push("At your target");
  return marks;
}

/** The pattern a run reads the marks by, for a receipt kept without its news (lib/team-run.ts). */
export const NEWS_MARKS = /· (?:Lowest yet|Highest yet|Was [^·]+|At your target)(?: ·|$)/;

/** "£34 at Smyths", "12,400 followers", "In stock at Smyths": a check's value and where. Pure. */
export function pointWords(t: Pick<Tracker, "kind" | "prefix" | "suffix" | "currency" | "label">, p: Pick<TrackerPoint, "value" | "source" | "url">): string {
  const src = sourceOf(p);
  const v = valueWords(t, p.value);
  return `${t.kind === "state" ? cap(v) : v}${src ? ` at ${src}` : ""}`;
}

/** A receipt's detail for a kept check: "Price checked · £34 at Smyths · Lowest yet". Pure. */
export function checkDetail(t: Pick<Tracker, "kind" | "direction" | "prefix" | "suffix" | "currency" | "label">, p: Pick<TrackerPoint, "value" | "source" | "url">, n: TrackerNews, previous: string | null): string {
  // "12,612 followers" already says what it is: "Checked · 12,612 followers at YouTube", not "Followers checked · 12,612 followers".
  const says = t.kind === "number" && !t.prefix && !t.suffix;
  return [says ? "Checked" : `${labelWords(t)} checked`, pointWords(t, p), ...newsMarks(t, n, previous)].join(" · ");
}

/**
 * The one sentence, said before any chart: what it is now and how that compares. `lead` is the value and where
 * ("£34 at Smyths"), `rest` what follows, so the app can set the figure apart; `lead + rest` is the sentence.
 *  - "£34 at Smyths, the lowest since you saved it."  "12,400 followers, the highest so far."
 *  - "£27 at John Lewis, under the £28 you asked for."  "£34 at Smyths. You asked to hear at £30 or less."
 *  - "In stock at Smyths, since 12 Nov. It was sold out before."  "24.5p a kWh, up from 23p on 3 Nov."
 * Pure.
 */
export function trackerSentence(view: Pick<Tracker, "kind" | "direction" | "prefix" | "suffix" | "currency" | "label" | "target"> & { points: TrackerPoint[] }, opts: { tz?: string; now?: Date } = {}): { lead: string; rest: string; text: string } | null {
  const s = summarise(view, view.points, opts);
  if (!s) return null;
  const t = view;
  const sorted = [...view.points].sort(byTime);
  // A reached target leads with the check that met it, which may be another shop than the best now.
  const lead = pointWords(t, s.target_reached && s.reached_by && t.target?.op !== "change" ? s.reached_by : s.now);
  const day = (p: TrackerPoint | string) => shortDay(typeof p === "string" ? p : p.checked_at, opts);
  const done = (rest: string) => ({ lead, rest, text: lead + rest });
  const target = t.target && t.target.op !== "change" ? t.target : null;

  if (target && t.kind === "number") {
    const tw = valueWords(t, target.value);
    if (!s.target_reached) return done(`. You asked to hear at ${targetWords(t, target)}.`);
    const c = compareNumbers((s.reached_by ?? s.now).value, target.value);
    return done(c === 0 ? `, the ${tw} you asked for.` : `, ${c < 0 ? "under" : "over"} the ${tw} you asked for.`);
  }
  if (target && t.kind === "state") return done(s.target_reached ? `. You asked to hear when it was.` : `. You asked to hear ${targetWords(t, target)}.`);

  if (s.checks === 1) return done(s.first.checked_by === "save" ? (t.currency ? ", the price when you saved it." : ", when you saved it.") : `, checked ${day(s.first)}.`);

  if (!hasBest(t)) {
    if (!s.changed_at) return done(`, the same since ${day(s.first)}.`);
    const at = sorted.findIndex((p) => p.checked_at === s.changed_at);
    const was = sorted[at - 1];
    if (t.kind === "state") return done(`, since ${day(s.changed_at)}. It was ${valueWords(t, was.value)} before.`);
    const up = compareNumbers(sorted[at].value, was.value) > 0;
    return done(`, ${up ? "up" : "down"} from ${valueWords(t, was.value)} on ${day(was)}.`);
  }

  const best = s.best!;
  const atBest = compareNumbers(s.now.value, best.value) === 0;
  const word = t.direction === "higher" ? "highest" : "lowest";
  const wasBest = `The ${word} was ${valueWords(t, best.value)} on ${day(lastSeen(sorted, best.value))}.`;
  const saved = sorted.find((p) => p.checked_by === "save") ?? null;
  if (!saved) return done(atBest ? `, the ${word} so far.` : `. ${wasBest}`);
  // Measured from the price when it was saved, in the price's own words.
  const diff = subtractNumbers(s.now.value, saved.value);
  const c = compareNumbers(diff, "0");
  const by = valueWords(t, diff.replace(/^-/, ""));
  const towardBetter = t.direction === "lower" ? c < 0 : c > 0;
  if (c === 0) return done(atBest ? ", the same as when you saved it." : `, the same as when you saved it. ${wasBest}`);
  if (towardBetter) return done(atBest ? `, the ${word} since you saved it.` : `, ${by} ${c < 0 ? "under" : "over"} the saved ${t.currency ? "price" : "figure"}. ${wasBest}`);
  // Worse than when it was saved: the best is worth saying only when it wasn't the saved figure itself.
  const bestWasSaved = compareNumbers(best.value, saved.value) === 0;
  return done(atBest || bestWasSaved ? `, ${by} ${c > 0 ? "more" : "less"} than when you saved it.` : `, ${by} ${c > 0 ? "more" : "less"} than when you saved it. ${wasBest}`);
}

/**
 * The line a kept check's news is told with, first: a reached target in the target's words, a new best as the best
 * ("£32 at Smyths, the lowest since you saved it."), a change as the tracker's sentence. `view` holds the check.
 * Null when it isn't news. Pure.
 */
export function newsLine(view: Parameters<typeof trackerSentence>[0], point: Pick<TrackerPoint, "value" | "source" | "url">, news: TrackerNews, opts: { tz?: string; now?: Date } = {}): string | null {
  if (!isNews(view, news)) return null;
  // A reached target is told with this check's own source, whatever another shop says.
  if (news.target_reached && view.target && view.target.op !== "change") {
    const words = pointWords(view, point);
    if (view.kind === "state") return `${words}. You asked to hear when it was.`;
    const c = compareNumbers(point.value, view.target.value);
    const tw = valueWords(view, view.target.value);
    return `${words}, ${c === 0 ? "the" : c < 0 ? "under the" : "over the"} ${tw} you asked for.`;
  }
  if (news.target_reached || !news.best) return trackerSentence(view, opts)?.text ?? null;
  const saved = view.points.some((p) => p.checked_by === "save");
  return `${pointWords(view, point)}, the ${view.direction === "higher" ? "highest" : "lowest"} ${saved ? "since you saved it" : "so far"}.`;
}

/** The last time a value was seen. */
function lastSeen(sorted: TrackerPoint[], value: string): TrackerPoint {
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].value === value) return sorted[i];
  return sorted[0];
}

/**
 * The quieter line under the sentence: where it started, how many checks, across how many sources.
 * "Saved at £42 on 3 Nov · 12 checks at 3 shops", "First checked 10 Nov · 4 checks". Null with one check. Pure.
 */
export function trackerDetail(view: Pick<Tracker, "kind" | "direction" | "prefix" | "suffix" | "currency" | "label" | "target" | "preset"> & { points: TrackerPoint[] }, opts: { tz?: string; now?: Date } = {}): string | null {
  const s = summarise(view, view.points, opts);
  if (!s || s.checks < 2) return null;
  const parts: string[] = [];
  // With a target, the sentence gives up the best: it goes here when it's better than now.
  if (view.target && view.target.op !== "change" && s.best && compareNumbers(s.best.value, s.now.value) !== 0) {
    parts.push(`${view.direction === "higher" ? "Highest" : "Lowest"} ${valueWords(view, s.best.value)} on ${shortDay(s.best.checked_at, opts)}`);
  }
  if (s.first.checked_by === "save") parts.push(`Saved at ${valueWords(view, s.first.value)} on ${shortDay(s.first.checked_at, opts)}`);
  else parts.push(`First checked ${shortDay(s.first.checked_at, opts)}`);
  const where = view.preset === "price" || view.preset === "stock" ? "shops" : "sites";
  parts.push(`${s.checks} checks${s.sources > 1 ? ` at ${s.sources} ${where}` : ""}`);
  return parts.join(" · ");
}

/** The tracker's name as said: a saved item's tracker takes the item's, filled in by the server. */
export const trackerName = (t: Pick<Tracker, "name" | "label">): string => t.name || cap(t.label);

/**
 * For Ask's tracker_history tool: one tracker as the model reads it, values exactly as kept. The first check,
 * then the newest ones, up to `limit`. Pure.
 */
export function trackerFacts(view: TrackerView, opts: { tz?: string; now?: Date; limit?: number } = {}) {
  const s = summarise(view, view.points, opts);
  const pt = (p: TrackerPoint) => ({
    value: valueWords(view, p.value),
    as_read: p.value,
    ...(sourceOf(p) ? { at: sourceOf(p) } : {}),
    ...(p.url ? { url: p.url } : {}),
    checked: p.checked_at,
    by: p.checked_by === "assistant" ? (p.who ?? "an assistant") : p.checked_by,
  });
  const limit = opts.limit ?? 30;
  const sorted = [...view.points].sort(byTime);
  const shown = sorted.length > limit ? [sorted[0], ...sorted.slice(-(limit - 1))] : sorted;
  return {
    tracker_id: view.id,
    name: trackerName(view),
    label: view.label,
    kind: view.kind,
    ...(view.kind === "state" ? { states: view.states } : { better: view.direction === "change" ? "any change is news" : `${view.direction} is better` }),
    ...(view.currency ? { currency: view.currency } : {}),
    ...(view.url ? { link: view.url } : {}),
    target: view.target ? { wants: targetWords(view, view.target), op: view.target.op, value: view.target.value, reached: !!s?.target_reached } : null,
    ...(s
      ? {
          says: trackerSentence(view, opts)!.text,
          now: pt(s.now),
          ...(s.best ? { best: pt(s.best) } : {}),
          latest: pt(s.latest),
          first: pt(s.first),
          ...(s.changed_at ? { changed: s.changed_at } : {}),
          fresh: s.fresh,
          checks: s.checks,
          ...(sorted.length > shown.length ? { shown: shown.length } : {}),
          points: shown.map(pt),
        }
      : { says: "No checks kept yet." }),
  };
}

/**
 * One short line for a run's prompt: what's known so the run needn't look it up. "Price: last £34 at Smyths on
 * 16 Nov; lowest £32 (10 Oct); saved at £42; you want £30 or less." The source is someone else's words: plain
 * already (cleanSource), and the caller quotes the line as data. Pure.
 */
export function trackerPromptLine(view: TrackerView, opts: { tz?: string; now?: Date } = {}): string {
  const s = summarise(view, view.points, opts);
  const parts: string[] = [];
  if (!s) parts.push("no checks yet");
  else {
    parts.push(`last ${pointWords(view, s.latest)} on ${shortDay(s.latest.checked_at, opts)}`);
    if (s.best) parts.push(`${view.direction === "higher" ? "highest" : "lowest"} ${valueWords(view, s.best.value)} (${shortDay(lastSeen([...view.points].sort(byTime), s.best.value).checked_at, opts)})`);
    else if (s.changed_at) parts.push(`changed ${shortDay(s.changed_at, opts)}`);
    if (s.first.checked_by === "save") parts.push(`saved at ${valueWords(view, s.first.value)}`);
  }
  if (view.target) parts.push(`you want to hear ${view.target.op === "change" || view.kind === "state" ? targetWords(view, view.target) : `at ${targetWords(view, view.target)}`}${s?.target_reached ? ", reached" : ""}`);
  return `${cap(view.label)}: ${parts.join("; ")}.`;
}

// ---------- lists ----------

/** The best price now, as a list carries it (SavedItem.price_now): the page's figure, currency and shop. */
export type PriceNow = { amount: string; currency: string; shop: string | null };

/** A list's best price now from a price tracker's checks: only once it has a check since the save. Pure. */
export function priceNowOf(t: Pick<Tracker, "kind" | "direction" | "currency" | "preset">, points: TrackerPoint[]): PriceNow | null {
  if (t.preset !== "price" || !t.currency || !points.some((p) => p.checked_by !== "save")) return null;
  const now = nowPoint(t, [...points].sort(byTime));
  return { amount: now.value, currency: t.currency, shop: sourceOf(now) };
}

/** An item's facts with the best price now in place of the saved one, for a list's line ("Product · £34 · Smyths"). Pure. */
export function factsWithPriceNow<F extends { price?: string; currency?: string; shop?: string }>(facts: F | null | undefined, now: PriceNow | null | undefined): F | null | undefined {
  if (!now) return facts;
  return { ...(facts ?? ({} as F)), price: now.amount, currency: now.currency, shop: now.shop ?? facts?.shop };
}

// ---------- who checks ----------

/** The words a tracker is about, for matching an assistant's job: its preset's and its label's. */
const TRACKER_WORDS: Record<string, RegExp> = {
  price: /\b(?:price|prices|pricing|deal|deals|cheap|cheaper|cost|costs|sale|sales|bargain|gift|gifts)\b/i,
  stock: /\b(?:stock|in stock|restock|restocks|sold out|available|availability|back in)\b/i,
};

/** An assistant as fitting needs it. */
export type FitAssistant = { id: string; name: string; job: string; instructions?: string | null; web?: boolean; paused?: boolean };

/**
 * Which assistants fit a tracker, best first (the app pre-sets "Who checks it?" to the fitting one): web on and not
 * paused, and a job (or instructions) that names what's tracked. A price matches price and
 * shopping words, stock matches stock words, anything else its label's words. Pure; the app mirrors it in sample mode.
 */
export function assistantsFor<A extends FitAssistant>(t: Pick<Tracker, "preset" | "label" | "name">, assistants: A[]): A[] {
  const words = t.preset ? [TRACKER_WORDS[t.preset]] : t.label.split(/\s+/).filter((w) => w.length > 2).map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/s$/, "")}s?\\b`, "i"));
  const scored = assistants
    .filter((a) => a.web && !a.paused)
    .map((a) => {
      const text = `${a.job} ${a.instructions ?? ""}`;
      const job = words.filter((w) => w.test(a.job)).length;
      const all = words.filter((w) => w.test(text)).length;
      return { a, score: job * 2 + all };
    })
    .filter((x) => x.score > 0);
  return scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name)).map((x) => x.a);
}
