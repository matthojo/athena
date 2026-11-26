/**
 * The browser's site session (netlify/edge-functions/site-auth.ts), checked
 * from a Function. The edge function issues `athena_session=<expiry>.<sig>`
 * after the site password, where sig is base64url HMAC-SHA256, under
 * SESSION_SECRET, of `<expiry>.<password tag>`: the tag is the first 16
 * characters of base64url SHA-256 of SITE_PASSWORD, so changing the password
 * ends every session. /api/* never passes through that gate, so the few
 * routes that a browser past the password may read before it has a key
 * (GET /api/setup) check the cookie here instead.
 *
 * A session only proves someone knows the site password. It never opens
 * notes or anything else the bearer token guards.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SITE_COOKIE = "athena_session";

/** The signature the edge function would give an expiry, for this password. */
export function sessionSignature(secret: string, password: string, exp: string): string {
  const tag = createHash("sha256").update(password).digest("base64url").slice(0, 16);
  return createHmac("sha256", secret).update(`${exp}.${tag}`).digest("base64url");
}

/** Whether the Cookie header carries an unexpired session signed with `secret` for `password`. */
export function validSiteSession(
  cookieHeader: string | null | undefined,
  secret: string | null | undefined,
  password: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!cookieHeader || !secret || !password) return false;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SITE_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [exp, sig] = match[1].split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(now.getTime() / 1000)) return false;
  const want = Buffer.from(sessionSignature(secret, password, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
