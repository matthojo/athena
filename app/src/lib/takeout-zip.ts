/**
 * Finds the watch history inside a Google Takeout zip without reading the
 * whole zip: the central directory at the end says where each file is, so
 * only that one entry is read and inflated (DecompressionStream). Handles
 * Zip64, which Takeout uses for exports over 4 GB.
 */

const HISTORY = /(^|\/)watch-history\.(json|html)$/i;

/**
 * Limits, so a broken or hostile zip can't make the tab inflate gigabytes:
 * the most one entry or one zip may inflate to, the most entries and the
 * largest central directory we'll read.
 */
export const LIMITS = { entryBytes: 256 * 2 ** 20, totalBytes: 512 * 2 ** 20, entries: 200_000, directoryBytes: 64 * 2 ** 20 };

export interface HistoryEntry {
  name: string;
  text: string;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => u32(v, o) + u32(v, o + 4) * 2 ** 32;

async function view(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

async function entries(file: Blob): Promise<Entry[]> {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error("not a zip");
    const recAt = u64(tail, loc + 8);
    const rec = await view(file, recAt, recAt + 56);
    if (u32(rec, 0) !== 0x06064b50) throw new Error("not a zip");
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (count > LIMITS.entries || cdSize > LIMITS.directoryBytes) throw new Error("zip too big");
  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const out: Entry[] = [];
  const names = new TextDecoder();
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50; i++) {
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let size = u32(cd, p + 20);
    const raw = u32(cd, p + 24);
    let offset = u32(cd, p + 42);
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // Zip64 sizes and offsets live in the 0x0001 extra field, in this order, only for the ones that overflowed.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        if (raw === 0xffffffff) f += 8;
        if (size === 0xffffffff) (size = u64(cd, f)), (f += 8);
        if (offset === 0xffffffff) offset = u64(cd, f);
      }
      e += 4 + len;
    }
    out.push({ name, method: u16(cd, p + 10), size, offset });
    p = extraEnd + commentLen;
  }
  return out;
}

/** Reads a stream as text, stopping (and throwing) once it passes `limit` bytes. */
export async function textUpTo(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; bytes: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("zip entry too big");
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytes };
}

async function read(file: Blob, entry: Entry, limit = LIMITS.entryBytes): Promise<{ text: string; bytes: number }> {
  const head = await view(file, entry.offset, entry.offset + 30);
  if (u32(head, 0) !== 0x04034b50) throw new Error("not a zip");
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const data = file.slice(start, start + entry.size);
  const max = Math.min(limit, LIMITS.entryBytes);
  if (entry.method === 0) return textUpTo(data.stream(), max);
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("can't unzip");
  return textUpTo(data.stream().pipeThrough(new DecompressionStream("deflate-raw")), max);
}

/**
 * The watch history in a Takeout zip (JSON when it has both), or null when
 * this zip has none (a multi-part export keeps it in one part only).
 */
export async function historyFromZip(file: Blob): Promise<HistoryEntry | null> {
  const found = (await entries(file)).filter((e) => HISTORY.test(e.name));
  const pick = found.find((e) => /\.json$/i.test(e.name)) ?? found[0];
  return pick ? { name: pick.name.split("/").pop()!, text: (await read(file, pick)).text } : null;
}

/** A zip, by its first bytes rather than its name. */
export async function isZip(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  return u32(await view(file, 0, 4), 0) === 0x04034b50;
}

/** Every entry whose path matches `pattern` (Timeline's monthly Semantic Location History files), read and inflated. `paths` keeps each folder in its name (Loop's one folder per habit). */
export async function entriesFromZip(file: Blob, pattern: RegExp, opts: { paths?: boolean } = {}): Promise<HistoryEntry[]> {
  const found = (await entries(file)).filter((e) => pattern.test(e.name));
  const out: HistoryEntry[] = [];
  let left = LIMITS.totalBytes;
  for (const e of found) {
    const { text, bytes } = await read(file, e, left);
    left -= bytes;
    out.push({ name: opts.paths ? e.name : e.name.split("/").pop()!, text });
  }
  return out;
}
