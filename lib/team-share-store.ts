/**
 * Shared assistants on the server (lib/team-share.ts has the format and the pure
 * parts): sharing an assistant as a file, and adding one someone shared.
 *
 * - `exportAssistant`: POST /api/team/<id>/export. The assistant and its
 *   skill as a file to share, with the owner's edits, links into their Athena
 *   taken out, and the personal-data check run against their own people,
 *   places, organisations, projects, email addresses, phone numbers, profile
 *   and account names. Nothing is kept: the edits only change the file.
 * - `shareZip`: the download, once nothing is left to check.
 * - `previewImport`: POST /api/team/import/preview. A zip, a folder's
 *   files, an assistant.json or a GitHub link, read once, with the accounts it
 *   needs and whether they're connected. Nothing is kept.
 * - `importAssistant`: POST /api/team/import. The assistant, paused, with
 *   only the tools the owner ticked (and the file asked for) allowed to
 *   run alone, and its skill with their answers added.
 */
import { AthenaInputError, q } from "./db";
import { listFacts } from "./memory";
import { listConnectors } from "./connectors";
import { createAssistant, getAssistant, listAssistants } from "./team";
import { triggersMoved } from "./team-flows";
import { avatarFromSeed } from "./team-seed";
import { MAX_ASSISTANTS, MAX_GREETING, MAX_INSTRUCTIONS, MAX_JOB, MAX_NAME, type TeamAssistant } from "./team-types";
import { assistantSkill, putAssistantSkill } from "./skills-store";
import { attachSkill } from "./team-skill-make";
import { fitAnswers, fitTeamSkill, hashText, MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, MAX_QUESTIONS, MAX_SUMMARY, skillBasis } from "./team-skill";
import { serialiseSkillMd, SKILL_LIMITS, SkillFormatError, type IntakeEntry, type SkillSource } from "./skills";
import { readSkillZip, writeSkillZip } from "./skill-zip";
import { fetchGithubFolder } from "./skill-fetch";
import {
  addRemoved,
  bundleFromEntries,
  bundleFromText,
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
  sharedSkillFiles,
  ShareFormatError,
  sharedFromAssistant,
  shareSeed,
  shareSlug,
  ASSISTANT_FILE,
  type KnownTerm,
  type Removed,
  type SharedBundle,
  type ShareEdits,
  type ShareExport,
  type ImportPreview,
  type SharedSkill,
} from "./team-share";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

// ---------- what counts as the owner's own ----------

/** First names worth checking alone: a name of two or more words gives its first word. */
const firstName = (name: string) => {
  const words = oneLine(name).split(" ");
  return words.length > 1 && words[0].length >= 3 && !/^(dr|mr|mrs|ms|miss|prof)\.?$/i.test(words[0]) ? words[0] : null;
};

/**
 * Everything in this Athena a shared file shouldn't name: people (whole
 * names, first names as names, nicknames, email addresses, phone numbers),
 * places and their first address line, organisations, projects, the owner's
 * own name, home town and employer, and the accounts they've connected.
 * Opened here, compared in memory, never kept or sent.
 */
export async function knownTerms(): Promise<KnownTerm[]> {
  const out: KnownTerm[] = [];
  const push = (term: unknown, kind: KnownTerm["kind"], loose = false) => {
    if (typeof term === "string" && term.trim()) out.push({ term: term.trim(), kind, ...(loose ? { loose } : {}) });
  };
  const [people, ids, places, orgs, projects, facts, connectors] = await Promise.all([
    q<{ name: string | null; email: string | null; phone: string | null }>(`SELECT name, email, phone FROM people LIMIT 5000`),
    q<{ kind: string; value: string }>(`SELECT kind, value FROM identities WHERE kind IN ('email', 'phone', 'alias', 'slack') LIMIT 10000`),
    q<{ name: string | null; address: string | null }>(`SELECT name, address FROM places LIMIT 5000`),
    q<{ name: string | null }>(`SELECT name FROM organisations LIMIT 5000`),
    q<{ name: string | null }>(`SELECT name FROM projects LIMIT 5000`),
    listFacts({ subjectKind: "me" }).catch(() => []),
    listConnectors().catch(() => []),
  ]);
  for (const p of people) {
    push(p.name, "person");
    push(firstName(p.name ?? ""), "person", true);
    push(p.email, "email");
    push(p.phone, "phone");
  }
  for (const i of ids) {
    if (i.kind === "email") push(i.value, "email");
    else if (i.kind === "phone") push(i.value, "phone");
    // Nicknames and Slack handles are kept lowercased: one word counts only as a name.
    else push(i.value, "person", !/\s/.test(i.value.trim()));
  }
  for (const p of places) {
    push(p.name, "place");
    const line = (p.address ?? "").split(/[,\n]/)[0]?.trim();
    if (line && /\d/.test(line) && /\p{L}{3,}/u.test(line)) push(line, "address");
  }
  for (const o of orgs) push(o.name, "organisation");
  for (const p of projects) push(p.name, "project");
  for (const f of facts) {
    const key = f.key.trim().toLowerCase();
    if (f.superseded_at || f.archived_at) continue;
    if (key === "name") push(f.value, "you", true);
    else if (key === "home town" || key === "employer") push(f.value, "you");
  }
  for (const c of connectors) {
    const label = c.account_label?.trim() ?? "";
    if (label.includes("@")) push(label, "email");
    else push(label, "account");
  }
  return out;
}

