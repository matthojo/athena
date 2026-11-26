/**
 * Team (lib/team.ts):
 *
 *   GET    /api/team                → { assistants, max }
 *   POST   /api/team                TeamAssistantInput (+ answers?) → the assistant (201); its skill is written after (lib/team-skill-make.ts)
 *   GET    /api/team/<id>           → the assistant
 *   PATCH  /api/team/<id>           TeamAssistantInput → the assistant (`models`: the whole set, checked like /api/models; 409 consent_needed)
 *   DELETE /api/team/<id>           → { ok }
 *   POST   /api/team/draft          { text } → { draft }               (lib/team-draft.ts; `fallback` when the model couldn't help)
 *   POST   /api/team/questions      { text, draft? } → { questions }   (2–4, or none with `fallback`)
 *   GET    /api/team/<id>/skill     → TeamSkillInfo: its own skill, `stale`, `edited`
 *   POST   /api/team/<id>/skill     { answers? } → TeamSkillInfo: write it now; { preview: true } → { preview }; { keep: true } → TeamSkillInfo
 *   PUT    /api/team/<id>/skill     { body, summary? } → TeamSkillInfo: the owner accepted an update
 *   GET    /api/team/activity?limit=<n> → { runs }: the whole team's runs, newest first (30 by default, 100 at most)
 *   GET    /api/team/<id>/runs      → { runs }, newest first
 *   POST   /api/team/<id>/run       → { run } (202): queued and handed to the background function (lib/team-run.ts)
 *   DELETE /api/team/<id>/memory?fact=<index> → { memory }; no fact: forget all (lib/team-memory.ts)
 *   POST   /api/team/<id>/keep      → { assistant }: a guest becomes a standing assistant; 409 { error } when the team is full
 *   POST   /api/team/<id>/export    { edits?, fine?, download? } → ShareExport (lib/team-share-store.ts); with download and
 *                                   nothing left to check, the zip; with something left, 409 { error, findings }
 *   /api/team/assignments…          → netlify/lib/assignment-routes.ts
 *
 * Behind the same bearer token as the rest of the API.
 */
import { MAX_ASSISTANTS, type TeamDraftResponse, type TeamQuestionsResponse, type TeamSkillPreviewResponse, type TeamActivityResponse, type TeamListResponse, type TeamMemoryResponse, type TeamRunResponse, type TeamRunsResponse } from "../../lib/team-types";
import { createAssistant, deleteAssistant, getAssistant, listAssistants, updateAssistant } from "../../lib/team";
import { draftAssistant, MAX_DRAFT_TEXT } from "../../lib/team-draft";
import { forgetMemory } from "../../lib/team-memory";
import { acceptSkillUpdate, askQuestions, attachSkill, keepSkill, MAX_QUESTIONS_TEXT, previewSkillUpdate, skillInfo } from "../../lib/team-skill-make";
import { fitAnswers, skillGist } from "../../lib/team-skill";
import { modelChoiceResponse } from "./models-routes";
import { handleAssignmentRoutes, handleKeep } from "./assignment-routes";
import { enqueueTeamRun, finishTeamRun, getTeamRun, handOffTeamRun, listTeamActivity, listTeamRuns } from "../../lib/team-run";
import { exportAssistant, ownHosts, shareZip } from "../../lib/team-share-store";
import { ShareFormatError } from "../../lib/team-share";
import { AthenaInputError } from "../../lib/db";
import { SKILL_LIMITS } from "../../lib/skills";
import { textUpTo } from "./body-limit";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_YET = "Not ready yet";
/** A shared assistant's zip or folder (2 MB, as base64) and the JSON around it. */
const MAX_IMPORT_BODY = Math.ceil((SKILL_LIMITS.uploadBytes * 4) / 3) + 64_000;

