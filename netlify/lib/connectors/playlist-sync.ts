/**
 * Playlists for Music, read by Athena itself (no model): the owner's
 * Spotify playlists and, for the ones they made or collaborate on, their
 * tracks (the first MAX_KEPT_TRACKS kept; artists counted over every track
 * read). Run by the Life log beside the places and money syncs, and by
 * "Load history again" on a Spotify account. Stored sealed in one settings
 * row (lib/playlist-store.ts). A playlist whose Spotify version is unchanged
 * keeps the tracks read before, so a daily read is mostly one call.
 *
 * A sign-in from before the playlist scopes gets a 403: saved as "sign in
 * again" (the page and the account say so), never an account error.
 */
import { callTool, type OpenConnector } from "./mcp-client";
import { PLAYLISTS_NEED_SIGN_IN } from "./spotify-direct";
import { loadPlaylists, markPlaylistsNeedSignIn, savePlaylists } from "../../../lib/playlist-store";
import { MAX_KEPT_TRACKS, orderPlaylists, topArtistsOf, type PlaylistTrack, type StoredPlaylist } from "../../../lib/playlists";

const MAX_LIST_PAGES = 4;
const MAX_TRACK_PAGES = 10;

type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

interface Page<T> {
  items?: T[];
  next_cursor?: string;
}

const parse = <T>(text: string): Page<T> => {
  try {
    return JSON.parse(text) as Page<T>;
  } catch {
    return {};
  }
};

class NeedsSignIn extends Error {}

async function pages<T>(call: Call, tool: string, args: Record<string, unknown>, max: number, deadline: number): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const r = await call(tool, { ...args, limit: 50, ...(cursor ? { cursor } : {}) });
    if (r.isError) {
      if (r.text.includes(PLAYLISTS_NEED_SIGN_IN)) throw new NeedsSignIn();
      throw new Error(r.text.slice(0, 200));
    }
    const page = parse<T>(r.text);
    items.push(...(page.items ?? []));
    cursor = page.next_cursor;
    if (!cursor) return { items, complete: true };
    if (Date.now() > deadline) break;
  }
  return { items, complete: !cursor };
}

interface Row {
  id?: string;
  playlist?: string;
  owner?: string;
  mine?: boolean;
  collaborative?: boolean;
  tracks?: number;
  version?: string;
  link?: string;
}

/**
 * Read one Spotify account's playlists through its tools (no store): the
 * list paged, then tracks for those the owner made or collaborates on,
 * reusing `before`'s tracks for a playlist whose version hasn't changed.
 * "needs_sign_in" when the sign-in lacks the playlist scopes.
 */
export async function collectSpotifyPlaylists(call: Call, before: Map<string, StoredPlaylist>, deadline: number): Promise<{ playlists: StoredPlaylist[]; read: number } | "needs_sign_in"> {
  let rows: Row[];
  try {
    rows = (await pages<Row>(call, "list_playlists", {}, MAX_LIST_PAGES, deadline)).items;
  } catch (error) {
    if (error instanceof NeedsSignIn) return "needs_sign_in";
    throw error;
  }
  const kept = orderPlaylists(
    rows
      .filter((r): r is Row & { id: string; playlist: string } => !!r.id && !!r.playlist)
      .map((r) => ({ id: r.id, name: r.playlist, ...(r.owner ? { owner: r.owner } : {}), mine: r.mine === true, tracks: r.tracks ?? 0, ...(r.link ? { link: r.link } : {}), ...(r.version ? { version: r.version } : {}), collaborative: r.collaborative })),
  );
  let read = 0;
  const playlists: StoredPlaylist[] = [];
  for (const p of kept) {
    const { collaborative, ...base } = p;
    const old = before.get(p.id);
    // Unchanged since the last read: keep its tracks.
    if (old?.items && old.version && old.version === p.version) {
      playlists.push({ ...base, items: old.items, top_artists: old.top_artists });
      continue;
    }
    // Spotify only shares the tracks of playlists the owner made or collaborates on.
    if ((!p.mine && !collaborative) || !p.tracks || Date.now() > deadline) {
      playlists.push(old?.items ? { ...base, items: old.items, top_artists: old.top_artists } : base);
      continue;
    }
    try {
      const { items } = await pages<PlaylistTrack>(call, "list_playlist_tracks", { playlist_id: p.id }, MAX_TRACK_PAGES, deadline);
      const tracks = items.filter((t) => t.track).map((t) => ({ track: t.track, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}), ...(t.link ? { link: t.link } : {}) }));
      playlists.push({ ...base, items: tracks.slice(0, MAX_KEPT_TRACKS), top_artists: topArtistsOf(tracks) });
      read++;
    } catch {
      playlists.push(base);
    }
  }
  return { playlists, read };
}

/** One Spotify account's playlists, read and saved. Returns a line for the run's summary. */
export async function readSpotifyPlaylists(call: Call, now: Date, budgetMs = 20_000): Promise<string> {
  const before = new Map(((await loadPlaylists()).find((s) => s.source === "spotify")?.playlists ?? []).map((p) => [p.id, p]));
  const got = await collectSpotifyPlaylists(call, before, Date.now() + budgetMs);
  if (got === "needs_sign_in") {
    await markPlaylistsNeedSignIn("spotify", now);
    return "Spotify playlists: sign in again to let Athena read them.";
  }
  await savePlaylists({ source: "spotify", updated: now.toISOString(), playlists: got.playlists });
  return `Spotify playlists: ${got.playlists.length} (${got.read} read again).`;
}

/** Every open Spotify account in the run. Never throws: a line for the summary, or "". */
export async function syncPlaylists(opened: OpenConnector[], ctx: { now: Date; budgetMs?: number }): Promise<string> {
  const said: string[] = [];
  for (const open of opened.filter((o) => o.connector.provider === "spotify" && o.direct)) {
    try {
      said.push(await readSpotifyPlaylists((name, args) => callTool(open, name, args), ctx.now, ctx.budgetMs));
    } catch (error) {
      said.push(`Spotify playlists couldn't be read: ${error instanceof Error ? error.message : "unknown problem"}.`);
    }
  }
  return said.join(" ");
}
