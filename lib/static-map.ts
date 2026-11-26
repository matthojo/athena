/**
 * A day's map: where you went, as one still image, drawn by the server from
 * map tiles and cached. docs: security/outside-services has the rules.
 *
 *  - The stops are the day's merged visits (lib/places-visits.ts, the sealed
 *    'day' row), in time order. Repeat visits to one spot are one marker.
 *  - Tiles come from the owner's own MapTiler or Stadia Maps key (Settings →
 *    Maps and artwork), light and dark styles. The provider is only ever sent
 *    tile numbers (zoom, x, y) and the key: never a place's name, id or
 *    coordinates. The route and markers are drawn here, in Athena's colours.
 *  - The route is dotted on purpose: Athena knows the stops, not the path.
 *  - The result is WebP, sealed under the data key in Netlify Blobs (store
 *    "athena-maps"), keyed by a blind index of the stops, provider, style and
 *    size: a day whose places change gets a new map, and the same day is
 *    never drawn twice.
 *  - Without a key the answer is { state: "no_key" }, which the app shows as
 *    "Add a map key in Settings". Nothing is fetched.
 *  - The same drawing and cache make one-pin stills for rich links: a Place's
 *    mini map (its sealed place_geo spot, else its typed address looked up
 *    once) and a map link's still (pinMap).
 */
import { getStore } from "@netlify/blobs";
import sharp from "sharp";
import { assertPublicHost, publicFetch } from "../netlify/lib/connectors/icons";
import { bodyUpTo } from "../netlify/lib/body-limit";
import { blindIndex, dataKeyConfigured, openBytes, openStrict, sealBytes } from "./data-box";
import { isValidDate } from "./dates";
import { q, qRaw } from "./db";
import { geocodeAddress } from "./places-visits";
import { isEncryptedPlaceholder } from "./encrypted";
import { setKeyStatus, tileCredentials, type TileProvider } from "./art-settings";

/** A map tile is at most 1024px square; anything claiming more is refused before decoding. */
const MAX_TILE_PIXELS = 4_000_000;

export type MapTheme = "light" | "dark";
export type MapSize = "card" | "full" | "tall";

/**
 * CSS pixels; images are drawn at twice this. card: on a day. full: the large
 * view on a wide screen. tall: the large view on a phone, about its width, so
 * street names stay readable before you pinch.
 */
export const MAP_SIZES: Record<MapSize, { w: number; h: number }> = { card: { w: 600, h: 320 }, full: { w: 1000, h: 750 }, tall: { w: 420, h: 620 } };
/** Markers a little larger on the card, which a phone shows at about 60%. */
const MARKER_SCALE: Record<MapSize, number> = { card: 1.3, full: 1, tall: 1.1 };
export const MAP_SCALE = 2;
/** Bump when the drawing changes, so cached maps are drawn again. */
export const RENDER_VERSION = 2;
const TILE = 256;
const MAX_ZOOM = 16;
const SINGLE_ZOOM = 15;
const MIN_ZOOM = 2;
const MAX_STOPS = 40;
const TILE_TIMEOUT_MS = 6_000;
const MAX_TILE_BYTES = 1024 * 1024;
const PARALLEL = 6;

export interface Provider {
  label: string;
  host: string;
  styles: Record<MapTheme, string>;
  /** A 512-pixel (@2x) tile on the 256 grid. Only z, x, y and the key go in it. */
  tile: (style: string, z: number, x: number, y: number, key: string) => string;
  attribution: string;
  /** Where the owner gets a free key. */
  keysUrl: string;
}

export const PROVIDERS: Record<TileProvider, Provider> = {
  maptiler: {
    label: "MapTiler",
    host: "api.maptiler.com",
    styles: { light: "dataviz", dark: "dataviz-dark" },
    tile: (style, z, x, y, key) => `https://api.maptiler.com/maps/${style}/256/${z}/${x}/${y}@2x.png?key=${encodeURIComponent(key)}`,
    attribution: "© MapTiler © OpenStreetMap contributors",
    keysUrl: "https://cloud.maptiler.com/account/keys/",
  },
  stadia: {
    label: "Stadia Maps",
    host: "tiles.stadiamaps.com",
    styles: { light: "alidade_smooth", dark: "alidade_smooth_dark" },
    tile: (style, z, x, y, key) => `https://tiles.stadiamaps.com/tiles/${style}/${z}/${x}/${y}@2x.png?api_key=${encodeURIComponent(key)}`,
    attribution: "© Stadia Maps © OpenMapTiles © OpenStreetMap contributors",
    keysUrl: "https://client.stadiamaps.com/dashboard/",
  },
};

