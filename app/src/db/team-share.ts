/**
 * Shared assistants, for the app (lib/team-share.ts, lib/team-share-store.ts and
 * /api/team/…/export and /api/team/import on the server): sharing an assistant as a file, and
 * adding one someone shared. Sample mode does the same here, against the
 * sample team and the sample people, with no server: a download there is
 * assistant.json on its own, and a zip can't be read.
 */
import { getToken, isSampleMode, request } from "./api";
import { createAssistant, getAssistant, listTeam, sampleKeepImportedSkill, teamChanged, type TeamAssistant } from "./team";
import { sampleSkillList } from "./skills";
import { samplePeople, samplePlaces, sampleOrganisations } from "./sample-data";
import {
  addRemoved,
  bundleFromEntries,
  checkFields,
  findPersonal,
  grantedTools,
  linkedHosts,
  parseShareLink,
  readShared,
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
  type SharedBundle,
  type ShareEdits,
  type ShareExport,
  type ImportInput,
  type ImportPreview,
} from "../../../lib/team-share";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { avatarFromSeed } from "../../../lib/team-seed";
import type { TeamAnswer } from "../../../lib/team-skill";
import { orderAccounts, splitWouldLike } from "../../../lib/shared-limits";
import { SAMPLE_ACCOUNTS } from "./item-accounts";

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

const b64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";

async function samplePreview(bundle: SharedBundle): Promise<ImportPreview> {
  const team = await listTeam();
  const texts = [bundle.shared.instructions, bundle.shared.summary, bundle.skill?.body ?? "", ...(bundle.skill?.files.map((f) => f.text) ?? [])];
  // Sample mode has Linear and Gmail connected, as its sample accounts are.
  const have = new Set(SAMPLE_ACCOUNTS.map((a) => a.provider));
  const { offered, asksFirst } = splitWouldLike(bundle.shared.would_like);
  return {
    ...bundle,
    shared: { ...bundle.shared, would_like: offered },
    asks_first: asksFirst,
    needs: bundle.shared.needs.map((id) => ({ id, connected: have.has(id) })),
    accounts: orderAccounts(SAMPLE_ACCOUNTS, bundle.shared.needs),
    links: linkedHosts(texts),
    room: team.length < MAX_ASSISTANTS,
  };
}

/** Sample mode's stand-in for a GitHub link: Dot, as someone else shared it. */
const SAMPLE_LINKED = {
  format: 1,
  name: "Dot",
  job: "Turns Linear issues assigned to you into to-dos",
  author: "sample-author",
  version: "1.1.0",
  summary: "Adds a to-do for each Linear issue assigned to you, in your Work context, with the issue's own due date.",
  instructions: "When a Linear issue is assigned to me, add a to-do with its title and link. Leave the due date empty unless the issue has one.",
  triggers: [{ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } }],
  asks: [{ question: "Which context should work to-dos go in?", choices: ["Work", "No context"] }],
  would_like: ["add_todo", "complete_todo", "archive_or_restore"],
  web: false,
  personality: { tone: "crisp", traits: ["tidy", "quick"], pronoun: "they", greeting: "Ready when you are." },
};
const SAMPLE_LINKED_SKILL = "1. Read the issue: its title, link and due date.\n2. If there's already a to-do for it, leave it.\n3. Add a to-do with the title and link, in the context your owner chose.\n4. Say in one line what you added.";

const asError = (error: unknown): never => {
  throw error instanceof Error ? new Error(error.message) : error;
};

/** A shared assistant's zip, its assistant.json, or its folder (from a picker or a drop), as an import would add it. Nothing is kept. */
export async function previewImportFiles(files: File[]): Promise<ImportPreview> {
  const one = files.length === 1 ? files[0] : null;
  const zip = !!one && isZip(one);
  const entries = !zip ? files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })) : [];
  const file = one?.name ?? entries[0]?.path.split("/")[0];
  if (isSampleMode()) {
    if (zip) throw new Error("In sample mode Athena can read an assistant.json or a folder, but not a zip.");
    try {
      const read = await Promise.all(entries.map(async (e) => ({ path: e.path, bytes: new Uint8Array(await e.file.arrayBuffer()) })));
      return samplePreview(bundleFromEntries(read, { kind: "upload", ...(file ? { file } : {}), at: new Date().toISOString() }));
    } catch (error) {
      return asError(error);
    }
  }
  const body = zip ? { zip: await b64(one!), file: one!.name } : { entries: await Promise.all(entries.map(async (e) => ({ path: e.path, data: await b64(e.file) }))), file };
  return request<ImportPreview>("/team/import/preview", { method: "POST", body: JSON.stringify(body) });
}

/** A shared assistant's folder on GitHub, read once by the server. Nothing is kept. */
export async function previewImportLink(url: string): Promise<ImportPreview> {
  if (isSampleMode()) {
    try {
      parseShareLink(url);
      await new Promise((r) => setTimeout(r, 700));
      return samplePreview({ shared: readShared(SAMPLE_LINKED), skill: { body: SAMPLE_LINKED_SKILL, files: [], skipped: [] }, source: { kind: "link", url, at: new Date().toISOString() } });
    } catch (error) {
      return asError(error);
    }
  }
  return request<ImportPreview>("/team/import/preview", { method: "POST", body: JSON.stringify({ url }) });
}

/** Add it: paused, with only the ticked tools it asked for. Returns the new assistant. */
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
  const input: ImportInput = { shared: p.shared, skill: p.skill, source: p.source, answers: choices.answers, allow: choices.allow, web: choices.web, accounts: choices.accounts };
  const { assistant } = await request<{ assistant: TeamAssistant }>("/team/import", { method: "POST", body: JSON.stringify(input) });
  teamChanged();
  return assistant;
}

// ---------- a file shared to the installed app ----------

/** An assistant shared to the installed app (sw.js keeps it until the Team page takes it). Null when there's none. */
export async function takeSharedAssistant(): Promise<File | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open("athena-share");
    const res = await cache.match("/share-target/assistant");
    if (!res) return null;
    const name = decodeURIComponent(res.headers.get("X-File-Name") ?? "") || "assistant.zip";
    const blob = await res.blob();
    await cache.delete("/share-target/assistant");
    return new File([blob], name, { type: blob.type });
  } catch {
    return null;
  }
}
