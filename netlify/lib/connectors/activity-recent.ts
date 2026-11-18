/**
 * Your activity, beyond plays and watches (owner decision, 12 Nov): the
 * hourly check's streams for every other Life log source with a direct
 * adapter. Each stream calls the account's own read tools (the same GETs a
 * Life log run makes, under the same "What Athena can read" allowlist) and
 * maps the rows the way the Life log recipe says (recipes.ts), so the
 * evening run only writes the day's line. No model.
 *
 * Ids, one per thing:
 *  - Goodreads: `book:r<review id>` finished, `started:r<review id>`,
 *    `want:r<review id>`, on the book's noticed_on day.
 *  - Readwise: `<day>:<link, or the title's key>` per book or article a day,
 *    count = that day's highlights. Never a highlight's or note's words
 *    (asked with text: false).
 *  - Steam: `<day>:<app id>`, minutes from the game's total the day before.
 *  - Lichess, Chess.com: `chess:<day>`, one entry a site a day.
 *  - Raindrop.io, Eventbrite: the history load's (backfill-tools.ts).
 *  - Habitify: `<habit id>:<day>`; Todoist: `<task id>:<day>`.
 *  - Reddit: the post or comment's link; saved and upvoted
 *    `saved:<link>`, `upvoted:<link>`, on the day first seen.
 *  - Bluesky, Mastodon: the post's link; a busy day's count `posts:<day>`.
 *  - Health: no entries. Each account's day_summary goes to the sealed
 *    health days (lib/health.ts), the last 3 days every check, and for
 *    Polar the days changed_days names.
 *
 * Other people's names and words never reach an entry: chess opponents and
 * comment text are dropped, @handles are taken out of the owner's own
 * posts, a reply is "Replied: …" with no name, nsfw is "Saved a post in
 * r/…" with nothing else.
 */
import { createHash } from "node:crypto";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { addDays, zonedToday } from "../../../lib/dates";
import { matchKey, readRating, type EntryInput } from "../../../lib/days";
import { HealthInputError, readHealthDay, type HealthDay, type HealthSource } from "../../../lib/health";
import type { WatchReadInput } from "../../../lib/watch-read-sync";
import { eventbriteRows, raindropRows } from "./backfill-tools";
import type { DirectAccount } from "./direct";
import type { ChessGame } from "./lichess-direct";
import type { RecentRead, RecentStream, RecentSync, StreamContext, Tally } from "./media-sync";

type Row = Record<string, unknown>;
type Dated = { date: string; entry: EntryInput };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isoOf = (ms: number) => new Date(ms).toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 16);

/** Days a per-day stream reads at most in one check. */
export const MAX_DAYS = 8;
/** Pages of one listing at most in one check. */
export const MAX_PAGES = 10;
/** Health: days re-read every check, for a watch that synced late. */
export const HEALTH_DAYS = 3;
/** Bluesky and Mastodon: more posts than this in a day is one count entry and the 3 most liked. */
export const BUSY_DAY = 10;
/** Reddit's saved and upvoted: items remembered (as hashes) so one isn't new again. */
export const KEEP_SEEN = 300;

/** An entry without its empty fields. */
function clean(e: Partial<EntryInput> & Pick<EntryInput, "kind" | "source" | "external_id" | "title">): EntryInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== "") out[k] = v;
  return out as unknown as EntryInput;
}

/** Every row of a listing, following next_cursor or next_page_token. */
export async function allRows(account: Pick<DirectAccount, "call">, tool: string, args: Record<string, unknown>, list = "items"): Promise<{ rows: Row[]; body: Row }> {
  const rows: Row[] = [];
  let cursor: Record<string, string> = {};
  let first: Row = {};
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await account.call(tool, { ...args, ...cursor });
    if (r.isError) throw new Error(r.text.slice(0, 300));
    const body = JSON.parse(r.text) as Row;
    if (n === 0) first = body;
    if (Array.isArray(body[list])) rows.push(...(body[list] as Row[]));
    if (str(body.next_cursor)) cursor = { cursor: str(body.next_cursor)! };
    else if (str(body.next_page_token)) cursor = { page_token: str(body.next_page_token)! };
    else break;
  }
  return { rows, body: first };
}

