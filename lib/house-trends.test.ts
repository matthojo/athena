// Run: npx tsx --test lib/house-trends.test.ts
// House's Trends card: each comparison per day, £ only when both sides are priced, the forecast, gas allowing for the weather, the takeaways.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "./dates";
import type { HomeDayFigures } from "./money";
import type { DayCost } from "./tariff";
import {
  changeArrow,
  changeWord,
  energyTrends,
  fitGas,
  forecastMonth,
  gasPairs,
  hdd,
  hddSum,
  needWords,
  trendsTakeaway,
  weatherAdjust,
  weatherLine,
  weightedRate,
  WEATHER_MISSING_WORDS,
  type Side,
} from "./house-trends";
import { homeWeather } from "./house-data";
import { houseEnergy, homeMonths } from "./house";
import { dailyMeans, type MeanCache, type MonthMeans } from "./weather";

function range(from: string, to: string, make: (date: string, i: number) => HomeDayFigures | null): Map<string, HomeDayFigures> {
  const m = new Map<string, HomeDayFigures>();
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1), i++) {
    const v = make(d, i);
    if (v) m.set(d, v);
  }
  return m;
}
const priceAll = (days: Map<string, HomeDayFigures>, pPerKwh = 25, standing = 50, skip: string[] = []): Map<string, DayCost> => {
  const out = new Map<string, DayCost>();
  for (const [d, f] of days) {
    if (skip.includes(d)) continue;
    const c: DayCost = {};
    if (f.kwh !== undefined) c.electricity = { unit_p: f.kwh * pPerKwh, standing_p: standing, total_p: f.kwh * pPerKwh + standing, slots: [], rates: [] };
    if (f.gas_kwh !== undefined) c.gas = { unit_p: f.gas_kwh * 6, standing_p: 30, total_p: f.gas_kwh * 6 + 30 };
    out.set(d, c);
  }
  return out;
};

// ---------- Comparisons ----------

test("month on month: November so far against October, per day, so a part month compares fairly", () => {
  const days = range("2026-10-01", "2026-11-09", (d) => ({ kwh: d < "2026-11-01" ? 10 : 11 }));
  const t = energyTrends({ days, costs: new Map() })!;
  assert.equal(t.as_of, "2026-11-09");
  const m = t.rows.find((r) => r.kind === "month")!;
  assert.equal(m.this.name, "November so far");
  assert.equal(m.this.days, 9);
  assert.equal(m.this.per_day, 11);
  assert.equal(m.against[0].other.name, "October");
  assert.equal(m.against[0].other.per_day, 10);
  assert.equal(m.against[0].change, 0.1);
  assert.equal(m.against[0].cost_change, undefined, "kWh only: no £");
  assert.equal(t.rows.some((r) => r.fuel === "gas"), false, "no gas, no gas rows");
  assert.equal(t.gas_weather, undefined);
});

test("month on month: the first two days of a month compare last month with the one before", () => {
  const days = range("2026-09-01", "2026-11-02", (d) => ({ kwh: d.slice(5, 7) === "09" ? 8 : 10 }));
  const m = energyTrends({ days, costs: new Map() })!.rows.find((r) => r.kind === "month")!;
  assert.equal(m.this.name, "October");
  assert.equal(m.against[0].other.name, "September");
  assert.equal(m.against[0].change, 0.25);
});

test("a gap in the data: per day over the days with readings; a period under half covered is left out", () => {
  // October with ten days missing still counts; per day ignores the gap.
  let days = range("2026-10-01", "2026-11-09", (d) => (d >= "2026-10-05" && d <= "2026-10-14" ? null : { kwh: 10 }));
  let m = energyTrends({ days, costs: new Map() })!.rows.find((r) => r.kind === "month")!;
  assert.equal(m.against[0].other.days, 21);
  assert.equal(m.against[0].other.per_day, 10);
  assert.equal(m.against[0].change, 0);
  // October with only ten days: not enough, the row isn't there at all.
  days = range("2026-10-22", "2026-11-09", () => ({ kwh: 10 }));
  m = energyTrends({ days, costs: new Map() })!.rows.find((r) => r.kind === "month")!;
  assert.equal(m, undefined);
});

