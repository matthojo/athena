/**
 * The day's weather, in one line for the Life log: "14° and rain in London".
 *
 * From Open-Meteo (no key, no account): the historical archive
 * (archive-api.open-meteo.com) for anything older than a few days, and its
 * forecast API's recent past for days the archive hasn't caught up with yet
 * (it runs about five days behind). Only coordinates and dates are sent,
 * rounded to two decimals (about 1 km), never a name or anything about the
 * owner.
 *
 * Cached per day and place (location_cache, sealed: together they say where
 * you were), so a day is fetched once. Today isn't cached: it isn't over.
 */
import { sealText, openStrict, blindIndex, dataKeyConfigured } from "./data-box";
import { qRaw } from "./db";

export interface DayWeather {
  /** The day's high, °C. */
  high: number;
  /** WMO weather code (the day's most significant). */
  code: number;
  /** Total rain and snow, mm. */
  wet?: number;
  /** The day's mean temperature, °C (House's heating degree days). */
  mean?: number;
}

/** WMO codes in a few plain words. */
export function weatherWords(code: number): string {
  if (code <= 1) return "sunny";
  if (code === 2) return "sun and cloud";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunderstorms";
  return "cloudy";
}

/** "14° and rain in London"; without a town, "14° and rain". */
export function weatherLine(w: DayWeather, town?: string | null): string {
  const t = Math.round(w.high);
  return `${t === 0 ? 0 : t}° and ${weatherWords(w.code)}${town ? ` in ${town}` : ""}`;
}

/** A weather line weatherLine could have written. */
export const WEATHER_LINE = /^-?\d{1,2}° and (sunny|sun and cloud|cloudy|fog|drizzle|rain|snow|thunderstorms)( in .{1,80})?$/;

export const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
export const RECENT_URL = "https://api.open-meteo.com/v1/forecast";
/** Days newer than this many days ago are asked of the forecast API's recent past. */
export const ARCHIVE_LAG_DAYS = 6;

export interface WeatherCache {
  get(key: string): Promise<DayWeather | null>;
  set(key: string, value: DayWeather): Promise<void>;
}

/** Sealed in location_cache under a blind index of "wx:<day>:<place>". Nothing cached without the data key. */
export const dbWeatherCache: WeatherCache = {
  async get(key) {
    const k = blindIndex("other", `wx:${key}`);
    if (!k) return null;
    const [row] = await qRaw<{ sealed: string }>(`SELECT sealed FROM location_cache WHERE key = $1`, [k]);
    if (!row) return null;
    try {
      return JSON.parse(openStrict(row.sealed)) as DayWeather;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    const k = blindIndex("other", `wx:${key}`);
    if (!k || !dataKeyConfigured()) return;
    await qRaw(`INSERT INTO location_cache (key, sealed) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed`, [k, sealText(JSON.stringify(value))]);
  },
};

export interface WeatherAsk {
  date: string;
  lat: number;
  lng: number;
  /** What the cache calls this place (an Athena place id, or rounded coordinates). */
  place: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

interface Daily {
  time?: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_mean?: Array<number | null>;
  weather_code?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
}

async function fetchDaily(base: string, lat: number, lng: number, from: string, to: string, fetchImpl: typeof fetch): Promise<Map<string, DayWeather>> {
  const url = new URL(base);
  url.search = new URLSearchParams({
    latitude: String(round2(lat)),
    longitude: String(round2(lng)),
    start_date: from,
    end_date: to,
    daily: "temperature_2m_max,temperature_2m_mean,weather_code,precipitation_sum",
    timezone: "auto",
  }).toString();
  const out = new Map<string, DayWeather>();
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return out;
  }
  if (!res.ok) return out;
  const body = (await res.json().catch(() => null)) as { daily?: Daily } | null;
  const d = body?.daily;
  for (const [i, day] of (d?.time ?? []).entries()) {
    const high = d?.temperature_2m_max?.[i];
    const code = d?.weather_code?.[i];
    if (typeof high !== "number" || typeof code !== "number") continue;
    const wet = d?.precipitation_sum?.[i];
    const mean = d?.temperature_2m_mean?.[i];
    out.set(day, { high, code, ...(typeof wet === "number" ? { wet } : {}), ...(typeof mean === "number" ? { mean } : {}) });
  }
  return out;
}

/**
 * Weather for each (day, place) asked, from the cache or Open-Meteo: one
 * request per place for all its days, the archive first, the recent-past API
 * for days the archive doesn't have yet. Days that can't be had are left out
 * (tried again next time). Today and later are never asked.
 */
export async function weatherFor(
  asks: WeatherAsk[],
  opts: { today: string; cache?: WeatherCache; fetch?: typeof fetch; deadline?: number },
): Promise<Map<string, DayWeather>> {
  const cache = opts.cache ?? dbWeatherCache;
  const fetchImpl = opts.fetch ?? fetch;
  const out = new Map<string, DayWeather>();
  const key = (a: WeatherAsk) => `${a.date}:${a.place}`;
  const missing = new Map<string, WeatherAsk[]>();
  for (const a of asks) {
    if (a.date >= opts.today || out.has(key(a))) continue;
    const hit = await cache.get(key(a));
    if (hit) {
      out.set(key(a), hit);
      continue;
    }
    missing.set(a.place, [...(missing.get(a.place) ?? []), a]);
  }
  for (const list of missing.values()) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const dates = list.map((a) => a.date).sort();
    const { lat, lng } = list[0];
    const old = dates.filter((d) => daysBetween(d, opts.today) > ARCHIVE_LAG_DAYS);
    const got = old.length ? await fetchDaily(ARCHIVE_URL, lat, lng, old[0], old[old.length - 1], fetchImpl) : new Map<string, DayWeather>();
    const rest = dates.filter((d) => !got.has(d));
    if (rest.length && daysBetween(rest[0], opts.today) <= 90) {
      for (const [d, w] of await fetchDaily(RECENT_URL, lat, lng, rest[0], rest[rest.length - 1], fetchImpl)) if (!got.has(d)) got.set(d, w);
    }
    for (const a of list) {
      const w = got.get(a.date);
      if (!w) continue;
      out.set(key(a), w);
      await cache.set(key(a), w);
    }
  }
  return out;
}

