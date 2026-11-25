/**
 * Sharing a note template, for the app (lib/template-share.ts, lib/templates-db.ts and POST /api/templates/:id/share
 * on the server): one of the owner's own templates as a file someone else can add to theirs. Sample mode does the
 * same here, against the sample people and places, with no server: a download there is template.json on its own,
 * not a zip.
 *
 * Adding one happens on the `#/add` screen (app/src/db/community.ts).
 */
import { getToken, isSampleMode, request } from "./api";
import { sampleKnown } from "./flow-share";
import { loadTemplates } from "./documents";
import { exportTemplate, serialiseSharedTemplate, type TemplateExport, type TemplateExportContext } from "../../../lib/template-share";
import { ShareFormatError, type Finding } from "../../../lib/team-share";

export type { TemplateExport };
/** What the owner can change in the share sheet. It changes the file, never the template. */
export type TemplateShareEdits = NonNullable<TemplateExportContext["edits"]>;

/** The template as a file to share, with these edits: what's flagged and what was taken out. */
export async function checkTemplateExport(id: string, edits: TemplateShareEdits, fine: string[]): Promise<TemplateExport> {
  if (isSampleMode()) {
    const t = (await loadTemplates()).find((x) => x.id === id && !x.starter && !x.shared);
    if (!t) throw new Error("Only templates you wrote can be shared.");
    try {
      return exportTemplate(t, { ownHosts: [location.hostname], known: sampleKnown(), edits, fine });
    } catch (error) {
      if (error instanceof ShareFormatError) throw new Error(error.message);
      throw error;
    }
  }
  return request<TemplateExport>(`/templates/${encodeURIComponent(id)}/share`, { method: "POST", body: JSON.stringify({ edits, fine }) });
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
 * Save the file to this device: a zip with <slug>/template.json, or template.json alone in sample mode. The server
 * checks again first and answers with what's still flagged; nothing is saved then.
 */
export async function downloadTemplateExport(id: string, edits: TemplateShareEdits, fine: string[]): Promise<{ findings: Finding[] } | { saved: string }> {
  if (isSampleMode()) {
    const x = await checkTemplateExport(id, edits, fine);
    if (x.findings.length) return { findings: x.findings };
    save(new Blob([serialiseSharedTemplate(x.shared)], { type: "application/json" }), "template.json");
    return { saved: "template.json" };
  }
  const token = getToken();
  const res = await fetch(`/api/templates/${encodeURIComponent(id)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ edits, fine, download: true }),
  });
  if (res.status === 409) return { findings: ((await res.json()) as { findings?: Finding[] }).findings ?? [] };
  if (!res.ok) {
    const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
    throw new Error(why ?? "That download didn't work. Try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "template.zip";
  save(await res.blob(), name);
  return { saved: name };
}
