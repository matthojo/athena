/**
 * What the home's energy cost: each day's electricity and gas priced at the
 * tariff that applied, with its standing charge. Pure, so the server (House,
 * GET /api/life/house) and the app's sample mode price the same way.
 *
 * Where the tariff comes from. The Octopus account number (an optional part
 * of the meters' address, lib/presets/octopus-meters.ts) gives the account's
 * agreements: which tariff each meter point was on, from when to when. Each
 * tariff's unit rates and standing charges are public prices, read once a
 * day during the meter sync (netlify/lib/connectors/octopus-direct.ts
 * readOctopusTariffs) and kept sealed (lib/tariff-store.ts).
 *
 * How a day is priced.
 *  - Electricity: each local half hour at the unit rate in force at its
 *    start, so a time-of-use tariff (rates that change through the day) and
 *    a tariff change in the middle of a month both price right. A two-rate
 *    tariff (E-2R, Economy 7) charges its night rate 00:30–07:30 UTC and its
 *    day rate otherwise: the usual hours, as the meter's own aren't given.
 *  - Gas: the day's kWh at the rate in force at local noon. Gas has no
 *    time-of-use tariffs, and Athena keeps only its daily total.
 *  - The standing charge: the one in force at local noon, a whole day's worth.
 * Prices are pence including VAT, as the tariff lists them.
 */
import { zonedToInstant } from "./dates";

export type Fuel = "electricity" | "gas";

/** One price: from (epoch seconds), to (epoch seconds, 0 when open-ended), pence inc VAT. Tuples keep a year of half-hourly prices small. */
export type Rate = [from: number, to: number, p: number];

export interface TariffAgreement {
  fuel: Fuel;
  /** "E-1R-VAR-22-11-01-C". */
  tariff: string;
  /** "VAR-22-11-01". */
  product: string;
  /** ISO instants; `to` null while it runs. */
  from: string;
  to: string | null;
  /** Unit rates (the day rate on a two-rate tariff), oldest first. */
  unit: Rate[];
  /** A two-rate tariff's night rate. */
  night?: Rate[];
  standing: Rate[];
}

/** What's kept, sealed: the account's agreements with their prices, as of a day. */
export interface TariffStore {
  fetched_on: string;
  account: string;
  agreements: TariffAgreement[];
}

/** "E-1R-AGILE-FLEX-22-11-25-C" → "AGILE-FLEX-22-11-25". */
export function productOf(tariff: string): string {
  return tariff.replace(/^[EG]-\dR-/, "").replace(/-[A-P]$/, "");
}

export const isTwoRate = (tariff: string): boolean => /^E-2R-/.test(tariff);

const sec = (iso: string | null | undefined): number => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

/** Octopus's rate rows → Rates, oldest first. Where a price is listed for both, direct debit wins (Athena can't tell how the owner pays; most pay that way). */
export function ratesOf(rows: Array<{ value_inc_vat?: number; valid_from?: string; valid_to?: string | null; payment_method?: string | null }>): Rate[] {
  const ok = rows.filter((r) => typeof r.value_inc_vat === "number" && r.valid_from && Number.isFinite(Date.parse(r.valid_from)));
  const dd = ok.some((r) => r.payment_method === "DIRECT_DEBIT");
  const kept = ok.filter((r) => !dd || !r.payment_method || r.payment_method === "DIRECT_DEBIT");
  const seen = new Set<number>();
  const out: Rate[] = [];
  for (const r of kept.sort((a, b) => sec(a.valid_from) - sec(b.valid_from))) {
    const from = sec(r.valid_from);
    if (seen.has(from)) continue;
    seen.add(from);
    out.push([from, sec(r.valid_to), Math.round(r.value_inc_vat! * 10000) / 10000]);
  }
  return out;
}

/** The price in force at t (epoch seconds), or null. Rates are oldest first. */
export function rateAt(rates: Rate[] | undefined, t: number): number | null {
  if (!rates?.length) return null;
  let lo = 0;
  let hi = rates.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rates[mid][0] <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (at < 0) return null;
  const [, to, p] = rates[at];
  return to && t >= to ? null : p;
}

/** The fuel's agreement in force at t (epoch seconds). */
export function agreementAt(store: Pick<TariffStore, "agreements"> | null | undefined, fuel: Fuel, t: number): TariffAgreement | null {
  for (const a of store?.agreements ?? []) {
    if (a.fuel !== fuel) continue;
    if (sec(a.from) <= t && (!a.to || t < sec(a.to))) return a;
  }
  return null;
}

/** Night on a two-rate meter: 00:30–07:30 UTC. */
const isNight = (t: number): boolean => {
  const m = Math.floor((t % 86400) / 60);
  return m >= 30 && m < 450;
};

