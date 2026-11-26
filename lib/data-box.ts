/**
 * Encryption at rest for Athena's personal content (docs: security/encryption).
 *
 * Note titles and bodies, people's details, to-dos, catch-ups, facts and the
 * rest of the free text Athena keeps are sealed here, in the Functions,
 * before they're written, and opened after they're read. So a database
 * dump, a backup, the Netlify DB console or a deploy preview's copy of the
 * database holds ciphertext, while the briefing, collections, Claude (MCP)
 * and the app all keep working. The server holds the key; this is not
 * end-to-end encryption.
 *
 * Keys. ATHENA_DATA_KEY is 32 random bytes as 64 hex characters
 * (`openssl rand -hex 32`), set for the production context only. Three keys
 * are derived from it with HKDF-SHA256: one encrypts, one computes blind
 * indexes, and a 4-byte key id that's stored with every value. During a
 * rotation the old key goes in ATHENA_DATA_KEY_PREVIOUS (space- or
 * comma-separated if there are several): values sealed under it still open,
 * and netlify/functions/encrypt-data.ts re-seals them under the new key.
 *
 * Format: "enc:v1:<key id>:<payload>". v1 is AES-256-GCM (lib/secret-box.ts)
 * with a random 96-bit IV; payload is base64url(iv ‖ ciphertext ‖ 16-byte
 * tag). Anything else is read as plaintext, which is what lets old rows and
 * sealed rows sit side by side while existing data is encrypted.
 *
 * Blind indexes: HMAC-SHA256 of a normalised value (a lowercased name or
 * email, a phone's last ten digits) under the index key, so exact matches —
 * "is there a Priya Shah?", "whose email is this?" — still run in SQL. They
 * reveal which rows share a value, never the value.
 *
 * Pure: no database access, so scripts/export-obsidian.ts can use it too.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { gcmDecrypt, gcmEncrypt } from "./secret-box";
import { UNREADABLE_TEXT, isEncryptedPlaceholder, lockedText } from "./encrypted";

const SEALED = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{38,})$/;
const HEX_KEY = /^[0-9a-f]{64}$/i;

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name);
  return fromNetlify ?? process.env[name];
}

// ---------- Errors ----------

/** Errors with the HTTP status the API should answer with. */
export class DataBoxError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 500 | 503,
  ) {
    super(message);
    this.name = "DataBoxError";
  }
}

/** Encryption is on, but this copy of Athena has no (valid) key: text can't be saved. */
export class DataKeyMissing extends DataBoxError {
  constructor(detail = "your data is encrypted and the key isn't available on this copy of Athena") {
    super(`Athena can't save this right now: ${detail}.`, 503);
    this.name = "DataKeyMissing";
  }
}

/** A sealed value that didn't open: sealed under a key we don't have, or altered. */
export class DataUnreadable extends DataBoxError {
  constructor(readonly keyId: string) {
    super(`A value sealed under key ${keyId} couldn't be decrypted`, 500);
    this.name = "DataUnreadable";
  }
}

/** Saving a placeholder back would overwrite ciphertext that might still be recoverable. */
export class PlaceholderWrite extends DataBoxError {
  constructor() {
    super("This item couldn't be decrypted, so it can't be changed here.", 409);
    this.name = "PlaceholderWrite";
  }
}

// ---------- Keys ----------

interface DataKey {
  kid: string;
  enc: Buffer;
  idx: Buffer;
}

interface Ring {
  current: DataKey | null;
  /** Current first, then previous keys, by key id. */
  keys: Map<string, DataKey>;
  /** Set when ATHENA_DATA_KEY is present but malformed. */
  problem: string | null;
}

function derive(hex: string): DataKey {
  const ikm = Buffer.from(hex, "hex");
  const part = (info: string, length: number) => Buffer.from(hkdfSync("sha256", ikm, "athena", info, length));
  return {
    kid: part("athena/data/key-id/v1", 4).toString("hex"),
    enc: part("athena/data/encrypt/v1", 32),
    idx: part("athena/data/index/v1", 32),
  };
}

let cached: { raw: string; ring: Ring } | null = null;

/** Derived once per set of env values (tests change them between cases). */
function ring(): Ring {
  const current = env("ATHENA_DATA_KEY")?.trim() ?? "";
  const previous = env("ATHENA_DATA_KEY_PREVIOUS")?.trim() ?? "";
  const raw = `${current}|${previous}`;
  if (cached?.raw === raw) return cached.ring;

  const keys = new Map<string, DataKey>();
  let problem: string | null = null;
  let currentKey: DataKey | null = null;
  if (current) {
    if (HEX_KEY.test(current)) {
      currentKey = derive(current);
      keys.set(currentKey.kid, currentKey);
    } else {
      problem = "ATHENA_DATA_KEY is set but isn't a valid key (64 hex characters)";
    }
  }
  for (const hex of previous.split(/[\s,]+/).filter(Boolean)) {
    if (!HEX_KEY.test(hex)) {
      console.error("Athena: ignoring a malformed key in ATHENA_DATA_KEY_PREVIOUS (not 64 hex characters)");
      continue;
    }
    const key = derive(hex);
    if (!keys.has(key.kid)) keys.set(key.kid, key);
  }
  if (problem) console.error(`Athena: ${problem}; text writes are refused until it's fixed`);
  cached = { raw, ring: { current: currentKey, keys, problem } };
  return cached.ring;
}

/** This deploy can seal new values. */
export function dataKeyConfigured(): boolean {
  return ring().current !== null;
}

/** Why the configured key can't be used, if it's set but malformed. */
export function dataKeyProblem(): string | null {
  return ring().problem;
}

/** The key id new values are sealed under, or null without a key. */
export function currentKeyId(): string | null {
  return ring().current?.kid ?? null;
}

