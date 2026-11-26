/**
 * Embeds for rich links: which pasted addresses
 * have a player, and the player's official embed address. Pure and shared
 * with the app: no network, no DOM, no imports.
 *
 * Nine providers, the owner's list: YouTube, Vimeo, Loom, Spotify, Apple
 * Music, Google Maps, Apple Maps, Figma and Framer. Anything else isn't
 * embeddable and shows as a Card or a Link.
 *
 * Rules:
 *  - Only an address is ever read, never pasted HTML. Text holding "<" (an
 *    `<iframe>` snippet) is refused outright, so nothing a page or a person
 *    pastes is ever put into a note as markup.
 *  - The embed address is built here from the ids in the address, on the
 *    provider's own embed host (youtube-nocookie.com for YouTube). Query
 *    strings from the paste are never carried over, except the few that
 *    choose what plays (a start time, a Vimeo privacy hash, an Apple Music
 *    track, a Figma node).
 *  - Hosts match exactly or as a subdomain at a dot: "youtube.com.example"
 *    isn't YouTube.
 *  - Maps never get a player. Apple Maps has none, and Google Maps gets
 *    none either, so nothing loads from Google in a note: both have
 *    a null embedUrl. The app shows Athena's own still of the spot (GET
 *    /api/link-map), and "Open map" opens the maps app the owner picked for
 *    this device in Settings (mapAppUrl).
 */

export const EMBED_PROVIDERS = ["youtube", "vimeo", "loom", "spotify", "apple-music", "google-maps", "apple-maps", "figma", "framer"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** What the player is, for its still and its button: Play (video), Listen (audio), Open map, Open file or Open site (canvas). */
export type EmbedKind = "video" | "audio" | "map" | "canvas";

export interface Embed {
  provider: EmbedProvider;
  kind: EmbedKind;
  /** The player's address (https, on the provider's embed host), or null for a map: Athena's still and "Open map" instead (Google Maps and Apple Maps). */
  embedUrl: string | null;
  /** Width over height (16/9 for a video). Null for a fixed-height player: see `height`. */
  aspect: number | null;
  /** CSS pixels, for players that are a fixed-height row (Spotify, Apple Music). */
  height?: number;
  /** A title read from the address itself (a Maps place, an Apple Music album), when there is one. */
  title?: string;
  /** The address to open in the provider's own app or site: the paste, tidied to https. */
  openUrl: string;
  /** Coordinates read from a map address, for Athena's still. */
  at?: { lat: number; lng: number };
  /** The iframe's `allow` list: only what this player needs. */
  allow: string;
}

/** Display names, for "Tap to load from {Provider}" and "Open in {Provider}". */
export const PROVIDER_NAMES: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  loom: "Loom",
  spotify: "Spotify",
  "apple-music": "Apple Music",
  "google-maps": "Google Maps",
  "apple-maps": "Apple Maps",
  figma: "Figma",
  framer: "Framer",
};

/** Every host a player loads from: the CSP `frame-src` allowlist in netlify.toml. */
export const EMBED_FRAME_HOSTS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://open.spotify.com",
  "https://embed.music.apple.com",
  "https://embed.figma.com",
  "https://*.framer.website",
  "https://*.framer.app",
] as const;

const VIDEO_ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture";
const AUDIO_ALLOW = "autoplay; encrypted-media; fullscreen";
const MAX_URL = 2048;

/** The pasted address as a URL, or null: https or http only, no credentials, no markup. */
function readUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL || /[<>\s"]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return null;
  u.protocol = "https:";
  u.port = "";
  return u;
}

/** host is `domain` or a subdomain of it, at a dot. */
const on = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const words = (slug: string | undefined) => {
  if (!slug) return undefined;
  let s: string;
  try {
    s = decodeURIComponent(slug);
  } catch {
    s = slug;
  }
  s = s.replace(/[+_]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return s && s.length <= 200 ? s : undefined;
};

/** "1h2m3s", "90", "90s" or "1:30" as whole seconds, or undefined. */
export function startSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^\d+s?$/.test(t)) return Number(t.replace("s", "")) || undefined;
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0) || undefined;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) || undefined;
  return undefined;
}

// ---------- providers ----------

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/;