/** Athena's colours on the map (tokens.css: --accent, --surface, --sunken). */
export const MAP_COLOURS: Record<MapTheme, { accent: string; halo: string; empty: string; shadow: string }> = {
  light: { accent: "#2c5fdd", halo: "#ffffff", empty: "#eef0f4", shadow: "rgba(21,24,30,0.22)" },
  dark: { accent: "#7d9df4", halo: "#14171d", empty: "#1d2026", shadow: "rgba(0,0,0,0.5)" },
};

export interface Stop {
  lat: number;
  lng: number;
}

// ---------- Geometry (Web Mercator, 256-pixel tiles) ----------

/** World pixels at zoom z. */
export function project(p: Stop, z: number): { x: number; y: number } {
  const lat = Math.max(-85.0511, Math.min(85.0511, p.lat));
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

export interface View {
  z: number;
  /** World pixels (at zoom z) of the image's top-left corner. */
  left: number;
  top: number;
  /** The frame in world pixels at zoom z: the output size times k. */
  w: number;
  h: number;
  /** World pixels per output CSS pixel: 1, or up to about 1.4 when drawn one zoom closer and scaled down. */
  k: number;
  /** The output, in CSS pixels. */
  out: { w: number; h: number };
}

/**
 * The closest view that fits every stop with room around it, centred. Tiles
 * only come in whole zooms, so when the best fit falls well between two, the
 * closer zoom is drawn a little larger and scaled down: the route fills the
 * frame instead of a quarter of it.
 */
export function fitView(stops: Stop[], size: { w: number; h: number }): View {
  const pad = Math.max(36, Math.round(Math.min(size.w, size.h) * 0.12));
  const ps0 = stops.map((s) => project(s, 0));
  const bw = Math.max(...ps0.map((p) => p.x)) - Math.min(...ps0.map((p) => p.x));
  const bh = Math.max(...ps0.map((p) => p.y)) - Math.min(...ps0.map((p) => p.y));
  let z = SINGLE_ZOOM;
  let k = 1;
  if (stops.length > 1 && (bw > 0 || bh > 0)) {
    const zf = Math.min(MAX_ZOOM, Math.log2(Math.min((size.w - 2 * pad) / Math.max(bw, 1e-12), (size.h - 2 * pad) / Math.max(bh, 1e-12))));
    const zi = Math.max(MIN_ZOOM, Math.floor(zf));
    if (zf - zi > 0.5 && zi + 1 <= MAX_ZOOM) {
      z = zi + 1;
      k = 2 ** (z - zf);
    } else z = zi;
  }
  const ps = stops.map((s) => project(s, z));
  const cx = (Math.max(...ps.map((p) => p.x)) + Math.min(...ps.map((p) => p.x))) / 2;
  const cy = (Math.max(...ps.map((p) => p.y)) + Math.min(...ps.map((p) => p.y))) / 2;
  const w = Math.round(size.w * k);
  const h = Math.round(size.h * k);
  return { z, left: Math.round(cx - w / 2), top: Math.round(cy - h / 2), w, h, k, out: { w: size.w, h: size.h } };
}

/** Where a stop lands on the output image, in its pixels. */
function place(s: Stop, view: View): { x: number; y: number } {
  const p = project(s, view.z);
  return { x: ((p.x - view.left) / view.k) * MAP_SCALE, y: ((p.y - view.top) / view.k) * MAP_SCALE };
}

/** The tiles under a view, with where each goes in the tile grid. */
export function tilesFor(view: View): { cols: number; rows: number; x0: number; y0: number; tiles: Array<{ z: number; x: number; y: number; col: number; row: number }> } {
  const n = 2 ** view.z;
  const x0 = Math.floor(view.left / TILE);
  const y0 = Math.floor(view.top / TILE);
  const x1 = Math.floor((view.left + view.w - 1) / TILE);
  const y1 = Math.floor((view.top + view.h - 1) / TILE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (y < 0 || y >= n) continue;
      tiles.push({ z: view.z, x: ((x % n) + n) % n, y, col: x - x0, row: y - y0 });
    }
  }
  return { cols: x1 - x0 + 1, rows: y1 - y0 + 1, x0, y0, tiles };
}

