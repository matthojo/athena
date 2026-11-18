/**
 * Saved (migration 0038): links, images, quotes, snippets and notes sent to
 * Athena from the Share sheet, Siri, the browser extension or the app, kept
 * with a readable copy and shown on the day they were saved.
 *
 * Sealed (SECURITY.md §11, ENCRYPTED in lib/encryption.ts): the URL, title,
 * site, author, excerpt, readable copy, quote, note, tags and source URL.
 * Readable: kind, source, dates, image size and tone, flags. A link's URL
 * also has a blind index so the same page saved twice is one item.
 *
 * Images (the owner's own, or a page's lead image) are resized and stripped
 * of metadata with sharp, then sealed under the data key in the
 * "athena-saved" blob store as `<id>/lg` (1600px) and `<id>/sm` (560px).
 * No key, no image: an upload is refused rather than stored readable.
 */
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { AthenaInputError, getOwnerTimeZone, q, qRaw, sealer } from "./db";
import { dataKeyConfigured, openBytes, sealBytes } from "./data-box";
import { zonedToday } from "./dates";
import { decodeImage, sniffImage } from "./art";
import { extractPage, tooDeep } from "./saved-extract";
import { detectFromHtml, detectFromUrl, type Detected, type SavedFacts, type SavedThing } from "./saved-kinds";
import { fetchPageHtml, fetchPageImage } from "./saved-fetch";
import { parseQuery, score, headline } from "./text-search";
import { urlHost } from "./team-events";
import { startTeamEvent } from "./team-triggers";
import { cleanTags, MAX_SAVED_IMAGE_BYTES, MAX_SAVED_TITLE, MAX_SAVED_TEXT, cleanUrl, planSave, savedUrlKey, SaveTooBig, siteOf, SAVED_KINDS, SAVED_SOURCES, type SaveInput, type SavedFiled, type SavedItem, type SavedKind, type SavedSource } from "./saved-rules";

export type { SavedItem, SavedKind, SavedSource };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSavedId = (raw: unknown): raw is string => typeof raw === "string" && UUID_RE.test(raw);

const COLS = `id, kind, url, title, site, author, to_char(published_on, 'YYYY-MM-DD') AS published_at, excerpt, quote, note, tags, source, source_url,
  has_image, image_w, image_h, image_tone, saved_at, to_char(saved_on, 'YYYY-MM-DD') AS saved_on, archived_at, readable IS NOT NULL AS has_readable, fetch_status, words,
  thing, facts, filed_at, filed_to`;

interface Row {
  id: string;
  kind: SavedKind;
  url: string | null;
  title: string | null;
  site: string | null;
  author: string | null;
  published_at: string | null;
  excerpt: string | null;
  quote: string | null;
  note: string | null;
  tags: string[] | null;
  source: SavedSource;
  source_url: string | null;
  has_image: boolean;
  image_w: number | null;
  image_h: number | null;
  image_tone: string | null;
  saved_at: Date | string;
  saved_on: string;
  archived_at: Date | string | null;
  has_readable: boolean;
  fetch_status: SavedItem["fetch_status"];
  words: number | null;
  thing: SavedThing | null;
  facts: string | null;
  filed_at: Date | string | null;
  filed_to: string | null;
  readable?: string | null;
}

/** Where an action filed an item, as stored (sealed JSON): what the app sees, and how to undo it on the other side. */
export interface FiledTo extends Omit<SavedFiled, "at"> {
  undo: unknown;
}

const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
};
/** The stored filing of a row (null when it isn't filed, or can't be opened here). */
export const filedToOf = (raw: string | null): FiledTo | null => parseJson<FiledTo>(raw);

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function filedView(r: Row): SavedFiled {
  const f = filedToOf(r.filed_to);
  return { at: iso(r.filed_at!), action: f?.action ?? "", label: f?.label ?? "Filed", href: f?.href ?? null };
}

