/**
 * The House page's figures (GET /api/life/house, views/house.ts): the home's
 * energy as charts, what it cost, the household bills and the house's own
 * Life admin. Pure, so the server and the app's sample mode draw the same
 * page from the same rules.
 *
 *  - Energy: from the sealed home days (lib/money.ts HomeDayFigures, kWh per
 *    local half hour for electricity, the day's kWh for gas).
 *  - Cost: each day priced by lib/tariff.ts when the Octopus account number
 *    is set and its tariff has been read; kWh only otherwise.
 *  - Bills: the regular payments already found in the bank days
 *    (lib/recurring.ts) that are household bills, by name. No model.
 *  - House admin: Life admin items about the home, picked by kind and words.
 *
 * Each chart has a one-line takeaway in plain words. Nothing here guesses at
 * a reason it can't see (the weather, who was in): it says what changed.
 */
import type { HouseAppliance } from "./home-appliances";
import { addDays, zonedParts } from "./dates";
import type { HomeDayFigures, HomeMonth } from "./money";
import type { MeterReading } from "./manual-entry";
import type { RegularPayment } from "./recurring";
import { energyTrends, type EnergyTrends } from "./house-trends";
import { cheapSlots, currentRates, pence, priceDay, type CurrentRate, type DayCost, type Fuel, type TariffStore } from "./tariff";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 16:00–19:00: when the grid is busiest and peak prices apply. */
export const PEAK_SLOTS = [32, 38] as const;
/** 00:00–06:00: where the overnight minimum is looked for. */
export const NIGHT_SLOTS = [0, 12] as const;

