/**
 * House's Trends card (views/house.ts, Ask's energy tool): each fuel's use
 * against an earlier period, always per day so a part month compares fairly.
 *
 *  - Month on month: this month so far against last month.
 *  - Same month last year.
 *  - The last 12 months against the 12 before, and the year so far against
 *    the same dates last year: only when the readings cover both periods,
 *    otherwise how many more months they need.
 *  - Month-end forecast: at this month's daily rate, recent days weighted a
 *    little more. Not in the first 3 days of a month.
 *  - Gas allowing for the weather: heating degree days (base 15.5°C) from the
 *    day's mean temperature at home (lib/weather.ts dailyMeans), and a straight
 *    line fitted to the owner's own gas against them (a baseload plus so much
 *    per degree day). Electricity is never adjusted.
 *
 * £ only when every day of both periods was priced: a priced figure is never
 * set against an unpriced one. Pure, so the server and sample mode agree.
 */
import { addDays, daysBetween } from "./dates";
import type { HomeDayFigures } from "./money";
import type { DayCost, Fuel } from "./tariff";

/** Heating degree days are counted below this mean temperature, °C. */
export const HDD_BASE = 15.5;
/** The fit needs this many days of gas with a temperature. */
export const FIT_MIN_DAYS = 60;
/** And a spread of weather: the degree days' standard deviation at least this. */
export const FIT_MIN_SPREAD = 1.5;
/** No forecast while the month has this many days or fewer. */
export const FORECAST_HIDE_DAYS = 3;
/** A period counts when readings cover at least this share of its days. */
export const MIN_COVER = 0.5;

// `|| 0`: never -0.
const r1 = (n: number) => Math.round(n * 10) / 10 || 0;
const r2 = (n: number) => Math.round(n * 100) / 100 || 0;
const r3 = (n: number) => Math.round(n * 1000) / 1000 || 0;
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
const monthName = (m: string, year = false) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const prevMonth = (month: string) => addDays(`${month}-01`, -1).slice(0, 7);
const yearBefore = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
/** The same day a year before; 29 February becomes the 28th. */
const dayYearBefore = (date: string) => (date.slice(5) === "02-29" ? `${Number(date.slice(0, 4)) - 1}-02-28` : yearBefore(date));

const fuelKwh = (d: HomeDayFigures | undefined, fuel: Fuel) => (fuel === "electricity" ? d?.kwh : d?.gas_kwh);

// ---------- Degree days and the fit ----------

/** One day's heating degree days from its mean temperature. */
export const hdd = (mean: number): number => Math.max(0, HDD_BASE - mean);

/** Heating degree days over [from, to], from the days that have a temperature. */
export function hddSum(temps: Map<string, number>, from: string, to: string): { hdd: number; days: number } {
  let total = 0;
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t = temps.get(d);
    if (t === undefined) continue;
    total += hdd(t);
    days++;
  }
  return { hdd: r2(total), days };
}

/** One day for the card's scatter: date, mean temperature °C, gas kWh. The last SCATTER_DAYS only. */
export type GasPoint = [string, number, number];
export const SCATTER_DAYS = 365;

export interface GasFit {
  /** kWh a day with no heating: hot water and cooking. */
  baseload: number;
  /** kWh more for each degree day. */
  per_hdd: number;
  days: number;
  /** How much of the day-to-day change the weather explains, 0 to 1. */
  r2: number;
}

/** A least-squares line through (degree days, gas kWh); null with too few days, too little spread or a line that doesn't rise. */
export function fitGas(pairs: Array<[number, number]>): GasFit | null {
  const n = pairs.length;
  if (n < FIT_MIN_DAYS) return null;
  const mx = sum(pairs.map((p) => p[0])) / n;
  const my = sum(pairs.map((p) => p[1])) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (Math.sqrt(sxx / n) < FIT_MIN_SPREAD) return null;
  const slope = sxy / sxx;
  if (!(slope > 0)) return null;
  const intercept = my - slope * mx;
  return { baseload: r3(intercept), per_hdd: r3(slope), days: n, r2: syy ? r2((sxy * sxy) / (sxx * syy)) : 0 };
}

