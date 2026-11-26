/**
 * Where you went each day: Google Maps Timeline visits (imported in the
 * browser, lib/places-timeline.ts), Swarm check-ins (synced nightly,
 * netlify/lib/connectors/swarm-sync.ts) and visits added by hand (for
 * someone with neither), merged, named, linked to Places, and written as
 * one line in the Life log with the day's weather.
 * docs: security/encryption has the rules.
 *
 * Storage (migration 0031). Each (day, source) is one sensitive_blobs row,
 * domain 'location', sealed JSON: 'timeline' (the visits as imported),
 * 'swarm' (the check-ins), 'manual' (visits added by hand) and 'day' (all
 * of them merged, named and linked). The
 * label is the day and the source. A Place's coordinates, ids, town and
 * visit days are one sealed value in place_geo. Names and weather looked up
 * once sit in location_cache under a blind index. location_todo lists days
 * still waiting for a name or the weather.
 *
 * Merge. A Swarm check-in during a Timeline visit (10 minutes either side,
 * within 300 m) is that visit, with Swarm's venue name. Other check-ins are
 * visits of their own. A visit added by hand that overlaps a Timeline visit
 * or a check-in (the same 10 minutes, the same 300 m) is that stop too, so a
 * Place counts it once, whichever arrived first. Other visits added by hand
 * are stops of their own.
 *
 * Names, in order: Google's Home and Work stay "Home" and "Work"; a known
 * Place (same Google or Foursquare id, or within 100 m, or the same name
 * with no coordinates yet); Swarm's venue; the name in an older Takeout
 * file; then OpenStreetMap's Nominatim (reverse geocoding, one request a
 * second, a plain app User-Agent, nothing about the owner, cached). A named
 * spot becomes a Place (or reuses one within 100 m); a spot Nominatim knows
 * only by its area ("Highgate") is named but makes no Place.
 *
 * The Life log. Each day note gets a "Places" section under Health: the
 * places line ("Lunch at Dishoom, then Hampstead Heath") and the weather
 * line ("14° and rain in London", lib/weather.ts). Coordinates never go in a
 * note. A Life log run keeps the section (keepPlaces, through
 * keepImported). Ask leaves it out unless the question is about places
 * (withoutPlaces, isPlacesQuestion).
 */
