/**
 * Ask's skills, for the app (lib/skills.ts, lib/skills-store.ts and
 * netlify/lib/skills-routes.ts on the server): the list, saving, previews of
 * an upload or a link, a draft from a chat, and downloads. Sample mode keeps
 * its own set on this page: the three starters and one of the owner's own,
 * in use.
 */
import { getToken, isSampleMode, request } from "./api";
import { STARTER_SKILLS } from "../../../lib/skill-starters";
import { intakeEntries, parseSkillMd, serialiseSkillMd, skillTitle, SkillFormatError, type SkillFile, type SkillPreview, type SkillSkipped, type SkillSource } from "../../../lib/skills";
import type { TeamSkillMeta } from "../../../lib/team-skill";
import { sampleTeamSkills } from "./sample-team";
import { skillImported } from "../../../lib/shared-limits";

export interface AppSkill {
  id: string;
  name: string;
  /** "Meeting prep". */
  title: string;
  description: string;
  body: string;
  extra: string;
  files: SkillFile[];
  skipped: SkillSkipped[];
  source: SkillSource;
  enabled: boolean;
  starter: string | null;
  /** A Team assistant's own skill: that assistant. Main Ask never lists or loads it. */
  assistant_id: string | null;
  /** An assistant's skill: what Athena wrote it from. */
  team?: TeamSkillMeta;
  /** From a file or a link: someone else's words. While Ask uses it, only `accounts` can be opened. Missing on older servers. */
  imported?: boolean;
  /** The connected accounts ticked for an imported skill (connector ids). Missing on older servers. */
  accounts?: string[];
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  /** The SKILL.md a download gives. */
  skill_md: string;
}

/** What the editor saves: the three parts, files, and where it came from. */
export interface SkillDraftInput {
  name: string;
  description: string;
  body: string;
  extra?: string;
  files?: SkillFile[];
  skipped?: SkillSkipped[];
  source?: Partial<SkillSource>;
  enabled?: boolean;
  /** An imported skill's connected accounts, the whole set. */
  accounts?: string[];
}

const listeners = new Set<() => void>();
/** Something changed a skill (saved, switched, deleted): the list and Ask's "/" follow. */
export function onSkillsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

// ---------- sample mode ----------

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
export const SAMPLE_SKILL_ID = "5a3e0000-0000-4000-8000-00000000c001";
const SAMPLE_DEAL = `---
name: deal-notes
description: Use when the owner asks what a client said about pricing, terms or a deal.
---

# Deal notes

1. Search calls and email from the last two months for the client and the deal.
2. Say what they asked for, what was agreed and what's still open, with who said it and when.
3. End with the next step on the owner's to-do list, if there is one.
`;

function sampleSkill(id: string, text: string, over: Partial<AppSkill>): AppSkill {
  const doc = parseSkillMd(text);
  const at = over.created_at ?? daysAgo(30);
  const s: AppSkill = { id, ...doc, title: skillTitle(doc.name), files: [], skipped: [], source: { kind: "starter", at }, enabled: false, starter: null, assistant_id: null, accounts: [], uses: 0, last_used_at: null, created_at: at, updated_at: at, skill_md: serialiseSkillMd(doc), ...over };
  return { ...s, imported: skillImported(s.source) };
}

let sampleSet: AppSkill[] | null = null;
function sampleSkills(): AppSkill[] {
  return (sampleSet ??= [
    sampleSkill(SAMPLE_SKILL_ID, SAMPLE_DEAL, {
      enabled: true,
      uses: 6,
      last_used_at: daysAgo(0),
      source: { kind: "link", url: "https://github.com/sample/skills/tree/main/deal-notes", at: daysAgo(12) },
      files: [{ path: "reference/terms.md", text: "# Terms we usually offer\n\n- 30 days to pay\n- A year's contract, renewed each spring\n" }],
      skipped: [{ path: "scripts/export.py", reason: "Not used: Athena doesn't run scripts" }],
      created_at: daysAgo(12),
    }),
    ...STARTER_SKILLS.map((s, i) => sampleSkill(`5a3e0000-0000-4000-8000-00000000c10${i}`, s.text, { starter: s.key, source: { kind: "starter", at: daysAgo(30) } })),
    // Moss, Dot and Wren's own skills.
    ...sampleTeamSkills().map((t) => sampleSkill(t.id, t.text, { assistant_id: t.assistant_id, team: t.team, source: { kind: "team", at: t.at }, created_at: t.at, uses: t.uses, last_used_at: t.uses ? daysAgo(1) : null })),
  ]);
}

