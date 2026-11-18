import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ANTHROPIC_API_KEY ??= "test";

const daily = {
  time: ["2026-11-12", "2026-11-13"],
  weather_code: [61, 2],
  temperature_2m_max: [11.4, 9.6],
  temperature_2m_min: [6.2, null],
  precipitation_sum: [4.26, 0],
  precipitation_probability_max: [85, 10],
  wind_speed_10m_max: [17.8, 9.1],
  sunrise: ["2026-11-12T07:14", "2026-11-13T07:16"],
  sunset: ["2026-11-12T16:17", "2026-11-13T16:15"],
};

test("the forecast: rounded coordinates and the dates out, plain days back, a day without figures left out", async () => {
  const { forecastDays } = await import("./weather");
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ daily })))) as unknown as typeof fetch;
  const days = await forecastDays({ lat: 51.50735, lng: -0.12776 }, { from: "2026-11-12", to: "2026-11-13", fetch: fetchImpl });
  const u = new URL(asked[0]);
  assert.equal(u.searchParams.get("latitude"), "51.51");
  assert.equal(u.searchParams.get("longitude"), "-0.13");
  assert.equal(u.searchParams.get("start_date"), "2026-11-12");
  assert.deepEqual(days, [{ date: "2026-11-12", sky: "rain", high: 11, low: 6, rain_mm: 4.3, rain_chance: 85, wind_mph: 18, sunrise: "07:14", sunset: "16:17" }]);
  assert.equal(await forecastDays({ lat: 1, lng: 1 }, { from: "2026-11-12", to: "2026-11-12", fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch }), null);
});

test("a town by name: only the name is sent", async () => {
  const { findTown } = await import("./weather");
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ results: [{ latitude: 38.72, longitude: -9.13, name: "Lisbon", country: "Portugal" }] })))) as unknown as typeof fetch;
  assert.deepEqual(await findTown("  Lisbon <b>", { fetch: fetchImpl }), { lat: 38.72, lng: -9.13, town: "Lisbon, Portugal" });
  const u = new URL(asked[0]);
  assert.equal(u.hostname, "geocoding-api.open-meteo.com");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["count", "format", "language", "name"]);
  assert.equal(u.searchParams.get("name"), "Lisbon b");
  assert.equal(await findTown("x", { fetch: fetchImpl }), null);
});

test("Ask's weather tool: a named town's forecast with its hours for one day, cited; past and far-off dates say so without asking", async () => {
  const { ReadTools } = await import("./ask-tools");
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("geocoding")) return new Response(JSON.stringify({ results: [{ latitude: 38.72, longitude: -9.13, name: "Lisbon", country: "Portugal" }] }));
    if (String(url).includes("hourly=")) return new Response(JSON.stringify({ hourly: { time: ["2026-11-12T06:00", "2026-11-12T07:00"], temperature_2m: [8, 9.4], precipitation: [0, 0.2], precipitation_probability: [5, 40], wind_speed_10m: [6, 7.7] } }));
    return new Response(JSON.stringify({ daily: { ...daily, time: ["2026-11-12"] } }));
  }) as unknown as typeof fetch;
  const cited: string[] = [];
  const tools = new ReadTools({ cite: (kind, id, title) => (cited.push(`${kind}:${id}:${title}`), "day:2026-11-11"), tz: "Europe/London", now: new Date("2026-11-11T22:05:00Z"), fetch: fetchImpl });
  const got = JSON.parse(await tools.run("weather", { date: "2026-11-12", place: "Lisbon" }));
  assert.equal(got.where, "Lisbon, Portugal");
  assert.equal(got.ref, "day:2026-11-11");
  assert.deepEqual(cited, ["day:2026-11-11:Forecast for Lisbon, Portugal"]);
  assert.equal(got.days[0].sky, "rain");
  assert.equal(got.days[0].day, "Thursday 12 November");
  assert.deepEqual(got.hours, [{ time: "07:00", temp: 9, rain_mm: 0.2, rain_chance: 40, wind_mph: 8 }]);
  const before = asked.length;
  assert.match(await tools.run("weather", { date: "2026-11-01", place: "Lisbon" }), /in the past/);
  assert.match(await tools.run("weather", { date: "2026-12-25", place: "Lisbon" }), /only reaches 2026-11-26/);
  assert.equal(asked.length, before);
});
