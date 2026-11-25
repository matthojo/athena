/**
 * lib/answer.ts's SourcesPort: the owner's connected accounts, opened with
 * their stored sign-ins for the length of one answer. Same rules as
 * collections (SECURITY.md §9):
 *
 *  - only the tools the owner allowed for an account, re-checked as reads when
 *    they're listed (listAllowedTools), and a call to anything else is refused;
 *  - callTool refuses send, reply and forward tools for every account;
 *  - an account that needs signing in, or doesn't answer in time, is skipped
 *    and named, never fatal.
 *
 * Every allowed read tool is offered (ask-past-sources, 8 Nov): for the
 * services Athena knows, the ones that help answer a question come first
 * (searching and reading), then the rest of the account's allowlist. Each
 * account also says when Athena started collecting from it, so the model
 * knows to search the account itself for anything older.
 *
 * Life log accounts (Trakt, YouTube, Letterboxd, Goodreads, Reddit, Spotify,
 * Last.fm, Steam, Readwise, Bluesky, Mastodon) return JSON lists with a link per item: each link is named
 * for what it is (a film, an episode, a track…), and a Reddit item marked
 * nsfw reaches Claude and the app by its community only, as in the Life log.
 */

import type { ExternalKind, LinkInfo, OpenSources, SourceAccount, SourcesPort, SourceTool } from "../../../lib/answer";
import { listConnectors, offeredInAsk, type Connector } from "../../../lib/connectors";
import { callTool, ConnectorNeedsSignIn, listAllowedTools, openConnector, type ListedTool, type OpenConnector } from "./mcp-client";

/** The tools worth offering for a question, best first; each must also be on the account's allowlist. */
const ANSWER_TOOLS: Record<string, string[]> = {
  granola: ["search_meetings", "get_meetings", "search_transcripts", "get_meeting_transcript", "list_meetings"],
  gmail: ["search_threads", "get_thread"],
  "google-calendar": ["search_events", "list_events", "get_event"],
  "outlook-mail": ["search_threads", "get_thread"],
  fastmail: ["search_threads", "get_thread"],
  "outlook-calendar": ["search_events", "list_events", "get_event"],
  "icloud-calendar": ["search_events", "list_events", "get_event"],
  "icloud-contacts": ["search_contacts", "get_contact"],
  slack: ["slack_search_public_and_private", "slack_search_public", "slack_read_thread", "slack_read_channel"],
  linear: ["list_issues", "get_issue", "list_comments", "list_documents", "get_document"],
  github: ["search_issues", "search_pull_requests", "issue_read", "pull_request_read"],
  notion: ["notion-search", "notion-fetch"],
  // Life log: what was done (history, diary, plays) before lists of what's planned or ranked.
  trakt: ["list_history", "list_in_progress", "list_ratings", "list_watchlist"],
  youtube: ["list_liked_videos", "list_playlists", "list_playlist_videos", "list_subscriptions"],
  letterboxd: ["list_diary"],
  goodreads: ["list_books"],
  reddit: ["my_posts", "my_comments", "my_saved", "my_upvoted"],
  spotify: ["recently_played", "saved_tracks", "saved_albums", "top_items"],
  lastfm: ["list_scrobbles", "top_artists"],
  steam: ["recently_played", "played_games"],
  plex: ["watch_history"],
  jellyfin: ["watch_history"],
  lichess: ["list_games"],
  chesscom: ["list_games"],
  tripit: ["list_trips"],
  readwise: ["search_highlights", "list_highlights"],
  bluesky: ["my_posts"],
  mastodon: ["my_posts"],
  listenbrainz: ["list_listens"],
  raindrop: ["search_bookmarks", "list_bookmarks"],
  eventbrite: ["list_orders"],
};

