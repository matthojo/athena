/**
 * Settings → Ask → Skills (lib/skills.ts, lib/skills-store.ts):
 *
 *   GET    /api/skills                     → { skills, max }: the starters are added the first time
 *   GET    /api/skills/<id>                → the skill
 *   POST   /api/skills                     { skill_md? | name, description, body, files?, skipped?, source?, enabled? } → the skill, saved
 *   PUT    /api/skills/<id>                { the same, any of them } → the skill
 *   DELETE /api/skills/<id>                → { ok }
 *   POST   /api/skills/preview             { zip } | { entries: [{ path, data }] } | { skill_md, file? } | { url } → what would be saved; nothing is
 *   GET    /api/skills/<id>/download?format=md|zip → SKILL.md, or a zip of it and its files
 *   GET    /api/skills/notice              → { skills: [{ id, name, title }] }: imported skills that lost their accounts (0085), once
 *   DELETE /api/skills/notice              → { ok }: the notice is read and doesn't come back
 *
 * A zip and a folder's files come base64, at most 2 MB of them. A link is
 * fetched once, here, through the guard in lib/skill-fetch.ts. Behind the
 * same bearer token as the rest of the API. "Make this a skill" (a model
 * call) is POST /api/assistant/skill-draft, rate-limited with the rest of Ask.
 */
import { AthenaInputError } from "../../lib/db";
import { textUpTo } from "./body-limit";
import { accountsNotice, createSkill, deleteSkill, dismissAccountsNotice, getSkill, listSkills, updateSkill, type Skill } from "../../lib/skills-store";
import { intakeEntries, serialiseSkillMd, SKILL_LIMITS, SkillFormatError, skillTitle, type IntakeEntry, type SkillPreview } from "../../lib/skills";
import { readSkillZip, writeSkillZip } from "../../lib/skill-zip";
import { fetchSkillFromLink } from "../../lib/skill-fetch";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 2 MB of files, as base64, and the JSON around them. */
const MAX_PREVIEW_BODY = Math.ceil((SKILL_LIMITS.uploadBytes * 4) / 3) + 64_000;

/** A skill as the app shows it: with its title and the SKILL.md a download gives. */
export function skillView(s: Skill) {
  return { ...s, title: skillTitle(s.name), skill_md: serialiseSkillMd(s) };
}

const bytesOf = (b64: unknown): Uint8Array => {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new SkillFormatError("That file didn't arrive whole. Try again.");
  return new Uint8Array(Buffer.from(b64, "base64"));
};

/** What an upload or link would save. Throws SkillFormatError. */
export async function previewFrom(body: Record<string, unknown>, now = new Date()): Promise<SkillPreview> {
  const at = now.toISOString();
  const file = typeof body.file === "string" ? body.file.slice(0, 200) : undefined;
  if (typeof body.url === "string") return fetchSkillFromLink(body.url.slice(0, 2048), now);
  if (body.zip !== undefined) return intakeEntries(readSkillZip(bytesOf(body.zip)), { kind: "upload", ...(file ? { file } : {}), at });
  if (Array.isArray(body.entries)) {
    if (body.entries.length > 500) throw new SkillFormatError("That folder has too many files for a skill.");
    const entries: IntakeEntry[] = body.entries.map((e) => ({ path: String((e as { path?: unknown })?.path ?? ""), bytes: bytesOf((e as { data?: unknown })?.data ?? "") }));
    return intakeEntries(entries, { kind: "upload", ...(file ? { file } : {}), at });
  }
  if (typeof body.skill_md === "string") return intakeEntries([{ path: "SKILL.md", bytes: new TextEncoder().encode(body.skill_md.slice(0, SKILL_LIMITS.body + 5_000)) }], { kind: "upload", ...(file ? { file } : {}), at });
  throw new SkillFormatError("Send a SKILL.md, a zip, a folder's files or a link.");
}

export async function handleSkillRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json): Promise<Response | null> {
  // ["api", "skills", <id or preview>, <download>]
  const [, , second, third] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);
  try {
    if (!second) {
      if (method === "GET") return json({ skills: (await listSkills()).map(skillView), max: SKILL_LIMITS.skills });
      if (method === "POST") return json(skillView(await createSkill((await body()) ?? {})), 201);
      return nope();
    }
    if (second === "notice" && segments.length === 3) {
      if (method === "GET") return json({ skills: (await accountsNotice()).map((s) => ({ ...s, title: skillTitle(s.name) })) });
      if (method === "DELETE") return (await dismissAccountsNotice(), json({ ok: true }));
      return nope();
    }
    if (second === "preview" && segments.length === 3) {
      if (method !== "POST") return nope();
      const text = await textUpTo(req, MAX_PREVIEW_BODY);
      if (text === null) return json({ error: "That's over 2 MB. A skill is mostly text: leave out large files." }, 413);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text || "{}");
      } catch {
        throw new SkillFormatError("That didn't arrive whole. Try again.");
      }
      return json(await previewFrom((parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>));
    }
    if (!UUID.test(second)) return json({ error: "Not found" }, 404);
    if (third === "download" && segments.length === 4) {
      if (method !== "GET") return nope();
      const s = await getSkill(second);
      if (!s) return json({ error: "Not found" }, 404);
      const md = serialiseSkillMd(s);
      const format = new URL(req.url).searchParams.get("format");
      if (format === "zip") {
        const zip = writeSkillZip([{ path: `${s.name}/SKILL.md`, text: md }, ...s.files.map((f) => ({ path: `${s.name}/${f.path}`, text: f.text }))]);
        return new Response(Buffer.from(zip), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${s.name}.zip"` } });
      }
      return new Response(md, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="SKILL.md"` } });
    }
    if (segments.length !== 3) return null;
    if (method === "GET") {
      const s = await getSkill(second);
      return s ? json(skillView(s)) : json({ error: "Not found" }, 404);
    }
    if (method === "PUT") return json(skillView(await updateSkill(second, (await body()) ?? {})));
    if (method === "DELETE") return (await deleteSkill(second)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return nope();
  } catch (error) {
    if (error instanceof SkillFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}
