/**
 * TripIt without MCP: a narrow, read-only adapter over TripIt's API v1
 * (api.tripit.com), registered in direct.ts.
 *
 * Why not MCP: TripIt runs no MCP server. Sign-in is OAuth 1.0 (HMAC-SHA1),
 * the only kind TripIt offers (its v1 docs, checked 7 Nov 2026: no OAuth 2),
 * with the owner's own TripIt app: a request token (POST), TripIt's consent
 * page, then an access token (POST) for that request token. The callback
 * carries only oauth_token, so Athena's `state` rides on the callback address.
 * After that, GETs only: /get/profile proves the sign-in, /list/trip reads
 * trips with their flights, stays, trains and car hire.
 *
 * Nothing is ever written to TripIt. tripit-trips.ts copies what's read
 * into Athena's Trips (lib/trips.ts saveBooking) at the start of a run.
 * Tokens, signatures and response bodies are never logged.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { isValidTimeZone } from "../../../lib/dates";
import { TRIPIT_API_URL } from "../../../lib/presets/media-travel";
import { arg, clean, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { LifeApiError, account, getJson, lifeAccountProblem, lifeFailure, ownerZone, readOnly, type LifeTool } from "./lifelog-b-http";

export const TRIPIT_OAUTH_URL = "https://api.tripit.com/oauth";
export const TRIPIT_AUTHORIZE_URL = "https://www.tripit.com/oauth/authorize";
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- OAuth 1.0 ----------

/** RFC 3986 percent-encoding, as OAuth 1.0 signs it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface OAuth1Keys {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/** The Authorization header for one request (RFC 5849 §3.4.1, HMAC-SHA1). `now` and `nonce` are fixed only by tests. */
export function oauth1Header(method: string, url: string, keys: OAuth1Keys, extra: Record<string, string> = {}, fixed: { now?: number; nonce?: string } = {}): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: fixed.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor((fixed.now ?? Date.now()) / 1000)),
    oauth_version: "1.0",
    ...(keys.token ? { oauth_token: keys.token } : {}),
    ...extra,
  };
  const params: Array<[string, string]> = [...Object.entries(oauth), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]);
  params.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const signature = createHmac("sha1", `${enc(keys.consumerSecret)}&${enc(keys.tokenSecret ?? "")}`).update(base).digest("base64");
  const fields = { ...oauth, oauth_signature: signature };
  return `OAuth realm="https://api.tripit.com/", ${Object.entries(fields)
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
}

/** POST to TripIt's request_token or access_token: a form-encoded token pair back. */
async function tokenPost(path: "request_token" | "access_token", keys: OAuth1Keys): Promise<{ token: string; secret: string }> {
  const url = `${TRIPIT_OAUTH_URL}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { Authorization: oauth1Header("POST", url, keys), "Content-Type": "application/x-www-form-urlencoded" }, body: "", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new LifeApiError("tripit", 503, "Couldn't reach TripIt to sign in. Try again in a few minutes.");
  }
  const body = new URLSearchParams(await res.text().catch(() => ""));
  const token = body.get("oauth_token");
  const secret = body.get("oauth_token_secret");
  if (res.ok && token && secret) return { token, secret };
  if (res.status >= 500) throw new LifeApiError("tripit", res.status, "TripIt is having trouble right now. Try again in a few minutes.");
  if (path === "request_token") throw new LifeApiError("tripit", 401, "TripIt refused Athena's app. Check the API key and secret under Edit, then sign in again.", true);
  throw new LifeApiError("tripit", 401, "TripIt didn't finish the sign-in. Sign in again and choose Allow.", true);
}

/** The request token, kept in the account's sealed `codeVerifier` until the callback. */
interface Pending {
  t: string;
  s: string;
}

/** Start signing in: a request token, then TripIt's consent page, which sends the browser back to `redirectUri` with `state`. */
export async function beginTripItSignIn(input: { client: { client_id: string; client_secret?: string }; redirectUri: string; state: string }): Promise<{ url: string; verifier: string }> {
  const req = await tokenPost("request_token", { consumerKey: input.client.client_id, consumerSecret: input.client.client_secret ?? "" });
  const callback = new URL(input.redirectUri);
  callback.searchParams.set("state", input.state);
  const url = new URL(TRIPIT_AUTHORIZE_URL);
  url.searchParams.set("oauth_token", req.token);
  url.searchParams.set("oauth_callback", callback.toString());
  return { url: url.toString(), verifier: JSON.stringify({ t: req.token, s: req.secret } satisfies Pending) };
}

