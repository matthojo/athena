/**
 * Artwork for Days and Watch & read: film and show posters, book covers,
 * album art and game headers. Never people's photos. SECURITY.md §13 has the
 * rules.
 *
 * Fetched once, by the server. The browser never asks a third party for an
 * image: it asks GET /api/art/:id, behind the app's token, and gets a copy
 * Athena keeps.
 *
 *  - Where art comes from (ArtHint, first that works wins): an image address
 *    an adapter returned (Letterboxd's poster in its RSS, Spotify's and
 *    Last.fm's album images), a Steam app id, a thumbnail on the owner's own
 *    Plex or Jellyfin server, an ISBN or a title on Open Library, a film
 *    or show title on TMDB when the owner added a TMDB key, and an album
 *    (or a track, or an artist's best-known album) by name on Deezer.
 *  - What's fetched: https only, from ART_HOSTS (or the owner's own media
 *    server for an `own` hint), every redirect hop checked again and every
 *    host resolved and refused if it's internal. 6 seconds and 6 MB at most;
 *    the bytes must be a JPEG, PNG, WebP or GIF.
 *  - What's kept: two WebP sizes (sm, 240 px on the long edge; lg, 800 px),
 *    sealed under the data key in Netlify Blobs (store "athena-art"), and an
 *    `art` row (blind-index id, the large size's pixels, a tone (average colour) for
 *    the placeholder). The id is a blind index of the original bytes, so the
 *    same cover from two addresses is kept once. `art_sources` maps a blind
 *    index of each source to its art, or to nothing for a fortnight when the
 *    source had none.
 *
 * attachArt() is the one way art gets onto entries: the days data session
 * calls it while it builds a day. It never throws.
 */
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import sharp, { type Sharp } from "sharp";
import { assertPublicHost, publicFetch } from "../netlify/lib/connectors/icons";
import { blindIndex, blindIndexes, currentKeyId, dataKeyConfigured, openBytes, sealBytes } from "./data-box";
import { qRaw } from "./db";
import { youtubeId } from "./watch-meta";
import { NOT_MUSIC, TRACK_SOURCES } from "./music";

// ---------- Shapes ----------

/** What a day entry carries (DayEntry.art in lib/day-types.ts). */
export interface ArtRef {
  id: string;
  w: number;
  h: number;
  /** "#rrggbb": the placeholder's colour while the image loads. */
  tone?: string;
}

/** Where an entry's art might come from. The first that gives an image wins. */
export type ArtHint =
  | { url: string }
  | { steam: number }
  | { own: { url: string; headers?: Record<string, string>; key: string } }
  | { spotify: string }
  /** A YouTube video id: its thumbnail. Watch & read only. */
  | { youtube: string }
  | { letterboxd: string }
  | { isbn: string }
  | { book: { title: string; author?: string } }
  /** An album by name on Deezer; a track's album when `track`; no title: the artist's best-known album. Always an album cover, never the artist. */
  | { album: { artist: string; title?: string; track?: boolean } }
  | { film: { title: string; year?: number } }
  | { show: { title: string; year?: number } };

export type ArtSize = "sm" | "lg";

// ---------- Limits ----------

/** Longest edge of each kept size, in pixels. */
export const ART_SIZES: Record<ArtSize, number> = { sm: 240, lg: 800 };
/** Largest source image fetched. */
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
/** Per request, each redirect included. */
export const FETCH_TIMEOUT_MS = 6_000;
/** A source with no art is asked again after this long. */
export const MISS_RETRY_MS = 14 * 86_400_000;
/** How long attachArt() spends fetching new art, by default. */
export const DEFAULT_BUDGET_MS = 2_500;
const PARALLEL = 4;
const MAX_REDIRECTS = 3;

// ---------- The allowlist ----------

/** Image hosts Athena fetches art from. Anything else is refused. */
export const ART_HOSTS: readonly string[] = [
  "a.ltrbxd.com", // Letterboxd posters
  "i.scdn.co", // Spotify album art
  "mosaic.scdn.co",
  "lastfm.freetls.fastly.net", // Last.fm album art
  "shared.akamai.steamstatic.com", // Steam headers
  "shared.fastly.steamstatic.com",
  "cdn.akamai.steamstatic.com",
  "cdn.cloudflare.steamstatic.com",
  "covers.openlibrary.org", // Open Library covers (redirect to archive.org)
  "archive.org",
  "image.tmdb.org", // TMDB posters
  "i.ytimg.com", // YouTube video thumbnails (Watch & read's videos only)
  "cdn-images.dzcdn.net", // Deezer album covers
  "e-cdns-images.dzcdn.net",
];
/** Hosts matched by suffix: Open Library's covers are served from numbered archive.org machines. */
const ART_HOST_SUFFIXES: readonly string[] = [".us.archive.org", ".spotifycdn.com"];
/** The lookups that turn a title or ISBN into an image address, and MusicBrainz for an artist's genres (netlify/lib/music-genres.ts). JSON only, never shown. */
export const LOOKUP_HOSTS: readonly string[] = ["openlibrary.org", "api.themoviedb.org", "open.spotify.com", "api.deezer.com", "musicbrainz.org"];
/** The one page read for its art: a Letterboxd film page names its poster in its structured data. */
export const PAGE_HOSTS: readonly string[] = ["letterboxd.com"];

