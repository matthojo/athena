/**
 * What the grocery list learns from past shops (migration 0096): the owner's
 * usuals, and the order they walk their shop in. Pure and shared with the
 * app, so sample mode and an offline copy reason the same way. No model:
 * every suggestion comes from dates the owner made by ticking lines.
 */
import { itemKey } from "./recipe-units";
import { AISLES, type Aisle } from "./grocery";

const DAY = 86_400_000;

/** One line bought on a shop. `day`: the shop's date in the owner's zone, YYYY-MM-DD. */
export interface BoughtEntry {
  item: string;
  quantity: number | null;
  unit: string | null;
  aisle: string;
  day: string;
}

/** A thing the owner buys every so often, and how due it is. */
export interface Usual {
  /** itemKey of the item: what shops are grouped on. */
  key: string;
  /** The wording last used. */
  item: string;
  /** The amount usually bought, when there's a usual one. */
  quantity: number | null;
  unit: string | null;
  aisle: string;
  /** Days between shops for it, typically. */
  every: number;
  /** Days since it was last bought. */
  since: number;
  /** How many shops it's been on, within the window looked at. */
  times: number;
}

/** A usual needs this many shops (two gaps) before it's offered. */
export const MIN_SHOPS = 3;
/** Only the latest gaps count: habits change. */
const RECENT_GAPS = 6;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The amount bought most often lately ("2 pint"), else the latest; none when it was never said. */
function usualAmount(entries: BoughtEntry[]): { quantity: number | null; unit: string | null } {
  const recent = entries.slice(-4).filter((e) => e.quantity !== null);
  if (!recent.length) return { quantity: null, unit: null };
  const counts = new Map<string, { n: number; quantity: number; unit: string | null; last: number }>();
  recent.forEach((e, i) => {
    const k = `${e.quantity}\u0000${e.unit ?? ""}`;
    const c = counts.get(k) ?? { n: 0, quantity: e.quantity!, unit: e.unit, last: i };
    c.n++;
    c.last = i;
    counts.set(k, c);
  });
  const best = [...counts.values()].sort((a, b) => b.n - a.n || b.last - a.last)[0];
  return { quantity: best.quantity, unit: best.unit };
}

/** Every usual with enough shops to go on, due or not, most due first. */
export function learnUsuals(bought: BoughtEntry[], today: string): Usual[] {
  const groups = new Map<string, BoughtEntry[]>();
  for (const e of [...bought].sort((a, b) => a.day.localeCompare(b.day))) {
    if (!e.item.trim() || e.day > today) continue;
    const key = itemKey(e.item);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out: Usual[] = [];
  for (const [key, entries] of groups) {
    // Two lines for the same thing on one shop are one shop.
    const days = [...new Set(entries.map((e) => e.day))];
    if (days.length < MIN_SHOPS) continue;
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).slice(-RECENT_GAPS);
    const every = Math.round(median(gaps));
    // Bought on every shop twice a day isn't a pattern, and twice a season isn't something to be reminded of.
    if (every < 2 || every > 60) continue;
    const last = entries[entries.length - 1];
    out.push({ key, item: last.item, ...usualAmount(entries), aisle: last.aisle, every, since: daysBetween(days[days.length - 1], today), times: days.length });
  }
  return out.sort((a, b) => b.since / b.every - a.since / a.every || a.item.localeCompare(b.item, "en-GB"));
}

/**
 * Is it due? A little before the usual gap is up (shops don't fall on the
 * exact day), and not once it's been so long the owner has plainly stopped
 * buying it.
 */
export function isDue(u: Pick<Usual, "every" | "since">): boolean {
  const early = Math.max(1, Math.round(u.every * 0.15));
  return u.since >= u.every - early && u.since <= u.every * 3;
}

/**
 * The usuals worth offering now: due, not on the list already (ticked or
 * not), and not skipped until a later date.
 */
export function dueUsuals(bought: BoughtEntry[], opts: { today: string; onList: string[]; skipped: Array<{ item: string; until: string }>; max?: number }): Usual[] {
  const listed = new Set(opts.onList.map(itemKey));
  const skipped = new Set(opts.skipped.filter((s) => s.until > opts.today).map((s) => itemKey(s.item)));
  return learnUsuals(bought, opts.today)
    .filter((u) => isDue(u) && !listed.has(u.key) && !skipped.has(u.key))
    .slice(0, opts.max ?? 6);
}

/** Skipping a usual puts it off until it would next be due: one more of its gaps from today. */
export function skipUntil(u: Pick<Usual, "every">, today: string): string {
  const d = new Date(Date.parse(`${today}T12:00:00Z`) + Math.max(2, u.every) * DAY);
  return d.toISOString().slice(0, 10);
}

// ---------- the walk round the shop ----------

/** A ticked line: its aisle and when it was ticked (ms). */
export interface Tick {
  aisle: string;
  at: number;
}

/** Ticks closer together than this, first to last, were made after the shop (or for an order), not walking round it. */
const MIN_WALK_MS = 4 * 60_000;
/** A walk needs this many aisles to say anything about the order. */
const MIN_AISLES = 3;

/**
 * The aisles in the order the owner reached them: each aisle at its first
 * tick. Empty when the ticks don't look like a walk round a shop (all at
 * once, or too few aisles), so ticking at home teaches nothing.
 */
export function walkOrder(ticks: Tick[]): Aisle[] {
  const sorted = ticks.filter((t) => Number.isFinite(t.at)).sort((a, b) => a.at - b.at);
  if (sorted.length < MIN_AISLES || sorted[sorted.length - 1].at - sorted[0].at < MIN_WALK_MS) return [];
  const order: Aisle[] = [];
  for (const t of sorted) {
    const aisle = (AISLES as readonly string[]).includes(t.aisle) ? (t.aisle as Aisle) : "other";
    if (!order.includes(aisle)) order.push(aisle);
  }
  return order.length >= MIN_AISLES ? order : [];
}

/** How many walks it takes before the list follows the owner's order. */
export const MIN_WALKS = 2;

/**
 * The aisles in the order the owner walks them, from their latest walks
 * (newest first): each walked aisle placed by where it fell on average, then
 * the aisles they've never walked, in the usual order. Their own route comes
 * first, unbroken; nothing is guessed about aisles they don't go down. Null
 * until there are enough walks.
 */
export function learnedOrder(walks: string[][], recent = 6): Aisle[] | null {
  const usable = walks.filter((w) => w.length >= MIN_AISLES).slice(0, recent);
  if (usable.length < MIN_WALKS) return null;
  const at = (i: number, n: number) => (n > 1 ? i / (n - 1) : 0);
  const score = new Map<Aisle, number>();
  for (const aisle of AISLES) {
    const seen = usable.map((w) => ({ i: w.indexOf(aisle), n: w.length })).filter((x) => x.i >= 0);
    if (seen.length) score.set(aisle, seen.reduce((sum, x) => sum + at(x.i, x.n), 0) / seen.length);
  }
  const walked = [...score.keys()].sort((a, b) => score.get(a)! - score.get(b)! || AISLES.indexOf(a) - AISLES.indexOf(b));
  return [...walked, ...AISLES.filter((a) => !score.has(a))];
}