/** The callback's oauth_token (passed as `code`), swapped for an access token. TripIt's don't expire. */
export async function exchangeTripItToken(input: { code: string; verifier: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  let pending: Pending;
  try {
    pending = JSON.parse(input.verifier) as Pending;
  } catch {
    throw new LifeApiError("tripit", 400, "This TripIt sign-in has expired. Start again from Athena.", true);
  }
  if (!pending.t || pending.t !== input.code) throw new LifeApiError("tripit", 400, "That TripIt sign-in doesn't match the one Athena started. Start again from Athena.", true);
  const access = await tokenPost("access_token", { consumerKey: input.client.client_id, consumerSecret: input.client.client_secret ?? "", token: pending.t, tokenSecret: pending.s });
  // OAuth 1.0 has no refresh token: the token secret is kept beside the token, sealed with it.
  return { access_token: access.token, token_type: "oauth1", token_secret: access.secret } as StoredTokens;
}

// ---------- reading ----------

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("tripit", 401, "TripIt signed Athena out. Sign in again.", true);
  if (status === 403) return new LifeApiError("tripit", 403, "TripIt says your account isn't confirmed yet. Confirm your email with TripIt, then sign in again.", true);
  if (status === 429) return new LifeApiError("tripit", 429, "TripIt is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("tripit", status, "TripIt is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("tripit", status, `TripIt refused that (${status})`);
}

/** TripIt sends one item as an object and several as an array. */
export const many = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

interface TDateTime {
  date?: string;
  time?: string;
  timezone?: string;
  utc_offset?: string;
}
interface TAddress {
  address?: string;
  city?: string;
  state?: string;
  country?: string;
}
interface TTrip {
  id?: string;
  display_name?: string;
  start_date?: string;
  end_date?: string;
  primary_location?: string;
  PrimaryLocationAddress?: TAddress;
  relative_url?: string;
}
interface TObject {
  id?: string;
  trip_id?: string;
  display_name?: string;
  supplier_name?: string;
  supplier_conf_num?: string;
  booking_site_name?: string;
  booking_site_conf_num?: string;
  is_purchased?: string;
}
interface TAir extends TObject {
  Segment?: TAirSegment | TAirSegment[];
}
interface TAirSegment {
  id?: string;
  StartDateTime?: TDateTime;
  EndDateTime?: TDateTime;
  start_airport_code?: string;
  start_city_name?: string;
  start_terminal?: string;
  end_airport_code?: string;
  end_city_name?: string;
  end_terminal?: string;
  marketing_airline?: string;
  marketing_airline_code?: string;
  marketing_flight_number?: string;
  seats?: string;
}
interface TLodging extends TObject {
  StartDateTime?: TDateTime;
  EndDateTime?: TDateTime;
  Address?: TAddress;
  room_type?: string;
}
interface TRail extends TObject {
  Segment?: TRailSegment | TRailSegment[];
}
interface TRailSegment {
  id?: string;
  StartDateTime?: TDateTime;
  EndDateTime?: TDateTime;
  start_station_name?: string;
  StartStationAddress?: TAddress;
  end_station_name?: string;
  EndStationAddress?: TAddress;
  carrier_name?: string;
  train_number?: string;
  coach_number?: string;
  seats?: string;
}
interface TCar extends TObject {
  StartDateTime?: TDateTime;
  EndDateTime?: TDateTime;
  start_location_name?: string;
  StartLocationAddress?: TAddress;
  end_location_name?: string;
  EndLocationAddress?: TAddress;
  car_type?: string;
}
export interface TripListResponse {
  Trip?: TTrip | TTrip[];
  AirObject?: TAir | TAir[];
  LodgingObject?: TLodging | TLodging[];
  RailObject?: TRail | TRail[];
  CarObject?: TCar | TCar[];
  page_num?: string;
  page_size?: string;
  max_page?: string;
}

/** A booking as athena_trip_booking takes it (lib/trips.ts BookingInput), plus TripIt's id for it. */
export interface TripItBooking {
  id: string;
  kind: "flight" | "hotel" | "train" | "car";
  title: string;
  provider?: string;
  reference?: string;
  segment?: string;
  start_local: string;
  start_tz: string;
  start_place?: string;
  start_city?: string;
  end_local?: string;
  end_tz?: string;
  end_place?: string;
  end_city?: string;
  seat?: string;
  trip_destination?: string;
}

/** "+01:00" as an IANA zone (Etc/GMT-1: the sign is inverted), when it's whole hours. */
function zoneFromOffset(offset: string | undefined): string | undefined {
  const m = /^([+-])(\d{2}):00$/.exec(offset ?? "");
  if (!m) return undefined;
  const h = Number(m[2]);
  return h === 0 ? "UTC" : `Etc/GMT${m[1] === "+" ? "-" : "+"}${h}`;
}

/** A TripIt date and time as local "YYYY-MM-DDTHH:MM" (or the day only) and its zone. */
export function localOf(dt: TDateTime | undefined, fallbackTz: string): { local: string; tz: string } | null {
  if (!dt?.date || !/^\d{4}-\d{2}-\d{2}$/.test(dt.date)) return null;
  const time = /^(\d{2}:\d{2})/.exec(dt.time ?? "")?.[1];
  const tz = dt.timezone && isValidTimeZone(dt.timezone) ? dt.timezone : zoneFromOffset(dt.utc_offset) ?? fallbackTz;
  return { local: time ? `${dt.date}T${time}` : dt.date, tz };
}

const join = (...parts: Array<string | undefined>) => parts.map((p) => p?.trim()).filter(Boolean).join(" ") || undefined;
const ref = (o: TObject) => o.supplier_conf_num?.trim() || o.booking_site_conf_num?.trim() || undefined;

/** Every booking in a list/trip reply, grouped by TripIt trip id. Objects without a start date are left out. */
export function tripItBookings(r: TripListResponse, tz: string): Map<string, TripItBooking[]> {
  const out = new Map<string, TripItBooking[]>();
  const trips = new Map(many(r.Trip).map((t) => [t.id ?? "", t]));
  const put = (o: TObject, b: Omit<TripItBooking, "trip_destination"> | null) => {
    if (!b) return;
    const trip = trips.get(o.trip_id ?? "");
    const dest = trip?.PrimaryLocationAddress?.city || trip?.primary_location?.split(",")[0]?.trim();
    const list = out.get(o.trip_id ?? "") ?? [];
    list.push(clean({ ...b, trip_destination: dest }) as unknown as TripItBooking);
    out.set(o.trip_id ?? "", list);
  };
  for (const a of many(r.AirObject)) {
    const segs = many(a.Segment);
    for (const s of segs) {
      const start = localOf(s.StartDateTime, tz);
      const end = localOf(s.EndDateTime, start?.tz ?? tz);
      const flight = join(s.marketing_airline_code, s.marketing_flight_number) ?? "Flight";
      put(a, start && {
        id: `tripit:air:${a.id}:${s.id ?? flight}`,
        kind: "flight",
        title: flight,
        provider: s.marketing_airline || a.supplier_name,
        reference: ref(a),
        segment: segs.length > 1 ? flight : undefined,
        start_local: start.local,
        start_tz: start.tz,
        start_place: join(s.start_airport_code, s.start_terminal ? `T${s.start_terminal.replace(/^T(erminal)?\s*/i, "")}` : undefined),
        start_city: s.start_city_name,
        end_local: end?.local,
        end_tz: end?.tz,
        end_place: join(s.end_airport_code, s.end_terminal ? `T${s.end_terminal.replace(/^T(erminal)?\s*/i, "")}` : undefined),
        end_city: s.end_city_name,
        seat: s.seats,
      });
    }
  }
  for (const l of many(r.LodgingObject)) {
    const start = localOf(l.StartDateTime, tz);
    const end = localOf(l.EndDateTime, start?.tz ?? tz);
    put(l, start && {
      id: `tripit:lodging:${l.id}`,
      kind: "hotel",
      title: l.supplier_name || l.display_name || "Stay",
      provider: l.booking_site_name,
      reference: ref(l),
      start_local: start.local,
      start_tz: start.tz,
      start_place: l.Address?.address,
      start_city: l.Address?.city,
      end_local: end?.local,
      end_tz: end?.tz,
      end_city: l.Address?.city,
    });
  }
  for (const rail of many(r.RailObject)) {
    const segs = many(rail.Segment);
    for (const s of segs) {
      const start = localOf(s.StartDateTime, tz);
      const end = localOf(s.EndDateTime, start?.tz ?? tz);
      const train = join(s.carrier_name, s.train_number) ?? rail.supplier_name ?? "Train";
      put(rail, start && {
        id: `tripit:rail:${rail.id}:${s.id ?? train}`,
        kind: "train",
        title: train,
        provider: s.carrier_name || rail.supplier_name,
        reference: ref(rail),
        segment: segs.length > 1 ? train : undefined,
        start_local: start.local,
        start_tz: start.tz,
        start_place: s.start_station_name,
        start_city: s.StartStationAddress?.city,
        end_local: end?.local,
        end_tz: end?.tz,
        end_place: s.end_station_name,
        end_city: s.EndStationAddress?.city,
        seat: join(s.coach_number ? `Coach ${s.coach_number}` : undefined, s.seats ? `seat ${s.seats}` : undefined),
      });
    }
  }
  for (const c of many(r.CarObject)) {
    const start = localOf(c.StartDateTime, tz);
    const end = localOf(c.EndDateTime, start?.tz ?? tz);
    put(c, start && {
      id: `tripit:car:${c.id}`,
      kind: "car",
      title: c.supplier_name || c.display_name || "Car hire",
      provider: c.booking_site_name,
      reference: ref(c),
      start_local: start.local,
      start_tz: start.tz,
      start_place: c.start_location_name,
      start_city: c.StartLocationAddress?.city,
      end_local: end?.local,
      end_tz: end?.tz,
      end_place: c.end_location_name,
      end_city: c.EndLocationAddress?.city ?? c.StartLocationAddress?.city,
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.start_local.localeCompare(b.start_local));
  return out;
}

export interface TripItContext {
  get<T>(path: string): Promise<T>;
  tz: string;
}

const MAX_PAGES = 10;

/** Trips, upcoming or past, with their bookings: one page of TripIt's, or every page for upcoming. */
export async function listTrips(ctx: TripItContext, args: Record<string, unknown>) {
  const which = arg.oneOf(args, "when", ["upcoming", "past"] as const) ?? "upcoming";
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 25 });
  const startPage = Number(arg.str(args, "cursor", { max: 4 }) ?? 1);
  if (!Number.isInteger(startPage) || startPage < 1) throw new LifeApiError("tripit", 400, "cursor isn't one Athena gave");
  const trips: Array<Record<string, unknown>> = [];
  let page = startPage;
  let maxPage = page;
  do {
    const r = await ctx.get<TripListResponse>(`/list/trip/past/${which === "past"}/include_objects/true/page_num/${page}/page_size/${limit}/format/json`);
    maxPage = Number(r.max_page ?? page) || page;
    const bookings = tripItBookings(r, ctx.tz);
    for (const t of many(r.Trip))
      trips.push(
        clean({
          name: t.display_name,
          destination: t.PrimaryLocationAddress?.city || t.primary_location,
          start_date: t.start_date,
          end_date: t.end_date,
          link: t.id ? `https://www.tripit.com/app/trips/${t.id}` : undefined,
          bookings: bookings.get(t.id ?? "") ?? [],
        }),
      );
    page++;
    // Past trips are paged by the caller; upcoming are few, so read them all.
  } while (which === "upcoming" && page <= maxPage && page < startPage + MAX_PAGES);
  return { trips, count: trips.length, total_pages: maxPage, ...(page <= maxPage ? { next_cursor: String(page) } : {}) };
}

export const TRIPIT_TOOLS: LifeTool<TripItContext>[] = [
  {
    name: "list_trips",
    summary: "See your trips",
    description:
      "The owner's TripIt trips, upcoming (default) or past (newest first, paged with next_cursor): each trip's name, destination, dates and link, and its bookings (flights by leg, hotel stays, trains, car hire) with times local to where they happen and their IANA zone, places, cities, booking reference and seat. Athena already copies these into Trips at the start of every run, so don't save them again with athena_trip_booking.",
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["upcoming", "past"], description: "upcoming (default) or past." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Trips per page (default 25)." },
        cursor: { type: "string", description: "next_cursor from the previous call." },
      },
    },
    annotations: readOnly,
    run: listTrips,
  },
];