function youtube(u: URL, host: string): Embed | null {
  if (!(on(host, "youtube.com") || host === "youtu.be" || on(host, "youtube-nocookie.com"))) return null;
  if (host === "music.youtube.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let shorts = false;
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch") id = u.searchParams.get("v") ?? undefined;
  else if (["embed", "shorts", "live", "v", "e"].includes(parts[0])) {
    id = parts[1];
    shorts = parts[0] === "shorts";
  }
  const list = u.searchParams.get("list");
  const openUrl = u.toString();
  if (id && YT_ID.test(id)) {
    const start = startSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));
    const q = start ? `?start=${start}` : "";
    return { provider: "youtube", kind: "video", embedUrl: `https://www.youtube-nocookie.com/embed/${id}${q}`, aspect: shorts ? 9 / 16 : 16 / 9, openUrl, allow: VIDEO_ALLOW };
  }
  if ((parts[0] === "playlist" || (parts[0] === "embed" && parts[1] === "videoseries")) && list && YT_LIST.test(list)) {
    return { provider: "youtube", kind: "video", embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`, aspect: 16 / 9, openUrl, allow: VIDEO_ALLOW };
  }
  return null;
}

function vimeo(u: URL, host: string): Embed | null {
  if (!on(host, "vimeo.com")) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let hash: string | undefined;
  if (host === "player.vimeo.com") {
    if (parts[0] !== "video") return null;
    id = parts[1];
    hash = u.searchParams.get("h") ?? undefined;
  } else {
    // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, vimeo.com/groups/x/videos/123, vimeo.com/showcase/x/video/123
    const at = parts.findIndex((p) => /^\d{5,12}$/.test(p));
    if (at < 0) return null;
    id = parts[at];
    const next = parts[at + 1];
    if (next && /^[0-9a-f]{6,20}$/i.test(next)) hash = next;
    hash ??= u.searchParams.get("h") ?? undefined;
  }
  if (!id || !/^\d{5,12}$/.test(id)) return null;
  const h = hash && /^[0-9a-f]{6,20}$/i.test(hash) ? `?h=${hash}` : "";
  return { provider: "vimeo", kind: "video", embedUrl: `https://player.vimeo.com/video/${id}${h}`, aspect: 16 / 9, openUrl: u.toString(), allow: VIDEO_ALLOW };
}

function loom(u: URL, host: string): Embed | null {
  if (!on(host, "loom.com")) return null;
  const [kind, id] = u.pathname.split("/").filter(Boolean);
  if ((kind !== "share" && kind !== "embed") || !id || !/^[0-9a-f]{32}$/i.test(id)) return null;
  return { provider: "loom", kind: "video", embedUrl: `https://www.loom.com/embed/${id.toLowerCase()}`, aspect: 16 / 9, openUrl: u.toString(), allow: VIDEO_ALLOW };
}

const SPOTIFY_TYPES = ["track", "album", "playlist", "episode", "show", "artist"];

function spotify(u: URL, host: string): Embed | null {
  if (host !== "open.spotify.com") return null;
  let parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "embed") parts = parts.slice(1);
  if (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0] ?? "")) parts = parts.slice(1);
  const [type, id] = parts;
  if (!SPOTIFY_TYPES.includes(type) || !id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  const compact = type === "track" || type === "episode";
  return { provider: "spotify", kind: "audio", embedUrl: `https://open.spotify.com/embed/${type}/${id}`, aspect: null, height: compact ? 152 : 352, openUrl: `https://open.spotify.com/${type}/${id}`, allow: AUDIO_ALLOW };
}

const APPLE_MUSIC_TYPES = ["album", "playlist", "song", "music-video", "station"];

