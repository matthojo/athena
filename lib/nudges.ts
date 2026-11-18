/**
 * Which notifications the owner wants, and when: the pure rules behind
 * Settings → Notifications and the reminders function. Stored as one plain
 * `settings` row (key `notifications`): switches and clock times, nothing
 * personal. Every time is wall-clock in the owner's zone (settings.timezone),
 * so a clock change or a trip needs no edits.
 */
import { addDays, zonedParts } from "./dates";
import { placeWithArticle } from "./day-words";

export type NudgeKind = "briefing" | "events" | "reminders" | "morning" | "evening" | "weekly";
export const NUDGE_KINDS: readonly NudgeKind[] = ["briefing", "events", "reminders", "morning", "evening", "weekly"];

export interface QuietHours {
  /** "22:00": nothing is sent from here… */
  from: string;
  /** …until here ("07:00"), the next morning when it's earlier. */
  to: string;
}

export interface NotificationPrefs extends Record<NudgeKind, boolean> {
  /** When the morning check-in push comes, "07:00" (before the 07:30 briefing). Only sent while the morning routine is on (lib/checkin-push.ts). */
  morning_at: string;
  /** When the evening Days prompt comes, "21:00". */
  evening_at: string;
  quiet: QuietHours | null;
}

/** What a device gets once notifications are on: everything, each switchable off in Settings → Notifications. */
export const DEFAULT_PREFS: NotificationPrefs = {
  briefing: true,
  events: true,
  reminders: true,
  morning: true,
  evening: true,
  weekly: true,
  morning_at: "07:00",
  evening_at: "21:00",
  quiet: null,
};

export const PREFS_KEY = "notifications";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isClockTime = (v: unknown): v is string => typeof v === "string" && HHMM.test(v);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Stored (or sent) prefs, with anything missing or malformed taken from the defaults. */
export function readPrefs(raw: unknown): NotificationPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: NotificationPrefs = { ...DEFAULT_PREFS };
  for (const k of NUDGE_KINDS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (isClockTime(r.morning_at)) out.morning_at = r.morning_at;
  if (isClockTime(r.evening_at)) out.evening_at = r.evening_at;
  const q = r.quiet as Record<string, unknown> | null | undefined;
  if (q === null) out.quiet = null;
  else if (q && isClockTime(q.from) && isClockTime(q.to) && q.from !== q.to) out.quiet = { from: q.from, to: q.to };
  return out;
}

/** A PUT's changes over the current prefs. Throws a readable message on anything it can't use. */
export function mergePrefs(current: NotificationPrefs, patch: unknown): NotificationPrefs {
  if (!patch || typeof patch !== "object") throw new Error("Send an object of settings");
  const p = patch as Record<string, unknown>;
  const next = { ...current };
  for (const k of NUDGE_KINDS) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== "boolean") throw new Error(`${k}: true or false`);
    next[k] = p[k] as boolean;
  }
  if (p.morning_at !== undefined) {
    if (!isClockTime(p.morning_at)) throw new Error("morning_at: a time like 07:00");
    next.morning_at = p.morning_at;
  }
  if (p.evening_at !== undefined) {
    if (!isClockTime(p.evening_at)) throw new Error("evening_at: a time like 21:00");
    next.evening_at = p.evening_at;
  }
  if (p.quiet !== undefined) {
    const q = p.quiet as Record<string, unknown> | null;
    if (q === null) next.quiet = null;
    else if (q && isClockTime(q.from) && isClockTime(q.to) && q.from !== q.to) next.quiet = { from: q.from, to: q.to };
    else throw new Error("quiet: null, or { from, to } as two different times like 22:00");
  }
  return next;
}

/** Minutes since local midnight in the owner's zone. */
function localMinutes(now: Date, tz: string): number {
  const { hour, minute } = zonedParts(now, tz);
  return hour * 60 + minute;
}

