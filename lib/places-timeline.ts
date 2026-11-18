/**
 * Google Maps Timeline, read in the browser: only the visits leave the
 * device (start, end, coordinates, Google's place id or name, home or work).
 * Routes, raw signals, activities and addresses stay on the phone or laptop.
 *
 * Three shapes are read:
 *  - The phone export (Settings → Location → Timeline → Export), Android:
 *    `{ semanticSegments: [{ startTime, endTime, visit: { hierarchyLevel,
 *    topCandidate: { placeId, semanticType, placeLocation: { latLng:
 *    "51.53°, -0.14°" } } } }] }`.
 *  - The same export from an iPhone: a bare array of segments, with
 *    `placeID` and `placeLocation: "geo:51.53,-0.14"`, numbers as text.
 *  - Takeout's older "Semantic Location History" (one file a month):
 *    `{ timelineObjects: [{ placeVisit: { location: { latitudeE7,
 *    longitudeE7, placeId, name, semanticType }, duration: {
 *    startTimestamp | startTimestampMs, … } } }] }`, which often has names.
 *
 * Pure: shared by the app (timeline-import.ts) and the server's checks.
 */

export interface TimelineVisit {
  /** ISO 8601 instants. */
  start: string;
  end: string;
  lat: number;
  lng: number;
  /** Google's place id ("ChIJ…"), when the export has one. */
  place_id?: string;
  /** Only the older Takeout files carry names. */
  name?: string;
  /** Google's Home and Work labels. */
  kind?: "home" | "work";
}

export interface TimelineParse {
  format: "phone" | "takeout";
  visits: TimelineVisit[];
  /** Segments that weren't visits (routes, activities): counted, never sent. */
  other: number;
}

export class TimelineError extends Error {
  constructor(readonly code: "not_timeline" | "raw_records" | "empty" | "bad_json") {
    super(code);
    this.name = "TimelineError";
  }
}

/** Visits shorter than this aren't places you went (a red light, a slow walk past). */
export const MIN_VISIT_MINUTES = 5;

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
const okLat = (n: number) => Number.isFinite(n) && n >= -90 && n <= 90;
const okLng = (n: number) => Number.isFinite(n) && n >= -180 && n <= 180;

/** "51.5345°, -0.1427°", "geo:51.5345,-0.1427", "51.5345,-0.1427" → [lat, lng]. */
export function readLatLng(raw: unknown): [number, number] | null {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("latLng" in o) return readLatLng(o.latLng);
    if ("latitudeE7" in o) return pair(Number(o.latitudeE7) / 1e7, Number(o.longitudeE7) / 1e7);
    return null;
  }
  if (typeof raw !== "string") return null;
  const m = /^\s*(?:geo:)?\s*(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?\s*$/.exec(raw);
  return m ? pair(Number(m[1]), Number(m[2])) : null;
}

function pair(lat: number, lng: number): [number, number] | null {
  if (!okLat(lat) || !okLng(lng) || (lat === 0 && lng === 0)) return null;
  return [round5(lat), round5(lng)];
}

