/**
 * Sharing a theme, for the app (lib/theme-share.ts, lib/theme-prefs.ts and POST /api/themes/:id/share on the server):
 * one of the person's own themes as a file someone else can add to theirs. Sample mode does the same here, against the
 * sample people and places, with no server: a download there is theme.json on its own, not a zip.
 *
 * A change made offline goes up first, so the server shares the theme as the person sees it. Adding one happens on
 * the `#/add` screen (app/src/db/community.ts).
 */
import { getToken, isSampleMode, request } from "./api";
import { sampleKnown } from "./flow-share";
import { flushTheme, themeState } from "../lib/theme";
import { exportTheme, serialiseSharedTheme, type ThemeExport, type ThemeExportContext } from "../../../lib/theme-share";
import { ShareFormatError, type Finding } from "../../../lib/team-share";

export type { ThemeExport };
/** What the person can change in the share sheet. It changes the file, never the theme. */
export type ThemeShareEdits = NonNullable<ThemeExportContext["edits"]>;

/** The theme as a file to share, with these edits: what's flagged and what was taken out. */
export async function checkThemeExport(id: string, edits: ThemeShareEdits, fine: string[]): Promise<ThemeExport> {
  if (isSampleMode()) {
    const t = themeState().themes.find((x) => x.id === id && !x.origin);
    if (!t) throw new Error("Share only themes you made.");
    try {
      return exportTheme(t.theme, { ownHosts: [location.hostname], known: sampleKnown(), edits, fine });
    } catch (error) {
      if (error instanceof ShareFormatError) throw new Error(error.message);
      throw error;
    }
  }
  await flushTheme();
  return request<ThemeExport>(`/themes/${encodeURIComponent(id)}/share`, { method: "POST", body: JSON.stringify({ edits, fine }) });
}

function save(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

/**
 * Save the file to this device: a zip with <slug>/theme.json, or theme.json alone in sample mode. The server checks
 * again first and answers with what's still flagged; nothing is saved then.
 */
export async function downloadThemeExport(id: string, edits: ThemeShareEdits, fine: string[]): Promise<{ findings: Finding[] } | { saved: string }> {
  if (isSampleMode()) {
    const x = await checkThemeExport(id, edits, fine);
    if (x.findings.length) return { findings: x.findings };
    save(new Blob([serialiseSharedTheme(x.shared)], { type: "application/json" }), "theme.json");
    return { saved: "theme.json" };
  }
  await flushTheme();
  const token = getToken();
  const res = await fetch(`/api/themes/${encodeURIComponent(id)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ edits, fine, download: true }),
  });
  if (res.status === 409) return { findings: ((await res.json()) as { findings?: Finding[] }).findings ?? [] };
  if (!res.ok) {
    const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
    throw new Error(why ?? "That download didn't work. Try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "theme.zip";
  save(await res.blob(), name);
  return { saved: name };
}