/** The local days from `since` to today, oldest first, at most MAX_DAYS. */
export function daysFrom(since: number, ctx: Pick<StreamContext, "tz" | "now">): string[] {
  const today = zonedToday(new Date(ctx.now), ctx.tz);
  let d = zonedToday(new Date(since), ctx.tz);
  if (d < addDays(today, -(MAX_DAYS - 1))) d = addDays(today, -(MAX_DAYS - 1));
  const out: string[] = [];
  for (; d <= today; d = addDays(d, 1)) out.push(d);
  return out;
}

/** An account opened the way a run opens it, for its own tools. */
async function opened(connector: Connector, secrets: ConnectorSecrets): Promise<DirectAccount> {
  const { directFor } = await import("./direct");
  return directFor(connector)!.open(connector, secrets);
}

/** A source's reads: its streams over an open account, and `open`, which opens it the way a run does. */
type ActivityDef = Omit<RecentSync, "open"> & { streams(account: Pick<DirectAccount, "call">): RecentStream[] };
function activity(def: ActivityDef): RecentSync & ActivityDef {
  return { ...def, open: async (connector, secrets) => def.streams(await opened(connector, secrets)) };
}

/** A stream with one read: everything since then. Newest seen is the check's own start (the tools are asked up to now). */
function stream(id: string, tools: string[], read: (since: number, ctx: StreamContext) => Promise<Omit<RecentRead, "read" | "newest"> & { read?: number }>): RecentStream {
  return {
    id,
    tools,
    async read(since, ctx) {
      const started = ctx!.now;
      const r = await read(since, ctx!);
      return { read: r.entries.length, ...r, newest: started };
    },
  };
}

// ---------- Goodreads ----------

const SHELF = { read: { kind: "read", prefix: "book", note: "finished", status: "done" }, "currently-reading": { kind: "read", prefix: "started", note: "started", status: "reading" }, "to-read": { kind: "saved", prefix: "want", note: "want to read", status: "queued" } } as const;
type Shelf = keyof typeof SHELF;

/** A shelf's books noticed since then: a read entry (finished or started) or a saved one (want to read), and the book for Watch & read. */
export function goodreadsRows(shelf: Shelf, rows: Row[]): { entries: Dated[]; watchRead: WatchReadInput[] } {
  const s = SHELF[shelf];
  const entries: Dated[] = [];
  const watchRead: WatchReadInput[] = [];
  for (const b of rows) {
    const date = str(b.noticed_on);
    const title = str(b.title);
    const link = str(b.link);
    const rid = link && /review\/show\/(\d+)/.exec(link)?.[1];
    if (!date || !title || !rid) continue;
    const rating = shelf === "read" ? readRating(b.rating, "goodreads") : undefined;
    entries.push({ date, entry: clean({ kind: s.kind, source: "goodreads", external_id: `${s.prefix}:r${rid}`, title, subtitle: str(b.author), url: link, rating, note: s.note }) });
    watchRead.push({ kind: "book", title, maker: str(b.author), status: s.status, ...(shelf === "read" && str(b.rating) ? { rating: str(b.rating) } : {}), at: date, url: link, source: "goodreads" });
  }
  return { entries, watchRead };
}

export const goodreadsRecent = activity({
  source: "goodreads",
  tools: ["list_books"],
  whole: true,
  streams: (account) =>
    [
        stream("shelves", ["list_books"], async (since) => {
          const out = { entries: [] as Dated[], watchRead: [] as WatchReadInput[], read: 0 };
          for (const shelf of Object.keys(SHELF) as Shelf[]) {
            const { rows } = await allRows(account, "list_books", { shelf, after: isoOf(since), limit: 50 }, "books");
            const m = goodreadsRows(shelf, rows);
            out.entries.push(...m.entries);
            out.watchRead.push(...m.watchRead);
            out.read += rows.length;
          }
          return out;
        }),
      ],
});

// ---------- Readwise ----------

/** One day's highlights by book or article: counts, the book's link, where (Kindle). Never the words. */
export function readwiseRows(date: string, rows: Row[]): Dated[] {
  return rows.flatMap((b) => {
    const title = str(b.title);
    const count = num(b.highlights_count);
    if (!title || !count) return [];
    const link = str(b.link);
    return [{ date, entry: clean({ kind: "highlight", source: "readwise", external_id: `${date}:${link ?? matchKey(title)}`, title, subtitle: str(b.author), count: count > 1 ? count : undefined, note: str(b.source), url: link, group: title }) }];
  });
}

