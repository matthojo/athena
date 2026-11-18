/**
 * ListenBrainz without MCP: a narrow, read-only adapter over ListenBrainz's
 * public API (api.listenbrainz.org/1), registered in direct.ts.
 *
 * Why no key: listens on ListenBrainz are public, and its API reads them
 * without a token (listenbrainz.readthedocs.io/en/latest/users/api/), so the
 * account is just the owner's username (auth_type "none"; the URL Athena
 * keeps is their profile, listenbrainz.org/user/<name>). Reads:
 * /user/<name>/listen-count (proves the user exists) and /user/<name>/listens
 * (newest first, at most 100 a call, paged back with max_ts). GETs only;
 * nothing is ever submitted.
 *
 * Rate limit: anonymous callers get 30 requests per 10 seconds (the
 * X-RateLimit headers, 9 Nov 2026); a 429 is waited out by getJson.
 */
import type { Connector } from "../../../lib/connectors";
import { LISTENBRAINZ_API_URL, LISTENBRAINZ_HOSTS } from "../../../lib/presets/life-b";
import { arg, clean } from "./google-api";
import { listenbrainzBackfill } from "./backfill-tools";
import { listenbrainzRecent } from "./media-recent";
import type { DirectAccount, DirectAdapter } from "./direct";
import { chessUsername } from "./lichess-direct";
import {
  CURSOR_PROP,
  LifeApiError,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  getJson,
  lifeAccountProblem,
  lifeFailure,
  ownerZone,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";

/** ListenBrainz (MetaBrainz) usernames: letters, digits, dot, dash and underscore; up to 64 characters. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;

/** The profile address Athena keeps, from a username or a listenbrainz.org link. */
export function listenbrainzAddress(raw: string): string {
  return `https://listenbrainz.org/user/${encodeURIComponent(chessUsername(raw, LISTENBRAINZ_HOSTS, /^\/user\//i, "ListenBrainz", NAME))}`;
}

function refused(status: number): LifeApiError {
  if (status === 404) return new LifeApiError("listenbrainz", 404, "ListenBrainz can't find that username. Check the spelling.", true);
  if (status === 401 || status === 403) return new LifeApiError("listenbrainz", 401, "ListenBrainz refused Athena. Try again later; if it keeps happening, remove and add the account again.", true);
  if (status === 429) return new LifeApiError("listenbrainz", 429, "ListenBrainz is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("listenbrainz", 503, "ListenBrainz is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("listenbrainz", status, `ListenBrainz refused that (${status})`);
}

const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
  const url = new URL(`${LISTENBRAINZ_API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  return getJson<T>(url.toString(), {
    service: "listenbrainz",
    hosts: ["api.listenbrainz.org"],
    headers: { "User-Agent": "Athena/1.0 (personal life log, read-only)" },
    refused,
    unreachable: "Couldn't reach ListenBrainz",
  });
};

/** One listen as ListenBrainz gives it, trimmed to what Athena reads. */
export interface Listen {
  listened_at?: number;
  recording_msid?: string;
  track_metadata?: {
    artist_name?: string;
    track_name?: string;
    release_name?: string;
    additional_info?: { duration_ms?: number; recording_mbid?: string; submission_client?: string };
    mbid_mapping?: { recording_mbid?: string; release_mbid?: string } | null;
  };
}

export interface ListenbrainzContext {
  user: string;
  tz: string;
}

/** A listen as a row, in the same fields as Last.fm's scrobbles, so the Life log and history loading treat them alike. */
export function listenRow(l: Listen, tz: string): Record<string, unknown> | null {
  const t = l.track_metadata;
  const track = t?.track_name?.trim();
  if (!track || !l.listened_at) return null;
  const at = when(l.listened_at * 1000, tz);
  const mbid = t?.mbid_mapping?.recording_mbid ?? t?.additional_info?.recording_mbid;
  return clean({
    track,
    artist: t?.artist_name?.trim() || undefined,
    album: t?.release_name?.trim() || undefined,
    date: at.date,
    time: at.time,
    played_at: at.at,
    minutes: t?.additional_info?.duration_ms ? Math.round(t.additional_info.duration_ms / 60_000) || undefined : undefined,
    link: mbid && /^[0-9a-f-]{36}$/.test(mbid) ? `https://musicbrainz.org/recording/${mbid}` : undefined,
  });
}