import { touchDays } from "./day-touch";
import { blindIndex, currentKeyId, dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { addDays, isValidDate, zonedToInstant, zonedToday } from "./dates";
import { randomUUID } from "node:crypto";
import { AthenaInputError, getOwnerTimeZone, getRecord, q, qRaw, sealer, tx, upsertPlace } from "./db";
import { dayTitle } from "./youtube-takeout";
import { adoptHealthDay, HOLDER_SOURCE } from "./health";
import { localDay, MIN_VISIT_MINUTES, type TimelineVisit } from "./places-timeline";
import { weatherFor, weatherLine, type DayWeather } from "./weather";
import { categoryOf, placesLine, withPlacesSection, type Checkin, type StopCategory, type Visit, type VisitKind } from "./places-line";

export * from "./places-line";

// ---------- Geometry ----------

/** Metres between two points (haversine). */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A check-in this close to a Timeline visit, and within its time, is that visit. */
export const MERGE_METRES = 300;
export const MERGE_SLACK_MS = 10 * 60_000;
/** A Place this close to a stop is that stop. */
export const NEAR_PLACE_METRES = 100;

// ---------- Merging ----------

/** Timeline visits and Swarm check-ins as one list of stops, in order. */
export function mergeVisits(timeline: TimelineVisit[], checkins: Checkin[]): Visit[] {
  const visits: Array<Visit & { _d?: number }> = timeline.map((t) => clean({ start: t.start, end: t.end, lat: t.lat, lng: t.lng, gid: t.place_id, kind: t.kind, takeout: t.name, timeline: true }));
  const extra: Visit[] = [];
  for (const c of [...checkins].sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(c.at);
    let best: (Visit & { _d?: number }) | null = null;
    let bestD = Infinity;
    for (const v of visits) {
      if (Date.parse(v.start) - MERGE_SLACK_MS > t || t > Date.parse(v.end) + MERGE_SLACK_MS) continue;
      const d = metres(v, c);
      if (d <= MERGE_METRES && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (best) {
      best.swarm = true;
      // Two check-ins in one visit: the nearer venue names it.
      if (!best.venue || bestD < (best._d ?? Infinity)) {
        best.venue = c.venue;
        best.fsq = c.venue_id;
        best.category = categoryOf(c.category) ?? best.category;
        best.town = c.town ?? best.town;
        best._d = bestD;
      }
    } else {
      extra.push(clean({ start: c.at, end: c.at, lat: c.lat, lng: c.lng, fsq: c.venue_id, venue: c.venue, category: categoryOf(c.category), town: c.town, swarm: true }));
    }
  }
  return [...visits.map(({ _d, ...v }) => v), ...extra].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Visits added by hand laid over the Timeline and Swarm stops: one that
 * overlaps a stop (10 minutes either side, within 300 m) is that stop, and
 * its Place (when it was added to one) names it. Others are stops of their
 * own. Pure; taking the visit out again leaves the stop as it was.
 */
export function mergeManual(stops: Visit[], manual: ManualVisit[]): Visit[] {
  const out: Visit[] = stops.map((v) => ({ ...v }));
  const own: Visit[] = [];
  for (const m of [...manual].sort((a, b) => a.start.localeCompare(b.start))) {
    const from = Date.parse(m.start);
    const to = Date.parse(m.end);
    let best: Visit | null = null;
    let bestD = Infinity;
    for (const v of out) {
      if (Date.parse(v.start) - MERGE_SLACK_MS > to || from > Date.parse(v.end) + MERGE_SLACK_MS) continue;
      const d = metres(v, m);
      if (d <= MERGE_METRES && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (!best) {
      own.push(manualAsVisit(m));
      continue;
    }
    best.manual = true;
    best.manual_ids = [...(best.manual_ids ?? []), m.id];
    // The owner said which Place it was (the first visit by hand to say so).
    if (m.place) best.place ??= m.place;
    if (m.name) best.venue ??= m.name;
    if (m.address) best.address ??= m.address;
    // A check-in is a moment: the visit by hand says how long. A Timeline visit keeps its own times.
    if (!best.timeline) {
      if (m.start < best.start) best.start = m.start;
      if (m.end > best.end) best.end = m.end;
    }
  }
  return [...out, ...own].sort((a, b) => a.start.localeCompare(b.start));
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------- Naming ----------

export interface KnownPlace {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
  gids?: string[];
  fsqs?: string[];
  town?: string;
}

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const KIND_NAME: Record<VisitKind, string> = { home: "Home", work: "Work" };

/** The Place a stop is: same id, else the nearest within 100 m, else one of the same name that has no coordinates yet. */
export function knownPlaceFor(v: Visit, places: KnownPlace[]): KnownPlace | null {
  if (v.kind) return places.find((p) => fold(p.name) === fold(KIND_NAME[v.kind!])) ?? null;
  const byId = places.find((p) => (v.gid && p.gids?.includes(v.gid)) || (v.fsq && p.fsqs?.includes(v.fsq)));
  if (byId) return byId;
  let best: KnownPlace | null = null;
  let bestD = NEAR_PLACE_METRES;
  for (const p of places) {
    if (p.lat === undefined || p.lng === undefined || p.name === "Home" || p.name === "Work") continue;
    const d = metres(v, { lat: p.lat, lng: p.lng });
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  if (best) return best;
  const named = v.venue ?? v.takeout;
  return named ? (places.find((p) => p.lat === undefined && fold(p.name) === fold(named)) ?? null) : null;
}

/** What Nominatim (or the cache) said about a spot. */
export interface SpotName {
  /** A venue, park or landmark: becomes a Place. */
  name?: string;
  /** Only an area ("Highgate"): names the stop, makes no Place. */
  area?: string;
  town?: string;
  address?: string;
  category?: StopCategory;
}

/** A stop's name, in the owner's order: Home and Work, a known Place, Swarm's venue, the Takeout name, then the map. */
export function nameFor(v: Visit, place: KnownPlace | null, spot: SpotName | null): string | null {
  if (v.kind) return KIND_NAME[v.kind];
  return place?.name ?? v.venue ?? v.takeout ?? spot?.name ?? spot?.area ?? null;
}

// ---------- Storing ----------

type Src = "timeline" | "swarm" | "manual" | "day";
const SRC_NAME: Record<Src, string> = { timeline: "Google Maps Timeline", swarm: "Swarm", manual: "Added by hand", day: "Merged" };
const label = (day: string, src: Src) => `Places · ${day} · ${SRC_NAME[src]}`;

interface DayRecord {
  visits: Visit[];
  line: string | null;
  weather: string | null;
  /** Place id → visits and minutes that day, for each Place's visits line. */
  places: Record<string, { n: number; minutes: number }>;
}

async function readRows<T>(src: Src, from: string, to: string): Promise<Map<string, T>> {
  const rows = await qRaw<{ day: string; ciphertext: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ciphertext FROM sensitive_blobs WHERE domain = 'location' AND source = $1 AND day BETWEEN $2::date AND $3::date`,
    [src, from, to],
  );
  const out = new Map<string, T>();
  for (const r of rows) {
    try {
      out.set(r.day, JSON.parse(openStrict(r.ciphertext)) as T);
    } catch {
      // Unreadable: left alone, never overwritten with a guess.
    }
  }
  return out;
}

async function writeRow(src: Src, day: string, value: unknown, tz: string): Promise<void> {
  await qRaw(
    `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
     VALUES ('location', $1, $2, $3::timestamptz, $4::date, $5)
     ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, label = EXCLUDED.label, recorded_at = EXCLUDED.recorded_at`,
    [label(day, src), sealText(JSON.stringify(value)), zonedToInstant(day, "12:00", tz).toISOString(), day, src],
  );
}

interface Geo {
  lat?: number;
  lng?: number;
  gids?: string[];
  fsqs?: string[];
  town?: string;
  seen?: Record<string, { n: number; minutes: number }>;
}

/** Every live Place, with its sealed coordinates and ids opened. */
async function loadKnown(): Promise<Map<string, KnownPlace & { geo: Geo | null }>> {
  const rows = await qRaw<{ id: string; name: string; sealed: string | null }>(
    `SELECT p.id, p.name, g.sealed FROM places p LEFT JOIN place_geo g ON g.place_id = p.id WHERE p.archived_at IS NULL`,
  );
  const out = new Map<string, KnownPlace & { geo: Geo | null }>();
  for (const r of rows) {
    let geo: Geo | null = null;
    if (r.sealed) {
      try {
        geo = JSON.parse(openStrict(r.sealed)) as Geo;
      } catch {
        continue;
      }
    }
    out.set(r.id, { id: r.id, name: r.name, lat: geo?.lat, lng: geo?.lng, gids: geo?.gids, fsqs: geo?.fsqs, town: geo?.town, geo });
  }
  return out;
}

async function saveGeo(placeId: string, geo: Geo): Promise<void> {
  await qRaw(
    `INSERT INTO place_geo (place_id, sealed) VALUES ($1, $2) ON CONFLICT (place_id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
    [placeId, sealText(JSON.stringify(geo))],
  );
}

// ---------- Nominatim ----------

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
/** Says what's asking and nothing about who: Nominatim's policy asks for an app name. */
export const NOMINATIM_AGENT = "Athena-personal-notes/1.0 (self-hosted day log; reverse lookups cached)";
export const NOMINATIM_GAP_MS = 1_100;
let lastLookup = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tests swap these. */
export const lookupDeps = { fetch: (input: string, init?: RequestInit) => fetch(input, init), sleep, gapMs: NOMINATIM_GAP_MS };

const POI = new Set(["amenity", "shop", "leisure", "tourism", "historic", "natural", "aeroway", "railway", "craft", "club", "office", "building", "man_made", "waterway"]);

/** Nominatim's answer, read. Null when it knows nothing there. */
export function readNominatim(body: unknown): SpotName | null {
  const r = body as { name?: string; category?: string; type?: string; address?: Record<string, string>; error?: string } | null;
  if (!r || r.error) return null;
  const a = r.address ?? {};
  const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county;
  const area = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.village ?? a.town ?? a.city;
  const road = a.road ? `${a.house_number ? `${a.house_number} ` : ""}${a.road}` : undefined;
  const address = [road, a.postcode, town].filter(Boolean).join(", ") || undefined;
  const name = r.name?.trim() && r.category && POI.has(r.category) && r.category !== "building" ? r.name.trim().slice(0, 120) : undefined;
  if (!name && !area) return null;
  return clean({ name, area: name ? undefined : area, town, address, category: categoryOf(r.type) });
}

export class LookupBusy extends Error {}

/** One reverse lookup, at most one a second across this process. Null when Nominatim says nothing, throws LookupBusy on 429. */
async function nominatim(lat: number, lng: number): Promise<SpotName | null> {
  const wait = lastLookup + lookupDeps.gapMs - Date.now();
  if (wait > 0) await lookupDeps.sleep(wait);
  lastLookup = Date.now();
  const url = `${NOMINATIM_URL}?${new URLSearchParams({ format: "jsonv2", lat: lat.toFixed(5), lon: lng.toFixed(5), zoom: "18", addressdetails: "1", "accept-language": "en" })}`;
  let res: Response;
  try {
    res = await lookupDeps.fetch(url, { headers: { "User-Agent": NOMINATIM_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new LookupBusy("unreachable");
  }
  if (res.status === 429 || res.status === 403 || res.status >= 500) throw new LookupBusy(String(res.status));
  if (!res.ok) return null;
  return readNominatim(await res.json().catch(() => null));
}

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

/** How a typed address is matched in the cache: case, spacing and trailing commas don't matter. */
export const addressKey = (address: string) => address.trim().replace(/\s+/g, " ").replace(/[,\s]+$/, "").toLowerCase();

/**
 * Where a typed address is (rich links: a Place's mini map when Athena has no
 * spot from a visit). Asked of Nominatim once per address, at most one lookup
 * a second, and kept in location_cache under a blind index of the address,
 * sealed; "nowhere" is kept too. Only the address is sent: never the place's
 * name or id. Null when it can't be found, or when Nominatim is busy (not kept,
 * so it's asked again later).
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const norm = addressKey(address ?? "");
  if (norm.length < 4 || norm.length > 300) return null;
  const key = blindIndex("other", `addr:${norm}`);
  if (!key) return null;
  const [kept] = await qRaw<{ sealed: string }>(`SELECT sealed FROM location_cache WHERE key = $1`, [key]);
  if (kept) {
    try {
      return JSON.parse(openStrict(kept.sealed)) as { lat: number; lng: number } | null;
    } catch {
      // sealed under a key we no longer hold: ask again
    }
  }
  const wait = lastLookup + lookupDeps.gapMs - Date.now();
  if (wait > 0) await lookupDeps.sleep(wait);
  lastLookup = Date.now();
  const url = `${NOMINATIM_SEARCH_URL}?${new URLSearchParams({ format: "jsonv2", q: address.trim().slice(0, 300), limit: "1", "accept-language": "en" })}`;
  let res: Response;
  try {
    res = await lookupDeps.fetch(url, { headers: { "User-Agent": NOMINATIM_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (res.status === 429 || res.status === 403 || res.status >= 500) return null;
  let found: { lat: number; lng: number } | null = null;
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as Array<{ lat?: string; lon?: string }> | null;
    const first = Array.isArray(body) ? body[0] : null;
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (first && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) found = { lat, lng };
  }
  await qRaw(`INSERT INTO location_cache (key, sealed) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed`, [key, sealText(JSON.stringify(found))]);
  return found;
}

const spotKeys = (v: Pick<Visit, "lat" | "lng" | "gid" | "fsq">) =>
  [v.gid ? `gid:${v.gid}` : null, v.fsq ? `fsq:${v.fsq}` : null, `geo:${v.lat.toFixed(4)},${v.lng.toFixed(4)}`].filter((k): k is string => !!k).map((k) => blindIndex("other", k)).filter((k): k is string => !!k);

async function cachedSpot(v: Pick<Visit, "lat" | "lng" | "gid" | "fsq">): Promise<SpotName | null | undefined> {
  const keys = spotKeys(v);
  if (!keys.length) return undefined;
  const rows = await qRaw<{ key: string; sealed: string }>(`SELECT key, sealed FROM location_cache WHERE key = ANY($1::text[])`, [keys]);
  for (const k of keys) {
    const row = rows.find((r) => r.key === k);
    if (!row) continue;
    try {
      return JSON.parse(openStrict(row.sealed)) as SpotName | null;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function cacheSpot(v: Pick<Visit, "lat" | "lng" | "gid" | "fsq">, spot: SpotName | null): Promise<void> {
  for (const k of spotKeys(v)) {
    await qRaw(`INSERT INTO location_cache (key, sealed) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed`, [k, sealText(JSON.stringify(spot))]);
  }
}

// ---------- Building a day ----------

export interface RefreshOptions {
  now?: Date;
  tz?: string;
  /** Ask Nominatim for spots nothing else names (rate limited). Off for imports: names come after, in their own requests. */
  lookups?: boolean;
  /** Stop looking things up after this (ms since epoch). */
  deadline?: number;
  /** Life log source to write into (a Life log run's own). */
  lifeLogSource?: string;
  /** Don't fetch the weather (tests, or when the names come first). */
  noWeather?: boolean;
}

export interface RefreshResult {
  days: number;
  written: number;
  skipped: number;
  /** Stops still without a name. */
  unnamed: number;
  /** Places made for the first time. */
  new_places: number;
  lookups: number;
}

const minutesIn = (v: Visit, day: string, tz: string) => {
  const s = Date.parse(v.start);
  const e = Date.parse(v.end);
  const d0 = zonedToInstant(day, "00:00", tz).getTime();
  const d1 = zonedToInstant(addDays(day, 1), "00:00", tz).getTime();
  const m = Math.max(0, Math.min(e, d1) - Math.max(s, d0)) / 60_000;
  return v.swarm && !v.timeline ? 30 : Math.round(m);
};

/**
 * Merge, name, link and write each day: the 'day' record, each Place's
 * visit days, the Life log's Places section, and the weather. The one way a
 * day's places reach a note.
 */
export async function refreshDays(dates: string[], opts: RefreshOptions = {}): Promise<RefreshResult> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const now = opts.now ?? new Date();
  const today = zonedToday(now, tz);
  const result: RefreshResult = { days: 0, written: 0, skipped: 0, unnamed: 0, new_places: 0, lookups: 0 };
  const sorted = [...new Set(dates)].filter(isValidDate).sort();
  if (!sorted.length) return result;
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  const [timeline, swarm, manual, before] = await Promise.all([
    readRows<{ visits: TimelineVisit[] }>("timeline", from, to),
    readRows<{ checkins: Checkin[] }>("swarm", from, to),
    readRows<{ visits: ManualVisit[] }>("manual", from, to),
    readRows<DayRecord>("day", from, to),
  ]);
  const known = await loadKnown();
  const geoChanged = new Set<string>();
  let lookupsOn = !!opts.lookups;

  const built: Array<{ date: string; record: DayRecord; unnamed: number; main: { lat: number; lng: number; place: string; town?: string } | null; townUnasked: boolean }> = [];
  for (const date of sorted) {
    const visits = mergeManual(mergeVisits(timeline.get(date)?.visits ?? [], swarm.get(date)?.checkins ?? []), manual.get(date)?.visits ?? [])
      .filter((v) => localDay(v.start, tz) === date);
    let unnamed = 0;
    for (const v of visits) {
      const list = [...known.values()];
      // A visit added by hand to a saved Place is that Place (while it's live).
      if (v.place && !known.has(v.place)) delete v.place;
      // Picked by hand for a Timeline visit or a check-in: the Place doesn't take on their ids, so taking the visit out leaves them as they were.
      const picked = !!v.place && !!(v.timeline || v.swarm);
      let place: KnownPlace | null = (v.place ? known.get(v.place) : undefined) ?? knownPlaceFor(v, list);
      let spot: SpotName | null = null;
      let asked = false;
      if (!nameFor(v, place, null)) {
        const cached = await cachedSpot(v);
        if (cached !== undefined) ((spot = cached), (asked = true));
        else if (lookupsOn && (!opts.deadline || Date.now() < opts.deadline)) {
          try {
            spot = await nominatim(v.lat, v.lng);
            asked = true;
            result.lookups++;
            await cacheSpot(v, spot);
          } catch (error) {
            if (error instanceof LookupBusy) lookupsOn = false;
          }
        }
      }
      const name = nameFor(v, place, spot);
      if (!name) {
        // The map was asked and knows nothing there: left unnamed for good, not waited on.
        if (!asked) unnamed++;
        continue;
      }
      v.name = name;
      v.category ??= spot?.category;
      v.town ??= spot?.town;
      // A named stop is a Place: Home, Work, a known one, a venue, or a landmark the map knows. An area alone isn't.
      if (!place && (v.kind || v.venue || v.takeout || spot?.name)) {
        const created = await upsertPlace({ name, address: v.address ?? spot?.address });
        place = { id: created.id, name, lat: v.lat, lng: v.lng, gids: [], fsqs: [], town: v.town };
        known.set(created.id, { ...place, geo: { lat: v.lat, lng: v.lng, gids: [], fsqs: [], town: v.town, seen: {} } });
        geoChanged.add(created.id);
        result.new_places++;
      }
      if (place) {
        v.place = place.id;
        const k = known.get(place.id)!;
        const g: Geo = (k.geo ??= { seen: {} });
        if (g.lat === undefined) ((g.lat = v.lat), (g.lng = v.lng), (k.lat = v.lat), (k.lng = v.lng), geoChanged.add(place.id));
        if (!picked && v.gid && !g.gids?.includes(v.gid)) ((g.gids = [...(g.gids ?? []), v.gid]), (k.gids = g.gids), geoChanged.add(place.id));
        if (!picked && v.fsq && !g.fsqs?.includes(v.fsq)) ((g.fsqs = [...(g.fsqs ?? []), v.fsq]), (k.fsqs = g.fsqs), geoChanged.add(place.id));
        if (!g.town && v.town) ((g.town = v.town), (k.town = v.town), geoChanged.add(place.id));
        v.town ??= g.town;
      }
    }
    // Where most of the day was spent decides the weather.
    const time = new Map<string, { m: number; v: Visit }>();
    for (const v of visits) {
      const key = v.place ?? `${v.lat.toFixed(2)},${v.lng.toFixed(2)}`;
      const t = time.get(key) ?? { m: 0, v };
      t.m += minutesIn(v, date, tz);
      if (!t.v.town && v.town) t.v = v;
      time.set(key, t);
    }
    const top = [...time.entries()].sort((a, b) => b[1].m - a[1].m)[0];
    const main: { lat: number; lng: number; place: string; town?: string } | null = top ? { lat: top[1].v.lat, lng: top[1].v.lng, place: top[0], town: top[1].v.town } : null;
    // The weather line says where: Home and Work have no town of their own until the map is asked once.
    let townUnasked = false;
    if (main && !main.town) {
      const spot = { lat: main.lat, lng: main.lng };
      let found = await cachedSpot(spot);
      if (found === undefined && lookupsOn && (!opts.deadline || Date.now() < opts.deadline)) {
        try {
          found = await nominatim(main.lat, main.lng);
          result.lookups++;
          await cacheSpot(spot, found);
        } catch (error) {
          if (error instanceof LookupBusy) lookupsOn = false;
        }
      }
      main.town = found?.town;
      townUnasked = found === undefined;
      const k = known.get(main.place);
      if (k && main.town) ((k.geo ??= { seen: {} }).town = main.town, (k.town = main.town), geoChanged.add(main.place));
    }
    const places: DayRecord["places"] = {};
    for (const v of visits) {
      if (!v.place) continue;
      const p = (places[v.place] ??= { n: 0, minutes: 0 });
      p.n++;
      p.minutes += minutesIn(v, date, tz);
    }
    built.push({ date, record: { visits, line: placesLine(visits, tz), weather: before.get(date)?.weather ?? null, places }, unnamed, main, townUnasked });
    result.unnamed += unnamed;
  }

  // The weather: one request per place for all its days, cached.
  const asks = opts.noWeather ? [] : built.filter((b) => b.main && b.date < today).map((b) => ({ date: b.date, lat: b.main!.lat, lng: b.main!.lng, place: b.main!.place }));
  const weather: Map<string, DayWeather> = asks.length ? await weatherFor(asks, { today, deadline: opts.deadline }) : new Map();
  for (const b of built) {
    const w = b.main ? weather.get(`${b.date}:${b.main.place}`) : undefined;
    if (w) b.record.weather = weatherLine(w, b.main!.town);
    if (!b.record.visits.length) b.record.weather = null;
  }

  for (const b of built) {
    result.days++;
    const prev = before.get(b.date);
    // Each Place's visit days: added, changed, or taken off when the day no longer has it.
    for (const id of new Set([...Object.keys(prev?.places ?? {}), ...Object.keys(b.record.places)])) {
      const k = known.get(id);
      if (!k) continue;
      const g: Geo = (k.geo ??= { seen: {} });
      const seen = (g.seen ??= {});
      const now = b.record.places[id];
      if (now && (seen[b.date]?.n !== now.n || seen[b.date]?.minutes !== now.minutes)) ((seen[b.date] = now), geoChanged.add(id));
      if (!now && seen[b.date]) (delete seen[b.date], geoChanged.add(id));
    }
    if (!prev || JSON.stringify(prev) !== JSON.stringify(b.record)) await writeRow("day", b.date, b.record, tz);
    const lines = [b.record.line, b.record.weather].filter((l): l is string => !!l);
    // The day's stops as Day entries (sealed like every entry; shown only where places are, lib/days.ts).
    const { writePlaceEntries } = await import("./days");
    await writePlaceEntries(b.date, stopsOf(b.record));
    const wrote = await writeDayNote(b.date, lines, { now, tz, source: opts.lifeLogSource });
    if (wrote === "written") result.written++;
    if (wrote === "skipped") result.skipped++;
    const waiting = b.unnamed > 0 || (!!b.record.visits.length && b.date < today && !opts.noWeather && (!b.record.weather || b.townUnasked));
    if (waiting) await qRaw(`INSERT INTO location_todo (day) VALUES ($1::date) ON CONFLICT (day) DO NOTHING`, [b.date]);
    else await qRaw(`DELETE FROM location_todo WHERE day = $1::date`, [b.date]);
  }
  for (const id of geoChanged) {
    const k = known.get(id);
    if (k?.geo) await saveGeo(id, k.geo);
  }
  return result;
}

// ---------- The day note ----------

/** Which Life log the line goes into: the one given, else the one reading Swarm, else the oldest, else the holder (lib/health.ts). */
async function lifeLogSource(given?: string): Promise<string> {
  if (given) return given;
  const [row] = await qRaw<{ source: string }>(
    `SELECT c.source FROM collections c WHERE c.recipe = 'life-log'
     ORDER BY EXISTS (SELECT 1 FROM connectors k WHERE k.id = ANY(c.connector_ids) AND k.provider = 'swarm') DESC, c.created_at LIMIT 1`,
  );
  return row?.source ?? HOLDER_SOURCE;
}

export async function lifeLogName(): Promise<string | null> {
  const [row] = await q<{ name: string }>(
    `SELECT c.name FROM collections c WHERE c.recipe = 'life-log'
     ORDER BY EXISTS (SELECT 1 FROM connectors k WHERE k.id = ANY(c.connector_ids) AND k.provider = 'swarm') DESC, c.created_at LIMIT 1`,
  );
  return row?.name ?? null;
}

/** Days replace the Life log's day notes: the day's places are opened from the sealed 'day' row when it's read (lib/days.ts). The day is marked changed. */
async function writeDayNote(date: string, lines: string[], _ctx: { now: Date; tz: string; source?: string }): Promise<"written" | "unchanged" | "skipped"> {
  await touchDays([date]);
  return lines.length ? "written" : "unchanged";
}

// ---------- Timeline imports ----------

export const MAX_IMPORT_DAYS = 31;
export const MAX_IMPORT_VISITS = 1500;
const VISIT_FIELDS = new Set(["start", "end", "lat", "lng", "place_id", "name", "kind"]);

/** One request's days from the browser, checked: only visits, only these fields, each on the day it says. */
export function readTimelineDays(raw: unknown, ctx: { tz: string; today: string }): Array<{ date: string; visits: TimelineVisit[] }> {
  const days = (raw as { days?: unknown } | null)?.days;
  if (!Array.isArray(days) || !days.length) throw new AthenaInputError("Send days: [{ date, visits }]");
  if (days.length > MAX_IMPORT_DAYS) throw new AthenaInputError(`At most ${MAX_IMPORT_DAYS} days at a time`);
  let count = 0;
  return days.map((d) => {
    const o = d as { date?: unknown; visits?: unknown };
    if (typeof o?.date !== "string" || !isValidDate(o.date)) throw new AthenaInputError("Each day needs a date, YYYY-MM-DD");
    if (o.date > ctx.today) throw new AthenaInputError(`${o.date} hasn't happened yet`);
    if (!Array.isArray(o.visits)) throw new AthenaInputError(`${o.date}: visits must be a list`);
    count += o.visits.length;
    if (count > MAX_IMPORT_VISITS) throw new AthenaInputError(`At most ${MAX_IMPORT_VISITS} visits at a time`);
    const visits = o.visits.map((v) => {
      const x = v as Record<string, unknown>;
      for (const k of Object.keys(x ?? {})) if (!VISIT_FIELDS.has(k)) throw new AthenaInputError(`Unknown field ${k}. Visits carry only ${[...VISIT_FIELDS].join(", ")}`);
      const start = typeof x.start === "string" && Number.isFinite(Date.parse(x.start)) ? new Date(x.start).toISOString() : null;
      const end = typeof x.end === "string" && Number.isFinite(Date.parse(x.end)) ? new Date(x.end).toISOString() : null;
      if (!start || !end || end < start) throw new AthenaInputError(`${o.date}: each visit needs start and end times`);
      if (Date.parse(end) - Date.parse(start) > 4 * 86_400_000) throw new AthenaInputError(`${o.date}: a visit can't last more than four days`);
      if (localDay(start, ctx.tz) !== o.date) throw new AthenaInputError(`${o.date}: a visit starts on another day`);
      const lat = Number(x.lat);
      const lng = Number(x.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new AthenaInputError(`${o.date}: coordinates out of range`);
      const out: TimelineVisit = { start, end, lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
      if (x.place_id !== undefined) {
        if (typeof x.place_id !== "string" || !/^[\w-]{10,300}$/.test(x.place_id)) throw new AthenaInputError(`${o.date}: place_id isn't a Google place id`);
        out.place_id = x.place_id;
      }
      if (x.name !== undefined) {
        if (typeof x.name !== "string" || !x.name.trim() || x.name.length > 120) throw new AthenaInputError(`${o.date}: a name is up to 120 characters`);
        out.name = x.name.trim();
      }
      if (x.kind !== undefined) {
        if (x.kind !== "home" && x.kind !== "work") throw new AthenaInputError(`${o.date}: kind is home or work`);
        out.kind = x.kind;
      }
      if (Date.parse(end) - Date.parse(start) < MIN_VISIT_MINUTES * 60_000) return null;
      return out;
    });
    return { date: o.date, visits: visits.filter((v): v is TimelineVisit => !!v) };
  });
}

const visitKey = (v: TimelineVisit) => `${v.start}|${v.lat.toFixed(4)}|${v.lng.toFixed(4)}`;

export interface ImportResult {
  days: number;
  /** Visits that weren't in Athena yet. */
  added: number;
  /** Days already up to date. */
  unchanged: number;
  /** Days you'd archived or deleted, left alone. */
  skipped: number;
  new_places: number;
  /** Days still waiting for names or weather (POST /api/places/names fills them in). */
  waiting: number;
}

/** Save one request's Timeline days (merged with what's there, so a repeat import adds nothing), then refresh them. */
export async function importTimeline(raw: unknown, opts: { now?: Date; tz?: string; deadline?: number } = {}): Promise<ImportResult> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const now = opts.now ?? new Date();
  const days = readTimelineDays(raw, { tz, today: zonedToday(now, tz) });
  const dates = days.map((d) => d.date).sort();
  const stored = await readRows<{ visits: TimelineVisit[] }>("timeline", dates[0], dates[dates.length - 1]);
  const done = await readRows<DayRecord>("day", dates[0], dates[dates.length - 1]);
  let added = 0;
  const changed: string[] = [];
  for (const d of days) {
    const have = stored.get(d.date)?.visits ?? [];
    const keys = new Set(have.map(visitKey));
    const fresh = d.visits.filter((v) => !keys.has(visitKey(v)));
    if (!fresh.length && done.has(d.date)) continue;
    added += fresh.length;
    if (fresh.length) await writeRow("timeline", d.date, { visits: [...have, ...fresh].sort((a, b) => a.start.localeCompare(b.start)) }, tz);
    changed.push(d.date);
  }
  const r = await refreshDays(changed, { now, tz, deadline: opts.deadline });
  return { days: days.length, added, unchanged: days.length - changed.length, skipped: r.skipped, new_places: r.new_places, waiting: await waitingDays() };
}

// ---------- Swarm ----------

/** Save check-ins by day: "replace" for the days a sync read in full (so a deleted check-in goes), "merge" for older pages. */
export async function saveCheckins(byDay: Map<string, Checkin[]>, mode: "replace" | "merge", opts: { now?: Date; tz?: string; lifeLogSource?: string; deadline?: number; lookups?: boolean } = {}): Promise<RefreshResult & { changed: number }> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const dates = [...byDay.keys()].sort();
  if (!dates.length) return { days: 0, written: 0, skipped: 0, unnamed: 0, new_places: 0, lookups: 0, changed: 0 };
  const stored = await readRows<{ checkins: Checkin[] }>("swarm", dates[0], dates[dates.length - 1]);
  const changed: string[] = [];
  for (const date of dates) {
    const incoming = byDay.get(date)!;
    const have = stored.get(date)?.checkins ?? [];
    const merged = mode === "replace" ? incoming : [...have.filter((c) => !incoming.some((i) => i.id === c.id)), ...incoming];
    merged.sort((a, b) => a.at.localeCompare(b.at));
    if (JSON.stringify(merged) === JSON.stringify(have)) continue;
    await writeRow("swarm", date, { checkins: merged }, tz);
    changed.push(date);
  }
  const r = await refreshDays(changed, { now: opts.now, tz, lifeLogSource: opts.lifeLogSource, deadline: opts.deadline, lookups: opts.lookups });
  return { ...r, changed: changed.length };
}

// ---------- Visits added by hand ----------

/**
 * One visit typed in, for someone without Swarm or a Timeline file: a saved
 * Place (its spot from place_geo, else its address looked up) or a typed
 * address, the day, when they got there and how long they stayed. Kept per
 * day under source 'manual', sealed like the others, and merged into the day
 * by refreshDays as a stop of its own.
 */
export interface ManualVisit {
  id: string;
  start: string;
  end: string;
  lat: number;
  lng: number;
  /** The saved Place it was added to. */
  place?: string;
  /** The Place's name, or the name typed with an address. */
  name?: string;
  address?: string;
}

/** A visit added by hand, as the app sends it (checked). */
export interface ManualVisitInput {
  date: string;
  /** "HH:MM", in the owner's zone. */
  time: string;
  minutes: number;
  place_id?: string;
  address?: string;
  name?: string;
}

export const MAX_MANUAL_MINUTES = 24 * 60;
export const MAX_MANUAL_PER_DAY = 50;
const MANUAL_FIELDS = new Set(["date", "time", "minutes", "place_id", "address", "name"]);
const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check one visit from the app: a day up to today, a time, minutes stayed, and a saved Place or an address. Pure. */
export function readManualVisit(raw: unknown, ctx: { today: string }): ManualVisitInput {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) throw new AthenaInputError("Send the visit as JSON: date, time, minutes, and place_id or address");
  for (const k of Object.keys(o)) if (!MANUAL_FIELDS.has(k)) throw new AthenaInputError(`Unknown field ${k}. A visit carries only ${[...MANUAL_FIELDS].join(", ")}`);
  const date = o.date === undefined || o.date === "" ? ctx.today : o.date;
  if (typeof date !== "string" || !isValidDate(date)) throw new AthenaInputError("date: YYYY-MM-DD");
  if (date > ctx.today) throw new AthenaInputError(`${date} hasn't happened yet`);
  if (typeof o.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) throw new AthenaInputError("time: when you got there, HH:MM");
  const minutes = Number(o.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MANUAL_MINUTES) throw new AthenaInputError("minutes: how long you stayed, 1 to 1,440");
  const out: ManualVisitInput = { date, time: o.time, minutes };
  if (o.place_id !== undefined && o.place_id !== null && o.place_id !== "") {
    if (typeof o.place_id !== "string" || !PLACE_ID.test(o.place_id)) throw new AthenaInputError("place_id isn't a Place");
    out.place_id = o.place_id;
  }
  if (typeof o.address === "string" && o.address.trim()) {
    const a = o.address.trim().replace(/\s+/g, " ");
    if (a.length < 4 || a.length > 300) throw new AthenaInputError("An address is 4 to 300 characters");
    out.address = a;
  } else if (o.address !== undefined && o.address !== null && o.address !== "") throw new AthenaInputError("address: text");
  if (typeof o.name === "string" && o.name.trim()) {
    if (o.name.trim().length > 120) throw new AthenaInputError("A name is up to 120 characters");
    out.name = o.name.trim();
  } else if (o.name !== undefined && o.name !== null && o.name !== "") throw new AthenaInputError("name: text");
  if (!out.place_id && !out.address) throw new AthenaInputError("Pick a Place or type an address");
  if (out.place_id && out.address) throw new AthenaInputError("Send a Place or an address, not both");
  return out;
}

/** When a visit added by hand starts and ends, as instants: the arrival in the owner's zone, plus the minutes. Pure. */
export function manualTimes(input: Pick<ManualVisitInput, "date" | "time" | "minutes">, tz: string): { start: string; end: string } {
  const start = zonedToInstant(input.date, input.time, tz);
  return { start: start.toISOString(), end: new Date(start.getTime() + input.minutes * 60_000).toISOString() };
}

/** A visit added by hand as one of the day's stops. Pure. */
export function manualAsVisit(m: ManualVisit): Visit {
  return clean({ start: m.start, end: m.end, lat: m.lat, lng: m.lng, venue: m.name, address: m.address, place: m.place, manual: true, manual_ids: [m.id] });
}

/** What the app lists: a visit added by hand with its day and minutes. No coordinates. */
export interface ManualVisitRow {
  id: string;
  date: string;
  start: string;
  minutes: number;
  place_id?: string;
  /** The Place's name now, else the name given, else the address. */
  name: string;
  address?: string;
}

/** Visits added by hand in [from, to], newest first. */
export async function listManualVisits(from: string, to: string): Promise<ManualVisitRow[]> {
  const [rows, merged] = await Promise.all([readRows<{ visits: ManualVisit[] }>("manual", from, to), readRows<DayRecord>("day", from, to)]);
  const ids = [...new Set([...rows.values()].flatMap((r) => r.visits.map((v) => v.place)).filter((id): id is string => !!id))];
  const names = new Map((ids.length ? await q<{ id: string; name: string }>(`SELECT id, name FROM places WHERE id = ANY($1::uuid[])`, [ids]) : []).map((p) => [p.id, p.name]));
  const out: ManualVisitRow[] = [];
  for (const [date, r] of rows) {
    for (const v of r.visits ?? []) {
      // What the day calls it: the Place it was added to or matched, or the map's name for a typed address.
      const stop = merged.get(date)?.visits.find((x) => x.manual_ids?.includes(v.id));
      out.push({
        id: v.id,
        date,
        start: v.start,
        minutes: Math.max(1, Math.round((Date.parse(v.end) - Date.parse(v.start)) / 60_000)),
        ...(v.place ? { place_id: v.place } : stop?.place ? { place_id: stop.place } : {}),
        name: (v.place && names.get(v.place)) || stop?.name || v.name || v.address || "A place",
        ...(v.address ? { address: v.address } : {}),
      });
    }
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

/** Where a saved Place is: its spot from a visit, else its address on the map. */
async function placeSpot(placeId: string): Promise<{ name: string; lat: number; lng: number }> {
  const place = (await getRecord("place", placeId)) as { id: string; name: string; address?: string | null } | null;
  if (!place) throw new AthenaInputError("That Place isn't there any more", 404);
  const k = (await loadKnown()).get(placeId);
  if (k?.lat !== undefined && k.lng !== undefined) return { name: place.name, lat: k.lat, lng: k.lng };
  const found = place.address?.trim() ? await geocodeAddress(place.address) : null;
  if (!found) throw new AthenaInputError(place.address?.trim() ? `Athena couldn't find ${place.name}'s address on the map. Check it on the Place, or type the address here.` : `${place.name} has no address yet. Add one on the Place, or type the address here.`);
  return { name: place.name, ...found };
}

/** Add one visit by hand and rebuild its day (the merged record, the day's Places entries, each Place's visits). */
export async function addManualVisit(raw: unknown, opts: { now?: Date; tz?: string; deadline?: number } = {}): Promise<ManualVisitRow> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const now = opts.now ?? new Date();
  const input = readManualVisit(raw, { today: zonedToday(now, tz) });
  let spot: { lat: number; lng: number };
  let name = input.name;
  if (input.place_id) {
    const p = await placeSpot(input.place_id);
    spot = p;
    name = p.name;
  } else {
    const found = await geocodeAddress(input.address!);
    if (!found) throw new AthenaInputError("Athena couldn't find that address on the map. Try adding the town or the postcode.");
    spot = found;
  }
  const have = (await readRows<{ visits: ManualVisit[] }>("manual", input.date, input.date)).get(input.date)?.visits ?? [];
  if (have.length >= MAX_MANUAL_PER_DAY) throw new AthenaInputError(`At most ${MAX_MANUAL_PER_DAY} visits a day by hand`);
  const visit: ManualVisit = clean({
    id: randomUUID(),
    ...manualTimes(input, tz),
    lat: Math.round(spot.lat * 1e5) / 1e5,
    lng: Math.round(spot.lng * 1e5) / 1e5,
    place: input.place_id,
    name,
    address: input.address,
  });
  await writeRow("manual", input.date, { visits: [...have, visit].sort((a, b) => a.start.localeCompare(b.start)) }, tz);
  // A typed address with no name is named by the map: one lookup, cached.
  await refreshDays([input.date], { now, tz, lookups: true, deadline: opts.deadline });
  const [row] = (await listManualVisits(input.date, input.date)).filter((v) => v.id === visit.id);
  return row;
}

/** Take a visit added by hand out and rebuild its day. False when it isn't there. */
export async function removeManualVisit(date: string, id: string, opts: { now?: Date; tz?: string; deadline?: number } = {}): Promise<boolean> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  if (!isValidDate(date)) throw new AthenaInputError("date: YYYY-MM-DD");
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const have = (await readRows<{ visits: ManualVisit[] }>("manual", date, date)).get(date)?.visits ?? [];
  const rest = have.filter((v) => v.id !== id);
  if (rest.length === have.length) return false;
  if (rest.length) await writeRow("manual", date, { visits: rest }, tz);
  else await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND source = 'manual' AND day = $1::date`, [date]);
  await refreshDays([date], { now: opts.now, tz, deadline: opts.deadline });
  // A day left with no visits at all has no record: it no longer counts as a day of places.
  const after = (await readRows<DayRecord>("day", date, date)).get(date);
  if (after && !after.visits.length) await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND source = 'day' AND day = $1::date`, [date]);
  return true;
}

// ---------- Names that wait ----------

export async function waitingDays(): Promise<number> {
  const [row] = await qRaw<{ n: string }>(`SELECT count(*) AS n FROM location_todo`);
  return Number(row?.n ?? 0);
}

/**
 * Look up names (and the weather) for days still waiting, newest first,
 * until `budgetMs` runs out. One caller at a time (an advisory lock), so
 * Nominatim never gets more than one request a second from Athena.
 */
export async function nameWaitingDays(budgetMs = 8_000, opts: { now?: Date; tz?: string } = {}): Promise<{ lookups: number; days: number; waiting: number; busy?: boolean }> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const deadline = Date.now() + budgetMs;
  const tz = opts.tz ?? (await getOwnerTimeZone());
  return tx(async (run) => {
    const [lock] = await run<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(31031) AS ok`);
    if (!lock?.ok) return { lookups: 0, days: 0, waiting: await waitingDays(), busy: true };
    const days = await qRaw<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM location_todo ORDER BY day DESC LIMIT 60`);
    let lookups = 0;
    let n = 0;
    for (const { day } of days) {
      if (Date.now() > deadline) break;
      const r = await refreshDays([day], { now: opts.now, tz, lookups: true, deadline });
      lookups += r.lookups;
      n++;
    }
    return { lookups, days: n, waiting: await waitingDays() };
  });
}

// ---------- Reading ----------

export interface PlaceVisits {
  /** Visits in all (two stops on one day count twice). */
  count: number;
  days: number;
  first: string | null;
  last: string | null;
  /** The latest few days, newest first. */
  recent: Array<{ date: string; minutes: number; n: number }>;
  /** Visits in each of the last 12 months, oldest first, ending with this month ("2026-11"). */
  months: Array<{ month: string; n: number }>;
}

/** When you've been to a Place: "Visited 6 times · last 3 Nov". Null for a Place with no visits. */
export async function placeVisits(placeId: string, opts: { now?: Date; tz?: string } = {}): Promise<PlaceVisits | null> {
  const [row] = await qRaw<{ sealed: string }>(`SELECT sealed FROM place_geo WHERE place_id = $1`, [placeId]);
  if (!row) return null;
  let geo: Geo;
  try {
    geo = JSON.parse(openStrict(row.sealed)) as Geo;
  } catch {
    return null;
  }
  const days = Object.entries(geo.seen ?? {}).sort(([a], [b]) => b.localeCompare(a));
  if (!days.length) return null;
  const today = zonedToday(opts.now ?? new Date(), opts.tz ?? (await getOwnerTimeZone()));
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 12 + i, 1));
    const month = d.toISOString().slice(0, 7);
    return { month, n: days.filter(([day]) => day.startsWith(month)).reduce((n, [, s]) => n + s.n, 0) };
  });
  return {
    count: days.reduce((n, [, s]) => n + s.n, 0),
    days: days.length,
    first: days[days.length - 1][0],
    last: days[0][0],
    recent: days.slice(0, 5).map(([date, s]) => ({ date, minutes: s.minutes, n: s.n })),
    months,
  };
}

export interface PlacesStatus {
  days: number;
  first: string | null;
  last: string | null;
  waiting: number;
  places: number;
  life_log: string | null;
  /** The Life log's notes, for "Open Life log" (#/notes?source=…). */
  life_log_source: string;
  swarm: boolean;
  /** The newest day's Places lines, for the Places page: "Lunch at Dishoom, then Hampstead Heath", "14° and rain in London". */
  latest: { date: string; lines: string[] } | null;
}

/** What the import sheet and the Places page show: no place, no coordinates. */
export async function placesStatus(): Promise<PlacesStatus> {
  const [d] = await qRaw<{ n: string; first: string | null; last: string | null }>(
    `SELECT count(*) AS n, to_char(min(day), 'YYYY-MM-DD') AS first, to_char(max(day), 'YYYY-MM-DD') AS last FROM sensitive_blobs WHERE domain = 'location' AND source = 'day'`,
  );
  const [p] = await qRaw<{ n: string }>(`SELECT count(*) AS n FROM place_geo g JOIN places p ON p.id = g.place_id WHERE p.archived_at IS NULL`);
  const [s] = await qRaw<{ n: string }>(`SELECT count(*) AS n FROM connectors WHERE provider = 'swarm'`);
  return {
    days: Number(d?.n ?? 0),
    first: d?.first ?? null,
    last: d?.last ?? null,
    waiting: await waitingDays(),
    places: Number(p?.n ?? 0),
    life_log: await lifeLogName(),
    life_log_source: await lifeLogSource(),
    swarm: Number(s?.n ?? 0) > 0,
    latest: d?.last ? await latestLines(d.last) : null,
  };
}

/** The newest day that has something to say, at most a week before `last`. */
async function latestLines(last: string): Promise<{ date: string; lines: string[] } | null> {
  const rows = await readRows<DayRecord>("day", addDays(last, -7), last);
  for (const date of [...rows.keys()].sort().reverse()) {
    const r = rows.get(date)!;
    const lines = [r.line, r.weather].filter((l): l is string => !!l);
    if (lines.length) return { date, lines };
  }
  return null;
}

// ---------- Key rotation ----------

/**
 * After a key rotation: drop the cache entries still under an old key
 * (lib/encryption.ts calls this). Visits and Place coordinates are re-sealed
 * by the backfill itself (ENCRYPTED there). In key order with a cursor, so
 * entries that won't open are counted and passed.
 */
export async function resealPlaces(budgetMs = 5_000): Promise<{ resealed: number; failed: number }> {
  const kid = currentKeyId();
  const report = { resealed: 0, failed: 0 };
  if (!kid) return report;
  const started = Date.now();
  const old = `enc:v1:${kid}:%`;
  let after = "";
  for (;;) {
    const rows = await qRaw<{ id: string; v: string }>(`SELECT key AS id, sealed AS v FROM location_cache WHERE sealed NOT LIKE $1 AND key > $2 ORDER BY key LIMIT 200`, [old, after]);
    if (!rows.length) return report;
    for (const r of rows) {
      if (Date.now() - started > budgetMs) return report;
      try {
        // The cache is keyed by the old index key too: dropped, looked up again when needed.
        openStrict(r.v);
        await qRaw(`DELETE FROM location_cache WHERE key = $1 AND sealed = $2`, [r.id, r.v]);
        report.resealed++;
      } catch {
        report.failed++;
      }
    }
    after = rows[rows.length - 1].id;
  }
}

// ---------- Days (lib/days.ts) ----------

/** One day's places, opened for the Days API: named stops in the order of the day, the places line and the weather line. No coordinates. */
export interface PlaceDay {
  line: string | null;
  weather: string | null;
  places: Array<{ id?: string; name: string; minutes?: number }>;
}

/** A day's named stops in the order of the day, one per Place (or name), with the minutes spent there. */
export function stopsOf(r: Pick<DayRecord, "visits">): PlaceDay["places"] {
  const stops: PlaceDay["places"] = [];
  for (const v of [...(r.visits ?? [])].sort((a, b) => a.start.localeCompare(b.start))) {
    if (!v.name) continue;
    const minutes = Math.max(0, Math.round((Date.parse(v.end) - Date.parse(v.start)) / 60_000)) || undefined;
    const same = stops.find((s) => (v.place ? s.id === v.place : !s.id && s.name === v.name));
    if (same) {
      if (minutes) same.minutes = (same.minutes ?? 0) + minutes;
      continue;
    }
    stops.push({ ...(v.place ? { id: v.place } : {}), name: v.name, ...(minutes ? { minutes } : {}) });
  }
  return stops;
}

/** Every day in [from, to] with a merged record. Days that won't open are left out. */
export async function placeDays(from: string, to: string): Promise<Map<string, PlaceDay>> {
  const rows = await readRows<DayRecord>("day", from, to);
  const out = new Map<string, PlaceDay>();
  for (const [day, r] of rows) {
    const stops = stopsOf(r);
    out.set(day, { line: r.line ?? null, weather: r.weather ?? null, places: stops });
  }
  return out;
}

/**
 * Where most of a day was spent (the place its weather line is for), from
 * that day's merged record: the same rule refreshDays uses. null without a
 * record or visits.
 */
export async function dayMainSpot(day: string, tz: string): Promise<{ lat: number; lng: number; town?: string } | null> {
  const r = (await readRows<DayRecord>("day", day, day)).get(day);
  const time = new Map<string, { m: number; v: Visit }>();
  for (const v of r?.visits ?? []) {
    const key = v.place ?? `${v.lat.toFixed(2)},${v.lng.toFixed(2)}`;
    const t = time.get(key) ?? { m: 0, v };
    t.m += minutesIn(v, day, tz);
    if (!t.v.town && v.town) t.v = v;
    time.set(key, t);
  }
  const top = [...time.values()].sort((a, b) => b.m - a.m)[0];
  return top ? { lat: top.v.lat, lng: top.v.lng, ...(top.v.town ? { town: top.v.town } : {}) } : null;
}