export const readwiseRecent = activity({
  source: "readwise",
  tools: ["list_highlights"],
  withhold: ["search_highlights"],
  whole: true,
  streams: (account) =>
    [
        stream("highlights", ["list_highlights"], async (since) => {
          // What reached Readwise since then names the days it was made on (a late Kindle sync points back).
          const added = await allRows(account, "list_highlights", { by: "added", after: isoOf(since), text: false });
          const days = (Array.isArray(added.body.days) ? (added.body.days as unknown[]) : []).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-MAX_DAYS);
          const entries: Dated[] = [];
          let read = added.rows.length;
          for (const date of days) {
            const { rows } = await allRows(account, "list_highlights", { date, text: false });
            read += rows.length;
            entries.push(...readwiseRows(date, rows));
          }
          return { entries, read };
        }),
      ],
});

// ---------- Steam ----------

/** Each game's total the last time it was seen, and the total before that day: [day, hours, hours the day before]. */
type GameMemory = Record<string, [string, number, number | null]>;

const appOf = (link: string | undefined) => (link ? /\/app\/(\d+)/.exec(link)?.[1] : undefined);

/**
 * Games last played since then: one played entry per game and day, its
 * total as the note, and minutes from the total at the end of the day
 * before. With no earlier total, no minutes (and no game_minutes_day).
 */
export function steamRows(rows: Row[], memory: GameMemory): { entries: Dated[]; memory: GameMemory } {
  const next: GameMemory = { ...memory };
  const entries: Dated[] = [];
  for (const g of rows) {
    const date = str(g.last_played_date);
    const title = str(g.game);
    const app = appOf(str(g.link));
    const total = num(g.hours_total);
    if (!date || !title || !app || total === undefined) continue;
    const k = hash(`steam\u0000${app}`);
    const was = next[k];
    const before = !was ? null : was[0] < date ? was[1] : was[2];
    next[k] = [date, total, before];
    const minutes = before !== null && total >= before ? Math.round((total - before) * 60) : undefined;
    entries.push({ date, entry: clean({ kind: "played", source: "steam", external_id: `${date}:${app}`, title, note: `${total} hours in total`, url: str(g.link), minutes }) });
  }
  return { entries, memory: next };
}

export const steamRecent = activity({
  source: "steam",
  tools: ["played_games"],
  withhold: ["recently_played"],
  whole: true,
  streams: (account) =>
    [
        stream("played", ["played_games"], async (since, ctx) => {
          let memory = (ctx.state.games as GameMemory | undefined) ?? undefined;
          const firstDay = zonedToday(new Date(since), ctx.tz);
          if (!memory) {
            // First check: every game's total now, so the next day played has a figure to count from. Games played since then have none.
            const all = await allRows(account, "played_games", { limit: 100 });
            if (all.body.private === true) return { entries: [], private: true, note: str(all.body.note) };
            memory = {};
            for (const g of all.rows) {
              const app = appOf(str(g.link));
              const total = num(g.hours_total);
              const day = str(g.last_played_date);
              if (app && total !== undefined && day && day < firstDay) memory[hash(`steam\u0000${app}`)] = [day, total, null];
            }
          }
          const { rows, body } = await allRows(account, "played_games", { after: isoOf(since), limit: 100 });
          if (body.private === true) return { entries: [], private: true, note: str(body.note) };
          const m = steamRows(rows, memory);
          ctx.state.games = m.memory;
          return { entries: m.entries, read: rows.length };
        }),
      ],
});

// ---------- Chess ----------

const CHESS_NAME = { lichess: "Lichess", chesscom: "Chess.com" } as const;

/** One chess entry a site a day: the games and the summary's line. No opponent, ever. */
export async function chessDay(source: "lichess" | "chesscom", date: string, games: Row[]): Promise<Dated[]> {
  if (!games.length) return [];
  // Loaded here: lichess-direct.ts registers this file's reads.
  const { chessSummary } = await import("./lichess-direct");
  const s = chessSummary(games as unknown as ChessGame[]);
  return [{ date, entry: clean({ kind: "chess", source, external_id: `chess:${date}`, title: `Chess on ${CHESS_NAME[source]}`, count: s.games > 1 ? s.games : undefined, note: s.line }) }];
}

