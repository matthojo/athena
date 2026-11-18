/**
 * Which version of Athena this is, and whether a newer release is out
 * (Settings → About). The build puts the version in from package.json
 * (app/vite.config.ts). The check is one request to GitHub's public releases
 * API, made only when the owner presses "Check for updates": no account,
 * token or anything else from Athena goes with it.
 */

export const ATHENA_REPO = "matthojo/athena";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${ATHENA_REPO}/releases/latest`;
/** The README's "Updating" section. */
export const UPDATING_URL = `https://github.com/${ATHENA_REPO}#updating`;

type Triple = [number, number, number];

/** "1.2.3" or "v1.2.3" as numbers; null for anything else (a pre-release, "dev"). */
export function parseVersion(value: string): Triple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when both are versions and `latest` comes after `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface LatestRelease {
  version: string;
  url: string;
}

/** GitHub's "latest release" reply, as the version and its page; null for a draft, a pre-release or anything unexpected. */
export function readLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null;
  const r = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || typeof r.html_url !== "string") return null;
  const v = parseVersion(r.tag_name);
  if (!v || !r.html_url.startsWith(`https://github.com/${ATHENA_REPO}/`)) return null;
  return { version: v.join("."), url: r.html_url };
}
