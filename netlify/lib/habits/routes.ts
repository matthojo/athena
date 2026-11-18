/**
 * The owner's own habits over REST (lib/own-habits.ts has the rules).
 *
 *  - POST /api/habits/log { habit, count?, date? }: the "Log a habit"
 *    Shortcut. A capture key opens it (the caller checks), as does a full
 *    key or the app's token. The habit is matched by name in any case; the
 *    reply's message is what Siri says. It can't read anything back.
 *  - GET  /api/habits?date=: every habit (archived ones too) and each live
 *    one's count, due-ness and streak on that day (default today). Full access.
 *  - POST /api/habits: make one. PATCH /api/habits/:id: change, archive or
 *    bring back. Full access.
 *  - PUT  /api/habits/:id/days/:date { progress }: set that day's count
 *    (0 clears it, which is how Undo works). Full access.
 */
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { DataBoxError } from "../../../lib/data-box";
import { isValidDate, zonedToday } from "../../../lib/dates";
import { createOwnHabit, listOwnHabits, logHabit, ownHabitsOn, setHabitDay, updateOwnHabit } from "../../../lib/own-habits";

type Json = (data: unknown, status?: number) => Response;
const today = async () => zonedToday(new Date(), await getOwnerTimeZone());

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4_000) throw new AthenaInputError("That's too much for one habit");
  if (/application\/x-www-form-urlencoded/i.test(req.headers.get("content-type") ?? "")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AthenaInputError("Send JSON: in Get Contents of URL, set Request Body to JSON");
  }
}

function fail(error: unknown, json: Json): Response {
  if (error instanceof AthenaInputError) return json({ error: error.message }, 400);
  if (error instanceof DataBoxError) return json({ error: "Athena can't open your habits right now: its encryption key isn't set here." }, 503);
  throw error;
}

/** POST /api/habits/log. The caller has checked the key. */
export async function handleHabitLog(req: Request, json: Json): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    return json(await logHabit(await body(req), await today()));
  } catch (error) {
    return fail(error, json);
  }
}

/** /api/habits, /api/habits/:id, /api/habits/:id/days/:date. Full access (the caller checks). Null for anything else. */
export async function handleHabitRoutes(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  const [, , id, sub, date] = segments;
  try {
    const now = await today();
    if (segments.length === 2) {
      if (req.method === "GET") {
        const day = url.searchParams.get("date") || now;
        if (!isValidDate(day)) return json({ error: "date: YYYY-MM-DD" }, 400);
        const [habits, on] = await Promise.all([listOwnHabits({ includeArchived: true }), day <= now ? ownHabitsOn(day, now) : Promise.resolve([])]);
        return json({ today: now, date: day, habits, on: on.map(({ habit, ...rest }) => ({ id: habit.id, ...rest })) });
      }
      if (req.method === "POST") return json(await createOwnHabit(await body(req), now), 201);
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 3 && id !== "log") {
      if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405);
      const habit = await updateOwnHabit(id, await body(req));
      return habit ? json(habit) : json({ error: "Not found" }, 404);
    }
    if (segments.length === 5 && sub === "days") {
      if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
      const b = (await body(req)) as { progress?: unknown };
      const r = await setHabitDay(id, date, b?.progress, now);
      return r ? json(r) : json({ error: "Not found" }, 404);
    }
    return null;
  } catch (error) {
    return fail(error, json);
  }
}