export async function handleTeamRoutes(req: Request, url: URL, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json, waitUntil?: (p: Promise<unknown>) => void): Promise<Response | null> {
  try {
    return await teamRoutes(req, url, segments, body, json, waitUntil);
  } catch (error) {
    // An assistant's own model the owner hasn't agreed to, or one that can't do the job (lib/models.ts).
    const r = modelChoiceResponse(error, json);
    if (r) return r;
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

async function teamRoutes(req: Request, url: URL, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json, waitUntil?: (p: Promise<unknown>) => void): Promise<Response | null> {
  const [, second, third] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);
  // Assignments: lineups of guests and standing assistants.
  if (second === "assignments") return handleAssignmentRoutes(req, segments, body, json);
  if (segments.length > 3) return null;

  if (!second) {
    if (method === "GET") return json({ assistants: await listAssistants(), max: MAX_ASSISTANTS } satisfies TeamListResponse);
    if (method === "POST") {
      const { answers, ...input } = (await body()) ?? {};
      const made = await createAssistant(input);
      // Its own skill is written after the response: the assistant works without it, and it attaches when ready.
      const writing = attachSkill(made.id, fitAnswers(answers));
      if (waitUntil) waitUntil(writing);
      return json(made, 201);
    }
    return nope();
  }

  if (second === "draft" && !third) {
    if (method !== "POST") return nope();
    const raw = ((await body()) ?? {}).text;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return json({ error: "text: what should it do?" }, 400);
    if (text.length > MAX_DRAFT_TEXT) return json({ error: `text: keep it under ${MAX_DRAFT_TEXT.toLocaleString("en-GB")} characters` }, 400);
    return json((await draftAssistant(text)) satisfies TeamDraftResponse);
  }

  if (second === "questions" && !third) {
    if (method !== "POST") return nope();
    const b = (await body()) ?? {};
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) return json({ error: "text: what should it do?" }, 400);
    if (text.length > MAX_QUESTIONS_TEXT) return json({ error: `text: keep it under ${MAX_QUESTIONS_TEXT.toLocaleString("en-GB")} characters` }, 400);
    const d = b.draft && typeof b.draft === "object" ? (b.draft as Record<string, unknown>) : null;
    const draft = d ? { job: typeof d.job === "string" ? d.job : undefined, instructions: typeof d.instructions === "string" ? d.instructions : undefined } : null;
    return json((await askQuestions(text, draft)) satisfies TeamQuestionsResponse);
  }

  if (second === "activity" && !third) {
    if (method !== "GET") return nope();
    return json({ runs: await listTeamActivity(Number(url.searchParams.get("limit")) || undefined) } satisfies TeamActivityResponse);
  }

  if (!UUID.test(second)) return json({ error: "Not found" }, 404);

  if (!third) {
    if (method === "GET") {
      const a = await getAssistant(second);
      return a ? json(a) : json({ error: "Not found" }, 404);
    }
    if (method === "PATCH") return json(await updateAssistant(second, (await body()) ?? {}));
    if (method === "DELETE") return (await deleteAssistant(second)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return nope();
  }

  const found = await getAssistant(second);
  if (!found) return json({ error: "Not found" }, 404);
  if (third === "skill") {
    if (method === "GET") return json(await skillInfo(found));
    if (method === "POST") {
      const b = (await body()) ?? {};
      if (b.preview === true) {
        const p = await previewSkillUpdate(found);
        return json({ preview: { name: p.name, description: p.description, body: p.body, summary: p.summary, gist: skillGist(p.body) } } satisfies TeamSkillPreviewResponse);
      }
      if (b.keep === true) {
        await keepSkill(found);
        return json(await skillInfo(found));
      }
      if (!(await attachSkill(found.id, fitAnswers(b.answers)))) return json({ error: "Athena couldn't write the skill just now. Try again." }, 503);
      return json(await skillInfo(found));
    }
    if (method === "PUT") {
      const b = (await body()) ?? {};
      await acceptSkillUpdate(found, b, b.answers === undefined ? undefined : fitAnswers(b.answers));
      return json(await skillInfo(found));
    }
    return nope();
  }
  if (third === "runs") {
    if (method !== "GET") return nope();
    return json({ runs: await listTeamRuns(second) } satisfies TeamRunsResponse);
  }
  if (third === "run") {
    if (method !== "POST") return nope();
    const queued = await enqueueTeamRun(second);
    try {
      await handOffTeamRun(url.origin, queued.id);
    } catch (error) {
      console.error("Athena team: couldn't start a run", (error as Error).message?.slice(0, 120));
      await finishTeamRun(queued.id, { status: "failed", error: "It couldn't start. Try again in a minute." });
      return json({ run: (await getTeamRun(queued.id))!, error: "It couldn't start. Try again in a minute." }, 503);
    }
    return json({ run: queued } satisfies TeamRunResponse, 202);
  }
  if (third === "export") {
    if (method !== "POST") return nope();
    const b = (await body()) ?? {};
    const made = await exportAssistant(found.id, b, ownHosts(url.origin));
    if (b.download !== true) return json(made);
    if (made.findings.length) return json({ error: "Check what's flagged first: edit it out, or say it's fine to share.", findings: made.findings }, 409);
    return new Response(Buffer.from(shareZip(made)), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${made.slug}.zip"`, "Cache-Control": "no-store" } });
  }
  if (third === "keep") {
    if (method !== "POST") return nope();
    return handleKeep(second, json);
  }
  if (third === "memory") {
    if (method !== "DELETE") return nope();
    const fact = url.searchParams.get("fact");
    if (fact !== null && !/^\d{1,3}$/.test(fact)) return json({ error: "fact: give the fact's number, from 0" }, 400);
    return json({ memory: await forgetMemory(second, fact === null ? null : Number(fact)) } satisfies TeamMemoryResponse);
  }
  return null;
}
