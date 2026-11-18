/**
 * Money and home: a day's spending from bank accounts (Monzo, Starling) and
 * its electricity and gas from Octopus Energy. SECURITY.md §1 has the rules.
 *
 * Storage. Each (day, source) is one row in sensitive_blobs: domain 'money'
 * (spend per category, the count, and each card payment's merchant, time and
 * amount) or 'home' (kWh by half hour). JSON sealed under the data key; the
 * label is the day and the source only. Migration 0035 refuses a money or
 * home row that isn't sealed. A write without the key is refused.
 *
 * No model in between. A Life log run reads the accounts itself before Claude
 * starts (netlify/lib/connectors/money-sync.ts), and the accounts' tools are
 * never offered to Claude, so amounts and merchants never reach a prompt, a
 * note, an entry, a metric or a run summary.
 *
 * Reading. Days show the money and home lines only when the owner turned
 * them on (Settings → Days: loadMoneyPrefs, off by default). Ask opens money
 * only for a money question (isMoneyQuestion). The Library's Money page
 * reads month totals by category and merchant; never a balance. The
 * Library's House page reads the home days (lib/house.ts).
 *
 * Purchases. A card payment at a shop with a purchase ordered the same day
 * keeps that purchase's id in the sealed row. Nothing is written to the
 * purchase: it never gets an amount.
 */
import { randomUUID } from "node:crypto";
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText, currentKeyId } from "./data-box";
import { addDays, zonedParts, zonedToInstant } from "./dates";
import { AthenaInputError, q, qRaw } from "./db";
import { MONEY_CATEGORIES, type DayHome, type DayMoney, type MoneyCategory } from "./day-types";
import { detectRecurring, exactMoney, monthlyTotals, regularLines, type Mandate, type RegularPayment } from "./recurring";
import { eveningShare, homeMonths } from "./house";

export { eveningShare, homeMonths };

export { MONEY_CATEGORIES, type MoneyCategory };

export type MoneySource = "monzo" | "starling";
export type HomeSource = "octopus";
export const MONEY_SOURCES: MoneySource[] = ["monzo", "starling"];
/** What the owner typed in themselves (spending, meter readings), for when no bank or meter is connected, or to add what one missed. */
export const MANUAL_SOURCE = "manual";
type StoredSource = MoneySource | HomeSource | typeof MANUAL_SOURCE;
const SOURCE_NAMES: Record<StoredSource, string> = { monzo: "Monzo", starling: "Starling", octopus: "Octopus Energy", manual: "Added by hand" };

// ---------- Categories ----------

export const CATEGORY_WORDS: Record<MoneyCategory, string> = {
  eating_out: "eating out",
  takeaway: "takeaway",
  groceries: "groceries",
  transport: "transport",
  shopping: "shopping",
  bills: "bills",
  entertainment: "going out",
  holidays: "holidays",
  personal_care: "personal care",
  general: "other",
};

/** Delivery apps: a payment to one is a takeaway, whatever the bank calls it. */
const TAKEAWAY = /\b(deliveroo|just ?eat|uber ?eats|dominos?|domino's|papa ?john'?s|pizza ?hut|hungryhouse)\b/i;

/**
 * A bank's category in Athena's words, or null for money that isn't spending
 * (moving money between your own accounts and pots, savings, income).
 */
export function categoryOf(source: MoneySource, raw: string | undefined, merchant?: string): MoneyCategory | null {
  const c = (raw ?? "").toLowerCase();
  if (merchant && TAKEAWAY.test(merchant)) return "takeaway";
  const map: Record<string, MoneyCategory | null> =
    source === "monzo"
      ? {
          eating_out: "eating_out",
          groceries: "groceries",
          transport: "transport",
          shopping: "shopping",
          bills: "bills",
          entertainment: "entertainment",
          holidays: "holidays",
          personal_care: "personal_care",
          expenses: "general",
          family: "general",
          general: "general",
          cash: "general",
          charity: "general",
          gifts: "shopping",
          finances: null,
          transfers: null,
          savings: null,
          income: null,
        }
      : {
          eating_out: "eating_out",
          takeaway: "takeaway",
          groceries: "groceries",
          transport: "transport",
          shopping: "shopping",
          bills_and_services: "bills",
          entertainment: "entertainment",
          holidays: "holidays",
          lifestyle: "entertainment",
          personal_care: "personal_care",
          home: "bills",
          general: "general",
          gifts: "shopping",
          pets: "shopping",
          family: "general",
          charity: "general",
          cash: "general",
          payments: "general",
          transfers: null,
          saving: null,
          savings: null,
          income: null,
          investments: null,
          none: null,
        };
  return c in map ? map[c] : "general";
}