test("missing periods: no last year, no row; rolling 12 and the year so far say how many months they need", () => {
  const days = range("2026-03-01", "2026-11-09", () => ({ kwh: 10 }));
  const t = energyTrends({ days, costs: new Map() })!;
  assert.deepEqual(t.rows.map((r) => r.kind).sort(), ["forecast", "month"]);
  const rolling = t.needs.find((n) => n.kind === "rolling")!;
  const ytd = t.needs.find((n) => n.kind === "ytd")!;
  // The 12 before start 2024-11-10; readings start 2026-03-01: about 16 months short.
  assert.equal(rolling.months, 16);
  // Last year's dates start 2025-01-01: 14 months short.
  assert.equal(ytd.months, 14);
  assert.equal(needWords(rolling), "The last 12 months against the 12 before shows in 16 more months.");
  assert.equal(needWords({ kind: "ytd", fuel: "gas", months: 1 }), "The year so far against last year shows in 1 more month.");
});

test("same month last year, the year so far and rolling 12 months, with two years of readings", () => {
  const days = range("2024-11-01", "2026-11-09", (d) => ({ kwh: d >= "2025-11-10" ? 9 : 10, gas_kwh: 20 }));
  const t = energyTrends({ days, costs: new Map(), weather: { missing: "no_home" } })!;
  const e = (k: string) => t.rows.find((r) => r.fuel === "electricity" && r.kind === k)!;
  assert.equal(e("year").against[0].other.name, "November 2025");
  // November 2025 was 10 a day until the 10th, 9 after.
  assert.equal(e("year").against[0].other.per_day, 9.3);
  assert.equal(e("year").against[0].change, -0.03);
  assert.equal(e("ytd").this.name, "1 Jan to 9 Nov");
  assert.equal(e("ytd").this.from, "2026-01-01");
  assert.equal(e("ytd").against[0].other.from, "2025-01-01");
  assert.equal(e("ytd").against[0].other.to, "2025-11-09");
  assert.equal(e("rolling").this.from, "2025-11-10");
  assert.equal(e("rolling").this.days, 365);
  assert.equal(e("rolling").against[0].other.to, "2025-11-09");
  assert.equal(e("rolling").against[0].change, -0.1);
  assert.equal(t.needs.length, 0);
  assert.deepEqual(t.gas_weather, { missing: "no_home" });
  assert.equal(t.rows.filter((r) => r.fuel === "gas").length, 5, "gas has every row too");
});

test("priced against unpriced: £ only when every day of both sides was priced", () => {
  const days = range("2026-10-01", "2026-11-09", (d) => ({ kwh: d < "2026-11-01" ? 10 : 11 }));
  // Every day priced: both sides carry £ and the £ change.
  let m = energyTrends({ days, costs: priceAll(days) })!.rows.find((r) => r.kind === "month")!;
  assert.equal(m.this.cost_p, Math.round(9 * (11 * 25 + 50)));
  assert.equal(m.this.cost_per_day_p, 325);
  assert.equal(m.against[0].other.cost_per_day_p, 300);
  assert.equal(m.against[0].cost_change, 0.08);
  // One October day unpriced: October has no £, so there's no £ change, though November keeps its own.
  m = energyTrends({ days, costs: priceAll(days, 25, 50, ["2026-10-15"]) })!.rows.find((r) => r.kind === "month")!;
  assert.equal(m.against[0].other.cost_p, undefined);
  assert.equal(m.against[0].cost_change, undefined);
  assert.equal(m.this.cost_p, 2925);
  assert.equal(m.against[0].change, 0.1, "kWh still compared");
});

// ---------- Forecast ----------

test("forecast weighting: the month's first day counts once, the latest twice", () => {
  assert.equal(weightedRate([{ date: "2026-11-01", v: 1 }, { date: "2026-11-03", v: 3 }], "2026-11-01", "2026-11-03"), 7 / 3);
  // Rising use: the weighted rate sits above the plain mean.
  const vals = [1, 2, 3, 4, 5].map((v, i) => ({ date: addDays("2026-11-01", i), v }));
  assert.ok(weightedRate(vals, "2026-11-01", "2026-11-05") > 3);
  assert.equal(weightedRate([{ date: "2026-11-01", v: 4 }], "2026-11-01", "2026-11-01"), 4);
});

