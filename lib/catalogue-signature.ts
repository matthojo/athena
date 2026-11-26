/**
 * Community: the catalogue's signature. The catalogue's build signs index.json with an Ed25519 private key held
 * outside both repositories (scripts/sign-catalogue.ts) and publishes the signature beside it as index.json.sig,
 * base64. Athena's server checks it against the public keys in CATALOGUE_SIGNING_KEYS (lib/catalogue-types.ts)
 * before reading the index, so whoever serves the catalogue's files can't change what's listed, or the hashes the
 * bundles are checked against, without the key.
 *
 * Keys are listed as their raw 32 bytes in base64. Server-only (node:crypto); catalogue-types.ts stays pure.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const RAW_KEY = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** A listed public key as a KeyObject, or null when it isn't a 32-byte key in base64. */
export function publicKeyFrom(listed: string): KeyObject | null {
  if (!RAW_KEY.test(listed)) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(listed, "base64").toString("base64url") }, format: "jwk" });
  } catch {
    return null;
  }
}

/** A key's public half as it's listed in CATALOGUE_SIGNING_KEYS. */
export function listedPublicKey(key: KeyObject): string {
  const jwk = (key.type === "private" ? createPublicKey(key) : key).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("Not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** A private key from its PEM text, or from base64 of its PKCS#8 DER bytes (one line, for a CI secret). */
export function privateKeyFrom(text: string): KeyObject {
  const t = text.trim();
  const key = t.includes("-----BEGIN") ? createPrivateKey(t) : createPrivateKey({ key: Buffer.from(t, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The catalogue is signed with an Ed25519 key");
  return key;
}

/** index.json's signature, as index.json.sig holds it. */
export function signIndex(body: Uint8Array, key: KeyObject): string {
  return sign(null, body, key).toString("base64");
}

/** Is `signature` (index.json.sig's text) a signature of exactly these bytes by one of the listed keys? */
export function verifyIndexSignature(body: Uint8Array, signature: string, listed: readonly string[]): boolean {
  const sig = signature.trim();
  if (!SIGNATURE.test(sig)) return false;
  const bytes = Buffer.from(sig, "base64");
  return listed.some((k) => {
    const key = publicKeyFrom(k);
    try {
      return !!key && verify(null, body, key, bytes);
    } catch {
      return false;
    }
  });
}