function instant(raw: unknown): string | null {
  if (typeof raw === "number" || (typeof raw === "string" && /^\d{11,14}$/.test(raw))) {
    const d = new Date(Number(raw));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function kindOf(raw: unknown): TimelineVisit["kind"] {
  const s = String(raw ?? "").toLowerCase();
  if (/home/.test(s)) return "home";
  if (/work/.test(s)) return "work";
  return undefined;
}

const placeId = (raw: unknown): string | undefined => (typeof raw === "string" && /^[\w-]{10,300}$/.test(raw) ? raw : undefined);
const nameOf = (raw: unknown): string | undefined => (typeof raw === "string" && raw.trim() ? raw.trim().replace(/\s+/g, " ").slice(0, 120) : undefined);

function visit(start: unknown, end: unknown, at: [number, number] | null, extra: { place_id?: unknown; name?: unknown; kind?: unknown }): TimelineVisit | null {
  const s = instant(start);
  const e = instant(end);
  if (!s || !e || !at) return null;
  if (Date.parse(e) - Date.parse(s) < MIN_VISIT_MINUTES * 60_000) return null;
  const v: TimelineVisit = { start: s, end: e, lat: at[0], lng: at[1] };
  const id = placeId(extra.place_id);
  const name = nameOf(extra.name);
  const kind = kindOf(extra.kind);
  if (id) v.place_id = id;
  if (name) v.name = name;
  if (kind) v.kind = kind;
  return v;
}

/** The phone export's segments (Android object or iPhone array). */
function fromSegments(segments: unknown[]): TimelineParse {
  const visits: TimelineVisit[] = [];
  let other = 0;
  for (const seg of segments) {
    const s = seg as Record<string, unknown> | null;
    const v = s?.visit as Record<string, unknown> | undefined;
    if (!v) {
      other++;
      continue;
    }
    // Level 0 is where you were; higher levels are places inside it.
    if (Number(v.hierarchyLevel ?? 0) > 0) continue;
    const top = (v.topCandidate ?? {}) as Record<string, unknown>;
    const found = visit(s!.startTime, s!.endTime, readLatLng(top.placeLocation), { place_id: top.placeId ?? top.placeID, kind: top.semanticType });
    if (found) visits.push(found);
  }
  return { format: "phone", visits, other };
}

/** One month of Takeout's Semantic Location History. */
function fromTimelineObjects(objects: unknown[]): TimelineParse {
  const visits: TimelineVisit[] = [];
  let other = 0;
  for (const o of objects) {
    const pv = (o as Record<string, unknown> | null)?.placeVisit as Record<string, unknown> | undefined;
    if (!pv) {
      other++;
      continue;
    }
    const loc = (pv.location ?? {}) as Record<string, unknown>;
    const d = (pv.duration ?? {}) as Record<string, unknown>;
    const found = visit(d.startTimestamp ?? d.startTimestampMs, d.endTimestamp ?? d.endTimestampMs, readLatLng(loc), {
      place_id: loc.placeId,
      name: loc.name,
      kind: loc.semanticType,
    });
    if (found) visits.push(found);
  }
  return { format: "takeout", visits, other };
}

/** One file's text. Throws TimelineError when it isn't a Timeline. */
export function parseTimeline(text: string): TimelineParse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TimelineError("bad_json");
  }
  const obj = data as Record<string, unknown> | null;
  let parsed: TimelineParse;
  if (Array.isArray(data) && data.some((s) => s && typeof s === "object" && ("visit" in s || "activity" in s || "timelinePath" in s))) parsed = fromSegments(data);
  else if (obj && Array.isArray(obj.semanticSegments)) parsed = fromSegments(obj.semanticSegments);
  else if (obj && Array.isArray(obj.timelineObjects)) parsed = fromTimelineObjects(obj.timelineObjects);
  else if (obj && (Array.isArray(obj.locations) || Array.isArray(obj.rawSignals))) throw new TimelineError("raw_records");
  else throw new TimelineError("not_timeline");
  return parsed;
}

/**
 * Several files' visits as one list: sorted, the same visit from two files
 * (or a month boundary) kept once.
 */
export function mergeParses(parses: TimelineParse[]): TimelineParse {
  const seen = new Set<string>();
  const visits: TimelineVisit[] = [];
  for (const v of parses.flatMap((p) => p.visits).sort((a, b) => a.start.localeCompare(b.start))) {
    const key = `${v.start}|${v.end}|${v.lat.toFixed(4)}|${v.lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    visits.push(v);
  }
  return { format: parses.some((p) => p.format === "phone") ? "phone" : "takeout", visits, other: parses.reduce((n, p) => n + p.other, 0) };
}

/** A Takeout zip's Semantic Location History files ("2019/2019_JANUARY.json"). */
export const TAKEOUT_MONTH = /(^|\/)Semantic Location History\/\d{4}\/[^/]+\.json$/i;
/** The phone export, or a renamed copy of it. */
export const PHONE_FILE = /(^|\/)(Timeline|location-history|Zeitachse|Cronologia)[^/]*\.json$/i;

/** The local day (YYYY-MM-DD) of an instant in a zone. */
export function localDay(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface TimelineDay {
  date: string;
  visits: TimelineVisit[];
}

/** Visits by the local day each starts on, oldest day first. */
export function groupVisitsByDay(visits: TimelineVisit[], tz: string): TimelineDay[] {
  const by = new Map<string, TimelineVisit[]>();
  for (const v of visits) {
    const d = localDay(v.start, tz);
    const list = by.get(d) ?? [];
    list.push(v);
    by.set(d, list);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, visits: list.sort((a, b) => a.start.localeCompare(b.start)) }));
}

/** Whole days per request: at most `maxDays` days or `maxVisits` visits. */
export function batchVisitDays(days: TimelineDay[], maxDays = 31, maxVisits = 1500): TimelineDay[][] {
  const out: TimelineDay[][] = [];
  let cur: TimelineDay[] = [];
  let n = 0;
  for (const d of days) {
    if (cur.length && (cur.length >= maxDays || n + d.visits.length > maxVisits)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push({ date: d.date, visits: d.visits.slice(0, maxVisits) });
    n += Math.min(d.visits.length, maxVisits);
  }
  if (cur.length) out.push(cur);
  return out;
}