const KIND: Record<string, ExternalKind> = {
  granola: "meeting",
  gmail: "email",
  "google-calendar": "event",
  "outlook-mail": "email",
  fastmail: "email",
  "outlook-calendar": "event",
  "icloud-calendar": "event",
  // A contact has no link to open; "page" until Ask has a kind for people outside Athena.
  "icloud-contacts": "page",
  slack: "message",
  // A Life log account's usual item; each link is named for itself (itemKinds).
  trakt: "episode",
  youtube: "video",
  letterboxd: "film",
  goodreads: "book",
  reddit: "post",
  spotify: "track",
  lastfm: "track",
  steam: "game",
  plex: "episode",
  jellyfin: "episode",
  lichess: "game",
  chesscom: "game",
  // A trip has no kind of its own in Ask yet.
  tripit: "event",
  readwise: "book",
  bluesky: "post",
  mastodon: "post",
  listenbrainz: "track",
  raindrop: "page",
  eventbrite: "event",
};

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What one Life log item is, from its fields; null when it's something else (a playlist, a channel). */
function lifeKind(provider: string, o: Obj, link: string): ExternalKind | null {
  switch (provider) {
    case "trakt":
      return o.kind === "episode" ? "episode" : o.kind === "film" ? "film" : o.kind === "show" || o.kind === "season" ? "show" : null;
    case "youtube":
      return /youtube\.com\/watch\?/.test(link) ? "video" : null;
    case "letterboxd":
      return "film";
    case "goodreads":
      return "book";
    case "reddit":
      return o.kind === "comment" ? "comment" : o.kind === "post" ? "post" : null;
    case "spotify":
    case "lastfm":
      return o.track ? "track" : o.album ? "album" : o.artist ? "artist" : null;
    case "steam":
    case "lichess":
    case "chesscom":
      return "game";
    case "plex":
    case "jellyfin":
      return o.kind === "film" ? "film" : o.kind === "episode" ? "episode" : null;
    case "tripit":
      return "event";
    case "readwise":
      // A book's own link, or a highlight's (search results name their book's kind).
      return o.kind === "book" || o.kind === undefined ? "book" : o.kind === "post" ? "post" : "page";
    case "bluesky":
    case "mastodon":
      return o.kind === "reply" ? "comment" : "post";
    case "listenbrainz":
      return o.track ? "track" : null;
    case "raindrop":
      return "page";
    case "eventbrite":
      return "event";
    default:
      return null;
  }
}

/** An NSFW Reddit item, by its community only: "Post in r/…". */
const nsfwTitle = (o: Obj) => `${o.kind === "comment" ? "Comment" : "Post"} in ${str(o.community) ?? "Reddit"}`;

/** Every object in a parsed JSON value, depth first. */
function* objects(v: unknown): Generator<Obj> {
  if (Array.isArray(v)) for (const x of v) yield* objects(x);
  else if (v && typeof v === "object") {
    yield v as Obj;
    for (const x of Object.values(v)) yield* objects(x);
  }
}

/**
 * The complete objects in JSON text, as [start, end) spans in the order they
 * close, inner before outer. A result cut short at 24,000 characters isn't
 * valid JSON, but every item before the cut still is.
 */
function spans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const open: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") open.push(i);
    else if (ch === "}" && open.length) out.push([open.pop()!, i + 1]);
  }
  return out;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The items in a result: all of it when it parses, else each complete object before the cut. */
function items(text: string): Obj[] {
  const body = parse(text);
  if (body !== undefined) return [...objects(body)];
  return spans(text)
    .map(([a, b]) => parse(text.slice(a, b)))
    .filter((o): o is Obj => !!o && typeof o === "object" && !Array.isArray(o));
}

/**
 * What each link in a Life log result is: link → kind, plus the title the app
 * must show instead of the model's (an NSFW Reddit item's community). Other
 * accounts, and results that aren't JSON, give nothing.
 */
export function itemKinds(provider: string, text: string): Record<string, LinkInfo> {
  const out: Record<string, LinkInfo> = {};
  if (!LIFE.has(provider)) return out;
  for (const o of items(text)) {
    const link = str(o.link);
    if (!link?.startsWith("https://")) continue;
    const kind = lifeKind(provider, o, link) ?? "page";
    if (provider === "reddit" && o.nsfw === true) out[bareRedditLink(link)] = { kind, title: nsfwTitle(o) };
    else out[link] = { kind };
  }
  return out;
}

