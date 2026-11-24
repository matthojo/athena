/**
 * The Community site, and the addresses Athena makes on it. No imports, so the share formats (lib/share-kinds.ts,
 * lib/team-share.ts) and the catalogue (lib/catalogue-types.ts) can all read it. Pure.
 */

/**
 * The Community site: a directory people sign in to and send items through, which also serves the catalogue's
 * index.json and bundles. The catalogue every Athena reads unless `ATHENA_CATALOGUE_URL` names another
 * (lib/community-config.ts). Nothing is fetched from it until the owner opens Community.
 */
export const COMMUNITY_SITE = "https://athena-community.netlify.app";

/** A catalogue id: lowercase letters and digits without i, l, o and u (Crockford's base 32), 16 of them: 80 random bits. */
export const CATALOGUE_ID = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;

/** The site's page for sending an item in: `/submit/` at the catalogue's host. Null without one. */
export function submitPageUrl(root: string): string | null {
  if (!root) return null;
  try {
    return new URL("/submit/", root).href;
  } catch {
    return null;
  }
}

/** A listing's own page on the site: `/items/<id>/` at the catalogue's host. Null without a root or a real id. */
export function listingPageUrl(root: string, id: string): string | null {
  if (!root || !CATALOGUE_ID.test(id)) return null;
  try {
    return new URL(`/items/${id}/`, root).href;
  } catch {
    return null;
  }
}

/**
 * A `based_on` that names a listing on the Community site, cleaned: `https://<site>/items/<id>/`. Only the Community
 * site's own host, so a file can't name somewhere else and have it read as Community. Undefined for anything else.
 */
export function listingLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 300) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.host !== new URL(COMMUNITY_SITE).host) return undefined;
    const m = /^\/items\/([^/]+)\/?$/.exec(u.pathname);
    return m && CATALOGUE_ID.test(m[1]) ? `${COMMUNITY_SITE}/items/${m[1]}/` : undefined;
  } catch {
    return undefined;
  }
}

/** The listing a `based_on` names, by id, when it's a Community listing. */
export const listingIdOf = (basedOn: string | undefined): string | null => (basedOn && listingLink(basedOn) ? /\/items\/([^/]+)\/$/.exec(basedOn)![1] : null);