// ---------- Days ----------

/** One card payment or direct debit, as an adapter reads it. amount: minor units spent (positive). */
export interface MoneyTxn {
  id: string;
  /** ISO 8601. */
  at: string;
  amount: number;
  currency: string;
  category: MoneyCategory;
  merchant?: string;
  /** "debit": a direct debit (Monzo's bacs scheme, Starling's DIRECT_DEBIT source); absent for a card payment. Regular payments use it (lib/recurring.ts). */
  kind?: "debit";
}

/** What one source's sealed day holds. */
export interface MoneyDayFigures {
  currency: string;
  spent: number;
  count: number;
  categories: Partial<Record<MoneyCategory, number>>;
  /** Each payment: merchant, local time HH:MM, amount, category, the purchase it matched. A payment added by hand has an id, so it can be taken out again. */
  payments: Array<{ id?: string; merchant?: string; time: string; amount: number; category: MoneyCategory; purchase_id?: string; kind?: "debit" }>;
}

/** Payments grouped by the owner's local day. Days listed in `days` come back even when empty, so a re-read clears them. */
export function moneyDays(txns: MoneyTxn[], tz: string, days: string[] = []): Map<string, MoneyDayFigures> {
  const out = new Map<string, MoneyDayFigures>();
  const empty = (currency = "GBP"): MoneyDayFigures => ({ currency, spent: 0, count: 0, categories: {}, payments: [] });
  for (const d of days) out.set(d, empty());
  const seen = new Set<string>();
  for (const t of [...txns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (seen.has(t.id) || !(t.amount > 0) || !Number.isFinite(Date.parse(t.at))) continue;
    seen.add(t.id);
    const p = zonedParts(new Date(t.at), tz);
    const day = out.get(p.date) ?? empty(t.currency);
    if (day.count === 0) day.currency = t.currency;
    if (t.currency !== day.currency) continue; // Spending abroad in another currency: left out rather than added wrongly.
    day.spent += t.amount;
    day.count++;
    day.categories[t.category] = (day.categories[t.category] ?? 0) + t.amount;
    day.payments.push({ ...(t.merchant ? { merchant: t.merchant } : {}), time: p.time, amount: t.amount, category: t.category, ...(t.kind ? { kind: t.kind } : {}) });
    out.set(p.date, day);
  }
  return out;
}

/** "£42", "£4.50": whole pounds from £10. */
export function money(minor: number, currency: string): string {
  const big = Math.abs(minor) >= 1000;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 }).format((big ? Math.round(minor / 100) * 100 : minor) / 100);
}

/** One day merged across bank accounts (same currency only). */
export function mergeMoney(days: MoneyDayFigures[]): MoneyDayFigures | null {
  const real = days.filter((d) => d.count > 0);
  if (!real.length) return null;
  const currency = real[0].currency;
  const out: MoneyDayFigures = { currency, spent: 0, count: 0, categories: {}, payments: [] };
  for (const d of real.filter((x) => x.currency === currency)) {
    out.spent += d.spent;
    out.count += d.count;
    for (const [k, v] of Object.entries(d.categories) as Array<[MoneyCategory, number]>) out.categories[k] = (out.categories[k] ?? 0) + v;
    out.payments.push(...d.payments);
  }
  out.payments.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

/** "£42 spent · groceries £24 · eating out £18": the total, then the two biggest categories. One category: "£18 spent, all eating out". */
export function moneyLine(d: MoneyDayFigures): string {
  const top = (Object.entries(d.categories) as Array<[MoneyCategory, number]>).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = `${money(d.spent, d.currency)} spent`;
  if (top.length === 1) return `${total}, all ${CATEGORY_WORDS[top[0][0]]}`;
  return [total, ...top.slice(0, 2).map(([k, v]) => `${CATEGORY_WORDS[k]} ${money(v, d.currency)}`)].join(" · ");
}

export function dayMoney(d: MoneyDayFigures): DayMoney {
  const categories = (Object.entries(d.categories) as Array<[MoneyCategory, number]>).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount }));
  return { line: moneyLine(d), currency: d.currency, spent: d.spent, count: d.count, categories };
}

/** Eating out and takeaways, in minor units: the Patterns factor. */
export const eatingOut = (d: MoneyDayFigures | null | undefined): number => (d ? (d.categories.eating_out ?? 0) + (d.categories.takeaway ?? 0) : 0);

