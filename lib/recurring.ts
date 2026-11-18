/**
 * Regular payments: subscriptions and bills found in the owner's opened money
 * days (lib/money.ts). Pure, so the server (after each money sync) and the
 * app's sample mode run the same rules.
 *
 * How a payment becomes "regular":
 *  1. Card payments and direct debits are grouped by a normalised merchant
 *     ("SPOTIFY P1A2B3" and "Spotify" are one), per currency.
 *  2. The gaps between payments must settle on a cadence: weekly (7 days,
 *     give or take 2), monthly (about 30, give or take 5, so 28-day Februarys
 *     and weekend shifts still count) or yearly (365, give or take 10).
 *  3. The amounts must hold steady, each within 10% of the usual one. One
 *     step change is allowed: that's a price rise, not noise.
 *  4. A confidence score weighs how regular, how steady and how many. Spending
 *     in person (eating out, takeaways, transport, groceries) loses points, and
 *     weekly spending at a café or on travel loses more, so a Saturday flat
 *     white at the same café never turns into a "subscription". CONFIDENCE_CUT
 *     is the bar.
 *  5. A direct debit is a bill by nature: it gains points and its amount may
 *     move (energy, water). A live direct debit mandate (Starling lists them)
 *     settles it outright, with no guessing; a cancelled one hides its payee.
 *
 * Each result says when the next payment is expected, the last amount, a
 * rise when the latest price is higher than the one before, and a missed
 * payment when the expected day has passed by more than a few days. Once a
 * whole extra cycle passes with nothing, it's treated as stopped and drops
 * out of the list.
 */
import { addDays, daysBetween } from "./dates";
import type { MoneyCategory } from "./day-types";

export type Cadence = "weekly" | "monthly" | "yearly";
export const CADENCES: readonly Cadence[] = ["weekly", "monthly", "yearly"];

/** One payment as a sealed money day keeps it (lib/money.ts MoneyDayFigures.payments). */
export interface RecurringInputPayment {
  merchant?: string;
  amount: number;
  category: MoneyCategory;
  /** "debit": a direct debit (Monzo's bacs scheme, Starling's DIRECT_DEBIT source). Absent: a card payment. */
  kind?: "debit";
}

export interface RecurringInputDay {
  date: string;
  currency: string;
  payments: RecurringInputPayment[];
}

/** A direct debit mandate, as Starling lists it (only what Athena keeps). */
export interface Mandate {
  name: string;
  live: boolean;
  /** The last payment taken under it, when Starling says. */
  last_on?: string;
  last_amount?: number;
  currency?: string;
}

export interface RegularPayment {
  /** The normalised merchant: stable across runs, used for "Not a subscription". */
  key: string;
  /** For people: "Spotify", "Council Tax". */
  name: string;
  /** A bill is a direct debit or a bills category; anything else is a subscription. */
  kind: "subscription" | "bill";
  cadence: Cadence;
  category: MoneyCategory;
  currency: string;
  last_on: string;
  /** Minor units. */
  last_amount: number;
  /** The usual amount at the current price, minor units. */
  usual_amount: number;
  next_on: string;
  /** Payments seen. */
  times: number;
  /** 0 to 1. Only results at or above CONFIDENCE_CUT are returned. */
  confidence: number;
  /** What it comes to a month, minor units (weekly × 52 ÷ 12, yearly ÷ 12). */
  monthly: number;
  /** The latest price is higher than the one before, from `on`. */
  rise?: { from: number; to: number; on: string };
  /** The expected payment didn't come. */
  missed?: { due_on: string };
  /** Settled by a live direct debit mandate. */
  mandate?: true;
  /** The last few payments, oldest first, for the page's little row of beats. */
  recent: Array<{ on: string; amount: number }>;
}

export const CONFIDENCE_CUT = 0.7;

/** How far either side of the cadence a gap may fall. */
const SLACK: Record<Cadence, number> = { weekly: 2, monthly: 5, yearly: 10 };
const LENGTH: Record<Cadence, number> = { weekly: 7, monthly: 30.44, yearly: 365.25 };
/** How late a payment may be before it's called missed. */
export const GRACE: Record<Cadence, number> = { weekly: 3, monthly: 5, yearly: 14 };
/** How many recent payments are weighed (older history can follow an older pattern). */
const WINDOW: Record<Cadence, number> = { weekly: 10, monthly: 13, yearly: 4 };
const MONTHLY_FACTOR: Record<Cadence, number> = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

