/**
 * History on connect for the accounts whose read tools already page back
 * through everything (backfill.ts): Last.fm, ListenBrainz, Spotify's saved
 * songs and albums, Plex, Jellyfin, Letterboxd, Raindrop.io and Eventbrite. The stream calls the account's own
 * tool with no date window, follows its next_cursor or next_page_token, and
 * maps the JSON it gives to Day entries and Watch & read, the way the Life
 * log recipe describes them (recipes.ts). Same requests, same read-only
 * allowlist, as a collection run; no model.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import type { EntryInput } from "../../../lib/days";
import { addPlay, emptyHours, hourOf } from "../../../lib/day-hours";
import { albumDayId } from "../../../lib/day-imports";
import { titleKey, type WatchReadInput } from "../../../lib/watch-read-sync";
import type { BackfillPage, BackfillStream, HistoryBackfill } from "./backfill";
import type { DirectAccount } from "./direct";

type Row = Record<string, unknown>;
type Mapped = Pick<BackfillPage, "entries" | "watchRead">;

export interface ToolSpec {
  /** The account's tool, and what to pass besides the cursor. */
  tool: string;
  args?: Record<string, unknown>;
  /** Where the rows are in its answer ("items", "films"). */
  list: string;
  map(rows: Row[], tz: string): Mapped;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One tool as a stream. The cursor is the tool's own next_cursor or next_page_token. */
export function toolStream(account: Pick<DirectAccount, "call">, spec: ToolSpec, tz: string): BackfillStream {
  return {
    id: spec.tool,
    tools: [spec.tool],
    async page(cursor) {
      const args = { ...spec.args, ...(cursor ? (cursor.startsWith("p:") ? { page_token: cursor.slice(2) } : { cursor: cursor.slice(2) }) : {}) };
      const r = await account.call(spec.tool, args);
      // A refusal for this request (busy, a bad cursor): the engine waits and tries again, then gives up.
      if (r.isError) throw new Error(r.text.slice(0, 300));
      const body = JSON.parse(r.text) as Row;
      const rows = Array.isArray(body[spec.list]) ? (body[spec.list] as Row[]) : [];
      const next = str(body.next_cursor) ? `c:${body.next_cursor}` : str(body.next_page_token) ? `p:${body.next_page_token}` : undefined;
      return { ...spec.map(rows, tz), read: rows.length, next };
    },
  };
}

/** A backfill over the adapter's own tools, opened the way a run opens the account. */
export function toolBackfill(specs: ToolSpec[]): HistoryBackfill {
  return {
    tools: specs.map((s) => s.tool),
    async open(connector: Connector, secrets: ConnectorSecrets, ctx) {
      // Loaded here: direct.ts registers the adapters that use this file.
      const { directFor } = await import("./direct");
      const account = await directFor(connector)!.open(connector, secrets);
      return specs.map((s) => toolStream(account, s, ctx.tz));
    },
  };
}

// ---------- Films and episodes (Plex, Jellyfin) ----------

/** A Plex or Jellyfin play: a watched entry, and the film or show for Watch & read (recipes.ts). */
export function mediaServerRows(source: "plex" | "jellyfin") {
  return (rows: Row[]): Mapped => {
    const entries: BackfillPage["entries"] = [];
    const items = new Map<string, WatchReadInput>();
    for (const r of rows) {
      const date = str(r.date);
      if (!date) continue;
      if (r.kind === "film" && str(r.title) && str(r.id)) {
        entries.push({ date, entry: clean({ kind: "watched", source, external_id: `${date}:${r.id}`, title: str(r.title)!, subtitle: num(r.year) ? String(r.year) : undefined, url: str(r.link) }) });
        const k = `film:${r.id}`;
        if (!items.has(k)) items.set(k, { kind: "film", title: str(r.title)!, year: num(r.year), status: "done", at: date, url: str(r.link), external_id: String(r.id), source });
      } else if (r.kind === "episode" && str(r.show)) {
        const se = num(r.season) !== undefined && num(r.episode) !== undefined ? `S${r.season}E${r.episode}` : "";
        const subtitle = [se, str(r.title)].filter(Boolean).join(" · ") || undefined;
        entries.push({ date, entry: clean({ kind: "watched", source, external_id: `${date}:${str(r.link) ?? `${r.show}:${se}`}`, title: str(r.show)!, subtitle, url: str(r.link), group: str(r.show) }) });
        const k = `show:${r.show_id ?? r.show}`;
        if (!items.has(k)) items.set(k, { kind: "tv", title: str(r.show)!, status: "reading", at: date, url: str(r.show_link), ...(str(r.show_id) ? { external_id: String(r.show_id) } : {}), source });
      }
    }
    return { entries, watchRead: [...items.values()] };
  };
}

// ---------- Letterboxd ----------

