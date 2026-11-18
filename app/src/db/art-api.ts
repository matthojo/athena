/**
 * Artwork, day maps and Settings → Maps and artwork, over the API
 * (netlify/lib/days-art/routes.ts). Images come through the token like
 * files do, and are kept in Cache Storage so they open offline. The browser
 * never asks MapTiler, Stadia, TMDB or anyone else for an image.
 */
import { ApiError, getToken, isSampleMode, request } from "./api";

export type TileProvider = "maptiler" | "stadia";
export type KeyStatus = "working" | "rejected";

export interface MapsArtStatus {
  tiles: { provider: TileProvider; status: KeyStatus; added_at: string } | null;
  tmdb: { status: KeyStatus; added_at: string } | null;
  setup: { encryption: boolean };
  art_count: number;
  /** Only straight after adding or testing a key: what it looks like. */
  preview?: { light?: string; dark?: string; poster?: string };
}

export const PROVIDER_INFO: Record<TileProvider, { label: string; keysUrl: string; signUp: string }> = {
  maptiler: { label: "MapTiler", keysUrl: "https://cloud.maptiler.com/account/keys/", signUp: "https://cloud.maptiler.com/auth/widget?next=https://cloud.maptiler.com/account/keys/&mode=signup" },
  stadia: { label: "Stadia Maps", keysUrl: "https://client.stadiamaps.com/dashboard/", signUp: "https://client.stadiamaps.com/signup/" },
};
export const TMDB_KEYS_URL = "https://www.themoviedb.org/settings/api";

const SAMPLE_STATUS: MapsArtStatus = { tiles: null, tmdb: null, setup: { encryption: true }, art_count: 0 };

export async function fetchMapsArt(): Promise<MapsArtStatus> {
  if (isSampleMode()) return SAMPLE_STATUS;
  return request<MapsArtStatus>("/maps-art");
}

export const addTileKey = (provider: TileProvider, key: string) => request<MapsArtStatus>("/maps-art/tiles", { method: "POST", body: JSON.stringify({ provider, key }) });
export const testTileKey = () => request<MapsArtStatus>("/maps-art/tiles/test", { method: "POST" });
export const removeTileKey = () => request<MapsArtStatus>("/maps-art/tiles", { method: "DELETE" });
export const addTmdbKey = (key: string) => request<MapsArtStatus>("/maps-art/tmdb", { method: "POST", body: JSON.stringify({ key }) });
export const testTmdbKey = () => request<MapsArtStatus>("/maps-art/tmdb/test", { method: "POST" });
export const removeTmdbKey = () => request<MapsArtStatus>("/maps-art/tmdb", { method: "DELETE" });

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`/api${path}`, { ...init, headers });
}

/** Settings' saved sample (a map in one theme, or a poster), or null. */
export async function fetchSample(which: "light" | "dark" | "poster"): Promise<Blob | null> {
  if (isSampleMode()) return null;
  const res = await authed(`/maps-art/preview/${which}`);
  return res.ok ? res.blob() : null;
}

// ---------- Art ----------

/** An art image's bytes (the browser's own cache keeps it for a year). */
export async function fetchArtBlob(id: string, size: "sm" | "lg"): Promise<Blob> {
  const res = await authed(`/art/${encodeURIComponent(id)}?size=${size}`);
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  return res.blob();
}

// ---------- Day maps ----------

export type DayMapState = "ready" | "no_key" | "key_rejected" | "no_places" | "unavailable" | "offline";

export interface DayMapResult {
  state: DayMapState;
  blob?: Blob;
  /** Markers on the map. */
  stops?: number;
  attribution?: string;
  provider?: TileProvider;
}

/** The attribution comes percent-encoded (headers are Latin-1). */
export function decodeHeader(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A day's map, or why there isn't one. */
export async function fetchDayMap(date: string, theme: "light" | "dark", size: "card" | "full" | "tall"): Promise<DayMapResult> {
  const res = await authed(`/days/${encodeURIComponent(date)}/map?${new URLSearchParams({ theme, size })}`);
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  if ((res.headers.get("content-type") ?? "").startsWith("image/")) {
    return {
      state: "ready",
      blob: await res.blob(),
      stops: Number(res.headers.get("x-map-stops")) || undefined,
      attribution: decodeHeader(res.headers.get("x-map-attribution")),
    };
  }
  const body = (await res.json()) as { state?: DayMapState; provider?: TileProvider };
  return { state: body.state ?? "unavailable", provider: body.provider };
}