function toItem(r: Row): SavedItem {
  return {
    id: r.id,
    kind: r.kind,
    url: r.url,
    title: r.title,
    site: r.site,
    author: r.author,
    published_at: r.published_at,
    excerpt: r.excerpt,
    quote: r.quote,
    note: r.note,
    tags: r.tags ?? [],
    source: r.source,
    source_url: r.source_url,
    image_url: r.has_image ? `/api/saved/${r.id}/image` : null,
    image_w: r.image_w,
    image_h: r.image_h,
    image_tone: r.image_tone,
    saved_at: iso(r.saved_at),
    saved_on: r.saved_on,
    archived: !!r.archived_at,
    has_readable: r.has_readable,
    fetch_status: r.fetch_status,
    words: r.words,
    thing: r.thing ?? null,
    facts: parseJson<SavedFacts>(r.facts),
    filed: r.filed_at ? filedView(r) : null,
    ...(r.readable !== undefined ? { readable: r.readable } : {}),
  };
}

// ---------- images ----------

const STORE = "athena-saved";
let storeFor: () => ReturnType<typeof getStore> = () => getStore({ name: STORE, consistency: "strong" });
/** Replace the blob store (tests). */
export function useSavedStore(make: () => ReturnType<typeof getStore>): void {
  storeFor = make;
}

export type ImageSize = "sm" | "lg";
const EDGE: Record<ImageSize, number> = { sm: 560, lg: 1600 };
const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export class SavedImageError extends AthenaInputError {}

interface Prepared {
  sm: Buffer;
  lg: Buffer;
  w: number;
  h: number;
  tone: string;
}

/** Two WebP sizes and the average colour. EXIF orientation applied, metadata (location included) dropped. */
async function prepareImage(bytes: Uint8Array): Promise<Prepared> {
  if (bytes.byteLength > MAX_SAVED_IMAGE_BYTES) throw new SavedImageError("That image is over 10 MB");
  if (!sniffImage(bytes)) {
    // HEIC/HEIF (an iPhone photo as it is): "ftyp" then heic, heix, hevc, mif1 or msf1.
    const brand = Buffer.from(bytes.subarray(4, 12)).toString("latin1");
    if (/^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) throw new SavedImageError("Athena can't keep HEIC photos. Convert it to JPEG first (in the Shortcut, add Convert Image before Get Contents of URL).");
    throw new SavedImageError("Send a JPEG, PNG, WebP or GIF image");
  }
  try {
    // One decode (refused above 25 megapixels from the header), every size derived from it.
    const d = await decodeImage(bytes, EDGE.lg);
    const [lg, sm, mean] = await Promise.all([
      d.from().webp({ quality: 82, effort: 4 }).toBuffer(),
      d.from().resize({ width: EDGE.sm, height: EDGE.sm, fit: "inside", withoutEnlargement: true }).webp({ quality: 76, effort: 4 }).toBuffer(),
      d.from().removeAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer(),
    ]);
    return { lg, sm, w: d.w, h: d.h, tone: `#${hex(mean[0])}${hex(mean[1])}${hex(mean[2])}` };
  } catch {
    throw new SavedImageError("Athena couldn't read that image");
  }
}

async function storeImage(id: string, p: Prepared): Promise<string> {
  const store = storeFor();
  const lg = sealBytes(p.lg);
  const sm = sealBytes(p.sm);
  await store.set(`${id}/lg`, new Uint8Array(lg.sealed).buffer as ArrayBuffer);
  await store.set(`${id}/sm`, new Uint8Array(sm.sealed).buffer as ArrayBuffer);
  return lg.kid;
}

/** One kept size, opened. Null when there's none (or it can't be opened here). */
export async function readSavedImage(id: string, size: ImageSize): Promise<Buffer | null> {
  if (!isSavedId(id)) return null;
  const sealed = await storeFor().get(`${id}/${size}`, { type: "arrayBuffer" });
  if (!sealed) return null;
  try {
    return openBytes(new Uint8Array(sealed));
  } catch {
    return null;
  }
}

async function dropImage(id: string): Promise<void> {
  const store = storeFor();
  await Promise.all([store.delete(`${id}/lg`), store.delete(`${id}/sm`)]).catch(() => undefined);
}

// ---------- reading a link ----------

export interface ReadResult {
  status: "ok" | "preview" | "failed";
  title?: string | null;
  site?: string | null;
  author?: string | null;
  published_at?: string | null;
  excerpt?: string | null;
  readable?: string | null;
  words?: number;
  image?: Prepared | null;
  /** What the page is (lib/saved-kinds.ts), or null. */
  thing?: Detected | null;
  /** The page as fetched, for Recipes to read a recipe page without fetching it again. Never stored here. */
  html?: string;
}

