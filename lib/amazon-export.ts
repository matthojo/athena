/**
 * An Amazon data export (Account → Data and privacy → Request your data):
 * a zip of folders of CSVs, sometimes with more zips inside. Pure, so the
 * app (components/amazon-import.ts) and the tests share it, like
 * lib/youtube-takeout.ts.
 *
 * Files are found by their columns, never their paths: Amazon names them
 * differently by account, country and year (Retail.OrderHistory.1.csv,
 * Retail.OrderHistory.2.csv, "Digital Items.csv", Kindle.Devices.
 * ReadingSession…), so each CSV's first line is read and matched against
 * what each kind needs (`sniff`). A path is only a tiebreak, for a library
 * file that could be Kindle's or Audible's.
 *
 * What it reads:
 *  - Retail orders: order id, day, items (name, ASIN, quantity, price and
 *    currency), status, shipped and delivered days.
 *  - Returns: which order (and item, when the file says) went back.
 *  - Digital orders: paid Kindle books, apps, films. Free ones are left out.
 *  - Kindle reading sessions: minutes per book per day.
 *  - Audible listening: minutes per title per day, and finished when the
 *    last position reaches the end.
 *  - Prime Video viewing: films and episodes per day.
 *  - Library files: ASIN to title for the sessions (Kindle's sessions name
 *    no book), and which books the export says were finished.
 *
 * Addresses, payment methods, gift messages and tracking numbers are never
 * read. Prices are read so the server can seal them with finance
 * (netlify/lib/days/amazon-import.ts); they never go on a purchase.
 *
 * Big exports: the zip is read entry by entry (only each CSV's head until
 * it's known to be wanted), and `parseAmazonExport` takes a `pause` it
 * awaits every few thousand rows, so the app can yield to the page.
 */
import { zonedParts, isValidDate } from "./dates";
import { parseCsv, readDate, type DateOrder } from "./netflix-csv";

// ---------- Shapes ----------

export type AmazonKind = "orders" | "returns" | "digital" | "kindle" | "audible" | "prime" | "library" | "titles";

export interface Money {
  /** In the currency's units, two places: 12.99. */
  amount: number;
  /** ISO 4217 when known ("GBP"), else "". */
  currency: string;
}

export type OrderStatus = "ordered" | "dispatched" | "delivered" | "cancelled" | "returned";

export interface OrderItem {
  /** Stable within the order: the ASIN, else the name's key. Dedupes "order id + item". */
  key: string;
  name: string;
  asin?: string;
  quantity: number;
  /** What was paid for this line, when the file says. Sealed on the server, never shown on a purchase. */
  price?: Money;
  returned?: boolean;
}

export interface AmazonOrder {
  id: string;
  /** The day it was ordered, in the owner's zone. */
  day: string;
  status: OrderStatus;
  /** When that status happened, ISO 8601. */
  statusAt: string;
  shippedOn?: string;
  deliveredOn?: string;
  returnedOn?: string;
  /** A return the file couldn't tie to one item, on an order with several. */
  partReturned?: boolean;
  digital?: boolean;
  items: OrderItem[];
}

export type MediaSource = "kindle" | "audible" | "prime_video";

export interface MediaItem {
  source: MediaSource;
  /** ASIN, or for Prime Video without one, the title and episode's key. */
  key: string;
  title: string;
  /** Author or narrator for books; season and episode for a show. */
  subtitle?: string;
  minutes?: number;
  /** Prime Video: a show (episodes share the title as their group). */
  show?: boolean;
}

export interface MediaDay {
  day: string;
  items: MediaItem[];
}

export interface FinishedTitle {
  source: "kindle" | "audible";
  asin: string;
  title: string;
  author?: string;
  /** The day it was finished, when known. */
  day?: string;
}

export interface AmazonCounts {
  orders: number;
  items: number;
  returned: number;
  digital: number;
  kindleDays: number;
  kindleBooks: number;
  kindleMinutes: number;
  audibleDays: number;
  audibleTitles: number;
  audibleMinutes: number;
  primeDays: number;
  primeTitles: number;
  finished: number;
}

export interface AmazonExport {
  orders: AmazonOrder[];
  /** Oldest first. */
  days: MediaDay[];
  finished: FinishedTitle[];
  counts: AmazonCounts;
  /** First and last day across everything, or null for an empty export. */
  range: { first: string; last: string } | null;
  /** The files read, by kind (for the preview's small print and the tests). */
  files: Array<{ name: string; kind: AmazonKind }>;
  skipped: {
    /** Kindle sessions for books nothing in the export names. */
    untitled: number;
    undated: number;
    future: number;
    /** Free digital items (samples, free books). */
    free: number;
  };
}

export class AmazonExportError extends Error {
  constructor(public readonly reason: "not-zip" | "nothing" | "too-big" | "unreadable") {
    super(reason);
  }
}

// ---------- Headers ----------

