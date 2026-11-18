/**
 * Link previews for rich links in notes (migration 0040; docs/notes/rich-links.md).
 * A web address shown as a Card, or as a Mention with its site's favicon,
 * needs a title, summary, site, picture and favicon. This reads them once
 * and keeps them, without making a Saved item.
 *
 *  - Pages are read only through Saved's guarded fetch (lib/saved-fetch.ts:
 *    https, public hosts on every hop, a byte cap, one deadline) and read with
 *    Saved's extractor and kinds (lib/saved-extract.ts, lib/saved-kinds.ts).
 *  - The row is keyed by a blind index of the normalised address; the address
 *    isn't kept (every request brings it). Title, summary, site name,
 *    author, kind and facts are sealed. Status and dates stay readable.
 *  - The picture (1200px) and the favicon (64px) are re-encoded as WebP with
 *    metadata dropped, then sealed in the "athena-link-previews" blob store,
 *    as Saved keeps its pictures. An SVG or ICO favicon isn't kept.
 *  - A good read is kept for 30 days, then read again on the next request; a
 *    failed one is tried again after an hour. A refresh that fails keeps the
 *    last good preview.
 *  - An address one of the owner's connected accounts can open (a Notion
 *    page) is read through that account first (PreviewSource); otherwise the
 *    page is read like any other.
 *  - Nothing is fetched or kept without the data key.
 */
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { q, qRaw, sealer } from "./db";
import { blindIndex, blindIndexes, dataKeyConfigured, openBytes, sealBytes } from "./data-box";
import { decodeImage, sniffImage } from "./art";
import { extractPage, tooDeep } from "./saved-extract";
import { detectFromHtml, detectFromUrl, SAVED_THINGS, type SavedFacts, type SavedThing } from "./saved-kinds";
import { fetchPageHtml, fetchPageImage } from "./saved-fetch";
import { siteOf } from "./saved-rules";
import { normalisePreviewUrl, previewKeyText } from "./link-preview-url";
import { embedFor, type Embed } from "./embeds";

export const PREVIEW_FRESH_DAYS = 30;
export const PREVIEW_RETRY_MINUTES = 60;
/** A preview nobody has asked for in this many days is deleted by the monthly sweep (sweepLinkPreviews). */
export const PREVIEW_UNUSED_DAYS = 90;
/** Page reads a minute per caller (cache hits don't count). */
export const PREVIEW_FETCHES_PER_MINUTE = 30;
const IMAGE_EDGE = 1200;
const FAVICON_EDGE = 64;
const MAX_FAVICON_BYTES = 512 * 1024;

export type PreviewShape = "wide" | "square" | "tall";

/** What GET /api/link-preview answers. */
export interface LinkPreview {
  id: string;
  /** The normalised address this preview is for. */
  url: string;
  /** "ok": the page was read. "failed": it wasn't (the card keeps the address and offers Try again). */
  status: "ok" | "failed";
  title: string | null;
  summary: string | null;
  /** The page's own site name, or its host without "www.". */
  site_name: string;
  author: string | null;
  /** What it is (lib/saved-kinds.ts): a book, a product, a recipe… Null for a plain page. */
  kind: SavedThing | null;
  facts: SavedFacts | null;
  /** /api/link-preview/:id/image?v=…, or null. */
  image_url: string | null;
  image_w: number | null;
  image_h: number | null;
  /** The picture's average colour, for the card's glow ("tint"). */
  image_tone: string | null;
  shape: PreviewShape | null;
  /** /api/link-preview/:id/favicon?v=…, or null. */
  favicon_url: string | null;
  /** Last good read (ISO), or null when it has never been read. */
  fetched_at: string | null;
  /** The player, when the address has one (lib/embeds.ts). */
  embed: Embed | null;
}

export class PreviewUnavailable extends Error {}
export class PreviewRateLimited extends Error {}

// ---------- the address ----------

// normalisePreviewUrl lives in lib/link-preview-url.ts (pure), so the app keys its own copy the same way.
export { normalisePreviewUrl } from "./link-preview-url";

const keyText = previewKeyText;

// ---------- reading a page ----------

/** A picture's shape, for the card's layout: wide pictures sit on top, square ones beside. */
export function shapeOf(w: number | null | undefined, h: number | null | undefined): PreviewShape | null {
  if (!w || !h) return null;
  const r = w / h;
  return r >= 1.3 ? "wide" : r <= 0.8 ? "tall" : "square";
}