/** Fetch a page once and keep what's readable. Never throws: a page that can't be read is "failed". */
export async function readLink(url: string): Promise<ReadResult> {
  try {
    const page = await fetchPageHtml(url);
    if (tooDeep(page.html)) throw new Error("page nested too deep");
    const x = extractPage(page.html, page.url);
    let image: Prepared | null = null;
    if (x.image && dataKeyConfigured()) {
      try {
        image = await prepareImage(await fetchPageImage(x.image));
      } catch {
        image = null;
      }
    }
    const thing = detectFromHtml(page.html, page.url, { title: x.title, author: x.author, hasText: !!x.text }) ?? detectFromUrl(url);
    return { status: x.text ? "ok" : "preview", title: x.title, site: x.site_name, author: x.author, published_at: x.published_at, excerpt: x.excerpt, readable: x.text, words: x.words, image, thing, html: page.html };
  } catch {
    return { status: "failed", thing: detectFromUrl(url) };
  }
}

// ---------- saving ----------

export interface SaveRequest extends SaveInput {
  image?: Uint8Array | null;
  /** An image by address: fetched once through the guarded fetch (10 MB). If that fails, the address is saved as a link. */
  image_url?: unknown;
  source?: unknown;
  client_id?: unknown;
  tags?: unknown;
}

export interface SaveOutcome {
  item: SavedItem;
  /** False when the client_id (or the same link) was already saved: the existing item. */
  created: boolean;
}

const sourceOf = (raw: unknown): SavedSource => (SAVED_SOURCES.includes(raw as SavedSource) ? (raw as SavedSource) : "app");