/** "Order ID", "OrderId" and "order_id" are the same column. */
export const norm = (s: string) => s.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const ORDER_ID = ["orderid", "ordernumber", "orderno"];
const ORDER_DATE = ["orderdate", "orderdatetime", "orderplaceddate", "ordertimestamp"];
const NAME = ["productname", "title", "itemname", "itemtitle", "description", "producttitle", "contenttitle"];
const ASIN = ["asin", "asinisbn", "productasin", "contentasin"];
const SHIPPING = ["shipmentstatus", "shipdate", "orderstatus", "shippingoption", "carriernametrackingnumber", "totalowed", "unitprice", "shipmentitemsubtotal"];
const DIGITAL = ["digitalorderitemid", "fulfilleddate", "ourprice", "isfulfilled", "ourpricecurrencycode", "digitalorderitemids"];
const RETURN = ["returnreason", "reversalreason", "returnauthorizationid", "reversalid", "refundcompletiondate", "returndate", "returnstatus", "reversalstatus", "returncreationdate", "returnrequestdate", "rmaid"];
const READING = ["totalreadingmillis", "readingmillis", "totalreadingtime", "readingtimemillis", "totalreadingtimemillis"];
const START = ["starttimestamp", "starttime", "startdate", "sessionstart", "startdatetime", "eventstarttimestamp", "starttimeutc"];
const LISTENING = ["eventdurationmilliseconds", "listeningdurationmilliseconds", "durationmilliseconds", "listeningtime", "listeningtimemilliseconds", "listentimemillis", "eventduration"];
const FINISH = ["isfinished", "finished", "finisheddate", "datefinished", "completiondate", "datecompleted", "markedasfinished", "listeningstatus", "readstatus", "readingstatus"];
const PRIME_TITLE = ["title", "videotitle", "contenttitle", "programtitle", "seriestitle", "showtitle"];
const PRIME_HINT = ["episodename", "episodetitle", "episode", "episodenumber", "seasonnumber", "season", "playbackstartdatetimeutc", "playbackstart", "playbackhour", "viewingdate", "dateviewed", "watcheddate", "datewatched", "secondsviewed", "durationwatched", "deliverytype", "videotype", "playbackenddatetimeutc"];
const DATEISH = ["playbackstartdatetimeutc", "playbackstart", "playbackhour", "viewingdate", "dateviewed", "watcheddate", "datewatched", "date", "viewedat", "playbackdate", "starttime", "startdate", "timestamp"];

const any = (h: Set<string>, names: string[]) => names.some((n) => h.has(n));

/**
 * What a CSV is, from its header row (and, only to break a tie, its path):
 * null when it's nothing the import reads (addresses, payments, search…).
 */
export function sniff(header: string[], path = ""): AmazonKind | null {
  const h = new Set(header.map(norm));
  const hasId = any(h, ORDER_ID);
  if (hasId && any(h, DIGITAL) && any(h, NAME)) return "digital";
  if (hasId && any(h, RETURN)) return "returns";
  if (hasId && any(h, ORDER_DATE) && any(h, NAME) && any(h, SHIPPING)) return "orders";
  if (hasId) return null;
  if (any(h, ASIN) && any(h, READING) && any(h, START)) return "kindle";
  if (any(h, LISTENING) && any(h, START) && (any(h, ASIN) || any(h, NAME))) return "audible";
  if (any(h, ASIN) && any(h, NAME) && any(h, FINISH)) return "library";
  if (any(h, PRIME_TITLE) && any(h, PRIME_HINT) && any(h, DATEISH) && !any(h, READING)) return "prime";
  if (any(h, ASIN) && any(h, NAME)) return "titles";
  void path;
  return null;
}

// ---------- Zip (read entry by entry) ----------

/** Where the zip's bytes come from: a File in the app, a Buffer in the tests. */
export interface ByteSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export const blobSource = (b: Blob): ByteSource => ({ size: b.size, read: async (s, e) => new Uint8Array(await b.slice(s, e).arrayBuffer()) });
export const bytesSource = (u: Uint8Array): ByteSource => ({ size: u.byteLength, read: async (s, e) => u.subarray(s, Math.min(e, u.byteLength)) });

/** So a broken or hostile zip can't make the tab inflate gigabytes. */
export const ZIP_LIMITS = { entryBytes: 256 * 2 ** 20, totalBytes: 768 * 2 ** 20, entries: 100_000, nestedBytes: 400 * 2 ** 20, depth: 2 };

export interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => u32(v, o) + u32(v, o + 4) * 2 ** 32;
const dv = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

export async function isZipSource(src: ByteSource): Promise<boolean> {
  if (src.size < 4) return false;
  return u32(dv(await src.read(0, 4)), 0) === 0x04034b50;
}

/** The zip's central directory: every entry's name, size and where it starts. */
export async function zipEntries(src: ByteSource): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, src.size - 65_557);
  const tail = dv(await src.read(tailStart, src.size));
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AmazonExportError("not-zip");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new AmazonExportError("not-zip");
    const recAt = u64(tail, loc + 8);
    const rec = dv(await src.read(recAt, recAt + 56));
    if (u32(rec, 0) !== 0x06064b50) throw new AmazonExportError("not-zip");
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (count > ZIP_LIMITS.entries || cdSize > 64 * 2 ** 20) throw new AmazonExportError("too-big");
  const cd = dv(await src.read(cdOffset, cdOffset + cdSize));
  const out: ZipEntry[] = [];
  const names = new TextDecoder();
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50; i++) {
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let compressed = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    let offset = u32(cd, p + 42);
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        if (size === 0xffffffff) (size = u64(cd, f)), (f += 8);
        if (compressed === 0xffffffff) (compressed = u64(cd, f)), (f += 8);
        if (offset === 0xffffffff) offset = u64(cd, f);
      }
      e += 4 + len;
    }
    if (!name.endsWith("/")) out.push({ name, method: u16(cd, p + 10), compressed, size, offset });
    p = extraEnd + commentLen;
  }
  return out;
}