/** The pairs to fit from: every day with gas and a temperature. */
export function gasPairs(days: Map<string, HomeDayFigures>, temps: Map<string, number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [date, d] of days) {
    const t = temps.get(date);
    if (d.gas_kwh === undefined || t === undefined) continue;
    out.push([hdd(t), d.gas_kwh]);
  }
  return out;
}

// ---------- Periods ----------

export interface Side {
  /** "November so far", "October", "November 2025", "Forecast for November". */
  name: string;
  from: string;
  to: string;
  /** Days with a reading for the fuel. */
  days: number;
  kwh: number;
  per_day: number;
  /** When every one of those days was priced, with standing charges. */
  cost_p?: number;
  cost_per_day_p?: number;
}

interface Totals {
  days: number;
  span: number;
  kwh: number;
  cost_p?: number;
  dates: string[];
}

function totals(days: Map<string, HomeDayFigures>, costs: Map<string, DayCost>, fuel: Fuel, from: string, to: string): Totals {
  let kwh = 0;
  let cost = 0;
  let priced = true;
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = fuelKwh(days.get(d), fuel);
    if (v === undefined) continue;
    dates.push(d);
    kwh += v;
    const c = costs.get(d)?.[fuel]?.total_p;
    if (c === undefined) priced = false;
    else cost += c;
  }
  return { days: dates.length, span: daysBetween(from, to) + 1, kwh, ...(priced && dates.length ? { cost_p: cost } : {}), dates };
}

function side(name: string, from: string, to: string, t: Totals): Side {
  return {
    name,
    from,
    to,
    days: t.days,
    kwh: r1(t.kwh),
    per_day: r2(t.kwh / t.days),
    ...(t.cost_p !== undefined ? { cost_p: Math.round(t.cost_p), cost_per_day_p: Math.round(t.cost_p / t.days) } : {}),
  };
}

/** A period the readings support: enough of its days, and at least 3. */
const enough = (t: Totals) => t.days >= 3 && t.days >= t.span * MIN_COVER;

// ---------- Comparisons ----------

export type TrendKind = "month" | "year" | "rolling" | "ytd" | "forecast";

export interface WeatherAdjusted {
  /** Mean temperature over each period's gas days, °C. */
  temp: number;
  other_temp: number;
  /** The raw change in gas a day, and the change once the weather is allowed for. */
  change: number;
  adjusted: number;
}

export interface Against {
  other: Side;
  /** kWh a day: +0.12 is 12% more. */
  change: number;
  /** £ a day, only when both sides are priced. */
  cost_change?: number;
  weather?: WeatherAdjusted;
}

export interface TrendRow {
  kind: TrendKind;
  fuel: Fuel;
  label: string;
  this: Side;
  /** One, or for the forecast up to two: last month and the same month last year. */
  against: Against[];
  /** The forecast only: what's been used so far this month, for the card's progress bar. */
  so_far?: { kwh: number; cost_p?: number; days: number };
}

/** Rolling 12 months and the year so far, when the readings start too late: how many more months they need. */
export interface TrendNeed {
  kind: "rolling" | "ytd" | "year";
  fuel: Fuel;
  months: number;
}

export type WeatherMissing = "no_home" | "history" | "unavailable";

export interface EnergyTrends {
  /** The latest day with a reading. */
  as_of: string;
  rows: TrendRow[];
  needs: TrendNeed[];
  /** Gas only: the fit, or why there isn't one. Absent without gas. */
  gas_weather?: { fit: GasFit; points: GasPoint[] } | { missing: WeatherMissing };
  /** "12% more gas a day than October, but it was 2° colder. About the same once the weather is allowed for." */
  weather_line?: string;
  takeaway: string;
  /** The same line for one fuel at a time, for the card's Electricity / Gas switch. */
  fuel_takeaways: Partial<Record<Fuel, string>>;
}

function compare(a: Side, b: Side): Against {
  return {
    other: b,
    change: r2(a.per_day / b.per_day - 1),
    ...(a.cost_per_day_p !== undefined && b.cost_per_day_p !== undefined && b.cost_per_day_p > 0 ? { cost_change: r2(a.cost_p! / a.days / (b.cost_p! / b.days) - 1) } : {}),
  };
}

