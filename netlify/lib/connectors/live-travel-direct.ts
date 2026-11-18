/**
 * Google Maps routes, TfL and National Rail accounts (lib/presets/live-travel.ts),
 * registered in direct.ts. No tools: no collection or Claude reads them.
 * Athena calls them itself (netlify/lib/live-travel.ts,
 * netlify/lib/proactive/directions.ts), with the key from travel-key.ts.
 *
 * Opening an account ("Check connection", and when it's added) makes one small
 * read-only call with the key:
 *  - Google: one walking route between two fixed points beside Trafalgar
 *    Square, asking only for its duration.
 *  - TfL: one line's status (the Victoria line).
 *  - National Rail: one row of King's Cross's departure board.
 * Nothing about the owner is sent. The key is never logged or put in a message.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { isTravelKeyProvider, type TravelKeyKind } from "../../../lib/presets/live-travel";
import type { DirectAdapter } from "./direct";
import { RDM_BOARD_URL } from "../live-travel";
import { GOOGLE_ROUTES_URL } from "../proactive/directions";
import { clearTravelKeys } from "../travel-key";

const TIMEOUT_MS = 8_000;
export const TFL_CHECK_URL = "https://api.tfl.gov.uk/Line/victoria/Status";
/** Two points beside Trafalgar Square: a check, not anyone's journey. */
export const CHECK_FROM = { latitude: 51.508, longitude: -0.128 };
export const CHECK_TO = { latitude: 51.5074, longitude: -0.127 };

const NAME: Record<TravelKeyKind, string> = { "google-routes": "Google", tfl: "TfL", "national-rail": "National Rail" };
const BAD_KEY: Record<TravelKeyKind, string> = {
  "google-routes": "Google didn't accept that key. Check the Routes API is turned on in the key's project and the key is allowed to use it, then paste it again under Edit.",
  tfl: "TfL didn't accept that key. Copy the primary key from your profile at api-portal.tfl.gov.uk and paste it again under Edit.",
  "national-rail": "National Rail didn't accept that key. Copy the consumer key from the Live Departure Board product's Specification tab and paste it again under Edit.",
};

/** A key that didn't work. `owner`: the owner has to fix it (the account shows needs_auth). */
export class TravelKeyError extends Error {
  constructor(
    readonly kind: TravelKeyKind,
    readonly status: number,
    message: string,
    readonly owner = false,
  ) {
    super(message);
    this.name = "TravelKeyError";
  }
}

/** The one request a check makes. Exported for tests. */
export function checkRequest(kind: TravelKeyKind, key: string): { url: string; init: RequestInit } {
  if (kind === "google-routes") {
    return {
      url: GOOGLE_ROUTES_URL,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration" },
        body: JSON.stringify({ origin: { location: { latLng: CHECK_FROM } }, destination: { location: { latLng: CHECK_TO } }, travelMode: "WALK" }),
      },
    };
  }
  if (kind === "tfl") {
    const url = new URL(TFL_CHECK_URL);
    url.searchParams.set("app_key", key);
    return { url: url.toString(), init: { headers: { Accept: "application/json" } } };
  }
  const url = new URL(`${RDM_BOARD_URL}/KGX`);
  url.searchParams.set("numRows", "1");
  return { url: url.toString(), init: { headers: { "x-apikey": key, Accept: "application/json" } } };
}

/** Check a key with one small read. Resolves when it works; throws a TravelKeyError when it doesn't. */
export async function checkTravelKey(kind: TravelKeyKind, key: string, f: typeof fetch = fetch): Promise<void> {
  const name = NAME[kind];
  if (!key.trim()) throw new TravelKeyError(kind, 401, `Paste your ${name} key.`, true);
  const { url, init } = checkRequest(kind, key.trim());
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new TravelKeyError(kind, 0, `Couldn't reach ${name}. Try again in a minute.`);
  }
  if (res.ok) return;
  // Google says a bad key with 400 (API_KEY_INVALID) and a key not allowed the Routes API with 403.
  if (res.status === 401 || res.status === 403 || (kind === "google-routes" && res.status === 400)) throw new TravelKeyError(kind, res.status, BAD_KEY[kind], true);
  if (res.status === 429) throw new TravelKeyError(kind, 429, `${name} is limiting how often Athena can ask right now. Try again in a few minutes.`);
  if (res.status >= 500) throw new TravelKeyError(kind, res.status, `${name} is having trouble right now. Try again in a few minutes.`);
  throw new TravelKeyError(kind, res.status, `${name} refused that (${res.status}).`);
}

const NOTHING = { text: "This account has nothing to read: Athena asks it itself for live travel.", isError: true };

export const liveTravelAdapter: DirectAdapter = {
  id: "live-travel",
  handles: (c) => isTravelKeyProvider(c.provider) && c.auth_type === "token",
  tools: () => [],
  serverInfo: (c) => ({
    website_url: c.provider === "google-routes" ? "https://developers.google.com/maps/documentation/routes" : c.provider === "tfl" ? "https://api-portal.tfl.gov.uk" : "https://raildata.org.uk",
  }),
  async open(connector: Connector, secrets: ConnectorSecrets) {
    await checkTravelKey(connector.provider as TravelKeyKind, secrets.token ?? "");
    // A new or changed key applies at once in this instance.
    clearTravelKeys();
    return { tools: [], call: async () => NOTHING };
  },
  accountProblem: (error) => error instanceof TravelKeyError && error.owner,
  failure: (error) => (error instanceof TravelKeyError ? { status: error.owner ? "needs_auth" : "error", detail: error.message } : null),
};
