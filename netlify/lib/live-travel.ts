/**
 * Live trains and Tube lines: two small read-only clients.
 *
 *  - National Rail departures, from the Live Departure Board on the Rail Data
 *    Marketplace (Darwin, National Rail's own feed). For a train booking
 *    leaving in the next 3 hours: the board at the station it leaves from,
 *    filtered to trains calling where it's going, and the service at the
 *    booked time. Picked over Realtime Trains because it's the official
 *    source, free with commercial use allowed, versioned (20220120) and
 *    answers "this station, these minutes" with one GET and only station
 *    codes; RTT replaced its API in 2026 and its terms are non-commercial.
 *  - TfL line status, from the Unified API: every Tube, Elizabeth line,
 *    Overground and DLR line in one GET, filtered here, so not even the line
 *    ids leave Athena.
 *
 * Keys come from Sources (the National Rail and TfL accounts,
 * lib/presets/live-travel.ts) through travelKey() (travel-key.ts), or else
 * the environment: ATHENA_RDM_KEY (the Live Departure Board product's
 * consumer key) and ATHENA_TFL_KEY (a TfL app key). Without one,
 * that half is off and every call returns null: never an error, and the
 * push, briefing and card say what they said before. Answers are cached in
 * memory for 2 minutes, each request gives up after 4 seconds, and any
 * failure (timeout, a 5xx, an answer we can't read) is null too.
 *
 * Nothing personal is sent: station codes, a time window and the key. No
 * storage beyond the cache; no tables.
 */

import type { BookingLike } from "../../lib/trip-text";
import { TFL_LINES } from "../../lib/stations";
import { boardTime, bookingStations, destinationName, liveCandidate, type LineStatus, type TrainStatus } from "../../lib/live-travel-text";
import { knownTravelKey, readEnv, travelKey, type TravelKeyDeps } from "./travel-key";

export type { LineStatus, TrainStatus } from "../../lib/live-travel-text";

/** The Live Departure Board on the Rail Data Marketplace. ATHENA_RDM_URL replaces it if the product page gives another. */
export const RDM_BOARD_URL = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepartureBoard";
export const TFL_STATUS_URL = "https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,overground,dlr/Status";
export const TIMEOUT_MS = 4_000;
export const CACHE_MS = 2 * 60_000;

export interface LiveDeps {
  fetch?: typeof fetch;
  now?: Date;
  /** Reads an environment variable; tests pass their own. */
  env?: (name: string) => string | undefined;
  /** The keys stored in Sources; tests pass their own (travel-key.ts). */
  stored?: TravelKeyDeps["stored"];
}

const key = (deps: LiveDeps, kind: "national-rail" | "tfl") => travelKey(kind, { env: deps.env, stored: deps.stored, now: deps.now });

/**
 * Which halves are switched on, without waiting: the environment's keys, and
 * stored ones this instance has read lately (travel-key.ts primeTravelKeys).
 * liveTravelReady reads the stored keys first.
 */
export function liveTravelConfigured(deps: Pick<LiveDeps, "env"> = {}): { trains: boolean; lines: boolean } {
  return { trains: knownTravelKey("national-rail", deps), lines: knownTravelKey("tfl", deps) };
}

/** Which halves are switched on, stored keys included. */
export async function liveTravelReady(deps: LiveDeps = {}): Promise<{ trains: boolean; lines: boolean }> {
  const [trains, lines] = await Promise.all([key(deps, "national-rail"), key(deps, "tfl")]);
  return { trains: !!trains, lines: !!lines };
}

// ---------- the cache ----------

const cache = new Map<string, { at: number; value: unknown }>();

/** For tests: start from nothing. */
export function clearLiveCache(): void {
  cache.clear();
}

async function cachedJson(cacheKey: string, url: string, init: RequestInit, deps: LiveDeps): Promise<unknown | null> {
  const now = (deps.now ?? new Date()).getTime();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  try {
    const res = await (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`Athena live travel: ${new URL(url).host} answered ${res.status}`);
      return null;
    }
    const value = (await res.json()) as unknown;
    if (cache.size > 200) cache.clear();
    cache.set(cacheKey, { at: now, value });
    return value;
  } catch (error) {
    console.error(`Athena live travel: ${new URL(url).host} didn't answer`, error instanceof Error ? error.name : "");
    return null;
  }
}

// ---------- National Rail ----------

interface BoardService {
  std?: string;
  etd?: string;
  platform?: string;
  isCancelled?: boolean;
  cancelReason?: string | null;
  delayReason?: string | null;
  destination?: Array<{ locationName?: string; crs?: string }>;
}

