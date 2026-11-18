/**
 * Films, shows and books from Letterboxd, Trakt, Goodreads, Plex and Jellyfin, into Watch &
 * read (reading_items), with the owner's rating as stars on a "Rating" field.
 *
 * One item per title. An item is found by any of its keys (each source's own
 * id, from the link or external_id), then by its kind, title and year, so
 * Letterboxd and Trakt logging the same film make one item, and a film the
 * owner added by hand is the one a source fills in.
 *
 * What a source last wrote is kept in `reading_items.sync` (sealed, 0029):
 * the keys, and the status and rating it set. When the item's status or
 * rating no longer matches that, the owner changed it, and no source touches
 * it again. A source moves status forward only (to watch → watching →
 * watched). The newer rating wins between sources; no rating leaves the field
 * as it is, never 0.
 *
 * Used by the collection runner's athena_watch_read and by the Goodreads
 * library import (netlify/lib/connectors/goodreads-library.ts).
 */
import { AthenaInputError, sealer, tx } from "./db";
import { defineField, listFields } from "./custom-fields";
import { FieldError, normaliseValue, ratingFieldOf, type CustomField } from "./custom-field-rules";
import { isEncryptedPlaceholder } from "./encrypted";
import { bookKey } from "./goodreads-csv";
import { READING_STATUSES, type ReadingStatus } from "./watch-read";
import { mergeMeta, readMeta, sameMeta, type WatchMeta } from "./watch-meta";

/** What a collection run's athena_watch_read may send. */
export const SYNC_KINDS = ["film", "tv", "book"] as const;
export const SYNC_SOURCES = ["letterboxd", "trakt", "goodreads", "plex", "jellyfin", "netflix", "kindle", "audible", "iplayer"] as const;
/** Plus what only a history load sends: YouTube's liked and saved videos (netlify/lib/connectors/youtube-backfill.ts). */
export const WATCH_READ_KINDS = [...SYNC_KINDS, "video"] as const;
export const WATCH_READ_SOURCES = [...SYNC_SOURCES, "youtube"] as const;
export type SyncKind = (typeof WATCH_READ_KINDS)[number];
export type SyncSource = (typeof WATCH_READ_SOURCES)[number];

export interface WatchReadInput {
  kind: SyncKind;
  title: string;
  /** Director or author. A show's is dropped (Watch & read has no "by" for shows). */
  maker?: string;
  year?: number;
  status: ReadingStatus;
  /** As the source gives it: stars out of 5 (Letterboxd, Goodreads), out of 10 (Trakt), or its text ("★★★★½", "8/10", "4/5"). */
  rating?: number | string;
  /** When it was watched, finished or rated: YYYY-MM-DD or ISO. Decides which rating is newer. Default now. */
  at?: string;
  url?: string;
  external_id?: string;
  source: SyncSource;
  /** The playlist it was saved to, by name (YouTube). Added to the item's playlists. */
  list?: string;
  /** Running time in minutes, and genres, when the source gives them. They fill gaps only (lib/watch-meta.ts). */
  minutes?: number;
  genres?: string[];
}

export type SyncAction = "created" | "updated" | "unchanged" | "skipped";

export interface SyncOutcome {
  action: SyncAction;
  id?: string;
  title: string;
  /** Stars on the item now (null: none). */
  rating?: number | null;
  /** What the owner set by hand and the source left alone. */
  kept?: Array<"status" | "rating">;
  reason?: string;
}

/** Stored, sealed, in reading_items.sync. */
interface SyncState {
  keys: string[];
  year?: number;
  /** The status a source last set. */
  status?: ReadingStatus;
  /** The rating a source last set (null: it set none). Absent: no source has rated it. */
  rating?: number | null;
  /** When that rating was given (ISO). */
  rated_at?: string;
}

const RANK: Record<ReadingStatus, number> = { queued: 0, reading: 1, done: 2 };

