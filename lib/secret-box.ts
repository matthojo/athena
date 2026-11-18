/**
 * Symmetric encryption for connector credentials (OAuth tokens, API keys).
 *
 * Unlike finance/health content (age, decrypted only on demand — SECURITY.md
 * §1–2), these secrets must be readable by the scheduled collector on every
 * run, unattended, so they're sealed with AES-256-GCM under a key held only
 * in the Functions environment: CONNECTOR_ENCRYPTION_KEY, 32 random bytes as
 * 64 hex characters (`openssl rand -hex 32`). A database dump alone reveals
 * nothing; the key never reaches the PWA. See SECURITY.md §9.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. Server-only.
 *
 * gcmEncrypt / gcmDecrypt are the one AES-256-GCM implementation in Athena:
 * lib/data-box.ts seals personal content with them too, under its own key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const TAG_BYTES = 16;

/** AES-256-GCM with a fresh random 96-bit IV per value. */
export function gcmEncrypt(key: Buffer, plaintext: string): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

/**
 * Throws if the tag doesn't verify: the wrong key, or the ciphertext was
 * changed. The tag length is pinned so a shortened tag can't be accepted.
 */
export function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer): string {
  if (iv.length !== 12 || tag.length !== TAG_BYTES) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function env(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name);
  return fromNetlify ?? process.env[name];
}

function key(): Buffer {
  const raw = env("CONNECTOR_ENCRYPTION_KEY")?.trim();
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new SecretBoxUnavailable();
  }
  return Buffer.from(raw, "hex");
}

export class SecretBoxUnavailable extends Error {
  constructor() {
    super("CONNECTOR_ENCRYPTION_KEY isn't set (64 hex characters: `openssl rand -hex 32`), so Athena can't store connector credentials");
    this.name = "SecretBoxUnavailable";
  }
}

export function secretBoxConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string): string {
  const { iv, ct, tag } = gcmEncrypt(key(), plaintext);
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unrecognised credential format");
  return gcmDecrypt(key(), Buffer.from(iv, "base64url"), Buffer.from(ct, "base64url"), Buffer.from(tag, "base64url"));
}

export function sealJson(value: unknown): string {
  return seal(JSON.stringify(value));
}

export function openJson<T>(sealed: string | null): T | null {
  return sealed ? (JSON.parse(open(sealed)) as T) : null;
}
