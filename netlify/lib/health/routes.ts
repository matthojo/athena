/**
 * Health over REST (lib/health.ts has the rules):
 *
 *  - POST /api/health/day: the iPhone Shortcut sends a day from Apple Health.
 *    A capture key opens it (the same key Siri capture uses), as does a full
 *    key or the app's token. JSON (or a form) with the athena_health_day
 *    fields; date defaults to yesterday and source to apple_health. Safe to
 *    send again: the same day and source is merged, never doubled. Sleep may
 *    come as stages (sleep_stages, lib/sleep-stages.ts). The answer names
 *    the day and carries no figures; `skipped` says what wasn't saved and why.
 *  - GET /api/health/series?field=steps&from=&to=: one value per day for a
 *    chart, opened here for the owner. Full access only.
 *  - GET /api/health/days?from=&to=: each day's merged figures, for the
 *    Library's Health page. Full access only.
 *  - GET /api/health/sources: which source each figure comes from, and the
 *    sources Athena can read. PUT the same shape to change it; recent Life
 *    log lines are rewritten. Full access only.
 *  - GET /api/health/manual?date=: what the owner typed in for a day (the
 *    Health page's "Log by hand"), or null. PUT the day's fields (as POST
 *    /api/health/day takes them) to replace them whole; DELETE ?date= to
 *    take them out. They win over every app for the figures they have.
 *    Full access only.
 *  - GET /api/health/status: the latest day each source sent and whether
 *    there's a Life log, for Settings → From your iPhone. No figures.
 *
 * Nothing here logs a figure.
 */
import { getOwnerTimeZone, qRaw } from "../../../lib/db";
import { DataBoxError } from "../../../lib/data-box";
import { addDays, isValidDate, zonedToday } from "../../../lib/dates";
import { dayTitle } from "../../../lib/youtube-takeout";
import { clearManualHealthDay, MANUAL_HEALTH, readSourceDay, replaceManualHealthDay, CAN_SEND, connectedSources, healthDays, healthSeries, HealthInputError, loadHealthPrefs, readHealthDayNoting, saveHealthDay, saveHealthPrefs, SERIES, type SeriesField } from "../../../lib/health";

type Json = (data: unknown, status?: number) => Response;

/** A form body from Shortcuts, as plain fields (workouts can't be sent this way). */
async function bodyOf(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > 20_000) throw new HealthInputError("That's too much for one day");
  if (/application\/x-www-form-urlencoded|multipart\/form-data/i.test(type)) {
    if (/multipart/i.test(type)) throw new HealthInputError("Send JSON: in Get Contents of URL, set Request Body to JSON");
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HealthInputError("Send JSON: in Get Contents of URL, set Request Body to JSON");
  }
}

/** POST /api/health/day. The caller has checked the key. */
export async function handleHealthDay(req: Request, json: Json): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const tz = await getOwnerTimeZone();
    const today = zonedToday(new Date(), tz);
    const { day, skipped } = readHealthDayNoting(await bodyOf(req), { today, source: "apple_health" });
    const saved = await saveHealthDay(day, { tz });
    // What Shortcuts shows when it runs: the day, never its figures.
    return json({ ...saved, ...(skipped.length ? { skipped } : {}), message: [`Saved health for ${dayTitle(day.date, today)}.`, ...skipped].join(" ") });
  } catch (error) {
    if (error instanceof HealthInputError) return json({ error: error.message }, 400);
    if (error instanceof DataBoxError) return json({ error: "Athena can't save health figures right now: its encryption key isn't set here." }, error.status);
    throw error;
  }
}