/** Paid at a counter, a till or a gate: regular here is a habit, not a subscription. */
const IN_PERSON = new Set<MoneyCategory>(["eating_out", "takeaway", "transport", "groceries"]);
/** …and weekly here is almost always the same café or the same commute. */
const WEEKLY_HABIT = new Set<MoneyCategory>(["eating_out", "takeaway", "transport"]);
/** Services that bill on a cycle: a nudge up, never enough on its own. */
const KNOWN =
  /\b(spotify|netflix|disney|apple|icloud|google|youtube|amazon prime|prime video|audible|kindle|now tv|nowtv|paramount|dazn|sky|bt|virgin media|vodafone|ee|o2|three|giffgaff|patreon|substack|guardian|economist|times|ft|financial times|github|dropbox|notion|adobe|microsoft|xbox|playstation|nintendo|strava|headspace|calm|duolingo|gym|puregym|the gym|better|nuffield|david lloyd|council tax|tv licence|tv licensing|water|energy|octopus|british gas|edf|eon|ovo|insurance|aviva|admiral|direct line|rent|mortgage)\b/;

// ---------- Names ----------

const STOP = /\b(ltd|limited|plc|llc|inc|uk|gb|gbr|eu|london|payments?|dd|direct debit|subscriptions?|bill|billing|help|online|digital|services?|www)\b/g;