/** A month of daily means for one place, as cached. */
export interface MonthMeans {
  /** Day of the month ("01") to °C. */
  days: Record<string, number>;
}

export interface MeanCache {
  get(key: string): Promise<MonthMeans | null>;
  set(key: string, value: MonthMeans): Promise<void>;
}

/** Sealed in location_cache like the day's weather, under a blind index of "wxmean:<month>:<place>". */
export const dbMeanCache: MeanCache = {
  async get(key) {
    const k = blindIndex("other", `wxmean:${key}`);
    if (!k) return null;
    const [row] = await qRaw<{ sealed: string }>(`SELECT sealed FROM location_cache WHERE key = $1`, [k]);
    if (!row) return null;
    try {
      return JSON.parse(openStrict(row.sealed)) as MonthMeans;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    const k = blindIndex("other", `wxmean:${key}`);
    if (!k || !dataKeyConfigured()) return;
    await qRaw(`INSERT INTO location_cache (key, sealed) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed`, [k, sealText(JSON.stringify(value))]);
  },
};

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

/**
 * The daily mean temperature at one spot for every day in [from, to] before
 * today, for House's heating degree days. Same rules as weatherFor: only the
 * coordinates (rounded to two decimals) and the dates go to Open-Meteo, the
 * archive first and the recent-past API for days it hasn't caught up with.
 * Cached a whole month at a time, once every day of it is in the archive, so
 * two years is about 24 cache reads and at most two requests. Days that
 * can't be had are left out.
 */
export async function dailyMeans(
  spot: { lat: number; lng: number },
  fromDay: string,
  to: string,
  opts: { today: string; cache?: MeanCache; fetch?: typeof fetch },
): Promise<Map<string, number>> {
  // Whole months, so each can be cached.
  const from = `${fromDay.slice(0, 7)}-01`;
  const cache = opts.cache ?? dbMeanCache;
  const fetchImpl = opts.fetch ?? fetch;
  const place = `${round2(spot.lat).toFixed(2)},${round2(spot.lng).toFixed(2)}`;
  const last = to < opts.today ? to : addDay(opts.today, -1);
  const out = new Map<string, number>();
  if (last < from) return out;
  const want: string[] = [];
  const settled = (month: string) => daysBetween(monthEnd(month), opts.today) > ARCHIVE_LAG_DAYS;
  for (let m = from.slice(0, 7); m <= last.slice(0, 7); m = addDay(monthEnd(m), 1).slice(0, 7)) {
    const hit = settled(m) ? await cache.get(`${m}:${place}`) : null;
    for (let d = `${m}-01`; d <= last && d.slice(0, 7) === m; d = addDay(d, 1)) {
      const t = hit?.days[d.slice(8, 10)];
      if (t !== undefined) out.set(d, t);
      else want.push(d);
    }
  }
  if (!want.length) return out;
  const got = new Map<string, DayWeather>();
  const old = want.filter((d) => daysBetween(d, opts.today) > ARCHIVE_LAG_DAYS);
  if (old.length) for (const [d, w] of await fetchDaily(ARCHIVE_URL, spot.lat, spot.lng, old[0], old[old.length - 1], fetchImpl)) got.set(d, w);
  const rest = want.filter((d) => got.get(d)?.mean === undefined);
  if (rest.length && daysBetween(rest[0], opts.today) <= 90) for (const [d, w] of await fetchDaily(RECENT_URL, spot.lat, spot.lng, rest[0], rest[rest.length - 1], fetchImpl)) if (got.get(d)?.mean === undefined) got.set(d, w);
  const months = new Map<string, MonthMeans>();
  for (const d of want) {
    const t = got.get(d)?.mean;
    if (t === undefined) continue;
    out.set(d, t);
  }
  // A month goes in the cache only when it's settled and every one of its days is in hand.
  for (const m of new Set(want.map((d) => d.slice(0, 7)))) {
    if (!settled(m)) continue;
    const days: Record<string, number> = {};
    let all = true;
    for (let d = `${m}-01`; d <= monthEnd(m); d = addDay(d, 1)) {
      const t = out.get(d);
      if (t === undefined) {
        all = false;
        break;
      }
      days[d.slice(8, 10)] = t;
    }
    if (all) months.set(m, { days });
  }
  for (const [m, v] of months) await cache.set(`${m}:${place}`, v);
  return out;
}

const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** One hour of today's forecast. */
export interface ForecastHour {
  /** Local time, "07:00". */
  time: string;
  /** °C. */
  temp: number;
  /** Rain and snow that hour, mm. */
  rain: number;
  /** Chance of rain, %, when Open-Meteo gives it. */
  chance?: number;
  /** Wind at 10 m, mph. */
  wind: number;
}

/** The waking hours the briefing is given: 07:00 to 22:00 inclusive. */
export const WAKING_HOURS = { from: 7, to: 22 } as const;

interface Hourly {
  time?: string[];
  temperature_2m?: Array<number | null>;
  precipitation?: Array<number | null>;
  precipitation_probability?: Array<number | null>;
  wind_speed_10m?: Array<number | null>;
}

/**
 * Today's hourly forecast for the waking hours, from Open-Meteo's forecast
 * API, for the morning briefing. Only the coordinates (rounded as above) and
 * the date are sent. Not cached: it's asked once a morning and changes. null
 * when it can't be had, so the caller falls back.
 */
export async function forecastToday(spot: { lat: number; lng: number }, opts: { date: string; fetch?: typeof fetch }): Promise<ForecastHour[] | null> {
  const url = new URL(RECENT_URL);
  url.search = new URLSearchParams({
    latitude: String(round2(spot.lat)),
    longitude: String(round2(spot.lng)),
    start_date: opts.date,
    end_date: opts.date,
    hourly: "temperature_2m,precipitation,precipitation_probability,wind_speed_10m",
    wind_speed_unit: "mph",
    timezone: "auto",
  }).toString();
  let body: { hourly?: Hourly } | null;
  try {
    const res = await (opts.fetch ?? fetch)(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    body = (await res.json().catch(() => null)) as { hourly?: Hourly } | null;
  } catch {
    return null;
  }
  const h = body?.hourly;
  const out: ForecastHour[] = [];
  for (const [i, at] of (h?.time ?? []).entries()) {
    if (at.slice(0, 10) !== opts.date) continue;
    const hour = Number(at.slice(11, 13));
    if (!(hour >= WAKING_HOURS.from && hour <= WAKING_HOURS.to)) continue;
    const temp = h?.temperature_2m?.[i];
    const rain = h?.precipitation?.[i];
    const wind = h?.wind_speed_10m?.[i];
    if (typeof temp !== "number" || typeof rain !== "number" || typeof wind !== "number") continue;
    const chance = h?.precipitation_probability?.[i];
    out.push({ time: at.slice(11, 16), temp, rain, ...(typeof chance === "number" ? { chance } : {}), wind });
  }
  return out.length ? out : null;
}

// ---------- The forecast, for Ask ----------

/** One day of the forecast. */
export interface ForecastDay {
  date: string;
  /** "rain", "sun and cloud". */
  sky: string;
  /** °C. */
  high: number;
  low: number;
  /** Rain and snow over the day, mm. */
  rain_mm: number;
  /** The highest chance of rain in the day, %. */
  rain_chance?: number;
  /** Strongest wind, mph. */
  wind_mph: number;
  sunrise?: string;
  sunset?: string;
}

/** Open-Meteo forecasts this many days ahead, today included. */
export const FORECAST_DAYS = 16;
export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

interface Daily {
  time?: string[];
  weather_code?: Array<number | null>;
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
  precipitation_probability_max?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
  sunrise?: Array<string | null>;
  sunset?: Array<string | null>;
}

/**
 * The daily forecast for a spot, from Open-Meteo's forecast API, for Ask's
 * weather tool. Only the coordinates (rounded to about 1 km) and the dates
 * are sent. Not cached: a forecast changes. null when it can't be had.
 */
export async function forecastDays(spot: { lat: number; lng: number }, opts: { from: string; to: string; fetch?: typeof fetch }): Promise<ForecastDay[] | null> {
  const url = new URL(RECENT_URL);
  url.search = new URLSearchParams({
    latitude: String(round2(spot.lat)),
    longitude: String(round2(spot.lng)),
    start_date: opts.from,
    end_date: opts.to,
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset",
    wind_speed_unit: "mph",
    timezone: "auto",
  }).toString();
  let d: Daily | undefined;
  try {
    const res = await (opts.fetch ?? fetch)(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    d = ((await res.json().catch(() => null)) as { daily?: Daily } | null)?.daily;
  } catch {
    return null;
  }
  const out: ForecastDay[] = [];
  for (const [i, date] of (d?.time ?? []).entries()) {
    const code = d?.weather_code?.[i];
    const high = d?.temperature_2m_max?.[i];
    const low = d?.temperature_2m_min?.[i];
    if (typeof code !== "number" || typeof high !== "number" || typeof low !== "number") continue;
    const chance = d?.precipitation_probability_max?.[i];
    const rise = d?.sunrise?.[i];
    const set = d?.sunset?.[i];
    out.push({
      date,
      sky: weatherWords(code),
      high: Math.round(high),
      low: Math.round(low),
      rain_mm: Math.round((d?.precipitation_sum?.[i] ?? 0) * 10) / 10,
      ...(typeof chance === "number" ? { rain_chance: chance } : {}),
      wind_mph: Math.round(d?.wind_speed_10m_max?.[i] ?? 0),
      ...(typeof rise === "string" ? { sunrise: rise.slice(11, 16) } : {}),
      ...(typeof set === "string" ? { sunset: set.slice(11, 16) } : {}),
    });
  }
  return out.length ? out : null;
}

/**
 * A town or city by name ("Lisbon"), from Open-Meteo's geocoder. Only the
 * name is sent. null when nothing matches or it didn't answer.
 */
export async function findTown(name: string, opts: { fetch?: typeof fetch } = {}): Promise<{ lat: number; lng: number; town: string } | null> {
  const clean = name.replace(/[^\p{L}\p{N} ,.'-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (clean.length < 2) return null;
  const url = new URL(GEOCODE_URL);
  url.search = new URLSearchParams({ name: clean, count: "1", language: "en", format: "json" }).toString();
  try {
    const res = await (opts.fetch ?? fetch)(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const hit = ((await res.json().catch(() => null)) as { results?: Array<{ latitude?: unknown; longitude?: unknown; name?: unknown; country?: unknown }> } | null)?.results?.[0];
    if (typeof hit?.latitude !== "number" || typeof hit.longitude !== "number" || typeof hit.name !== "string") return null;
    return { lat: hit.latitude, lng: hit.longitude, town: [hit.name, typeof hit.country === "string" ? hit.country : ""].filter(Boolean).join(", ").slice(0, 120) };
  } catch {
    return null;
  }
}