const hhmm = (slot: number) => `${String(Math.floor(slot / 2) % 24).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Days with electricity half hours, oldest first. */
const electricDays = (days: Map<string, HomeDayFigures>): string[] => [...days.keys()].filter((d) => days.get(d)?.half_hours?.length === 48).sort();

// ---------- Days and months (shared with lib/money.ts) ----------

const EVENING = [18, 23];
/** The share of the day's electricity used 18:00–23:00. */
export const eveningShare = (d: HomeDayFigures): number => (d.kwh && d.half_hours ? r2(d.half_hours.slice(EVENING[0] * 2, EVENING[1] * 2).reduce((s, v) => s + v, 0) / d.kwh) : 0);

/** Days at home by month, newest first: electricity and gas apart, a fuel only in months it has figures. */
export function homeMonths(days: Map<string, HomeDayFigures>): HomeMonth[] {
  const homeByMonth = new Map<string, { month: string; kwh: number; evening: number; days: number; gas: number; gasDays: number }>();
  for (const [day, d] of days) {
    const key = day.slice(0, 7);
    const row = homeByMonth.get(key) ?? { month: key, kwh: 0, evening: 0, days: 0, gas: 0, gasDays: 0 };
    if (d.kwh !== undefined) {
      row.kwh += d.kwh;
      row.evening += d.kwh * eveningShare(d);
      row.days++;
    }
    if (d.gas_kwh !== undefined) {
      row.gas += d.gas_kwh;
      row.gasDays++;
    }
    homeByMonth.set(key, row);
  }
  return [...homeByMonth.values()]
    .filter((r) => r.days || r.gasDays)
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((r) => ({
      month: r.month,
      ...(r.days ? { electricity: { kwh: r1(r.kwh), evening_share: r.kwh ? r2(r.evening / r.kwh) : 0, days: r.days } } : {}),
      ...(r.gasDays ? { gas: { kwh: r1(r.gas), days: r.gasDays } } : {}),
    }));
}

// ---------- Today ----------

/** The latest day with half hours, the usual day beside it (the mean of up to 28 days before it), and which half hour it is now. */
export function latestAndTypical(days: Map<string, HomeDayFigures>, now: Date, tz: string): { date: string; half_hours: number[]; kwh: number; typical: number[]; now_slot: number } | null {
  const list = electricDays(days);
  const date = list[list.length - 1];
  if (!date) return null;
  const before = list.filter((d) => d < date).slice(-28);
  const typical = Array.from({ length: 48 }, (_, i) => (before.length ? r3(sum(before.map((d) => days.get(d)!.half_hours![i])) / before.length) : 0));
  const p = zonedParts(now, tz);
  const [h, m] = p.time.split(":").map(Number);
  const hh = days.get(date)!.half_hours!;
  return { date, half_hours: hh, kwh: r2(sum(hh)), typical, now_slot: h * 2 + (m >= 30 ? 1 : 0) };
}

// ---------- The week ----------

export interface Heatmap {
  /** Oldest first, up to 7. */
  days: string[];
  /** days × 48 half hours, kWh. */
  cells: number[][];
  max: number;
}

/** The last seven days with half hours, each a row of 48. */
export function weekHeatmap(days: Map<string, HomeDayFigures>): Heatmap {
  const list = electricDays(days).slice(-7);
  const cells = list.map((d) => days.get(d)!.half_hours!.map(r3));
  return { days: list, cells, max: Math.max(0, ...cells.flat()) };
}

/** The busiest and quietest hour across the week, averaged. */
export function weekHours(map: Heatmap): { busiest: number; quietest: number } | null {
  if (!map.days.length) return null;
  const hours = Array.from({ length: 24 }, (_, h) => sum(map.cells.map((row) => row[h * 2] + row[h * 2 + 1])));
  let busiest = 0;
  let quietest = 0;
  hours.forEach((v, h) => {
    if (v > hours[busiest]) busiest = h;
    if (v < hours[quietest]) quietest = h;
  });
  return { busiest, quietest };
}

// ---------- Baseload ----------

export interface Baseload {
  /** The overnight minimum, as a steady draw. */
  kw: number;
  kwh_day: number;
  kwh_year: number;
  /** Its share of the electricity used. */
  share: number;
  /** At the day's average unit price, with a tariff. */
  cost_year_p?: number;
  days: number;
}

/** The "always on" draw: each night's lowest half hour (00:00–06:00), the median across up to 30 days, held for 24 hours. */
export function baseload(days: Map<string, HomeDayFigures>, averageUnitP?: number): Baseload | null {
  const list = electricDays(days).slice(-30);
  if (!list.length) return null;
  const mins = list.map((d) => Math.min(...days.get(d)!.half_hours!.slice(NIGHT_SLOTS[0], NIGHT_SLOTS[1])));
  const kw = median(mins) * 2;
  const kwhDay = kw * 24;
  const used = sum(list.map((d) => sum(days.get(d)!.half_hours!))) / list.length;
  const kwhYear = kwhDay * 365;
  return {
    kw: r3(kw),
    kwh_day: r1(kwhDay),
    kwh_year: Math.round(kwhYear),
    share: used ? r2(Math.min(1, kwhDay / used)) : 0,
    ...(averageUnitP !== undefined ? { cost_year_p: Math.round(kwhYear * averageUnitP) } : {}),
    days: list.length,
  };
}

// ---------- Peak and cheap hours ----------

export interface PeakShare {
  /** 16:00–19:00's share of the electricity, over up to 30 days. */
  peak: number;
  /** On a time-of-use tariff: the share used in its cheap half hours. */
  cheap?: number;
  days: number;
}

export function peakShare(days: Map<string, HomeDayFigures>, costs?: Map<string, DayCost>): PeakShare | null {
  const list = electricDays(days).slice(-30);
  if (!list.length) return null;
  let total = 0;
  let peak = 0;
  let cheapTotal = 0;
  let cheap = 0;
  let tou = false;
  for (const d of list) {
    const hh = days.get(d)!.half_hours!;
    total += sum(hh);
    peak += sum(hh.slice(PEAK_SLOTS[0], PEAK_SLOTS[1]));
    const rates = costs?.get(d)?.electricity?.rates;
    if (!rates) continue;
    const marks = cheapSlots(rates);
    if (marks.some(Boolean)) tou = true;
    cheapTotal += sum(hh);
    cheap += sum(hh.filter((_, i) => marks[i]));
  }
  return { peak: total ? r2(peak / total) : 0, ...(tou && cheapTotal ? { cheap: r2(cheap / cheapTotal) } : {}), days: list.length };
}

// ---------- Daily and monthly ----------

export interface DailyPoint {
  date: string;
  kwh?: number;
  gas_kwh?: number;
  cost?: { electricity?: { unit_p: number; standing_p: number; total_p: number }; gas?: { unit_p: number; standing_p: number; total_p: number } };
  /** The busiest half hour. */
  peak?: { slot: number; kwh: number };
}

/** The 30 days up to the latest reading, each fuel as it was, priced where it can be. */
export function dailySeries(days: Map<string, HomeDayFigures>, costs: Map<string, DayCost>, n = 30): DailyPoint[] {
  const last = [...days.keys()].sort().pop();
  if (!last) return [];
  const out: DailyPoint[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(last, -i);
    const d = days.get(date);
    const c = costs.get(date);
    const point: DailyPoint = { date };
    if (d?.kwh !== undefined) point.kwh = r2(d.kwh);
    if (d?.gas_kwh !== undefined) point.gas_kwh = r2(d.gas_kwh);
    if (c?.electricity || c?.gas) {
      point.cost = {
        ...(c.electricity ? { electricity: { unit_p: c.electricity.unit_p, standing_p: c.electricity.standing_p, total_p: c.electricity.total_p } } : {}),
        ...(c.gas ? { gas: { ...c.gas } } : {}),
      };
    }
    if (d?.half_hours?.length === 48) {
      let slot = 0;
      d.half_hours.forEach((v, j) => v > d.half_hours![slot] && (slot = j));
      point.peak = { slot, kwh: r3(d.half_hours[slot]) };
    }
    out.push(point);
  }
  return out;
}

export interface MonthPoint {
  month: string;
  electricity?: { kwh: number; days: number; per_day: number; cost_p?: number };
  gas?: { kwh: number; days: number; per_day: number; cost_p?: number };
}

/** Months oldest first, kWh a day so a part month compares fairly, with the month's cost when every day of it was priced. */
export function monthSeries(months: HomeMonth[], costs: Map<string, DayCost>): MonthPoint[] {
  const priced = new Map<string, { e: number; eDays: number; g: number; gDays: number }>();
  for (const [date, c] of costs) {
    const m = priced.get(date.slice(0, 7)) ?? { e: 0, eDays: 0, g: 0, gDays: 0 };
    if (c.electricity) (m.e += c.electricity.total_p), m.eDays++;
    if (c.gas) (m.g += c.gas.total_p), m.gDays++;
    priced.set(date.slice(0, 7), m);
  }
  return [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const p = priced.get(m.month);
      return {
        month: m.month,
        ...(m.electricity ? { electricity: { kwh: m.electricity.kwh, days: m.electricity.days, per_day: r2(m.electricity.kwh / m.electricity.days), ...(p && p.eDays === m.electricity.days ? { cost_p: Math.round(p.e) } : {}) } } : {}),
        ...(m.gas ? { gas: { kwh: m.gas.kwh, days: m.gas.days, per_day: r2(m.gas.kwh / m.gas.days), ...(p && p.gDays === m.gas.days ? { cost_p: Math.round(p.g) } : {}) } } : {}),
      };
    });
}

export interface YearOnYear {
  month: string;
  fuel: Fuel;
  per_day: number;
  last_year: number;
  /** +0.12 is 12% more. */
  change: number;
}

/** The latest month with at least three days, against the same month a year before, per fuel. */
export function yearOnYear(months: MonthPoint[]): YearOnYear[] {
  const out: YearOnYear[] = [];
  for (const fuel of ["electricity", "gas"] as const) {
    const now = [...months].reverse().find((m) => (m[fuel]?.days ?? 0) >= 3);
    if (!now) continue;
    const [y, mm] = now.month.split("-");
    const before = months.find((m) => m.month === `${Number(y) - 1}-${mm}`)?.[fuel];
    if (!before?.per_day) continue;
    out.push({ month: now.month, fuel, per_day: now[fuel]!.per_day, last_year: before.per_day, change: r2(now[fuel]!.per_day / before.per_day - 1) });
  }
  return out;
}

// ---------- Takeaways ----------

const more = (change: number, what: string, than: string): string => {
  const n = Math.round(Math.abs(change) * 100);
  if (n < 3) return `About the same ${what} as ${than}`;
  return `${n}% ${change > 0 ? "more" : "less"} ${what} than ${than}`;
};

const dayWords = (date: string, today: string): string => {
  if (date === today) return "Today so far";
  if (date === addDays(today, -1)) return "Yesterday";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
};

export function todayTakeaway(t: NonNullable<ReturnType<typeof latestAndTypical>>, today: string): string {
  const upTo = t.date === today ? t.now_slot + 1 : 48;
  const used = sum(t.half_hours.slice(0, upTo));
  const usual = sum(t.typical.slice(0, upTo));
  const lead = `${dayWords(t.date, today)}: ${r1(used).toFixed(1)} kWh`;
  if (!usual) return `${lead}.`;
  const change = used / usual - 1;
  const n = Math.round(Math.abs(change) * 100);
  return n < 5 ? `${lead}, about a usual day.` : `${lead}, ${n}% ${change > 0 ? "more" : "less"} than a usual day.`;
}

export function weekTakeaway(map: Heatmap): string {
  const h = weekHours(map);
  if (!h) return "";
  return `Your busiest hour this week was ${hhmm(h.busiest * 2)}, your quietest ${hhmm(h.quietest * 2)}.`;
}

export function dailyTakeaway(points: DailyPoint[]): string {
  const week = points.slice(-7);
  const before = points.slice(-14, -7);
  const fuels: Array<["kwh" | "gas_kwh", string]> = [["gas_kwh", "gas"], ["kwh", "electricity"]];
  for (const [k, word] of fuels) {
    const a = week.map((p) => p[k]).filter((v): v is number => v !== undefined);
    const b = before.map((p) => p[k]).filter((v): v is number => v !== undefined);
    if (a.length < 4 || b.length < 4) continue;
    const change = sum(a) / a.length / (sum(b) / b.length) - 1;
    if (Math.abs(change) >= 0.1) return `${more(change, word, "the week before")} in the last seven days.`;
  }
  const costed = points.filter((p) => p.cost);
  if (costed.length) {
    const total = sum(costed.map((p) => (p.cost!.electricity?.total_p ?? 0) + (p.cost!.gas?.total_p ?? 0)));
    return `${pence(total)} over ${costed.length} days, ${pence(total / costed.length)} a day with standing charges.`;
  }
  const kwh = sum(points.map((p) => (p.kwh ?? 0) + (p.gas_kwh ?? 0)));
  return kwh ? `${Math.round(kwh)} kWh over the last ${points.length} days.` : "";
}

/** "38% more gas a day than November last year", or against the month before when there's no last year. */
export function monthlyTakeaway(months: MonthPoint[], yoy: YearOnYear[]): string {
  const gas = yoy.find((y) => y.fuel === "gas");
  const pick = gas && Math.abs(gas.change) >= 0.03 ? gas : (yoy.find((y) => y.fuel === "electricity") ?? gas);
  if (pick) return `${more(pick.change, `${pick.fuel} a day`, `${monthName(pick.month)} last year`)}.`;
  for (const fuel of ["gas", "electricity"] as const) {
    const withFuel = months.filter((m) => (m[fuel]?.days ?? 0) >= 3);
    const [prev, now] = withFuel.slice(-2);
    if (!prev || !now) continue;
    const change = now[fuel]!.per_day / prev[fuel]!.per_day - 1;
    const m = Number(now.month.slice(5, 7));
    const heating = fuel === "gas" && change > 0.1 && (m >= 9 || m <= 1) ? ", as the heating comes on" : "";
    return `${more(change, `${fuel} a day`, monthName(prev.month))}${heating}.`;
  }
  return "";
}

export function baseloadTakeaway(b: Baseload): string {
  const cost = b.cost_year_p !== undefined ? `, about £${Math.round(b.cost_year_p / 100).toLocaleString("en-GB")} a year` : "";
  return `Things left on all the time use ${pct(b.share)} of your electricity: ${b.kwh_year.toLocaleString("en-GB")} kWh a year${cost}.`;
}

export function peakTakeaway(p: PeakShare): string {
  const cheap = p.cheap !== undefined ? ` ${pct(p.cheap)} is used in the cheap hours.` : "";
  return `${pct(p.peak)} of your electricity is used between 16:00 and 19:00.${cheap}`;
}

// ---------- The page's energy, all together ----------

export interface HouseEnergy {
  today: {
    date: string;
    half_hours: number[];
    typical: number[];
    now_slot: number;
    kwh: number;
    /** Pence per half hour and the day's total with its standing charge, when priced. */
    slot_cost?: number[];
    cost_p?: number;
    /** Cheap half hours on a time-of-use tariff. */
    cheap?: boolean[];
  } | null;
  heatmap: Heatmap;
  daily: DailyPoint[];
  months: MonthPoint[];
  yoy: YearOnYear[];
  baseload: Baseload | null;
  peak: PeakShare | null;
  rates: Partial<Record<Fuel, CurrentRate>>;
  /** Which fuels the home has. */
  fuels: Fuel[];
  /** The Trends card (lib/house-trends.ts). */
  trends: EnergyTrends | null;
  takeaways: { today: string; week: string; daily: string; monthly: string; baseload: string; peak: string };
}

/** Everything the energy half of the page draws, from the days and (when there is one) the tariff. */
export function houseEnergy(input: {
  days: Map<string, HomeDayFigures>;
  months: HomeMonth[];
  tariff: TariffStore | null;
  today: string;
  now: Date;
  tz: string;
  /** The home's daily mean temperatures for gas allowing for the weather, or why there are none. */
  weather?: { temps: Map<string, number> } | { missing: "no_home" | "unavailable" };
}): HouseEnergy | null {
  const { days, tariff, today, now, tz } = input;
  if (!days.size) return null;
  const costs = new Map<string, DayCost>();
  if (tariff?.agreements.length) for (const [date, d] of days) {
    const c = priceDay(date, d, tariff, tz);
    if (c.electricity || c.gas) costs.set(date, c);
  }
  const rates = currentRates(tariff, today, now, tz);
  const lt = latestAndTypical(days, now, tz);
  const heatmap = weekHeatmap(days);
  const daily = dailySeries(days, costs);
  const months = monthSeries(input.months, costs);
  const yoy = yearOnYear(months);
  const base = baseload(days, rates.electricity?.average_p);
  const peak = peakShare(days, costs);
  const lc = lt ? costs.get(lt.date)?.electricity : undefined;
  const cheap = lc ? cheapSlots(lc.rates) : undefined;
  const fuels: Fuel[] = [];
  if ([...days.values()].some((d) => d.kwh !== undefined)) fuels.push("electricity");
  if ([...days.values()].some((d) => d.gas_kwh !== undefined)) fuels.push("gas");
  return {
    today: lt ? { ...lt, ...(lc ? { slot_cost: lc.slots, cost_p: lc.total_p } : {}), ...(cheap?.some(Boolean) ? { cheap } : {}) } : null,
    heatmap,
    daily,
    months: months.slice(-24),
    yoy,
    baseload: base,
    peak,
    rates,
    fuels,
    trends: energyTrends({ days, costs, weather: input.weather }),
    takeaways: {
      today: lt ? todayTakeaway(lt, today) : "",
      week: weekTakeaway(heatmap),
      daily: dailyTakeaway(daily),
      monthly: monthlyTakeaway(months, yoy),
      baseload: base ? baseloadTakeaway(base) : "",
      peak: peak ? peakTakeaway(peak) : "",
    },
  };
}

export interface HouseData {
  today: string;
  /** null: no meter connected, or no readings yet. */
  energy: HouseEnergy | null;
  /** Is there a meter account at all, and how costs stand: priced, the account number not set, or set but its tariff not read yet. */
  meter: boolean;
  /** A smart meter account is connected (Octopus). False with only readings typed in by hand. */
  meter_account?: boolean;
  /** Meter readings typed in by hand (lib/meter-readings.ts), newest first. */
  readings?: MeterReading[];
  costs: "priced" | "no_account" | "waiting";
  bills: { bank: boolean; items: HouseBill[]; monthly: { amount: number; currency: string } | null };
  /** The home's appliances as Athena last saw them (lib/home-appliances.ts). Absent when no appliance account is connected. */
  appliances?: HouseAppliance[];
}

// ---------- Household bills ----------

export type BillType = "housing" | "council_tax" | "energy" | "water" | "broadband" | "phone" | "tv_licence" | "insurance";

export const BILL_WORDS: Record<BillType, string> = {
  housing: "Rent or mortgage",
  council_tax: "Council tax",
  energy: "Energy",
  water: "Water",
  broadband: "Broadband",
  phone: "Phone",
  tv_licence: "TV licence",
  insurance: "Home insurance",
};

/** Checked in this order: the first that fits names the bill. Matched against the payee as the bank gives it, never shown. */
const BILL_RULES: Array<[BillType, RegExp]> = [
  ["tv_licence", /\btv ?licen[cs]/],
  ["council_tax", /\bcouncil\b|\bborough\b|\bctax\b/],
  ["water", /\bwater\b|\bthames\b|severn trent|\banglian\b|united utilities|dwr cymru|\baffinity\b|\bwessex\b|\bscottish water\b/],
  ["energy", /\boctopus\b|british gas|\bedf\b|\be ?on\b|\bovo\b|scottish power|\bsse\b|so energy|utility warehouse|\boutfox\b|shell energy|\bbulb\b|\benergy\b|\belectric(ity)?\b|\bgas\b/],
  ["broadband", /broadband|\bfibre\b|virgin media|\bplusnet\b|talk ?talk|\bhyperoptic\b|\bzen internet\b|\bbt\b|\bsky\b|\bcuckoo\b|\bonestream\b|\binternet\b/],
  ["phone", /\bee\b|\bo2\b|\bthree\b|\bgiffgaff\b|\bvodafone\b|tesco mobile|\bvoxi\b|\bsmarty\b|\blebara\b|\bid mobile\b|\bmobile\b|\bphone\b/],
  ["housing", /\brent\b|\bmortgage\b|\blettings?\b|\blandlord\b|\bletting agents?\b/],
  ["insurance", /home ?insurance|\bcontents\b|\bbuildings insurance\b|\bhomeserve\b|home emergency|boiler cover|\bhome cover\b/],
];

export function billTypeOf(key: string, name = ""): BillType | null {
  const s = `${key} ${name.toLowerCase()}`;
  for (const [type, re] of BILL_RULES) if (re.test(s)) return type;
  return null;
}

export interface HouseBill {
  key: string;
  name: string;
  type: BillType;
  cadence: RegularPayment["cadence"];
  currency: string;
  last_amount: number;
  last_on: string;
  next_on: string;
  /** What it comes to a month, minor units. */
  monthly: number;
  missed?: { due_on: string };
  rise?: RegularPayment["rise"];
}

const BILL_ORDER: BillType[] = ["housing", "council_tax", "energy", "water", "broadband", "phone", "tv_licence", "insurance"];

/** The household bills among the regular payments, biggest kind first, and what they come to a month. */
export function householdBills(items: RegularPayment[]): { items: HouseBill[]; monthly: { amount: number; currency: string } | null } {
  const out: HouseBill[] = [];
  for (const r of items) {
    const type = billTypeOf(r.key, r.name);
    if (!type) continue;
    out.push({
      key: r.key,
      name: r.name,
      type,
      cadence: r.cadence,
      currency: r.currency,
      last_amount: r.last_amount,
      last_on: r.last_on,
      next_on: r.next_on,
      monthly: r.monthly,
      ...(r.missed ? { missed: r.missed } : {}),
      ...(r.rise ? { rise: r.rise } : {}),
    });
  }
  out.sort((a, b) => BILL_ORDER.indexOf(a.type) - BILL_ORDER.indexOf(b.type) || b.monthly - a.monthly);
  const currency = out[0]?.currency;
  return { items: out, monthly: currency ? { currency, amount: sum(out.filter((b) => b.currency === currency).map((b) => b.monthly)) } : null };
}

// ---------- House admin ----------

/** A Life admin item, as much of it as the filter reads. */
export interface AdminItem {
  kind: string;
  name: string;
  provider?: string;
  notes?: string;
  renews_on?: string | null;
}

const HOUSE_WORDS =
  /\b(boiler|gas safe(ty)?|gas check|home|house|household|buildings?|contents|appliances?|washing machine|washer|dishwasher|fridge|freezer|oven|hob|cooker|tumble|dryer|chimney|eicr|electrical (check|safety|certificate)|smoke alarms?|carbon monoxide|roof|gutters?|damp|tv licen[cs]e|council tax|mortgage|tenancy|lease|landlord|burglar alarm|heat pump|solar|septic|drains?|plumb\w*|kitchen|bathroom)\b/i;
const NOT_HOUSE = /\b(car|van|vehicle|motor|bike|travel|pet|dog|cat|health|dental|life insurance|phone insurance|gadget)\b/i;

/** About the home: the Home kind, or a policy, warranty or other item whose words are about the house. */
export function isHouseItem(a: AdminItem): boolean {
  if (a.kind === "home") return true;
  if (!["insurance", "warranty", "subscription", "licence", "other"].includes(a.kind)) return false;
  const text = [a.name, a.provider ?? "", a.notes ?? ""].join(" ");
  return HOUSE_WORDS.test(text) && !NOT_HOUSE.test(`${a.name} ${a.provider ?? ""}`);
}

/** The house's items, the soonest due first, undated last. */
export function houseAdmin<T extends AdminItem>(items: T[]): T[] {
  return items.filter(isHouseItem).sort((a, b) => (a.renews_on ?? "9999").localeCompare(b.renews_on ?? "9999") || a.name.localeCompare(b.name));
}