/** Stops in order, with a repeat visit to the same spot (within about 40 m at this zoom) drawn once. */
export function markerPoints(stops: Stop[], view: View): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const s of stops) {
    const q = place(s, view);
    if (!out.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 6 * MAP_SCALE)) out.push(q);
  }
  return out;
}

/** The route (dotted, through the stops in order) and the markers, as SVG over the tiles. */
export function overlaySvg(stops: Stop[], view: View, theme: MapTheme, markerScale = 1): string {
  const c = MAP_COLOURS[theme];
  const S = MAP_SCALE * markerScale;
  const W = view.out.w * MAP_SCALE;
  const H = view.out.h * MAP_SCALE;
  const route = stops.map((s) => {
    const p = place(s, view);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  });
  const pts = markerPoints(stops, view);
  const line =
    route.length > 1
      ? // A light casing lifts the dots off a light map; on a dark map it reads as chain links, so dark has none.
        (theme === "light" ? `<polyline points="${route.join(" ")}" fill="none" stroke="${c.halo}" stroke-opacity="0.9" stroke-width="${5 * S}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 ${7 * S}"/>` : "") +
        `<polyline points="${route.join(" ")}" fill="none" stroke="${c.accent}" stroke-width="${(theme === "dark" ? 3 : 2.6) * S}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 ${7 * S}"/>`
      : "";
  const markers = pts
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${(p.y + 1 * S).toFixed(1)}" r="${8.5 * S}" fill="${c.shadow}" filter="url(#s)"/>` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${7.5 * S}" fill="${c.halo}"/>` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${4.75 * S}" fill="${c.accent}"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${1.6 * S}"/></filter></defs>${line}${markers}</svg>`;
}

// ---------- Tiles ----------

export class TileKeyRejected extends Error {}

/** Replaceable in tests: the network and the DNS check. */
export const mapDeps = {
  fetch: (input: string | URL, init?: RequestInit) => publicFetch(input, init),
  assertPublic: (url: URL) => assertPublicHost(url),
};

async function fetchTile(provider: Provider, url: string): Promise<Buffer | null> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== provider.host) return null;
  await mapDeps.assertPublic(u);
  const res = await mapDeps.fetch(u, { redirect: "error", signal: AbortSignal.timeout(TILE_TIMEOUT_MS), headers: { Accept: "image/png,image/*", "User-Agent": "Athena-personal-notes/1.0" } });
  if (res.status === 401 || res.status === 403) throw new TileKeyRejected();
  if (!res.ok || !res.body) return null;
  // Counted as it arrives: an oversized tile is cut off, not buffered whole.
  const bytes = await bodyUpTo(res, MAX_TILE_BYTES);
  if (!bytes) return null;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return png || jpg || webp ? bytes : null;
}

/** Draw the map: tiles, then the route and markers. Throws TileKeyRejected when the provider refuses the key. */
export async function renderMap(stops: Stop[], opts: { provider: TileProvider; key: string; theme: MapTheme; size: MapSize }): Promise<{ image: Buffer; tiles: number; missing: number }> {
  const provider = PROVIDERS[opts.provider];
  const view = fitView(stops, MAP_SIZES[opts.size]);
  const grid = tilesFor(view);
  const style = provider.styles[opts.theme];
  const T = TILE * MAP_SCALE;
  const got: Array<{ input: Buffer; left: number; top: number }> = [];
  let missing = 0;
  let next = 0;
  let rejected = false;
  const worker = async () => {
    while (next < grid.tiles.length && !rejected) {
      const t = grid.tiles[next++];
      try {
        const bytes = await fetchTile(provider, provider.tile(style, t.z, t.x, t.y, opts.key));
        if (bytes) got.push({ input: await sharp(bytes, { limitInputPixels: MAX_TILE_PIXELS }).resize(T, T).png().toBuffer(), left: t.col * T, top: t.row * T });
        else missing++;
      } catch (error) {
        if (error instanceof TileKeyRejected) rejected = true;
        missing++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, grid.tiles.length) }, worker));
  if (rejected) throw new TileKeyRejected();
  const bg = MAP_COLOURS[opts.theme].empty;
  const mosaic = await sharp({ create: { width: grid.cols * T, height: grid.rows * T, channels: 3, background: bg } })
    .composite(got)
    .png()
    .toBuffer();
  const size = MAP_SIZES[opts.size];
  const cropped = await sharp(mosaic)
    .extract({ left: (view.left - grid.x0 * TILE) * MAP_SCALE, top: (view.top - grid.y0 * TILE) * MAP_SCALE, width: view.w * MAP_SCALE, height: view.h * MAP_SCALE })
    .resize(size.w * MAP_SCALE, size.h * MAP_SCALE, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const image = await sharp(cropped)
    .composite([{ input: Buffer.from(overlaySvg(stops, view, opts.theme, MARKER_SCALE[opts.size])), left: 0, top: 0 }])
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  return { image, tiles: grid.tiles.length, missing };
}

