/**
 * Days: one record per calendar day in the owner's time zone (migration
 * 0032; the shapes are lib/day-types.ts). Days replace the Life log's day
 * notes (owner decision, 7 Nov 2026).
 *
 * What a day holds, and where each part lives:
 *  - entries (day_entries): what was watched, listened to, read, played,
 *    posted and saved, one row each, written by a Life log run
 *    (athena_day_entry) and by the Netflix, Goodreads and YouTube imports.
 *    Deduped by (source, the source's own id): saving the same item again
 *    updates it. The source's id is matched by blind index, the text sealed.
 *  - the line (days.line): one written sentence about the day, from the run
 *    (athena_day_line) until the owner edits it; then it's theirs.
 *  - mood and journal (days.private): sealed under the data key like a
 *    health day; refused without the key.
 *  - photos (day_files): files, kept while the day uses them.
 *  - health and places: their sealed rows (lib/health.ts,
 *    lib/places-visits.ts), opened here when a day is read. Nothing of them
 *    is copied into the day.
 *  - notes and events: whatever is dated that day, found when it's read.
 *
 * Folding. The same film, episode or book twice on one day (two sources,
 * or one source under two ids, like Goodreads' shelf and its export) is
 * one entry: the second copy is kept but points at the first
 * (folded_into), which takes its rating, link and episode numbers when it
 * has none. That's how Trakt's line for a Netflix episode joins it.
 */
import { swapJournalSection } from "./checkin-journal";
import { randomUUID } from "node:crypto";
import { blindIndexes, dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { isEncryptedPlaceholder } from "./encrypted";
import { accountOf } from "./todo-context";
import { addDays, daysBetween, isValidDate, zonedParts, zonedToInstant, zonedToday } from "./dates";
import { AthenaInputError, getOwnerTimeZone, q, qRaw, sealer } from "./db";
import { touchDays } from "./day-touch";
import { readHours, sameHours } from "./day-hours";
import { healthLine, loadHealthPrefs, mergeSources, readHealthDays, workoutPhrase, type HealthFigures } from "./health";
import { placeDays, type PlaceDay } from "./places-visits";
import { dayHome, dayMoney, loadMoneyPrefs, readHomeDays, readMoneyDays } from "./money";
import { headline, markMatches, parseQuery, score, type SearchField, type TextQuery } from "./text-search";
import { toStars, SYNC_SOURCES, type SyncSource } from "./watch-read-sync";
import {
  DAY_ENTRY_KINDS,
  isDayEntryKind,
  MAX_DAY_PHOTOS,
  MAX_JOURNAL_CHARS,
  MAX_LINE_CHARS,
  MAX_RANGE_DAYS,
  type Day,
  type DayArt,
  type DayCounts,
  type DayEntry,
  type DayEntryKind,
  type DayEvent,
  type DayHealth,
  type DayHome,
  type DayMoney,
  type DayNote,
  type DayPatch,
  type DayPhoto,
  type DaySearch,
  type DaySearchFilters,
  type DaySearchHit,
  type DaysRange,
  type DaySummary,
  type Mood,
  calendarLabelOrder,
} from "./day-types";

export * from "./day-types";
export { touchDays } from "./day-touch";

// ---------- Reading what a writer sends ----------

/** One entry as a writer gives it: the run's athena_day_entry, an import, the conversion. */
export interface EntryInput {
  kind: DayEntryKind;
  source: string;
  /** The source's own id for the item, stable across runs. */
  external_id: string;
  title: string;
  subtitle?: string;
  at?: string;
  url?: string;
  rating?: number;
  count?: number;
  minutes?: number;
  group?: string;
  note?: string;
  /** Plays per local hour, 0-23 (lib/day-hours.ts), for a listened entry whose source gives play times. */
  hours?: number[];
}

export const MAX_ENTRIES_PER_WRITE = 500;
/** The collection converted Life log notes' entries carry (lib/days-convert.ts): a source's own entry for the same thing takes over from them. */
export const CONVERTED = "life-log-note";
const SOURCE_RE = /^[a-z][a-z0-9_]{1,29}$/;

/** One line of plain text: control characters and runs of spaces go, capped at `max`. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** An http(s) link, or undefined. Nothing else is ever stored as a link. */
export function cleanUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 2000) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// ---------- Links written into an entry's words ----------
//
// A run sometimes writes "Blackstar [link](https://open.spotify.com/…)" into a
// title, subtitle or note instead of giving url (the collection rules ask for
// Markdown in notes). Words stay words; the first whole link becomes url.

const LINKISH = /https?:\/\//i;
/** [label](https://…), with an optional <> around the address and an optional "title". */
const MD_LINK = /!?\[([^[\]]*)\]\(\s*<?(https?:\/\/[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/gi;
/** A Markdown link cut off by a length cap: "[link](https://open.spotify.com/tr…". */
const CUT_MD_LINK = /!?\[([^[\]]*)\]\(\s*<?https?:\/\/\S*$/i;
const BARE_URL = /<?\bhttps?:\/\/[^\s<>]+>?/gi;
/** Labels that only say "here's a link": dropped, never kept as words. */
const LINK_WORD = /^(?:link|links|url|here|source|more|(?:(?:open|listen|watch|view|read|play)(?:\s+(?:it|this|on|in|at|with))?(?:\s+[\w.]+)?)|spotify|last\.?fm|youtube|trakt|letterboxd|goodreads|plex|jellyfin|steam|reddit|bluesky|mastodon|readwise)$/i;

const linkWord = (label: string) => {
  const l = label.replace(/[^\p{L}\p{N}.\s]+/gu, " ").replace(/\s+/g, " ").trim();
  return !l || LINK_WORD.test(l) || LINKISH.test(label);
};

/** A link worth keeping: whole (not cut off with "…"), http(s), trailing sentence punctuation left off. */
function wholeUrl(raw: string): string | undefined {
  let u = raw.replace(/^<|>$/g, "").replace(/[.,;:!?'"]+$/, "");
  if (/…$/.test(u)) return undefined;
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return cleanUrl(u);
}

/** Separators and brackets a removed link leaves behind. */
const tidy = (s: string) =>
  s
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)\]])/g, "$1")
    .replace(/(?:\s*[·•|–—]\s*){2,}/g, " · ")
    .replace(/^[\s·•|,;:–—-]+|[\s·•|,;:(–—-]+$/g, "")
    .trim();

/** One piece of text with its links taken out: the words, and the first whole link in it. */
export function splitLink(text: string): { text: string; url?: string } {
  if (!LINKISH.test(text)) return { text };
  let url: string | undefined;
  const take = (raw: string) => {
    url ??= wholeUrl(raw);
  };
  const s = text
    .replace(MD_LINK, (_m, label: string, href: string) => {
      take(href);
      return linkWord(label) ? " " : ` ${label.trim()} `;
    })
    .replace(CUT_MD_LINK, (_m, label: string) => (linkWord(label) ? " " : ` ${label.trim()} `))
    .replace(BARE_URL, (m) => {
      take(m);
      return " ";
    });
  return url ? { text: tidy(s), url } : { text: tidy(s) };
}

/**
 * An entry with links taken out of its title, subtitle and note: the words
 * stay, and the first whole link becomes url when it has none (a url it has
 * is kept). Returns the same object when there's nothing to take out, so a
 * caller can tell "changed" by identity.
 */
export function unlinkEntry<T extends { title: string; subtitle?: string; note?: string; url?: string }>(e: T): T {
  if (!LINKISH.test(e.title) && !LINKISH.test(e.subtitle ?? "") && !LINKISH.test(e.note ?? "")) return e;
  const title = splitLink(e.title);
  const subtitle = e.subtitle ? splitLink(e.subtitle) : undefined;
  const note = e.note ? splitLink(e.note) : undefined;
  const url = e.url || title.url || subtitle?.url || note?.url;
  const out: T = { ...e, title: title.text || (url ? new URL(url).hostname.replace(/^www\./, "") : e.title) };
  if (subtitle?.text) out.subtitle = subtitle.text;
  else delete out.subtitle;
  if (note?.text) out.note = note.text;
  else delete out.note;
  if (url) out.url = url;
  return out;
}

/** A rating as stars (0.5–5 in halves): a number out of 5, or the source's own words ("8/10", "★★★★½"). */
export function readRating(v: unknown, source: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const as = (SYNC_SOURCES as readonly string[]).includes(source) ? (source as SyncSource) : "goodreads";
  return toStars(as, typeof v === "number" || typeof v === "string" ? v : undefined);
}

const positiveInt = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : undefined;

/** Check one entry. Throws AthenaInputError with what's wrong, in words a model or the app can act on. */
export function readEntry(raw: unknown, ctx: { source?: string } = {}): EntryInput {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kind = o.kind;
  if (!isDayEntryKind(kind)) throw new AthenaInputError(`kind: one of ${DAY_ENTRY_KINDS.join(", ")}`);
  const source = ctx.source ?? (typeof o.source === "string" ? o.source.trim().toLowerCase() : "");
  if (!SOURCE_RE.test(source)) throw new AthenaInputError("source: the service's name in lower case, like trakt or lastfm");
  const external = typeof o.external_id === "string" ? o.external_id.trim() : typeof o.external_id === "number" ? String(o.external_id) : "";
  if (!external || external.length > 300) throw new AthenaInputError("external_id: the source's own id for this item (up to 300 characters)");
  // Links come out before the length cap, so a long one is never cut in half.
  const words = unlinkEntry({
    title: cleanText(o.title, 4000),
    ...(cleanText(o.subtitle, 4000) ? { subtitle: cleanText(o.subtitle, 4000) } : {}),
    ...(cleanText(o.note, 4000) ? { note: cleanText(o.note, 4000) } : {}),
    ...(cleanUrl(o.url) ? { url: cleanUrl(o.url) } : {}),
  });
  const title = cleanText(words.title, 300);
  if (!title) throw new AthenaInputError("title: what it was, like the film's or album's name");
  let at: string | undefined;
  if (o.at !== undefined && o.at !== null && o.at !== "") {
    const t = typeof o.at === "string" ? Date.parse(o.at) : NaN;
    if (Number.isNaN(t)) throw new AthenaInputError("at: an ISO 8601 time, like 2026-11-06T21:40:00Z");
    at = new Date(t).toISOString();
  }
  const count = positiveInt(o.count, 10_000);
  const minutes = positiveInt(o.minutes, 1440);
  const out: EntryInput = { kind, source, external_id: external, title };
  const subtitle = cleanText(words.subtitle, 300);
  if (subtitle) out.subtitle = subtitle;
  if (at) out.at = at;
  if (words.url) out.url = words.url;
  const rating = readRating(o.rating, source);
  if (rating) out.rating = rating;
  if (count && count > 1) out.count = count;
  // A habit's count is done (1) or not (0): a skipped or missed habit is still on the day.
  if (kind === "habit") out.count = count === 0 ? 0 : 1;
  if (minutes !== undefined && minutes > 0) out.minutes = minutes;
  const group = cleanText(o.group, 200);
  if (group) out.group = group;
  const note = cleanText(words.note, 300);
  if (note) out.note = note;
  const hours = kind === "listened" ? readHours(o.hours) : undefined;
  if (hours) out.hours = hours;
  return out;
}

/** The day's line: one sentence, no line breaks, at most MAX_LINE_CHARS. Empty means none. */
export function readLine(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new AthenaInputError("line: text");
  const s = cleanText(raw, MAX_LINE_CHARS + 1);
  if (s.length > MAX_LINE_CHARS) throw new AthenaInputError(`line: at most ${MAX_LINE_CHARS} characters`);
  return s;
}

export function readDate(raw: unknown, what = "date"): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !isValidDate(raw)) throw new AthenaInputError(`${what}: YYYY-MM-DD`);
  return raw;
}

