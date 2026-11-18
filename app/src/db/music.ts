/**
 * Music for the app (GET /api/life/music, lib/music-data.ts on the server):
 * one period's page, or one artist. Nothing is stored on the device; the
 * last answers are held in memory for a minute, so the Library's line and
 * the page share one request. Sample mode answers from db/sample-music.ts
 * with the same rules (lib/music.ts).
 */

import { isSampleMode, request } from "./api";
import type { ArtistDetail, MusicData } from "../../../lib/music";
import type { PlaylistsView, StoredPlaylist } from "../../../lib/playlists";

export type { ArtistDetail, MusicAlbum, MusicArtist, MusicData, MusicDay, MusicPoint } from "../../../lib/music";

const HOLD_MS = 60_000;
const held = new Map<string, { at: number; value: Promise<unknown> }>();

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  const h = held.get(key);
  if (h && Date.now() - h.at < HOLD_MS) return h.value as Promise<T>;
  const value = load();
  held.set(key, { at: Date.now(), value });
  value.catch(() => held.delete(key));
  return value;
}

export function loadMusic(period: string): Promise<MusicData> {
  return once(`p:${period}`, async () => (isSampleMode() ? (await import("./sample-music")).sampleMusic(period) : request<MusicData>(`/life/music?period=${encodeURIComponent(period)}`)));
}

/** One artist over everything held; null when Athena has no plays for them. */
export function loadArtist(name: string): Promise<ArtistDetail | null> {
  return once(`a:${name.toLowerCase()}`, async () => {
    if (isSampleMode()) return (await import("./sample-music")).sampleArtist(name);
    try {
      return await request<ArtistDetail>(`/life/music?artist=${encodeURIComponent(name)}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  });
}

// ---------- Playlists (not tied to a period) ----------

export type { PlaylistsView, PlaylistSummary } from "../../../lib/playlists";
export type PlaylistDetail = StoredPlaylist & { source: string; updated: string };

export function loadPlaylists(): Promise<PlaylistsView> {
  return once("playlists", async () => (isSampleMode() ? (await import("./sample-music")).samplePlaylists() : request<PlaylistsView>("/life/music?playlists=1")));
}

export function loadPlaylist(id: string): Promise<PlaylistDetail | null> {
  return once(`pl:${id}`, async () => {
    if (isSampleMode()) return (await import("./sample-music")).samplePlaylist(id);
    try {
      return await request<PlaylistDetail>(`/life/music?playlist=${encodeURIComponent(id)}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  });
}