/** A rating as stars, 0.5 to 5 in halves; undefined for none (0, empty or unreadable). Trakt's 1–10 is halved. */
export function toStars(source: SyncSource, raw: number | string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let n: number;
  // Trakt, Plex and Jellyfin rate out of 10.
  let outOf = source === "trakt" || source === "plex" || source === "jellyfin" ? 10 : 5;
  if (typeof raw === "number") n = raw;
  else {
    const s = raw.trim();
    const glyphs = (s.match(/★/g) ?? []).length + (/½/.test(s) ? 0.5 : 0);
    const frac = /(\d+(?:\.\d+)?)\s*\/\s*(10|5)\b/.exec(s);
    if (frac) {
      n = Number(frac[1]);
      outOf = Number(frac[2]);
    } else if (glyphs) {
      n = glyphs;
      outOf = 5;
    } else n = /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
  }
  if (!Number.isFinite(n) || n <= 0 || n > outOf) return undefined;
  const stars = Math.round((outOf === 10 ? n / 2 : n) * 2) / 2;
  return stars >= 0.5 ? Math.min(5, stars) : undefined;
}

/** A title for matching: case, accents, punctuation, "&" and a leading "The" ignored; a book's series in brackets dropped. */
export function titleKey(kind: SyncKind, title: string): string {
  const t = kind === "book" ? bookKey(title) : title.toLowerCase();
  return t
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

/** The source's own id for the title, from its link: the film, show or book, not the owner's diary page or episode. */
export function linkKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "letterboxd.com") {
    // letterboxd.com/film/<slug>/ or a diary entry, letterboxd.com/<you>/film/<slug>/1/
    const i = parts.indexOf("film");
    return i >= 0 && parts[i + 1] ? `letterboxd:film:${parts[i + 1].toLowerCase()}` : undefined;
  }
  if (host === "trakt.tv" && (parts[0] === "movies" || parts[0] === "shows") && parts[1]) return `trakt:${parts[0]}:${parts[1].toLowerCase()}`;
  if (host === "goodreads.com") {
    const id = /^(\d+)/.exec(parts[2] ?? "")?.[1];
    if (parts[0] === "book" && parts[1] === "show" && id) return `goodreads:book:${id}`;
    if (parts[0] === "review" && parts[1] === "show" && id) return `goodreads:review:${id}`;
  }
  return undefined;
}