function appleMusic(u: URL, host: string): Embed | null {
  if (host !== "music.apple.com" && host !== "embed.music.apple.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const [cc, type, ...rest] = parts;
  if (!/^[a-z]{2}$/i.test(cc ?? "") || !APPLE_MUSIC_TYPES.includes(type)) return null;
  const id = rest[rest.length - 1];
  const slug = rest.length > 1 ? rest[0] : undefined;
  if (!id || !/^(\d{1,15}|pl\.[A-Za-z0-9-]{8,64}|ra\.[A-Za-z0-9.-]{4,64})$/.test(id)) return null;
  if (slug && !/^[^/?#]{1,200}$/.test(slug)) return null;
  const track = u.searchParams.get("i");
  const i = track && /^\d{1,15}$/.test(track) ? `?i=${track}` : "";
  const path = `${cc.toLowerCase()}/${type}/${slug ? `${encodeURIComponent(decodeSafe(slug))}/` : ""}${id}`;
  const single = type === "song" || !!i;
  return {
    provider: "apple-music",
    kind: type === "music-video" ? "video" : "audio",
    embedUrl: `https://embed.music.apple.com/${path}${i}`,
    aspect: type === "music-video" ? 16 / 9 : null,
    ...(type === "music-video" ? {} : { height: single ? 175 : 450 }),
    ...(words(slug) ? { title: words(slug) } : {}),
    openUrl: `https://music.apple.com/${path}${i}`,
    allow: AUDIO_ALLOW,
  };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function latLng(lat: string | number | undefined, lng: string | number | undefined): { lat: number; lng: number } | undefined {
  const a = Number(lat);
  const b = Number(lng);
  if (lat === undefined || lng === undefined || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return undefined;
  if (a === 0 && b === 0) return undefined;
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}

const PAIR = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Coordinates and a place name from a Google Maps address, when it has them. */
function googleSpot(u: URL): { at?: { lat: number; lng: number }; name?: string; q?: string } {
  const out: { at?: { lat: number; lng: number }; name?: string; q?: string } = {};
  // A dropped pin's exact spot: …!3d51.5!4d-0.12
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(u.pathname + u.search);
  const view = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u.pathname);
  const query = u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("ll") ?? u.searchParams.get("center") ?? u.searchParams.get("destination");
  const pair = query ? PAIR.exec(query) : null;
  out.at = latLng(pin?.[1], pin?.[2]) ?? latLng(pair?.[1], pair?.[2]) ?? latLng(view?.[1], view?.[2]);
  const place = /\/maps\/place\/([^/@]+)/.exec(u.pathname)?.[1];
  out.name = words(place);
  if (query && !pair) out.q = query.trim().slice(0, 200);
  out.name ??= out.q;
  return out;
}

function googleMaps(u: URL, host: string): Embed | null {
  const isMaps = /^(www\.|maps\.)?google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host) && (host.startsWith("maps.") || u.pathname === "/maps" || u.pathname.startsWith("/maps/"));
  if (!isMaps) return null;
  const openUrl = u.toString();
  // Google's own "Embed a map" address, pasted as an address (never as HTML): only its spot is read.
  if (u.pathname === "/maps/embed" && host === "www.google.com") {
    const pb = u.searchParams.get("pb");
    if (!pb || !/^[A-Za-z0-9!._%:-]{1,1500}$/.test(pb)) return null;
    const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(pb) ?? /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/.exec(pb);
    const at = pin ? (pin[0].startsWith("!2d") ? latLng(pin[2], pin[1]) : latLng(pin[1], pin[2])) : undefined;
    return { provider: "google-maps", kind: "map", embedUrl: null, aspect: 4 / 3, openUrl, ...(at ? { at } : {}), allow: "" };
  }
  const spot = googleSpot(u);
  if (!spot.at && !spot.q) return null;
  // Like Apple Maps: no player, so nothing loads from Google in a note.
  return {
    provider: "google-maps",
    kind: "map",
    embedUrl: null,
    aspect: 4 / 3,
    ...(spot.name ? { title: spot.name } : {}),
    openUrl,
    ...(spot.at ? { at: spot.at } : {}),
    allow: "",
  };
}

function appleMaps(u: URL, host: string): Embed | null {
  if (host !== "maps.apple.com" && host !== "maps.apple") return null;
  const p = u.searchParams;
  const pair = (k: string) => {
    const m = PAIR.exec(p.get(k) ?? "");
    return m ? latLng(m[1], m[2]) : undefined;
  };
  const at = pair("ll") ?? pair("coordinate") ?? pair("sll") ?? pair("q") ?? pair("daddr") ?? latLng(p.get("latitude") ?? undefined, p.get("longitude") ?? undefined);
  const name = words(p.get("q") && !PAIR.test(p.get("q")!) ? p.get("q")! : (p.get("name") ?? p.get("address") ?? undefined));
  if (!at && !name) return null;
  return { provider: "apple-maps", kind: "map", embedUrl: null, aspect: 4 / 3, ...(name ? { title: name } : {}), openUrl: u.toString(), ...(at ? { at } : {}), allow: "" };
}

const FIGMA_TYPES: Record<string, string> = { file: "design", design: "design", proto: "proto", board: "board", slides: "slides", deck: "slides" };

function figma(u: URL, host: string): Embed | null {
  if (host !== "figma.com" && host !== "www.figma.com" && host !== "embed.figma.com") return null;
  const [type, key, slug] = u.pathname.split("/").filter(Boolean);
  const kind = FIGMA_TYPES[type];
  if (!kind || !key || !/^[A-Za-z0-9]{10,64}$/.test(key)) return null;
  const params = new URLSearchParams();
  const node = u.searchParams.get("node-id");
  if (node && /^[0-9]+[-:][0-9]+$/.test(node)) params.set("node-id", node);
  params.set("embed-host", "athena");
  const name = words(slug);
  return {
    provider: "figma",
    kind: "canvas",
    embedUrl: `https://embed.figma.com/${kind}/${key}${slug ? `/${encodeURIComponent(decodeSafe(slug))}` : ""}?${params}`,
    aspect: 16 / 9,
    ...(name ? { title: name } : {}),
    openUrl: `https://www.figma.com/${kind}/${key}${slug ? `/${encodeURIComponent(decodeSafe(slug))}` : ""}${node && params.has("node-id") ? `?node-id=${node}` : ""}`,
    allow: "fullscreen; clipboard-write",
  };
}

/** A published Framer site (name.framer.website, name.framer.app). The editor and custom domains aren't recognised. */
function framer(u: URL, host: string): Embed | null {
  const m = /^([a-z0-9][a-z0-9-]{0,62})\.framer\.(website|app)$/.exec(host);
  if (!m) return null;
  const path = u.pathname.replace(/\/+$/, "");
  const embedUrl = `https://${host}${path}`;
  return { provider: "framer", kind: "canvas", embedUrl, aspect: 16 / 10, openUrl: embedUrl || `https://${host}/`, allow: "fullscreen" };
}

const READERS = [youtube, vimeo, loom, spotify, appleMusic, googleMaps, appleMaps, figma, framer];

/**
 * A pasted address's player, or null when it hasn't one. Takes the address
 * only: pasted HTML (an `<iframe>` snippet) is refused, never parsed.
 */
export function embedFor(raw: unknown): Embed | null {
  const u = readUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  for (const read of READERS) {
    const e = read(u, host);
    if (e) return e;
  }
  return null;
}

/** Whether a pasted address has a player (the switcher's Embed option). */
export function isEmbeddable(raw: unknown): boolean {
  return embedFor(raw) !== null;
}

/** Coordinates in a Google Maps or Apple Maps address, for Athena's still of it. Null for anything else. */
export function mapCoordinates(raw: unknown): { lat: number; lng: number } | null {
  const e = embedFor(raw);
  return e?.kind === "map" && e.at ? e.at : null;
}

// ---------- Opening a spot in the owner's maps app ----------

/** What kind of device this is, from its user agent: Apple (iPhone, iPad, Mac), Android, or another computer. */
export type MapPlatform = "apple" | "android" | "web";

/** The platform from a user agent string (navigator.userAgent). */
export function mapPlatform(userAgent: string | null | undefined): MapPlatform {
  const ua = userAgent ?? "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(ua)) return "apple";
  return "web";
}

/** The maps apps "Open map" can open, picked per device in Settings → Maps and artwork. */
export const MAP_APPS = ["apple", "google", "osm"] as const;
export type MapApp = (typeof MAP_APPS)[number];

export const isMapApp = (v: unknown): v is MapApp => typeof v === "string" && (MAP_APPS as readonly string[]).includes(v);

/** Before the owner picks: Apple Maps on an iPhone, iPad or Mac, OpenStreetMap anywhere else. */
export const defaultMapApp = (platform: MapPlatform): MapApp => (platform === "apple" ? "apple" : "osm");

/**
 * A link that opens a spot (or, without coordinates, a search) in the maps
 * app the owner picked: Athena's still is the map in the note, and "Open map"
 * leaves for that app. Nothing here loads inside a note. Null with nothing to show.
 *   apple:  maps://?ll=lat,lng&q=label on an Apple device (the Maps app),
 *           https://maps.apple.com/?ll=…&q=… anywhere else (Apple Maps on the web)
 *   google: https://www.google.com/maps/search/?api=1&query=… (the app on a phone that has it)
 *   osm:    https://www.openstreetmap.org/?mlat=…&mlon=… or /search?query=…
 */
export function mapAppUrl(spot: { at?: { lat: number; lng: number } | null; query?: string | null }, app: MapApp, platform: MapPlatform = "web"): string | null {
  const at = spot.at && Number.isFinite(spot.at.lat) && Number.isFinite(spot.at.lng) && Math.abs(spot.at.lat) <= 90 && Math.abs(spot.at.lng) <= 180 ? spot.at : null;
  const query = (spot.query ?? "").replace(/[\u0000-\u001f()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  if (!at && !query) return null;
  const ll = at ? `${at.lat},${at.lng}` : null;
  if (app === "apple") {
    const p = new URLSearchParams();
    if (ll) p.set("ll", ll);
    if (query) p.set("q", query);
    return platform === "apple" ? `maps://?${p}` : `https://maps.apple.com/?${p}`;
  }
  if (app === "google") return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: ll ?? query! })}`;
  if (at) return `https://www.openstreetmap.org/?${new URLSearchParams({ mlat: String(at.lat), mlon: String(at.lng) })}#map=17/${at.lat}/${at.lng}`;
  return `https://www.openstreetmap.org/search?${new URLSearchParams({ query: query! })}`;
}