/** Sample mode: every skill as the page keeps it, for the Team pages. */
export function sampleSkillList(): AppSkill[] {
  return sampleSkills();
}

/** Sample mode: put or remove an assistant's own skill (the Team pages write it). */
export function setSampleSkills(next: AppSkill[]): void {
  sampleSet = next;
  changed();
}

/** Sample mode: a skill built the way the server keeps one. */
export function sampleSkillFrom(id: string, text: string, over: Partial<AppSkill>): AppSkill {
  return sampleSkill(id, text, over);
}

/** The skill sample mode's pricing answer used. */
export function sampleUsedSkill(): { id: string; name: string } {
  return { id: SAMPLE_SKILL_ID, name: "Deal notes" };
}

// ---------- the list ----------

let cache: AppSkill[] | null = null;

export async function fetchSkills(): Promise<AppSkill[]> {
  if (isSampleMode()) return sampleSkills().map((s) => ({ ...s }));
  const { skills } = await request<{ skills: AppSkill[] }>("/skills");
  cache = skills;
  return skills;
}

/** The skills Ask's "/" offers: on ones first, then off ones (picking one uses it once without switching it on). The last list fetched, then fresh. Never an assistant's own. */
export async function pickableSkills(): Promise<AppSkill[]> {
  const all = (isSampleMode() ? sampleSkills() : (cache ?? (await fetchSkills().catch(() => [])))).filter((s) => !s.assistant_id);
  return [...all.filter((s) => s.enabled), ...all.filter((s) => !s.enabled)];
}

export async function fetchSkill(id: string): Promise<AppSkill | null> {
  if (isSampleMode()) return sampleSkills().find((s) => s.id === id) ?? null;
  return request<AppSkill>(`/skills/${encodeURIComponent(id)}`).catch(() => null);
}

/** Save a new skill or changes to one. Nothing is saved anywhere else. */
export async function saveSkill(input: SkillDraftInput, id?: string): Promise<AppSkill> {
  if (isSampleMode()) {
    const doc = parseSkillMd(serialiseSkillMd({ name: input.name, description: input.description, body: input.body, extra: input.extra ?? "" }));
    const list = sampleSkills();
    if (list.some((s) => s.name === doc.name && s.id !== id)) throw new SkillFormatError(`There's already a skill called ${doc.name}. Pick another name.`);
    const was = id ? list.find((s) => s.id === id) : undefined;
    const now = new Date().toISOString();
    const next: AppSkill = was
      ? { ...was, ...doc, title: skillTitle(doc.name), files: input.files ?? was.files, skipped: input.skipped ?? was.skipped, enabled: input.enabled ?? was.enabled, accounts: input.accounts ?? was.accounts, updated_at: now, skill_md: serialiseSkillMd(doc) }
      : // As the server does: one from a file or a link starts off, whatever was sent.
        sampleSkill(crypto.randomUUID(), serialiseSkillMd(doc), { files: input.files ?? [], skipped: input.skipped ?? [], enabled: !!input.enabled && !skillImported(input.source), accounts: input.accounts ?? [], source: { kind: input.source?.kind ?? "written", ...(input.source?.url ? { url: input.source.url } : {}), ...(input.source?.file ? { file: input.source.file } : {}), at: now }, created_at: now });
    sampleSet = was ? list.map((s) => (s.id === id ? next : s)) : [next, ...list];
    changed();
    return next;
  }
  const saved = id ? await request<AppSkill>(`/skills/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }) : await request<AppSkill>("/skills", { method: "POST", body: JSON.stringify(input) });
  cache = null;
  changed();
  return saved;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<AppSkill> {
  if (isSampleMode()) {
    sampleSet = sampleSkills().map((s) => (s.id === id ? { ...s, enabled } : s));
    changed();
    return sampleSkills().find((s) => s.id === id)!;
  }
  const saved = await request<AppSkill>(`/skills/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
  cache = null;
  changed();
  return saved;
}

export async function deleteSkill(id: string): Promise<void> {
  if (isSampleMode()) sampleSet = sampleSkills().filter((s) => s.id !== id);
  else await request(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  cache = null;
  changed();
}

// ---------- imports: a preview first ----------

const b64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A SKILL.md, a .zip, or a folder's files (from a folder picker or a drop), as the server would keep them. Nothing is saved. */
export async function previewUpload(files: File[]): Promise<SkillPreview> {
  const one = files.length === 1 ? files[0] : null;
  const isZip = !!one && (/\.zip$/i.test(one.name) || one.type === "application/zip" || one.type === "application/x-zip-compressed");
  const folder = !one || !isZip ? files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f })) : [];
  if (isSampleMode()) {
    if (isZip) throw new SkillFormatError("In sample mode Athena can read a SKILL.md or a folder, but not a zip.");
    const entries = await Promise.all(folder.map(async (e) => ({ path: e.path, bytes: new Uint8Array(await e.file.arrayBuffer()) })));
    return intakeEntries(entries, { kind: "upload", file: one?.name ?? folder[0]?.path.split("/")[0], at: new Date().toISOString() });
  }
  const body = isZip
    ? { zip: await b64(one!), file: one!.name }
    : { entries: await Promise.all(folder.map(async (e) => ({ path: e.path, data: await b64(e.file) }))), file: one?.name ?? folder[0]?.path.split("/")[0] };
  return request<SkillPreview>("/skills/preview", { method: "POST", body: JSON.stringify(body) });
}