/** Gas a day against the line for each period's weather; null unless 80% of the gas days have a temperature. */
export function weatherAdjust(days: Map<string, HomeDayFigures>, temps: Map<string, number>, fit: GasFit, a: Side, b: Side): WeatherAdjusted | null {
  const period = (s: Side) => {
    const ts: number[] = [];
    let gas = 0;
    let n = 0;
    for (let d = s.from; d <= s.to; d = addDays(d, 1)) {
      const g = days.get(d)?.gas_kwh;
      if (g === undefined) continue;
      n++;
      const t = temps.get(d);
      if (t === undefined) continue;
      ts.push(t);
      gas += g;
    }
    if (!n || ts.length < n * 0.8) return null;
    const meanHdd = sum(ts.map(hdd)) / ts.length;
    const expected = fit.baseload + fit.per_hdd * meanHdd;
    return expected > 0 ? { temp: sum(ts) / ts.length, ratio: gas / ts.length / expected } : null;
  };
  const pa = period(a);
  const pb = period(b);
  if (!pa || !pb) return null;
  return { temp: r1(pa.temp), other_temp: r1(pb.temp), change: r2(a.per_day / b.per_day - 1), adjusted: r2(pa.ratio / pb.ratio - 1) };
}

/** Months from `need` to `have` (dates), rounded up: how much more history a comparison needs. */
const monthsShort = (need: string, have: string) => Math.max(1, Math.ceil(daysBetween(need, have) / 30.44));

// ---------- Forecast ----------

/** Recent days weigh more: from 1 for the month's first day to 2 for the latest. */
export function weightedRate(values: Array<{ date: string; v: number }>, first: string, latest: string): number {
  const spanDays = daysBetween(first, latest);
  let ws = 0;
  let wv = 0;
  for (const { date, v } of values) {
    const w = spanDays ? 1 + daysBetween(first, date) / spanDays : 1;
    ws += w;
    wv += w * v;
  }
  return ws ? wv / ws : 0;
}

/** The month's total at its current daily rate: what's been used, and the rate for every day without a reading. */
export function forecastMonth(days: Map<string, HomeDayFigures>, costs: Map<string, DayCost>, fuel: Fuel, asOf: string): Side | null {
  const month = asOf.slice(0, 7);
  const end = lastDay(month);
  if (Number(asOf.slice(8, 10)) <= FORECAST_HIDE_DAYS || asOf >= end) return null;
  const first = `${month}-01`;
  const t = totals(days, costs, fuel, first, asOf);
  if (t.days < 3) return null;
  const left = daysBetween(first, end) + 1 - t.days;
  const kwhRate = weightedRate(t.dates.map((d) => ({ date: d, v: fuelKwh(days.get(d), fuel)! })), first, asOf);
  const kwh = t.kwh + kwhRate * left;
  const n = t.span + daysBetween(asOf, end);
  let cost: number | undefined;
  if (t.cost_p !== undefined) cost = t.cost_p + weightedRate(t.dates.map((d) => ({ date: d, v: costs.get(d)![fuel]!.total_p })), first, asOf) * left;
  return {
    name: `Forecast for ${monthName(month)}`,
    from: first,
    to: end,
    days: n,
    kwh: r1(kwh),
    per_day: r2(kwh / n),
    ...(cost !== undefined ? { cost_p: Math.round(cost), cost_per_day_p: Math.round(cost / n) } : {}),
  };
}

// ---------- All of it ----------

/** The month the month-on-month and last-year rows are about: the latest with 3 days of readings, else the one before. */
function currentMonth(days: Map<string, HomeDayFigures>, fuel: Fuel, asOf: string): { month: string; to: string } {
  const month = asOf.slice(0, 7);
  let n = 0;
  for (let d = `${month}-01`; d <= asOf; d = addDays(d, 1)) if (fuelKwh(days.get(d), fuel) !== undefined) n++;
  if (n >= 3) return { month, to: asOf };
  const prev = prevMonth(month);
  return { month: prev, to: lastDay(prev) };
}