/** True when Athena may fetch art from this address (https, an allowed host, no credentials in it). */
export function artUrlAllowed(raw: string | URL, ownHost?: string): boolean {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443" && !(ownHost && url.host === ownHost))) return false;
  const host = url.hostname.toLowerCase();
  if (ownHost) return url.host.toLowerCase() === ownHost.toLowerCase();
  return ART_HOSTS.includes(host) || ART_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

// ---------- Fetching ----------

export class ArtFetchError extends Error {
  constructor(
    readonly reason: "not_allowed" | "internal" | "timeout" | "too_big" | "not_image" | "http" | "failed",
    message?: string,
  ) {
    super(message ?? reason);
  }
}

/** Replaceable in tests: the network and the DNS check. */
export const artDeps = {
  fetch: (input: string | URL, init?: RequestInit) => publicFetch(input, init),
  assertPublic: (url: URL) => assertPublicHost(url),
  now: () => Date.now(),
  timeoutMs: FETCH_TIMEOUT_MS,
};

/** What the bytes are, from their first few bytes. Only the four web image types are kept. */
export function sniffImage(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/**
 * GET an allowed address with redirects followed by hand (each hop checked
 * against the allowlist and the DNS check), a timeout and a byte cap.
 * `accept: "json"` is for the two lookups; everything else must be an image.
 */
export async function safeFetch(
  raw: string,
  opts: { headers?: Record<string, string>; ownHost?: string; accept?: "image" | "json" | "html"; maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  const allowed = (u: URL) =>
    opts.accept === "json"
      ? u.protocol === "https:" && LOOKUP_HOSTS.includes(u.hostname) && !u.username
      : opts.accept === "html"
        ? u.protocol === "https:" && PAGE_HOSTS.includes(u.hostname) && !u.username
        : artUrlAllowed(u, opts.ownHost);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtFetchError("not_allowed");
  }
  // One deadline for the whole fetch, redirects included (a timer of our own: AbortSignal.timeout doesn't hold the process open).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" })), artDeps.timeoutMs);
  try {
    return await fetchHops(url, opts, maxBytes, allowed, ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHops(
  start: URL,
  opts: { headers?: Record<string, string>; ownHost?: string; accept?: "image" | "json" | "html" },
  maxBytes: number,
  allowed: (u: URL) => boolean,
  deadline: AbortSignal,
): Promise<Buffer> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(url)) throw new ArtFetchError("not_allowed", url.hostname);
    try {
      await artDeps.assertPublic(url);
    } catch {
      throw new ArtFetchError("internal", url.hostname);
    }
    let res: Response;
    try {
      res = await artDeps.fetch(url, {
        redirect: "manual",
        signal: deadline,
        // The owner's server's own header (Plex's or Jellyfin's token) only ever goes to that server.
        headers: { Accept: opts.accept === "json" ? "application/json" : opts.accept === "html" ? "text/html" : "image/webp,image/*;q=0.9", "User-Agent": "Athena-personal-notes/1.0", ...(opts.ownHost && url.host === opts.ownHost ? opts.headers : opts.accept === "json" ? opts.headers : {}) },
      });
    } catch (error) {
      throw new ArtFetchError((error as Error)?.name === "TimeoutError" || deadline.aborted ? "timeout" : "failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new ArtFetchError("http", String(res.status));
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ArtFetchError("http", String(res.status));
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new ArtFetchError("too_big");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ArtFetchError("too_big");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof ArtFetchError) throw error;
      throw new ArtFetchError(deadline.aborted ? "timeout" : "failed");
    }
    const bytes = Buffer.concat(chunks);
    if ((opts.accept ?? "image") === "image" && !sniffImage(bytes)) throw new ArtFetchError("not_image");
    return bytes;
  }
  throw new ArtFetchError("http", "too many redirects");
}

// ---------- Resizing ----------

export interface PreparedArt {
  sm: Buffer;
  lg: Buffer;
  /** The large size's pixels. */
  w: number;
  h: number;
  tone: string;
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Images above this many pixels are refused from their header, before any decode (security review M20). */
export const MAX_DECODE_PIXELS = 25_000_000;
/** A JPEG is decoded at a reduced size, so a large one costs little: a full-size phone photo is kept (owner's decision, 10 Nov 2026). */
export const MAX_JPEG_PIXELS = 60_000_000;

export interface DecodedImage {
  w: number;
  h: number;
  /** A fresh pipeline over the decoded pixels: derive every other size and the tone from this, never from the source bytes. */
  from(): Sharp;
}

/**
 * Decode untrusted image bytes exactly once, to sRGB pixels at most `edge` on
 * the long side (EXIF orientation applied, metadata dropped). The header is
 * read first and anything over the limit (25 megapixels; 60 for a JPEG) is
 * refused there, so a small crafted file can't make several full-size
 * decodes run side by side.
 */
export async function decodeImage(bytes: Uint8Array, edge: number): Promise<DecodedImage> {
  // The limit goes by what the bytes are, not by what a header claims to be.
  const limit = sniffImage(bytes) === "image/jpeg" ? MAX_JPEG_PIXELS : MAX_DECODE_PIXELS;
  const opts = { limitInputPixels: limit, animated: false, failOn: "error" as const };
  const meta = await sharp(bytes, opts).metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > limit || (limit === MAX_JPEG_PIXELS && meta.format !== "jpeg")) throw new Error("image too large");
  const { data, info } = await sharp(bytes, opts)
    .rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  return { w: info.width, h: info.height, from: () => sharp(data, { raw }) };
}

/** Two WebP sizes and the overall colour. EXIF orientation is applied; metadata is dropped. */
export async function prepareArt(bytes: Buffer): Promise<PreparedArt> {
  const d = await decodeImage(bytes, ART_SIZES.lg);
  // The tone is the image's average colour. sharp's "dominant" picks the most common coarse bin, which on real
  // covers is usually the black or white background (The Wager came out #081818, Hades #080808); the average
  // reads as the cover (teal, warm brown) while it loads.
  const [lg, sm, mean] = await Promise.all([
    d.from().webp({ quality: 80, effort: 4 }).toBuffer(),
    d.from().resize({ width: ART_SIZES.sm, height: ART_SIZES.sm, fit: "inside", withoutEnlargement: true }).webp({ quality: 76, effort: 4 }).toBuffer(),
    d.from().removeAlpha().resize(1, 1, { fit: "fill", kernel: "cubic" }).raw().toBuffer(),
  ]);
  return { lg, sm, w: d.w, h: d.h, tone: `#${hex(mean[0])}${hex(mean[1])}${hex(mean[2])}` };
}

// ---------- Storing ----------

const STORE = "athena-art";
let storeFor: () => ReturnType<typeof getStore> = () => getStore({ name: STORE, consistency: "strong" });
/** Replace the blob store (tests). */
export function useArtStore(make: () => ReturnType<typeof getStore>): void {
  storeFor = make;
}

const ART_ID = /^[A-Za-z0-9_-]{22}$/;
export const isArtId = (raw: unknown): raw is string => typeof raw === "string" && ART_ID.test(raw);

/** A source's identity before any lookup: what dedupes it. Titles are folded so "The Wager" and "the wager " match. */
export function sourceKey(hint: ArtHint): string | null {
  const fold = (s: string | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if ("url" in hint) {
    try {
      const u = new URL(hint.url);
      u.hash = "";
      return `url:${u.toString()}`;
    } catch {
      return null;
    }
  }
  if ("steam" in hint) return Number.isInteger(hint.steam) && hint.steam > 0 ? `steam:${hint.steam}` : null;
  if ("spotify" in hint) return spotifyPath(hint.spotify) ? `spotify:${spotifyPath(hint.spotify)}` : null;
  if ("youtube" in hint) return /^[\w-]{11}$/.test(hint.youtube) ? `yt:${hint.youtube}` : null;
  if ("letterboxd" in hint) return letterboxdFilm(hint.letterboxd) ? `lbx:${letterboxdFilm(hint.letterboxd)}` : null;
  if ("own" in hint) return hint.own.key ? `own:${hint.own.key}` : null;
  if ("isbn" in hint) {
    const isbn = hint.isbn.replace(/[^0-9Xx]/g, "").toUpperCase();
    return isbn.length === 10 || isbn.length === 13 ? `isbn:${isbn}` : null;
  }
  if ("book" in hint) return fold(hint.book.title) ? `book:${fold(hint.book.title)}|${fold(hint.book.author)}` : null;
  if ("album" in hint) {
    const artist = musicKey(hint.album.artist);
    if (!artist) return null;
    const title = musicKey(hint.album.title ?? "");
    return title ? `deezer:${hint.album.track ? "track" : "album"}:${artist}|${title}` : `deezer:artist:${artist}`;
  }
  if ("film" in hint) return fold(hint.film.title) ? `tmdb:movie:${fold(hint.film.title)}|${hint.film.year ?? ""}` : null;
  if ("show" in hint) return fold(hint.show.title) ? `tmdb:tv:${fold(hint.show.title)}|${hint.show.year ?? ""}` : null;
  return null;
}

const sourceHash = (key: string) => blindIndex("other", `art-src\u0000${key}`);
const sourceHashes = (key: string) => blindIndexes("other", `art-src\u0000${key}`);

/** Keep these bytes as art (or find them already kept), and remember the source. */
export async function storeArt(key: string, bytes: Buffer): Promise<ArtRef> {
  const id = blindIndex("other", `art-img\u0000${createHash("sha256").update(bytes).digest("hex")}`);
  const src = sourceHash(key);
  if (!id || !src) throw new Error("no data key");
  const [have] = await qRaw<{ w: number; h: number; tone: string | null }>(`SELECT w, h, tone FROM art WHERE id = $1`, [id]);
  let ref: ArtRef;
  if (have) {
    ref = { id, w: have.w, h: have.h, ...(have.tone ? { tone: have.tone } : {}) };
  } else {
    const p = await prepareArt(bytes);
    const store = storeFor();
    const lg = sealBytes(p.lg);
    const sm = sealBytes(p.sm);
    await store.set(`${id}/lg`, new Uint8Array(lg.sealed).buffer as ArrayBuffer);
    await store.set(`${id}/sm`, new Uint8Array(sm.sealed).buffer as ArrayBuffer);
    await qRaw(`INSERT INTO art (id, w, h, tone, bytes, kid) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [id, p.w, p.h, p.tone, p.lg.length + p.sm.length, lg.kid]);
    ref = { id, w: p.w, h: p.h, tone: p.tone };
  }
  await linkSource(src, id);
  return ref;
}

async function linkSource(src: string, artId: string | null): Promise<void> {
  await qRaw(
    `INSERT INTO art_sources (source_hash, art_id, checked_at) VALUES ($1, $2, now())
     ON CONFLICT (source_hash) DO UPDATE SET art_id = EXCLUDED.art_id, checked_at = now()`,
    [src, artId],
  );
}

/** One kept size, opened. Null when there's no such art (or it can't be opened here). */
export async function readArt(id: string, size: ArtSize): Promise<Buffer | null> {
  if (!isArtId(id)) return null;
  const sealed = await storeFor().get(`${id}/${size}`, { type: "arrayBuffer" });
  if (!sealed) return null;
  try {
    return openBytes(new Uint8Array(sealed));
  } catch {
    return null;
  }
}

/**
 * After a key rotation: re-seal art still under an old key, within `budgetMs`
 * (lib/encryption.ts calls this). In id order with a cursor, so art that
 * won't open is counted and passed, never in the way of the rest. Ids stay as they are: entries point at them.
 */
export async function resealArt(budgetMs = 4_000): Promise<{ resealed: number; failed: number }> {
  const kid = currentKeyId();
  const report = { resealed: 0, failed: 0 };
  if (!kid) return report;
  const until = Date.now() + budgetMs;
  const store = storeFor();
  let after = "";
  for (;;) {
    const rows = await qRaw<{ id: string }>(`SELECT id FROM art WHERE kid <> $1 AND id > $2 ORDER BY id LIMIT 50`, [kid, after]);
    if (!rows.length) return report;
    for (const { id } of rows) {
      if (Date.now() > until) return report;
      try {
        // Both sizes are opened before either is written; bytes that are gone have nothing left to re-seal.
        const next: Array<[string, Buffer]> = [];
        for (const key of [`${id}/lg`, `${id}/sm`]) {
          const sealed = await store.get(key, { type: "arrayBuffer" });
          if (sealed) next.push([key, sealBytes(openBytes(new Uint8Array(sealed))).sealed]);
        }
        for (const [key, sealed] of next) await store.set(key, new Uint8Array(sealed).buffer as ArrayBuffer);
        await qRaw(`UPDATE art SET kid = $2 WHERE id = $1`, [id, kid]);
        report.resealed++;
      } catch {
        report.failed++;
      }
    }
    after = rows[rows.length - 1].id;
  }
}

/** How many images Athena keeps (Settings). */
export async function artCount(): Promise<number> {
  try {
    const [row] = await qRaw<{ n: string | number }>(`SELECT count(*) AS n FROM art`);
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

// ---------- Lookups (title or ISBN → an image address) ----------

/** Replaceable in tests: the owner's TMDB key, read from Settings (lib/art-settings.ts). */
export const artKeys = { tmdb: async (): Promise<string | null> => (await import("./art-settings")).tmdbKey() };

/** TMDB takes a v3 API key as a parameter, or a v4 read token as a bearer header. */
export function tmdbAuth(key: string): { params: Record<string, string>; headers: Record<string, string> } {
  return key.startsWith("eyJ") ? { params: {}, headers: { Authorization: `Bearer ${key}` } } : { params: { api_key: key }, headers: {} };
}

/** A film's or show's poster address on TMDB, or null. */
export async function tmdbPoster(kind: "movie" | "tv", title: string, year: number | undefined, key: string): Promise<string | null> {
  const auth = tmdbAuth(key);
  const u = new URL(`https://api.themoviedb.org/3/search/${kind}`);
  u.searchParams.set("query", title);
  u.searchParams.set("include_adult", "false");
  if (year) u.searchParams.set(kind === "movie" ? "primary_release_year" : "first_air_date_year", String(year));
  for (const [k, v] of Object.entries(auth.params)) u.searchParams.set(k, v);
  const body = JSON.parse((await safeFetch(u.toString(), { accept: "json", headers: auth.headers, maxBytes: 512 * 1024 })).toString("utf8")) as { results?: Array<{ poster_path?: string | null }> };
  const path = body.results?.find((r) => typeof r.poster_path === "string" && /^\/[\w.-]+$/.test(r.poster_path))?.poster_path;
  return path ? `https://image.tmdb.org/t/p/w780${path}` : null;
}

/** A title compared loosely: case, accents, punctuation and a leading "The" don't count. */
const titleKey = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");

/**
 * A book's cover on Open Library by title (and author), or null. A plain
 * query finds covers the structured title search misses (it can match an
 * edition without one). Only a result whose title matches is used, so "A
 * Summary of The Wager" never wins over The Wager.
 */
export async function openLibraryCover(title: string, author?: string): Promise<string | null> {
  const u = new URL("https://openlibrary.org/search.json");
  u.searchParams.set("q", [title, author].filter(Boolean).join(" "));
  u.searchParams.set("limit", "5");
  u.searchParams.set("fields", "cover_i,title");
  const body = JSON.parse((await safeFetch(u.toString(), { accept: "json", maxBytes: 512 * 1024 })).toString("utf8")) as { docs?: Array<{ cover_i?: number; title?: string }> };
  const want = titleKey(title);
  const doc = body.docs?.find((d) => Number.isInteger(d.cover_i) && (d.cover_i as number) > 0 && typeof d.title === "string" && titleKey(d.title) === want);
  return doc ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null;
}

// ---------- Deezer: album covers by name ----------

/** An artist or album name compared loosely: case, accents, "&", punctuation and a leading "The" don't count. */
export const musicKey = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");

/** An album title without the edition it is: "(Deluxe)", "[Remastered 2011]", " - EP", " - Single". */
const bareTitle = (t: string) =>
  musicKey(
    t
      .replace(/\s*[([][^)\]]*\b(deluxe|edition|remaster(ed)?|expanded|anniversary|bonus|version|explicit|clean|mono|stereo)\b[^)\]]*[)\]]/gi, "")
      .replace(/\s+-\s+(ep|single)\s*$/i, ""),
  );

export interface DeezerAlbum {
  title?: string;
  artist?: { name?: string };
  cover_xl?: string;
  cover_big?: string;
}

/** A Deezer cover address, unless it's the blank one Deezer gives an album without a cover. */
const deezerImage = (a: DeezerAlbum | undefined) => [a?.cover_xl, a?.cover_big].find((u): u is string => typeof u === "string" && /^https:\/\//.test(u) && !/\/images\/cover\/\//.test(u)) ?? null;

/**
 * The cover of the album that is this one: the same artist (exactly, as
 * musicKey has it), then the same title, else the same without its edition,
 * else one that starts with the other ("Carrie & Lowell" for "Carrie &
 * Lowell (10th Anniversary Edition)"). No title: the artist's first, which
 * Deezer ranks by how much it's played. Null when nothing matches.
 */
export function deezerCoverOf(albums: DeezerAlbum[] | undefined, artist: string, title?: string): string | null {
  const who = musicKey(artist);
  const theirs = (albums ?? []).filter((a) => typeof a.artist?.name === "string" && musicKey(a.artist.name) === who && deezerImage(a));
  if (!title) return deezerImage(theirs[0]);
  const want = musicKey(title);
  const bare = bareTitle(title);
  const score = (a: DeezerAlbum) => {
    const t = musicKey(a.title ?? "");
    if (!t) return 0;
    if (t === want) return 3;
    if (bareTitle(a.title ?? "") === bare) return 2;
    return t.startsWith(bare) || bare.startsWith(t) ? 1 : 0;
  };
  let best: DeezerAlbum | undefined;
  let top = 0;
  for (const a of theirs) {
    const s = score(a);
    if (s > top) [best, top] = [a, s];
  }
  return deezerImage(best);
}

/** Deezer says it's busy with a 200 and an error body: thrown as a 429, so it's asked again later. */
async function deezerSearch<T>(path: string, q: string): Promise<T[]> {
  const u = new URL(`https://api.deezer.com/search/${path}`);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "10");
  const body = JSON.parse((await safeFetch(u.toString(), { accept: "json", maxBytes: 512 * 1024 })).toString("utf8")) as { data?: T[]; error?: { code?: number } };
  if (body.error) throw new ArtFetchError("http", body.error.code === 4 ? "429" : "503");
  return Array.isArray(body.data) ? body.data : [];
}

/** A quoted term for Deezer's advanced search. */
const dq = (s: string) => `"${s.replace(/"/g, " ").trim()}"`;

/**
 * The cover for an album, a track's album, or (no title) the artist's
 * best-known album, by name on Deezer. Its field search ("artist:… album:…")
 * first; when that finds nothing (it misses some tracks), the plain words,
 * held to the same match.
 */
export async function deezerCover(album: { artist: string; title?: string; track?: boolean }): Promise<string | null> {
  if (!musicKey(album.artist)) return null;
  const title = album.title && musicKey(album.title) ? album.title : undefined;
  const search = async <T>(path: string, fields: string, words: string) => {
    const found = await deezerSearch<T>(path, fields);
    return found.length ? found : deezerSearch<T>(path, words);
  };
  if (album.track && title) {
    const tracks = await search<{ title?: string; artist?: { name?: string }; album?: DeezerAlbum }>("track", `artist:${dq(album.artist)} track:${dq(title)}`, `${album.artist} ${title}`);
    // A track's album: matched on the track's own title and artist, its album's cover.
    const hit = tracks.find((t) => typeof t.artist?.name === "string" && musicKey(t.artist.name) === musicKey(album.artist) && bareTitle(t.title ?? "") === bareTitle(title) && deezerImage(t.album));
    return deezerImage(hit?.album);
  }
  const albums = title ? await search<DeezerAlbum>("album", `artist:${dq(album.artist)} album:${dq(title)}`, `${album.artist} ${title}`) : await search<DeezerAlbum>("album", `artist:${dq(album.artist)}`, album.artist);
  return deezerCoverOf(albums, album.artist, title);
}

/** "album/1EoDsNmgTLtmwe1BDAVxV5" from a Spotify link to an album, track, episode or show; null otherwise. */
export function spotifyPath(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "open.spotify.com") return null;
    const m = /^\/(?:intl-[a-z-]+\/)?(album|track|episode|show)\/([A-Za-z0-9]{10,40})\/?$/.exec(u.pathname);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/** Album art for a Spotify link, through Spotify's public oEmbed (no key). */
export async function spotifyArt(link: string): Promise<string | null> {
  const path = spotifyPath(link);
  if (!path) return null;
  const u = new URL("https://open.spotify.com/oembed");
  u.searchParams.set("url", `https://open.spotify.com/${path}`);
  const body = JSON.parse((await safeFetch(u.toString(), { accept: "json", maxBytes: 64 * 1024 })).toString("utf8")) as { thumbnail_url?: string };
  return typeof body.thumbnail_url === "string" && artUrlAllowed(body.thumbnail_url) ? body.thumbnail_url : null;
}

/** "past-lives" from a Letterboxd film or diary link (letterboxd.com/film/x/ or letterboxd.com/<member>/film/x/…). */
export function letterboxdFilm(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hostname !== "letterboxd.com" && u.hostname !== "www.letterboxd.com") return null;
    const m = /^\/(?:[A-Za-z0-9_]+\/)?film\/([a-z0-9-]{1,120})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The poster a Letterboxd film page names in its structured data (JSON-LD "image"), or null. */
export function letterboxdPagePoster(html: string): string | null {
  for (const m of html.matchAll(/"image"\s*:\s*"(https:\/\/a\.ltrbxd\.com\/resized\/film-poster\/[^"]+)"/g)) {
    const src = m[1].replace(/\\\//g, "/");
    if (artUrlAllowed(src)) return src;
  }
  return null;
}

/** Steam's header image for an app. */
export const steamHeader = (appId: number) => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;

/** Letterboxd's diary RSS puts the poster in the item's description: its address, or null. */
export function letterboxdPoster(descriptionHtml: string | null | undefined): string | null {
  const m = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(descriptionHtml ?? "");
  if (!m) return null;
  const src = m[1].replace(/&amp;/g, "&");
  return artUrlAllowed(src) ? src : null;
}

/** The widescreen thumbnails YouTube keeps for a video, sharpest first. Not every video has the first two. */
export const youtubeThumbnails = (id: string): string[] => ["maxresdefault", "hq720", "mqdefault"].map((size) => `https://i.ytimg.com/vi/${id}/${size}.jpg`);

/** A video's thumbnail: the sharpest size it has. A missing size is a 404; anything else is thrown for later. */
async function youtubeThumbnail(id: string): Promise<Buffer | null> {
  for (const url of youtubeThumbnails(id)) {
    try {
      return await safeFetch(url);
    } catch (error) {
      if (error instanceof ArtFetchError && error.reason === "http" && error.message === "404") continue;
      throw error;
    }
  }
  return null;
}

/** Fetch one hint's image. Null: this source has no art (remembered); throws: try again later. */
async function fetchHint(hint: ArtHint): Promise<Buffer | null> {
  try {
    if ("url" in hint) return await safeFetch(hint.url);
    if ("steam" in hint) return await safeFetch(steamHeader(hint.steam));
    if ("spotify" in hint) {
      const url = await spotifyArt(hint.spotify);
      return url ? await safeFetch(url) : null;
    }
    if ("youtube" in hint) return await youtubeThumbnail(hint.youtube);
    if ("letterboxd" in hint) {
      const slug = letterboxdFilm(hint.letterboxd);
      if (!slug) return null;
      const page = (await safeFetch(`https://letterboxd.com/film/${slug}/`, { accept: "html", maxBytes: 1024 * 1024 })).toString("utf8");
      const url = letterboxdPagePoster(page);
      return url ? await safeFetch(url) : null;
    }
    if ("own" in hint) {
      const u = new URL(hint.own.url);
      return await safeFetch(hint.own.url, { ownHost: u.host, headers: hint.own.headers });
    }
    if ("isbn" in hint) {
      const isbn = sourceKey(hint)!.slice(5);
      return await safeFetch(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`);
    }
    if ("book" in hint) {
      const url = await openLibraryCover(hint.book.title, hint.book.author);
      return url ? await safeFetch(url) : null;
    }
    if ("album" in hint) {
      const url = await deezerCover(hint.album);
      return url ? await safeFetch(url) : null;
    }
    const key = await artKeys.tmdb();
    if (!key) return null;
    const url = "film" in hint ? await tmdbPoster("movie", hint.film.title, hint.film.year, key) : await tmdbPoster("tv", hint.show.title, hint.show.year, key);
    return url ? await safeFetch(url) : null;
  } catch (error) {
    // A 404, a refused host or something that isn't an image: this source has none. A timeout or a 5xx: later.
    if (error instanceof ArtFetchError && (error.reason === "timeout" || error.reason === "failed" || (error.reason === "http" && /^(5\d\d|429)$/.test(error.message)))) throw error;
    return null;
  }
}

// ---------- The hook ----------

export interface ArtOptions {
  /** How long to spend fetching new art (default 2.5 s). */
  budgetMs?: number;
  /** Keep the Function alive for fetches still going when the budget ends (Netlify's context.waitUntil). */
  waitUntil?: (p: Promise<unknown>) => void;
}

interface Known {
  art: ArtRef | null;
  checked: number;
}

/**
 * Put art on entries. Art already kept comes from one query; new art is
 * fetched for up to `budgetMs` (4 at a time, each source once even when
 * many entries share it), and anything left is fetched on a later call.
 * Hints with no key (a TMDB title without a TMDB key) are skipped. Without
 * the data key nothing is fetched (art is only kept sealed). Never throws:
 * an entry without art comes back as it was.
 */
export async function attachArt<E extends { id: string; art?: ArtRef }>(items: Array<{ entry: E; hints: ArtHint[] }>, opts: ArtOptions = {}): Promise<E[]> {
  const out = items.map((i) => i.entry);
  if (!items.length || !dataKeyConfigured()) return out;
  try {
    const keyed = items.map((i) => i.hints.map((h) => ({ hint: h, key: sourceKey(h) })).filter((x): x is { hint: ArtHint; key: string } => !!x.key));
    const allKeys = [...new Set(keyed.flat().map((x) => x.key))];
    const byHash = new Map<string, string>();
    for (const k of allKeys) for (const hsh of sourceHashes(k)) byHash.set(hsh, k);
    const rows = byHash.size
      ? await qRaw<{ source_hash: string; art_id: string | null; checked_at: Date | string; w: number | null; h: number | null; tone: string | null }>(
          `SELECT s.source_hash, s.art_id, s.checked_at, a.w, a.h, a.tone FROM art_sources s LEFT JOIN art a ON a.id = s.art_id WHERE s.source_hash = ANY($1::text[])`,
          [[...byHash.keys()]],
        )
      : [];
    const known = new Map<string, Known>();
    for (const r of rows) {
      const k = byHash.get(r.source_hash)!;
      const art = r.art_id && r.w && r.h ? { id: r.art_id, w: r.w, h: r.h, ...(r.tone ? { tone: r.tone } : {}) } : null;
      const prev = known.get(k);
      if (!prev || (art && !prev.art)) known.set(k, { art, checked: new Date(r.checked_at).getTime() });
    }

    const now = artDeps.now();
    const deadline = now + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
    const tmdb = keyed.some((ks) => ks.some((x) => "film" in x.hint || "show" in x.hint)) ? await artKeys.tmdb().catch(() => null) : null;
    const usable = (x: { hint: ArtHint }) => !(("film" in x.hint || "show" in x.hint) && !tmdb);

    // First pass: art already kept. What's left needs a fetch, in hint order.
    const pending: Array<{ index: number; rest: Array<{ hint: ArtHint; key: string }> }> = [];
    keyed.forEach((ks, index) => {
      const list = ks.filter(usable);
      for (let j = 0; j < list.length; j++) {
        const k = known.get(list[j].key);
        if (k?.art) {
          out[index] = { ...out[index], art: k.art };
          return;
        }
        if (!k || now - k.checked > MISS_RETRY_MS) {
          pending.push({ index, rest: list.slice(j) });
          return;
        }
      }
    });
    if (!pending.length) return out;

    // Second pass: fetch, each source once.
    const inflight = new Map<string, Promise<ArtRef | null | undefined>>();
    const fetchOnce = (x: { hint: ArtHint; key: string }): Promise<ArtRef | null | undefined> => {
      let p = inflight.get(x.key);
      if (!p) {
        p = (async () => {
          const k = known.get(x.key);
          if (k && (k.art || now - k.checked <= MISS_RETRY_MS)) return k.art;
          try {
            const bytes = await fetchHint(x.hint);
            if (!bytes) {
              const src = sourceHash(x.key);
              if (src) await linkSource(src, null);
              return null;
            }
            return await storeArt(x.key, bytes);
          } catch {
            return undefined; // try again next time
          }
        })();
        inflight.set(x.key, p);
      }
      return p;
    };
    let next = 0;
    const worker = async () => {
      while (next < pending.length && artDeps.now() < deadline) {
        const job = pending[next++];
        for (const x of job.rest) {
          if (artDeps.now() >= deadline) return;
          const art = await withDeadline(fetchOnce(x), deadline);
          if (art) {
            out[job.index] = { ...out[job.index], art };
            break;
          }
          if (art === undefined) break; // unsettled: don't fall back to a worse source yet
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pending.length) }, worker));
    // Fetches still going when the budget ran out finish after the reply (Netlify's context.waitUntil), so a slow cover is ready next time.
    if (opts.waitUntil && inflight.size) opts.waitUntil(Promise.allSettled([...inflight.values()]));
  } catch (error) {
    console.error("Athena art: attachArt failed", (error as Error)?.message);
  }
  return out;
}

/** The promise's value, or undefined once the deadline passes (the work carries on and is kept). */
function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T | undefined> {
  const left = deadline - artDeps.now();
  if (left <= 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), left);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/** For Settings' test: the key works if TMDB finds a well-known film's poster. */
export async function testTmdbKey(key: string): Promise<{ ok: true; poster: Buffer } | { ok: false; reason: "rejected" | "unreachable" }> {
  try {
    const url = await tmdbPoster("movie", "Paddington 2", 2017, key);
    if (!url) return { ok: false, reason: "unreachable" };
    const bytes = await safeFetch(url);
    const p = await sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS }).resize({ width: 240, height: 240, fit: "inside" }).webp({ quality: 76 }).toBuffer();
    return { ok: true, poster: p };
  } catch (error) {
    return { ok: false, reason: error instanceof ArtFetchError && error.reason === "http" && /^40[13]$/.test(error.message) ? "rejected" : "unreachable" };
  }
}

/** Whether new art can be kept on this deploy (the data key seals it). */
export const artStorable = () => dataKeyConfigured() && !!currentKeyId();

// ---------- Day entries (lib/day-types.ts, owned by days data) ----------

/** The parts of a DayEntry art needs (structural, so lib/art.ts doesn't depend on the Days branch). */
export interface DayEntryLike {
  id: string;
  kind: string;
  source: string;
  title: string;
  subtitle?: string;
  url?: string;
  art?: ArtRef;
}

/** What an adapter knew that the entry doesn't carry. All optional. */
export interface ArtExtras {
  /** An image address the source returned (Letterboxd's poster, Spotify's or Last.fm's album art). */
  image?: string;
  isbn?: string;
  steamAppId?: number;
  /** A Plex or Jellyfin thumbnail through the owner's server. */
  own?: { url: string; headers?: Record<string, string>; key: string };
  /** Release year, for a better TMDB match. */
  year?: number;
  /** When the source knows: a film or a show. */
  type?: "film" | "show";
}

/** Kinds that have artwork. Posts, saves, chess, workouts and the rest never get any: they could be people's photos. */
export const ART_KINDS: readonly string[] = ["watched", "listened", "read", "highlight", "played"];
/** Sources whose "watched" isn't a film or a show, so TMDB isn't asked. */
const NOT_TMDB = new Set(["youtube", "youtube_music"]);

/** The hints for one day entry, best first. */
export function dayEntryHints(e: DayEntryLike, extra: ArtExtras = {}): ArtHint[] {
  if (!ART_KINDS.includes(e.kind)) return [];
  const hints: ArtHint[] = [];
  if (extra.own?.url && extra.own.key) hints.push({ own: extra.own });
  if (extra.image && artUrlAllowed(extra.image)) hints.push({ url: extra.image });
  // From the entry's own link, no key needed: Spotify's oEmbed, a Letterboxd film page.
  if (e.url && e.kind === "listened" && spotifyPath(e.url)) hints.push({ spotify: e.url });
  if (e.url && e.kind === "watched" && letterboxdFilm(e.url)) hints.push({ letterboxd: e.url });
  if (e.kind === "played") {
    const steam = extra.steamAppId ?? Number(/store\.steampowered\.com\/app\/(\d+)/.exec(e.url ?? "")?.[1]);
    if (Number.isInteger(steam) && steam > 0) hints.push({ steam });
  }
  if (e.kind === "read" || e.kind === "highlight") {
    if (extra.isbn) hints.push({ isbn: extra.isbn });
    if (e.title.trim()) hints.push({ book: { title: e.title, ...(e.subtitle ? { author: e.subtitle } : {}) } });
  }
  // Music without a cover from its source: the album by name on Deezer (a track's album for Apple Music's tracks).
  const album = e.kind === "listened" ? albumHint(e) : null;
  if (album) hints.push(album);
  if (e.kind === "watched" && !NOT_TMDB.has(e.source) && e.title.trim()) {
    const show = extra.type ? extra.type === "show" : /\bS\d+\s*·?\s*E\d+\b|\bepisode\b|\bseason\b/i.test(e.subtitle ?? "");
    hints.push(show ? { show: { title: e.title, ...(extra.year ? { year: extra.year } : {}) } } : { film: { title: e.title, ...(extra.year ? { year: extra.year } : {}) } });
  }
  return hints;
}

/**
 * A listened entry's album by name: title is the album (a track for Apple
 * Music), subtitle the artist. An entry titled with the artist (tracks
 * from many albums) asks for the artist's best-known album. Podcasts and
 * audiobooks never.
 */
export function albumHint(e: { source: string; title: string; subtitle?: string }): ArtHint | null {
  if ((NOT_MUSIC as readonly string[]).includes(e.source)) return null;
  const artist = e.subtitle?.trim();
  if (!artist || !musicKey(artist)) return null;
  const title = e.title.trim();
  if (!title || musicKey(title) === musicKey(artist)) return { album: { artist } };
  return { album: { artist, title, ...((TRACK_SOURCES as readonly string[]).includes(e.source) ? { track: true } : {}) } };
}

/**
 * The one call the days data session makes: art onto a day's entries.
 * Entries that already have art keep it. Extras are keyed by entry id.
 */
export async function attachDayArt<E extends DayEntryLike>(entries: E[], extras: Map<string, ArtExtras> | Record<string, ArtExtras> = {}, opts: ArtOptions = {}): Promise<E[]> {
  const get = (id: string) => (extras instanceof Map ? extras.get(id) : extras[id]);
  const todo = entries.map((entry, i) => ({ i, entry, hints: entry.art ? [] : dayEntryHints(entry, get(entry.id)) })).filter((x) => x.hints.length);
  if (!todo.length) return entries;
  const done = await attachArt(todo, opts);
  const out = [...entries];
  todo.forEach((x, k) => (out[x.i] = done[k]));
  return out;
}

/**
 * What's already known about these sources, by source key, without
 * fetching anything (one query): the art kept, or null for a source asked
 * within the last fortnight that had none. A source never asked isn't in
 * the map. What Music reads on every load, so covers found in the
 * background show without each entry being written again.
 */
export async function cachedArt(hints: ArtHint[]): Promise<Map<string, ArtRef | null>> {
  const out = new Map<string, ArtRef | null>();
  if (!hints.length || !dataKeyConfigured()) return out;
  const byHash = new Map<string, string>();
  for (const h of hints) {
    const k = sourceKey(h);
    if (k) for (const hsh of sourceHashes(k)) byHash.set(hsh, k);
  }
  if (!byHash.size) return out;
  try {
    const rows = await qRaw<{ source_hash: string; art_id: string | null; checked_at: Date | string; w: number | null; h: number | null; tone: string | null }>(
      `SELECT s.source_hash, s.art_id, s.checked_at, a.w, a.h, a.tone FROM art_sources s LEFT JOIN art a ON a.id = s.art_id WHERE s.source_hash = ANY($1::text[])`,
      [[...byHash.keys()]],
    );
    const now = artDeps.now();
    for (const r of rows) {
      const k = byHash.get(r.source_hash)!;
      if (r.art_id && r.w && r.h) out.set(k, { id: r.art_id, w: r.w, h: r.h, ...(r.tone ? { tone: r.tone } : {}) });
      else if (!out.get(k) && now - new Date(r.checked_at).getTime() <= MISS_RETRY_MS) out.set(k, null);
    }
  } catch {
    // No art yet is no reason to fail the page.
  }
  return out;
}

// ---------- Watch & read (lib/memory.ts reading items) ----------

/** Watch & read's kinds, as day-entry kinds: only the ones with artwork. */
const READING_AS_ENTRY: Record<string, { kind: string; type?: "film" | "show" }> = {
  book: { kind: "read" },
  paper: { kind: "read" },
  film: { kind: "watched", type: "film" },
  tv: { kind: "watched", type: "show" },
  game: { kind: "played" },
  // An album, a song or a podcast with a Spotify link: its cover from Spotify's oEmbed.
  music: { kind: "listened" },
  podcast: { kind: "listened" },
};

/**
 * Art onto Watch & read items (GET /api/reading). An item whose link is a
 * YouTube video gets the video's thumbnail, whatever its kind; the rest go by
 * kind, as day entries do. Items with no source of art come back as they were.
 */
export async function readingArt<R extends { id: string; title: string; kind: string; author: string; url: string; source?: string | null; art?: ArtRef }>(items: R[], opts: ArtOptions = {}): Promise<R[]> {
  const todo = items
    .map((entry, i) => {
      const hints: ArtHint[] = [];
      const video = youtubeId(entry.url);
      if (video) hints.push({ youtube: video });
      const m = READING_AS_ENTRY[entry.kind];
      if (m && !video) hints.push(...dayEntryHints({ id: entry.id, kind: m.kind, source: entry.source ?? "manual", title: entry.title, subtitle: entry.author || undefined, url: entry.url || undefined }, m.type ? { type: m.type } : {}));
      return { i, entry, hints: entry.art ? [] : hints };
    })
    .filter((x) => x.hints.length);
  if (!todo.length) return items;
  const done = await attachArt(todo, opts);
  const out = [...items];
  todo.forEach((x, k) => (out[x.i] = done[k]));
  return out;
}

// ---------- The art finder (lib/days.ts on claude/days-data writes and lists through these) ----------

/**
 * What the finder needs from the Days store. lib/days.ts on claude/days-data
 * has both: `entriesWithoutArt(limit)` and `setEntryArt(id, art)`. Passed in,
 * so this file doesn't import the Days branch:
 *
 *   import { entriesWithoutArt, setEntryArt } from "./days";
 *   await fillDayArt({ entriesWithoutArt, setEntryArt }, { budgetMs: 8000, waitUntil });
 */
export interface DayArtStore {
  entriesWithoutArt(limit: number): Promise<Array<DayEntryLike & { date?: string }>>;
  setEntryArt(entryId: string, art: ArtRef | null): Promise<void>;
}

export interface FillResult {
  /** Entries without art that were looked at. */
  looked: number;
  /** Of those, the ones art could come from (the rest: posts, saves, no link or title to go on). */
  eligible: number;
  /** Art found and written this time. */
  found: number;
}

/**
 * Work through entries without art, newest days first: find art for those
 * that can have it and write it back. Sources already checked cost one query,
 * not a request, so running it often is cheap. Never throws.
 */
export async function fillDayArt(store: DayArtStore, opts: ArtOptions & { limit?: number } = {}): Promise<FillResult> {
  try {
    const rows = await store.entriesWithoutArt(opts.limit ?? 400);
    const eligible = rows.filter((r) => dayEntryHints(r).length);
    if (!eligible.length) return { looked: rows.length, eligible: 0, found: 0 };
    const done = await attachDayArt(eligible, {}, opts);
    let found = 0;
    for (const e of done) {
      if (!e.art) continue;
      await store.setEntryArt(e.id, e.art);
      found++;
    }
    return { looked: rows.length, eligible: eligible.length, found };
  } catch (error) {
    console.error("Athena art: fillDayArt failed", (error as Error)?.message);
    return { looked: 0, eligible: 0, found: 0 };
  }
}
