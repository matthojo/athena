/**
 * Settings → Ask → Skills (lib/skills.ts, lib/skills-store.ts):
 *
 *   GET    /api/skills                     → { skills, max }: the starters are added the first time
 *   GET    /api/skills/<id>                → the skill
 *   POST   /api/skills                     { skill_md? | name, description, body, files?, skipped?, source?, enabled? } → the skill, saved
 *   PUT    /api/skills/<id>                { the same, any of them } → the skill
 *   DELETE /api/skills/<id>                → { ok }
 *   GET    /api/skills/<id>/download?format=md|zip → SKILL.md, or a zip of it and its files
 *   GET    /api/skills/notice              → { skills: [{ id, name, title }] }: imported skills that lost their accounts (0086), once
 *   DELETE /api/skills/notice              → { ok }: the notice is read and doesn't come back
 *
 * A skill someone shared (a file, a zip, a folder or a link) is previewed and
 * added through #/add and /api/community/preview (netlify/lib/community-add-routes.ts). Behind the
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