test("forecast: hidden in the first 3 days and on the last; otherwise used so far plus the rate for the rest", () => {
  const days = range("2026-10-01", "2026-11-30", () => ({ kwh: 10, gas_kwh: 20 }));
  assert.equal(forecastMonth(days, new Map(), "electricity", "2026-11-03"), null);
  assert.equal(forecastMonth(days, new Map(), "electricity", "2026-11-30"), null);
  const f = forecastMonth(days, priceAll(days), "electricity", "2026-11-04")!;
  assert.equal(f.kwh, 300);
  assert.equal(f.per_day, 10);
  assert.equal(f.cost_p, 30 * 300);
  assert.equal(f.name, "Forecast for November");
  // A missing day is forecast at the rate too.
  const gap = new Map(days);
  gap.delete("2026-11-05");
  assert.equal(forecastMonth(gap, new Map(), "gas", "2026-11-09")!.kwh, 600);
  const t = energyTrends({ days: range("2025-11-01", "2026-11-09", () => ({ kwh: 10 })), costs: new Map() })!;
  const row = t.rows.find((r) => r.kind === "forecast")!;
  assert.equal(row.label, "By 30 Nov");
  assert.deepEqual(row.against.map((a) => a.other.name), ["October", "November 2025"]);
  // The month so far, for the card's progress bar.
  assert.deepEqual(row.so_far, { kwh: 90, days: 9 });
  assert.equal(energyTrends({ days: range("2025-11-01", "2026-11-03", () => ({ kwh: 10 })), costs: new Map() })!.rows.some((r) => r.kind === "forecast"), false);
});

// ---------- Degree days and the fit ----------

test("heating degree days: base 15.5°C, nothing on a warm day, summed over the days with a temperature", () => {
  assert.equal(hdd(10), 5.5);
  assert.equal(hdd(20), 0);
  const temps = new Map([["2026-11-01", 10], ["2026-11-02", 20], ["2026-11-03", 15.5], ["2026-11-05", 5]]);
  assert.deepEqual(hddSum(temps, "2026-11-01", "2026-11-05"), { hdd: 16, days: 4 });
});

/** Temperatures from 2° to 18° and back, a 60-day swing. */
const swing = (i: number) => 10 + 8 * Math.sin((i / 60) * 2 * Math.PI);

test("the fit: known gas gives back its baseload and kWh a degree day; too few days or too little spread, none", () => {
  const temps = new Map<string, number>();
  const days = range("2026-01-01", "2026-03-31", (d, i) => {
    temps.set(d, swing(i));
    return { gas_kwh: 8 + 3 * hdd(swing(i)) };
  });
  const fit = fitGas(gasPairs(days, temps))!;
  assert.equal(fit.baseload, 8);
  assert.equal(fit.per_hdd, 3);
  assert.equal(fit.days, 90);
  assert.equal(fit.r2, 1);
  assert.equal(fitGas(gasPairs(days, temps).slice(0, 59)), null, "under 60 days");
  assert.equal(fitGas(Array.from({ length: 90 }, (_, i) => [5 + (i % 2) * 0.5, 20] as [number, number])), null, "the same weather every day");
  assert.equal(fitGas(Array.from({ length: 90 }, (_, i) => [i % 10, 30 - i % 10] as [number, number])), null, "gas that falls as it gets colder");
});

test("adjusted change: more gas in a colder month is about the same once the weather is allowed for", () => {
  const fit = { baseload: 8, per_hdd: 3, days: 90, r2: 1 };
  const temps = new Map<string, number>();
  const days = range("2026-10-01", "2026-11-09", (d) => {
    const t = d < "2026-11-01" ? 10 : 8;
    temps.set(d, t);
    return { gas_kwh: 8 + 3 * hdd(t) };
  });
  const a: Side = { name: "November so far", from: "2026-11-01", to: "2026-11-09", days: 9, kwh: 0, per_day: 8 + 3 * 7.5 };
  const b: Side = { name: "October", from: "2026-10-01", to: "2026-10-31", days: 31, kwh: 0, per_day: 8 + 3 * 5.5 };
  const w = weatherAdjust(days, temps, fit, a, b)!;
  assert.equal(w.temp, 8);
  assert.equal(w.other_temp, 10);
  assert.equal(w.change, 0.24);
  assert.equal(w.adjusted, 0);
  // 10% more than the weather explains.
  for (let d = "2026-11-01"; d <= "2026-11-09"; d = addDays(d, 1)) days.set(d, { gas_kwh: (8 + 3 * 7.5) * 1.1 });
  assert.equal(weatherAdjust(days, temps, fit, a, b)!.adjusted, 0.1);
  // Too few temperatures: no adjustment.
  for (let d = "2026-11-01"; d <= "2026-11-05"; d = addDays(d, 1)) temps.delete(d);
  assert.equal(weatherAdjust(days, temps, fit, a, b), null);
});