const LIFE = new Set(["trakt", "youtube", "letterboxd", "goodreads", "reddit", "spotify", "lastfm", "steam", "readwise", "bluesky", "mastodon", "plex", "jellyfin", "lichess", "chesscom", "tripit", "listenbrainz", "raindrop", "eventbrite"]);

/**
 * A Reddit permalink carries the post's title as a slug (/comments/<id>/<title_words>/).
 * For an NSFW item that slug is swapped for "_", which Reddit still opens, so the
 * link can be cited without the title reaching Claude or the source chip.
 */
export function bareRedditLink(link: string): string {
  return link.replace(/^(https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+\/)[^/?#]+/, "$1_");
}

const NSFW_KEEPS = new Set(["kind", "community", "date", "time", "link", "nsfw"]);
const nsfwOnly = (o: Obj): Obj => {
  const kept = Object.fromEntries(Object.entries(o).filter(([k]) => NSFW_KEEPS.has(k)));
  if (typeof kept.link === "string") kept.link = bareRedditLink(kept.link);
  return kept;
};

/**
 * A Reddit result with every NSFW item cut to its community, date and link,
 * so Claude never reads its title or text. A result that was cut short also
 * loses the item the cut fell in, which may be NSFW without saying so yet.
 */
export function withoutNsfw(provider: string, text: string): string {
  if (provider !== "reddit") return text;
  const body = parse(text);
  if (body !== undefined) {
    if (!text.includes('"nsfw"')) return text;
    for (const o of objects(body))
      if (o.nsfw === true) {
        for (const k of Object.keys(o)) if (!NSFW_KEEPS.has(k)) delete o[k];
        if (typeof o.link === "string") o.link = bareRedditLink(o.link);
      }
    return JSON.stringify(body);
  }
  // Cut short: keep each complete item (an NSFW one cut down), and drop the one the cut fell in.
  let out = "";
  let at = 0;
  for (const [a, b] of spans(text)) {
    const o = parse(text.slice(a, b));
    if (a < at || !o || typeof o !== "object" || !("kind" in o)) continue;
    out += text.slice(at, a) + ((o as Obj).nsfw === true ? JSON.stringify(nsfwOnly(o as Obj)) : text.slice(a, b));
    at = b;
  }
  return `${out}\n\n[cut short: narrow the search to see more]`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A Granola meeting's id where its results name one: id="…", "id": "…", meeting_id. */
const GRANOLA_ID = new RegExp(`(?:meeting_id|document_id|\\bid)["']?\\s*[=:]\\s*["']?(${UUID})`, "gi");

/** Links a result points at that aren't written out in it: Granola meetings open at notes.granola.ai/d/<id>. */
export function derivedLinks(provider: string, text: string): string[] {
  if (provider !== "granola") return [];
  return [...new Set([...text.matchAll(GRANOLA_ID)].map((m) => `https://notes.granola.ai/d/${m[1].toLowerCase()}`))];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** "Gmail", or "Gmail (work)" when there's more than one of it. */
function displayNames(connectors: Connector[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const c of connectors) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  return new Map(connectors.map((c) => [c.id, (count.get(c.name) ?? 0) > 1 && c.account_label ? `${c.name} (${c.account_label})` : c.name]));
}

/** When Athena started collecting from an account: the day it was added (collections look back from there). */
function collectedSince(c: Connector): string | undefined {
  return /^\d{4}-\d{2}-\d{2}/.test(c.created_at ?? "") ? c.created_at.slice(0, 10) : undefined;
}

/**
 * How the accounts are opened, listed and called. `open` may take the account's row as it is now, and
 * `tools` and `call` default to the MCP client's: the Netlify Server passes its own, which keep accounts
 * open between answers (netlify/server/assistant/warm-sources.ts).
 */
export interface AnswerSourceDeps {
  list: () => Promise<Connector[]>;
  open: (id: string, row?: Connector) => Promise<OpenConnector>;
  tools?: (open: OpenConnector) => Promise<ListedTool[]>;
  call?: (open: OpenConnector, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/** The port over these accounts; tests pass their own list and opener, the app uses the stored ones. */
export function answerSourcesWith(deps: AnswerSourceDeps): SourcesPort {
  return { open: ({ timeoutMs, only }) => openAll(deps, timeoutMs, only) };
}

let active: SourcesPort = answerSourcesWith({ list: listConnectors, open: openConnector });
/** Swap how Ask reaches the accounts (the Netlify Server's warm ones). */
export function useAnswerSources(port: SourcesPort): void {
  active = port;
}

export const answerSources: SourcesPort = { open: (opts) => active.open(opts) };

async function openAll(deps: AnswerSourceDeps, timeoutMs: number, only?: ReadonlySet<string>): Promise<OpenSources> {
  // Something someone else shared limits this answer (lib/shared-scope.ts): the other accounts aren't opened, listed or named.
  const all = (await deps.list()).filter((c) => !only || only.has(c.id.toLowerCase()));
  const names = displayNames(all);
  const skipped: string[] = [];
  // An account in error may only have had a bad run; one that needs signing in can't be read until it's signed in again.
  const usable = all.filter((c) => {
    if (c.status === "needs_auth") skipped.push(`${names.get(c.id)} (needs signing in)`);
    // A custom server sits beside mail and calendar here only with its "Use in Ask" switch on (lib/connectors.ts).
    // Home appliances are read through Ask's own `appliances` tool (lib/ask-tools.ts), which reads what Athena last saw and gives a ref to cite: the account's live tool returns no link, so an answer from it couldn't be shown.
    if (c.provider === "home-connect") return false;
    return (c.status === "connected" || c.status === "error") && c.allowed_tools.length > 0 && offeredInAsk(c);
  });

  const opened: OpenConnector[] = [];
  let closed = false;
  const usedKeys = new Set<string>();
  const accounts: SourceAccount[] = [];

  await Promise.all(
    usable.map(async (c) => {
      const name = names.get(c.id) ?? c.name;
      const attempt = (async () => {
        const open = await deps.open(c.id, c);
        // Opened after the answer was over: close it straight away.
        if (closed) {
          await open.close();
          throw new Error("too late");
        }
        opened.push(open);
        return { open, listed: await (deps.tools ?? listAllowedTools)(open) };
      })();
      let ready: Awaited<typeof attempt>;
      try {
        ready = await withTimeout(attempt, timeoutMs, `${name} took too long to open`);
      } catch (error) {
        attempt.catch(() => undefined);
        skipped.push(`${name} (${error instanceof ConnectorNeedsSignIn ? "needs signing in" : "didn't respond"})`);
        return;
      }
      // The best tools for a question first, then everything else the owner allowed.
      const preferred = ANSWER_TOOLS[c.provider] ?? [];
      const rank = (name: string) => (preferred.includes(name) ? preferred.indexOf(name) : preferred.length);
      const listed = [...ready.listed].sort((a, b) => rank(a.name) - rank(b.name));
      if (!listed.length) return;
      const tools: SourceTool[] = listed.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
      const offered = new Set(tools.map((t) => t.name));
      let key = (slug(`${c.provider === "custom" ? c.name : c.provider}_${c.account_label}`).slice(0, 24) || "account").replace(/_+$/, "");
      while (usedKeys.has(key)) key = `${key}_${usedKeys.size + 1}`;
      usedKeys.add(key);
      accounts.push({
        key,
        name,
        kind: KIND[c.provider] ?? "page",
        tools,
        connector: { id: c.id, provider: c.provider, since: collectedSince(c) },
        async call(tool, args, ms) {
          if (!offered.has(tool)) throw new Error(`${tool} isn't offered for ${name}`);
          const r = await withTimeout((deps.call ?? callTool)(ready.open, tool, args), ms, `${name} took too long`);
          const text = r.isError ? r.text : withoutNsfw(c.provider, r.text);
          return { ...r, text, links: derivedLinks(c.provider, text), items: r.isError ? {} : itemKinds(c.provider, r.text) };
        },
      });
    }),
  );

  // The same order every time, whichever account opened first.
  accounts.sort((a, b) => a.key.localeCompare(b.key));
  return {
    accounts,
    skipped,
    async close() {
      closed = true;
      await Promise.all(opened.map((o) => o.close()));
    },
  };
}