/** An entry's bytes as a stream, inflated. */
async function entryStream(src: ByteSource, entry: ZipEntry, upTo = entry.compressed): Promise<ReadableStream<Uint8Array>> {
  const head = dv(await src.read(entry.offset, entry.offset + 30));
  if (u32(head, 0) !== 0x04034b50) throw new AmazonExportError("unreadable");
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = await src.read(start, start + Math.min(upTo, entry.compressed));
  const stream = new Blob([raw as BlobPart]).stream() as ReadableStream<Uint8Array>;
  if (entry.method === 0) return stream;
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") throw new AmazonExportError("unreadable");
  return stream.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Up to `limit` inflated bytes, then stop (a head) or throw (a whole entry that's too big). */
async function collect(stream: ReadableStream<Uint8Array>, limit: number, partial: boolean): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.byteLength;
      if (bytes >= limit) {
        if (partial) break;
        throw new AmazonExportError("too-big");
      }
    }
  } catch (err) {
    // A head read from a cut-off slice ends in a decompression error once it runs dry: what came out is enough.
    if (!partial || err instanceof AmazonExportError) throw err;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(bytes, partial ? limit : bytes));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    out.set(p.subarray(0, out.length - at), at);
    at += p.byteLength;
  }
  return out;
}

/** The first line of a CSV entry: enough to know what it is. */
async function headOf(src: ByteSource, entry: ZipEntry): Promise<string[]> {
  const bytes = await collect(await entryStream(src, entry, 32 * 1024), 16 * 1024, true);
  const text = new TextDecoder().decode(bytes);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return parseCsv(line)[0] ?? [];
}

export interface FoundFile {
  /** Path inside the zip; a nested zip's files read "outer.zip/inner.csv". */
  name: string;
  kind: AmazonKind;
  bytes: number;
  /** Reads the whole file as text. */
  text: () => Promise<string>;
}

/**
 * The CSVs worth reading in an export zip, nested zips included, each read
 * only as far as its header. `progress` is told how many entries have been
 * looked at, for the app's "Looking through…" line.
 */
export async function findAmazonFiles(src: ByteSource, opts: { progress?: (looked: number, total: number) => void; depth?: number; prefix?: string } = {}): Promise<FoundFile[]> {
  const entries = await zipEntries(src);
  const out: FoundFile[] = [];
  const depth = opts.depth ?? 0;
  const prefix = opts.prefix ?? "";
  let looked = 0;
  for (const e of entries) {
    looked++;
    opts.progress?.(looked, entries.length);
    if (/(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
    if (/\.zip$/i.test(e.name) && depth < ZIP_LIMITS.depth && e.size <= ZIP_LIMITS.nestedBytes) {
      try {
        const inner = await collect(await entryStream(src, e), ZIP_LIMITS.nestedBytes, false);
        out.push(...(await findAmazonFiles(bytesSource(inner), { depth: depth + 1, prefix: `${prefix}${e.name}/` })));
      } catch {
        // A nested zip that won't open is skipped; the rest still comes in.
      }
      continue;
    }
    if (!/\.csv$/i.test(e.name) || e.size === 0 || e.size > ZIP_LIMITS.entryBytes) continue;
    let header: string[];
    try {
      header = await headOf(src, e);
    } catch {
      continue;
    }
    const name = `${prefix}${e.name}`;
    const kind = sniff(header, name);
    if (!kind) continue;
    out.push({
      name,
      kind,
      bytes: e.size,
      text: async () => new TextDecoder().decode(await collect(await entryStream(src, e), ZIP_LIMITS.entryBytes + 1, false)),
    });
  }
  if (depth === 0 && out.reduce((k, f) => k + f.bytes, 0) > ZIP_LIMITS.totalBytes) throw new AmazonExportError("too-big");
  return out;
}

// ---------- Cells ----------

const NA = /^(not available|n\/a|na|none|null|undefined|-|—|unknown|not applicable)$/i;
const cell = (row: string[], i: number) => {
  if (i < 0) return "";
  const v = (row[i] ?? "").trim();
  return NA.test(v) ? "" : v;
};

/** Control characters out, spaces tidied, "·" kept out of titles (Days uses it as a separator). */
export const tidy = (s: string, max = 300) =>
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max);

/** For matching a name: case, accents and punctuation ignored. */
export const nameKey = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const SYMBOLS: Array<[RegExp, string]> = [
  [/£/, "GBP"],
  [/€/, "EUR"],
  [/US\$|\$/, "USD"],
  [/¥|￥/, "JPY"],
  [/₹/, "INR"],
];

/**
 * A price: "£12.99", "12.99", "1,234.56", "12,99 €", "EUR 12,99". undefined
 * for empty or unreadable; currency from the cell's symbol or `fallback`.
 */
export function readMoney(raw: string, fallback = ""): Money | undefined {
  const s = raw.trim();
  if (!s || NA.test(s)) return undefined;
  let currency = /^[A-Z]{3}$/.test(fallback.trim().toUpperCase()) ? fallback.trim().toUpperCase() : "";
  const code = /\b([A-Z]{3})\b/.exec(s)?.[1];
  if (code) currency = code;
  else for (const [re, c] of SYMBOLS) if (re.test(s) && !currency) currency = c;
  let num = s.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(num)) return undefined;
  const lastDot = num.lastIndexOf(".");
  const lastComma = num.lastIndexOf(",");
  // The later of "." and "," is the decimal point when two digits follow it, or it's the only kind there.
  if (lastComma > lastDot && (num.length - lastComma - 1 === 2 || (lastDot < 0 && num.length - lastComma - 1 !== 3))) num = num.replace(/\./g, "").replace(",", ".");
  else num = num.replace(/,/g, "");
  const amount = Number(num);
  if (!Number.isFinite(amount)) return undefined;
  return { amount: Math.round(amount * 100) / 100, currency };
}

