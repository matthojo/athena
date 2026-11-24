/**
 * Shared assistants, for the app (lib/team-share.ts, lib/team-share-store.ts and
 * /api/team/…/export on the server): sharing an assistant as a file, and, in
 * sample mode, adding one someone shared (the Add screen, app/src/add/, previews it;
 * a real copy adds through /api/community/add). Sample mode works against the
 * sample team and the sample people, with no server: a download there is
 * assistant.json on its own.
 */
import { getToken, isSampleMode, request } from "./api";
import { createAssistant, getAssistant, sampleKeepImportedSkill, teamChanged, type TeamAssistant } from "./team";
import { sampleSkillList } from "./skills";
import { samplePeople, samplePlaces, sampleOrganisations } from "./sample-data";
import {
  addRemoved,
  checkFields,
  findPersonal,
  grantedTools,
  scrubText,
  serialiseShared,
  triggerInputs,
  withAnswers,
  sharedFromAssistant,
  shareSeed,
  shareSlug,
  ShareFormatError,
  type KnownTerm,
  type Removed,
  type ShareEdits,
  type ShareExport,
  type ImportPreview,
} from "../../../lib/team-share";
import { avatarFromSeed } from "../../../lib/team-seed";
import type { TeamAnswer } from "../../../lib/team-skill";

export type { ShareEdits, ShareExport, ImportPreview };

// ---------- sharing ----------

/** Sample mode's own people, places and organisations, as the server would gather them. */
function sampleKnown(): KnownTerm[] {
  const out: KnownTerm[] = [];
  for (const p of samplePeople()) {
    out.push({ term: p.name, kind: "person" });
    const first = p.name.split(" ")[0];
    if (first && first !== p.name) out.push({ term: first, kind: "person", loose: true });
    if (p.email) out.push({ term: p.email, kind: "email" });
  }
  for (const p of samplePlaces()) out.push({ term: p.name, kind: "place" });
  for (const o of sampleOrganisations()) out.push({ term: o.name, kind: "organisation" });
  out.push({ term: "Jordan", kind: "you", loose: true });
  return out;
}

function sampleExport(a: TeamAssistant, edits: ShareEdits, fine: string[]): ShareExport {
  const s = sampleSkillList().find((x) => x.assistant_id === a.id);
  let removed: Removed[] = [];
  const hosts = [location.hostname];
  const scrub = (t: string) => {
    const r = scrubText(t, hosts);
    removed = addRemoved(removed, r.removed);
    return r.text;
  };
  let w = sharedFromAssistant(a, { summary: s?.team?.summary, answers: s?.team?.answers, edits });
  w = { ...w, job: scrub(w.job), instructions: scrub(w.instructions), summary: scrub(w.summary) };
  const body = edits.skill ?? s?.body ?? "";
  const skill = body.trim() ? { body: scrub(body), files: (s?.files ?? []).map((f) => ({ path: f.path, text: scrub(f.text) })), skipped: [] } : null;
  return { shared: w, skill, findings: findPersonal(checkFields(w, skill), sampleKnown(), fine), removed, slug: shareSlug(w.name, w.job) };
}

/** The assistant as a file to share, with these edits: what's flagged and what was taken out. Nothing changes on the assistant. */
export async function checkExport(id: string, edits: ShareEdits, fine: string[]): Promise<ShareExport> {
  if (isSampleMode()) {
    const a = await getAssistant(id);
    if (!a) throw new Error("That assistant isn't there any more");
    try {
      return sampleExport(a, edits, fine);
    } catch (error) {
      if (error instanceof ShareFormatError) throw new Error(error.message);
      throw error;
    }
  }
  return request<ShareExport>(`/team/${encodeURIComponent(id)}/export`, { method: "POST", body: JSON.stringify({ edits, fine }) });
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
 * Save the shared to this device. The server checks again first: when
 * something is still flagged it answers with the findings, returned here,
 * and nothing is saved. Null when it saved.
 */
export async function downloadExport(id: string, edits: ShareEdits, fine: string[]): Promise<ShareExport["findings"] | null> {
  if (isSampleMode()) {
    const x = await checkExport(id, edits, fine);
    if (x.findings.length) return x.findings;
    save(new Blob([serialiseShared(x.shared)], { type: "application/json" }), "assistant.json");
    return null;
  }
  const token = getToken();
  const res = await fetch(`/api/team/${encodeURIComponent(id)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ edits, fine, download: true }),
  });
  if (res.status === 409) return ((await res.json()) as { findings: ShareExport["findings"] }).findings;
  if (!res.ok) {
    const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
    throw new Error(why ?? "That download didn't work. Try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "assistant.zip";
  save(await res.blob(), name);
  return null;
}

// ---------- adding ----------

/** Sample mode: add it, paused, with only the ticked tools it asked for. Returns the new assistant. A real copy adds through /api/community/add. */
export async function addImported(p: ImportPreview, choices: { answers: TeamAnswer[]; allow: string[]; web: boolean; accounts: string[] }): Promise<TeamAssistant> {
  if (isSampleMode()) {
    const w = p.shared;
    const made = await createAssistant(
      {
        ...(w.name ? { name: w.name } : {}),
        job: w.job,
        instructions: w.instructions,
        ...(w.personality ? { personality: w.personality } : {}),
        avatar: w.avatar ?? avatarFromSeed(shareSeed(w)),
        allow: grantedTools(w, choices.allow),
        web: choices.web && w.web,
        paused: true,
        triggers: triggerInputs(w),
        answers: choices.answers,
        accounts: choices.accounts,
      },
      { sampleSkill: !p.skill, imported: true, needs: w.needs },
    );
    if (p.skill) sampleKeepImportedSkill(made, withAnswers(p.skill.body, choices.answers), choices.answers, w.summary);
    return made;
  }
  throw new Error("Adding goes through /api/community/add outside sample mode.");
}