// ---------- Matching (folding two sources' copies of one thing) ----------

/** A title for matching: case, accents, punctuation, "&" and a leading "The" ignored. */
export function matchKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

/** The episode part of a subtitle: "S2E3 · Who Is Alive?" and "Season 2: Who Is Alive?" both give "who is alive". */
function episodeKey(subtitle: string | undefined): string {
  if (!subtitle) return "";
  const parts = subtitle.split(/\s*[·:]\s*/).filter(Boolean);
  return matchKey(parts[parts.length - 1] ?? "");
}

/** Kinds where two sources often log the same thing on the same day. */
const FOLDS: ReadonlySet<DayEntryKind> = new Set(["watched", "read"]);

/** Is `b` the same thing as `a` (same day and kind assumed)? Same title, and the same episode when both name one. */
export function sameThing(a: Pick<EntryInput, "title" | "subtitle">, b: Pick<EntryInput, "title" | "subtitle">): boolean {
  if (matchKey(a.title) !== matchKey(b.title)) return false;
  const ea = episodeKey(a.subtitle);
  const eb = episodeKey(b.subtitle);
  return !ea || !eb || ea === eb || /^\d{4}$/.test(ea) || /^\d{4}$/.test(eb);
}

const NUMBERED = /\bS\d+\s?E\d+/i;

/** What the kept entry takes from a copy folded into it: what it lacks. */
export function foldInto(keep: EntryInput, copy: EntryInput): Partial<EntryInput> {
  const take: Partial<EntryInput> = {};
  if (!keep.rating && copy.rating) take.rating = copy.rating;
  if (!keep.url && copy.url) take.url = copy.url;
  if (!keep.note && copy.note) take.note = copy.note;
  if (copy.subtitle && (!keep.subtitle || (NUMBERED.test(copy.subtitle) && !NUMBERED.test(keep.subtitle)))) take.subtitle = copy.subtitle;
  if (!keep.at && copy.at) take.at = copy.at;
  return take;
}

// ---------- Writing entries ----------

interface EntryRow {
  id: string;
  date: string;
  kind: DayEntryKind;
  source: string;
  external_id: string;
  ext_key: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  grp: string | null;
  note: string | null;
  at: string | null;
  rating: string | null;
  count: number;
  minutes: number | null;
  art: DayArt | null;
  hours: string | null;
  position: number;
  folded_into: string | null;
  collection: string | null;
  archived_at: string | null;
  updated_at: string;
}