// ---------- sharing one ----------

function readEdits(raw: unknown): ShareEdits {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const asks = Array.isArray(r.asks)
    ? r.asks
        .slice(0, MAX_QUESTIONS)
        .map((a) => ({
          question: oneLine(String((a as { question?: unknown })?.question ?? "")).slice(0, MAX_QUESTION),
          choices: (Array.isArray((a as { choices?: unknown })?.choices) ? ((a as { choices: unknown[] }).choices) : []).filter((c): c is string => typeof c === "string").map(oneLine).filter(Boolean).slice(0, MAX_CHOICES).map((c) => c.slice(0, MAX_CHOICE)),
        }))
        .filter((a) => a.question)
    : undefined;
  return {
    name: str(r.name, MAX_NAME * 2),
    job: str(r.job, MAX_JOB * 2),
    instructions: str(r.instructions, MAX_INSTRUCTIONS),
    summary: str(r.summary, MAX_SUMMARY),
    skill: str(r.skill, SKILL_LIMITS.body),
    greeting: str(r.greeting, MAX_GREETING),
    asks,
    version: str(r.version, 20),
    author: str(r.author, 40),
    no_avatar: r.no_avatar === true ? true : undefined,
  };
}

/**
 * The hosts that are this Athena: the address the request came to, and the
 * site's own (Netlify's URL and DEPLOY_URL). Links to them are taken out.
 */
export function ownHosts(requestOrigin: string, env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const raw of [requestOrigin, env.URL, env.DEPLOY_URL, env.DEPLOY_PRIME_URL]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
      if (host && host !== "localhost" && host !== "127.0.0.1") out.add(host);
    } catch {
      // not an address
    }
  }
  return [...out];
}

/**
 * The assistant as a file to share, ready to look over: edits applied, links into
 * this Athena taken out, and the check run. `fine`: finding ids the owner
 * said are fine to share. Throws AthenaInputError (404) when it's gone.
 */