// ---------- The day's stops ----------

/** The day's stops in time order, from the merged places row. Coordinates only. */
export async function dayStops(date: string): Promise<Stop[]> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'location' AND source = 'day' AND day = $1::date`, [date]);
  if (!row) return [];
  let visits: Array<{ start?: string; lat?: number; lng?: number }> = [];
  try {
    visits = (JSON.parse(openStrict(row.ciphertext)) as { visits?: typeof visits }).visits ?? [];
  } catch {
    return [];
  }
  return visits
    .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng) && Math.abs(v.lat!) <= 90 && Math.abs(v.lng!) <= 180)
    .sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")))
    .slice(0, MAX_STOPS)
    .map((v) => ({ lat: v.lat!, lng: v.lng! }));
}

// ---------- The cache and the answer ----------

const STORE = "athena-maps";
let storeFor: () => ReturnType<typeof getStore> = () => getStore({ name: STORE, consistency: "strong" });
/** The map store, for Settings' saved samples (netlify/lib/days-art/routes.ts). */
export const mapStore = () => storeFor();
/** Replace the blob store (tests). */
export function useMapStore(make: () => ReturnType<typeof getStore>): void {
  storeFor = make;
}

/** Same stops, provider, style and size → same map. A blind index, so the key says nothing about where. */
export function mapSignature(stops: Stop[], provider: TileProvider, theme: MapTheme, size: MapSize): string | null {
  const where = stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join(";");
  return blindIndex("other", `map\u0000v${RENDER_VERSION}\u0000${provider}\u0000${PROVIDERS[provider].styles[theme]}\u0000${size}\u0000${where}`);
}

export type DayMap =
  | { state: "ready"; image: Buffer; etag: string; stops: number; attribution: string; provider: TileProvider }
  | { state: "no_key" }
  | { state: "key_rejected"; provider: TileProvider }
  | { state: "no_places" }
  | { state: "unavailable" };

/** The map for a day: from the cache, or drawn now and kept. */
export async function dayMap(date: string, theme: MapTheme, size: MapSize = "card"): Promise<DayMap> {
  if (!isValidDate(date)) return { state: "no_places" };
  return cachedMap(() => dayStops(date), theme, size);
}

/** Draw `stops` (read only once a key is known), or open the kept copy. Shared by day maps and single-pin stills. */
async function cachedMap(readStops: () => Promise<Stop[]>, theme: MapTheme, size: MapSize): Promise<DayMap> {
  if (!dataKeyConfigured()) return { state: "unavailable" };
  const creds = await tileCredentials();
  if (!creds) return { state: "no_key" };
  if (creds.status === "rejected") return { state: "key_rejected", provider: creds.provider };
  const stops = await readStops();
  if (!stops.length) return { state: "no_places" };
  const sig = mapSignature(stops, creds.provider, theme, size);
  if (!sig) return { state: "unavailable" };
  const markers = markerPoints(stops, fitView(stops, MAP_SIZES[size])).length;
  const ready = (image: Buffer): DayMap => ({ state: "ready", image, etag: sig, stops: markers, attribution: PROVIDERS[creds.provider].attribution, provider: creds.provider });
  const store = storeFor();
  const kept = await store.get(sig, { type: "arrayBuffer" });
  if (kept) {
    try {
      return ready(openBytes(new Uint8Array(kept)));
    } catch {
      // sealed under a key we no longer hold: draw it again
    }
  }
  let drawn: Awaited<ReturnType<typeof renderMap>>;
  try {
    drawn = await renderMap(stops, { provider: creds.provider, key: creds.key, theme, size });
  } catch (error) {
    if (error instanceof TileKeyRejected) {
      await setKeyStatus("tiles", "rejected");
      return { state: "key_rejected", provider: creds.provider };
    }
    console.error("Athena map: drawing failed", (error as Error)?.message);
    return { state: "unavailable" };
  }
  // Every tile failed: say so, and don't keep a blank map.
  if (drawn.missing === drawn.tiles) return { state: "unavailable" };
  // Some tiles failed: show it, but draw it again next time.
  if (!drawn.missing) await store.set(sig, new Uint8Array(sealBytes(drawn.image).sealed).buffer as ArrayBuffer);
  return ready(drawn.image);
}

// ---------- Single-pin stills (rich links: a Place's card, a map embed's still) ----------

/** A valid spot, rounded to about a metre (so the cache key doesn't change with noise), or null. */
export function cleanStop(lat: unknown, lng: unknown): Stop | null {
  const a = Number(lat);
  const b = Number(lng);
  if (lat === null || lng === null || lat === "" || lng === "" || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: Math.round(a * 1e5) / 1e5, lng: Math.round(b * 1e5) / 1e5 };
}

/** Replaceable in tests: where a typed address is (lib/places-visits.ts, Nominatim, cached). */
export const placeDeps = { geocode: (address: string) => geocodeAddress(address) };

/**
 * A Place's spot: its sealed coordinates from visits (place_geo) first, else
 * where its typed address is (looked up once and cached, so every place with
 * an address gets a map). Null when there's neither. The
 * looked-up spot isn't written to place_geo, so it never changes which visits
 * match the place.
 */
export async function placeStop(placeId: string): Promise<Stop | null> {
  const [row] = await q<{ sealed: string | null; address: string }>(`SELECT g.sealed, p.address FROM places p LEFT JOIN place_geo g ON g.place_id = p.id WHERE p.id = $1::uuid`, [placeId]);
  if (!row) return null;
  // q() has opened both columns already (or left a placeholder where it couldn't).
  if (row.sealed) {
    try {
      const geo = JSON.parse(row.sealed) as { lat?: number; lng?: number };
      const stop = cleanStop(geo.lat, geo.lng);
      if (stop) return stop;
    } catch {
      // can't open it here: fall back to the address
    }
  }
  const address = (row.address ?? "").trim();
  if (!address || isEncryptedPlaceholder(address)) return null;
  const at = await placeDeps.geocode(address);
  return at ? cleanStop(at.lat, at.lng) : null;
}

/** One pin on a map, drawn and cached exactly like a day's map. "no_places" when there's no spot. */
export async function pinMap(stop: Stop | null, theme: MapTheme, size: MapSize = "card"): Promise<DayMap> {
  const clean = stop ? cleanStop(stop.lat, stop.lng) : null;
  if (!clean) return { state: "no_places" };
  return cachedMap(async () => [clean], theme, size);
}

/** A Place's mini map: its pin, or "no_places" when Athena doesn't know where it is. */
export async function placeMap(placeId: string, theme: MapTheme, size: MapSize = "card"): Promise<DayMap> {
  if (!dataKeyConfigured()) return { state: "unavailable" };
  return pinMap(await placeStop(placeId), theme, size);
}

/** A fixed, neutral spot for Settings' test: central London's parks. Nothing about the owner. */
export const TEST_STOPS: Stop[] = [
  { lat: 51.5073, lng: -0.1657 },
  { lat: 51.5033, lng: -0.1195 },
  { lat: 51.5138, lng: -0.0984 },
];

/** For Settings' test: draw the sample in both themes. */
export async function testTiles(provider: TileProvider, key: string): Promise<{ ok: true; light: Buffer; dark: Buffer } | { ok: false; reason: "rejected" | "unreachable" }> {
  try {
    const [light, dark] = await Promise.all(
      (["light", "dark"] as const).map((theme) => renderMap(TEST_STOPS, { provider, key, theme, size: "card" })),
    );
    if (light.missing === light.tiles || dark.missing === dark.tiles) return { ok: false, reason: "unreachable" };
    return { ok: true, light: light.image, dark: dark.image };
  } catch (error) {
    return { ok: false, reason: error instanceof TileKeyRejected ? "rejected" : "unreachable" };
  }
}