function fuelRows(days: Map<string, HomeDayFigures>, costs: Map<string, DayCost>, fuel: Fuel, asOf: string, firstReading: string): { rows: TrendRow[]; needs: TrendNeed[] } {
  const rows: TrendRow[] = [];
  const needs: TrendNeed[] = [];
  const t = (from: string, to: string) => totals(days, costs, fuel, from, to);

  // Month on month, and the same month last year.
  const cur = currentMonth(days, fuel, asOf);
  const curFrom = `${cur.month}-01`;
  const curT = t(curFrom, cur.to);
  if (enough(curT)) {
    const partial = cur.to < lastDay(cur.month);
    const thisSide = side(partial ? `${monthName(cur.month)} so far` : monthName(cur.month), curFrom, cur.to, curT);
    const pm = prevMonth(cur.month);
    const pmT = t(`${pm}-01`, lastDay(pm));
    if (enough(pmT)) rows.push({ kind: "month", fuel, label: "Month on month", this: thisSide, against: [compare(thisSide, side(monthName(pm), `${pm}-01`, lastDay(pm), pmT))] });
    const ly = yearBefore(cur.month);
    const lyT = t(`${ly}-01`, lastDay(ly));
    if (enough(lyT)) rows.push({ kind: "year", fuel, label: "Same month last year", this: thisSide, against: [compare(thisSide, side(monthName(ly, true), `${ly}-01`, lastDay(ly), lyT))] });
    else if (firstReading > `${ly}-01`) needs.push({ kind: "year", fuel, months: monthsShort(`${ly}-01`, firstReading) });
  }

  // The last 12 months against the 12 before.
  const r12From = addDays(asOf, -364);
  const p12To = addDays(r12From, -1);
  const p12From = addDays(p12To, -364);
  if (firstReading > p12From) needs.push({ kind: "rolling", fuel, months: monthsShort(p12From, firstReading) });
  else {
    const a = t(r12From, asOf);
    const b = t(p12From, p12To);
    if (enough(a) && enough(b)) {
      const sa = side("Last 12 months", r12From, asOf, a);
      rows.push({ kind: "rolling", fuel, label: "12 months against the 12 before", this: sa, against: [compare(sa, side("the 12 months before", p12From, p12To, b))] });
    }
  }

  // The year so far against the same dates last year. In January that's the month row again.
  if (asOf.slice(5, 7) !== "01") {
    const yFrom = `${asOf.slice(0, 4)}-01-01`;
    const lyFrom = yearBefore(yFrom);
    const lyTo = dayYearBefore(asOf);
    if (firstReading > lyFrom) needs.push({ kind: "ytd", fuel, months: monthsShort(lyFrom, firstReading) });
    else {
      const a = t(yFrom, asOf);
      const b = t(lyFrom, lyTo);
      if (enough(a) && enough(b)) {
        const sa = side(`1 Jan to ${shortDay(asOf)}`, yFrom, asOf, a);
        rows.push({ kind: "ytd", fuel, label: "Year to date", this: sa, against: [compare(sa, side(`the same dates in ${lyFrom.slice(0, 4)}`, lyFrom, lyTo, b))] });
      }
    }
  }

  // The month-end forecast, against last month and the same month last year.
  const f = forecastMonth(days, costs, fuel, asOf);
  if (f) {
    const month = asOf.slice(0, 7);
    const against: Against[] = [];
    for (const [m, name] of [[prevMonth(month), monthName(prevMonth(month))], [yearBefore(month), monthName(yearBefore(month), true)]] as const) {
      const mt = t(`${m}-01`, lastDay(m));
      if (enough(mt)) against.push(compare(f, side(name, `${m}-01`, lastDay(m), mt)));
    }
    const sf = t(`${month}-01`, asOf);
    if (against.length) rows.push({ kind: "forecast", fuel, label: `By ${shortDay(lastDay(month))}`, this: f, against, so_far: { kwh: r1(sf.kwh), days: sf.days, ...(sf.cost_p !== undefined && f.cost_p !== undefined ? { cost_p: Math.round(sf.cost_p) } : {}) } });
  }
  return { rows, needs };
}

/** "8% less", "12% more", "About the same" (under 3%). */
export function changeWord(change: number): string {
  const n = Math.round(Math.abs(change) * 100);
  return n < 3 ? "About the same" : `${n}% ${change > 0 ? "more" : "less"}`;
}

/** "↑", "↓" or "→", to go with changeWord. */
export const changeArrow = (change: number): string => (Math.round(Math.abs(change) * 100) < 3 ? "→" : change > 0 ? "↑" : "↓");