// ---------- Home ----------

/** One half-hour reading, as Octopus gives it. */
export interface Reading {
  start: string;
  kwh: number;
}

/** A day at home. Each fuel is there only when its meter is: a gas-only account has no `kwh` or `half_hours`. */
export interface HomeDayFigures {
  /** Electricity. */
  kwh?: number;
  gas_kwh?: number;
  /** Electricity, kWh per local half hour, 48 slots (46 or 50 on clock-change days are folded by local time). */
  half_hours?: number[];
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Readings grouped by local day, each day's 48 electricity half hours. null (or none on a day) for a fuel: no figures for it. */
export function homeDays(electric: Reading[] | null, gas: Reading[] | null, tz: string): Map<string, HomeDayFigures> {
  const out = new Map<string, HomeDayFigures>();
  const slot = (r: Reading) => {
    const p = zonedParts(new Date(r.start), tz);
    const [h, m] = p.time.split(":").map(Number);
    return { day: p.date, i: h * 2 + (m >= 30 ? 1 : 0) };
  };
  const ok = (r: Reading) => r.kwh >= 0 && Number.isFinite(Date.parse(r.start));
  for (const r of electric ?? []) {
    if (!ok(r)) continue;
    const { day, i } = slot(r);
    const d: HomeDayFigures = out.get(day) ?? {};
    const hh = d.half_hours ?? Array<number>(48).fill(0);
    hh[i] = round(hh[i] + r.kwh, 3);
    out.set(day, { ...d, kwh: round((d.kwh ?? 0) + r.kwh, 3), half_hours: hh });
  }
  for (const r of gas ?? []) {
    if (!ok(r)) continue;
    const { day } = slot(r);
    const d: HomeDayFigures = out.get(day) ?? {};
    out.set(day, { ...d, gas_kwh: round((d.gas_kwh ?? 0) + r.kwh, 3) });
  }
  return out;
}

const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/** "8.4 kWh, mostly 18:00–22:00 · gas 21.3 kWh": the four hours holding the most, when they hold at least 40% of the day. "Gas 21.3 kWh" alone. */
export function homeLine(d: HomeDayFigures): string {
  const gas = d.gas_kwh !== undefined ? `gas ${d.gas_kwh.toFixed(1)} kWh` : "";
  if (d.kwh === undefined) return gas ? gas[0].toUpperCase() + gas.slice(1) : "";
  const total = `${d.kwh.toFixed(1)} kWh`;
  // From meter readings typed in by hand: the day's share, no hours.
  if (!d.half_hours) return gas ? `${total} · ${gas}` : total;
  const hours = Array.from({ length: 24 }, (_, h) => d.half_hours![h * 2] + d.half_hours![h * 2 + 1]);
  let best = 0;
  let at = 0;
  for (let h = 0; h <= 20; h++) {
    const s = hours[h] + hours[h + 1] + hours[h + 2] + hours[h + 3];
    if (s > best) [best, at] = [s, h];
  }
  const electric = d.kwh > 0 && best / d.kwh >= 0.4 ? `${total}, mostly ${hh(at)}–${hh(at + 4)}` : total;
  return gas ? `${electric} · ${gas}` : electric;
}

export function dayHome(d: HomeDayFigures): DayHome {
  const electric = d.kwh === undefined
    ? {}
    : d.half_hours
      ? { kwh: round(d.kwh, 1), by_hour: Array.from({ length: 24 }, (_, h) => round(d.half_hours![h * 2] + d.half_hours![h * 2 + 1], 2)), evening_share: eveningShare(d) }
      : { kwh: round(d.kwh, 1) };
  return { line: homeLine(d), ...electric, ...(d.gas_kwh !== undefined ? { gas_kwh: round(d.gas_kwh, 1) } : {}) };
}

// ---------- Storing ----------

type Domain = "money" | "home";
const label = (domain: Domain, date: string, source: StoredSource) => `${domain === "money" ? "Money" : "Home"} · ${date} · ${SOURCE_NAMES[source]}`;

async function saveDay(domain: Domain, source: StoredSource, date: string, figures: unknown, tz: string): Promise<boolean> {
  const sealed = sealText(JSON.stringify(figures));
  const [prev] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = $1 AND source = $2 AND day = $3::date`, [domain, source, date]);
  if (prev) {
    try {
      if (openStrict(prev.ciphertext) === JSON.stringify(figures) && prev.ciphertext.startsWith(`enc:v1:${currentKeyId()}:`)) return false;
    } catch {
      // Unreadable under the current key: replace it.
    }
  }
  await qRaw(
    `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
     VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6)
     ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, label = EXCLUDED.label, recorded_at = EXCLUDED.recorded_at`,
    [domain, label(domain, date, source), sealed, zonedToInstant(date, "12:00", tz).toISOString(), date, source],
  );
  return true;
}

/** Purchases ordered on these days, by shop, for linking (their names are opened by q()). */
async function purchasesOn(days: string[]): Promise<Array<{ id: string; retailer: string; day: string }>> {
  if (!days.length) return [];
  try {
    return await q<{ id: string; retailer: string; day: string }>(
      `SELECT id, retailer, to_char(ordered_on, 'YYYY-MM-DD') AS day FROM purchases WHERE ordered_on = ANY($1::date[]) AND archived_at IS NULL`,
      [days],
    );
  } catch {
    return [];
  }
}

const shopKey = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\b(ltd|limited|plc|uk|gb|com|co|www|the|store|online|marketplace|mktp|retail)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");

/** Does a card merchant name a purchase's shop? "AMAZON* MKTPLACE" ~ "Amazon", "Waitrose & Partners" ~ "Waitrose". */
export function sameShop(merchant: string, retailer: string): boolean {
  const a = shopKey(merchant);
  const b = shopKey(retailer);
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Seal one bank account's days. Each listed day replaces what was there (a
 * re-read puts right a refund or a pending payment that settled). Card
 * payments at a shop with a purchase that day keep the purchase's id.
 */
export async function saveMoneyDays(source: MoneySource, days: Map<string, MoneyDayFigures>, ctx: { tz: string }): Promise<{ days: number; changed: number; linked: number }> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const purchases = await purchasesOn([...days.keys()]);
  let changed = 0;
  let linked = 0;
  for (const [date, figures] of days) {
    for (const p of figures.payments) {
      const match = p.merchant ? purchases.find((x) => x.day === date && sameShop(p.merchant!, x.retailer)) : undefined;
      if (match) {
        p.purchase_id = match.id;
        linked++;
      }
    }
    if (figures.count === 0) {
      const gone = await qRaw<{ id: string }>(`DELETE FROM sensitive_blobs WHERE domain = 'money' AND source = $1 AND day = $2::date RETURNING id`, [source, date]);
      changed += gone.length;
      continue;
    }
    if (await saveDay("money", source, date, figures, ctx.tz)) changed++;
  }
  return { days: days.size, changed, linked };
}

export async function saveHomeDays(source: HomeSource | typeof MANUAL_SOURCE, days: Map<string, HomeDayFigures>, ctx: { tz: string }): Promise<{ days: number; changed: number }> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  let changed = 0;
  for (const [date, figures] of days) if (await saveDay("home", source, date, figures, ctx.tz)) changed++;
  return { days: days.size, changed };
}

async function readDays<T>(domain: Domain, from: string, to: string): Promise<{ days: Map<string, Array<T & { source: string }>>; unreadable: number }> {
  const rows = await qRaw<{ day: string; source: string; ciphertext: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, source, ciphertext FROM sensitive_blobs WHERE domain = $1 AND day BETWEEN $2::date AND $3::date AND source NOT IN ('${RECURRING_SOURCE}', 'tariff', 'readings') ORDER BY day`,
    [domain, from, to],
  );
  const days = new Map<string, Array<T & { source: string }>>();
  let unreadable = 0;
  for (const r of rows) {
    try {
      days.set(r.day, [...(days.get(r.day) ?? []), { ...(JSON.parse(openStrict(r.ciphertext)) as T), source: r.source }]);
    } catch {
      unreadable++;
    }
  }
  return { days, unreadable };
}

