/**
 * Assignments (docs/team.md, "Routes and client"; lib/assignment-run.ts):
 *
 *   POST   /api/team/assignments/lineup        { text } → { lineup, fallback? }   (nothing is kept)
 *   POST   /api/team/assignments               the accepted Lineup (+ id?: a draft it replaces) → the assignment (201); starts it
 *   GET    /api/team/assignments               → { assignments, max }
 *   GET    /api/team/assignments/<id>          → the assignment
 *   DELETE /api/team/assignments/<id>          → { ok }
 *   PATCH  /api/team/assignments/<id>          { checkpoint?, suggestions? } → the assignment
 *   PATCH  /api/team/assignments/<id>/stages/<n>  { checkpoint } → the assignment (a stage that hasn't run)
 *   POST   /api/team/assignments/<id>/go       → the assignment: Go on a draft's lineup, on a stage waiting for approval, or again on one that didn't finish
 *   POST   /api/team/assignments/<id>/answer   { answers: [{ id, answer }] } or { use: "suggested", from_here?: true } → the assignment;
 *                                              with { stage: <n>, answers } an answer already given is changed, and the work re-runs from that stage
 *   POST   /api/team/assignments/<id>/send-back { to, note } → the assignment
 *   POST   /api/team/assignments/<id>/stop     → the assignment
 *   POST   /api/team/<assistantId>/keep        → { assistant }, or 409 { error } when the team is full (handled here, called from team-routes.ts)
 *
 * Behind the same bearer token as the rest of the API.
 */
import { ASSIGNMENT_LIMITS, type Assignment, type KeptAssistant, type Lineup } from "../../lib/assignment-types";
import { TeamFullError } from "../../lib/assignments";
import { answerStage, changeAnswers, goAssignment, keepOnTeam, lineupFor, patchAssignment, patchStage, readAssignment, readAssignments, removeAssignment, sendBack, startAssignment, stopAssignment } from "../../lib/assignment-run";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AssignmentListResponse {
  assignments: Assignment[];
  /** Assignments running or waiting at once. */
  max: number;
}
export interface LineupResponse {
  lineup: Lineup;
  fallback?: true;
}

const answersOf = (raw: unknown): Array<{ id: string; answer: string }> | null =>
  Array.isArray(raw) && raw.every((a) => a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string" && typeof (a as { answer?: unknown }).answer === "string") ? (raw as Array<{ id: string; answer: string }>) : null;

/** POST /api/team/<assistantId>/keep: a guest becomes a standing assistant; 409 when the team is full. */
export async function handleKeep(assistantId: string, json: Json): Promise<Response> {
  try {
    return json((await keepOnTeam(assistantId)) satisfies KeptAssistant);
  } catch (error) {
    if (error instanceof TeamFullError) return json({ error: error.message }, 409);
    throw error;
  }
}

/** `segments` from "team" on: ["team", "assignments", …]. Null when the path isn't one of these. */
export async function handleAssignmentRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json): Promise<Response | null> {
  if (segments[1] !== "assignments" || segments.length > 5) return null;
  const [, , id, action, n] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);

  if (!id) {
    if (method === "GET") return json({ assignments: await readAssignments(), max: ASSIGNMENT_LIMITS.running } satisfies AssignmentListResponse);
    if (method === "POST") {
      const b = (await body()) ?? {};
      const draft = typeof b.id === "string" && UUID.test(b.id) ? b.id : null;
      const thread = typeof b.thread_id === "string" && UUID.test(b.thread_id) ? b.thread_id : null;
      return json(await startAssignment(b, { id: draft, threadId: thread }), 201);
    }
    return nope();
  }

  if (id === "lineup" && !action) {
    if (method !== "POST") return nope();
    const raw = ((await body()) ?? {}).text;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return json({ error: "text: what's the assignment?" }, 400);
    if (text.length > ASSIGNMENT_LIMITS.brief) return json({ error: `text: keep it under ${ASSIGNMENT_LIMITS.brief.toLocaleString("en-GB")} characters` }, 400);
    return json((await lineupFor(text)) satisfies LineupResponse);
  }

  if (!UUID.test(id)) return json({ error: "Not found" }, 404);

  if (!action) {
    if (method === "GET") {
      const a = await readAssignment(id);
      return a ? json(a) : json({ error: "Not found" }, 404);
    }
    if (method === "PATCH") return json(await patchAssignment(id, (await body()) ?? {}));
    if (method === "DELETE") return (await removeAssignment(id)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return nope();
  }

  if (action === "stages") {
    if (!n || !/^\d$/.test(n)) return json({ error: "Not found" }, 404);
    if (method !== "PATCH") return nope();
    return json(await patchStage(id, Number(n), (await body()) ?? {}));
  }
  if (n) return null;
  if (method !== "POST") return ["go", "answer", "send-back", "stop"].includes(action) ? nope() : null;
  const found = async () => (await readAssignment(id)) ?? json({ error: "Not found" }, 404);

  if (action === "go") return json(await goAssignment(id));
  if (action === "stop") return json(await stopAssignment(id));
  if (action === "answer") {
    const b = (await body()) ?? {};
    if (b.use === "suggested") await answerStage(id, { use: "suggested", from_here: b.from_here === true });
    else {
      const answers = answersOf(b.answers);
      if (!answers?.length) return json({ error: "answers: each with the question's id and your answer" }, 400);
      if (b.stage !== undefined) {
        if (typeof b.stage !== "number" || !Number.isInteger(b.stage)) return json({ error: "stage: its number" }, 400);
        await changeAnswers(id, b.stage, answers);
      } else await answerStage(id, answers);
    }
    return found().then((a) => (a instanceof Response ? a : json(a)));
  }
  if (action === "send-back") {
    const b = (await body()) ?? {};
    if (typeof b.to !== "number") return json({ error: "to: this stage's number or an earlier one's" }, 400);
    await sendBack(id, b.to, typeof b.note === "string" ? b.note : "");
    return found().then((a) => (a instanceof Response ? a : json(a)));
  }
  return null;
}