/** The unit price of one electricity half hour starting at t. */
export function electricityRateAt(store: Pick<TariffStore, "agreements"> | null | undefined, t: number): number | null {
  const a = agreementAt(store, "electricity", t);
  if (!a) return null;
  if (a.night && isNight(t)) return rateAt(a.night, t) ?? rateAt(a.unit, t);
  return rateAt(a.unit, t);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface FuelCost {
  /** Pence for the energy used. */
  unit_p: number;
  /** Pence for the day's standing charge. */
  standing_p: number;
  total_p: number;
}

export interface DayCost {
  electricity?: FuelCost & {
    /** Pence per local half hour, 48 of them. */
    slots: number[];
    /** Unit price per half hour, pence/kWh. */
    rates: number[];
  };
  gas?: FuelCost;
}

/** The instant (epoch seconds) a local half hour starts. */
export const slotStart = (date: string, slot: number, tz: string): number =>
  Math.floor(zonedToInstant(date, `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`, tz).getTime() / 1000);

/** All 48 of a local day's half-hour starts: from midnight in steps, or one by one on a clock-change day. */
export function slotStarts(date: string, tz: string): number[] {
  const midnight = slotStart(date, 0, tz);
  const late = slotStart(date, 47, tz);
  if (late - midnight === 47 * 1800) return Array.from({ length: 48 }, (_, i) => midnight + i * 1800);
  return Array.from({ length: 48 }, (_, i) => slotStart(date, i, tz));
}

/**
 * One day priced, each fuel only where it has figures and a tariff covers it.
 * An electricity half hour with no price makes the whole fuel unpriced that
 * day, rather than a cost that's quietly too low.
 */
export function priceDay(date: string, d: { half_hours?: number[]; kwh?: number; gas_kwh?: number }, store: Pick<TariffStore, "agreements"> | null | undefined, tz: string): DayCost {
  const out: DayCost = {};
  if (!store?.agreements.length) return out;
  const starts = slotStarts(date, tz);
  const noon = starts[24];
  if (d.half_hours?.length === 48) {
    const rates: number[] = [];
    const slots: number[] = [];
    let raw = 0;
    let ok = true;
    for (let i = 0; i < 48; i++) {
      const p = electricityRateAt(store, starts[i]);
      if (p === null) {
        ok = false;
        break;
      }
      rates.push(p);
      raw += d.half_hours[i] * p;
      slots.push(r2(d.half_hours[i] * p));
    }
    const standing = rateAt(agreementAt(store, "electricity", noon)?.standing, noon);
    if (ok && standing !== null) {
      // Summed before rounding, so 48 roundings don't add up to a wrong total.
      const unit = r2(raw);
      out.electricity = { unit_p: unit, standing_p: r2(standing), total_p: r2(unit + standing), slots, rates };
    }
  }
  if (d.gas_kwh !== undefined) {
    const a = agreementAt(store, "gas", noon);
    const p = rateAt(a?.unit, noon);
    const standing = rateAt(a?.standing, noon);
    if (p !== null && standing !== null) {
      const unit = r2(d.gas_kwh * p);
      out.gas = { unit_p: unit, standing_p: r2(standing), total_p: r2(unit + standing) };
    }
  }
  return out;
}

export interface CurrentRate {
  product: string;
  tariff: string;
  /** Pence/kWh now. */
  unit_p: number;
  /** Pence a day. */
  standing_p: number;
  /** The price changes through the day. */
  time_of_use: boolean;
  /** Today's lowest and highest unit price, on a time-of-use tariff. */
  low_p?: number;
  high_p?: number;
  /** A time-weighted day's average unit price (for "always on" costs). */
  average_p: number;
}

/** Each fuel's prices today, as of `now`. */
export function currentRates(store: Pick<TariffStore, "agreements"> | null | undefined, today: string, now: Date, tz: string): Partial<Record<Fuel, CurrentRate>> {
  const out: Partial<Record<Fuel, CurrentRate>> = {};
  if (!store?.agreements.length) return out;
  const t = Math.floor(now.getTime() / 1000);
  const starts = slotStarts(today, tz);
  const noon = starts[24];
  const e = agreementAt(store, "electricity", t) ?? agreementAt(store, "electricity", noon);
  if (e) {
    const day = starts.map((s) => electricityRateAt(store, s)).filter((p): p is number => p !== null);
    const unit = electricityRateAt(store, t) ?? day[day.length - 1];
    const standing = rateAt(e.standing, t) ?? rateAt(e.standing, noon);
    if (unit !== undefined && unit !== null && standing !== null && day.length) {
      const lo = Math.min(...day);
      const hi = Math.max(...day);
      const tou = hi - lo > 0.5;
      out.electricity = {
        product: e.product,
        tariff: e.tariff,
        unit_p: unit,
        standing_p: standing,
        time_of_use: tou,
        ...(tou ? { low_p: lo, high_p: hi } : {}),
        average_p: r2(day.reduce((s, v) => s + v, 0) / day.length),
      };
    }
  }
  const g = agreementAt(store, "gas", t) ?? agreementAt(store, "gas", noon);
  if (g) {
    const unit = rateAt(g.unit, t) ?? rateAt(g.unit, noon);
    const standing = rateAt(g.standing, t) ?? rateAt(g.standing, noon);
    if (unit !== null && standing !== null) out.gas = { product: g.product, tariff: g.tariff, unit_p: unit, standing_p: standing, time_of_use: false, average_p: unit };
  }
  return out;
}

/**
 * The cheap half hours of a priced day: at or under three quarters of the
 * day's average price. On a tariff with a cheap night window that's the
 * window; on a flat tariff, nothing.
 */
export function cheapSlots(rates: number[]): boolean[] {
  if (!rates.length) return [];
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  if (hi - lo <= 0.5) return rates.map(() => false);
  const avg = rates.reduce((s, v) => s + v, 0) / rates.length;
  return rates.map((p) => p <= avg * 0.75);
}

/** "£1.42", "38p": pence for people. */
export function pence(p: number): string {
  if (Math.abs(p) < 100) return `${Math.round(p)}p`;
  return `£${(p / 100).toFixed(2)}`;
}

/** "24.5p" a unit price, one decimal where it has one. */
export function unitPrice(p: number): string {
  const r = Math.round(p * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}p`;
}