const chess = (source: "lichess" | "chesscom") =>
  activity({
  source,
  tools: ["list_games"],
  whole: true,
  streams: (account) =>
    [
        stream("games", ["list_games"], async (since, ctx) => {
          const entries: Dated[] = [];
          let read = 0;
          for (const date of daysFrom(since, ctx)) {
            const { rows } = await allRows(account, "list_games", { date });
            read += rows.length;
            entries.push(...(await chessDay(source, date, rows)));
          }
          return { entries, read };
        }),
      ],
});

export const lichessRecent = chess("lichess");
export const chesscomRecent = chess("chesscom");

// ---------- Raindrop.io, Eventbrite ----------

export const raindropRecent = activity({
  source: "raindrop",
  tools: ["list_bookmarks"],
  withhold: ["search_bookmarks"],
  whole: true,
  streams: (account) =>
    [
        stream("bookmarks", ["list_bookmarks"], async (since) => {
          const { rows } = await allRows(account, "list_bookmarks", { after: isoOf(since), limit: 50 });
          return { entries: raindropRows(rows).entries, read: rows.length };
        }),
      ],
});

/** An event ends after it starts: two more days back, so a long one that was on at the last check is still read once it's past. */
const EVENT_SLACK_MS = 2 * 86_400_000;

export const eventbriteRecent = activity({
  source: "eventbrite",
  tools: ["list_orders"],
  whole: true,
  streams: (account) =>
    [
        stream("orders", ["list_orders"], async (since, ctx) => {
          const { rows } = await allRows(account, "list_orders", { when: "past", after: isoOf(since - EVENT_SLACK_MS) });
          const today = zonedToday(new Date(ctx.now), ctx.tz);
          return { entries: eventbriteRows(rows).entries.filter((e) => e.date <= today), read: rows.length };
        }),
      ],
});

// ---------- Habits ----------

/** Habitify: one habit entry per habit a day, done (1) or not (0), its note as given. */
export function habitifyRows(date: string, rows: Row[]): Dated[] {
  return rows.flatMap((h) => {
    const id = str(h.habit_id);
    const name = str(h.name);
    if (!id || !name) return [];
    return [{ date, entry: { kind: "habit", source: "habitify", external_id: `${id}:${date}`, title: name, count: h.done === true ? 1 : 0, group: "habits", ...(str(h.note) ? { note: str(h.note) } : {}) } as EntryInput }];
  });
}

/** Todoist: routines done that day (recurring, or labelled habit). It can't say what was missed. */
export function todoistRows(date: string, rows: Row[]): Dated[] {
  return rows.flatMap((t) => {
    const id = str(t.task_id);
    const name = str(t.name);
    if (!id || !name) return [];
    return [{ date, entry: clean({ kind: "habit", source: "todoist", external_id: `${id}:${date}`, title: name, group: "habits", at: str(t.at) }) }];
  });
}

const habits = (source: "habitify" | "todoist", tool: string, map: (date: string, rows: Row[]) => Dated[], withhold: string[]) =>
  activity({
  source,
  tools: [tool],
  withhold,
  whole: true,
  streams: (account) =>
    [
        stream("habits", [tool], async (since, ctx) => {
          const entries: Dated[] = [];
          let read = 0;
          for (const date of daysFrom(since, ctx)) {
            const { rows } = await allRows(account, tool, { date });
            read += rows.length;
            entries.push(...map(date, rows));
          }
          return { entries, read };
        }),
      ],
});

export const habitifyRecent = habits("habitify", "habits_on", habitifyRows, ["habit_logs"]);
export const todoistRecent = habits("todoist", "routines_on", todoistRows, ["completed_tasks", "completed_events"]);

// ---------- Reddit ----------

/** The owner's post or comment: the post's title, the community, the link. A private community is its name only; nsfw is "Posted in r/…" alone. */
export function redditPosted(r: Row): Dated | null {
  const date = str(r.date);
  const community = str(r.community);
  if (!date || !community) return null;
  const comment = r.kind === "comment";
  const link = str(r.link);
  if (r.private === true) return { date, entry: { kind: "posted", source: "reddit", external_id: `private:${hash(`${r.kind}\u0000${date}\u0000${r.time ?? ""}\u0000${community}`)}`, title: comment ? `Commented in ${community}` : `Posted in ${community}` } };
  if (!link) return null;
  if (r.nsfw === true) return { date, entry: { kind: "posted", source: "reddit", external_id: link, title: `Posted in ${community}` } };
  const title = comment ? str(r.on) : str(r.title);
  return { date, entry: clean({ kind: "posted", source: "reddit", external_id: link, title: title ?? (comment ? `Commented in ${community}` : `Posted in ${community}`), subtitle: community, url: link, note: comment ? "comment" : undefined }) };
}