/** Keep something. Throws AthenaInputError (400), SaveTooBig, SavedImageError, or DataBoxError (503) without the key. */
export async function saveItem(input: SaveRequest, opts: { read?: typeof readLink; now?: Date; fetchImage?: (url: string) => Promise<Uint8Array> } = {}): Promise<SaveOutcome> {
  const clientId = isSavedId(input.client_id) ? String(input.client_id).toLowerCase() : null;
  if (clientId) {
    const [have] = await q<Row>(`SELECT ${COLS} FROM saved_items WHERE client_id = $1`, [clientId]);
    if (have) {
      // A repeat that carries a note, title or tags updates the item (the note replaces): how a note typed after a toolbar save arrives.
      const patch: SavedPatch = {};
      if (typeof input.note === "string") patch.note = input.note;
      if (typeof input.title === "string") patch.title = input.title;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (!Object.keys(patch).length) return { item: toItem(have), created: false };
      if (typeof patch.note === "string" && patch.note.length > MAX_SAVED_TEXT) throw new SaveTooBig("note");
      return { item: (await updateSaved(have.id, patch)) ?? toItem(have), created: false };
    }
  }
  if (!input.image?.byteLength && typeof input.image_url === "string") {
    const remote = cleanUrl(input.image_url);
    if (!remote) throw new AthenaInputError("image: send a file, a base64 data URL, or an https address");
    let bytes: Uint8Array | null = null;
    if (dataKeyConfigured()) {
      try {
        bytes = await (opts.fetchImage ?? ((u: string) => fetchPageImage(u, MAX_SAVED_IMAGE_BYTES)))(remote);
      } catch {
        bytes = null;
      }
    }
    // Couldn't fetch it (or no key to seal it): keep the address as a link instead.
    input = bytes ? { ...input, image: bytes, source_url: input.source_url ?? remote } : { ...input, url: input.url ?? remote, image_url: undefined };
  }
  const plan = planSave({ ...input, hasImage: !!input.image?.byteLength });
  if (!plan) throw new AthenaInputError("There was nothing to save");
  const s = await sealer();
  const urlBidx = plan.url ? s.index("other", `saved-url\u0000${savedUrlKey(plan.url)}`) : null;
  if (plan.kind === "link" && urlBidx) {
    const [have] = await q<Row>(`SELECT ${COLS} FROM saved_items WHERE url_bidx = $1 AND archived_at IS NULL ORDER BY saved_at DESC LIMIT 1`, [urlBidx]);
    if (have) {
      // The extension's later note arrives by this client_id, so the item takes it on if it has none.
      if (clientId) await qRaw(`UPDATE saved_items SET client_id = $2 WHERE id = $1 AND client_id IS NULL`, [have.id, clientId]).catch(() => undefined);
      if (plan.note && plan.note !== have.note) {
        const note = have.note ? `${have.note}\n\n${plan.note}` : plan.note;
        await qRaw(`UPDATE saved_items SET note = $2, updated_at = now() WHERE id = $1`, [have.id, s.text(note.slice(0, MAX_SAVED_TEXT))]);
        have.note = note;
      }
      return { item: toItem(have), created: false };
    }
  }
  if (!dataKeyConfigured() && input.image?.byteLength) throw new SavedImageError("Athena can't keep images here: its encryption key isn't set.");
  const image = input.image?.byteLength ? await prepareImage(input.image) : null;
  const now = opts.now ?? new Date();
  const savedOn = zonedToday(now, await getOwnerTimeZone());
  const tags = cleanTags(input.tags);
  const linkUrl = plan.url ?? plan.source_url;
  // A link's row goes in first, with what its address says; the page is read afterwards (below). A page that
  // hangs or crashes the read can then never lose the save (security review M18).
  let thing: Detected | null = plan.kind === "image" ? { type: "image", facts: {} } : plan.kind === "link" ? detectFromUrl(plan.url) : null;
  const isLink = plan.kind === "link" && !!plan.url;
  let [row] = await q<Row>(
    `INSERT INTO saved_items (kind, client_id, url, url_bidx, title, site, author, published_on, excerpt, readable, words, quote, note, tags, source, source_url,
       has_image, image_w, image_h, image_tone, image_kid, fetch_status, fetched_at, saved_at, saved_on, thing, facts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::date, $26, $27)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING ${COLS}`,
    [
      plan.kind,
      clientId,
      s.maybe(plan.url),
      urlBidx,
      s.maybe(plan.title?.slice(0, MAX_SAVED_TITLE) ?? null),
      s.maybe(siteOf(linkUrl)),
      null,
      null,
      null,
      null,
      null,
      s.maybe(plan.quote),
      s.maybe(plan.note),
      s.list(tags),
      sourceOf(input.source),
      s.maybe(plan.source_url),
      false,
      image?.w ?? null,
      image?.h ?? null,
      image?.tone ?? null,
      null,
      // "failed" until the read below says otherwise: what it stays as if the read never comes back.
      isLink ? "failed" : null,
      null,
      now.toISOString(),
      savedOn,
      thing?.type ?? null,
      thing && Object.keys(thing.facts).length ? s.text(JSON.stringify(thing.facts)) : null,
    ],
  );
  if (!row) {
    // Two sends with one client_id at once: the other won.
    const [have] = await q<Row>(`SELECT ${COLS} FROM saved_items WHERE client_id = $1`, [clientId]);
    return { item: toItem(have), created: false };
  }
  let read: ReadResult | null = null;
  if (isLink) {
    try {
      read = await (opts.read ?? readLink)(plan.url!);
      thing = read.thing ?? thing;
      await qRaw(
        `UPDATE saved_items SET title = COALESCE(title, $2), site = COALESCE($3, site), author = $4, published_on = $5::date, excerpt = $6, readable = $7, words = $8,
           fetch_status = $9, fetched_at = $10, thing = $11, facts = $12 WHERE id = $1`,
        [
          row.id,
          s.maybe(read.title?.slice(0, MAX_SAVED_TITLE) ?? null),
          s.maybe(read.site ?? null),
          s.maybe(read.author ?? null),
          read.published_at ?? null,
          s.maybe(read.excerpt ?? null),
          s.maybe(read.readable ?? null),
          read.words || null,
          read.status,
          now.toISOString(),
          thing?.type ?? null,
          thing && Object.keys(thing.facts).length ? s.text(JSON.stringify(thing.facts)) : null,
        ],
      );
    } catch {
      read = null; // the item is kept as saved; "Read again" tries the page later
    }
  }
  const pic = image ?? read?.image ?? null;
  if (pic) {
    const kid = await storeImage(row.id, pic);
    await qRaw(`UPDATE saved_items SET has_image = true, image_w = $2, image_h = $3, image_tone = $4, image_kid = $5 WHERE id = $1`, [row.id, pic.w, pic.h, pic.tone, kid]);
  }
  if (read || pic) {
    const [fresh] = await q<Row>(`SELECT ${COLS} FROM saved_items WHERE id = $1`, [row.id]);
    if (fresh) row = fresh;
  }
  const saved = toItem(row);
  // The price it was saved at: its price tracker's first check (lib/trackers-store.ts). Never throws.
  await (await import("./trackers-store")).keepSavePoint(saved);
  // For Team's event triggers: something you did, so a matching assistant starts now (lib/team-triggers.ts). Never throws.
  await startTeamEvent("saved", saved.id, "saved", { savedAction: "saved", kind: saved.thing ?? saved.kind, title: saved.title, host: urlHost(saved.url ?? saved.source_url), tags: saved.tags });
  // A recipe page goes on to Recipes, filed there with this item as its pointer (lib/recipes.ts; loaded only then).
  if (thing?.type === "recipe") return { item: await (await import("./recipes")).fileRecipeFromSave(toItem(row), read?.html ?? null), created: true };
  return { item: toItem(row), created: true };
}

