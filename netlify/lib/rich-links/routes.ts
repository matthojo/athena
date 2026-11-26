/**
 * Rich links in notes over REST. Full access
 * (the app's token or a full key); the caller checks, as for every /api route.
 *
 *  - GET /api/link-preview?url=…[&refresh=1]: a web address's preview
 *    (lib/link-previews.ts), kept or read now. A read counts towards 30 a
 *    minute per caller; a kept preview doesn't. 400 for an address that
 *    isn't one, 429 over the limit with nothing kept, 503 without the data key.
 *  - GET /api/link-preview/:id/image and /favicon: the kept WebP, with the
 *    same safe headers as Saved's pictures.
 *  - GET /api/places/:id/map[?theme=dark&size=card|full|tall]: a Place's
 *    mini map, one pin, drawn and cached like a day's map (lib/static-map.ts).
 *  - GET /api/link-map?url=…[&theme&size]: the still for a Google Maps or
 *    Apple Maps link, one pin at the spot its address gives.
 *
 * Maps answer like GET /api/days/:date/map: the WebP with X-Map-State: ready,
 * or JSON { state } (no_key, key_rejected, no_places, unavailable).
 * Nothing here logs an address, a place or a coordinate.
 */
import { getLinkPreview, isPreviewId, PreviewRateLimited, PreviewUnavailable, readPreviewPicture, takePreviewSlot } from "../../../lib/link-previews";
import { mapCoordinates } from "../../../lib/embeds";
// Previews through connected accounts (a Notion page), registered on load.
import "./connector-previews";
import { pinMap, placeMap, type DayMap, type MapSize, type MapTheme } from "../../../lib/static-map";

type Json = (data: unknown, status?: number) => Response;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PREVIEW_ERRORS = {
  notAddress: "That isn't a web address.",
  noKey: "Athena can't keep link previews here: its encryption key isn't set.",
  tooMany: "That's a lot of link previews in one minute. Try again shortly.",
  notMap: "That isn't a Google Maps or Apple Maps link.",
} as const;

/** The headers Saved's pictures go out with: WebP only, never sniffed, never run. */
function pictureResponse(bytes: Buffer, cors: Record<string, string>): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      // The address carries ?v=<when it was read>, so a refresh gets a new one.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...cors,
    },
  });
}

/** A map as GET /api/days/:date/map sends it. */
function mapResponse(req: Request, map: DayMap, cors: Record<string, string>): Response {
  if (map.state !== "ready") {
    return new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Map-State": map.state, ...cors } });
  }
  const etag = `"${map.etag}"`;
  const headers = {
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "X-Map-State": "ready",
    "X-Map-Stops": String(map.stops),
    "X-Map-Attribution": encodeURIComponent(map.attribution),
    "Access-Control-Expose-Headers": "X-Map-State, X-Map-Stops, X-Map-Attribution, ETag",
    ...cors,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(map.image), {
    headers: { ...headers, "Content-Type": "image/webp", "Content-Length": String(map.image.length), "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
  });
}

const themeOf = (url: URL): MapTheme => (url.searchParams.get("theme") === "dark" ? "dark" : "light");
const sizeOf = (url: URL): MapSize => {
  const asked = url.searchParams.get("size");
  return asked === "full" || asked === "tall" ? asked : "card";
};

/** Handles the routes above; null for anything else. */
export async function handleRichLinkRoutes(req: Request, url: URL, segments: string[], json: Json, cors: Record<string, string>): Promise<Response | null> {
  const [, first, second, third] = segments;

  if (first === "link-preview") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (segments.length === 2) {
      try {
        const preview = await getLinkPreview(url.searchParams.get("url"), { refresh: url.searchParams.get("refresh") === "1", takeSlot: () => takePreviewSlot(req) });
        if (!preview) return json({ error: PREVIEW_ERRORS.notAddress }, 400);
        return json(preview);
      } catch (error) {
        if (error instanceof PreviewUnavailable) return json({ error: PREVIEW_ERRORS.noKey }, 503);
        if (error instanceof PreviewRateLimited) return json({ error: PREVIEW_ERRORS.tooMany }, 429);
        throw error;
      }
    }
    if (segments.length === 4 && (third === "image" || third === "favicon")) {
      if (!isPreviewId(second)) return json({ error: "Not found" }, 404);
      const bytes = await readPreviewPicture(second, third);
      return bytes ? pictureResponse(bytes, cors) : json({ error: "Image not found" }, 404);
    }
    return json({ error: "Not found" }, 404);
  }

  if (first === "places" && segments.length === 4 && third === "map") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!UUID.test(second)) return json({ error: "Not found" }, 404);
    return mapResponse(req, await placeMap(second.toLowerCase(), themeOf(url), sizeOf(url)), cors);
  }

  if (first === "link-map" && segments.length === 2) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const raw = url.searchParams.get("url");
    const at = mapCoordinates(raw);
    if (!at) {
      // A map link without a spot in its address (a search, a short link) has no still.
      const isMap = /^https?:\/\/([a-z0-9-]+\.)*(google\.[a-z.]+|maps\.apple\.com|maps\.apple)\//i.test(raw ?? "");
      return isMap ? mapResponse(req, { state: "no_places" }, cors) : json({ error: PREVIEW_ERRORS.notMap }, 400);
    }
    return mapResponse(req, await pinMap(at, themeOf(url), sizeOf(url)), cors);
  }

  return null;
}