/**
 * Listens in a window, newest first. ListenBrainz takes max_ts or min_ts, not
 * both, so Athena reads back from the window's end (or the cursor) and stops
 * at its start. The cursor is the oldest listen's time.
 */
async function listListens(ctx: ListenbrainzContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 100 });
  const cursor = decodeCursor<number>("listenbrainz:listens", args.cursor);
  const maxTs = cursor ?? (w.before !== undefined ? Math.ceil(w.before / 1000) : undefined);
  const body = await get<{ payload?: { count?: number; listens?: Listen[] } }>(`/user/${encodeURIComponent(ctx.user)}/listens`, { count: limit, max_ts: maxTs });
  const listens = body.payload?.listens ?? [];
  const after = w.after !== undefined ? w.after / 1000 : undefined;
  const kept = listens.filter((l) => l.listened_at !== undefined && (after === undefined || l.listened_at >= after));
  const items = kept.map((l) => listenRow(l, ctx.tz)).filter((r): r is Record<string, unknown> => !!r);
  const oldest = listens.at(-1)?.listened_at;
  // A full page that didn't reach the window's start means there's more.
  const more = listens.length === limit && oldest !== undefined && (after === undefined || oldest > after);
  const byArtist = new Map<string, number>();
  for (const i of items) if (i.artist) byArtist.set(i.artist as string, (byArtist.get(i.artist as string) ?? 0) + 1);
  return withItems(items, {
    count: items.length,
    top_artists: [...byArtist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([artist, plays]) => ({ artist, plays })),
    username: ctx.user,
    next_cursor: more ? encodeCursor("listenbrainz:listens", oldest) : undefined,
  });
}

export const LISTENBRAINZ_TOOLS: LifeTool<ListenbrainzContext>[] = [
  {
    name: "list_listens",
    summary: "See what you listened to",
    description:
      "The owner's ListenBrainz listening history, newest first: track, artist, album, minutes, local date and time, and a MusicBrainz link when ListenBrainz matched the recording; plus count and the page's top artists. Ask one day at a time with date (YYYY-MM-DD, the owner's time zone), or use after/before. Up to 100 a page; page on with next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many a page (default 100)." },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: listListens,
  },
];

/** Open the account: the listen count proves the username exists. */
export async function openListenbrainz(connector: Pick<Connector, "url">, tz?: string): Promise<DirectAccount> {
  let user: string;
  try {
    user = decodeURIComponent(new URL(listenbrainzAddress(connector.url)).pathname.split("/").pop()!);
  } catch (error) {
    throw new LifeApiError("listenbrainz", 400, (error as Error).message, true);
  }
  const [, zone] = await Promise.all([get(`/user/${encodeURIComponent(user)}/listen-count`), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("listenbrainz", LISTENBRAINZ_TOOLS, { user, tz: zone });
}

export const listenbrainzAdapter: DirectAdapter = {
  id: "listenbrainz",
  handles: (c) => c.provider === "listenbrainz" && c.auth_type === "none",
  tools: () => LISTENBRAINZ_TOOLS,
  serverInfo: () => ({ website_url: "https://listenbrainz.org/" }),
  open: (connector) => openListenbrainz(connector),
  checkAddress: listenbrainzAddress,
  backfill: listenbrainzBackfill,
  recent: listenbrainzRecent,
  accountProblem: (e) => lifeAccountProblem("listenbrainz", e),
  failure: (e) => lifeFailure("listenbrainz", e),
};