/** Read a link's page again (the reader's "Read again"). */
export async function refetchItem(id: string, opts: { read?: typeof readLink } = {}): Promise<SavedItem | null> {
  const item = await getSaved(id);
  if (!item || item.kind !== "link" || !item.url) return item;
  const read = await (opts.read ?? readLink)(item.url);
  const s = await sealer();
  const thing = read.thing ?? detectFromUrl(item.url);
  if (thing) await qRaw(`UPDATE saved_items SET thing = $2, facts = $3 WHERE id = $1`, [id, thing.type, Object.keys(thing.facts).length ? s.text(JSON.stringify(thing.facts)) : null]);
  // Read again found a price on the page: the owner's own check on its price tracker (lib/trackers-store.ts).
  if (thing?.facts.price && thing.facts.currency) await (await import("./trackers-store")).recordOwnerRead(item, thing.facts).catch(() => undefined);
  if (read.status !== "failed") {
    await qRaw(
      `UPDATE saved_items SET title = COALESCE(title, $2), site = COALESCE($3, site), author = COALESCE($4, author), published_on = COALESCE($5::date, published_on),
         excerpt = COALESCE($6, excerpt), readable = $7, words = $8, fetch_status = $9, fetched_at = now(), updated_at = now() WHERE id = $1`,
      [id, s.maybe(read.title ?? null), s.maybe(read.site ?? null), s.maybe(read.author ?? null), read.published_at ?? null, s.maybe(read.excerpt ?? null), s.maybe(read.readable ?? null), read.words || null, read.status],
    );
    if (read.image && !item.image_url) {
      const kid = await storeImage(id, read.image);
      await qRaw(`UPDATE saved_items SET has_image = true, image_w = $2, image_h = $3, image_tone = $4, image_kid = $5 WHERE id = $1`, [id, read.image.w, read.image.h, read.image.tone, kid]);
    }
  } else {
    await qRaw(`UPDATE saved_items SET fetch_status = CASE WHEN readable IS NULL THEN 'failed' ELSE fetch_status END, fetched_at = now() WHERE id = $1`, [id]);
  }
  return getSaved(id, { readable: true });
}

// ---------- rate limit ----------

/** Saves a minute per key (or the app's token), across every Function instance. */
export const SAVES_PER_MINUTE = 60;

/** Count one save for this caller; false once they're over SAVES_PER_MINUTE this minute. */
export async function takeSaveSlot(req: Request, limit = SAVES_PER_MINUTE): Promise<boolean> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const bucket = createHash("sha256").update(`saved-rate\u0000${token}`).digest("hex").slice(0, 32);
  const [row] = await qRaw<{ n: number }>(
    `INSERT INTO saved_rate (bucket, minute, n) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, minute) DO UPDATE SET n = saved_rate.n + 1 RETURNING n`,
    [bucket],
  );
  // Tidy old minutes now and then.
  if (Math.random() < 0.02) void qRaw(`DELETE FROM saved_rate WHERE minute < now() - interval '10 minutes'`).catch(() => undefined);
  return (row?.n ?? 0) <= limit;
}

// ---------- reading ----------

