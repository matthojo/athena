/**
 * Sharing check-in questions, for the app (lib/checkin-share.ts, lib/checkin-sets.ts and POST /api/checkins/share on
 * the server): some of the owner's own questions as a file someone else can add to their check-ins. Sample mode does
 * the same here, against the sample people and places, with no server: a download there is checkin.json on its own,
 * not a zip.
 *
 * Adding a set happens on the `#/add` screen (app/src/db/community.ts).
 */
import { getToken, isSampleMode, request } from "./api";
import { sampleKnown } from "./flow-share";
import { exportCheckins, serialiseSharedCheckins, type CheckinExport, type CheckinExportContext } from "../../../lib/checkin-share";
import { ShareFormatError, type Finding } from "../../../lib/team-share";

export type { CheckinExport };
/** What the owner can change in the share sheet. It changes the file, never the questions. */
export type CheckinShareEdits = NonNullable<CheckinExportContext["edits"]>;

/** The picked questions as a file to share, with these edits: what's flagged and what was taken out. */
export async function checkCheckinExport(questionIds: string[], edits: CheckinShareEdits, fine: string[]): Promise<CheckinExport> {
  if (isSampleMode()) {
    const { sampleCheckinSettings } = await import("./sample-checkins");
    const own = (await sampleCheckinSettings()).own;
    const picked = questionIds.map((id) => own.find((q) => q.id === id && !q.set)).filter((q): q is NonNullable<typeof q> => !!q);
    try {
      return exportCheckins(picked, { ownHosts: [location.hostname], known: sampleKnown(), edits, fine });
    } catch (error) {
      if (error instanceof ShareFormatError) throw new Error(error.message);
      throw error;
    }
  }
  return request<CheckinExport>("/checkins/share", { method: "POST", body: JSON.stringify({ question_ids: questionIds, edits, fine }) });
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
 * Save the file to this device: a zip with <slug>/checkin.json, or checkin.json alone in sample mode. The server
 * checks again first and answers with what's still flagged; nothing is saved then. Null when it saved, with the name.
 */
export async function downloadCheckinExport(questionIds: string[], edits: CheckinShareEdits, fine: string[]): Promise<{ findings: Finding[] } | { saved: string }> {
  if (isSampleMode()) {
    const x = await checkCheckinExport(questionIds, edits, fine);
    if (x.findings.length) return { findings: x.findings };
    save(new Blob([serialiseSharedCheckins(x.shared)], { type: "application/json" }), "checkin.json");
    return { saved: "checkin.json" };
  }
  const token = getToken();
  const res = await fetch("/api/checkins/share", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question_ids: questionIds, edits, fine, download: true }),
  });
  if (res.status === 409) return { findings: ((await res.json()) as { findings?: Finding[] }).findings ?? [] };
  if (!res.ok) {
    const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
    throw new Error(why ?? "That download didn't work. Try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "check-in-questions.zip";
  save(await res.blob(), name);
  return { saved: name };
}