/** "SPOTIFY P1A2B3C" → "spotify", "NETFLIX.COM" → "netflix", "Apple.com/bill" → "apple", "PureGym Ltd" → "puregym". */
export function merchantKey(raw: string): string {
  const base = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/https?:\/\//g, " ")
    .replace(/\*\s*[^\s*]*\d[^\s*]*/g, " ")
    .replace(/\.(com|co\.uk|co|net|org|io|tv|uk)\b/g, " ")
    .replace(/[*/\\]+/g, " ")
    .replace(/\b[a-z]*\d[a-z0-9]*\b/g, " ");
  const key = base.replace(/&/g, " and ").replace(STOP, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return key || raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The merchant as people write it: "SPOTIFY P1A2B3C" → "Spotify", "AMAZON PRIME*2B3" → "Amazon Prime", "Disney Plus" stays. */
export function merchantName(raw: string): string {
  let s = raw
    .replace(/\*\s*[^\s*]*\d[^\s*]*/g, " ")
    .replace(/\.(com|co\.uk|net|org|io|tv)\b(\/\S*)?/gi, " ")
    .replace(/\b[A-Za-z]*\d[A-Za-z0-9]*\b/g, " ")
    .replace(/\b(ltd|limited|plc|llc|inc)\b\.?/gi, " ")
    .replace(/[*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = raw.trim();
  // Banks often shout: "NETFLIX" → "Netflix". Mixed case is kept as the merchant wrote it.
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) s = s.toLowerCase().replace(/(^|[\s&(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  return s;
}

// ---------- Maths ----------

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The share of amounts within 10% of their median. */
const steadyShare = (xs: number[]): number => {
  if (!xs.length) return 0;
  const m = median(xs);
  return xs.filter((x) => Math.abs(x - m) <= m * 0.1).length / xs.length;
};

/**
 * How steady the amounts are, allowing one change of price. Returns the
 * score and, when a change fits better than none, where it happened.
 */
export function amountSteadiness(amounts: number[]): { score: number; split?: number } {
  const flat = steadyShare(amounts);
  if (amounts.length < 3) return { score: flat };
  let best = { score: flat } as { score: number; split?: number };
  for (let i = 1; i < amounts.length; i++) {
    const before = amounts.slice(0, i);
    const after = amounts.slice(i);
    // A real change of price: the two sides differ by more than 2%.
    if (Math.abs(median(after) - median(before)) <= median(before) * 0.02) continue;
    const share = (steadyShare(before) * before.length + steadyShare(after) * after.length) / amounts.length;
    // Two flat runs (£10.99 then £11.99) are a price change even inside the 10% band.
    const tight = [before, after].every((xs) => xs.every((x) => Math.abs(x - median(xs)) <= median(xs) * 0.01));
    const score = tight ? share : share - 0.05;
    if (score > best.score || (tight && score >= best.score && best.split === undefined)) best = { score, split: i };
  }
  return best;
}

function cadenceOf(gaps: number[]): Cadence | null {
  const m = median(gaps);
  if (m >= 5 && m <= 9) return "weekly";
  if (m >= 25 && m <= 36) return "monthly";
  if (m >= 350 && m <= 380) return "yearly";
  return null;
}

/** The share of gaps that fit the cadence; a skipped cycle (twice the length) counts half. */
export function regularity(gaps: number[], cadence: Cadence): number {
  if (!gaps.length) return 0;
  const len = LENGTH[cadence];
  const slack = SLACK[cadence];
  let fit = 0;
  for (const g of gaps) {
    if (Math.abs(g - len) <= slack) fit += 1;
    else if (Math.abs(g - 2 * len) <= slack * 1.5) fit += 0.5;
  }
  return fit / gaps.length;
}

/** The next payment after `from`: a week, the same day next month (the 31st becomes the month's last), or a year on. */
export function nextDate(from: string, cadence: Cadence, dayOfMonth = Number(from.slice(8, 10))): string {
  if (cadence === "weekly") return addDays(from, 7);
  const [y, m] = from.split("-").map(Number);
  const [ny, nm] = cadence === "monthly" ? (m === 12 ? [y + 1, 1] : [y, m + 1]) : [y + 1, m];
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(dayOfMonth, last)).padStart(2, "0")}`;
}

// ---------- Finding them ----------

interface Hit {
  on: string;
  amount: number;
  category: MoneyCategory;
  debit: boolean;
  raw: string;
}

const looselySame = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

export interface DetectOptions {
  mandates?: Mandate[];
  /** Keys the owner marked "Not a subscription". */
  hidden?: Iterable<string>;
  /** Keep results under the cut too (for tests and tuning). */
  all?: boolean;
}

/** Regular payments in these days, as of `today`, soonest next payment first. */
export function detectRecurring(days: Iterable<RecurringInputDay>, today: string, opts: DetectOptions = {}): RegularPayment[] {
  const groups = new Map<string, { currency: string; key: string; hits: Hit[] }>();
  for (const d of days) {
    if (d.date > today) continue;
    for (const p of d.payments) {
      if (!p.merchant?.trim() || !(p.amount > 0)) continue;
      const key = merchantKey(p.merchant);
      if (!key) continue;
      const id = `${d.currency}|${key}`;
      const g = groups.get(id) ?? { currency: d.currency, key, hits: [] };
      g.hits.push({ on: d.date, amount: p.amount, category: p.category, debit: p.kind === "debit", raw: p.merchant.trim() });
      groups.set(id, g);
    }
  }
  const hidden = new Set(opts.hidden ?? []);
  const mandates = (opts.mandates ?? []).map((m) => ({ ...m, key: merchantKey(m.name) })).filter((m) => m.key);
  const used = new Set<string>();
  const out: RegularPayment[] = [];

  for (const g of groups.values()) {
    const mandate = mandates.find((m) => looselySame(m.key, g.key));
    if (mandate) used.add(mandate.key);
    if (mandate && !mandate.live) continue; // Cancelled: the payee has stopped being a bill.
    const r = assess(g.key, g.currency, g.hits.sort((a, b) => a.on.localeCompare(b.on)), today, !!mandate?.live);
    if (r && (opts.all || r.confidence >= CONFIDENCE_CUT)) out.push(r);
  }

  // A live mandate with no payments in the days read yet (history still filling): its own last payment.
  for (const m of mandates) {
    if (used.has(m.key) || !m.live || !m.last_on || !m.last_amount) continue;
    const r = assess(m.key, m.currency ?? "GBP", [{ on: m.last_on, amount: m.last_amount, category: "bills", debit: true, raw: m.name }], today, true);
    if (r) out.push(r);
  }

  return out.filter((r) => !hidden.has(r.key)).sort((a, b) => a.next_on.localeCompare(b.next_on) || a.name.localeCompare(b.name));
}

function assess(key: string, currency: string, all: Hit[], today: string, mandate: boolean): RegularPayment | null {
  if (!all.length) return null;
  const allGaps = all.slice(1).map((h, i) => daysBetween(all[i].on, h.on));
  let cadence = cadenceOf(allGaps.filter((g) => g > 0)) ?? (mandate ? "monthly" : null);
  if (!cadence) return null;
  const hits = all.slice(-WINDOW[cadence]);
  const gaps = hits.slice(1).map((h, i) => daysBetween(hits[i].on, h.on));
  // The recent window can tell a different story from the whole history.
  cadence = cadenceOf(gaps.filter((g) => g > 0)) ?? cadence;
  const debit = hits.some((h) => h.debit) || mandate;
  const need = cadence === "yearly" || debit ? 2 : 3;
  if (hits.length < need && !mandate) return null;

  const last = hits[hits.length - 1];
  const category = mostCommon(hits.map((h) => h.category));
  const regular = gaps.length ? regularity(gaps, cadence) : mandate ? 1 : 0;
  const amounts = hits.map((h) => h.amount);
  const steady = amountSteadiness(amounts);
  const name = merchantName(last.raw);

  let confidence: number;
  if (mandate) confidence = 1;
  else {
    const steadyScore = debit ? Math.max(steady.score, 0.7) : steady.score;
    confidence = 0.5 * regular + 0.35 * steadyScore + 0.15 * Math.min(1, (hits.length - 1) / 5);
    if (debit) confidence += 0.2;
    if (IN_PERSON.has(category)) confidence -= 0.25;
    if (cadence === "weekly" && WEEKLY_HABIT.has(category)) confidence -= 0.3;
    if (KNOWN.test(key)) confidence += 0.1;
    if (hits.length >= 3 && amounts.every((a) => a === amounts[0])) confidence += 0.05;
    // A gap of zero days (twice on one day) is a shop, not a cycle.
    if (gaps.some((g) => g === 0)) confidence -= 0.2;
    confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  }

  const current = steady.split !== undefined ? amounts.slice(steady.split) : amounts;
  const usual = Math.round(median(current.length ? current : amounts));
  const dayOfMonth = Number(mostCommon(hits.slice(-3).map((h) => h.on.slice(8, 10))));
  let next = nextDate(last.on, cadence, cadence === "monthly" ? dayOfMonth : undefined);
  let missed: RegularPayment["missed"];
  const late = daysBetween(next, today);
  if (late > GRACE[cadence]) {
    // A whole extra cycle with nothing: it has stopped. A live mandate stays (Starling says it's still set up).
    if (late > LENGTH[cadence] + GRACE[cadence] && !mandate) return null;
    missed = { due_on: next };
    if (mandate) while (daysBetween(next, today) > GRACE[cadence]) next = nextDate(next, cadence, dayOfMonth);
  }

  let rise: RegularPayment["rise"];
  if (steady.split !== undefined) {
    const before = median(amounts.slice(0, steady.split));
    const after = median(amounts.slice(steady.split));
    const at = hits[steady.split];
    // Only a recent rise is news: the change is one of the last two payments, or within about two months.
    if (after > before * 1.02 && (steady.split >= hits.length - 2 || daysBetween(at.on, today) <= 62)) rise = { from: amounts[steady.split - 1], to: last.amount, on: at.on };
  }

  return {
    key,
    name,
    kind: debit || category === "bills" ? "bill" : "subscription",
    cadence,
    category,
    currency,
    last_on: last.on,
    last_amount: last.amount,
    usual_amount: usual,
    next_on: next,
    times: all.length,
    confidence,
    monthly: Math.round(usual * MONTHLY_FACTOR[cadence]),
    ...(rise ? { rise } : {}),
    ...(missed ? { missed } : {}),
    ...(mandate ? { mandate: true as const } : {}),
    recent: hits.slice(-6).map((h) => ({ on: h.on, amount: h.amount })),
  };
}

function mostCommon<T extends string>(xs: T[]): T {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  // Ties go to the latest.
  let best = xs[xs.length - 1];
  for (const [k, v] of n) if (v > (n.get(best) ?? 0)) best = k;
  return best;
}

// ---------- Reading them ----------

/** What they come to a month, per currency (the owner's own currency first when there's one). */
export function monthlyTotals(list: RegularPayment[]): Array<{ currency: string; amount: number; count: number }> {
  const by = new Map<string, { currency: string; amount: number; count: number }>();
  for (const r of list) {
    const row = by.get(r.currency) ?? { currency: r.currency, amount: 0, count: 0 };
    row.amount += r.monthly;
    row.count++;
    by.set(r.currency, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/**
 * Names due today or tomorrow, for the briefing: a name, a kind and a date,
 * never an amount (the briefing is a note, and notes carry no figures).
 */
export function dueSoon(list: RegularPayment[], today: string): Array<{ key: string; name: string; kind: "subscription" | "bill"; on: string }> {
  const tomorrow = addDays(today, 1);
  return list.filter((r) => !r.missed && (r.next_on === today || r.next_on === tomorrow)).map((r) => ({ key: r.key, name: r.name, kind: r.kind, on: r.next_on }));
}

/** A price as a bill shows it: "£11.99", "£168" (whole pounds lose the pence, nothing is rounded). */
export function exactMoney(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

export const CADENCE_WORDS: Record<Cadence, string> = { weekly: "Every week", monthly: "Every month", yearly: "Every year" };

/** For Ask: what's paid regularly, in plain words with amounts (Ask opens money only for a money question). */
export function regularLines(list: RegularPayment[], fmt: (minor: number, currency: string) => string = exactMoney): Array<Record<string, string>> {
  return list.map((r) => ({
    name: r.name,
    kind: r.kind === "bill" ? "bill" : "subscription",
    how_often: CADENCE_WORDS[r.cadence].toLowerCase(),
    usual_amount: fmt(r.usual_amount, r.currency),
    a_month: fmt(r.monthly, r.currency),
    last_paid: r.last_on,
    next_expected: r.next_on,
    ...(r.rise ? { price_rose: `from ${fmt(r.rise.from, r.currency)} to ${fmt(r.rise.to, r.currency)} on ${r.rise.on}` } : {}),
    ...(r.missed ? { missed: `expected ${r.missed.due_on}, hasn't come` } : {}),
  }));
}