test("the weather line, each way round", () => {
  assert.equal(weatherLine({ temp: 8, other_temp: 10, change: 0.12, adjusted: 0.01 }, "October"), "12% more gas a day than October, but it was 2° colder. About the same once the weather is allowed for.");
  assert.equal(weatherLine({ temp: 12, other_temp: 10, change: -0.2, adjusted: -0.08 }, "October"), "20% less gas a day than October, but it was 2° warmer. 8% less once the weather is allowed for.");
  assert.equal(weatherLine({ temp: 11, other_temp: 10, change: 0.1, adjusted: 0.2 }, "October"), "10% more gas a day than October, even though it was 1° warmer. 20% more once the weather is allowed for.");
  assert.equal(weatherLine({ temp: 10.2, other_temp: 10, change: 0.01, adjusted: 0.02 }, "October"), "About the same gas a day as October, and the weather was much the same. About the same once the weather is allowed for.");
  assert.equal(weatherLine({ temp: 7, other_temp: 10, change: 0.01, adjusted: -0.15 }, "October"), "About the same gas a day as October, and it was 3° colder. 15% less once the weather is allowed for.");
});

test("change words and arrows", () => {
  assert.equal(changeWord(-0.08), "8% less");
  assert.equal(changeWord(0.12), "12% more");
  assert.equal(changeWord(0.02), "About the same");
  assert.deepEqual([changeArrow(-0.08), changeArrow(0.12), changeArrow(0.01)], ["↓", "↑", "→"]);
});

// ---------- Gas and the weather in energyTrends ----------

test("gas allowing for the weather: the fit from the owner's history, the line on the month row; without enough history, why", () => {
  const temps = new Map<string, number>();
  const days = range("2026-08-01", "2026-11-09", (d, i) => {
    const t = d >= "2026-11-01" ? 4 : swing(i);
    temps.set(d, t);
    return { kwh: 9, gas_kwh: 7 + 2.5 * hdd(t) };
  });
  const t = energyTrends({ days, costs: new Map(), weather: { temps } })!;
  assert.ok("fit" in t.gas_weather!);
  // The scatter's days: date, temperature, gas, every day with both (fewer than a year here).
  const pts = (t.gas_weather as { points: Array<[string, number, number]> }).points;
  assert.equal(pts.length, days.size);
  assert.deepEqual(pts.at(-1), ["2026-11-09", 4, 35.8]);
  const g = t.rows.find((r) => r.fuel === "gas" && r.kind === "month")!.against[0].weather!;
  assert.ok(g.change > 0.3, `raw ${g.change}`);
  assert.equal(g.adjusted, 0);
  assert.match(t.weather_line!, /^\d+% more gas a day than October, but it was \d+° colder\. About the same once the weather is allowed for\.$/);
  assert.equal(t.takeaway, t.weather_line);
  assert.equal(t.rows.find((r) => r.fuel === "electricity" && r.kind === "month")!.against[0].weather, undefined, "electricity is never adjusted");
  // Forty days: not enough to fit.
  const short = new Map([...days].slice(-40));
  const s = energyTrends({ days: short, costs: new Map(), weather: { temps } })!;
  assert.deepEqual(s.gas_weather, { missing: "history" });
  assert.equal(s.weather_line, undefined);
  assert.match(WEATHER_MISSING_WORDS.history, /60 days/);
  assert.deepEqual(energyTrends({ days, costs: new Map() })!.gas_weather, { missing: "unavailable" });
});

// ---------- Takeaways ----------