/** Open the account: the profile proves the sign-in. */
export async function openTripIt(connector: Pick<Connector, "id">, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const tokens = secrets.tokens as (StoredTokens & { token_secret?: string }) | undefined;
  const client = secrets.ownClient;
  if (!tokens?.access_token || !tokens.token_secret) throw new LifeApiError("tripit", 401, "Not signed in yet", true);
  if (!client?.client_id || !client.client_secret) throw new LifeApiError("tripit", 401, "No TripIt app is saved for this account. Add its API key and secret under Edit.", true);
  const keys: OAuth1Keys = { consumerKey: client.client_id, consumerSecret: client.client_secret, token: tokens.access_token, tokenSecret: tokens.token_secret };
  const get = <T>(path: string): Promise<T> => {
    const url = `${TRIPIT_API_URL}${path}`;
    return getJson<T>(url, { service: "tripit", hosts: ["api.tripit.com"], headers: { Authorization: oauth1Header("GET", url, keys) }, refused, unreachable: "Couldn't reach TripIt" });
  };
  const [, zone] = await Promise.all([get<{ Profile?: unknown }>("/get/profile/format/json"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("tripit", TRIPIT_TOOLS, { get, tz: zone });
}

export const tripitAdapter: DirectAdapter = {
  id: "tripit",
  handles: (c) => c.provider === "tripit" && c.auth_type === "oauth",
  tools: () => TRIPIT_TOOLS,
  serverInfo: () => ({ website_url: "https://www.tripit.com/" }),
  open: (connector, secrets) => openTripIt(connector, secrets),
  beginSignIn: beginTripItSignIn,
  exchangeCode: ({ code, verifier, client }) => exchangeTripItToken({ code, verifier, client }),
  accountProblem: (e) => lifeAccountProblem("tripit", e),
  failure: (e) => lifeFailure("tripit", e),
};