/** Inside quiet hours: [from, to), across midnight when `to` is earlier. */
export function inQuietHours(now: Date, tz: string, quiet: QuietHours | null): boolean {
  if (!quiet || quiet.from === quiet.to) return false;
  const m = localMinutes(now, tz);
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** From the owner's evening time until midnight, local. */
export function isEveningTime(now: Date, tz: string, at: string): boolean {
  return localMinutes(now, tz) >= minutesOf(at);
}

/** Monday of the week `date` is in: the week the Sunday review covers. */
export function weekMonday(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

/** What the evening prompt needs to know about today. */
export interface DayForPrompt {
  mood?: number | null;
  line?: string | null;
  /** Who wrote the line: a run's own summary doesn't count as the owner keeping the day. */
  line_by?: "owner" | "run" | null;
  journal?: string | null;
  entries?: Array<{ title: string; source: string; at?: string; kind?: string; count?: number }>;
  events?: Array<{ title: string }>;
}

/** The owner has kept today: a mood, their own line or a journal entry. */
export function dayKept(day: DayForPrompt | null): boolean {
  if (!day) return false;
  return !!day.mood || (!!day.line?.trim() && day.line_by === "owner") || !!day.journal?.trim();
}

/** Never health or places in a push: those stay on the device's own pages. */
const PRIVATE_SOURCES = new Set(["health", "places"]);

/** The day's first highlight, for the prompt's body: its earliest entry, else its first event. */
export function firstHighlight(day: DayForPrompt | null): string | null {
  if (!day) return null;
  const entries = (day.entries ?? []).filter((e) => e.title?.trim() && !PRIVATE_SOURCES.has(e.source) && e.kind !== "habit");
  const timed = entries.filter((e) => e.at).sort((a, b) => a.at!.localeCompare(b.at!));
  const first = timed[0] ?? entries[0];
  const title = first?.title ?? day.events?.find((e) => e.title?.trim())?.title ?? null;
  if (!title) return null;
  const t = title.trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** A habit logged today but not done yet ("Reading"), for the evening prompt. */
export function untickedHabit(day: DayForPrompt | null): string | null {
  const h = (day?.entries ?? []).find((e) => e.kind === "habit" && e.count === 0 && e.title?.trim());
  if (!h) return null;
  const t = h.title.trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

// ---------- The day handed back (docs/notes/affection-2026-11.md, moment 1) ----------

/** Someone the owner saw or caught up with today (lib/week-review.ts seenEvents, plus logged catch-ups). */
export interface SeenToday {
  name: string;
  /** Saw them in person (a meeting at a place, or an in-person catch-up), not a call. */
  in_person?: boolean;
  /** The Library place it was at, from the event or the catch-up. */
  place?: string | null;
  /** How: the catch-up's kind or the event's title ("Lunch", "Lunch with Priya", "Video call"). A meal leads the words. */
  how?: string | null;
}

/** What the day's line reads: the prompt's day, plus where it went when places are allowed (the app; never a push). */
export interface DayForLine extends DayForPrompt {
  date?: string;
  /** "Lunch at Dishoom, then Hampstead Heath" (lib/places-line.ts). Left out of anything that leaves the device. */
  places_line?: string | null;
}

/**
 * A place that must never appear in a push or a line: home, work, health and
 * money. Matched on the name, as the owner named it.
 */
export function privatePlace(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (/^(home|work|the office|office)( all day)?$/i.test(n)) return true;
  if (/\b(home|house|flat|apartment)\b/i.test(n)) return true;
  if (/\b(hospital|clinic|surgery|gp|doctors?|dentists?|dental|pharmacy|chemist|therap(y|ist)|counsell?(ing|or)|physio\w*|a&e|medical|health ?cent(re|er)|nhs|ward|hospice)\b/i.test(n)) return true;
  if (/\b(bank|building society|pawn\w*|jobcentre|job centre|bookmakers?|betting|casino|citizens advice|debt)\b/i.test(n)) return true;
  return false;
}

/** "Priya Shah" → "Priya"; "Dr Ana Lopez" → "Ana"; Mum and Dad stay. */
export function firstNameOf(name: string): string {
  const n = name.trim();
  if (/^(Mum|Dad|Mom|Nan|Gran|Grandma|Grandad)$/i.test(n)) return n;
  return n.replace(/^(Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+/i, "").split(/\s+/)[0] ?? n;
}

const listOf = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lower-case the first letter unless it starts a name ("Lunch at…" → "lunch at…", "Hampstead Heath" stays). */
const lower = (s: string) => (MEAL.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The places line with anything private taken out, phrase by phrase ("Work, lunch at Dishoom, then Hampstead Heath" → "Lunch at Dishoom, then Hampstead Heath"). */
export function publicPlaces(line: string | null | undefined): string[] {
  if (!line) return [];
  return line
    .replace(/ and \d+ more$/, "")
    .split(/, then |, /)
    .map((p) => p.trim())
    .filter((p) => p && !privatePlace(p.replace(/^(lunch|dinner|breakfast|brunch|coffee|drinks) at /i, "")))
    .map((p, i) => (i === 0 ? upper(p) : p));
}

const MEAL = /^(lunch|dinner|breakfast|brunch|coffee|drinks) at (.+)$/i;
/** A stop as the sentence says it: "Barbican Centre" → "the Barbican", "lunch at Dishoom" as it is (lib/day-words.ts). */
const sayStop = (p: string): string => {
  const m = p.match(MEAL);
  return m ? `${m[1]} at ${placeWithArticle(m[2])}` : placeWithArticle(p);
};
const KIND_VERB: Record<string, string> = { watched: "Watched", read: "Reading", listened: "Listening to", played: "Played" };

/** The day's first highlight as words: "Watched Severance", or an event's own title. */
function highlightWords(day: DayForPrompt | null): string | null {
  const t = firstHighlight(day);
  if (!t) return null;
  const e = (day?.entries ?? []).find((x) => x.title?.trim() === t || (t.endsWith("…") && x.title?.startsWith(t.slice(0, -1))));
  const verb = e?.kind ? KIND_VERB[e.kind] : undefined;
  return verb ? `${verb} ${t}` : t;
}

/**
 * The day handed back in one sentence, best thing first: the people the owner
 * saw, then a named place, then a highlight. Never an undone habit, a health
 * figure, money, home or a private place. Null when the day has nothing to say.
 *
 *   "Lunch with Priya at Dishoom, then Hampstead Heath"
 *   "Saw Priya at Dishoom"            (no places line: the event's place)
 *   "Time with Priya and Tom"         (seen, nowhere public named)
 *   "A call with Mum"
 *   "Lunch at Dishoom, then Hampstead Heath"
 *   "Watched Severance"
 */
export function eveningLine(day: DayForLine | null, seen: SeenToday[] = []): string | null {
  // One entry per first name, in person first; the order otherwise as given (catch-ups, then events).
  const people: SeenToday[] = [];
  const names = new Set<string>();
  for (const s of [...seen].sort((a, b) => Number(!!b.in_person) - Number(!!a.in_person))) {
    const n = firstNameOf(s.name);
    if (!n || names.has(n.toLowerCase())) continue;
    names.add(n.toLowerCase());
    const place = s.place?.trim() && !privatePlace(s.place) ? s.place.trim() : null;
    people.push({ ...s, name: n, place });
  }
  const places = publicPlaces(day?.places_line);
  const met = people.filter((p) => p.in_person);
  if (!met.length && people.length) {
    const calls = people.slice(0, 3).map((p) => p.name);
    return `A call with ${listOf(calls)}${people.length > 3 ? " and others" : ""}`;
  }
  if (met.length) {
    // The first person's catch-up leads, with everyone met at the same place.
    const lead = met[0];
    const together = met.filter((p) => (p.place ?? null) === (lead.place ?? null)).slice(0, 3);
    const who = listOf(together.map((p) => p.name));
    // A person is tied to a place only by their own catch-up or event, never by where the phone was.
    const where = lead.place ?? null;
    const mealAt = places[0]?.match(MEAL);
    const sameStop = !!where && !!mealAt && mealAt[2].toLowerCase() === where.toLowerCase();
    const meal = (lead.how ?? "").match(/^(lunch|dinner|breakfast|brunch|coffee|drinks)\b/i)?.[1] ?? (sameStop ? mealAt![1] : undefined);
    // The places line's stop where they met is said once.
    const rest = where ? places.filter((p) => !p.toLowerCase().includes(where.toLowerCase())) : places;
    const at = where ? placeWithArticle(where) : null;
    const first = at ? (meal ? `${upper(meal.toLowerCase())} with ${who} at ${at}` : `Saw ${who} at ${at}`) : `Time with ${who}`;
    // Then whoever else was met (by place), then the places, two more at most.
    const others = met.filter((p) => !together.includes(p));
    const more: string[] = [];
    const byPlace = new Map<string, string[]>();
    for (const p of others) byPlace.set(p.place ?? "", [...(byPlace.get(p.place ?? "") ?? []), p.name]);
    for (const [place, ns] of byPlace) more.push(place ? `${listOf(ns)} at ${placeWithArticle(place)}` : `time with ${listOf(ns)}`);
    more.push(...rest.map((p) => lower(sayStop(p))));
    const tail = more.slice(0, 2);
    if (!tail.length) return first;
    return tail.length === 1 ? `${first}, then ${tail[0]}` : `${first}, ${tail[0]}, then ${tail[1]}`;
  }
  if (places.length) {
    const p = places.slice(0, 3).map((x, i) => (i === 0 ? upper(sayStop(x)) : sayStop(x)));
    return p.length === 1 ? p[0] : `${p.slice(0, -1).join(", ")}, then ${p[p.length - 1]}`;
  }
  return highlightWords(day);
}

/** The evening prompt itself: the day's best thing, then a question. Tapping it opens today with the mood picker ready. */
export function eveningPrompt(today: string, day: DayForPrompt | null, seen: SeenToday[] = []): { title: string; body: string; url: string; tag: string } {
  // A push leaves the device: no places line (location history is sealed), only the people's own public places.
  const line = eveningLine(day ? { ...day, places_line: null } : null, seen);
  return {
    title: "How was today?",
    body: line ? `${line}. How was it?` : "Add a mood or a line before the day ends.",
    url: `/#/days/${today}?mood`,
    tag: `evening-${today}`,
  };
}

/** The first 60 characters of the owner's words, cut at a word, for the "Kept" toast. */
export function quoteOf(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

const WEEKDAY_NAME = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

/**
 * What the "Kept" toast says before it quotes the owner: "Kept. Tuesday has
 * Priya, Hampstead Heath and" (the toast adds their words). Without anyone or
 * anywhere: "Kept for Tuesday:".
 */
export function keptLead(date: string, seen: SeenToday[], places_line?: string | null): string {
  const weekday = WEEKDAY_NAME.format(new Date(`${date}T12:00:00Z`));
  const names = [...new Set(seen.filter((s) => s.in_person !== false).map((s) => firstNameOf(s.name)))].slice(0, 2);
  // With people, the last stop (the first is usually where you met them); alone, the first.
  const stops = publicPlaces(places_line).map((p) => p.replace(MEAL, "$2"));
  const place = names.length ? stops[stops.length - 1] : stops[0];
  const bits = [...names, ...(place ? [place] : [])];
  return bits.length ? `Kept. ${weekday} has ${bits.join(", ")} and` : `Kept for ${weekday}:`;
}

// ---------- Regular payments (lib/recurring.ts) ----------

/** What a regular-payment nudge needs: a name and dates. A push shows on the lock screen, so never an amount. */
export interface RegularForNudge {
  key: string;
  name: string;
  cadence: "weekly" | "monthly" | "yearly";
  rise?: { on: string };
  missed?: { due_on: string };
}

export type PaymentNudgeKind = "price_up" | "missed";

const dayWords = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

export interface PaymentNudge {
  kind: PaymentNudgeKind;
  title: string;
  body: string;
  url: string;
  /** The reminder_log key: a blind index of the merchant and a date, never its name. */
  tag: string;
  /** The same key under data keys from before a rotation: a nudge sent then isn't sent again. */
  older: string[];
}

/** reminder_log keys from before merchants were indexed: "regular-up:<merchant>:<date>", the merchant readable. */
export const LEGACY_PAYMENT_PREFIXES = ["regular-up:", "regular-missed:"] as const;
const PAYMENT_PREFIX = { "regular-up:": "pay-up", "regular-missed:": "pay-missed" } as const;

/** A legacy key under the merchant's blind indexes (current key first), or [] when it isn't one or there's no data key. */
export function rekeyLegacyPayment(key: string, index: (merchant: string) => string[]): string[] {
  const prefix = LEGACY_PAYMENT_PREFIXES.find((p) => key.startsWith(p));
  const m = prefix && /^(.+):(\d{4}-\d{2}-\d{2})$/.exec(key.slice(prefix.length));
  return prefix && m ? index(m[1]).map((i) => `${PAYMENT_PREFIX[prefix]}:${i}:${m[2]}`) : [];
}

/**
 * The two money nudges, each once (its tag is the reminder_log key): a price
 * that went up, and a payment that was expected and didn't come. Both open
 * Money, where the amounts are. A rise is news for a week; a missed payment
 * until the next one is due or the list drops it.
 *
 * `index` gives the merchant's blind indexes, the current data key's first
 * (data-box's blindIndexes): reminder_log is readable, so the tag carries
 * that and not the name. Without a data key there's no index and no nudge.
 */
export function paymentNudges(list: RegularForNudge[], today: string, index: (merchant: string) => string[]): PaymentNudge[] {
  const out: PaymentNudge[] = [];
  const add = (kind: PaymentNudgeKind, legacy: string, title: string, body: string) => {
    const [tag, ...older] = rekeyLegacyPayment(legacy, index);
    if (tag) out.push({ kind, title, body, url: "/#/money", tag, older });
  };
  for (const r of list) {
    if (r.rise && r.rise.on <= today && r.rise.on >= addDays(today, -7)) {
      add("price_up", `regular-up:${r.key}:${r.rise.on}`, `${r.name} costs more now`, "The latest payment was higher than the one before. Open Money to see both prices.");
    }
    if (r.missed) {
      add("missed", `regular-missed:${r.key}:${r.missed.due_on}`, `No payment to ${r.name} yet`, `It was due around ${dayWords(r.missed.due_on)}. If you've cancelled it, there's nothing to do.`);
    }
  }
  return out;
}