const ENTRY_COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, kind, source, external_id, ext_key, title, subtitle, url, grp, note,
  to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, rating::text AS rating, count, minutes, art, hours, position, folded_into, collection, archived_at, updated_at`;

/** The source's id as it's matched: its blind index under each key we hold (the current one first), or the id itself before encryption. */
export function extKeys(source: string, externalId: string): string[] {
  const keys = blindIndexes("other", `day\u0000${source}\u0000${externalId}`);
  return keys.length ? keys : [externalId];
}

const asInput = (r: EntryRow): EntryInput => ({
  kind: r.kind,
  source: r.source,
  external_id: r.external_id,
  title: r.title,
  ...(r.subtitle ? { subtitle: r.subtitle } : {}),
  ...(r.at ? { at: r.at } : {}),
  ...(r.url ? { url: r.url } : {}),
  ...(r.rating ? { rating: Number(r.rating) } : {}),
  ...(r.count !== 1 ? { count: r.count } : {}),
  ...(r.minutes ? { minutes: r.minutes } : {}),
  ...(r.grp ? { group: r.grp } : {}),
  ...(r.note ? { note: r.note } : {}),
});

/** The fields that make an entry what it is, in one order, for "did anything change?". */
const canon = (e: EntryInput) =>
  JSON.stringify([e.kind, e.title, e.subtitle ?? null, e.at ? new Date(e.at).toISOString() : null, e.url ?? null, e.rating ?? null, e.count ?? 1, e.minutes ?? null, e.group ?? null, e.note ?? null]);

const same = (a: EntryInput, b: EntryInput, date: string, rowDate: string) => date === rowDate && canon(a) === canon(b);

export interface WriteResult {
  created: number;
  updated: number;
  unchanged: number;
  /** The owner hid it: left alone. */
  skipped: number;
  /** Of created and updated, folded into another source's entry for the same thing. */
  folded: number;
  /** Days that had no entries before this write. */
  new_days: string[];
  /** Days with an entry created or changed. */
  changed_days: string[];
  /** What happened to each item, in the order given, and the day it's on (an item keeps its first day). */
  outcomes: Array<{ action: "created" | "updated" | "unchanged" | "skipped"; date: string }>;
}

export interface WriteContext {
  /** The collection that wrote it (its source, "life-log-personal"), or the import's. */
  collection?: string;
  runId?: string;
  /** A history backfill wrote it (netlify/lib/connectors/backfill.ts): a new row is marked so it never counts as new. */
  backfilled?: boolean;
}

/**
 * Save entries for one or more days. Deduped by (source, external_id): the
 * same item again updates its row, wherever it was. An entry the owner hid
 * stays hidden. Watched and read entries that match another source's on
 * the same day fold into it.
 */
export async function writeEntries(items: Array<{ date: string; entry: EntryInput }>, ctx: WriteContext = {}): Promise<WriteResult> {
  const result: WriteResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, folded: 0, new_days: [], changed_days: [], outcomes: [] };
  if (!items.length) return result;
  if (items.length > MAX_ENTRIES_PER_WRITE) throw new AthenaInputError(`At most ${MAX_ENTRIES_PER_WRITE} entries at once`);
  const s = await sealer();
  const dates = [...new Set(items.map((i) => i.date))];
  // The days' live entries, opened: to fold into, and to know which days are new.
  const onDays = await q<EntryRow>(`SELECT ${ENTRY_COLS} FROM day_entries WHERE date = ANY($1::date[]) ORDER BY created_at`, [dates]);
  const hadEntries = new Set(onDays.filter((r) => !r.archived_at).map((r) => r.date));
  const changed = new Set<string>();
  const nextPosition = new Map<string, number>();
  for (const r of onDays) nextPosition.set(r.date, Math.max(nextPosition.get(r.date) ?? 0, r.position + 1));

  for (const item of items) {
    // Every writer, not only readEntry's: imports and the conversion too.
    const entry = { ...unlinkEntry(item.entry) };
    // Hours only on music, and only well formed (lib/day-hours.ts).
    if (entry.hours !== undefined) {
      const h = entry.kind === "listened" ? readHours(entry.hours) : undefined;
      if (h) entry.hours = h;
      else delete entry.hours;
    }
    let date = item.date;
    const keys = extKeys(entry.source, entry.external_id);
    const [prev] = await q<EntryRow>(`SELECT ${ENTRY_COLS} FROM day_entries WHERE source = $1 AND ext_key = ANY($2::text[]) LIMIT 1`, [entry.source, keys]);
    if (prev?.archived_at) {
      result.skipped++;
      result.outcomes.push({ action: "skipped", date: prev.date });
      continue;
    }
    // An item keeps the day it was first logged on: a saved post or a shelf seen again on a later run stays put.
    if (prev) date = prev.date;
    // Fold: the same film, episode or book from another source that day.
    let target: EntryRow | undefined;
    // An entry others are folded into stays the one they're folded into.
    if (FOLDS.has(entry.kind) && !(prev && onDays.some((r) => r.folded_into === prev.id))) {
      target = onDays.find(
        (r) =>
          r.id !== prev?.id && r.date === date && r.kind === entry.kind && !r.folded_into && !r.archived_at &&
          (r.collection !== CONVERTED || ctx.collection === CONVERTED) && sameThing(asInput(r), entry),
      );
    }
    const folded = target?.id ?? null;
    if (prev) {
      // What other sources folded into it stays on it (their rating and link), whatever this source sends now.
      let stored = entry;
      for (const c of onDays.filter((r) => r.folded_into === prev.id && !r.archived_at)) stored = { ...stored, ...foldInto(stored, asInput(c)) };
      // Hours only ever arrive or change; an entry sent without them keeps what it has.
      const hoursNew = !!entry.hours && !sameHours(readHours(prev.hours), entry.hours);
      if (same(asInput(prev), stored, date, prev.date) && (prev.folded_into ?? null) === folded && prev.ext_key === keys[0]) {
        if (hoursNew) {
          await qRaw(`UPDATE day_entries SET hours = $2, updated_at = now() WHERE id = $1`, [prev.id, s.text(JSON.stringify(entry.hours))]);
          result.updated++;
          result.outcomes.push({ action: "updated", date });
          changed.add(date);
        } else {
          result.unchanged++;
          result.outcomes.push({ action: "unchanged", date });
        }
      } else {
        await qRaw(
          `UPDATE day_entries SET date = $2::date, kind = $3, external_id = $4, ext_key = $5, title = $6, subtitle = $7, url = $8, grp = $9, note = $10,
             at = $11::timestamptz, rating = $12, count = $13, minutes = $14, folded_into = $15, collection = COALESCE($16, collection), run_id = COALESCE($17::uuid, run_id),
             hours = COALESCE($18, hours), updated_at = now()
           WHERE id = $1`,
          [prev.id, date, stored.kind, s.text(stored.external_id), keys[0], s.text(stored.title), s.maybe(stored.subtitle ?? null), s.maybe(stored.url ?? null), s.maybe(stored.group ?? null), s.maybe(stored.note ?? null),
            stored.at ?? null, stored.rating ?? null, stored.count ?? 1, stored.minutes ?? null, folded, ctx.collection ?? null, ctx.runId ?? null, entry.hours ? s.text(JSON.stringify(entry.hours)) : null],
        );
        result.updated++;
        result.outcomes.push({ action: "updated", date });
        changed.add(date);
        if (prev.date !== date) changed.add(prev.date);
      }
    } else {
      const position = nextPosition.get(date) ?? 0;
      nextPosition.set(date, position + 1);
      const [row] = await qRaw<{ id: string }>(
        `INSERT INTO day_entries (date, kind, source, external_id, ext_key, title, subtitle, url, grp, note, at, rating, count, minutes, position, folded_into, collection, run_id, backfilled, hours)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14, $15, $16, $17, $18::uuid, $19, $20)
         ON CONFLICT (source, ext_key) DO NOTHING RETURNING id`,
        [date, entry.kind, entry.source, s.text(entry.external_id), keys[0], s.text(entry.title), s.maybe(entry.subtitle ?? null), s.maybe(entry.url ?? null), s.maybe(entry.group ?? null), s.maybe(entry.note ?? null),
          entry.at ?? null, entry.rating ?? null, entry.count ?? 1, entry.minutes ?? null, position, folded, ctx.collection ?? null, ctx.runId ?? null, ctx.backfilled ?? false,
          entry.hours ? s.text(JSON.stringify(entry.hours)) : null],
      );
      if (!row) {
        result.unchanged++;
        result.outcomes.push({ action: "unchanged", date });
        continue;
      }
      result.created++;
      result.outcomes.push({ action: "created", date });
      changed.add(date);
      onDays.push({ id: row.id, date, kind: entry.kind, source: entry.source, external_id: entry.external_id, ext_key: keys[0], title: entry.title, subtitle: entry.subtitle ?? null,
        url: entry.url ?? null, grp: entry.group ?? null, note: entry.note ?? null, at: entry.at ?? null, rating: entry.rating ? String(entry.rating) : null, count: entry.count ?? 1,
        minutes: entry.minutes ?? null, art: null, hours: entry.hours ? JSON.stringify(entry.hours) : null, position, folded_into: folded, collection: ctx.collection ?? null, archived_at: null, updated_at: new Date().toISOString() });
      // A converted note's line for the same thing gives way to the source's own entry, which takes its rating and link.
      if (!folded && ctx.collection !== CONVERTED) {
        const old = onDays.find((r) => r.id !== row.id && r.date === date && r.kind === entry.kind && r.collection === CONVERTED && !r.folded_into && !r.archived_at && sameThing(asInput(r), entry));
        if (old) {
          const take = foldInto(entry, asInput(old));
          await qRaw(`UPDATE day_entries SET folded_into = $2, updated_at = now() WHERE id = $1`, [old.id, row.id]);
          old.folded_into = row.id;
          if (take.rating || take.url || take.note) {
            await qRaw(`UPDATE day_entries SET rating = COALESCE(rating, $2), url = COALESCE(url, $3), note = COALESCE(note, $4) WHERE id = $1`, [
              row.id, take.rating ?? null, s.maybe(take.url ?? null), s.maybe(take.note ?? null),
            ]);
          }
          result.folded++;
        }
      }
    }
    if (target) {
      result.folded++;
      const take = foldInto(asInput(target), entry);
      if (Object.keys(take).length) {
        const next = { ...asInput(target), ...take };
        await qRaw(`UPDATE day_entries SET subtitle = $2, url = $3, note = $4, at = $5::timestamptz, rating = $6, updated_at = now() WHERE id = $1`, [
          target.id, s.maybe(next.subtitle ?? null), s.maybe(next.url ?? null), s.maybe(next.note ?? null), next.at ?? null, next.rating ?? null,
        ]);
        Object.assign(target, { subtitle: next.subtitle ?? null, url: next.url ?? null, note: next.note ?? null, at: next.at ?? null, rating: next.rating ? String(next.rating) : null });
      }
    }
  }
  result.changed_days = [...changed].sort();
  result.new_days = result.changed_days.filter((d) => !hadEntries.has(d));
  if (changed.size) await touchDays(result.changed_days);
  return result;
}

const sameName = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() === (b ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Put plays per hour on listened entries that already exist, matched by
 * source, day, title and artist: "Load history again" over days a Life log
 * run wrote under its own ids (netlify/lib/connectors/backfill.ts). Only
 * hours change: never the count, never a new row. Returns rows changed.
 */
export async function fillEntryHours(items: Array<{ date: string; entry: EntryInput }>): Promise<number> {
  const timed = items.flatMap((i) => {
    const hours = i.entry.kind === "listened" ? readHours(i.entry.hours) : undefined;
    return hours ? [{ date: i.date, entry: { ...i.entry, hours } }] : [];
  });
  if (!timed.length) return 0;
  const s = await sealer();
  const sources = [...new Set(timed.map((i) => i.entry.source))];
  const dates = [...new Set(timed.map((i) => i.date))];
  const rows = await q<{ id: string; date: string; source: string; title: string; subtitle: string | null; grp: string | null; hours: string | null }>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, source, title, subtitle, grp, hours FROM day_entries
      WHERE kind = 'listened' AND archived_at IS NULL AND source = ANY($1::text[]) AND date = ANY($2::date[])`,
    [sources, dates],
  );
  let changed = 0;
  const days = new Set<string>();
  for (const { date, entry } of timed) {
    const artist = entry.subtitle ?? entry.group;
    const row = rows.find((r) => r.date === date && r.source === entry.source && sameName(r.title, entry.title) && sameName(r.subtitle ?? r.grp, artist));
    if (!row || sameHours(readHours(row.hours), entry.hours)) continue;
    await qRaw(`UPDATE day_entries SET hours = $2, updated_at = now() WHERE id = $1`, [row.id, s.text(JSON.stringify(entry.hours))]);
    row.hours = JSON.stringify(entry.hours);
    changed++;
    days.add(date);
  }
  if (days.size) await touchDays([...days].sort());
  return changed;
}

/** Hide an entry (the owner's choice): a source saving it again leaves it hidden. Undo with showEntry. */
export async function hideEntry(id: string): Promise<boolean> {
  const rows = await qRaw<{ date: string }>(`UPDATE day_entries SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING to_char(date, 'YYYY-MM-DD') AS date`, [id]);
  if (rows[0]) await touchDays([rows[0].date]);
  return rows.length > 0;
}

export async function showEntry(id: string): Promise<boolean> {
  const rows = await qRaw<{ date: string }>(`UPDATE day_entries SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING to_char(date, 'YYYY-MM-DD') AS date`, [id]);
  if (rows[0]) await touchDays([rows[0].date]);
  return rows.length > 0;
}

// ---------- Added by hand ----------

/**
 * Something the owner adds to a day themselves (the day page's "Add to this
 * day"): a film, an album, a book, a game, a workout or anything else, for
 * when the app it came from isn't one Athena reads (a workout goes in with
 * the day's health instead, lib/health.ts MANUAL_HEALTH). Kept like any source's
 * entry under source 'manual', with its own id as the external id, so it
 * counts in Music, Watch & read's screen time, search and Ask like the rest.
 */