/** "12% more gas a day than October, but it was 2° colder. About the same once the weather is allowed for." */
export function weatherLine(w: WeatherAdjusted, than: string): string {
  const n = Math.round(Math.abs(w.change) * 100);
  const raw = n < 3 ? `About the same gas a day as ${than}` : `${n}% ${w.change > 0 ? "more" : "less"} gas a day than ${than}`;
  const colder = Math.round(w.other_temp - w.temp);
  let temp: string;
  if (colder === 0) temp = n < 3 ? ", and the weather was much the same" : ", with much the same weather";
  else {
    const explains = n >= 3 && (colder > 0) === w.change > 0;
    temp = `${n < 3 ? ", and" : explains ? ", but" : ", even though"} it was ${Math.abs(colder)}° ${colder > 0 ? "colder" : "warmer"}`;
  }
  const a = Math.round(Math.abs(w.adjusted) * 100);
  const adjusted = a < 3 ? "About the same once the weather is allowed for." : `${a}% ${w.adjusted > 0 ? "more" : "less"} once the weather is allowed for.`;
  return `${raw}${temp}. ${adjusted}`;
}

const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString("en-GB")}`;

/** The card's one line: the weather when it says something, else the forecast, else this month against the last. */
export function trendsTakeaway(rows: TrendRow[], weather?: string): string {
  const gasMonth = rows.find((r) => r.kind === "month" && r.fuel === "gas")?.against[0];
  if (weather && gasMonth?.weather && (Math.abs(gasMonth.weather.change) >= 0.05 || Math.abs(gasMonth.weather.other_temp - gasMonth.weather.temp) >= 1)) return weather;
  const forecasts = rows.filter((r) => r.kind === "forecast");
  const month = forecasts[0]?.this.from.slice(0, 7);
  if (forecasts.length) {
    const vsLast = (r: TrendRow) => r.against.find((a) => a.other.to.slice(0, 7) === prevMonthOf(r.this.from));
    // Every fuel priced, and each against last month: the whole bill.
    if (forecasts.every((r) => r.this.cost_p !== undefined && vsLast(r)?.other.cost_p !== undefined)) {
      const total = sum(forecasts.map((r) => r.this.cost_p!));
      const perDay = total / (daysBetween(forecasts[0].this.from, forecasts[0].this.to) + 1);
      const last = forecasts.map((r) => vsLast(r)!.other);
      const lastPerDay = sum(last.map((s) => s.cost_p!)) / (daysBetween(last[0].from, last[0].to) + 1);
      const c = perDay / lastPerDay - 1;
      const words = Math.round(Math.abs(c) * 100) < 3 ? `about the same a day as ${last[0].name}` : `${changeWord(c).toLowerCase()} a day than ${last[0].name}`;
      return `${monthName(month)} is on course for about ${pounds(total)} of ${forecasts.length > 1 ? "energy" : forecasts[0].fuel}, ${words}.`;
    }
    const r = forecasts.find((x) => x.fuel === "gas") ?? forecasts[0];
    const a = vsLast(r) ?? r.against[0];
    const words = Math.round(Math.abs(a.change) * 100) < 3 ? `about the same a day as ${a.other.name}` : `${changeWord(a.change).toLowerCase()} a day than ${a.other.name}`;
    return `${monthName(month)} is on course for about ${Math.round(r.this.kwh).toLocaleString("en-GB")} kWh of ${r.fuel}, ${words}.`;
  }
  for (const kind of ["month", "year", "ytd", "rolling"] as const) {
    const r = rows.find((x) => x.kind === kind && x.fuel === "gas") ?? rows.find((x) => x.kind === kind);
    if (!r) continue;
    const a = r.against[0];
    const n = Math.round(Math.abs(a.change) * 100);
    return n < 3 ? `${r.this.name}: about the same ${r.fuel} a day as ${a.other.name}.` : `${r.this.name}: ${n}% ${a.change > 0 ? "more" : "less"} ${r.fuel} a day than ${a.other.name}.`;
  }
  return "";
}
const prevMonthOf = (from: string) => prevMonth(from.slice(0, 7));

/**
 * Every row the readings support, per fuel, with gas allowed for the weather
 * when there are temperatures and enough history. `weather` is the home's
 * daily mean temperatures, or why there are none.
 */
export function energyTrends(input: { days: Map<string, HomeDayFigures>; costs: Map<string, DayCost>; weather?: { temps: Map<string, number> } | { missing: "no_home" | "unavailable" } }): EnergyTrends | null {
  const { days, costs } = input;
  const dates = [...days.keys()].sort();
  const asOf = dates[dates.length - 1];
  if (!asOf) return null;
  const rows: TrendRow[] = [];
  const needs: TrendNeed[] = [];
  const fuels: Fuel[] = (["electricity", "gas"] as const).filter((f) => dates.some((d) => fuelKwh(days.get(d), f) !== undefined));
  for (const fuel of fuels) {
    const first = dates.find((d) => fuelKwh(days.get(d), fuel) !== undefined)!;
    const latest = [...dates].reverse().find((d) => fuelKwh(days.get(d), fuel) !== undefined)!;
    const r = fuelRows(days, costs, fuel, latest, first);
    rows.push(...r.rows);
    needs.push(...r.needs);
  }
  const out: EnergyTrends = { as_of: asOf, rows, needs, takeaway: "", fuel_takeaways: {} };
  if (fuels.includes("gas")) {
    const w = input.weather;
    if (!w) out.gas_weather = { missing: "unavailable" };
    else if ("missing" in w) out.gas_weather = { missing: w.missing };
    else {
      const fit = fitGas(gasPairs(days, w.temps));
      if (!fit) out.gas_weather = { missing: "history" };
      else {
        const since = addDays(asOf, -(SCATTER_DAYS - 1));
        const points: GasPoint[] = dates.filter((d) => d >= since && days.get(d)?.gas_kwh !== undefined && w.temps.has(d)).map((d) => [d, r1(w.temps.get(d)!), r1(days.get(d)!.gas_kwh!)]);
        out.gas_weather = { fit, points };
        for (const r of rows) {
          if (r.fuel !== "gas" || (r.kind !== "month" && r.kind !== "year")) continue;
          const adj = weatherAdjust(days, w.temps, fit, r.this, r.against[0].other);
          if (adj) r.against[0].weather = adj;
        }
        const m = rows.find((r) => r.fuel === "gas" && r.kind === "month")?.against[0];
        if (m?.weather) out.weather_line = weatherLine(m.weather, m.other.name);
      }
    }
  }
  out.takeaway = trendsTakeaway(rows, out.weather_line);
  for (const fuel of fuels) out.fuel_takeaways[fuel] = trendsTakeaway(rows.filter((r) => r.fuel === fuel), fuel === "gas" ? out.weather_line : undefined);
  return out;
}

/** Why gas isn't allowed for the weather, in one line. */
export const WEATHER_MISSING_WORDS: Record<WeatherMissing, string> = {
  no_home: "Gas isn't adjusted for the weather until Athena knows where home is. Add a place called Home with its address in Places.",
  history: `Gas is adjusted for the weather once there are ${FIT_MIN_DAYS} days of readings with both mild and cold days.`,
  unavailable: "Gas isn't adjusted for the weather right now: the weather service didn't answer. It tries again next time.",
};

/** "The last 12 months against the 12 before shows in 10 more months." */
export function needWords(n: TrendNeed): string {
  const months = `${n.months} more month${n.months === 1 ? "" : "s"}`;
  if (n.kind === "year") return `The same month last year shows in ${months}.`;
  return n.kind === "rolling" ? `The last 12 months against the 12 before shows in ${months}.` : `The year so far against last year shows in ${months}.`;
}

/** The Trends card's views: each its own chart and one line. Weather is gas only. */
export type TrendView = "month" | "year" | "rolling" | "weather";
export const VIEW_KINDS: Record<TrendView, TrendKind[]> = { month: ["forecast", "month"], year: ["year", "ytd"], rolling: ["rolling"], weather: ["month", "year"] };

/** One plain line for a view of one fuel: the forecast or this month, last year, the 12 months, or the weather. "" when the view has nothing yet. */
export function viewTakeaway(t: EnergyTrends, fuel: Fuel, view: TrendView): string {
  if (view === "weather") return fuel === "gas" ? (t.weather_line ?? "") : "";
  const rows = t.rows.filter((r) => r.fuel === fuel && VIEW_KINDS[view].includes(r.kind));
  // This month: the forecast's figure is the headline, so the line says how the month's going so far.
  return trendsTakeaway(rows.some((r) => r.kind === "month") ? rows.filter((r) => r.kind !== "forecast") : rows);
}
