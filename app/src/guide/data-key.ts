/**
 * The data key the guide makes for a new owner (ATHENA_DATA_KEY, docs:
 * security/encryption). It's made here, in the browser, and never sent to
 * Athena: the owner copies it into Netlify themselves. Its key id is worked
 * out the same way lib/data-box.ts does (HKDF-SHA256, salt "athena"), so once
 * the new deploy is live the guide can say whether the key Netlify has is the
 * one the owner saved.
 *
 * Kept in sessionStorage until the site has a key, so a reload while the
 * owner is in Netlify doesn't make a different one.
 */

const STORE = "athena.guide.key";
const HEX = /^[0-9a-f]{64}$/;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** 32 random bytes as 64 hex characters, like `openssl rand -hex 32`. */
export function makeDataKey(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The 8-character key id lib/data-box.ts stores with every value sealed under this key. */
export async function dataKeyId(key: string): Promise<string> {
  const bytes = Uint8Array.from(key.match(/../g)!.map((b) => parseInt(b, 16)));
  const ikm = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
  const enc = new TextEncoder();
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("athena"), info: enc.encode("athena/data/key-id/v1") }, ikm, 32);
  return hex(new Uint8Array(bits));
}

/** This session's key: the one made earlier, or a new one. */
export function sessionDataKey(): string {
  try {
    const kept = sessionStorage.getItem(STORE);
    if (kept && HEX.test(kept)) return kept;
    const made = makeDataKey();
    sessionStorage.setItem(STORE, made);
    return made;
  } catch {
    return makeDataKey();
  }
}

/** Forget it once the site has a key: the owner's copy is the one that counts now. */
export function forgetSessionDataKey(): void {
  try {
    sessionStorage.removeItem(STORE);
  } catch {
    // nothing kept
  }
}