export async function exportAssistant(id: string, body: Record<string, unknown>, hosts: string[], deps: { known?: KnownTerm[] } = {}): Promise<ShareExport> {
  const a = await getAssistant(id);
  if (!a) throw new AthenaInputError("That assistant isn't there any more", 404);
  const s = await assistantSkill(a.id);
  const edits = readEdits(body.edits);
  const fine = Array.isArray(body.fine) ? body.fine.filter((f): f is string => typeof f === "string").slice(0, 200) : [];
  let removed: Removed[] = [];
  const scrub = (text: string) => {
    const r = scrubText(text, hosts);
    removed = addRemoved(removed, r.removed);
    return r.text;
  };
  let w;
  try {
    w = sharedFromAssistant(a, { summary: s?.team?.summary, answers: s?.team?.answers, edits });
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  w = { ...w, job: scrub(w.job), instructions: scrub(w.instructions), summary: scrub(w.summary), asks: w.asks.map((x) => ({ question: scrub(x.question), choices: x.choices.map(scrub) })) };
  const skillBody = edits.skill ?? s?.body ?? "";
  const skill: SharedSkill | null = skillBody.trim() ? { body: scrub(skillBody), files: (s?.files ?? []).map((f) => ({ path: f.path, text: scrub(f.text) })), skipped: [] } : null;
  const known = deps.known ?? (await knownTerms());
  const findings = findPersonal(checkFields(w, skill), known, fine);
  return { shared: w, skill, findings, removed, slug: shareSlug(w.name, w.job) };
}

/** The download: <slug>/assistant.json, <slug>/SKILL.md and its files, in a zip. */
export function shareZip(x: ShareExport): Uint8Array {
  const files = [{ path: `${x.slug}/${ASSISTANT_FILE}`, text: serialiseShared(x.shared) }];
  if (x.skill) {
    const description = `${x.shared.name || "This assistant"}'s skill: how it does its job (${x.shared.job.replace(/[.!]+$/, "")}).`.slice(0, SKILL_LIMITS.description);
    files.push({ path: `${x.slug}/SKILL.md`, text: serialiseSkillMd({ name: x.slug.slice(0, SKILL_LIMITS.name), description, body: x.skill.body, extra: "" }) });
    for (const f of x.skill.files) files.push({ path: `${x.slug}/${f.path}`, text: f.text });
  }
  return writeSkillZip(files);
}

// ---------- adding one ----------

const asShareError = (error: unknown): never => {
  if (error instanceof SkillFormatError) throw new ShareFormatError(error.message.replace("for a skill", "for an assistant").replace("A skill is mostly text", "A shared assistant is mostly text"));
  throw error;
};

const bytesOf = (b64: unknown): Uint8Array => {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new ShareFormatError("That file didn't arrive whole. Try again.");
  return new Uint8Array(Buffer.from(b64, "base64"));
};

/** A shared from what the app sent: a zip, a folder's files, an assistant.json, or a GitHub link. Throws ShareFormatError. */
export async function bundleFrom(body: Record<string, unknown>, now = new Date()): Promise<SharedBundle> {
  const at = now.toISOString();
  const file = typeof body.file === "string" ? body.file.slice(0, 200) : undefined;
  const upload: SkillSource = { kind: "upload", ...(file ? { file } : {}), at };
  try {
    if (typeof body.url === "string") {
      const url = body.url.trim().slice(0, 2048);
      const link = parseShareLink(url);
      return bundleFromEntries(await fetchGithubFolder(link), { kind: "link", url, at });
    }
    if (body.zip !== undefined) return bundleFromEntries(readSkillZip(bytesOf(body.zip)), upload);
    if (Array.isArray(body.entries)) {
      if (body.entries.length > 500) throw new ShareFormatError("That folder has too many files for an assistant.");
      const entries: IntakeEntry[] = body.entries.map((e) => ({ path: String((e as { path?: unknown })?.path ?? ""), bytes: bytesOf((e as { data?: unknown })?.data ?? "") }));
      return bundleFromEntries(entries, upload);
    }
    if (typeof body.assistant_json === "string") return bundleFromText(body.assistant_json.slice(0, 200_000), upload, typeof body.skill_md === "string" ? body.skill_md.slice(0, SKILL_LIMITS.body + 5_000) : undefined);
  } catch (error) {
    return asShareError(error);
  }
  throw new ShareFormatError("Send a shared assistant's zip, its folder, its assistant.json or a GitHub link.");
}

/** Everything an import would add, with the accounts it needs and whether they're connected. Nothing is kept. */
export async function previewImport(body: Record<string, unknown>, now = new Date()): Promise<ImportPreview> {
  const bundle = await bundleFrom(body, now);
  const [connectors, team] = await Promise.all([listConnectors().catch(() => []), listAssistants()]);
  const have = new Set(connectors.filter((c) => c.status !== "error").map((c) => c.provider));
  const texts = [bundle.shared.instructions, bundle.shared.summary, bundle.skill?.body ?? "", ...(bundle.skill?.files.map((f) => f.text) ?? [])];
  return { ...bundle, needs: bundle.shared.needs.map((id) => ({ id, connected: have.has(id) })), links: linkedHosts(texts), room: team.length < MAX_ASSISTANTS };
}

function sourceOf(raw: unknown, now: Date): SkillSource {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const at = now.toISOString();
  if (r.kind === "link" && typeof r.url === "string") {
    try {
      parseShareLink(r.url);
      return { kind: "link", url: r.url.slice(0, 2048), at };
    } catch {
      // not a GitHub link: kept as an upload
    }
  }
  return { kind: "upload", ...(typeof r.file === "string" ? { file: r.file.slice(0, 200) } : {}), at };
}

/**
 * Import one: the assistant (paused, its triggers as paused flows, only the ticked tools
 * it asked for), then its skill with the owner's answers, or, with no skill,
 * one Athena writes from the job and the answers. Returns the assistant; the
 * second value is the skill still being written, when there is one.
 */
export async function importAssistant(body: Record<string, unknown>, now = new Date()): Promise<{ assistant: TeamAssistant; writing: Promise<unknown> | null }> {
  let w;
  try {
    w = readShared(body.shared);
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  const answers = fitAnswers(body.answers);
  const rawSkill = body.skill && typeof body.skill === "object" ? (body.skill as Record<string, unknown>) : null;
  const skillBody = typeof rawSkill?.body === "string" ? rawSkill.body.replace(/\r\n?/g, "\n").trim().slice(0, SKILL_LIMITS.body) : "";
  let files;
  try {
    files = rawSkill ? sharedSkillFiles(rawSkill.files) : [];
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  const asFlows = await triggersMoved();
  const a = await createAssistant({
    ...(w.name ? { name: w.name } : {}),
    job: w.job,
    instructions: w.instructions,
    ...(w.personality ? { personality: w.personality } : {}),
    // No looks of its own: the character its preview showed.
    avatar: w.avatar ?? avatarFromSeed(shareSeed(w)),
    allow: grantedTools(w, body.allow),
    web: body.web === true && w.web,
    paused: true,
    // Once triggers are flows (lib/team-flows.ts), each becomes a paused flow of its own, marked as imported: turning
    // the assistant on turns on the ones that have never run (lib/team.ts updateAssistant).
    triggers: triggerInputs(w).map((t) => (asFlows ? { ...t, paused: true } : t)),
  }, { origin: "shared" });
  const source = sourceOf(body.source, now);
  const fitted = skillBody ? fitTeamSkill({ body: withAnswers(skillBody, answers).slice(0, SKILL_LIMITS.body), summary: w.summary }, a) : null;
  if (!fitted) return { assistant: a, writing: attachSkill(a.id, answers) };
  await putAssistantSkill(a.id, fitted, { basis: skillBasis(a), made: hashText(fitted.body.trim()), summary: fitted.summary, answers }, { files, source });
  return { assistant: a, writing: null };
}