export interface TimeOpts {
  /** The owner's zone, for which day a UTC time falls on. */
  tz: string;
  order: DateOrder;
}

/**
 * An instant from a cell: ISO ("2024-03-14T10:22:31Z", "2024-03-14 10:22:31
 * UTC", no zone means UTC), epoch milliseconds, or a date ("14/03/2024",
 * "2024-03-14") at noon UTC. null when it isn't one.
 */
export function readInstant(raw: string, order: DateOrder): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (iso) {
    const zone = !iso[3] || /^(z|utc|gmt)$/i.test(iso[3]) ? "Z" : iso[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const time = iso[2].indexOf(":") === 1 ? `0${iso[2]}` : iso[2];
    const d = new Date(`${iso[1]}T${time}${zone}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dateOnly = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?(\s*(UTC|GMT|Z))?$/i, "").trim();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? (isValidDate(dateOnly) ? dateOnly : null) : readDate(dateOnly, order);
  return day ? new Date(`${day}T12:00:00Z`) : null;
}

/** The owner's day for a cell, or null. A date with no time stays that date. */
export function readDay(raw: string, t: TimeOpts): string | null {
  const d = readInstant(raw, t.order);
  if (!d) return null;
  const noTime = !/\d:\d{2}/.test(raw) && !/^\d{12,13}$/.test(raw.trim());
  return noTime ? d.toISOString().slice(0, 10) : zonedParts(d, t.tz).date;
}

/** Day order for slash dates across every date-ish cell in the export. */
function orderOf(samples: string[], locale?: string): DateOrder {
  let dmy = false;
  let mdy = false;
  for (const raw of samples) {
    const m = /^(\d{1,2})\/(\d{1,2})\/\d{2,4}/.exec(raw.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    else if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  return /^en-(us|ph)$/i.test(locale ?? "") || /^(en|es)-US/i.test(locale ?? "") ? "mdy" : "dmy";
}

// ---------- Columns ----------

class Cols {
  private idx = new Map<string, number>();
  constructor(header: string[]) {
    header.forEach((h, i) => {
      const k = norm(h);
      if (!this.idx.has(k)) this.idx.set(k, i);
    });
  }
  /** The first of `names` the file has, else -1. */
  find(...names: string[][]): number {
    for (const list of names) for (const n of list) if (this.idx.has(n)) return this.idx.get(n)!;
    return -1;
  }
  /** A column whose name matches. */
  match(re: RegExp): number {
    for (const [k, i] of this.idx) if (re.test(k)) return i;
    return -1;
  }
}

// ---------- Parsing ----------

export interface ParseOptions {
  /** The owner's zone. Default UTC. */
  tz?: string;
  /** navigator.language, for slash dates that could be either way round. */
  locale?: string;
  /** YYYY-MM-DD: later days are left out. Default today in `tz`. */
  today?: string;
  /** Awaited every few thousand rows, so a big export doesn't freeze the page. */
  pause?: () => Promise<void>;
  /** Told how far through the rows it is (0–1). */
  progress?: (fraction: number) => void;
}

const STEP = 2_000;
/** Older than this and still "shipped" or open: Amazon closed it long ago. */
const SETTLE_DAYS = 30;
const MIN_KINDLE_MS = 60_000;
const MIN_PRIME_SECONDS = 120;
const FINISHED_SHARE = 0.97;

type Draft = AmazonOrder;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const isoAt = (day: string) => `${day}T12:00:00.000Z`;

/**
 * Read the files of an export into orders, media days and finished titles.
 * `files` are the CSVs `findAmazonFiles` found (or, in the tests and the
 * sample, plain texts with a name).
 */
export async function parseAmazonExport(files: Array<{ name: string; text: string; kind?: AmazonKind }>, opts: ParseOptions = {}): Promise<AmazonExport> {
  const tz = opts.tz ?? "UTC";
  const today = opts.today ?? zonedParts(new Date(), tz).date;
  const pause = opts.pause ?? (async () => undefined);
  const skipped = { untitled: 0, undated: 0, future: 0, free: 0 };
  const read: Array<{ name: string; kind: AmazonKind; header: string[]; rows: string[][] }> = [];
  for (const f of files) {
    const rows = await csvInSteps(f.text, pause);
    if (!rows.length) continue;
    const header = rows[0];
    const kind = f.kind ?? sniff(header, f.name);
    if (!kind) continue;
    read.push({ name: f.name, kind, header, rows: rows.slice(1) });
    await pause();
  }
  // Slash dates: one order for the whole export, from every date-ish cell.
  const samples: string[] = [];
  for (const f of read) {
    const c = new Cols(f.header);
    const cols = [c.find(ORDER_DATE), c.find(START), c.find(DATEISH), c.find(["shipdate"]), c.find(FINISH)].filter((i) => i >= 0);
    for (const r of f.rows.slice(0, 500)) for (const i of cols) samples.push(r[i] ?? "");
  }
  const t: TimeOpts = { tz, order: orderOf(samples, opts.locale) };
  const total = read.reduce((k, f) => k + f.rows.length, 0) || 1;
  let done = 0;
  const tick = async (i: number) => {
    if (i % STEP === STEP - 1) {
      opts.progress?.(Math.min(1, (done + i) / total));
      await pause();
    }
  };

  // ASIN → title (and author), from every file that pairs them.
  const titles = new Map<string, { title: string; author?: string }>();
  const learn = (asin: string, title: string, author?: string) => {
    const a = asin.trim().toUpperCase();
    const ti = tidy(title);
    if (a && ti && !titles.has(a)) titles.set(a, { title: ti, ...(author ? { author: tidy(author, 120) } : {}) });
  };
  for (const f of read) {
    const c = new Cols(f.header);
    const ai = c.find(ASIN);
    const ni = c.find(NAME);
    const au = c.find(["author", "authors", "authorname", "creator"]);
    if (ai < 0 || ni < 0) continue;
    for (let i = 0; i < f.rows.length; i++) {
      if (i % STEP === STEP - 1) await pause();
      const r = f.rows[i];
      learn(cell(r, ai), cell(r, ni), cell(r, au) || undefined);
    }
  }

  const orders = new Map<string, Draft>();
  const finished = new Map<string, FinishedTitle>();
  const media = new Map<string, Map<string, MediaItem>>();
  const addMedia = (day: string, item: MediaItem) => {
    const m = media.get(day) ?? media.set(day, new Map()).get(day)!;
    const k = `${item.source}:${item.key}`;
    const have = m.get(k);
    if (have) {
      if (item.minutes) have.minutes = (have.minutes ?? 0) + item.minutes;
    } else m.set(k, { ...item });
  };
  const dayOk = (day: string | null): day is string => {
    if (!day) {
      skipped.undated++;
      return false;
    }
    if (day > today) {
      skipped.future++;
      return false;
    }
    return true;
  };

  // Orders first, then returns (which need them).
  const ordered = [...read].sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const f of ordered) {
    const c = new Cols(f.header);
    if (f.kind === "orders" || f.kind === "digital") {
      const digital = f.kind === "digital";
      const id = c.find(ORDER_ID);
      const date = c.find(ORDER_DATE);
      const name = digital ? c.find(["title", "productname", "itemname"]) : c.find(NAME);
      const asin = c.find(ASIN);
      const qty = c.find(["quantity", "originalquantity", "qty", "quantityordered"]);
      const cur = c.find(["currency", "ourpricecurrencycode", "basecurrencycode", "currencycode", "transactioncurrencycode"]);
      const totalCol = c.find(["totalowed", "transactionamount", "shipmentitemsubtotal", "itemtotal", "ourprice", "amountcharged", "itemsubtotal"]);
      const unit = c.find(["unitprice", "ourprice", "listpriceperunit", "purchasepriceperunit", "itemprice", "price"]);
      const orderStatus = c.find(["orderstatus"]);
      const shipStatus = c.find(["shipmentstatus", "shippingstatus", "deliverystatus"]);
      const shipDate = c.find(["shipdate", "shipmentdate", "shippeddate", "dispatchdate"]);
      const delivered = c.find(["deliverydate", "delivereddate", "actualdeliverydate", "deliveredon"]);
      const fulfilled = c.find(["fulfilleddate"]);
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        const oid = cell(r, id).replace(/\s+/g, "");
        const title = tidy(cell(r, name));
        if (!oid || !title) continue;
        const day = readDay(cell(r, date) || cell(r, fulfilled), t);
        if (!dayOk(day)) continue;
        const quantity = Math.max(1, Math.min(999, Math.round(Number(cell(r, qty)) || 1)));
        const currency = cell(r, cur);
        const line = readMoney(cell(r, totalCol), currency) ?? (() => {
          const u = readMoney(cell(r, unit), currency);
          return u ? { amount: Math.round(u.amount * quantity * 100) / 100, currency: u.currency } : undefined;
        })();
        if (digital && line && line.amount === 0) {
          skipped.free++;
          continue;
        }
        const a = cell(r, asin).toUpperCase();
        const key = a || nameKey(title);
        const o: Draft = orders.get(oid) ?? { id: oid, day, status: "ordered", statusAt: isoAt(day), items: [], ...(digital ? { digital: true } : {}) };
        if (day < o.day) o.day = day;
        const have = o.items.find((x) => x.key === key);
        if (have) {
          have.quantity = Math.min(999, have.quantity + quantity);
          if (line && have.price && have.price.currency === line.currency) have.price = { amount: Math.round((have.price.amount + line.amount) * 100) / 100, currency: line.currency };
          else if (line && !have.price) have.price = line;
        } else o.items.push({ key, name: title, ...(a ? { asin: a } : {}), quantity, ...(line ? { price: line } : {}) });
        // Status from this row; the order keeps the furthest along.
        const os = cell(r, orderStatus).toLowerCase();
        const ss = cell(r, shipStatus).toLowerCase();
        const shipped = readDay(cell(r, shipDate), t) ?? undefined;
        const got = readDay(cell(r, delivered), t) ?? undefined;
        let s: OrderStatus = digital ? "delivered" : "ordered";
        if (/cancel/.test(os) || /cancel/.test(ss)) s = "cancelled";
        else if (got || /deliver/.test(ss)) s = "delivered";
        else if (shipped || /ship|dispatch/.test(ss)) s = /closed|complete/.test(os) ? "delivered" : "dispatched";
        if (shipped && (!o.shippedOn || shipped < o.shippedOn)) o.shippedOn = shipped;
        if (got && (!o.deliveredOn || got > o.deliveredOn)) o.deliveredOn = got;
        o.status = furthest(o.status, s);
        orders.set(oid, o);
      }
    } else if (f.kind === "returns") {
      const id = c.find(ORDER_ID);
      const asin = c.find(ASIN);
      const name = c.find(NAME);
      const when = c.find(["refundcompletiondate", "returndate", "returncreationdate", "returnrequestdate", "creationdate", "date", "reversaldate"]);
      const refunded = c.find(["amountrefunded", "refundamount", "refundedamount"]);
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        const o = orders.get(cell(r, id).replace(/\s+/g, ""));
        if (!o) continue;
        const a = cell(r, asin).toUpperCase();
        const n = nameKey(cell(r, name));
        // By ASIN or name when the file says; else the only item; else the one item whose price is what was refunded.
        const back = readMoney(cell(r, refunded));
        const byAmount = back ? o.items.filter((x) => x.price && x.price.amount === back.amount) : [];
        const item =
          o.items.find((x) => (a && x.asin === a) || (n && nameKey(x.name) === n)) ?? (o.items.length === 1 ? o.items[0] : byAmount.length === 1 ? byAmount[0] : undefined);
        if (item) item.returned = true;
        else o.partReturned = true;
        const d = readDay(cell(r, when), t);
        if (d && d <= today && (!o.returnedOn || d > o.returnedOn)) o.returnedOn = d;
      }
    } else if (f.kind === "kindle") {
      const asin = c.find(ASIN);
      const start = c.find(START);
      const ms = c.find(READING);
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        const a = cell(r, asin).toUpperCase();
        const millis = Number(cell(r, ms)) || 0;
        if (!a || millis < MIN_KINDLE_MS) continue;
        const day = readDay(cell(r, start), t);
        if (!dayOk(day)) continue;
        const known = titles.get(a);
        if (!known) {
          skipped.untitled++;
          continue;
        }
        addMedia(day, { source: "kindle", key: a, title: known.title, ...(known.author ? { subtitle: known.author } : {}), minutes: millis / 60_000 });
      }
    } else if (f.kind === "audible") {
      const asin = c.find(ASIN);
      const name = c.find(NAME);
      const start = c.find(START);
      const ms = c.find(LISTENING);
      const end = c.find(["endpositionmilliseconds", "endposition", "positionmilliseconds"]);
      const length = c.find(["booklengthmilliseconds", "booklength", "titlelengthmilliseconds", "lengthmilliseconds", "contentlengthmilliseconds"]);
      const author = c.find(["author", "authors", "narrator"]);
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        const a = cell(r, asin).toUpperCase();
        const title = tidy(cell(r, name)) || (a ? titles.get(a)?.title ?? "" : "");
        const millis = Number(cell(r, ms)) || 0;
        if (!title || millis <= 0) continue;
        const day = readDay(cell(r, start), t);
        if (!dayOk(day)) continue;
        const key = a || nameKey(title);
        const by = tidy(cell(r, author), 120) || (a ? titles.get(a)?.author : undefined);
        addMedia(day, { source: "audible", key, title, ...(by ? { subtitle: by } : {}), minutes: millis / 60_000 });
        const pos = Number(cell(r, end)) || 0;
        const len = Number(cell(r, length)) || 0;
        if (a && len > 0 && pos >= len * FINISHED_SHARE) {
          const prev = finished.get(`audible:${a}`);
          if (!prev || (prev.day ?? "") < day) finished.set(`audible:${a}`, { source: "audible", asin: a, title, ...(by ? { author: by } : {}), day });
        }
      }
    } else if (f.kind === "prime") {
      const title = c.find(PRIME_TITLE);
      const asin = c.find(ASIN);
      const when = c.find(DATEISH);
      const episode = c.find(["episodename", "episodetitle", "episode", "episodenumber"]);
      const season = c.find(["seasonnumber", "season"]);
      const secs = c.match(/^(secondsviewed|durationwatched|secondswatched|viewingduration|watchtimeseconds|playbackduration)/);
      const type = c.find(["videotype", "contenttype", "type"]);
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        if (/trailer|bonus|extra|preview/i.test(cell(r, type))) continue;
        const raw = tidy(cell(r, title));
        if (!raw) continue;
        const seconds = secs >= 0 ? Number(cell(r, secs)) : NaN;
        if (Number.isFinite(seconds) && seconds < MIN_PRIME_SECONDS) continue;
        const day = readDay(cell(r, when), t);
        if (!dayOk(day)) continue;
        const split = splitShow(raw);
        const ep = tidy(cell(r, episode), 200);
        const se = cell(r, season) ? (/^\d+$/.test(cell(r, season)) ? `Season ${cell(r, season)}` : tidy(cell(r, season), 40)) : split.season;
        const show = !!(ep || se);
        const subtitle = [se, ep].filter(Boolean).join(" · ") || undefined;
        const a = cell(r, asin).toUpperCase();
        const key = a || nameKey(`${split.title} ${se ?? ""} ${ep}`);
        addMedia(day, { source: "prime_video", key, title: split.title, ...(subtitle ? { subtitle } : {}), ...(Number.isFinite(seconds) && seconds > 0 ? { minutes: seconds / 60 } : {}), ...(show ? { show: true } : {}) });
      }
    } else if (f.kind === "library") {
      const asin = c.find(ASIN);
      const name = c.find(NAME);
      const fin = c.find(FINISH);
      const fdate = c.find(["finisheddate", "datefinished", "completiondate", "datecompleted", "lastreaddate", "lastupdated"]);
      const author = c.find(["author", "authors", "authorname"]);
      const narrator = c.find(["narrator", "narrators"]);
      // Audible's library names narrators; a path that says so breaks a tie. Otherwise it's Kindle's.
      const source: "kindle" | "audible" = narrator >= 0 || /audible/i.test(f.name) ? "audible" : "kindle";
      for (let i = 0; i < f.rows.length; i++) {
        await tick(i);
        const r = f.rows[i];
        const a = cell(r, asin).toUpperCase();
        const ti = tidy(cell(r, name));
        const flag = cell(r, fin).toLowerCase();
        const isDone = /^(true|yes|1|finished|complete|completed|read|done)$/.test(flag) || readInstant(flag, t.order) !== null;
        if (!a || !ti || !isDone) continue;
        const day = readDay(cell(r, fdate) || (readInstant(flag, t.order) ? cell(r, fin) : ""), t) ?? undefined;
        if (day && day > today) continue;
        const by = tidy(cell(r, author), 120) || undefined;
        const k = `${source}:${a}`;
        if (!finished.has(k)) finished.set(k, { source, asin: a, title: ti, ...(by ? { author: by } : {}), ...(day ? { day } : {}) });
      }
    }
    done += f.rows.length;
    opts.progress?.(Math.min(1, done / total));
    await pause();
  }

  // Settle each order's status.
  const out: AmazonOrder[] = [];
  let settled = 0;
  for (const o of orders.values()) {
    if (++settled % STEP === 0) await pause();
    const old = daysBetween(o.day, today) > SETTLE_DAYS;
    const allBack = o.items.length > 0 && o.items.every((x) => x.returned);
    let status = o.status;
    if (allBack) status = "returned";
    else if (old && (status === "ordered" || status === "dispatched")) status = "delivered";
    const at = status === "returned" ? o.returnedOn ?? o.deliveredOn ?? o.shippedOn : status === "delivered" ? o.deliveredOn ?? o.shippedOn : status === "dispatched" ? o.shippedOn : undefined;
    out.push({ ...o, status, statusAt: isoAt(at ?? o.day) });
  }
  // Plain comparison: localeCompare over a hundred thousand orders blocks the page for half a second.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  out.sort((a, b) => cmp(a.day, b.day) || cmp(a.id, b.id));
  await pause();

  const days: MediaDay[] = [...media.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, m]) => ({
      day,
      items: [...m.values()].map((x) => (x.minutes !== undefined ? { ...x, minutes: Math.max(1, Math.round(x.minutes)) } : x)),
    }));

  const fin = [...finished.values()].filter((x) => x.title);
  await pause();
  let lo = "";
  let hi = "";
  const see = (d: string | undefined) => {
    if (!d) return;
    if (!lo || d < lo) lo = d;
    if (!hi || d > hi) hi = d;
  };
  for (const o of out) see(o.day);
  for (const d of days) see(d.day);
  for (const x of fin) see(x.day);
  await pause();
  const per = (s: MediaSource) => days.flatMap((d) => d.items.filter((x) => x.source === s));
  const kindle = per("kindle");
  const audible = per("audible");
  const prime = per("prime_video");
  const counts: AmazonCounts = {
    orders: out.filter((o) => !o.digital).length,
    items: out.filter((o) => !o.digital).reduce((k, o) => k + o.items.length, 0),
    returned: out.reduce((k, o) => k + o.items.filter((x) => x.returned).length, 0),
    digital: out.filter((o) => o.digital).reduce((k, o) => k + o.items.length, 0),
    kindleDays: new Set(days.filter((d) => d.items.some((x) => x.source === "kindle")).map((d) => d.day)).size,
    kindleBooks: new Set(kindle.map((x) => x.key)).size,
    kindleMinutes: kindle.reduce((k, x) => k + (x.minutes ?? 0), 0),
    audibleDays: new Set(days.filter((d) => d.items.some((x) => x.source === "audible")).map((d) => d.day)).size,
    audibleTitles: new Set(audible.map((x) => x.key)).size,
    audibleMinutes: audible.reduce((k, x) => k + (x.minutes ?? 0), 0),
    primeDays: new Set(days.filter((d) => d.items.some((x) => x.source === "prime_video")).map((d) => d.day)).size,
    primeTitles: new Set(prime.map((x) => x.title)).size,
    finished: fin.length,
  };
  opts.progress?.(1);
  return {
    orders: out,
    days,
    finished: fin,
    counts,
    range: lo ? { first: lo, last: hi } : null,
    files: read.map((f) => ({ name: f.name, kind: f.kind })),
    skipped,
  };
}

/**
 * parseCsv's rules (quotes, doubled quotes, CRLF), but a slice at a time with
 * `pause` between, so a 50 MB file doesn't block the page in one go.
 */
export async function csvInSteps(text: string, pause: () => Promise<void>, slice = 256 * 1024): Promise<string[][]> {
  const rows: string[][] = [];
  const s = text;
  const n = s.length;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let next = i + slice;
  let row: string[] = [];
  // Fields are sliced out of the text, not built a character at a time; empty rows are dropped as they're read.
  const endRow = () => {
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < n) {
    if (i >= next) {
      next = i + slice;
      await pause();
    }
    let field: string;
    if (s.charCodeAt(i) === 34) {
      // Quoted: up to the closing quote, "" meaning one quote.
      let j = i + 1;
      let parts = "";
      for (;;) {
        const q = s.indexOf('"', j);
        if (q < 0) {
          parts += s.slice(j);
          j = n;
          break;
        }
        parts += s.slice(j, q);
        if (s.charCodeAt(q + 1) === 34) {
          parts += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      // Anything after the closing quote up to the delimiter belongs to the field, as parseCsv keeps it.
      let k = j;
      while (k < n && s[k] !== "," && s[k] !== "\n" && s[k] !== "\r") k++;
      field = parts + s.slice(j, k);
      i = k;
    } else {
      let k = i;
      while (k < n && s[k] !== "," && s[k] !== "\n" && s[k] !== "\r") k++;
      field = s.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) break;
    const c = s[i];
    if (c === ",") {
      i++;
      if (i >= n) row.push("");
    } else {
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      endRow();
    }
  }
  if (row.length) endRow();
  return rows;
}

const RANK: Record<AmazonKind, number> = { titles: 0, library: 1, orders: 2, digital: 3, returns: 4, kindle: 5, audible: 6, prime: 7 };
const rank = (k: AmazonKind) => RANK[k];

const STAGE: Record<OrderStatus, number> = { ordered: 0, dispatched: 1, delivered: 2, cancelled: 2, returned: 3 };
/** Several rows of one order (one per item or shipment): the furthest along wins, but one cancelled item doesn't cancel a delivered order. */
function furthest(a: OrderStatus, b: OrderStatus): OrderStatus {
  if (a === b) return a;
  if (a === "cancelled") return b === "ordered" ? a : b;
  if (b === "cancelled") return a === "ordered" ? b : a;
  return STAGE[b] > STAGE[a] ? b : a;
}

/** "The Boys: Season 2" → The Boys, Season 2. A film stays as it is. */
export function splitShow(raw: string): { title: string; season?: string } {
  const m = /^(.*?)\s*(?::|-|–|,)\s*(Season|Series|Staffel|Saison|Temporada|Stagione)\s*(\d{1,3})\b.*$/i.exec(raw);
  if (m && m[1].trim()) return { title: tidy(m[1]), season: `Season ${m[3]}` };
  return { title: raw };
}

// ---------- What goes to the server ----------

/** What a purchase's item list says for an item that went back. Server-side, lib/trips.ts swaps it in for the plain name. */
export const RETURNED_SUFFIX = " (returned)";

export const itemLabel = (i: OrderItem) => `${i.quantity > 1 ? `${i.quantity} × ` : ""}${i.name}${i.returned ? RETURNED_SUFFIX : ""}`;

/** Orders as one request carries them: at most this many. */
export const ORDERS_PER_REQUEST = 100;

export function batchOrders(orders: AmazonOrder[], size = ORDERS_PER_REQUEST): AmazonOrder[][] {
  const out: AmazonOrder[][] = [];
  for (let i = 0; i < orders.length; i += size) out.push(orders.slice(i, i + size));
  return out;
}

/** Media days for one request: whole days, at most 120 days or 600 items. */
export function batchMediaDays(days: MediaDay[], maxDays = 120, maxItems = 600): MediaDay[][] {
  const out: MediaDay[][] = [];
  let cur: MediaDay[] = [];
  let n = 0;
  for (const d of days) {
    const k = Math.max(1, d.items.length);
    if (cur.length && (cur.length >= maxDays || n + k > maxItems)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(d);
    n += k;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The busiest months across orders and media, for the preview's bars. */
export function busiestMonths(x: AmazonExport, k = 5): Array<{ month: string; orders: number; media: number }> {
  const m = new Map<string, { orders: number; media: number }>();
  const at = (month: string) => m.get(month) ?? m.set(month, { orders: 0, media: 0 }).get(month)!;
  for (const o of x.orders) at(o.day.slice(0, 7)).orders++;
  for (const d of x.days) at(d.day.slice(0, 7)).media += d.items.length;
  return [...m.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => b.orders + b.media - (a.orders + a.media) || b.month.localeCompare(a.month))
    .slice(0, k);
}
