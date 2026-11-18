/**
 * The address a link preview is kept under (lib/link-previews.ts), pure so
 * the app can key its own copy on the device the same way
 * (app/src/db/rich-links.ts).
 */
import { cleanUrl } from "./saved-rules";

const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|si)$/i;

/**
 * https, no fragment (a text fragment or anchor is the same page), no
 * tracking parameters, no trailing slash after a path. The path's case is
 * kept: YouTube's ids are case-sensitive. Null for anything that isn't a
 * public-looking web address.
 */
export function normalisePreviewUrl(raw: unknown): string | null {
  const clean = cleanUrl(raw);
  if (!clean) return null;
  const u = new URL(clean);
  u.protocol = "https:";
  u.hash = "";
  if (u.port === "443" || u.port === "80") u.port = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let s = u.toString();
  if (u.pathname !== "/" && !u.search) s = s.replace(/\/+$/, "");
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s.length <= 2048 ? s : null;
}

/** What a preview's blind index is made from (lib/link-previews.ts keys its rows by it; the Obsidian export finds titles by it). */
export const previewKeyText = (url: string): string => `link-preview\u0000${url}`;
