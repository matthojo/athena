/**
 * Check-ins over REST (lib/checkins.ts; the contract is lib/checkin-types.ts). Behind the bearer
 * token (the caller checks). Input problems are AthenaInputError and a missing key DataKeyMissing,
 * both answered by api.ts's catch.
 *
 *  - GET /api/checkins/settings → CheckinSettingsView. PUT (CheckinSettings) → CheckinSettingsView.
 *  - GET /api/checkins?from&to → CheckinSummary[] (at most 400 days).
 *  - GET /api/checkins/trends?from&to → CheckinTrends (scale answers and picks, at most 731 days).
 *  - GET /api/checkins/:date/:kind → Checkin (plans today or tomorrow the first time it's read; a past day nobody opened stays empty).
 *  - PUT /api/checkins/:date/:kind/answers/:question_id (CheckinValue) → Checkin. DELETE → Checkin.
 *  - POST /api/checkins/:date/:kind/done → Checkin.
 *  - POST /api/checkins/:date/:kind/deeper (DeeperRequest) → DeeperReply.
 */
import { answerCheckin, checkinTrends, clearAnswer, deeperFor, finishCheckin, getCheckin, listCheckins, loadCheckinSettings, readKind, saveCheckinSettings, settingsView } from "../../../lib/checkins";
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
    if (req.method === "GET") return json(settingsView(await loadCheckinSettings()));
    if (req.method === "PUT") return json(await saveCheckinSettings(await body(req)));
    return json({ error: "Method not allowed" }, 405);
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