export async function getSaved(id: string, opts: { readable?: boolean } = {}): Promise<SavedItem | null> {
  if (!isSavedId(id)) return null;
  const [row] = await q<Row>(`SELECT ${COLS}${opts.readable ? ", readable" : ""} FROM saved_items WHERE id = $1`, [id]);
  return row ? toItem(row) : null;
}

export interface SavedQuery {
  kind?: unknown;
  q?: unknown;
  day?: unknown;
  limit?: unknown;
  before?: unknown;
  archived?: boolean;
  /** true: only what an action filed. Otherwise filed items are left out of the list (but kept on their day and in search). */
  filed?: boolean;
}

export interface SavedPage {
  items: Array<SavedItem & { match?: string }>;
  /** By kind for the main list (filed items not counted), plus how many are filed. */
  counts: Record<SavedKind | "all" | "filed", number>;
  more: boolean;
}

/** Newest first; by kind, by day, before a time (paging), or matching words (searched in the Function, sealed text opened). */
export async function listSaved(query: SavedQuery = {}): Promise<SavedPage> {
  const kind = SAVED_KINDS.includes(query.kind as SavedKind) ? (query.kind as SavedKind) : null;
  const day = typeof query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : null;
  const before = typeof query.before === "string" && !Number.isNaN(Date.parse(query.before)) ? query.before : null;
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 60));
  const words = typeof query.q === "string" && query.q.trim() ? parseQuery(query.q.trim().slice(0, 200)) : null;
  const archived = query.archived ?? false;
  // Which rows: filed only (the Filed filter), any (a day, a search), or not filed (the main list).
  const filed = query.filed ? "only" : day || words ? "any" : "not";
  const filedSql = (n: number) => `($${n}::text = 'any' OR (filed_at IS NOT NULL) = ($${n}::text = 'only'))`;
  const countRows = await qRaw<{ kind: SavedKind; filed: boolean; n: number }>(`SELECT kind, filed_at IS NOT NULL AS filed, count(*)::int AS n FROM saved_items WHERE (archived_at IS NOT NULL) = $1 GROUP BY 1, 2`, [archived]);
  const counts = { all: 0, link: 0, image: 0, quote: 0, snippet: 0, note: 0, filed: 0 } as SavedPage["counts"];
  for (const c of countRows) {
    if (c.filed) {
      counts.filed += c.n;
      continue;
    }
    counts[c.kind] += c.n;
    counts.all += c.n;
  }
  if (words) {
    const rows = await q<Row>(
      `SELECT ${COLS}, readable FROM saved_items WHERE (archived_at IS NOT NULL) = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::date IS NULL OR saved_on = $3::date) AND ${filedSql(4)} ORDER BY saved_at DESC LIMIT 2000`,
      [archived, kind, day, filed],
    );
    const ranked = rows
      .map((r) => {
        const fields = [
          { text: r.title ?? "", weight: 1 },
          { text: [r.note, r.quote, (r.tags ?? []).join(" ")].filter(Boolean).join(" "), weight: 0.8 },
          { text: [r.excerpt, r.site, r.author].filter(Boolean).join(" "), weight: 0.5 },
          { text: (r.readable ?? "").slice(0, 60_000), weight: 0.25 },
        ];
        const sc = score(words, fields);
        const where = [r.note, r.quote, r.excerpt, r.readable].find((t) => t && score(words, [{ text: t, weight: 1 }]) > 0);
        return { r, sc, match: where ? headline(where, words, 22) : undefined };
      })
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc || iso(b.r.saved_at).localeCompare(iso(a.r.saved_at)));
    return { items: await withPricesNow(ranked.slice(0, limit).map(({ r, match }) => ({ ...toItem({ ...r, readable: undefined }), ...(match ? { match } : {}) }))), counts, more: ranked.length > limit };
  }
  const rows = await q<Row>(
    `SELECT ${COLS} FROM saved_items WHERE (archived_at IS NOT NULL) = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::date IS NULL OR saved_on = $3::date) AND ($4::timestamptz IS NULL OR saved_at < $4::timestamptz) AND ${filedSql(6)}
     ORDER BY ${filed === "only" ? "filed_at" : "saved_at"} DESC LIMIT $5`,
    [archived, kind, day, before, limit + 1, filed],
  );
  return { items: await withPricesNow(rows.slice(0, limit).map(toItem)), counts, more: rows.length > limit };
}