/** A saved or upvoted item, on today: its post's title, the community, the link. nsfw or private: "Saved a post in r/…" alone. */
export function redditSaved(r: Row, how: "saved" | "upvoted", today: string): Dated | null {
  const community = str(r.community);
  const link = str(r.link);
  if (!community) return null;
  const id = `${how}:${link ?? hash(`${r.date ?? ""}\u0000${r.time ?? ""}\u0000${community}`)}`;
  if (r.private === true || r.nsfw === true || !link) return { date: today, entry: { kind: "saved", source: "reddit", external_id: id, title: `Saved a post in ${community}` } };
  const title = r.kind === "comment" ? str(r.on) : str(r.title);
  return { date: today, entry: clean({ kind: "saved", source: "reddit", external_id: id, title: title ?? `Saved a post in ${community}`, subtitle: community, url: link, note: how === "upvoted" ? "upvoted" : undefined }) };
}

export const redditRecent = activity({
  source: "reddit",
  tools: ["my_posts", "my_comments", "my_saved", "my_upvoted"],
  whole: true,
  streams(account) {
    const posted = (tool: string) =>
      stream(tool, [tool], async (since) => {
        const { rows } = await allRows(account, tool, { after: isoOf(since), limit: 100 });
        return { entries: rows.map(redditPosted).filter((e): e is Dated => !!e), read: rows.length };
      });
    const saved = (tool: string, how: "saved" | "upvoted") =>
      stream(tool, [tool], async (_since, ctx) => {
        // No dates: the first page, and anything not seen before goes on today. The first check only remembers what's there.
        const r = await account.call(tool, { limit: 25 });
        if (r.isError) throw new Error(r.text.slice(0, 300));
        const rows = ((JSON.parse(r.text) as Row).items as Row[] | undefined) ?? [];
        const today = zonedToday(new Date(ctx.now), ctx.tz);
        const items = rows.map((row) => redditSaved(row, how, today)).filter((e): e is Dated => !!e);
        const seen = ctx.state.seen as string[] | undefined;
        const keys = items.map((e) => hash(e.entry.external_id));
        ctx.state.seen = [...new Set([...keys, ...(seen ?? [])])].slice(0, KEEP_SEEN);
        if (!seen) return { entries: [], read: rows.length };
        return { entries: items.filter((_e, i) => !seen.includes(keys[i])), read: rows.length };
      });
    return [posted("my_posts"), posted("my_comments"), saved("my_saved", "saved"), saved("my_upvoted", "upvoted")];
  },
});

// ---------- Bluesky, Mastodon ----------

const SOCIAL_NAME = { bluesky: "Bluesky", mastodon: "Mastodon" } as const;