/**
 * The page's best favicon that Athena can keep: an apple-touch-icon, then a
 * PNG, WebP, JPEG or GIF icon (largest first). SVG and ICO aren't kept.
 */
export function faviconHref(html: string, base: string): string | null {
  const head = html.slice(0, 200_000);
  const found: Array<{ href: string; score: number }> = [];
  // [^<>]* stops at the next "<", so a run of unclosed "<link " tags is read in one pass (security review M18).
  for (const m of head.matchAll(/<link\b[^<>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const relM = attr("rel");
    const hrefM = attr("href");
    if (!relM || !hrefM) continue;
    const rel = (relM[2] ?? relM[3] ?? relM[4] ?? "").toLowerCase().split(/\s+/);
    const href = (hrefM[2] ?? hrefM[3] ?? hrefM[4] ?? "").trim();
    if (!href || /^data:/i.test(href)) continue;
    const typeM = attr("type");
    const type = (typeM?.[2] ?? typeM?.[3] ?? typeM?.[4] ?? "").toLowerCase();
    if (/svg|icon$|x-icon/.test(type) || /\.(svg|ico)(\?|#|$)/i.test(href)) continue;
    const sizesM = attr("sizes");
    const size = Number(/(\d+)x\d+/.exec(sizesM?.[2] ?? sizesM?.[3] ?? sizesM?.[4] ?? "")?.[1] ?? 0);
    let score: number;
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) score = 1000 + (size || 180);
    else if (rel.includes("icon")) score = size || 32;
    else continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    found.push({ href: abs, score });
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.href ?? null;
}

interface Picture {
  bytes: Buffer;
  w: number;
  h: number;
  tone: string;
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** One WebP size, EXIF orientation applied, metadata (location included) dropped. Null when it isn't an image sharp reads. */
async function picture(bytes: Uint8Array, edge: number): Promise<Picture | null> {
  if (!sniffImage(bytes)) return null;
  try {
    // One decode (refused above 25 megapixels from the header); the tone comes from the same pixels.
    const d = await decodeImage(bytes, edge);
    const [out, mean] = await Promise.all([d.from().webp({ quality: 80, effort: 4 }).toBuffer(), d.from().removeAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer()]);
    return { bytes: out, w: d.w, h: d.h, tone: `#${hex(mean[0])}${hex(mean[1])}${hex(mean[2])}` };
  } catch {
    return null;
  }
}

/** What one read of a page found. */
export interface PageRead {
  status: "ok" | "failed";
  title: string | null;
  summary: string | null;
  site_name: string | null;
  author: string | null;
  kind: SavedThing | null;
  facts: SavedFacts | null;
  image: Picture | null;
  favicon: Picture | null;
}

/** The network seams, replaced in tests: Saved's guarded fetch. */
export const previewDeps = {
  fetchHtml: (url: string) => fetchPageHtml(url),
  fetchImage: (url: string, maxBytes?: number) => fetchPageImage(url, maxBytes),
};

/**
 * A richer way to read some addresses than fetching the page: one of the
 * owner's connected accounts that can open it (a private Notion page, which a
 * plain fetch only sees as a sign-in page). The owner chose (stage 1
 * questions): use a connector when there is one, else read it like any page.
 * Sources are registered by the server (netlify/lib/rich-links/connector-previews.ts);
 * `read` returns null when it has no account or can't open this one, and the
 * page is then read as usual.
 */
export interface PreviewSource {
  id: string;
  matches(url: URL): boolean;
  read(url: string): Promise<Pick<PageRead, "title" | "summary" | "site_name" | "author"> | null>;
}

const sources: PreviewSource[] = [];
/** Add a source (once per id; a later one with the same id replaces it). */
export function registerPreviewSource(source: PreviewSource): void {
  const at = sources.findIndex((s) => s.id === source.id);
  if (at >= 0) sources[at] = source;
  else sources.push(source);
}

async function fromSource(url: string): Promise<Pick<PageRead, "title" | "summary" | "site_name" | "author"> | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const source of sources) {
    if (!source.matches(u)) continue;
    try {
      const got = await source.read(url);
      if (got?.title) return got;
    } catch {
      // the account is signed out or the server failed: read the page instead
    }
  }
  return null;
}

/** Read a page once. Never throws: a page that can't be read is "failed" (with what its address says about it). */
export async function readPreview(url: string): Promise<PageRead> {
  const fromUrl = detectFromUrl(url);
  const failed: PageRead = { status: "failed", title: null, summary: null, site_name: null, author: null, kind: fromUrl?.type ?? null, facts: fromUrl && Object.keys(fromUrl.facts).length ? fromUrl.facts : null, image: null, favicon: null };
  const rich = await fromSource(url);
  if (rich) return { ...failed, ...rich, status: "ok" };
  let page: { html: string; url: string };
  let x: ReturnType<typeof extractPage>;
  let thing: ReturnType<typeof detectFromHtml>;
  let icon: string | null;
  try {
    page = await previewDeps.fetchHtml(url);
    // Reading the page is inside the try too: a page that makes a parser throw is "failed", never a 500 (security review M21).
    if (tooDeep(page.html)) return failed;
    x = extractPage(page.html, page.url);
    thing = detectFromHtml(page.html, page.url, { title: x.title, author: x.author, hasText: !!x.text }) ?? fromUrl;
    icon = faviconHref(page.html, page.url);
  } catch {
    return failed;
  }
  const [image, favicon] = await Promise.all([
    x.image ? previewDeps.fetchImage(x.image).then((b) => picture(b, IMAGE_EDGE)).catch(() => null) : null,
    icon ? previewDeps.fetchImage(icon, MAX_FAVICON_BYTES).then((b) => picture(b, FAVICON_EDGE)).catch(() => null) : null,
  ]);
  return {
    status: "ok",
    title: x.title,
    summary: x.excerpt,
    site_name: x.site_name,
    author: x.author,
    kind: thing?.type ?? null,
    facts: thing && Object.keys(thing.facts).length ? thing.facts : null,
    image,
    favicon,
  };
}

// ---------- the cache ----------

const STORE = "athena-link-previews";
let storeFor: () => ReturnType<typeof getStore> = () => getStore({ name: STORE, consistency: "strong" });
/** Replace the blob store (tests). */
export function usePreviewStore(make: () => ReturnType<typeof getStore>): void {
  storeFor = make;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isPreviewId = (raw: unknown): raw is string => typeof raw === "string" && UUID_RE.test(raw);

interface Row {
  id: string;
  status: "ok" | "failed";
  title: string | null;
  summary: string | null;
  site_name: string | null;
  author: string | null;
  kind: string | null;
  facts: string | null;
  has_image: boolean;
  image_w: number | null;
  image_h: number | null;
  image_tone: string | null;
  has_favicon: boolean;
  fetched_at: Date | string | null;
  checked_at: Date | string;
}

const COLS = "id, status, title, summary, site_name, author, kind, facts, has_image, image_w, image_h, image_tone, has_favicon, fetched_at, checked_at";
const ms = (v: Date | string) => (v instanceof Date ? v : new Date(v)).getTime();

function toPreview(r: Row, url: string): LinkPreview {
  const v = r.fetched_at ? ms(r.fetched_at).toString(36) : "0";
  let facts: SavedFacts | null = null;
  try {
    const parsed = r.facts ? JSON.parse(r.facts) : null;
    facts = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    facts = null;
  }
  return {
    id: r.id,
    url,
    status: r.status,
    title: r.title,
    summary: r.summary,
    site_name: r.site_name || siteOf(url) || url,
    author: r.author,
    kind: (SAVED_THINGS as readonly string[]).includes(r.kind ?? "") ? (r.kind as SavedThing) : null,
    facts,
    image_url: r.has_image ? `/api/link-preview/${r.id}/image?v=${v}` : null,
    image_w: r.has_image ? r.image_w : null,
    image_h: r.has_image ? r.image_h : null,
    image_tone: r.has_image ? r.image_tone : null,
    shape: r.has_image ? shapeOf(r.image_w, r.image_h) : null,
    favicon_url: r.has_favicon ? `/api/link-preview/${r.id}/favicon?v=${v}` : null,
    fetched_at: r.fetched_at ? new Date(ms(r.fetched_at)).toISOString() : null,
    embed: embedFor(url),
  };
}

/** Whether a kept row is still good: a good read for 30 days, a failure for an hour. */
export function isFresh(r: Pick<Row, "status" | "fetched_at" | "checked_at">, now = Date.now()): boolean {
  if (r.status === "ok" && r.fetched_at && now - ms(r.fetched_at) < PREVIEW_FRESH_DAYS * 86_400_000) return true;
  return now - ms(r.checked_at) < PREVIEW_RETRY_MINUTES * 60_000;
}

async function findRow(url: string): Promise<Row | null> {
  const keys = blindIndexes("other", keyText(url));
  if (!keys.length) return null;
  const [row] = await q<Row>(`SELECT ${COLS} FROM link_previews WHERE url_bidx = ANY($1::text[]) ORDER BY checked_at DESC LIMIT 1`, [keys]);
  return row ?? null;
}

/** Page reads a minute per caller, across every Function instance (Saved's per-minute table, its own bucket). */
export async function takePreviewSlot(req: Request, limit = PREVIEW_FETCHES_PER_MINUTE): Promise<boolean> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const bucket = createHash("sha256").update(`link-preview-rate\u0000${token}`).digest("hex").slice(0, 32);
  const [row] = await qRaw<{ n: number }>(
    `INSERT INTO saved_rate (bucket, minute, n) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, minute) DO UPDATE SET n = saved_rate.n + 1 RETURNING n`,
    [bucket],
  );
  return (row?.n ?? 0) <= limit;
}

async function keepPicture(id: string, which: "image" | "favicon", p: Picture): Promise<string> {
  const sealed = sealBytes(p.bytes);
  await storeFor().set(`${id}/${which}`, new Uint8Array(sealed.sealed).buffer as ArrayBuffer);
  return sealed.kid;
}

/** Write what a read found. A failed refresh keeps the last good preview and only notes the try. */
async function keep(url: string, have: Row | null, read: PageRead): Promise<Row> {
  const s = await sealer();
  const bidx = blindIndex("other", keyText(url));
  if (!bidx) throw new PreviewUnavailable("no key");
  if (read.status === "failed" && have?.status === "ok") {
    const [row] = await q<Row>(`UPDATE link_previews SET checked_at = now() WHERE id = $1 RETURNING ${COLS}`, [have.id]);
    return row ?? have;
  }
  const facts = read.facts ? s.text(JSON.stringify(read.facts)) : null;
  const [row] = await q<Row>(
    `INSERT INTO link_previews (url_bidx, status, title, summary, site_name, author, kind, facts, image_w, image_h, image_tone, fetched_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (url_bidx) DO UPDATE SET status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary, site_name = EXCLUDED.site_name,
       author = EXCLUDED.author, kind = EXCLUDED.kind, facts = EXCLUDED.facts, image_w = EXCLUDED.image_w, image_h = EXCLUDED.image_h,
       image_tone = EXCLUDED.image_tone, fetched_at = COALESCE(EXCLUDED.fetched_at, link_previews.fetched_at), checked_at = now(),
       has_image = false, has_favicon = false
     RETURNING ${COLS}`,
    [
      bidx,
      read.status,
      s.maybe(read.title),
      s.maybe(read.summary),
      s.maybe(read.site_name),
      s.maybe(read.author),
      read.kind ? s.text(read.kind) : null,
      facts,
      read.image?.w ?? null,
      read.image?.h ?? null,
      read.image?.tone ?? null,
      read.status === "ok" ? new Date().toISOString() : null,
    ],
  );
  // An older row under a previous key's index: this one replaces it.
  if (have && have.id !== row.id) await dropPreview(have.id);
  const [imageKid, faviconKid] = await Promise.all([
    read.image ? keepPicture(row.id, "image", read.image) : storeFor().delete(`${row.id}/image`).then(() => null).catch(() => null),
    read.favicon ? keepPicture(row.id, "favicon", read.favicon) : storeFor().delete(`${row.id}/favicon`).then(() => null).catch(() => null),
  ]);
  if (imageKid || faviconKid) {
    await qRaw(`UPDATE link_previews SET has_image = $2, image_kid = $3, has_favicon = $4, favicon_kid = $5 WHERE id = $1`, [row.id, !!imageKid, imageKid, !!faviconKid, faviconKid]);
    row.has_image = !!imageKid;
    row.has_favicon = !!faviconKid;
  }
  return row;
}

async function dropPreview(id: string): Promise<void> {
  await qRaw(`DELETE FROM link_previews WHERE id = $1`, [id]);
  await Promise.all([storeFor().delete(`${id}/image`), storeFor().delete(`${id}/favicon`)]).catch(() => undefined);
}

export interface PreviewOptions {
  /** Called before a page is read; false means over the limit. Cache hits never call it. */
  takeSlot?: () => Promise<boolean>;
  /** Read again even if the kept preview is fresh (the card's Try again). Still rate-limited. */
  refresh?: boolean;
  now?: number;
}

/**
 * The preview for an address: kept, or read now and kept. Null for an
 * address that isn't a web address. Throws PreviewUnavailable without the
 * data key, and PreviewRateLimited when a read is needed and the caller is
 * over the limit (a stale preview is returned instead when there is one).
 */
export async function getLinkPreview(raw: unknown, opts: PreviewOptions = {}): Promise<LinkPreview | null> {
  const url = normalisePreviewUrl(raw);
  if (!url) return null;
  if (!dataKeyConfigured()) throw new PreviewUnavailable("no key");
  const have = await findRow(url);
  if (have && !opts.refresh && isFresh(have, opts.now)) return toPreview(have, url);
  if (opts.takeSlot && !(await opts.takeSlot())) {
    if (have) return toPreview(have, url);
    throw new PreviewRateLimited("too many");
  }
  const read = await readPreview(url);
  return toPreview(await keep(url, have, read), url);
}

/** A kept picture or favicon, opened. Null when there's none (or it can't be opened here). */
export async function readPreviewPicture(id: string, which: "image" | "favicon"): Promise<Buffer | null> {
  if (!isPreviewId(id)) return null;
  const [row] = await qRaw<{ has: boolean }>(`SELECT ${which === "image" ? "has_image" : "has_favicon"} AS has FROM link_previews WHERE id = $1`, [id]);
  if (!row?.has) return null;
  const sealed = await storeFor().get(`${id}/${which}`, { type: "arrayBuffer" });
  if (!sealed) return null;
  try {
    return openBytes(new Uint8Array(sealed));
  } catch {
    return null;
  }
}

// ---------- Key rotation ----------

/**
 * After a key rotation: drop the previews still under another key
 * (lib/encryption.ts calls this). A row is found by a blind index of its
 * address under the key that wrote it, and the address isn't kept, so it
 * can't be moved to the current key: it's read again when next shown.
 * Returns how many went.
 */
export async function dropStalePreviews(kid: string, budgetMs = 4_000): Promise<number> {
  const until = Date.now() + budgetMs;
  const sealed = ["title", "summary", "site_name", "author", "kind", "facts"].map((c) => `${c} NOT LIKE $1`);
  let dropped = 0;
  while (Date.now() < until) {
    const rows = await qRaw<{ id: string }>(
      `SELECT id FROM link_previews WHERE ${sealed.join(" OR ")} OR image_kid <> $2 OR favicon_kid <> $2 ORDER BY id LIMIT 50`,
      [`enc:v1:${kid}:%`, kid],
    );
    if (!rows.length) break;
    for (const { id } of rows) await dropPreview(id);
    dropped += rows.length;
  }
  return dropped;
}

// ---------- the monthly sweep ----------

/**
 * Rows to delete: those not used for PREVIEW_UNUSED_DAYS. A row has no
 * "last used" column (no migration for it), but every use reads the page
 * again once a preview is 30 days old, which moves checked_at. So a row
 * used at any time in the last 90 days has a checked_at within the last
 * 90 + 30 days, and a row checked longer ago than that hasn't been used for
 * at least 90 days.
 */
export function sweepCutoff(now = Date.now()): Date {
  return new Date(now - (PREVIEW_UNUSED_DAYS + PREVIEW_FRESH_DAYS) * 86_400_000);
}

/** Delete previews (and their pictures) not used for 90 days. Returns how many went. Run monthly (netlify/functions/link-previews-sweep.ts). */
export async function sweepLinkPreviews(opts: { now?: number; limit?: number } = {}): Promise<number> {
  const rows = await qRaw<{ id: string }>(
    `DELETE FROM link_previews WHERE id IN (SELECT id FROM link_previews WHERE checked_at < $1 ORDER BY checked_at LIMIT $2) RETURNING id`,
    [sweepCutoff(opts.now).toISOString(), opts.limit ?? 5000],
  );
  for (const { id } of rows) await Promise.all([storeFor().delete(`${id}/image`), storeFor().delete(`${id}/favicon`)]).catch(() => undefined);
  return rows.length;
}