/** A list's items with the best price now on those with checks since they were saved (lib/trackers-store.ts; one query). */
async function withPricesNow<T extends SavedItem>(items: T[]): Promise<T[]> {
  const now = await (await import("./trackers-store")).pricesNow(items.map((i) => i.id));
  return now.size ? items.map((i) => (now.has(i.id) ? { ...i, price_now: now.get(i.id) } : i)) : items;
}

/** Days in a range that have saved items, with how many (the Day's "Saved" section and the calendar). */
export async function savedDays(from: string, to: string): Promise<Array<{ date: string; n: number }>> {
  return qRaw(`SELECT to_char(saved_on, 'YYYY-MM-DD') AS date, count(*)::int AS n FROM saved_items WHERE archived_at IS NULL AND saved_on BETWEEN $1::date AND $2::date GROUP BY saved_on ORDER BY saved_on`, [from, to]);
}

// ---------- changing ----------

export interface SavedPatch {
  title?: unknown;
  note?: unknown;
  tags?: unknown;
  archived?: unknown;
}

export async function updateSaved(id: string, patch: SavedPatch): Promise<SavedItem | null> {
  if (!isSavedId(id)) return null;
  const s = await sealer();
  const text = (v: unknown, max: number) => (v === undefined ? undefined : typeof v === "string" ? v.trim().slice(0, max) || null : v === null ? null : undefined);
  const title = text(patch.title, MAX_SAVED_TITLE);
  const note = text(patch.note, MAX_SAVED_TEXT);
  const tags = patch.tags === undefined ? undefined : cleanTags(patch.tags);
  const archived = patch.archived === undefined ? null : patch.archived === true;
  const [row] = await qRaw<{ id: string }>(
    `UPDATE saved_items SET
       title = CASE WHEN $2 THEN $3 ELSE title END,
       note = CASE WHEN $4 THEN $5 ELSE note END,
       tags = CASE WHEN $6 THEN $7::text[] ELSE tags END,
       archived_at = CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN COALESCE(archived_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 RETURNING id`,
    [id, title !== undefined, title === undefined ? null : s.maybe(title), note !== undefined, note === undefined ? null : s.maybe(note), tags !== undefined, tags ? s.list(tags) : null, archived],
  );
  return row ? getSaved(id, { readable: true }) : null;
}

/** Delete for good, image too. */
export async function deleteSaved(id: string): Promise<boolean> {
  if (!isSavedId(id)) return false;
  const [row] = await qRaw<{ id: string; has_image: boolean }>(`DELETE FROM saved_items WHERE id = $1 RETURNING id, has_image`, [id]);
  if (row?.has_image) await dropImage(id);
  return !!row;
}

/**
 * Re-seal kept images still under an old key (the backfill, after a rotation).
 * Walks the table by id, 50 at a time, until the budget runs out: an image
 * that can't be opened is counted and passed over, so it never holds up the
 * ones behind it.
 */
export async function resealSavedImages(currentKid: string, budgetMs = 4_000): Promise<{ resealed: number; failed: number }> {
  const until = Date.now() + budgetMs;
  let resealed = 0;
  let failed = 0;
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await qRaw<{ id: string }>(`SELECT id FROM saved_items WHERE has_image AND image_kid IS DISTINCT FROM $1 AND id > $2::uuid ORDER BY id LIMIT 50`, [currentKid, cursor]);
    for (const { id } of rows) {
      if (Date.now() > until) return { resealed, failed };
      cursor = id;
      const [lg, sm] = await Promise.all([readSavedImage(id, "lg"), readSavedImage(id, "sm")]);
      if (!lg || !sm) {
        failed++;
        continue;
      }
      const store = storeFor();
      const a = sealBytes(lg);
      const b = sealBytes(sm);
      await store.set(`${id}/lg`, new Uint8Array(a.sealed).buffer as ArrayBuffer);
      await store.set(`${id}/sm`, new Uint8Array(b.sealed).buffer as ArrayBuffer);
      await qRaw(`UPDATE saved_items SET image_kid = $2 WHERE id = $1`, [id, a.kid]);
      resealed++;
    }
    if (rows.length < 50) return { resealed, failed };
  }
}