/** Each day's money merged across accounts, opened. */
export async function readMoneyDays(from: string, to: string): Promise<{ days: Map<string, MoneyDayFigures>; unreadable: number }> {
  const raw = await readDays<MoneyDayFigures>("money", from, to);
  const days = new Map<string, MoneyDayFigures>();
  for (const [d, list] of raw.days) {
    const m = mergeMoney(list);
    if (m) days.set(d, m);
  }
  return { days, unreadable: raw.unreadable };
}

/**
 * One day at home from every source that has it: each fuel from a smart
 * meter when there is one (it has the half hours), else from the readings
 * typed in by hand (lib/meter-readings.ts).
 */
export function mergeHome(list: Array<HomeDayFigures & { source?: string }>): HomeDayFigures {
  const sorted = [...list].sort((a, b) => Number(a.source === MANUAL_SOURCE) - Number(b.source === MANUAL_SOURCE));
  const out: HomeDayFigures = {};
  for (const d of sorted) {
    if (out.kwh === undefined && d.kwh !== undefined) {
      out.kwh = d.kwh;
      if (d.half_hours) out.half_hours = d.half_hours;
    }
    if (out.gas_kwh === undefined && d.gas_kwh !== undefined) out.gas_kwh = d.gas_kwh;
  }
  return out;
}

