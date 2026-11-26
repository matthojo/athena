/**
 * The site's own address, and which browser origins may call /api/*.
 *
 * Calls that carry the master token to Athena's own functions (a background
 * run's hand-off) go to siteOrigin(): Netlify's URL, the site's primary
 * address, never the Host a request arrived with. The request's own origin
 * is used only where URL isn't set (tests, a bare local run).
 *
 * CORS: the app is served from the same origin as /api/*, the browser
 * extension reaches it through the host permission it asks for, and the
 * Shortcut, Raycast and scripts aren't browsers. So a cross-origin answer is
 * only ever needed by the site itself (under any of its addresses) and a
 * browser extension; any other Origin gets no Access-Control-Allow-Origin.
 */

const env = (key: string): string | undefined =>
  (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(key) ?? process.env[key];

const originOf = (raw: string | undefined): string | null => {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/** Netlify's URL as an origin, or `fallback` where it isn't set. */
export function siteOrigin(fallback: string): string {
  return originOf(env("URL")) ?? fallback;
}

/** The site's own addresses: URL, and this deploy's own (DEPLOY_PRIME_URL, DEPLOY_URL). */
export function siteOrigins(): string[] {
  return ["URL", "DEPLOY_PRIME_URL", "DEPLOY_URL"].map((k) => originOf(env(k))).filter((o): o is string => !!o);
}

const EXTENSION = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]{1,64}$/i;

/**
 * The Origin to name in Access-Control-Allow-Origin, or null for none: the
 * request's own origin, one of the site's addresses, or a browser
 * extension's. Pure.
 */
export function corsOrigin(origin: string | null, own: { request: string; site: string[] }): string | null {
  if (!origin) return null;
  if (origin === own.request || own.site.includes(origin) || EXTENSION.test(origin)) return origin;
  return null;
}