export const MANUAL_ENTRY_SOURCE = "manual";
export const MANUAL_ENTRY_KINDS = ["watched", "listened", "read", "played", "other"] as const satisfies readonly DayEntryKind[];

/** Add one entry by hand. Answers with its id (null when it folded into another source's entry for the same thing that day). */
export async function addManualEntry(date: string, raw: unknown, ctx: { today: string }): Promise<{ id: string | null; date: string; result: WriteResult["outcomes"][number]["action"] }> {
  readDate(date);
  if (date > ctx.today) throw new AthenaInputError("date: that day hasn't happened yet");
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (!(MANUAL_ENTRY_KINDS as readonly unknown[]).includes(o.kind)) throw new AthenaInputError(`kind: one of ${MANUAL_ENTRY_KINDS.join(", ")}`);
  const external_id = randomUUID();
  const entry = readEntry({ ...o, external_id }, { source: MANUAL_ENTRY_SOURCE });
  const r = await writeEntries([{ date, entry }], { collection: MANUAL_ENTRY_SOURCE });
  const [row] = await qRaw<{ id: string; folded_into: string | null }>(`SELECT id, folded_into FROM day_entries WHERE source = $1 AND ext_key = ANY($2::text[]) LIMIT 1`, [MANUAL_ENTRY_SOURCE, extKeys(MANUAL_ENTRY_SOURCE, external_id)]);
  return { id: row && !row.folded_into ? row.id : null, date, result: r.outcomes[0]?.action ?? "created" };
}

/** Delete an entry added by hand (anything else can only be hidden). False when there's no such entry. */
export async function removeManualEntry(id: string): Promise<boolean> {
  const rows = await qRaw<{ date: string }>(`DELETE FROM day_entries WHERE id = $1 AND source = $2 RETURNING to_char(date, 'YYYY-MM-DD') AS date`, [id, MANUAL_ENTRY_SOURCE]);
  if (rows[0]) await touchDays([rows[0].date]);
  return rows.length > 0;
}

// ---------- Places (the Timeline import and Swarm, through lib/places-visits.ts) ----------

/** The source a day's stops are written under. Read only where places are allowed (getDay's `places`, Ask's places questions). */
export const PLACES = "places";

/**
 * A day's named stops as entries: one "other" entry per Place (or name), in
 * the order of the day, with the minutes spent there. The day's set is
 * replaced each time its places are rebuilt; stops the owner hid stay hidden.
 */
export async function writePlaceEntries(date: string, stops: Array<{ id?: string; name: string; minutes?: number }>): Promise<WriteResult> {
  const items = stops.map((stop) => ({
    date,
    entry: {
      kind: "other" as const,
      source: PLACES,
      external_id: `${date}:${stop.id ? `place:${stop.id}` : `name:${matchKey(stop.name)}`}`,
      title: stop.name,
      ...(stop.minutes ? { minutes: Math.min(1440, stop.minutes) } : {}),
      group: "Places",
    },
  }));
  const result = await writeEntries(items, { collection: PLACES });
  // Stops no longer on the day go (they're derived from the sealed record, which is kept).
  const keep = items.flatMap((i) => extKeys(PLACES, i.entry.external_id));
  const gone = await qRaw<{ id: string }>(
    `DELETE FROM day_entries WHERE date = $1::date AND source = $2 AND archived_at IS NULL AND NOT (ext_key = ANY($3::text[])) RETURNING id`,
    [date, PLACES, keep],
  );
  if (gone.length) await touchDays([date]);
  return result;
}

// ---------- Art (days-art writes it, through these) ----------

/** Set or clear an entry's cover art. */
export async function setEntryArt(entryId: string, art: DayArt | null): Promise<void> {
  if (art && (typeof art.id !== "string" || !art.id || !(art.w > 0) || !(art.h > 0))) throw new AthenaInputError("art: id, w and h");
  const value = art ? { id: art.id, w: Math.round(art.w), h: Math.round(art.h), ...(art.tone ? { tone: String(art.tone).slice(0, 60) } : {}) } : null;
  await qRaw(`UPDATE day_entries SET art = $2::jsonb, updated_at = now() WHERE id = $1`, [entryId, value === null ? null : JSON.stringify(value)]);
}

/** Entries that have no art yet, newest days first: what an art finder works through. Only kinds that ever get art (posts, saves, chess, workouts and places never do). */
export async function entriesWithoutArt(limit = 50): Promise<Array<Pick<DayEntry, "id" | "kind" | "source" | "title" | "subtitle" | "url"> & { date: string }>> {
  const rows = await q<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM day_entries WHERE art IS NULL AND archived_at IS NULL AND folded_into IS NULL AND kind IN ('watched', 'listened', 'read', 'highlight', 'played') AND source <> 'places' ORDER BY date DESC, position LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  // Unlinked, so an entry whose link was written into its words gets art from that link.
  return rows.map((r) => {
    const e = unlinkEntry(rowEntry(r));
    return { id: r.id, date: r.date, kind: r.kind, source: r.source, title: e.title, ...(e.subtitle ? { subtitle: e.subtitle } : {}), ...(e.url ? { url: e.url } : {}) };
  });
}

/** settings key for the one-off link repair: { after: last id done } while it runs, { done: true } once through. */
export const LINK_REPAIR_KEY = "days_entry_links";

/** What the link repair writes to one stored row, or null when it's already clean. */
export function linkRepair(r: Pick<EntryRow, "title" | "subtitle" | "url" | "note">): { title: string; subtitle: string | null; url: string | null; note: string | null } | null {
  const was = { title: r.title, ...(r.subtitle ? { subtitle: r.subtitle } : {}), ...(r.note ? { note: r.note } : {}), ...(r.url ? { url: r.url } : {}) };
  const now = unlinkEntry(was);
  if (now === was) return null;
  return { title: cleanText(now.title, 300), subtitle: now.subtitle ? cleanText(now.subtitle, 300) : null, url: now.url ?? null, note: now.note ? cleanText(now.note, 300) : null };
}

/**
 * One-off: rewrite stored entries whose links were written into their words
 * (see splitLink), sealed as writeEntries seals them. Pages through by id
 * within the budget and carries on next time; idempotent, and a no-op once done.
 * Reading already shows them clean (toEntry); this gives them a url to find art by.
 */
export async function repairEntryLinks(budgetMs = 3_000): Promise<{ fixed: number; done: boolean }> {
  const started = Date.now();
  const [flag] = await qRaw<{ value: { done?: boolean; after?: string } | null }>(`SELECT value FROM settings WHERE key = $1`, [LINK_REPAIR_KEY]);
  if (flag?.value?.done) return { fixed: 0, done: true };
  let after = flag?.value?.after ?? "00000000-0000-0000-0000-000000000000";
  const s = await sealer();
  let fixed = 0;
  for (;;) {
    const rows = await q<EntryRow>(`SELECT ${ENTRY_COLS} FROM day_entries WHERE id > $1::uuid AND source <> '${PLACES}' ORDER BY id LIMIT 200`, [after]);
    for (const r of rows) {
      const next = linkRepair(r);
      if (next) {
        await qRaw(`UPDATE day_entries SET title = $2, subtitle = $3, url = $4, note = $5, updated_at = now() WHERE id = $1`, [
          r.id, s.text(next.title), s.maybe(next.subtitle), s.maybe(next.url), s.maybe(next.note),
        ]);
        fixed++;
      }
      after = r.id;
    }
    const done = rows.length < 200;
    if (done || Date.now() - started > budgetMs) {
      await qRaw(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [LINK_REPAIR_KEY, JSON.stringify(done ? { done: true } : { after })],
      );
      return { fixed, done };
    }
  }
}

// ---------- The line, mood, journal and photos ----------

interface DayRow {
  date: string;
  line: string | null;
  line_by: "run" | "owner" | null;
  private: string | null;
  updated_at: string;
}

interface Private {
  mood?: Mood;
  journal?: string;
  /** The mood was set by a check-in (mirrorCheckinDay), over mood_before: undone, the day goes back to that. */
  mood_by?: "checkin";
  mood_before?: Mood;
}

function openPrivate(sealed: string | null): Private | null {
  if (!sealed) return {};
  try {
    return JSON.parse(openStrict(sealed)) as Private;
  } catch {
    return null;
  }
}

/**
 * The run's line for a day. A line the owner wrote stays theirs: the run's
 * is not saved, and the answer says so.
 */
