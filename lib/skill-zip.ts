/**
 * A skill uploaded as a .zip (lib/skills.ts): its entries, read from the
 * central directory, inflated only when they're text Athena would keep and
 * small enough, each capped as it inflates, so a hostile zip can't make the
 * Function inflate more than the caps. Stored (0) and deflate (8) only; no
 * Zip64 (a skill is far under 4 GB) and no encryption.
 */
import { inflateRawSync } from "node:zlib";
import { SKILL_LIMITS, SkillFormatError, TEXT_EXTENSIONS, type IntakeEntry } from "./skills";

const MAX_ENTRIES = 500;

const isText = (name: string) => (TEXT_EXTENSIONS as readonly string[]).some((ext) => name.toLowerCase().endsWith(ext)) || /(^|\/)skill\.md$/i.test(name);

/** A zip's files as intake entries. Throws SkillFormatError when it isn't a zip Athena can read. */
export function readSkillZip(zip: Uint8Array): IntakeEntry[] {
  if (zip.byteLength > SKILL_LIMITS.uploadBytes) throw new SkillFormatError("That's over 2 MB. A skill is mostly text: leave out large files.");
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SkillFormatError("That isn't a zip Athena can open.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new SkillFormatError("That zip has too many files for a skill.");
  const out: IntakeEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SkillFormatError("That zip is damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    // Read only what would be kept: other files are listed by name and size.
    if (!isText(name) || size > SKILL_LIMITS.fileBytes || flags & 0x1) {
      out.push({ path: name, bytes: new Uint8Array(), size: Math.max(size, 1), ...(flags & 0x1 ? { unread: true } : {}) });
      continue;
    }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new SkillFormatError("That zip is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let bytes: Buffer;
    try {
      if (method === 0) bytes = raw;
      else if (method === 8) bytes = inflateRawSync(raw, { maxOutputLength: SKILL_LIMITS.fileBytes + 1 });
      else throw new Error("method");
    } catch {
      // Over the cap as it inflated (listed as too big), or a method Athena doesn't read.
      out.push({ path: name, bytes: new Uint8Array(), ...(method === 8 ? { size: SKILL_LIMITS.fileBytes + 1 } : { unread: true }) });
      continue;
    }
    out.push({ path: name, bytes: new Uint8Array(bytes) });
  }
  return out;
}

/** A zip of these files, stored (no compression): a skill's download, which Claude reads back unchanged. */
export function writeSkillZip(files: Array<{ path: string; text: string }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const data = Buffer.from(f.text, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

let table: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
