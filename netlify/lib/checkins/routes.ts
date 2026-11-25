/**
 * Check-ins over REST (lib/checkins.ts; the contract is lib/checkin-types.ts). Behind the bearer
 * token (the caller checks). Input problems are AthenaInputError and a missing key DataKeyMissing,
 * both answered by api.ts's catch.
 *
 *  - GET /api/checkins/settings → CheckinSettingsView. PUT (CheckinSettings) → CheckinSettingsView.
 *  - PUT /api/checkins/sets/:id ({ paused }) → CheckinSettingsView. DELETE → CheckinSettingsView (its questions go too).
 *  - POST /api/checkins/share ({ question_ids, edits?, fine?, download? }) → CheckinExport; with download the zip,
 *    or 409 with what's still flagged (lib/checkin-sets.ts).
 *  - GET /api/checkins?from&to → CheckinSummary[] (at most 400 days).
 *  - GET /api/checkins/trends?from&to → CheckinTrends (scale answers and picks, at most 731 days).
 *  - GET /api/checkins/:date/:kind → Checkin (plans today or tomorrow the first time it's read; a past day nobody opened stays empty).
 *  - PUT /api/checkins/:date/:kind/answers/:question_id (CheckinValue) → Checkin. DELETE → Checkin.
 *  - POST /api/checkins/:date/:kind/done → Checkin.
 *  - POST /api/checkins/:date/:kind/deeper (DeeperRequest) → DeeperReply.
 */
import { answerCheckin, checkinTrends, clearAnswer, deeperFor, finishCheckin, getCheckin, listCheckins, loadSettingsView, readKind, saveCheckinSettings } from "../../../lib/checkins";
import { AthenaInputError } from "../../../lib/db";

type Json = (data: unknown, status?: number) => Response;

async function body(req: Request): Promise<unknown> {
  const b = (await req.json().catch(() => undefined)) as unknown;
  if (b === undefined) throw new AthenaInputError("Send JSON");
  return b;
}

export async function handleCheckinRoutes(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  // segments: ["api", "checkins", "settings" | date?, kind?, "answers" | "done" | "deeper"?, question_id?]
  const [, , date, kindRaw, part, questionId] = segments;
  if (!date) {
    if (req.method !== "GET") return null;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return json({ error: "from and to: YYYY-MM-DD" }, 400);
    return json(await listCheckins(from, to));
  }
  if (date === "trends" && segments.length === 3) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return json({ error: "from and to: YYYY-MM-DD" }, 400);
    return json(await checkinTrends(from, to));
  }
  if (date === "settings" && segments.length === 3) {
    if (req.method === "GET") return json(await loadSettingsView());
    if (req.method === "PUT") return json(await saveCheckinSettings(await body(req)));
    return json({ error: "Method not allowed" }, 405);
  }
  if (date === "sets" && kindRaw && segments.length === 4) {
    const { removeCheckinSet, setCheckinSetPaused } = await import("../../../lib/checkin-sets");
    if (req.method === "DELETE") return json(await removeCheckinSet(kindRaw));
    if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    const b = (await body(req)) as { paused?: unknown } | null;
    if (typeof b?.paused !== "boolean") throw new AthenaInputError("Send { paused: true or false }");
    return json(await setCheckinSetPaused(kindRaw, b.paused));
  }
  if (date === "share" && segments.length === 3) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const b = ((await body(req)) ?? {}) as Record<string, unknown>;
    const [{ exportCheckinsFor, checkinZip }, { ownHosts }] = await Promise.all([import("../../../lib/checkin-sets"), import("../../../lib/team-share-store")]);
    const made = await exportCheckinsFor(b, { hosts: ownHosts(new URL(req.url).origin) });
    if (b.download !== true) return json(made);
    if (made.findings.length) return json({ error: "Check what's flagged first: edit it out, or say it's fine to share.", findings: made.findings }, 409);
    return new Response(Buffer.from(checkinZip(made)), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${made.slug}.zip"`, "Cache-Control": "no-store" } });
  }
  if (!kindRaw) return null;
  const kind = readKind(kindRaw);
  if (segments.length === 4) {
    if (req.method === "GET") return json(await getCheckin(date, kind));
    return json({ error: "Method not allowed" }, 405);
  }
  if (part === "answers" && questionId && segments.length === 6) {
    if (req.method === "PUT") return json(await answerCheckin(date, kind, questionId, await body(req)));
    if (req.method === "DELETE") return json(await clearAnswer(date, kind, questionId));
    return json({ error: "Method not allowed" }, 405);
  }
  if ((part === "done" || part === "deeper") && segments.length === 5) {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (part === "done") return json(await finishCheckin(date, kind));
    return json(await deeperFor(date, kind, await body(req)));
  }
  return null;
}