const HHMM = /^(\d{2}):(\d{2})$/;
const minutes = (t: string) => {
  const m = HHMM.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The board's answer for one service, as a status. */
export function readService(s: BoardService, ctx: { from: string; to: string | null; destination: string; checkedAt: Date }): TrainStatus | null {
  const scheduled = s.std ?? "";
  const std = minutes(scheduled);
  if (std === null) return null;
  const etd = (s.etd ?? "").trim();
  const base = { from: ctx.from, to: ctx.to, scheduled, platform: s.platform?.trim() || null, destination: ctx.destination, checked_at: ctx.checkedAt.toISOString() };
  if (s.isCancelled || /^cancel/i.test(etd)) return { ...base, expected: null, late: 0, state: "cancelled", platform: null, reason: s.cancelReason ?? null };
  const reason = s.delayReason ?? null;
  const exp = minutes(etd);
  if (exp !== null) {
    // Across midnight: 23:55 expected 00:07 is 12 minutes late; anything "earlier" by hours is the next day's wrap.
    const diff = (exp - std + 1440) % 1440;
    const late = diff > 720 ? 0 : diff;
    return late > 0 ? { ...base, expected: etd, late, state: "late", reason } : { ...base, expected: null, late: 0, state: "on_time", reason: null };
  }
  if (/^on time$/i.test(etd)) return { ...base, expected: null, late: 0, state: "on_time", reason: null };
  if (/^delayed$/i.test(etd)) return { ...base, expected: null, late: 0, state: "delayed", reason };
  // "No report", "Starts here" or nothing: we can't say, so we say nothing.
  return null;
}

/**
 * Live status for a train booking, or null: no key, not a train leaving in
 * the next 3 hours, a station we can't name, the service isn't on the board,
 * or the board didn't answer. Sends the two station codes and a window.
 */
export async function trainStatus(b: BookingLike, deps: LiveDeps = {}): Promise<TrainStatus | null> {
  const now = deps.now ?? new Date();
  if (!liveCandidate(b, now)) return null;
  const apiKey = await key(deps, "national-rail");
  if (!apiKey) return null;
  const { from, to } = bookingStations(b);
  const time = boardTime(b);
  if (!from || !time) return null;

  // The board looks timeOffset minutes ahead for timeWindow minutes (each -120..120). Ten-minute steps keep the cache useful.
  const ahead = (Date.parse(String(b.starts_at)) - now.getTime()) / 60_000;
  const offset = Math.max(-120, Math.min(120, Math.floor((ahead - 20) / 10) * 10));
  const url = new URL(`${(deps.env ?? readEnv)("ATHENA_RDM_URL")?.trim() || RDM_BOARD_URL}/${from}`);
  url.searchParams.set("numRows", "20");
  if (to && to !== from) {
    url.searchParams.set("filterCrs", to);
    url.searchParams.set("filterType", "to");
  }
  url.searchParams.set("timeOffset", String(offset));
  url.searchParams.set("timeWindow", "60");
  const board = (await cachedJson(`rdm:${from}:${to ?? ""}:${offset}`, url.toString(), { headers: { "x-apikey": apiKey, Accept: "application/json" } }, deps)) as {
    trainServices?: BoardService[] | null;
  } | null;
  const services = board?.trainServices;
  if (!Array.isArray(services)) return null;

  // The booked time exactly; else the nearest within 2 minutes (an email that rounded).
  const want = minutes(time)!;
  const near = services
    .map((s) => ({ s, d: Math.abs((minutes(s.std ?? "") ?? -999) - want) }))
    .filter((x) => x.d <= 2)
    .sort((x, y) => x.d - y.d)[0];
  if (!near) return null;
  const boardDestination = near.s.destination?.[0]?.locationName ?? null;
  return readService(near.s, { from, to, destination: destinationName(b, to, boardDestination), checkedAt: now });
}

// ---------- TfL ----------

interface TflLine {
  id?: string;
  name?: string;
  lineStatuses?: Array<{ statusSeverity?: number; statusSeverityDescription?: string; reason?: string }>;
}

/** Good Service, No Issues and Information aren't worth a line. */
const FINE = new Set([10, 18, 19]);

/** Each line in TfL's answer that isn't running normally, worst status first. */
export function readLines(raw: unknown): LineStatus[] {
  if (!Array.isArray(raw)) return [];
  const out: LineStatus[] = [];
  for (const line of raw as TflLine[]) {
    if (!line?.id || !Array.isArray(line.lineStatuses)) continue;
    const bad = line.lineStatuses.filter((s) => typeof s.statusSeverity === "number" && !FINE.has(s.statusSeverity)).sort((a, b) => a.statusSeverity! - b.statusSeverity!);
    if (!bad.length) continue;
    const worst = bad[0];
    out.push({
      id: line.id,
      name: TFL_LINES[line.id] ?? (line.name && !/\bline$|^DLR$/i.test(line.name) ? `${line.name} line` : line.name ?? line.id),
      severity: worst.statusSeverity!,
      description: (worst.statusSeverityDescription ?? "disrupted").toLowerCase(),
      reason: worst.reason?.trim() || null,
    });
  }
  return out;
}

/** Every line that isn't on Good Service right now, or null (no key, or TfL didn't answer). */
export async function lineStatuses(deps: LiveDeps = {}): Promise<LineStatus[] | null> {
  const appKey = await key(deps, "tfl");
  if (!appKey) return null;
  const url = new URL(TFL_STATUS_URL);
  url.searchParams.set("app_key", appKey);
  const raw = await cachedJson("tfl:status", url.toString(), { headers: { Accept: "application/json" } }, deps);
  return raw === null ? null : readLines(raw);
}

/** The owner's lines that aren't on Good Service, in the order given (busiest first). Empty when all's well or we can't tell. */
export async function commuteDisruptions(lineIds: string[], deps: LiveDeps = {}): Promise<LineStatus[]> {
  if (!lineIds.length) return [];
  const all = await lineStatuses(deps);
  if (!all) return [];
  return lineIds.flatMap((id) => all.filter((l) => l.id === id));
}