export async function setRunLine(date: string, raw: unknown, runId?: string): Promise<"saved" | "unchanged" | "owner_wrote_it"> {
  const line = readLine(raw);
  if (!line) throw new AthenaInputError("line: one short sentence about the day");
  const s = await sealer();
  const [prev] = await q<DayRow>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, line, line_by, private, updated_at FROM days WHERE date = $1::date`, [date]);
  if (prev?.line_by === "owner") return "owner_wrote_it";
  if (prev?.line === line) return "unchanged";
  await qRaw(
    `INSERT INTO days (date, line, line_by, line_run) VALUES ($1::date, $2, 'run', $3::uuid)
     ON CONFLICT (date) DO UPDATE SET line = EXCLUDED.line, line_by = 'run', line_run = EXCLUDED.line_run, updated_at = now()
     WHERE days.line_by IS DISTINCT FROM 'owner'`,
    [date, s.text(line), runId ?? null],
  );
  return "saved";
}

/** The owner's changes to a day: line, mood, journal, photos. */
export async function patchDay(date: string, raw: unknown, opts: { tz?: string } = {}): Promise<Day> {
  readDate(date);
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const known = new Set(["line", "mood", "journal", "photos"]);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new AthenaInputError(`Unknown field ${k}. Fields: line, mood, journal, photos`);
  const patch = o as DayPatch;
  const tz = opts.tz ?? (await getOwnerTimeZone());
  if (date > zonedToday(new Date(), tz)) throw new AthenaInputError("That day hasn't happened yet");
  const s = await sealer();
  await qRaw(`INSERT INTO days (date) VALUES ($1::date) ON CONFLICT (date) DO NOTHING`, [date]);

  if ("line" in patch) {
    const line = readLine(patch.line);
    // Clearing it hands the line back to the run; writing it makes it the owner's.
    await qRaw(`UPDATE days SET line = $2, line_by = $3, updated_at = now() WHERE date = $1::date`, [date, line ? s.text(line) : null, line ? "owner" : null]);
  }
  if ("mood" in patch || "journal" in patch) {
    if ("mood" in patch && patch.mood !== null && !(Number.isInteger(patch.mood) && (patch.mood as number) >= 1 && (patch.mood as number) <= 5)) throw new AthenaInputError("mood: 1 to 5, or null");
    let journal: string | undefined;
    if ("journal" in patch && patch.journal !== null) {
      if (typeof patch.journal !== "string") throw new AthenaInputError("journal: text, or null");
      // Line breaks are the owner's: keep them, tidy the rest.
      journal = patch.journal.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (journal.length > MAX_JOURNAL_CHARS) throw new AthenaInputError(`journal: at most ${MAX_JOURNAL_CHARS} characters`);
    }
    if (!dataKeyConfigured()) throw new DataKeyMissing();
    const [row] = await qRaw<{ private: string | null }>(`SELECT private FROM days WHERE date = $1::date`, [date]);
    const before = openPrivate(row?.private ?? null);
    if (before === null) throw new AthenaInputError("This day's mood and journal can't be opened here, so they weren't changed");
    const next: Private = { ...before };
    if ("mood" in patch) {
      if (patch.mood === null) delete next.mood;
      else next.mood = patch.mood as Mood;
      // The owner's own mood now: a check-in taking its answer back leaves it alone.
      delete next.mood_by;
      delete next.mood_before;
    }
    if ("journal" in patch) {
      if (!journal) delete next.journal;
      else next.journal = journal;
    }
    const empty = next.mood === undefined && !next.journal;
    await qRaw(`UPDATE days SET private = $2, updated_at = now() WHERE date = $1::date`, [date, empty ? null : sealText(JSON.stringify(next))]);
  }
  if (patch.photos) {
    const add = Array.isArray(patch.photos.add) ? patch.photos.add : [];
    const remove = Array.isArray(patch.photos.remove) ? patch.photos.remove : [];
    const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
    if (![...add, ...remove].every(uuid)) throw new AthenaInputError("photos: file ids from an upload");
    if (remove.length) await qRaw(`DELETE FROM day_files WHERE date = $1::date AND file_id = ANY($2::uuid[])`, [date, remove]);
    if (add.length) {
      const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM day_files WHERE date = $1::date`, [date]);
      if (n + add.length > MAX_DAY_PHOTOS) throw new AthenaInputError(`A day keeps up to ${MAX_DAY_PHOTOS} photos`);
      const added = await qRaw<{ file_id: string }>(
        `INSERT INTO day_files (date, file_id) SELECT $1::date, f.id FROM files f WHERE f.id = ANY($2::uuid[]) AND f.type LIKE 'image/%' ON CONFLICT DO NOTHING RETURNING file_id`,
        [date, add],
      );
      const have = await qRaw<{ file_id: string }>(`SELECT file_id FROM day_files WHERE date = $1::date AND file_id = ANY($2::uuid[])`, [date, add]);
      if (have.length < new Set(add).size && !added.length) throw new AthenaInputError("photos: that file isn't a photo Athena has");
    }
    await qRaw(`UPDATE days SET updated_at = now() WHERE date = $1::date`, [date]);
    if (remove.length) {
      const { sweepFiles } = await import("./files");
      await sweepFiles().catch(() => 0);
    }
  }
  return (await getDay(date, { tz, money: "prefs" }))!;
}

// ---------- Check-ins (lib/checkins.ts) ----------

export { swapJournalSection } from "./checkin-journal";

/**
 * A check-in's answers copied into the day: `mood` sets the day's mood (null takes the check-in's
 * back: the mood it replaced returns, unless the owner has set one since), and `journal` swaps the
 * check-in's section (swapJournalSection). Sealed like the owner's own; refused without the key.
 * Returns the section now in the journal, for the check-in to remember.
 */
export async function mirrorCheckinDay(date: string, change: { mood?: Mood | null; journal?: { was: string | null; now: string | null } }): Promise<{ section: string | null }> {
  readDate(date);
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  for (let attempt = 0; ; attempt++) {
    const [row] = await qRaw<{ private: string | null }>(`SELECT private FROM days WHERE date = $1::date`, [date]);
    const sealed = row?.private ?? null;
    const before = openPrivate(sealed);
    if (before === null) throw new AthenaInputError("This day's mood and journal can't be opened here, so the check-in wasn't copied to it");
    const next: Private = { ...before };
    if (change.mood !== undefined) {
      if (change.mood !== null) {
        if (next.mood_by !== "checkin") {
          if (next.mood !== undefined) next.mood_before = next.mood;
          next.mood_by = "checkin";
        }
        next.mood = change.mood;
      } else if (next.mood_by === "checkin") {
        if (next.mood_before !== undefined) next.mood = next.mood_before;
        else delete next.mood;
        delete next.mood_by;
        delete next.mood_before;
      }
    }
    let section = change.journal?.was ?? null;
    if (change.journal) {
      const swapped = swapJournalSection(before.journal, change.journal.was, change.journal.now);
      section = swapped.section;
      if (swapped.journal) next.journal = swapped.journal;
      else delete next.journal;
    }
    if (JSON.stringify(next) === JSON.stringify(before)) return { section };
    const empty = next.mood === undefined && !next.journal;
    const done = await qRaw(
      `INSERT INTO days (date, private) VALUES ($1::date, $2) ON CONFLICT (date) DO UPDATE SET private = EXCLUDED.private, updated_at = now() WHERE days.private IS NOT DISTINCT FROM $3 RETURNING 1`,
      [date, empty ? null : sealText(JSON.stringify(next)), sealed],
    );
    if (done.length) return { section };
    if (attempt >= 3) throw new AthenaInputError("The day changed while the check-in was being copied to it. Try again");
  }
}

// ---------- Counts and heat ----------

/** Points a day earns, then four steps: one scale for every calendar. */
export function heatFor(c: Omit<DayCounts, "heat">, extra: { journal?: boolean; line?: boolean } = {}): DayCounts["heat"] {
  const minutes = Object.values(c.minutes).reduce((n, m) => n + (m ?? 0), 0);
  const points =
    c.entries + Math.floor(minutes / 60) + c.photos * 2 + c.notes + Math.min(c.events, 4) * 0.5 + (extra.journal ? 2 : 0) + ((c.steps ?? 0) >= 10_000 ? 1 : 0);
  if (points <= 0 && !extra.line) return 0;
  if (points <= 2) return 1;
  if (points <= 5) return 2;
  if (points <= 10) return 3;
  return 4;
}

function countEntries(entries: Array<Pick<DayEntry, "kind" | "count" | "minutes" | "source">>): Pick<DayCounts, "entries" | "by_kind" | "minutes"> {
  const by_kind: DayCounts["by_kind"] = {};
  const minutes: DayCounts["minutes"] = {};
  let total = 0;
  for (const e of entries) {
    const n = e.count ?? 1;
    total += n;
    by_kind[e.kind] = (by_kind[e.kind] ?? 0) + n;
    // Time at a place isn't time doing something: it stays off the minutes and the heat.
    if (e.minutes && e.source !== "places") minutes[e.kind] = (minutes[e.kind] ?? 0) + e.minutes;
  }
  return { entries: total, by_kind, minutes };
}

// ---------- Reading a day ----------

export interface ReadOptions {
  tz?: string;
  /** Open the day's health figures (the app: yes; Ask: only for a health question). */
  health?: boolean;
  /** Open where the owner went and the weather. */
  places?: boolean;
  /** Open the mood and journal. */
  private?: boolean;
  /**
   * Open the day's spending and electricity (lib/money.ts). Off unless asked:
   * "prefs" (the app) opens each only when the owner turned it on in
   * Settings → Days; true (Ask, for a money question) opens both.
   */
  money?: boolean | "prefs";
}

const rowEntry = (r: EntryRow): DayEntry => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  title: r.title,
  ...(r.subtitle ? { subtitle: r.subtitle } : {}),
  ...(r.at ? { at: r.at } : {}),
  ...(r.url ? { url: r.url } : {}),
  ...(r.art ? { art: r.art } : {}),
  ...(r.rating ? { rating: Number(r.rating) } : {}),
  ...(r.count !== 1 ? { count: r.count } : {}),
  ...(r.minutes ? { minutes: r.minutes } : {}),
  ...(r.grp ? { group: r.grp } : {}),
  ...(r.note ? { note: r.note } : {}),
});