/** A diary entry: a watched entry with its rating, and the film, watched, for Watch & read. */
export function letterboxdRows(rows: Row[]): Mapped {
  const entries: BackfillPage["entries"] = [];
  const watchRead: WatchReadInput[] = [];
  for (const r of rows) {
    const date = str(r.watched_on);
    const title = str(r.title);
    if (!date || !title) continue;
    const id = str(r.link) ?? `${titleKey("film", title)}:${r.year ?? ""}`;
    const note = [r.rewatch ? "rewatch" : undefined, str(r.review)?.slice(0, 200)].filter(Boolean).join(" · ") || undefined;
    entries.push({ date, entry: clean({ kind: "watched", source: "letterboxd", external_id: `${date}:${id}`, title, subtitle: num(r.year) ? String(r.year) : undefined, url: str(r.link), note }) });
    watchRead.push({ kind: "film", title, year: num(r.year), status: "done", ...(str(r.rating) ? { rating: str(r.rating) } : {}), at: date, url: str(r.link), source: "letterboxd" });
  }
  return { entries, watchRead };
}

// ---------- Music (Last.fm, Spotify) ----------

/** A song saved to Liked Songs, or an album saved, as a saved entry on the day it was saved. */
export function spotifySavedRows(kind: "tracks" | "albums") {
  return (rows: Row[]): Mapped => ({
    entries: rows.flatMap((r) => {
      const date = str(r.saved_date);
      const title = kind === "tracks" ? str(r.track) : str(r.album);
      const link = str(r.link);
      if (!date || !title || !link) return [];
      const id = link.split("/").pop()!.split("?")[0];
      return [{ date, entry: clean({ kind: "saved", source: "spotify", external_id: `saved:${kind}:${id}`, title, subtitle: str(r.artist), url: link, group: str(r.artist), note: kind === "tracks" ? "liked song" : "saved album" }) }];
    }),
  });
}

export const LASTFM_CAP = 100_000;

interface Session {
  date: string;
  key: string;
  title: string;
  artist?: string;
  count: number;
  /** Plays per local hour (lib/day-hours.ts), from each scrobble's time. */
  hours?: number[];
}

/** Last.fm's cursor with the oldest day of the last page held back, so a day split over two pages is one entry per album. */
interface LastfmCursor {
  c: string;
  held: Session[];
}

/**
 * Scrobbles folded as the Life log folds them: one listened entry per album
 * (or the artist, without one) per day, with count. A page ends part-way
 * through a day, so that day's sessions wait for the next page.
 */
export function lastfmStream(account: Pick<DirectAccount, "call">, opts: { tool: string; source: string; limit: number } = { tool: "list_scrobbles", source: "lastfm", limit: 200 }): BackfillStream {
  const label = opts.source === "lastfm" ? "Last.fm" : "ListenBrainz";
  return {
    id: opts.tool,
    tools: [opts.tool],
    // Scrobbles run to hundreds of thousands: the most recent 100,000. ListenBrainz listens too.
    cap: LASTFM_CAP,
    async page(cursor) {
      let held: Session[] = [];
      let c: string | undefined;
      if (cursor) {
        try {
          ({ c, held } = JSON.parse(cursor) as LastfmCursor);
        } catch {
          throw new Error(`Athena lost its place in your ${label} history. Load it again.`);
        }
      }
      const r = await account.call(opts.tool, { limit: opts.limit, ...(c ? { cursor: c } : {}) });
      if (r.isError) throw new Error(r.text.slice(0, 300));
      const body = JSON.parse(r.text) as { items?: Row[]; next_cursor?: string };
      const rows = body.items ?? [];
      const sessions = new Map<string, Session>(held.map((s) => [`${s.date}\u0000${s.key}`, s]));
      for (const t of rows) {
        const date = str(t.date);
        const one = listenSession(t);
        if (!date || !one) continue;
        const { title, artist } = one;
        // The same id as every album-and-day writer (albumDayId), so loads, imports and the hourly check meet.
        const key = albumDayId(date, title, artist).slice(date.length + 1);
        const k = `${date}\u0000${key}`;
        const s = sessions.get(k) ?? { date, key, title, ...(artist ? { artist } : {}), count: 0 };
        s.count++;
        // Each play's local hour, so Music can say when the owner listens. A session held over from an older cursor may have none yet.
        const hour = hourOf(t.time);
        if (hour !== undefined) s.hours = addPlay(s.hours ?? emptyHours(), hour);
        sessions.set(k, s);
      }
      const all = [...sessions.values()];
      const next = str(body.next_cursor);
      const oldest = all.reduce<string | undefined>((o, s) => (!o || s.date < o ? s.date : o), undefined);
      const keep = next ? all.filter((s) => s.date === oldest) : [];
      const out = next ? all.filter((s) => s.date !== oldest) : all;
      return {
        entries: out.map((s) => ({ date: s.date, entry: listenedEntry(opts.source, s.date, s, s.count, s.hours) })),
        read: rows.length,
        next: next ? JSON.stringify({ c: next, held: keep } satisfies LastfmCursor) : undefined,
      };
    },
  };
}

