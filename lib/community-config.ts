/**
 * Community: where the catalogue is, and the owner's switch for checking it. Server-side (it reads the environment
 * and settings); the helpers marked pure are tested.
 *
 * - `ATHENA_CATALOGUE_URL`: the catalogue's root, an https address (index.json is read from there). Empty by
 *   default, and while it's empty Athena never contacts a catalogue. http is accepted only for localhost, for a
 *   catalogue served while developing.
 * - "Check the Community catalogue": settings row `community`, `{ on: boolean }`, plain. Off until the owner turns
 *   it on. While it's off Athena's server fetches nothing from the catalogue; adding an item from a file or a link
 *   still works.
 */
import { AthenaInputError, q } from "./db";

const env = (k: string): string | undefined => (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(k) ?? process.env[k];

/** The catalogue root as configured, cleaned: an https address with no query, fragment or trailing slash, or "". Pure. */
export function cleanCatalogueUrl(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "";
    if (u.username || u.password || u.search || u.hash) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** The catalogue's root from `ATHENA_CATALOGUE_URL`, or "" when there isn't one (the default). */
export const catalogueUrl = (): string => cleanCatalogueUrl(env("ATHENA_CATALOGUE_URL"));

/**
 * A file's address under the catalogue's root: `path` as an index gives it ("index.json", "bundles/<id>.json").
 * Null when the root is empty or the path would leave it. Pure.
 */
export function catalogueFileUrl(root: string, path: string): string | null {
  if (!root || !path || path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === "..") || /[?#\\]/.test(path)) return null;
  const url = `${root}/${path}`;
  try {
    return new URL(url).href.startsWith(`${root}/`) ? url : null;
  } catch {
    return null;
  }
}

// ---------- the owner's switch ----------

export const COMMUNITY_KEY = "community";

/** On only when the owner turned it on. Pure. */
export const readCommunityCheck = (raw: unknown): boolean => !!raw && typeof raw === "object" && (raw as { on?: unknown }).on === true;

/** A read that fails counts as off: nothing is fetched unless the switch is known to be on. */
export async function loadCommunityCheck(): Promise<boolean> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [COMMUNITY_KEY]);
    return readCommunityCheck(row?.value);
  } catch {
    return false;
  }
}

/** PUT { on: boolean }. */
export async function saveCommunityCheck(raw: unknown): Promise<{ on: boolean }> {
  const on = (raw as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") throw new AthenaInputError("Send on: true or false");
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [COMMUNITY_KEY, JSON.stringify({ on })]);
  return { on };
}