/** A stored row as the app and Ask see it: links written into its words (rows from before splitLink) read as url. */
const toEntry = (r: EntryRow): DayEntry => unlinkEntry(rowEntry(r));

/** A day's workouts as entries (never stored: they're opened from the sealed health day each time). */
function workoutEntries(date: string, f: HealthFigures): DayEntry[] {
  return (f.workouts ?? []).map((w, i) => ({
    id: `health:${date}:${i}`,
    kind: "workout" as const,
    source: "health",
    title: w.name?.trim() || workoutPhrase(w).replace(/^./, (c) => c.toUpperCase()),
    ...(w.name?.trim() ? { subtitle: workoutPhrase(w) } : {}),
    ...(w.start ? { at: w.start } : {}),
    minutes: Math.round(w.minutes),
  }));
}

function healthOf(f: HealthFigures): DayHealth {
  const { workouts, ...rest } = f;
  return { line: healthLine(f), ...rest, ...(workouts?.length ? { workouts: workouts.map(({ route: _r, elevation_m: _e, ...w }) => w) } : {}) } as DayHealth;
}

/** When the day starts and ends, as instants, in the owner's zone. */
function bounds(date: string, tz: string): [string, string] {
  return [zonedToInstant(date, "00:00", tz).toISOString(), zonedToInstant(addDays(date, 1), "00:00", tz).toISOString()];
}

async function notesOn(date: string, tz: string): Promise<DayNote[]> {
  const [start, end] = bounds(date, tz);
  return q<DayNote>(
    `SELECT id, title, type, COALESCE(source, 'manual') AS source, created_at FROM notes
     WHERE archived_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz AND COALESCE(source, '') NOT LIKE 'life-log%'
     ORDER BY created_at LIMIT 60`,
    [start, end],
  );
}

async function eventsOn(date: string, tz: string): Promise<DayEvent[]> {
  const [start, end] = bounds(date, tz);
  const rows = await q<{ id: string; title: string; kind: string; starts_at: string | null; ends_at: string | null; date: string; source: string | null; label: string | null }>(
    `SELECT e.id, e.title, e.kind, e.starts_at, e.ends_at, to_char(e.date, 'YYYY-MM-DD') AS date, e.source,
       COALESCE((SELECT NULLIF(c.label, '') FROM collections c WHERE c.source = e.source AND c.label <> '' LIMIT 1), NULLIF(k.account_label, '')) AS label
     FROM events e LEFT JOIN connectors k ON k.id = e.calendar_connector_id
     WHERE e.archived_at IS NULL AND (
       (e.starts_at >= $1::timestamptz AND e.starts_at < $2::timestamptz)
       OR (e.starts_at IS NULL AND e.recurrence = 'none' AND e.date = $3::date)
       OR (e.starts_at IS NULL AND e.recurrence = 'yearly' AND to_char(e.date, 'MM-DD') = to_char($3::date, 'MM-DD') AND e.date <= $3::date))
     ORDER BY e.starts_at NULLS FIRST LIMIT 60`,
    [start, end, date],
  );
  return rows.map((r) => {
    const label = calendarLabel(r.label, r.source);
    return { id: r.id, title: r.title, kind: r.kind, ...(r.starts_at ? { starts_at: new Date(r.starts_at).toISOString() } : { date }), ...(r.ends_at ? { ends_at: new Date(r.ends_at).toISOString() } : {}), ...(label ? { label } : {}) };
  });
}

/** Every label on the owner's calendars, in colour order: from collections that sync events and from calendar accounts. */
async function calendarLabelList(): Promise<string[]> {
  const rows = await q<{ label: string }>(
    `SELECT label FROM collections WHERE lookahead_days > 0 AND label <> ''
     UNION SELECT account_label FROM connectors WHERE provider IN ('google-calendar', 'outlook-calendar', 'icloud-calendar') AND account_label <> ''`,
  );
  return calendarLabelOrder(rows.map((r) => r.label));
}

/** An event's calendar label: the one the owner gave, else work or personal when its source says so. */
export function calendarLabel(label: string | null | undefined, source: string | null | undefined): string | null {
  const l = (label ?? "").trim().toLowerCase();
  return l || accountOf(source) || null;
}

async function photosOn(dates: string[]): Promise<Map<string, DayPhoto[]>> {
  const rows = await qRaw<{ date: string; id: string; width: number | null; height: number | null; has_thumb: boolean; created_at: string }>(
    `SELECT to_char(df.date, 'YYYY-MM-DD') AS date, f.id, f.width, f.height, f.has_thumb, df.created_at FROM day_files df JOIN files f ON f.id = df.file_id
     WHERE df.date = ANY($1::date[]) ORDER BY df.created_at`,
    [dates],
  );
  const out = new Map<string, DayPhoto[]>();
  for (const r of rows) {
    const p: DayPhoto = { id: r.id, thumb: r.has_thumb, added_at: new Date(r.created_at).toISOString(), ...(r.width ? { w: r.width } : {}), ...(r.height ? { h: r.height } : {}) };
    out.set(r.date, [...(out.get(r.date) ?? []), p]);
  }
  return out;
}

const byTime = (a: DayEntry & { position?: number }, b: DayEntry & { position?: number }) =>
  (a.at && b.at ? a.at.localeCompare(b.at) : 0) || (a.position ?? 0) - (b.position ?? 0);

/** The day's money and home lines, as far as `want` allows. Never fails the day: a row that won't open is left out. */
async function moneyAndHome(date: string, want: boolean | "prefs"): Promise<{ money?: DayMoney; home?: DayHome }> {
  if (!want) return {};
  try {
    const prefs = want === "prefs" ? await loadMoneyPrefs() : { money: true, home: true };
    if (!prefs.money && !prefs.home) return {};
    const [m, h] = await Promise.all([prefs.money ? readMoneyDays(date, date) : null, prefs.home ? readHomeDays(date, date) : null]);
    const money = m?.days.get(date);
    const home = h?.days.get(date);
    return { ...(money ? { money: dayMoney(money) } : {}), ...(home ? { home: dayHome(home) } : {}) };
  } catch {
    return {};
  }
}

