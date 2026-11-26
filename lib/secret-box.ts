/**
 * Symmetric encryption for connector credentials (OAuth tokens, API keys).
 *
 * Unlike finance/health content (age, decrypted only on demand; docs:
 * security/encryption), these secrets must be readable by the scheduled collector on every
 * run, unattended, so they're sealed with AES-256-GCM under a key held only
 * in the Functions environment: CONNECTOR_ENCRYPTION_KEY, 32 random bytes as
 * 64 hex characters (`openssl rand -hex 32`). A database dump alone reveals
 * nothing; the key never reaches the PWA. See docs: security/connectors.
 *
 * Format: "v2.<key id>.<iv>.<tag>.<ciphertext>", each part base64url except
 * the key id (8 hex characters, derived from the key with HKDF-SHA256). A
 * value is sealed for a context, such as the connector it belongs to and
 * that connector's address, which is authenticated with it (GCM's additional
 * data): the value opens only for that same context, so a ciphertext moved
 * to another row, or left in a row whose address was changed, doesn't open.
 * "v1.<iv>.<tag>.<ciphertext>" values carry no key id or context. They're
 * retired: lib/secret-format.ts seals every one again as v2 once, after which
 * this copy of Athena refuses them (retireV1) rather than opening them, so a
 * v1 value can't be put back into a row to get round the context. Until
 * then they open, and are sealed again as v2 when they're next read.
 *
 * Rotation: the old key goes in CONNECTOR_ENCRYPTION_KEY_PREVIOUS (space- or
 * comma-separated if there are several). Values sealed under it still open,
 * and are sealed under the new key when they're next written; needsReseal
 * says which values those are.
 *
 * gcmEncrypt / gcmDecrypt are the one AES-256-GCM implementation in Athena:
 * lib/data-box.ts seals personal content with them too, under its own key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const TAG_BYTES = 16;
const HEX_KEY = /^[0-9a-f]{64}$/i;

/** AES-256-GCM with a fresh random 96-bit IV per value, authenticating `aad` with it when given. */
export function gcmEncrypt(key: Buffer, plaintext: string, aad?: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

/**
 * Throws if the tag doesn't verify: the wrong key, the wrong additional
 * data, or the ciphertext was changed. The tag length is pinned so a
 * shortened tag can't be accepted.
 */
export function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad?: Buffer): string {
  if (iv.length !== 12 || tag.length !== TAG_BYTES) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name);
  return fromNetlify ?? process.env[name];
}

// ---------- keys ----------

interface BoxKey {
  kid: string;
  key: Buffer;
}

interface Ring {
  current: BoxKey | null;
  /** Current first, then previous keys. */
  keys: BoxKey[];
}

function boxKey(hex: string): BoxKey {
  const key = Buffer.from(hex, "hex");
  return { kid: Buffer.from(hkdfSync("sha256", key, "athena", "athena/connector/key-id/v1", 4)).toString("hex"), key };
}

let cached: { raw: string; ring: Ring } | null = null;

/** Read once per set of env values (tests change them between cases). */
function ring(): Ring {
  const current = env("CONNECTOR_ENCRYPTION_KEY")?.trim() ?? "";
  const previous = env("CONNECTOR_ENCRYPTION_KEY_PREVIOUS")?.trim() ?? "";
  const raw = `${current}|${previous}`;
  if (cached?.raw === raw) return cached.ring;
  const currentKey = HEX_KEY.test(current) ? boxKey(current) : null;
  const keys = currentKey ? [currentKey] : [];
  for (const hex of previous.split(/[\s,]+/).filter(Boolean)) {
    if (!HEX_KEY.test(hex)) {
      console.error("Athena: ignoring a malformed key in CONNECTOR_ENCRYPTION_KEY_PREVIOUS (not 64 hex characters)");
      continue;
    }
    const k = boxKey(hex);
    if (!keys.some((have) => have.kid === k.kid)) keys.push(k);
  }
  cached = { raw, ring: { current: currentKey, keys } };
  return cached.ring;
}

function currentKey(): BoxKey {
  const k = ring().current;
  if (!k) throw new SecretBoxUnavailable();
  return k;
}

export class SecretBoxUnavailable extends Error {
  constructor() {
    super("CONNECTOR_ENCRYPTION_KEY isn't set (64 hex characters: `openssl rand -hex 32`), so Athena can't store connector credentials");
    this.name = "SecretBoxUnavailable";
  }
}

export function secretBoxConfigured(): boolean {
  return ring().current !== null;
}

/** The current key's id (8 hex characters), or null without a key. */
export function currentKeyId(): string | null {
  return ring().current?.kid ?? null;
}

// ---------- the v1 format ----------

/** A v1 value, refused because every v1 value here has been sealed again as v2. */
export class SecretFormatRetired extends Error {
  constructor() {
    super("A credential in the retired v1 format was refused");
    this.name = "SecretFormatRetired";
  }
}

let v1Refused = false;

/** From now on, refuse v1 values (lib/secret-format.ts, once they've all been sealed again). `false` is for tests. */
export function retireV1(on = true): void {
  v1Refused = on;
}

export function v1Retired(): boolean {
  return v1Refused;
}

/** Sealed in the v1 format. */
export const isV1 = (sealed: string | null | undefined): boolean => typeof sealed === "string" && sealed.startsWith("v1.");

// ---------- sealing ----------

/** The additional data a v2 value is sealed with: a fixed label, then its context. */
function aadFor(context: string): Buffer {
  return Buffer.from(`athena/secret-box/v2\n${context}`, "utf8");
}

/** Seal `plaintext` under the current key for `context` (empty: no particular place). */
export function seal(plaintext: string, context = ""): string {
  const { kid, key } = currentKey();
  const { iv, ct, tag } = gcmEncrypt(key, plaintext, aadFor(context));
  return ["v2", kid, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Open a value sealed for `context` (v1 values have none, and open for any). */
export function open(sealed: string, context = ""): string {
  const parts = sealed.split(".");
  if (parts[0] === "v2" && parts.length === 5) {
    const [, kid, iv, tag, ct] = parts;
    const k = ring().keys.find((have) => have.kid === kid);
    if (!k) {
      if (!ring().current) throw new SecretBoxUnavailable();
      throw new Error(`Sealed under a key this copy of Athena doesn't have (key id ${kid})`);
    }
    return gcmDecrypt(k.key, Buffer.from(iv, "base64url"), Buffer.from(ct, "base64url"), Buffer.from(tag, "base64url"), aadFor(context));
  }
  if (parts[0] === "v1" && parts.length === 4) {
    if (v1Refused) throw new SecretFormatRetired();
    const [, iv, tag, ct] = parts;
    const { keys } = ring();
    if (!keys.length) throw new SecretBoxUnavailable();
    let last: unknown;
    for (const k of keys) {
      try {
        return gcmDecrypt(k.key, Buffer.from(iv, "base64url"), Buffer.from(ct, "base64url"), Buffer.from(tag, "base64url"));
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }
  throw new Error("Unrecognised credential format");
}

/**
 * A value that opens but should be sealed again: v1 (no context bound to
 * it), or sealed under a previous key.
 */
export function needsReseal(sealed: string | null): boolean {
  if (!sealed) return false;
  const parts = sealed.split(".");
  return !(parts[0] === "v2" && parts[1] === ring().current?.kid);
}

export function sealJson(value: unknown, context = ""): string {
  return seal(JSON.stringify(value), context);
}

export function openJson<T>(sealed: string | null, context = ""): T | null {
  return sealed ? (JSON.parse(open(sealed, context)) as T) : null;
}