export async function readHomeDays(from: string, to: string): Promise<{ days: Map<string, HomeDayFigures>; unreadable: number }> {
  const raw = await readDays<HomeDayFigures>("home", from, to);
  const days = new Map<string, HomeDayFigures>();
  for (const [d, list] of raw.days) days.set(d, mergeHome(list));
  return { days, unreadable: raw.unreadable };
}

/** For Ask's money questions: each day's spending as its line, with categories in full. */
export async function moneyLines(from: string, to: string): Promise<Map<string, string>> {
  const { days } = await readMoneyDays(from, to).catch(() => ({ days: new Map<string, MoneyDayFigures>() }));
  const out = new Map<string, string>();
  for (const [d, m] of days) {
    const all = (Object.entries(m.categories) as Array<[MoneyCategory, number]>).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${CATEGORY_WORDS[k]} ${money(v, m.currency)}`);
    out.set(d, [`${money(m.spent, m.currency)} spent`, ...all].join(" · "));
  }
  return out;
}

// ---------- Added by hand ----------

/**
 * Spending the owner types in themselves: for someone with no supported bank
 * connected, or a cash payment a bank never sees. Kept like a bank's days, a
 * sealed row per day under source 'manual', so the Money page, Days, Ask and
 * Regular payments read it with everything else. Each payment has an id so it
 * can be taken out again.
 */
export interface ManualPayment {
  id: string;
  date: string;
  /** Local HH:MM. */
  time: string;
  /** Minor units, positive. */
  amount: number;
  currency: string;
  category: MoneyCategory;
  /** What it was, or where: "Coffee", "Corner shop". */
  merchant?: string;
}

/** The most one payment typed in may be: £1,000,000. */
export const MAX_MANUAL_MINOR = 100_000_000;
export const MAX_MANUAL_DAYS_BACK = 800;

/** Check what the app (or a key) sends for one payment. Throws AthenaInputError in words the app can show. */
export function readManualPayment(raw: unknown, ctx: { today: string; nowTime?: string }): Omit<ManualPayment, "id"> {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) throw new AthenaInputError("Send the payment as JSON: date, amount, category");
  const date = o.date === undefined || o.date === "" ? ctx.today : o.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new AthenaInputError("date: YYYY-MM-DD");
  if (date > ctx.today) throw new AthenaInputError("date: that day hasn't happened yet");
  if (date < addDays(ctx.today, -MAX_MANUAL_DAYS_BACK)) throw new AthenaInputError(`date: at most ${MAX_MANUAL_DAYS_BACK} days back`);
  const amount = typeof o.amount === "string" ? Number(o.amount) : o.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_MANUAL_MINOR) throw new AthenaInputError("amount: what was spent in pence (or cents), a whole number above 0");
  const category = o.category === undefined || o.category === "" ? "general" : o.category;
  if (typeof category !== "string" || !(MONEY_CATEGORIES as readonly string[]).includes(category)) throw new AthenaInputError(`category: one of ${MONEY_CATEGORIES.join(", ")}`);
  const currency = o.currency === undefined || o.currency === "" ? "GBP" : o.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new AthenaInputError("currency: three capital letters, like GBP");
  const time: unknown = o.time === undefined || o.time === "" ? (date === ctx.today && ctx.nowTime ? ctx.nowTime : "12:00") : o.time;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AthenaInputError("time: HH:MM");
  const merchant = typeof o.merchant === "string" ? o.merchant.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { date, time, amount, currency, category: category as MoneyCategory, ...(merchant ? { merchant } : {}) };
}

/** One day's hand-added payments as a source's day, in time order. */
export function manualDayFigures(payments: Array<Omit<ManualPayment, "date">>): MoneyDayFigures {
  const sorted = [...payments].sort((a, b) => a.time.localeCompare(b.time));
  const out: MoneyDayFigures = { currency: sorted[0]?.currency ?? "GBP", spent: 0, count: 0, categories: {}, payments: [] };
  for (const p of sorted) {
    out.spent += p.amount;
    out.count++;
    out.categories[p.category] = (out.categories[p.category] ?? 0) + p.amount;
    out.payments.push({ id: p.id, ...(p.merchant ? { merchant: p.merchant } : {}), time: p.time, amount: p.amount, category: p.category });
  }
  return out;
}

async function readManualDay(date: string): Promise<MoneyDayFigures | null> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'money' AND source = $1 AND day = $2::date`, [MANUAL_SOURCE, date]);
  return row ? (JSON.parse(openStrict(row.ciphertext)) as MoneyDayFigures) : null;
}