test("takeaways: the forecast in £ when everything is priced, in kWh when not, else this month against the last", () => {
  const days = range("2026-09-01", "2026-11-09", (d) => ({ kwh: d < "2026-11-01" ? 10 : 9, gas_kwh: d < "2026-11-01" ? 20 : 18 }));
  const priced = energyTrends({ days, costs: priceAll(days) })!;
  // November: (9×25+50)+(18×6+30) = 413p a day × 30; October 450p a day.
  assert.equal(priced.takeaway, "November is on course for about £124 of energy, 8% less a day than October.");
  // One fuel at a time, for the card's switch: each names its own fuel.
  assert.match(priced.fuel_takeaways.electricity!, /^November is on course for about £\d+ of electricity, \d+% less a day than October\.$/);
  assert.match(priced.fuel_takeaways.gas!, /^November is on course for about £\d+ of gas, \d+% less a day than October\.$/);
  const kwh = energyTrends({ days, costs: new Map() })!;
  assert.equal(kwh.fuel_takeaways.electricity, "November is on course for about 270 kWh of electricity, 10% less a day than October.");
  assert.equal(kwh.takeaway, "November is on course for about 540 kWh of gas, 10% less a day than October.");
  // Day 3: no forecast, so the month row.
  const early = new Map([...days].filter(([d]) => d <= "2026-11-03"));
  assert.equal(energyTrends({ days: early, costs: new Map() })!.takeaway, "November so far: 10% less gas a day than October.");
  const flat = range("2026-09-01", "2026-11-03", () => ({ kwh: 10 }));
  assert.equal(energyTrends({ days: flat, costs: new Map() })!.takeaway, "November so far: about the same electricity a day as October.");
  assert.equal(trendsTakeaway([]), "");
});

// ---------- The real path: readings, Open-Meteo stubbed at fetch, degree days, the card ----------