/** The owner's first words, about 80 characters: no @handles, no links. */
export function firstWords(text: string | undefined, max = 80): string {
  const t = (text ?? "")
    .replace(/(^|[\s(])@[\w.-]+(?:@[\w.-]+)?/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** One post's title: the warning alone, "Replied: …", "Quoted a post", or the first words. */
export function postTitle(p: Row): string {
  const cw = str(p.content_warning);
  if (cw) return cw;
  const words = firstWords(str(p.text));
  if (p.kind === "reply") return words ? `Replied: ${words}` : "Replied";
  if (p.quote === true) return "Quoted a post";
  return words || "Posted";
}

const likesOf = (p: Row) => num(p.likes) ?? num(p.favourites) ?? 0;

/**
 * A day's posts: one posted entry each, or on a busy day (more than 10)
 * one entry with the count plus the 3 most liked. `tally` counts each post
 * once, whichever way the day is written.
 */
export function socialDay(source: "bluesky" | "mastodon", date: string, rows: Row[]): { entries: Dated[]; tally: Tally[]; keep?: string[] } {
  const posts = rows.filter((p) => str(p.link));
  const tally = posts.map((p) => ({ key: `${source}\u0000${str(p.link)}`, word: "post" as const, n: 1, date }));
  const one = (p: Row, note?: string): Dated => ({ date, entry: clean({ kind: "posted", source, external_id: str(p.link)!, title: postTitle(p), url: str(p.link), note }) });
  if (posts.length <= BUSY_DAY) return { entries: posts.map((p) => one(p)), tally };
  const top = [...posts].sort((a, b) => likesOf(b) - likesOf(a)).slice(0, 3);
  const entries = [{ date, entry: { kind: "posted", source, external_id: `posts:${date}`, title: `${posts.length} posts on ${SOCIAL_NAME[source]}`, count: posts.length } as EntryInput }, ...top.map((p) => one(p, TOP_NOTE))];
  // The day's single posts written before it got busy go: the count entry stands for them.
  return { entries, tally, keep: entries.map((e) => e.entry.external_id) };
}

/** A busy day's most liked posts: counted in the day's count entry, not again. */
export const TOP_NOTE = "one of the day's most liked";

const social = (source: "bluesky" | "mastodon") =>
  activity({
  source,
  tools: ["my_posts"],
  whole: true,
  streams: (account) =>
    [
        stream("posts", ["my_posts"], async (since, ctx) => {
          const out: RecentRead = { entries: [], tally: [], drop: [], read: 0 };
          for (const date of daysFrom(since, ctx)) {
            const { rows } = await allRows(account, "my_posts", { date });
            out.read += rows.length;
            const d = socialDay(source, date, rows);
            out.entries.push(...d.entries);
            out.tally!.push(...d.tally);
            if (d.keep) out.drop!.push({ date, source, kind: "posted", keep: d.keep });
          }
          return out;
        }),
      ],
});

export const blueskyRecent = social("bluesky");
export const mastodonRecent = social("mastodon");

// ---------- Health days ----------

/** day_summary's answer as a health day, or null when it has no figures (nothing worn, nothing logged) or won't read. */
export function healthDayOf(raw: unknown, source: HealthSource, today: string): HealthDay | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    const day = readHealthDay({ ...(raw as Row), source }, { today, source });
    const { date: _d, source: _s, workouts, ...rest } = day;
    return Object.keys(rest).length || workouts?.length ? day : null;
  } catch (error) {
    if (error instanceof HealthInputError) return null;
    throw error;
  }
}

/** What a health day counts as in the run's line: each workout, and a day with other figures. Hashes only. */
export function healthTally(day: HealthDay): Tally[] {
  const { date, source, workouts, ...rest } = day;
  const out: Tally[] = (workouts ?? []).map((w, i) => ({ key: `${source}\u0000${date}\u0000${w.start ?? i}\u0000${w.type}`, word: "workout", n: 1, date }));
  if (Object.keys(rest).length) out.push({ key: `${source}\u0000${date}`, word: "health day", n: 1, date });
  return out;
}

const health = (source: HealthSource & ("strava" | "oura" | "withings" | "whoop" | "polar"), withhold: string[]) =>
  activity({
  source,
  tools: ["day_summary"],
  withhold,
  whole: true,
  health: true,
  streams: (account) =>
    [
        stream("days", ["day_summary"], async (since, ctx) => {
          const today = zonedToday(new Date(ctx.now), ctx.tz);
          const days = new Set(daysFrom(Math.min(since, ctx.now - (HEALTH_DAYS - 1) * 86_400_000), ctx));
          for (let i = 0; i < HEALTH_DAYS; i++) days.add(addDays(today, -i));
          // Polar: the days a watch synced late, when the owner allows it (asking clears Polar's list).
          if (source === "polar" && ctx.allowed.has("changed_days")) {
            const r = await account.call("changed_days", {});
            if (!r.isError) for (const d of ((JSON.parse(r.text) as Row).items as unknown[] | undefined) ?? []) if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d >= addDays(today, -28)) days.add(d);
          }
          const out: RecentRead = { entries: [], health: [], tally: [], read: 0 };
          for (const date of [...days].sort()) {
            const r = await account.call("day_summary", { date });
            if (r.isError) throw new Error(r.text.slice(0, 300));
            out.read++;
            const day = healthDayOf(JSON.parse(r.text), source, today);
            if (!day) continue;
            out.health!.push(day);
            out.tally!.push(...healthTally(day));
          }
          return out;
        }),
      ],
});

export const stravaRecent = health("strava", ["activities"]);
export const ouraRecent = health("oura", ["daily_sleep", "daily_readiness", "daily_activity", "workouts", "sessions", "tags"]);
export const withingsRecent = health("withings", ["body_measures", "daily_activity", "daily_sleep"]);
export const whoopRecent = health("whoop", ["sleep", "workouts"]);
export const polarRecent = health("polar", ["exercises", "daily_activity", "sleep", "changed_days"]);
