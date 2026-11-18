/**
 * Playlists on Music (#/music): the owner's playlists from Spotify, read by
 * Athena's own daily sync (netlify/lib/connectors/playlist-sync.ts) and kept
 * in one sealed settings row (lib/playlist-store.ts). Not tied to the period
 * switch: the section says when they were read. Pure.
 */

export const PLAYLIST_SOURCES = ["spotify"] as const;
export type PlaylistSource = (typeof PLAYLIST_SOURCES)[number];

/** Kept per playlist: the first this many tracks, and every artist counted. */
export const MAX_KEPT_TRACKS = 100;
/** Playlists kept per source, the owner's own first. */
export const MAX_PLAYLISTS = 60;

export interface PlaylistTrack {
  track: string;
  artist?: string;
  album?: string;
  link?: string;
}

export interface StoredPlaylist {
  id: string;
  name: string;
  /** Who made it, when it isn't the owner. */
  owner?: string;
  mine: boolean;
  tracks: number;
  link?: string;
  /** Spotify's snapshot id: unchanged means the tracks needn't be read again. */
  version?: string;
  /** The first tracks, in order; absent when Spotify doesn't share them (a followed playlist). */
  items?: PlaylistTrack[];
  /** Artists across every track read, most first, at most 8. */
  top_artists?: Array<{ name: string; tracks: number }>;
}

export interface SourcePlaylists {
  source: PlaylistSource;
  /** When they were last read. */
  updated: string;
  /** The sign-in predates the playlist scopes: "Sign in again". */
  needs_sign_in?: boolean;
  playlists: StoredPlaylist[];
}

/** The list the page shows: no tracks, just enough for the grid. */
export interface PlaylistSummary {
  id: string;
  source: PlaylistSource;
  name: string;
  owner?: string;
  tracks: number;
}

export interface PlaylistsView {
  /** Most recent read across sources, or null when never read. */
  updated: string | null;
  needs_sign_in: boolean;
  playlists: PlaylistSummary[];
}

export function playlistsView(all: SourcePlaylists[]): PlaylistsView {
  const updated = all.map((s) => s.updated).sort().pop() ?? null;
  return {
    updated,
    needs_sign_in: all.some((s) => s.needs_sign_in),
    playlists: all.flatMap((s) => s.playlists.map((p) => ({ id: p.id, source: s.source, name: p.name, ...(p.owner && !p.mine ? { owner: p.owner } : {}), tracks: p.tracks }))),
  };
}

/** Artists by how many of the tracks they're on (a track by two artists counts for both), most first. */
export function topArtistsOf(tracks: PlaylistTrack[], n = 8): Array<{ name: string; tracks: number }> {
  const m = new Map<string, { name: string; tracks: number }>();
  for (const t of tracks)
    for (const name of (t.artist ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const k = name.toLowerCase();
      const a = m.get(k) ?? { name, tracks: 0 };
      a.tracks++;
      m.set(k, a);
    }
  return [...m.values()].sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name)).slice(0, n);
}

/** The owner's own first, then most tracks; at most MAX_PLAYLISTS. */
export const orderPlaylists = <T extends StoredPlaylist>(ps: T[]): T[] => [...ps].sort((a, b) => Number(b.mine) - Number(a.mine) || b.tracks - a.tracks || a.name.localeCompare(b.name)).slice(0, MAX_PLAYLISTS);