const asManual = (date: string, d: MoneyDayFigures): ManualPayment[] =>
  d.payments.filter((p) => p.id).map((p) => ({ id: p.id!, date, time: p.time, amount: p.amount, currency: d.currency, category: p.category, ...(p.merchant ? { merchant: p.merchant } : {}) }));

/** Save a payment typed in by hand. Regular payments are worked out again, so a rent paid by hand each month shows up there too. */
export async function addManualPayment(raw: unknown, ctx: { today: string; tz: string; nowTime?: string }): Promise<ManualPayment> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const p = readManualPayment(raw, ctx);
  const before = await readManualDay(p.date);
  const have = before ? asManual(p.date, before) : [];
  if (have.length && have[0].currency !== p.currency) throw new AthenaInputError(`currency: this day already has spending in ${have[0].currency}; one currency a day`);
  const made: ManualPayment = { id: randomUUID(), ...p };
  await saveDay("money", MANUAL_SOURCE, p.date, manualDayFigures([...have, made]), ctx.tz);
  await refreshRecurring(ctx.today).catch(() => 0);
  return made;
}

/** Take a hand-added payment out. False when there was none with that id on that day. */
export async function removeManualPayment(date: string, id: string, ctx: { today: string; tz: string }): Promise<boolean> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AthenaInputError("date: YYYY-MM-DD");
  const before = await readManualDay(date);
  if (!before) return false;
  const have = asManual(date, before);
  const rest = have.filter((p) => p.id !== id);
  if (rest.length === have.length) return false;
  if (rest.length) await saveDay("money", MANUAL_SOURCE, date, manualDayFigures(rest), ctx.tz);
  else await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'money' AND source = $1 AND day = $2::date`, [MANUAL_SOURCE, date]);
  await refreshRecurring(ctx.today).catch(() => 0);
  return true;
}

/** Hand-added payments in [from, to], newest first, for the Money page's list. */
export async function manualPayments(from: string, to: string): Promise<{ payments: ManualPayment[]; unreadable: number }> {
  const rows = await qRaw<{ day: string; ciphertext: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ciphertext FROM sensitive_blobs WHERE domain = 'money' AND source = $1 AND day BETWEEN $2::date AND $3::date`,
    [MANUAL_SOURCE, from, to],
  );
  const payments: ManualPayment[] = [];
  let unreadable = 0;
  for (const r of rows) {
    try {
      payments.push(...asManual(r.day, JSON.parse(openStrict(r.ciphertext)) as MoneyDayFigures));
    } catch {
      unreadable++;
    }
  }
  payments.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return { payments, unreadable };
}

// ---------- The Library's Money page ----------

export interface MoneyMonth {
  month: string;
  currency: string;
  spent: number;
  categories: Array<{ category: MoneyCategory; amount: number }>;
  /** Most money first, at most 12. */
  merchants: Array<{ name: string; amount: number; count: number }>;
  days: number;
}

/** A month at home, each fuel only when some day had it. Per-day figures divide by that fuel's own days. */
export interface HomeMonth {
  month: string;
  electricity?: { kwh: number; evening_share: number; days: number };
  gas?: { kwh: number; days: number };
}

