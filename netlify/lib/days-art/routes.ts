/**
 * Artwork, day maps and their keys over REST. Every route needs full access
 * (the app's token or a full key). docs: security/outside-services.
 *
 *  - GET    /api/art/:id?size=sm|lg       a kept image (WebP). The bytes for an id never
 *                                         change, so it's cached for a year.
 *  - GET    /api/days/:date/map?theme=light|dark&size=card|full|tall
 *                                         the day's map (WebP, revalidated by ETag), or
 *                                         JSON { state } when there isn't one: no_key,
 *                                         key_rejected, no_places, unavailable.
 *  - GET    /api/maps-art                 which keys are kept (never a key) and how much art.
 *  - POST   /api/maps-art/tiles           { provider, key }: try it, keep it if it works,
 *                                         and send back a sample map in both themes.
 *  - POST   /api/maps-art/tiles/test      try the kept key again.
 *  - DELETE /api/maps-art/tiles
 *  - POST   /api/maps-art/tmdb            { key }, the same for TMDB, with a sample poster.
 *  - POST   /api/maps-art/tmdb/test, DELETE /api/maps-art/tmdb
 *  - GET    /api/maps-art/preview/light|dark|poster
 *                                         the sample from the last good test, so Settings
 *                                         shows what your maps and posters look like.
 *
 * Nothing here logs a key, a place, a title or an image address.
 */
import { artCount, isArtId, readArt, testTmdbKey, type ArtSize } from "../../../lib/art";
import { mapsArtStatus, removeKey, saveTileKey, saveTmdbKey, setKeyStatus, tileCredentials, tmdbKeyForTest, TILE_PROVIDERS, type TileProvider } from "../../../lib/art-settings";
import { isValidDate } from "../../../lib/dates";
import { secretBoxConfigured } from "../../../lib/secret-box";
import { openBytes, sealBytes } from "../../../lib/data-box";
import { dayMap, mapStore, PROVIDERS, testTiles, type MapSize, type MapTheme } from "../../../lib/static-map";

type Json = (data: unknown, status?: number) => Response;

export const ART_CACHE = "private, max-age=31536000, immutable";
export const MAP_CACHE = "private, no-cache";

const dataUri = (b: Buffer) => `data:image/webp;base64,${b.toString("base64")}`;

/** Words for the app. */
export const MAPS_ART_COPY = {
  noEncryption: "Athena can't keep keys here yet: its encryption key for sign-ins isn't set.",
  tileRejected: (p: TileProvider) => `${PROVIDERS[p].label} didn't accept that key. Copy it again from your ${PROVIDERS[p].label} account.`,
  tileUnreachable: (p: TileProvider) => `Couldn't reach ${PROVIDERS[p].label}. Try again in a minute.`,
  tmdbRejected: "TMDB didn't accept that key. Copy the API key (or the read access token) again from TMDB.",
  tmdbUnreachable: "Couldn't reach TMDB. Try again in a minute.",
  pasteKey: "Paste the key first.",
  noKept: "There's no key to test. Add one first.",
};

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Sample = "light" | "dark" | "poster";
const SAMPLES: readonly Sample[] = ["light", "dark", "poster"];
const sampleKey = (s: Sample) => `settings-sample/${s}`;

/** Keep the test's samples (sealed, like the maps). Without the data key there's nowhere to keep them: skip. */
async function keepSamples(samples: Partial<Record<Sample, Buffer>>): Promise<void> {
  try {
    for (const [k, v] of Object.entries(samples)) await mapStore().set(sampleKey(k as Sample), new Uint8Array(sealBytes(v).sealed).buffer as ArrayBuffer);
  } catch {
    // no data key here
  }
}

async function dropSamples(which: Sample[]): Promise<void> {
  for (const k of which) await mapStore().delete(sampleKey(k)).catch(() => undefined);
}

const cleanKey = (raw: unknown) => (typeof raw === "string" ? raw.trim().replace(/\s+/g, "") : "");

