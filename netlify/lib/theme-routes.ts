/**
 * Sharing a theme, over REST, mounted by netlify/functions/api.ts behind the same bearer token:
 *
 *   POST /api/themes/:id/share   { edits?, fine?, download? } → ThemeExport (lib/theme-share.ts); with download, the
 *                                zip (<slug>/theme.json), or 409 with what's still flagged
 *
 * Only a theme the owner made: Athena's built-in themes aren't theirs to share, and one added from someone else is
 * refused (lib/theme-prefs.ts exportThemeFor). Choosing, saving and removing themes go through PUT /api/settings;
 * adding one someone shared goes through POST /api/community/add.
 */
import { exportThemeFor, themeZip } from "../../lib/theme-prefs";
import { AthenaInputError } from "../../lib/db";

type Reply = (data: unknown, status?: number) => Response;

const THEME_ID = /^[a-z0-9]{6,32}$/;

/** /api/themes*: null for anything else. */
export async function handleThemeRoutes(req: Request, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second, third, fourth] = segments;
  if (first !== "themes") return null;
  if (!second || third !== "share" || fourth !== undefined) return reply({ error: "Not found" }, 404);
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const id = decodeURIComponent(second);
  if (!THEME_ID.test(id)) return reply({ error: "No such theme" }, 404);
  let b: Record<string, unknown> = {};
  try {
    const data = (await req.json()) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) b = data as Record<string, unknown>;
  } catch {
    throw new AthenaInputError("Send a JSON object");
  }
  const { ownHosts } = await import("../../lib/team-share-store");
  const made = await exportThemeFor(id, b, { hosts: ownHosts(new URL(req.url).origin) });
  if (b.download !== true) return reply(made);
  if (made.findings.length) return reply({ error: "Check what's flagged first: edit it out, or say it's fine to share.", findings: made.findings }, 409);
  return new Response(Buffer.from(await themeZip(made)), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${made.slug}.zip"`, "Cache-Control": "no-store" } });
}
