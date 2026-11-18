// Run: npx tsx --test app/src/lib/takeout-zip.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { entriesFromZip, historyFromZip, LIMITS, textUpTo } from "./takeout-zip";

/** A minimal zip (deflated entries, no Zip64) with these files. */
function zip(files: Record<string, string>): Blob {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([new Uint8Array(Buffer.concat([...local, cd, end]))]);
}

test("reads the watch history out of a zip", async () => {
  const found = await historyFromZip(zip({ "Takeout/YouTube/history/watch-history.json": '[{"title":"Watched a"}]' }));
  assert.deepEqual(found, { name: "watch-history.json", text: '[{"title":"Watched a"}]' });
});

test("refuses an entry that inflates past the limit (a zip bomb)", async (t) => {
  const was = LIMITS.entryBytes;
  t.after(() => (LIMITS.entryBytes = was));
  LIMITS.entryBytes = 1000;
  // 5,000 bytes of one letter: tiny compressed, too big inflated.
  await assert.rejects(historyFromZip(zip({ "watch-history.json": "a".repeat(5000) })), /too big/);
});

test("refuses a zip whose entries together inflate past the total", async (t) => {
  const was = LIMITS.totalBytes;
  t.after(() => (LIMITS.totalBytes = was));
  LIMITS.totalBytes = 1500;
  const files = { "a/2024_JANUARY.json": "x".repeat(1000), "a/2024_FEBRUARY.json": "y".repeat(1000) };
  await assert.rejects(entriesFromZip(zip(files), /\d{4}_[A-Z]+\.json$/), /too big/);
  LIMITS.totalBytes = was;
  assert.equal((await entriesFromZip(zip(files), /\d{4}_[A-Z]+\.json$/)).length, 2);
});

test("textUpTo decodes across chunks and stops at the limit", async () => {
  const chunks = [Buffer.from("caf"), Buffer.from([0xc3]), Buffer.from([0xa9, 0x21])];
  const stream = () => new Blob(chunks.map((c) => new Uint8Array(c))).stream();
  assert.deepEqual(await textUpTo(stream(), 100), { text: "café!", bytes: 6 });
  await assert.rejects(textUpTo(stream(), 5), /too big/);
});