/** GET /api/health/series. Full access only (the caller checks). */
export async function handleHealthSeries(req: Request, url: URL, json: Json): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const field = url.searchParams.get("field") ?? "";
  if (!(SERIES as readonly string[]).includes(field)) return json({ error: `field: one of ${SERIES.join(", ")}` }, 400);
  const today = zonedToday(new Date(), await getOwnerTimeZone());
  const to = url.searchParams.get("to") || today;
  const from = url.searchParams.get("from") || addDays(to, -29);
  if (!isValidDate(from) || !isValidDate(to) || from > to) return json({ error: "from and to: YYYY-MM-DD, from first" }, 400);
  if (from < addDays(to, -800)) return json({ error: "At most 800 days at a time" }, 400);
  try {
    const { points, unreadable } = await healthSeries(field as SeriesField, from, to);
    return json({ field, from, to, points, ...(unreadable ? { unreadable } : {}) });
  } catch (error) {
    if (error instanceof DataBoxError) return json({ error: error.message }, error.status);
    throw error;
  }
}

/** GET /api/health/status. Full access only (the caller checks). Days and names, never figures. */
export async function handleHealthStatus(req: Request, json: Json): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const today = zonedToday(new Date(), await getOwnerTimeZone());
  const sources = await qRaw<{ source: string; last_day: string }>(
    `SELECT source, to_char(max(day), 'YYYY-MM-DD') AS last_day FROM sensitive_blobs WHERE domain = 'health' AND day IS NOT NULL GROUP BY source ORDER BY source`,
  );
  const [life] = await qRaw<{ id: string; name: string }>(`SELECT id, name FROM collections WHERE recipe = 'life-log' ORDER BY created_at LIMIT 1`);
  return json({ today, sources, life_log: life ?? null });
}

/** GET /api/health/days. Full access only (the caller checks). */
export async function handleHealthDays(req: Request, url: URL, json: Json): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const today = zonedToday(new Date(), await getOwnerTimeZone());
  const to = url.searchParams.get("to") || today;
  const from = url.searchParams.get("from") || addDays(to, -182);
  if (!isValidDate(from) || !isValidDate(to) || from > to) return json({ error: "from and to: YYYY-MM-DD, from first" }, 400);
  if (from < addDays(to, -800)) return json({ error: "At most 800 days at a time" }, 400);
  try {
    const { days, prefs, unreadable } = await healthDays(from, to);
    return json({ from, to, today, days, prefs, ...(unreadable ? { unreadable } : {}) });
  } catch (error) {
    if (error instanceof DataBoxError) return json({ error: error.message }, error.status);
    throw error;
  }
}

/** GET or PUT /api/health/sources. Full access only (the caller checks). */
export async function handleHealthSources(req: Request, json: Json): Promise<Response> {
  if (req.method === "PUT") {
    try {
      const prefs = await saveHealthPrefs(await req.json().catch(() => null));
      return json({ prefs, connected: await connectedSources(), can_send: CAN_SEND });
    } catch (error) {
      if (error instanceof HealthInputError) return json({ error: error.message }, 400);
      throw error;
    }
  }
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const [prefs, connected] = await Promise.all([loadHealthPrefs(), connectedSources()]);
  return json({ prefs, connected, can_send: CAN_SEND });
}

/** GET, PUT or DELETE /api/health/manual. Full access only (the caller checks). */
export async function handleHealthManual(req: Request, url: URL, json: Json): Promise<Response> {
  try {
    const tz = await getOwnerTimeZone();
    const today = zonedToday(new Date(), tz);
    if (req.method === "PUT") {
      const raw = await bodyOf(req);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HealthInputError("Send the day's figures as JSON");
      const { day, skipped } = readHealthDayNoting({ ...(raw as Record<string, unknown>), source: MANUAL_HEALTH }, { today, source: MANUAL_HEALTH });
      const saved = await replaceManualHealthDay(day, { tz });
      return json({ ...saved, ...(skipped.length ? { skipped } : {}) });
    }
    const date = url.searchParams.get("date") ?? "";
    if (!isValidDate(date)) return json({ error: "date: YYYY-MM-DD" }, 400);
    if (req.method === "GET") return json({ date, figures: await readSourceDay(date, MANUAL_HEALTH) });
    if (req.method === "DELETE") return (await clearManualHealthDay(date, { tz })) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof HealthInputError) return json({ error: error.message }, 400);
    if (error instanceof DataBoxError) return json({ error: "Athena can't save health figures right now: its encryption key isn't set here." }, error.status);
    throw error;
  }
}