/** Months in [from, to], newest first: totals by category and merchant. No balances: Athena never reads them. Energy is House's (lib/house.ts). */
export async function moneyMonths(from: string, to: string): Promise<{ months: MoneyMonth[]; unreadable: number }> {
  const m = await readMoneyDays(from, to);
  const byMonth = new Map<string, MoneyMonth & { merchantMap: Map<string, { amount: number; count: number }> }>();
  for (const [day, d] of m.days) {
    const key = day.slice(0, 7);
    const month = byMonth.get(key) ?? { month: key, currency: d.currency, spent: 0, categories: [] as MoneyMonth["categories"], merchants: [], days: 0, merchantMap: new Map<string, { amount: number; count: number }>() };
    if (d.currency !== month.currency) continue;
    month.spent += d.spent;
    month.days++;
    for (const [c, v] of Object.entries(d.categories) as Array<[MoneyCategory, number]>) {
      const row = month.categories.find((x) => x.category === c);
      if (row) row.amount += v;
      else month.categories.push({ category: c, amount: v });
    }
    for (const p of d.payments) {
      const name = (p.merchant ?? "").trim() || "Other";
      const row = month.merchantMap.get(name) ?? { amount: 0, count: 0 };
      row.amount += p.amount;
      row.count++;
      month.merchantMap.set(name, row);
    }
    byMonth.set(key, month);
  }
  const months = [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(({ merchantMap, ...rest }) => ({
      ...rest,
      categories: rest.categories.sort((a, b) => b.amount - a.amount),
      merchants: [...merchantMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 12),
    }));
  return { months, unreadable: m.unreadable };
}

// ---------- The owner's choice: Money and Home on Days ----------

export interface MoneyPrefs {
  /** Show the day's spending line on Days. Off by default. */
  money: boolean;
  /** Show the day's electricity line on Days. Off by default. */
  home: boolean;
}

const PREFS_KEY = "days_money_home";
export const DEFAULT_MONEY_PREFS: MoneyPrefs = { money: false, home: false };

export function readMoneyPrefs(raw: unknown): MoneyPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { money: o.money === true, home: o.home === true };
}

export async function loadMoneyPrefs(): Promise<MoneyPrefs> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [PREFS_KEY]);
    return readMoneyPrefs(row?.value);
  } catch {
    return DEFAULT_MONEY_PREFS;
  }
}

/** PUT { money?, home? }: what's sent changes, the rest is kept. */
export async function saveMoneyPrefs(raw: unknown): Promise<MoneyPrefs> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || (o.money === undefined && o.home === undefined)) throw new AthenaInputError("Send money or home, true or false");
  for (const k of ["money", "home"] as const) if (o[k] !== undefined && typeof o[k] !== "boolean") throw new AthenaInputError(`${k}: true or false`);
  const next = { ...(await loadMoneyPrefs()), ...(o.money !== undefined ? { money: o.money as boolean } : {}), ...(o.home !== undefined ? { home: o.home as boolean } : {}) };
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [PREFS_KEY, JSON.stringify(next)]);
  return next;
}

// ---------- Ask: "Let Ask read transactions" ----------

/**
 * The owner's switch for Ask's money tools (owner, 9 Nov 2026): off by
 * default, independent of the Days switch above. While it's off Ask isn't
 * offered `money` or `regular_payments` and a day read in full leaves its
 * spending out (lib/ask-tools.ts), so no amount or merchant reaches a prompt.
 */
const ASK_MONEY_KEY = "ask_money";

export const readAskMoney = (raw: unknown): boolean => !!raw && typeof raw === "object" && (raw as { on?: unknown }).on === true;

export async function loadAskMoney(): Promise<boolean> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [ASK_MONEY_KEY]);
    return readAskMoney(row?.value);
  } catch {
    return false;
  }
}

/** PUT { on: boolean }. */
export async function saveAskMoney(raw: unknown): Promise<{ on: boolean }> {
  const on = (raw as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") throw new AthenaInputError("Send on: true or false");
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ASK_MONEY_KEY, JSON.stringify({ on })]);
  return { on };
}

// ---------- Ask ----------

/** A question about spending, a bank or energy use: Ask may then open the money and home rows. */
export function isMoneyQuestion(text: string): boolean {
  return /\b(money|spen[dt]\w*|spending|cost(s|ing)?|paid|pay(ing|ments?)?|bought|buy(ing)?|£|\$|€|pounds?|budget\w*|expens\w*|bank\w*|monzo|starling|merchants?|shops?|groceries|takeaways?|eating out|restaurants?|card|transactions?|energy|electric\w*|kwh|octopus|gas)\b|£/i.test(text);
}

// ---------- Keys ----------

// After a key rotation the backfill re-seals money, home and finance days with every other sensitive_blobs day row (lib/encryption.ts ENCRYPTED).

/** Days in a window, oldest first. */
export const dayList = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
};

// ---------- Regular payments (lib/recurring.ts) ----------