/** Everything Athena has for one day, or null for a date that isn't one. Health, places and the private parts only when asked. */
export async function getDay(date: string, opts: ReadOptions = {}): Promise<Day | null> {
  if (!isValidDate(date)) return null;
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const want = { health: opts.health ?? true, places: opts.places ?? true, private: opts.private ?? true };
  const [[row], entryRows, notes, events, photos, health, places, moneyHome, calendarLabels] = await Promise.all([
    q<DayRow>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, line, line_by, private, updated_at FROM days WHERE date = $1::date`, [date]),
    q<EntryRow>(`SELECT ${ENTRY_COLS} FROM day_entries WHERE date = $1::date AND archived_at IS NULL AND folded_into IS NULL ORDER BY at NULLS LAST, position, created_at`, [date]),
    notesOn(date, tz),
    eventsOn(date, tz),
    photosOn([date]),
    want.health ? Promise.all([readHealthDays(date, date), loadHealthPrefs()]).catch(() => null) : Promise.resolve(null),
    want.places ? placeDays(date, date).catch(() => new Map<string, PlaceDay>()) : Promise.resolve(new Map<string, PlaceDay>()),
    moneyAndHome(date, opts.money ?? false),
    calendarLabelList(),
  ]);
  // A day's stops (source "places") are entries too, shown only where places are.
  const entries = entryRows.filter((r) => want.places || r.source !== PLACES).map(toEntry);
  let healthPart: DayHealth | undefined;
  if (health) {
    const [{ days }, prefs] = health;
    const sources = days.get(date);
    if (sources?.length) {
      const merged = mergeSources(sources, prefs);
      healthPart = healthOf(merged);
      entries.push(...workoutEntries(date, merged));
      entries.sort(byTime);
    }
  }
  const place = places.get(date);

  const priv = want.private ? openPrivate(row?.private ?? null) : null;
  const dayPhotos = photos.get(date) ?? [];
  const base = { ...countEntries(entries), photos: dayPhotos.length, notes: notes.length, events: events.length, ...(healthPart?.steps ? { steps: healthPart.steps } : {}) };
  const counts: DayCounts = { ...base, heat: heatFor(base, { journal: !!priv?.journal, line: !!row?.line }) };
  const updated = [row?.updated_at, ...entryRows.map((r) => r.updated_at)].filter(Boolean).map((t) => new Date(t!).toISOString()).sort().pop();
  return {
    date,
    ...(row?.line ? { line: row.line, line_by: row.line_by ?? "run" } : {}),
    ...(priv?.mood ? { mood: priv.mood } : {}),
    ...(priv?.journal ? { journal: priv.journal } : {}),
    photos: dayPhotos,
    ...(place?.weather ? { weather: place.weather } : {}),
    ...(place?.line ? { places_line: place.line } : {}),
    ...(healthPart ? { health: healthPart } : {}),
    ...moneyHome,
    places: place?.places ?? [],
    entries,
    notes,
    events,
    ...(calendarLabels.length ? { calendar_labels: calendarLabels } : {}),
    counts,
    ...(updated ? { updated_at: updated } : {}),
  };
}

// ---------- A range of days ----------

/** Every day in [from, to] that has anything, as summaries: what a calendar or a list draws. */
export async function daysRange(from: string, to: string, opts: { tz?: string } = {}): Promise<DaysRange> {
  readDate(from, "from");
  readDate(to, "to");
  if (to < from) throw new AthenaInputError("to: on or after from");
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new AthenaInputError(`At most ${MAX_RANGE_DAYS} days at once`);
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const [start] = bounds(from, tz);
  const [, end] = bounds(to, tz);
  const [dayRows, kindRows, artRows, photoRows, noteRows, eventRows, health] = await Promise.all([
    q<DayRow>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, line, line_by, private, updated_at FROM days WHERE date BETWEEN $1::date AND $2::date`, [from, to]),
    qRaw<{ date: string; kind: DayEntryKind; n: number; rows: number; minutes: number | null }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, sum(count)::int AS n, count(*)::int AS rows, (sum(minutes) FILTER (WHERE source <> 'places'))::int AS minutes FROM day_entries
       WHERE date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL GROUP BY date, kind`,
      [from, to],
    ),
    qRaw<{ date: string; art: DayArt }>(
      `SELECT date, art FROM (
         SELECT to_char(date, 'YYYY-MM-DD') AS date, art, row_number() OVER (PARTITION BY date ORDER BY count DESC, position) AS n FROM day_entries
         WHERE date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL AND art IS NOT NULL) x
       WHERE n <= 4 ORDER BY date, n`,
      [from, to],
    ),
    qRaw<{ date: string; n: number; first: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, count(*)::int AS n, (array_agg(file_id ORDER BY created_at))[1]::text AS first FROM day_files
       WHERE date BETWEEN $1::date AND $2::date GROUP BY date`,
      [from, to],
    ),
    qRaw<{ date: string; n: number }>(
      `SELECT to_char((created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date, count(*)::int AS n FROM notes
       WHERE archived_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz AND COALESCE(source, '') NOT LIKE 'life-log%' GROUP BY 1`,
      [start, end, tz],
    ),
    qRaw<{ date: string; n: number }>(
      `SELECT to_char((starts_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS date, count(*)::int AS n FROM events
       WHERE archived_at IS NULL AND starts_at >= $1::timestamptz AND starts_at < $2::timestamptz GROUP BY 1
       UNION ALL
       SELECT to_char(date, 'YYYY-MM-DD'), count(*)::int FROM events
       WHERE archived_at IS NULL AND starts_at IS NULL AND recurrence = 'none' AND date BETWEEN $4::date AND $5::date GROUP BY date`,
      [start, end, tz, from, to],
    ),
    Promise.all([readHealthDays(from, to), loadHealthPrefs()]).catch(() => null),
  ]);
  const all = new Map<string, { row?: DayRow; kinds: typeof kindRows; art: DayArt[]; photos?: { n: number; first: string }; notes: number; events: number; steps?: number; workouts: Array<{ minutes: number }> }>();
  const at = (date: string) => {
    let d = all.get(date);
    if (!d) all.set(date, (d = { kinds: [], art: [], notes: 0, events: 0, workouts: [] }));
    return d;
  };
  for (const r of dayRows) at(r.date).row = r;
  for (const r of kindRows) at(r.date).kinds.push(r);
  for (const r of artRows) at(r.date).art.push(r.art);
  for (const r of photoRows) at(r.date).photos = { n: r.n, first: r.first };
  for (const r of noteRows) at(r.date).notes += r.n;
  for (const r of eventRows) at(r.date).events += r.n;
  if (health) {
    const [{ days }, prefs] = health;
    for (const [date, sources] of days) {
      const m = mergeSources(sources, prefs);
      const d = at(date);
      if (m.steps) d.steps = m.steps;
      d.workouts = (m.workouts ?? []).map((w) => ({ minutes: Math.round(w.minutes) }));
    }
  }
  const out: DaySummary[] = [];
  for (const [date, d] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const by_kind: DayCounts["by_kind"] = {};
    const minutes: DayCounts["minutes"] = {};
    let entries = 0;
    for (const k of d.kinds) {
      by_kind[k.kind] = (by_kind[k.kind] ?? 0) + k.n;
      if (k.minutes) minutes[k.kind] = (minutes[k.kind] ?? 0) + k.minutes;
      entries += k.n;
    }
    if (d.workouts.length) {
      by_kind.workout = (by_kind.workout ?? 0) + d.workouts.length;
      minutes.workout = (minutes.workout ?? 0) + d.workouts.reduce((n, w) => n + w.minutes, 0);
      entries += d.workouts.length;
    }
    const priv = openPrivate(d.row?.private ?? null);
    const base = { entries, by_kind, minutes, photos: d.photos?.n ?? 0, notes: d.notes, events: d.events, ...(d.steps ? { steps: d.steps } : {}) };
    const counts: DayCounts = { ...base, heat: heatFor(base, { journal: !!priv?.journal, line: !!d.row?.line }) };
    if (!counts.heat && !priv?.mood) continue;
    out.push({
      date,
      ...(d.row?.line ? { line: d.row.line } : {}),
      ...(priv?.mood ? { mood: priv.mood } : {}),
      counts,
      art: d.art,
      ...(d.photos ? { photo: d.photos.first } : {}),
      journal: !!priv?.journal,
      ...habitsOf(d.kinds),
    });
  }
  return { from, to, days: out };
}

/** A day's habits for the calendar's "Colour days by: Habits": done of logged (count 1 done, 0 not). */
function habitsOf(kinds: Array<{ kind: DayEntryKind; n: number; rows: number }>): { habits?: { done: number; of: number } } {
  const h = kinds.find((k) => k.kind === "habit");
  return h?.rows ? { habits: { done: h.n, of: h.rows } } : {};
}

// ---------- Search ----------

export const SEARCH_LIMIT = 40;

/** What each kind is called in a snippet. */
export const KIND_WORD: Record<DayEntryKind, string> = {
  watched: "Watched",
  listened: "Listened",
  read: "Read",
  highlight: "Highlights",
  played: "Played",
  posted: "Posted",
  saved: "Saved",
  chess: "Chess",
  workout: "Workout",
  habit: "Habit",
  other: "Other",
};

/**
 * Entries, day lines and (with `journal`) journals matching a query, best
 * first. Text is sealed, so it's opened and scored here (lib/text-search.ts).
 */