// ---------- Sealing ----------

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("enc:") && SEALED.test(value);
}

/** The key id a sealed value was sealed under (null for plaintext). */
export function sealedKeyId(value: unknown): string | null {
  return isSealed(value) ? value.slice(7, 15) : null;
}

/**
 * Seal one value under the current key. Empty stays empty: ciphertext
 * length gives that away anyway, and SQL can keep its `= ''` checks.
 */
export function sealText(plaintext: string): string {
  if (plaintext === "") return "";
  const key = ring().current;
  if (!key) throw new DataKeyMissing(ring().problem ?? undefined);
  if (isEncryptedPlaceholder(plaintext)) throw new PlaceholderWrite();
  const { iv, ct, tag } = gcmEncrypt(key.enc, plaintext);
  return `enc:v1:${key.kid}:${Buffer.concat([iv, ct, tag]).toString("base64url")}`;
}

/**
 * Open one value: plaintext passes through untouched; a sealed value is
 * decrypted, or throws — DataKeyMissing when this deploy has no key at all,
 * DataUnreadable when it has keys but this value won't open with them.
 */
export function openStrict(value: string): string {
  if (!isSealed(value)) return value;
  const kid = value.slice(7, 15);
  const r = ring();
  if (r.keys.size === 0) throw new DataKeyMissing(r.problem ?? undefined);
  const key = r.keys.get(kid);
  if (!key) throw new DataUnreadable(kid);
  const bytes = Buffer.from(value.slice(16), "base64url");
  if (bytes.length < 28) throw new DataUnreadable(kid);
  try {
    return gcmDecrypt(key.enc, bytes.subarray(0, 12), bytes.subarray(12, bytes.length - 16), bytes.subarray(bytes.length - 16));
  } catch {
    throw new DataUnreadable(kid);
  }
}

/** This site's own address (Netlify sets `URL`), or "production" when it isn't known. */
function placeholderHost(): string {
  try {
    return new URL(env("URL") ?? "").host || "production";
  } catch {
    return "production";
  }
}

const reported = new Set<string>();

/** Open a value for display: a neutral placeholder instead of an error when it won't open. */
export function openText(value: string): string {
  try {
    return openStrict(value);
  } catch (error) {
    if (error instanceof DataKeyMissing) return lockedText(placeholderHost());
    // Never the value itself: just which key, once per key, so a missing old key is easy to spot.
    const kid = sealedKeyId(value) ?? "?";
    if (!reported.has(kid)) {
      reported.add(kid);
      console.error(`Athena: values sealed under key ${kid} couldn't be decrypted (a missing old key, or altered data)`);
    }
    return UNREADABLE_TEXT;
  }
}

/**
 * Open every sealed string inside a query result, in place: columns, JSON
 * built in SQL (a commitment's person, an interaction's people), arrays
 * (tags). Dates, buffers and other objects are left alone.
 */
export function openDeep<T>(value: T): T {
  if (typeof value === "string") return (isSealed(value) ? openText(value) : value) as T;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = openDeep(value[i]);
    return value;
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const record = value as Record<string, unknown>;
    for (const k of Object.keys(record)) record[k] = openDeep(record[k]);
  }
  return value;
}

// ---------- Blind indexes ----------

export type IndexPurpose = "name" | "email" | "phone" | "slack" | "other" | "booking" | "order" | "tracking";

function hmac(key: DataKey, purpose: IndexPurpose, value: string): string {
  return createHmac("sha256", key.idx).update(`${purpose}\u0000${value}`).digest().subarray(0, 16).toString("base64url");
}

/** Blind index of an already-normalised value under the current key ('' or no key = null). */
export function blindIndex(purpose: IndexPurpose, normalised: string): string | null {
  const key = ring().current;
  return key && normalised ? hmac(key, purpose, normalised) : null;
}

/** The value's blind index under every key we hold: lookups match rows not yet re-indexed after a rotation. */
export function blindIndexes(purpose: IndexPurpose, normalised: string): string[] {
  if (!normalised) return [];
  return [...ring().keys.values()].map((key) => hmac(key, purpose, normalised));
}

// ---------- Files (lib/files.ts) ----------

/** "ATHF" ‖ 0x01: a sealed file's first five bytes. */
const FILE_MAGIC = Buffer.from([0x41, 0x54, 0x48, 0x46, 0x01]);

/**
 * Seal a file's bytes under the current key: magic ‖ key id (4) ‖ iv (12) ‖
 * ciphertext ‖ tag (16). AES-256-GCM, a fresh IV per file. There's no
 * plaintext fallback: without a key a file can't be stored at all.
 */
export function sealBytes(plain: Uint8Array): { sealed: Buffer; kid: string } {
  const key = ring().current;
  if (!key) throw new DataKeyMissing(ring().problem ?? "files are only kept encrypted, and this copy of Athena has no key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.enc, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { sealed: Buffer.concat([FILE_MAGIC, Buffer.from(key.kid, "hex"), iv, ct, cipher.getAuthTag()]), kid: key.kid };
}

/** Open sealed file bytes with whichever key sealed them. Throws DataKeyMissing / DataUnreadable. */
export function openBytes(sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < FILE_MAGIC.length + 4 + 12 + 16 || !buf.subarray(0, 5).equals(FILE_MAGIC)) throw new DataUnreadable("?");
  const kid = buf.subarray(5, 9).toString("hex");
  const r = ring();
  if (r.keys.size === 0) throw new DataKeyMissing(r.problem ?? undefined);
  const key = r.keys.get(kid);
  if (!key) throw new DataUnreadable(kid);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.enc, buf.subarray(9, 21), { authTagLength: 16 });
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(21, buf.length - 16)), decipher.final()]);
  } catch {
    throw new DataUnreadable(kid);
  }
}