/** A link to the title itself: a Trakt episode's link becomes its show's. */
function titleUrl(url: string | undefined): string {
  if (!url || !/^https:\/\//i.test(url) || url.length > 2000) return "";
  return url.replace(/^(https:\/\/trakt\.tv\/shows\/[^/]+)\/.*$/i, "$1");
}

/** ISO for a day (noon UTC, as the Life log dates days) or a time; undefined when it isn't one. */
function isoOf(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T12:00:00Z` : at);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The input checked and tidied, or the owner-facing reason it can't be used. */
export function checkInput(raw: WatchReadInput): WatchReadInput {
  if (!(WATCH_READ_KINDS as readonly string[]).includes(raw.kind)) throw new AthenaInputError(`kind is one of ${WATCH_READ_KINDS.join(", ")}`);
  if (!(WATCH_READ_SOURCES as readonly string[]).includes(raw.source)) throw new AthenaInputError(`source is one of ${WATCH_READ_SOURCES.join(", ")}`);
  if (!(READING_STATUSES as readonly string[]).includes(raw.status)) throw new AthenaInputError(`status is one of ${READING_STATUSES.join(", ")}`);
  const title = (raw.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title || !titleKey(raw.kind, title)) throw new AthenaInputError("Add a title");
  const year = Number.isInteger(raw.year) && raw.year! >= 1800 && raw.year! <= 2200 ? raw.year : undefined;
  return { ...raw, title, year, maker: raw.maker?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined };
}

interface Row {
  id: string;
  kind: string;
  title: string;
  author: string;
  url: string;
  status: ReadingStatus;
  finished_at: string | null;
  archived_at: string | null;
  sync: unknown;
  meta: unknown;
}

/** What this input says about the title beyond its name. */
function learnedMeta(input: WatchReadInput): WatchMeta {
  return readMeta({ year: input.year, minutes: input.minutes, genres: input.genres, lists: input.list ? [input.list] : undefined });
}

interface Item extends Row {
  state: SyncState | null;
  /** The Rating field's value now. */
  stars: number | undefined;
}

function readState(raw: unknown): SyncState | null {
  let v = raw;
  if (typeof v === "string") {
    if (isEncryptedPlaceholder(v)) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || !Array.isArray((v as SyncState).keys)) return null;
  return v as SyncState;
}

/** The owner's Rating field for Watch & read: theirs if they have one, otherwise made once. Null when "Rating" is taken by another type. */
export async function ratingField(opts: { create: boolean }): Promise<CustomField | null> {
  const mine = ratingFieldOf(await listFields({ kind: "reading" }), "reading");
  if (mine || !opts.create) return mine ?? null;
  const { field } = await defineField({ kind: "reading", label: "Rating", type: "rating" }, { reuse: true });
  return field.type === "rating" ? field : null;
}

/**
 * Save these titles into Watch & read: one item each, matched across sources
 * and runs. `collection` is the source label stored on new items (the
 * collection's, or the import's). Safe to repeat.
 */
export async function syncWatchRead(inputs: WatchReadInput[], opts: { collection: string; now?: Date; backfilled?: boolean }): Promise<SyncOutcome[]> {
  const checked = inputs.map(checkInput);
  const now = (opts.now ?? new Date()).toISOString();
  const field = await ratingField({ create: checked.some((i) => toStars(i.source, i.rating) !== undefined) });
  const s = await sealer();

  return tx(async (run) => {
    // One sync at a time: two runs seeing the same film still make one item.
    await run(`SELECT pg_advisory_xact_lock(hashtext('athena:watch-read-sync'))`);
    const rows = await run<Row>(`SELECT id, kind, title, author, url, status, finished_at, archived_at, sync, meta FROM reading_items`);
    const values = field
      ? await run<{ entity_id: string; value: string }>(`SELECT entity_id, value FROM custom_values WHERE field_id = $1`, [field.id])
      : [];
    const starsById = new Map<string, number>();
    for (const v of values) {
      if (isEncryptedPlaceholder(v.value)) continue;
      try {
        const n = JSON.parse(v.value);
        if (typeof n === "number") starsById.set(v.entity_id, n);
      } catch {
        // not a number: leave it out
      }
    }
    const items: Item[] = rows
      .filter((r) => !isEncryptedPlaceholder(r.title))
      .map((r) => ({ ...r, state: readState(r.sync), stars: starsById.get(r.id) }));

    const out: SyncOutcome[] = [];
    for (const input of checked) {
      const stars = toStars(input.source, input.rating);
      const at = isoOf(input.at) ?? now;
      const tkey = titleKey(input.kind, input.title);
      const idKeys = [linkKey(input.url), input.external_id?.trim() ? `${input.source}:${input.external_id.trim().toLowerCase().slice(0, 300)}` : undefined].filter(
        (k): k is string => !!k,
      );
      const keys = idKeys;

      // By the source's id first, then by kind, title and a year that doesn't disagree.
      const item =
        items.find((it) => it.state?.keys.some((k) => idKeys.includes(k))) ??
        items.find(
          (it) =>
            it.kind === input.kind &&
            titleKey(input.kind, it.title) === tkey &&
            !(input.year && it.state?.year && it.state.year !== input.year),
        );

      if (item?.archived_at) {
        out.push({ action: "skipped", id: item.id, title: item.title, reason: "You archived it. Leave it alone." });
        continue;
      }

      const learnt = learnedMeta(input);

      if (!item) {
        const state: SyncState = { keys, ...(input.year ? { year: input.year } : {}), status: input.status };
        if (stars !== undefined && field) Object.assign(state, { rating: stars, rated_at: at });
        const [row] = await run<{ id: string }>(
          // A backfilled item is dated when it happened (added, watched), not today, and marked so it's never new (0054).
          `INSERT INTO reading_items (title, url, kind, author, status, notes, source, finished_at, sync, backfilled, created_at, meta)
           VALUES ($1, $2, $3, $4, $5, '', $6, CASE WHEN $5 = 'done' THEN $7::timestamptz END, $8::jsonb, $9, CASE WHEN $9 THEN LEAST($7::timestamptz, now()) ELSE now() END, $10::jsonb) RETURNING id`,
          [s.text(input.title), s.text(titleUrl(input.url)), input.kind, s.text(input.kind === "tv" ? "" : (input.maker ?? "")), input.status, opts.collection, at, s.json(state), opts.backfilled ?? false, Object.keys(learnt).length ? s.json(learnt) : null],
        );
        if (stars !== undefined && field) await writeStars(run, s, field, row.id, stars);
        items.push({ id: row.id, kind: input.kind, title: input.title, author: input.maker ?? "", url: titleUrl(input.url), status: input.status, finished_at: input.status === "done" ? at : null, archived_at: null, sync: null, meta: learnt, state, stars: field ? stars : undefined });
        out.push({ action: "created", id: row.id, title: input.title, rating: field ? (stars ?? null) : null });
        continue;
      }

      // ---- an item that's already there ----
      const state: SyncState = item.state ? { ...item.state, keys: [...item.state.keys] } : { keys: [] };
      /** Something the owner would see: a link, a maker, the status or the stars. */
      let changed = false;
      let learned = false;
      const kept: Array<"status" | "rating"> = [];
      for (const k of keys) if (!state.keys.includes(k)) (state.keys.push(k), (learned = true));
      if (input.year && !state.year) ((state.year = input.year), (learned = true));

      const set: Record<string, unknown> = {};
      if (!item.author && input.maker && input.kind !== "tv") set.author = input.maker;
      if (!item.url && titleUrl(input.url)) set.url = titleUrl(input.url);

      // Status: the owner's choice stands. An item no source has set yet counts as theirs unless it's still "to watch".
      const ownerStatus = state.status === undefined ? item.status !== "queued" : item.status !== state.status;
      if (ownerStatus && RANK[input.status] > RANK[item.status]) kept.push("status");
      else if (!ownerStatus && RANK[input.status] > RANK[item.status]) {
        set.status = input.status;
        state.status = input.status;
      } else if (!ownerStatus && state.status !== item.status) state.status = item.status;

      // Rating: the owner's choice stands (one they set, or cleared). Otherwise the newer rating wins.
      let rating = item.stars ?? null;
      if (field && stars !== undefined) {
        const ownerRating = !("rating" in state) ? item.stars !== undefined : (item.stars ?? null) !== state.rating;
        if (ownerRating) {
          if (item.stars !== stars) kept.push("rating");
        } else if (!state.rated_at || at >= state.rated_at) {
          if (item.stars !== stars) {
            await writeStars(run, s, field, item.id, stars);
            item.stars = stars;
            changed = true;
          }
          if (state.rating !== stars || state.rated_at !== at) ((state.rating = stars), (state.rated_at = at), (learned = true));
          rating = stars;
        }
      }

      // What the source knows about the title (year, length, genres, its playlist): gaps filled, nothing the owner sees moved.
      const keptMeta = readMeta(item.meta);
      const nextMeta = mergeMeta(keptMeta, learnt);
      const metaChanged = !sameMeta(keptMeta, nextMeta);

      if (Object.keys(set).length || changed || learned || metaChanged || JSON.stringify(state) !== JSON.stringify(item.state)) {
        await run(
          `UPDATE reading_items SET
             author = COALESCE($2, author), url = COALESCE($3, url), status = COALESCE($4, status),
             finished_at = CASE WHEN $4::text = 'done' THEN COALESCE(finished_at, $5::timestamptz) WHEN $4::text IS NULL THEN finished_at ELSE NULL END,
             sync = $6::jsonb,
             meta = COALESCE($8::jsonb, meta),
             updated_at = CASE WHEN $7::boolean THEN now() ELSE updated_at END
           WHERE id = $1`,
          [item.id, s.maybe((set.author as string) ?? null), s.maybe((set.url as string) ?? null), (set.status as string) ?? null, at, s.json(state), Object.keys(set).length > 0 || changed, metaChanged ? s.json(nextMeta) : null],
        );
        if (metaChanged) item.meta = nextMeta;
        if (set.author) item.author = set.author as string;
        if (set.url) item.url = set.url as string;
        if (set.status) {
          item.status = set.status as ReadingStatus;
          if (item.status === "done") item.finished_at ??= at;
        }
        item.state = state;
      }
      const updated = Object.keys(set).length > 0 || changed;
      out.push({ action: updated ? "updated" : "unchanged", id: item.id, title: item.title, rating, ...(kept.length ? { kept } : {}) });
    }
    return out;
  });
}

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

async function writeStars(run: Run, s: Awaited<ReturnType<typeof sealer>>, field: CustomField, id: string, stars: number): Promise<void> {
  let value: unknown;
  try {
    value = normaliseValue(field, stars).value;
  } catch (error) {
    if (error instanceof FieldError) return;
    throw error;
  }
  await run(
    `INSERT INTO custom_values (field_id, entity_kind, entity_id, value) VALUES ($1, 'reading', $2, $3)
     ON CONFLICT (field_id, entity_id) DO UPDATE SET value = EXCLUDED.value, entity_kind = EXCLUDED.entity_kind, updated_at = now()`,
    [field.id, id, s.text(JSON.stringify(value))],
  );
}