export async function searchDays(
  query: string | TextQuery,
  opts: { kind?: DayEntryKind; from?: string; to?: string; limit?: number; journal?: boolean; places?: boolean; source?: string; dates?: Set<string> } = {},
): Promise<DaySearchHit[]> {
  const parsed = typeof query === "string" ? parseQuery(query.trim()) : query;
  if (!parsed) return [];
  const where = ["archived_at IS NULL", "folded_into IS NULL", ...(opts.places ? [] : [`source <> '${PLACES}'`])];
  const params: unknown[] = [];
  if (opts.kind) (params.push(opts.kind), where.push(`kind = $${params.length}`));
  if (opts.source) (params.push(opts.source), where.push(`source = $${params.length}`));
  if (opts.dates) (params.push([...opts.dates]), where.push(`date = ANY($${params.length}::date[])`));
  if (opts.from) (params.push(readDate(opts.from, "from")), where.push(`date >= $${params.length}::date`));
  if (opts.to) (params.push(readDate(opts.to, "to")), where.push(`date <= $${params.length}::date`));
  const dateWhere = [opts.from ? `date >= '${opts.from}'::date` : "", opts.to ? `date <= '${opts.to}'::date` : ""].filter(Boolean);
  const [rows, dayRows] = await Promise.all([
    q<EntryRow>(`SELECT ${ENTRY_COLS} FROM day_entries WHERE ${where.join(" AND ")}`, params),
    q<DayRow>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, line, line_by, private, updated_at FROM days ${dateWhere.length ? `WHERE ${dateWhere.join(" AND ")}` : ""}`),
  ]);
  const lines = new Map(dayRows.filter((d) => d.line).map((d) => [d.date, d.line!]));
  const hits: DaySearchHit[] = [];
  const field = (text: string | null | undefined, weight: number): SearchField => ({ text: text && !isEncryptedPlaceholder(text) ? text : "", weight });
  for (const r of rows) {
    const rank = score(parsed, [field(r.title, 1), field(r.subtitle, 0.6), field(r.grp, 0.4), field(r.note, 0.3), field(KIND_WORD[r.kind], 0.05), field(r.source, 0.05)]);
    if (rank <= 0) continue;
    const words = [r.title, r.subtitle].filter(Boolean).join(" · ");
    hits.push({ date: r.date, match: "entry", entry: toEntry(r), ...(lines.has(r.date) ? { line: lines.get(r.date) } : {}), snippet: `${KIND_WORD[r.kind]}: ${markMatches(words, parsed)}`, rank });
  }
  // A line or journal is the day's own words: only when no entry filter is on.
  if (!opts.kind && !opts.source) {
    for (const d of dayRows) {
      if (opts.dates && !opts.dates.has(d.date)) continue;
      if (d.line) {
        const rank = score(parsed, [field(d.line, 0.8)]);
        if (rank > 0) hits.push({ date: d.date, match: "line", line: d.line, snippet: markMatches(d.line, parsed), rank });
      }
      if (opts.journal && d.private) {
        const p = openPrivate(d.private);
        if (p?.journal) {
          const rank = score(parsed, [field(p.journal, 0.5)]);
          if (rank > 0) hits.push({ date: d.date, match: "journal", ...(d.line ? { line: d.line } : {}), snippet: markMatches(headline(p.journal, parsed), parsed), rank });
        }
      }
    }
  }
  return hits.sort((a, b) => b.rank - a.rank || b.date.localeCompare(a.date)).slice(0, Math.max(1, Math.min(200, opts.limit ?? SEARCH_LIMIT)));
}

/** "Friday 6 November" (with the year when it isn't this year's). */
export function dayWords(date: string, today: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const words = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const [weekday, ...rest] = words.replace(",", "").split(" ");
  return `${weekday} ${rest.join(" ")}${date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`}`;
}

/** Today in the owner's zone (exported for routes and tests). */
export async function ownerToday(now = new Date()): Promise<string> {
  return zonedParts(now, await getOwnerTimeZone()).date;
}

// ---------- After a key rotation ----------

/** Re-seal mood and journal still under an old key (lib/encryption.ts calls this; the line and entries go with the backfill). */
export async function resealDays(budgetMs = 5_000): Promise<{ resealed: number; failed: number }> {
  const { currentKeyId } = await import("./data-box");
  const kid = currentKeyId();
  const report = { resealed: 0, failed: 0 };
  if (!kid) return report;
  const started = Date.now();
  const rows = await qRaw<{ date: string; private: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, private FROM days WHERE private IS NOT NULL AND private NOT LIKE $1 LIMIT 200`, [`enc:v1:${kid}:%`]);
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    try {
      await qRaw(`UPDATE days SET private = $3 WHERE date = $1::date AND private = $2`, [r.date, r.private, sealText(openStrict(r.private))]);
      report.resealed++;
    } catch {
      report.failed++;
    }
  }
  return report;
}

// ---------- Ask and global search ----------

/** Is the question about how the owner felt, or what they wrote in their journal? Only then does Ask open mood and journal. */
export function isMoodQuestion(text: string): boolean {
  return /\b(mood|moods|feel|feels|felt|feeling|feelings|happy|happier|sad|low|down|journal|journaled|diary|stress(ed|ful)?|anxious|anxiety|good days?|bad days?|great days?|rough days?|best days?|worst days?)\b/i.test(text);
}

/** Global search (lib/memory.ts recall): the best match on each day, from entries, day lines and journals (searched like any note body, owner 7 Nov). */
export async function dayRecallHits(query: TextQuery, limit = 20): Promise<Array<{ date: string; title: string; snippet: string; rank: number }>> {
  const hits = await searchDays(query, { limit: 200, journal: true });
  const byDay = new Map<string, { date: string; title: string; snippet: string; rank: number; more: number }>();
  for (const h of hits) {
    const had = byDay.get(h.date);
    if (had) {
      had.more++;
      continue;
    }
    const title = h.match === "entry" ? h.entry!.title : (h.line ?? (h.match === "journal" ? "Your journal" : ""));
    const snippet = h.match === "line" ? (h.line ?? "") : h.snippet;
    byDay.set(h.date, { date: h.date, title, snippet, rank: h.rank, more: 0 });
  }
  return [...byDay.values()]
    .slice(0, limit)
    .map(({ more, ...h }) => ({ ...h, snippet: more ? `${h.snippet} (and ${more} more that day)` : h.snippet }));
}

/** Every stored entry in [from, to], by day, with each day's line: what Ask reads for "what was I watching in March?". Workouts aren't here (they're health). */
export async function entriesInRange(from: string, to: string, opts: { kind?: DayEntryKind; limit?: number; places?: boolean } = {}): Promise<Array<{ date: string; line?: string; entries: DayEntry[] }>> {
  readDate(from, "from");
  readDate(to, "to");
  const params: unknown[] = [from, to];
  if (opts.kind) params.push(opts.kind);
  const [rows, lines] = await Promise.all([
    q<EntryRow>(
      `SELECT ${ENTRY_COLS} FROM day_entries WHERE date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL ${opts.places ? "" : `AND source <> '${PLACES}'`} ${opts.kind ? "AND kind = $3" : ""}
       ORDER BY date, at NULLS LAST, position LIMIT ${Math.max(1, Math.min(2000, opts.limit ?? 600))}`,
      params,
    ),
    q<{ date: string; line: string | null }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, line FROM days WHERE date BETWEEN $1::date AND $2::date AND line IS NOT NULL`, [from, to]),
  ]);
  const out = new Map<string, { date: string; line?: string; entries: DayEntry[] }>();
  for (const l of lines) if (l.line) out.set(l.date, { date: l.date, line: l.line, entries: [] });
  for (const r of rows) {
    const d = out.get(r.date) ?? { date: r.date, entries: [] };
    d.entries.push(toEntry(r));
    out.set(r.date, d);
  }
  return [...out.values()].filter((d) => !opts.kind || d.entries.length).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Search with filters and facets (GET /api/days/search) ----------

/** Days a place (by name) was visited, from the days' place entries. */
async function datesAtPlace(place: string, from?: string, to?: string): Promise<Set<string>> {
  const key = matchKey(place);
  const rows = await q<{ date: string; title: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, title FROM day_entries WHERE source = '${PLACES}' AND archived_at IS NULL
       AND ($1::date IS NULL OR date >= $1::date) AND ($2::date IS NULL OR date <= $2::date)`,
    [from ?? null, to ?? null],
  );
  return new Set(rows.filter((r) => matchKey(r.title) === key).map((r) => r.date));
}

/** People linked to each day: mentioned in a note written that day, or on an event that day. Date → person ids. */
async function peopleByDate(tz: string, dates?: string[]): Promise<Map<string, Set<string>>> {
  const rows = await qRaw<{ date: string; person: string }>(
    `SELECT to_char((n.created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS date, e.target_id::text AS person
       FROM edges e JOIN notes n ON n.id = e.source_id
      WHERE e.source_type = 'note' AND e.target_type = 'person' AND n.archived_at IS NULL AND COALESCE(n.source, '') NOT LIKE 'life-log%'
     UNION
     SELECT to_char(COALESCE((ev.starts_at AT TIME ZONE $1)::date, ev.date), 'YYYY-MM-DD'), e.target_id::text
       FROM edges e JOIN events ev ON ev.id = e.source_id
      WHERE e.source_type = 'event' AND e.target_type = 'person' AND ev.archived_at IS NULL AND ev.recurrence = 'none'`,
    [tz],
  );
  const out = new Map<string, Set<string>>();
  const only = dates ? new Set(dates) : null;
  for (const r of rows) {
    if (only && !only.has(r.date)) continue;
    (out.get(r.date) ?? out.set(r.date, new Set()).get(r.date)!).add(r.person);
  }
  return out;
}

/** A person by id, or by name (whole name first, then a name that contains it). */
async function peopleNamed(person: string): Promise<Map<string, string>> {
  const all = await q<{ id: string; name: string }>(`SELECT id, name FROM people WHERE archived_at IS NULL`);
  if (/^[0-9a-f-]{36}$/i.test(person)) return new Map(all.filter((p) => p.id === person.toLowerCase()).map((p) => [p.id, p.name]));
  const want = person.trim().toLowerCase();
  const exact = all.filter((p) => p.name.toLowerCase() === want);
  return new Map((exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(want))).map((p) => [p.id, p.name]));
}

const byCount = (m: Map<string, number>, n = 12) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);

/**
 * The owner's Days search: entries (places included), day lines and
 * journals, narrowed by kind, dates, source, a place or a person, with the
 * facets the filter chips offer.
 */
export async function searchDaysFaceted(query: string, filters: DaySearchFilters & { limit?: number }, opts: { tz?: string } = {}): Promise<DaySearch> {
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const parsed = parseQuery(query.trim());
  const empty: DaySearch = { q: query, results: [], facets: { sources: [], places: [], people: [] } };
  if (!parsed) return empty;
  let dates: Set<string> | undefined;
  if (filters.place) dates = await datesAtPlace(filters.place, filters.from, filters.to);
  if (filters.person) {
    const ids = new Set((await peopleNamed(filters.person)).keys());
    const linked = new Set<string>();
    for (const [date, people] of await peopleByDate(tz)) if ([...people].some((p) => ids.has(p))) linked.add(date);
    dates = dates ? new Set([...dates].filter((d) => linked.has(d))) : linked;
  }
  if (dates && !dates.size) return empty;
  const results = await searchDays(parsed, { kind: filters.kind, from: filters.from, to: filters.to, source: filters.source, dates, limit: filters.limit, journal: true, places: true });
  // Facets: what the results span.
  const hitDates = [...new Set(results.map((r) => r.date))];
  const sources = new Map<string, number>();
  for (const r of results) if (r.entry && r.entry.source !== PLACES) sources.set(r.entry.source, (sources.get(r.entry.source) ?? 0) + 1);
  const places = new Map<string, number>();
  const people = new Map<string, number>();
  if (hitDates.length) {
    const placeRows = await q<{ title: string }>(`SELECT title FROM day_entries WHERE source = '${PLACES}' AND archived_at IS NULL AND date = ANY($1::date[])`, [hitDates]);
    for (const p of placeRows) places.set(p.title, (places.get(p.title) ?? 0) + 1);
    const linked = await peopleByDate(tz, hitDates);
    const ids = [...new Set([...linked.values()].flatMap((s) => [...s]))];
    if (ids.length) {
      const names = new Map((await q<{ id: string; name: string }>(`SELECT id, name FROM people WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`, [ids])).map((p) => [p.id, p.name]));
      for (const s of linked.values()) for (const id of s) if (names.has(id)) people.set(names.get(id)!, (people.get(names.get(id)!) ?? 0) + 1);
    }
  }
  return { q: query, results, facets: { sources: byCount(sources), places: byCount(places), people: byCount(people) } };
}