/** Handles /api/art/*, /api/days/:date/map and /api/maps-art/*; null for anything else. */
export async function handleArtRoutes(req: Request, url: URL, segments: string[], json: Json, cors: Record<string, string>): Promise<Response | null> {
  const [, first, second, third] = segments;

  if (first === "art" && segments.length === 3) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const size: ArtSize = url.searchParams.get("size") === "sm" ? "sm" : "lg";
    if (!isArtId(second)) return json({ error: "Not found" }, 404);
    const etag = `"${second}-${size}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": ART_CACHE, ...cors } });
    const bytes = await readArt(second, size);
    if (!bytes) return json({ error: "Not found" }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/webp", "Content-Length": String(bytes.length), "Cache-Control": ART_CACHE, ETag: etag, "X-Content-Type-Options": "nosniff", ...cors },
    });
  }

  if (first === "days" && segments.length === 4 && third === "map") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!isValidDate(second)) return json({ error: "Not found" }, 404);
    const theme: MapTheme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const asked = url.searchParams.get("size");
    const size: MapSize = asked === "full" || asked === "tall" ? asked : "card";
    const map = await dayMap(second, theme, size);
    if (map.state !== "ready") {
      return new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Map-State": map.state, ...cors } });
    }
    const etag = `"${map.etag}"`;
    const headers = {
      "Cache-Control": MAP_CACHE,
      ETag: etag,
      "X-Map-State": "ready",
      "X-Map-Stops": String(map.stops),
      // Headers are Latin-1: the © travels percent-encoded.
      "X-Map-Attribution": encodeURIComponent(map.attribution),
      "Access-Control-Expose-Headers": "X-Map-State, X-Map-Stops, X-Map-Attribution, ETag",
      ...cors,
    };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(map.image), { headers: { ...headers, "Content-Type": "image/webp", "Content-Length": String(map.image.length), "X-Content-Type-Options": "nosniff" } });
  }

  if (first === "maps-art") {
    if (second === "preview" && segments.length === 4) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      if (!SAMPLES.includes(third as Sample)) return json({ error: "Not found" }, 404);
      const sealed = await mapStore().get(sampleKey(third as Sample), { type: "arrayBuffer" });
      let bytes: Buffer | null = null;
      try {
        bytes = sealed ? openBytes(new Uint8Array(sealed)) : null;
      } catch {
        bytes = null;
      }
      if (!bytes) return json({ error: "Not found" }, 404);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff", ...cors } });
    }
    if (segments.length === 2) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json({ ...(await mapsArtStatus()), art_count: await artCount() });
    }
    const which = second === "tiles" || second === "tmdb" ? second : null;
    if (!which || segments.length > 4 || (third && third !== "test")) return json({ error: "Not found" }, 404);

    if (req.method === "DELETE" && !third) {
      await removeKey(which);
      await dropSamples(which === "tiles" ? ["light", "dark"] : ["poster"]);
      return json({ ...(await mapsArtStatus()), art_count: await artCount() });
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!secretBoxConfigured()) return json({ error: MAPS_ART_COPY.noEncryption }, 503);
    const testing = third === "test";

    if (which === "tiles") {
      let provider: TileProvider;
      let key: string;
      if (testing) {
        const kept = await tileCredentials();
        if (!kept) return json({ error: MAPS_ART_COPY.noKept }, 404);
        ({ provider, key } = kept);
      } else {
        const body = await readBody(req);
        provider = TILE_PROVIDERS.includes(body.provider as TileProvider) ? (body.provider as TileProvider) : "maptiler";
        key = cleanKey(body.key);
        if (!key || key.length > 400) return json({ error: MAPS_ART_COPY.pasteKey }, 400);
      }
      const tried = await testTiles(provider, key);
      if (!tried.ok) {
        if (testing && tried.reason === "rejected") await setKeyStatus("tiles", "rejected");
        return json({ error: tried.reason === "rejected" ? MAPS_ART_COPY.tileRejected(provider) : MAPS_ART_COPY.tileUnreachable(provider), reason: tried.reason }, tried.reason === "rejected" ? 400 : 502);
      }
      if (testing) await setKeyStatus("tiles", "working");
      else await saveTileKey(provider, key);
      await keepSamples({ light: tried.light, dark: tried.dark });
      return json({ ...(await mapsArtStatus()), art_count: await artCount(), preview: { light: dataUri(tried.light), dark: dataUri(tried.dark) } });
    }

    let key: string;
    if (testing) {
      const kept = await tmdbKeyForTest();
      if (!kept) return json({ error: MAPS_ART_COPY.noKept }, 404);
      key = kept;
    } else {
      key = cleanKey((await readBody(req)).key);
      if (!key || key.length > 600) return json({ error: MAPS_ART_COPY.pasteKey }, 400);
    }
    const tried = await testTmdbKey(key);
    if (!tried.ok) {
      if (testing && tried.reason === "rejected") await setKeyStatus("tmdb", "rejected");
      return json({ error: tried.reason === "rejected" ? MAPS_ART_COPY.tmdbRejected : MAPS_ART_COPY.tmdbUnreachable, reason: tried.reason }, tried.reason === "rejected" ? 400 : 502);
    }
    if (testing) await setKeyStatus("tmdb", "working");
    else await saveTmdbKey(key);
    await keepSamples({ poster: tried.poster });
    return json({ ...(await mapsArtStatus()), art_count: await artCount(), preview: { poster: dataUri(tried.poster) } });
  }

  return null;
}
