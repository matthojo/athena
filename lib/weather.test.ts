// Run: npx tsx --test lib/weather.test.ts
// The weather line and Open-Meteo, with fetch stubbed and an in-memory cache: one request per place, the archive then the recent past, cached per day and place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARCHIVE_URL, RECENT_URL, forecastToday, weatherFor, weatherLine, weatherWords, WEATHER_LINE, type DayWeather, type WeatherCache } from "./weather";

test("the line: the day's high and a few words", () => {
  assert.equal(weatherLine({ high: 13.6, code: 63 }, "London"), "14° and rain in London");
  assert.equal(weatherLine({ high: -0.4, code: 73 }, "Oslo"), "0° and snow in Oslo");
  assert.equal(weatherLine({ high: 24, code: 0 }), "24° and sunny");
  assert.deepEqual([1, 2, 3, 45, 53, 81, 86, 96].map(weatherWords), ["sunny", "sun and cloud", "cloudy", "fog", "drizzle", "rain", "snow", "thunderstorms"]);
  assert.ok(WEATHER_LINE.test("14° and rain in London"));
});

function memoryCache(): WeatherCache & { map: Map<string, DayWeather> } {
  const map = new Map<string, DayWeather>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

test("one request per place, archive first, recent days from the forecast's past, all cached", async () => {
  const calls: URL[] = [];
  const fake = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const from = url.searchParams.get("start_date")!;
    const to = url.searchParams.get("end_date")!;
    const time: string[] = [];
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) time.push(d);
    const archive = url.origin + url.pathname === ARCHIVE_URL;
    // The archive has nothing for the last few days (null), as Open-Meteo's does.
    return Response.json({ daily: { time, temperature_2m_max: time.map((d) => (archive && d >= "2026-11-02" ? null : 14)), weather_code: time.map(() => 63), precipitation_sum: time.map(() => 4.2) } });
  }) as typeof fetch;
  const cache = memoryCache();
  const today = "2026-11-07";
  const asks = [
    { date: "2026-10-20", lat: 51.51234, lng: -0.12701, place: "p1" },
    { date: "2026-10-21", lat: 51.51234, lng: -0.12701, place: "p1" },
    { date: "2026-11-05", lat: 51.51234, lng: -0.12701, place: "p1" },
    { date: "2026-11-05", lat: 48.85, lng: 2.35, place: "paris" },
    { date: today, lat: 51.5, lng: -0.1, place: "p1" },
  ];
  const got = await weatherFor(asks, { today, cache, fetch: fake });
  assert.equal(got.size, 4, "today isn't over, so it isn't asked");
  assert.deepEqual(got.get("2026-11-05:paris"), { high: 14, code: 63, wet: 4.2 });
  assert.deepEqual(calls.map((u) => `${u.host} ${u.searchParams.get("start_date")}..${u.searchParams.get("end_date")}`), [
    "archive-api.open-meteo.com 2026-10-20..2026-10-21",
    "api.open-meteo.com 2026-11-05..2026-11-05",
    "api.open-meteo.com 2026-11-05..2026-11-05",
  ]);
  assert.equal(calls[0].searchParams.get("latitude"), "51.51", "only rounded coordinates are sent");
  assert.ok(!calls.some((u) => [...u.searchParams.keys()].some((k) => !["latitude", "longitude", "start_date", "end_date", "daily", "timezone"].includes(k))));
  assert.ok(calls.every((u) => [ARCHIVE_URL, RECENT_URL].includes(u.origin + u.pathname)));
  assert.equal(cache.map.size, 4);

  // Again: all from the cache, no requests.
  calls.length = 0;
  const again = await weatherFor(asks, { today, cache, fetch: fake });
  assert.equal(again.size, 4);
  assert.equal(calls.length, 0);
});

test("a failed or empty answer isn't cached, so it's tried again", async () => {
  const cache = memoryCache();
  let n = 0;
  const down = (async () => {
    n++;
    return new Response("busy", { status: 503 });
  }) as typeof fetch;
  const asks = [{ date: "2026-10-01", lat: 51.5, lng: -0.1, place: "p1" }];
  assert.equal((await weatherFor(asks, { today: "2026-11-07", cache, fetch: down })).size, 0);
  assert.equal(cache.map.size, 0);
  const offline = (async () => {
    n++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal((await weatherFor(asks, { today: "2026-11-07", cache, fetch: offline })).size, 0);
  assert.equal(n, 4, "each time: the archive, then the recent past");
});

// A response in Open-Meteo's forecast shape (lib/fixtures/open-meteo-forecast-hourly.json): Bristol, 9 November 2026, rain in the late afternoon.
const RECORDED = readFileSync(new URL("./fixtures/open-meteo-forecast-hourly.json", import.meta.url), "utf8");

test("today's forecast: rounded coordinates out, the waking hours back", async () => {
  const calls: URL[] = [];
  const fake = (async (input: string | URL) => {
    calls.push(new URL(String(input)));
    return new Response(RECORDED, { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const hours = await forecastToday({ lat: 51.45412, lng: -2.58791 }, { date: "2026-11-09", fetch: fake });
  assert.equal(calls.length, 1);
  const u = calls[0];
  assert.equal(u.origin + u.pathname, RECENT_URL);
  assert.equal(u.searchParams.get("latitude"), "51.45", "rounded as the daily weather is");
  assert.equal(u.searchParams.get("longitude"), "-2.59");
  assert.equal(u.searchParams.get("start_date"), "2026-11-09");
  assert.equal(u.searchParams.get("end_date"), "2026-11-09");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["end_date", "hourly", "latitude", "longitude", "start_date", "timezone", "wind_speed_unit"]);
  assert.ok(hours);
  assert.equal(hours.length, 16, "07:00 to 22:00");
  assert.equal(hours[0].time, "07:00");
  assert.equal(hours[hours.length - 1].time, "22:00");
  assert.deepEqual(hours.find((h) => h.time === "17:00"), { time: "17:00", temp: 9.8, rain: 1.8, chance: 85, wind: 17.9 });
});

test("today's forecast: null when Open-Meteo fails, errors or sends nothing usable", async () => {
  const date = "2026-11-09";
  const spot = { lat: 51.45, lng: -2.59 };
  assert.equal(await forecastToday(spot, { date, fetch: (async () => { throw new Error("offline"); }) as typeof fetch }), null);
  assert.equal(await forecastToday(spot, { date, fetch: (async () => new Response("busy", { status: 503 })) as typeof fetch }), null);
  assert.equal(await forecastToday(spot, { date, fetch: (async () => new Response("not json")) as typeof fetch }), null);
  assert.equal(await forecastToday(spot, { date: "2026-11-10", fetch: (async () => new Response(RECORDED)) as typeof fetch }), null, "hours for another day aren't today's");
});