/** What a play is folded under: the album, or the artist without one (the Life log's fold, recipes.ts). Also the hourly check's (media-sync.ts). */
export function listenSession(row: Row): { title: string; artist?: string } | null {
  const artist = str(row.artist);
  const title = str(row.album) ?? artist;
  if (!title) return null;
  return { title, ...(artist ? { artist } : {}) };
}

/** A day's listened entry for one session: the same id (albumDayId) and fields from the history load and the hourly check. */
export function listenedEntry(source: string, date: string, s: { title: string; artist?: string }, count: number, hours?: number[]): EntryInput {
  return clean({ kind: "listened", source, external_id: albumDayId(date, s.title, s.artist), title: s.title, subtitle: s.artist, count: count > 1 ? count : undefined, group: s.artist, hours });
}

export const lastfmBackfill: HistoryBackfill = {
  tools: ["list_scrobbles"],
  async open(connector, secrets) {
    const { directFor } = await import("./direct");
    return [lastfmStream(await directFor(connector)!.open(connector, secrets))];
  },
};

/** ListenBrainz: listens folded the way Last.fm's scrobbles are (listenbrainz-direct.ts gives the same rows). */
export const listenbrainzBackfill: HistoryBackfill = {
  tools: ["list_listens"],
  async open(connector, secrets) {
    const { directFor } = await import("./direct");
    return [lastfmStream(await directFor(connector)!.open(connector, secrets), { tool: "list_listens", source: "listenbrainz", limit: 100 })];
  },
};

// ---------- Saved links and events (Raindrop.io, Eventbrite) ----------

/** A Raindrop.io bookmark: a saved entry on the day it was saved, the collection as its note. */
export function raindropRows(rows: Row[]): Mapped {
  return {
    entries: rows.flatMap((r) => {
      const date = str(r.saved_on);
      const id = str(r.id);
      const title = str(r.title);
      if (!date || !id || !title) return [];
      return [{ date, entry: clean({ kind: "saved", source: "raindrop", external_id: `raindrop:${id}`, title, subtitle: str(r.site), url: str(r.link), note: str(r.collection) }) }];
    }),
  };
}

/** An Eventbrite order: an other entry on the day the event happened (backfill.ts leaves out days still to come). */
export function eventbriteRows(rows: Row[]): Mapped {
  return {
    entries: rows.flatMap((r) => {
      const date = str(r.date);
      const id = str(r.order_id);
      const title = str(r.event);
      if (!date || !id || !title) return [];
      const where = [str(r.venue), str(r.town)].filter(Boolean).join(", ") || undefined;
      return [{ date, entry: clean({ kind: "other", source: "eventbrite", external_id: `eventbrite:${id}`, title, subtitle: [str(r.time), where].filter(Boolean).join(" · ") || undefined, url: str(r.link), minutes: num(r.minutes), group: "Events" }) }];
    }),
  };
}

export const raindropBackfill = toolBackfill([{ tool: "list_bookmarks", args: { limit: 50 }, list: "items", map: raindropRows }]);
export const eventbriteBackfill = toolBackfill([{ tool: "list_orders", args: { when: "past" }, list: "items", map: eventbriteRows }]);

export const plexBackfill = toolBackfill([{ tool: "watch_history", args: { limit: 100 }, list: "items", map: mediaServerRows("plex") }]);
export const jellyfinBackfill = toolBackfill([{ tool: "watch_history", args: { limit: 100 }, list: "items", map: mediaServerRows("jellyfin") }]);
export const letterboxdBackfill = toolBackfill([{ tool: "list_diary", args: { limit: 50 }, list: "films", map: letterboxdRows }]);
const SPOTIFY_SAVES: ToolSpec[] = [
  { tool: "saved_tracks", args: { limit: 50 }, list: "items", map: spotifySavedRows("tracks") },
  { tool: "saved_albums", args: { limit: 50 }, list: "items", map: spotifySavedRows("albums") },
];

/**
 * Spotify: liked songs and saved albums, then the playlists for Music
 * (playlist-sync.ts). Playlists are Athena's own read for Music, like the
 * daily sync, so that stream stands for no tool of "What Athena can read".
 */
export const spotifyBackfill: HistoryBackfill = {
  tools: SPOTIFY_SAVES.map((s) => s.tool),
  async open(connector, secrets, ctx) {
    const { directFor } = await import("./direct");
    const account = await directFor(connector)!.open(connector, secrets);
    const playlists: BackfillStream = {
      id: "playlists",
      tools: [],
      async page() {
        const { readSpotifyPlaylists } = await import("./playlist-sync");
        await readSpotifyPlaylists((name, args) => account.call(name, args), new Date());
        return { entries: [], read: 0 };
      },
    };
    return [...SPOTIFY_SAVES.map((s) => toolStream(account, s, ctx.tz)), playlists];
  },
};

/** An entry without its empty fields. */
function clean(e: Partial<EntryInput> & Pick<EntryInput, "kind" | "source" | "external_id" | "title">): EntryInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== "") out[k] = v;
  return out as unknown as EntryInput;
}