/** A GitHub folder or a raw SKILL.md, fetched once by the server. Nothing is saved. */
export async function previewLink(url: string): Promise<SkillPreview> {
  if (isSampleMode()) {
    const doc = parseSkillMd(STARTER_SKILLS[2].text.replace("name: meeting-prep", "name: client-prep"));
    return { ...doc, files: [{ path: "reference/questions.md", text: "# Questions worth asking\n\n- What would make this a yes?\n- Who else needs to agree?\n" }], skipped: [{ path: "scripts/calendar.js", reason: "Not used: Athena doesn't run scripts" }], source: { kind: "link", url, at: new Date().toISOString() } };
  }
  return request<SkillPreview>("/skills/preview", { method: "POST", body: JSON.stringify({ url }) });
}

/** "Make this a skill": a draft from this conversation, for the editor. Never saved by this. */
export async function draftFromChat(messages: Array<{ role: "user" | "assistant"; text: string }>): Promise<{ name: string; description: string; body: string }> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 900));
    return {
      name: "pricing-follow-up",
      description: "Use when the owner asks where a pricing conversation with a client has got to.",
      body: "1. Find the client's last call and their latest pricing email.\n2. Say what they proposed and what the owner still owes them, with dates.\n3. If a reply is due, say so and offer to draft it.",
    };
  }
  return request("/assistant/skill-draft", { method: "POST", body: JSON.stringify({ messages }) });
}

/** Save a skill's SKILL.md, or a zip of it and its files, to this device. */
export async function downloadSkill(s: AppSkill, format: "md" | "zip"): Promise<void> {
  let blob: Blob;
  if (isSampleMode() || format === "md") blob = new Blob([s.skill_md], { type: "text/markdown" });
  else {
    const token = getToken();
    const res = await fetch(`/api/skills/${encodeURIComponent(s.id)}/download?format=zip`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error("That download didn't work. Try again.");
    blob = await res.blob();
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = format === "zip" && !isSampleMode() ? `${s.name}.zip` : "SKILL.md";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

// ---------- a draft on its way to the editor ----------

let held: (SkillDraftInput & { from: "chat" | "import" }) | null = null;
/** Hold a draft (from a chat, or an import's preview) for the editor to open with. Nothing is saved. */
export function holdSkillDraft(d: SkillDraftInput & { from: "chat" | "import" }): void {
  held = d;
}
/** The draft the editor opens with, once. */
export function takeSkillDraft(): (SkillDraftInput & { from: "chat" | "import" }) | null {
  const d = held;
  held = null;
  return d;
}