test("real path: readings, then the home's temperatures from Open-Meteo (stubbed at fetch), then the card's data", async () => {
  const today = "2026-11-10";
  const days = range("2026-06-01", "2026-11-09", (d, i) => {
    const t = d >= "2026-11-01" ? 3 : 14 - i / 15;
    return { kwh: 9, half_hours: Array(48).fill(9 / 48), gas_kwh: Math.round((7 + 2.5 * hdd(t)) * 10) / 10 };
  });
  const asked: URL[] = [];
  const stub = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url);
    const from = url.searchParams.get("start_date")!;
    const to = url.searchParams.get("end_date")!;
    const time: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) time.push(d);
    const mean = time.map((d) => (d >= "2026-11-01" ? 3 : 14 - Math.round((Date.parse(d) - Date.parse("2026-06-01")) / 86_400_000) / 15));
    return new Response(JSON.stringify({ daily: { time, temperature_2m_max: mean.map((m) => m + 4), temperature_2m_mean: mean, weather_code: time.map(() => 3), precipitation_sum: time.map(() => 0) } }), { status: 200 });
  }) as typeof fetch;
  const store = new Map<string, MonthMeans>();
  const cache: MeanCache = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) };

  // Only rounded coordinates and dates go out; the archive, then the recent past.
  const temps = await dailyMeans({ lat: 51.55678, lng: -0.14321 }, "2026-06-01", "2026-11-09", { today, cache, fetch: stub });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].origin + asked[0].pathname, "https://archive-api.open-meteo.com/v1/archive");
  assert.equal(asked[1].origin + asked[1].pathname, "https://api.open-meteo.com/v1/forecast");
  for (const u of asked) {
    assert.deepEqual([...u.searchParams.keys()].sort(), ["daily", "end_date", "latitude", "longitude", "start_date", "timezone"]);
    assert.equal(u.searchParams.get("latitude"), "51.56");
    assert.equal(u.searchParams.get("longitude"), "-0.14");
    assert.match(u.searchParams.get("daily")!, /temperature_2m_mean/);
  }
  assert.equal(temps.size, daysBetweenIncl("2026-06-01", "2026-11-09"));
  assert.equal(temps.get("2026-11-05"), 3);
  // Settled months are cached whole; the second time only the recent days are asked.
  assert.deepEqual([...store.keys()].sort(), ["2026-06:51.56,-0.14", "2026-07:51.56,-0.14", "2026-08:51.56,-0.14", "2026-09:51.56,-0.14", "2026-10:51.56,-0.14"]);
  asked.length = 0;
  const again = await dailyMeans({ lat: 51.55678, lng: -0.14321 }, "2026-06-01", "2026-11-09", { today, cache, fetch: stub });
  assert.equal(again.size, temps.size);
  assert.ok(asked.every((u) => u.searchParams.get("start_date")! >= "2026-11-01"), "only November asked again");

  // Degree days.
  assert.equal(hddSum(temps, "2026-11-01", "2026-11-09").hdd, 9 * 12.5);

  // The card's data, through houseEnergy as the page gets it.
  const weather = await homeWeather(days, today, { spot: async () => ({ lat: 51.55678, lng: -0.14321 }), fetch: stub, cache });
  assert.ok(weather && "temps" in weather);
  const e = houseEnergy({ days, months: homeMonths(days), tariff: null, today, now: new Date("2026-11-10T09:00:00Z"), tz: "Europe/London", weather })!;
  const t = e.trends!;
  assert.ok("fit" in t.gas_weather!);
  const fit = (t.gas_weather as { fit: { baseload: number; per_hdd: number } }).fit;
  assert.ok(Math.abs(fit.baseload - 7) < 0.1 && Math.abs(fit.per_hdd - 2.5) < 0.05, JSON.stringify(fit));
  const gas = t.rows.find((r) => r.fuel === "gas" && r.kind === "month")!;
  assert.equal(gas.this.name, "November so far");
  assert.ok(Math.abs(gas.against[0].weather!.adjusted) < 0.03);
  assert.match(t.takeaway, /more gas a day than October, but it was \d+° colder\. About the same once the weather is allowed for\./);
  assert.ok(t.rows.some((r) => r.kind === "forecast" && r.fuel === "electricity"));
  assert.ok(t.needs.some((n) => n.kind === "rolling"));

  // No home, or Open-Meteo down: raw figures and why.
  assert.deepEqual(await homeWeather(days, today, { spot: async () => null, fetch: stub }), { missing: "no_home" });
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await homeWeather(days, today, { spot: async () => ({ lat: 51.5, lng: -0.1 }), fetch: down }), { missing: "unavailable" });
  assert.equal(await homeWeather(range("2026-11-01", "2026-11-09", () => ({ kwh: 9 })), today, { spot: async () => ({ lat: 51.5, lng: -0.1 }), fetch: stub }), undefined, "no gas, no weather asked");
});

const daysBetweenIncl = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

test("the card's views: one line each, and the same month last year says when it will show", async () => {
  const { viewTakeaway } = await import("./house-trends");
  const temps = new Map<string, number>();
  const days = range("2024-11-01", "2026-11-09", (d, i) => {
    const t = d >= "2026-11-01" ? 4 : swing(i);
    temps.set(d, t);
    return { kwh: d >= "2025-11-10" ? 9 : 10, gas_kwh: 7 + 2.5 * hdd(t) };
  });
  const t = energyTrends({ days, costs: new Map(), weather: { temps } })!;
  // This month: the forecast is the headline, so the line is the month so far.
  assert.equal(viewTakeaway(t, "electricity", "month"), "November so far: about the same electricity a day as October.");
  assert.match(viewTakeaway(t, "electricity", "year"), /^November so far: \d+% less electricity a day than November 2025\.$/);
  assert.equal(viewTakeaway(t, "electricity", "rolling"), "Last 12 months: 10% less electricity a day than the 12 months before.");
  assert.equal(viewTakeaway(t, "gas", "weather"), t.weather_line);
  assert.equal(viewTakeaway(t, "electricity", "weather"), "", "electricity is never adjusted");
  // Readings from March: no same month last year, and when it will show.
  const short = energyTrends({ days: range("2026-03-01", "2026-11-09", () => ({ kwh: 10 })), costs: new Map() })!;
  const need = short.needs.find((n) => n.kind === "year")!;
  assert.equal(need.months, 4);
  assert.equal(needWords(need), "The same month last year shows in 4 more months.");
  assert.equal(viewTakeaway(short, "electricity", "year"), "");
});