/**
 * One sealed row holds the list: domain 'money', source 'recurring', label
 * 'recurring'. The money rows' check wants a day, so it sits on a fixed day
 * no money window ever reaches (readDays also skips the source). It keeps the
 * found payments, Starling's mandates as last read, and the keys the owner
 * marked "Not a subscription". Recomputed after each money sync.
 */
export const RECURRING_SOURCE = "recurring";
const RECURRING_DAY = "2000-01-01";
/** Two years and a month: enough for a yearly renewal to show twice, whichever day it is. */
export const RECURRING_HISTORY_DAYS = 760;

export interface RecurringStore {
  /** The day it was worked out, in the owner's zone. */
  computed_on: string;
  items: RegularPayment[];
  mandates: Mandate[];
  /** Merchant keys the owner said aren't subscriptions. */
  hidden: string[];
}

const EMPTY_STORE: RecurringStore = { computed_on: "", items: [], mandates: [], hidden: [] };

export async function loadRecurringStore(): Promise<RecurringStore> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'money' AND source = $1 AND day = $2::date`, [RECURRING_SOURCE, RECURRING_DAY]);
  if (!row) return { ...EMPTY_STORE };
  const o = JSON.parse(openStrict(row.ciphertext)) as Partial<RecurringStore>;
  return { computed_on: o.computed_on ?? "", items: o.items ?? [], mandates: o.mandates ?? [], hidden: o.hidden ?? [] };
}

async function saveRecurringStore(store: RecurringStore): Promise<void> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(
    `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
     VALUES ('money', 'recurring', $1, now(), $2::date, $3)
     ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, recorded_at = EXCLUDED.recorded_at`,
    [sealText(JSON.stringify(store)), RECURRING_DAY, RECURRING_SOURCE],
  );
}

/**
 * Work the list out again from the sealed days (after a money sync). Mandates
 * read this run replace the kept ones; without them the kept ones stand.
 * Returns how many regular payments there are now (a count, for the run summary).
 */
export async function refreshRecurring(today: string, opts: { mandates?: Mandate[] } = {}): Promise<number> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const [store, { days }] = await Promise.all([loadRecurringStore().catch(() => ({ ...EMPTY_STORE })), readMoneyDays(addDays(today, -RECURRING_HISTORY_DAYS), today)]);
  const mandates = opts.mandates ?? store.mandates;
  const items = detectRecurring(
    [...days].map(([date, d]) => ({ date, currency: d.currency, payments: d.payments })),
    today,
    { mandates },
  );
  await saveRecurringStore({ computed_on: today, items, mandates, hidden: store.hidden });
  return items.filter((r) => !store.hidden.includes(r.key)).length;
}

export interface RegularPayments {
  today: string;
  items: RegularPayment[];
  totals: Array<{ currency: string; amount: number; count: number }>;
  /** Marked "Not a subscription", by name, so they can be brought back. */
  hidden: Array<{ key: string; name: string }>;
}

/** For the Money page, Ask, the briefing and nudges: the list, the owner's hidden ones taken out. */
export async function regularPayments(today: string): Promise<RegularPayments> {
  const store = await loadRecurringStore();
  const hidden = new Set(store.hidden);
  const items = store.items.filter((r) => !hidden.has(r.key));
  return {
    today,
    items,
    totals: monthlyTotals(items),
    hidden: store.hidden.map((key) => ({ key, name: store.items.find((r) => r.key === key)?.name ?? key })),
  };
}

/** "Not a subscription" (hidden: true), or bring one back (false). Remembered, sealed with the list. */
export async function markNotRegular(raw: unknown): Promise<{ hidden: string[] }> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const key = typeof o?.key === "string" ? o.key.trim() : "";
  if (!key || key.length > 120) throw new AthenaInputError("Send key: the payment's key");
  if (typeof o?.hidden !== "boolean") throw new AthenaInputError("hidden: true or false");
  const store = await loadRecurringStore();
  const hidden = new Set(store.hidden);
  if (o.hidden) hidden.add(key);
  else hidden.delete(key);
  await saveRecurringStore({ ...store, hidden: [...hidden] });
  return { hidden: [...hidden] };
}

/** For Ask's money questions: what's paid regularly, with amounts, and the monthly total. */
export async function regularPaymentLines(today: string): Promise<{ payments: Array<Record<string, string>>; a_month: string[] }> {
  const r = await regularPayments(today);
  return { payments: regularLines(r.items), a_month: r.totals.map((t) => `${exactMoney(t.amount, t.currency)} a month across ${t.count}`) };
}
