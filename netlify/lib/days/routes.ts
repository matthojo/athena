/**
 * Days over REST (lib/days.ts; shapes in lib/day-types.ts). All need full
 * access (the app's token or a full key); a capture key can't read a day.
 *
 *  - GET   /api/days?from=&to=            summaries of the days with anything on them (default: the last five weeks)
 *  - GET   /api/days/search?q=&kind=&from=&to=&source=&place=&person=&limit=  (results, and facets for the filter chips)
 *  - GET   /api/days/firsts?around=       Home's memory: firsts with anniversaries within three days, who and where on the candidate days, and the never-nudge topics (lib/day-firsts.ts)
 *  - GET   /api/days/memories             memories on Home: { on, hidden } (lib/day-prefs.ts)
 *  - PATCH /api/days/memories             { on } | { hide: date } | { show: date }
 *  - GET   /api/days/convert              the dry run: what converting the Life log notes would do
 *  - POST  /api/days/convert              convert a batch (about eight seconds); call again until remaining is 0
 *  - GET   /api/days/:date                one whole day
 *  - PATCH /api/days/:date                the owner's line, mood, journal and photos (DayPatch)
 *  - POST  /api/days/:date/entries        add an entry by hand: { kind (watched, listened, read, played, other), title, subtitle?, note?, url?, rating?, minutes? }
 *  - PATCH /api/days/:date/entries/:id    { hidden: true | false }: hide an entry, or show it again
 *  - DELETE /api/days/:date/entries/:id   delete an entry added by hand (others can only be hidden)
 *
 * Nothing here logs a day's content.
 */
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { DataBoxError } from "../../../lib/data-box";
import { addDays, zonedToday } from "../../../lib/dates";
import { attachDayArt, ART_KINDS } from "../../../lib/art";
import { addManualEntry, removeManualEntry, daysRange, getDay, setEntryArt, hideEntry, isDayEntryKind, patchDay, readDate, searchDaysFaceted, showEntry } from "../../../lib/days";
import { convertLifeLogNotes, planConversion } from "../../../lib/days-convert";
import { memoryContext } from "../../../lib/day-firsts";
import { loadMemoryPrefs, saveMemoryPrefs } from "../../../lib/day-prefs";

type Json = (data: unknown, status?: number) => Response;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_KEY = "Athena can't open or save this right now: its encryption key isn't set here.";

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 64_000) throw new AthenaInputError("That's too much for one change");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AthenaInputError("Send JSON");
  }
}

/** Handles /api/days…; null for anything else. */
export async function handleDaysRoutes(req: Request, url: URL, segments: string[], json: Json, waitUntil?: (p: Promise<unknown>) => void): Promise<Response | null> {
  const [, first, second, third, fourth] = segments;
  if (first !== "days") return null;
  const method = req.method;
  try {
    if (segments.length === 2) {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const tz = await getOwnerTimeZone();
      const today = zonedToday(new Date(), tz);
      const to = url.searchParams.get("to") ?? today;
      const from = url.searchParams.get("from") ?? addDays(readDate(to, "to"), -34);
      return json(await daysRange(from, to, { tz }));
    }
    if (segments.length === 3 && second === "search") {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ q, results: [], facets: { sources: [], places: [], people: [] } });
      const kind = url.searchParams.get("kind") ?? undefined;
      if (kind && !isDayEntryKind(kind)) throw new AthenaInputError("kind: watched, listened, read, highlight, played, posted, saved, chess, workout or other");
      const limit = Number(url.searchParams.get("limit") ?? 40);
      const param = (k: string) => url.searchParams.get(k)?.trim().slice(0, 200) || undefined;
      return json(
        await searchDaysFaceted(q.slice(0, 200), {
          kind: kind && isDayEntryKind(kind) ? kind : undefined,
          from: param("from"),
          to: param("to"),
          source: param("source")?.toLowerCase(),
          place: param("place"),
          person: param("person"),
          limit: Number.isFinite(limit) ? limit : 40,
        }),
      );

    }
    if (segments.length === 3 && second === "firsts") {
      if (method !== "GET") return json({ error: "Method not allowed" }, 405);
      const tz = await getOwnerTimeZone();
      const around = url.searchParams.get("around") ?? zonedToday(new Date(), tz);
      return json(await memoryContext(readDate(around, "around"), { tz }));
    }
    if (segments.length === 3 && second === "memories") {
      if (method === "GET") return json(await loadMemoryPrefs());
      if (method === "PATCH") return json(await saveMemoryPrefs(await body(req)));
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 3 && second === "convert") {
      if (method === "GET") return json(await planConversion());
      if (method === "POST") return json(await convertLifeLogNotes({ budgetMs: 8_000 }));
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 3) {
      const date = readDate(second);
      if (method === "GET") return json(await withDayArt(await getDay(date, { money: "prefs" }), waitUntil));
      if (method === "PATCH") return json(await patchDay(date, await body(req)));
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "entries") {
      if (method !== "POST") return json({ error: "Method not allowed" }, 405);
      const today = zonedToday(new Date(), await getOwnerTimeZone());
      return json(await addManualEntry(readDate(second), await body(req), { today }), 201);
    }
    if (segments.length === 5 && third === "entries" && UUID.test(fourth ?? "")) {
      readDate(second);
      if (method === "DELETE") return (await removeManualEntry(fourth)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
      if (method !== "PATCH") return json({ error: "Method not allowed" }, 405);
      const b = (await body(req)) as { hidden?: unknown };
      if (typeof b.hidden !== "boolean") throw new AthenaInputError("hidden: true or false");
      const changed = b.hidden ? await hideEntry(fourth) : await showEntry(fourth);
      return json({ id: fourth, hidden: b.hidden, changed });
    }
  } catch (error) {
    if (error instanceof AthenaInputError) return json({ error: error.message }, error.status ?? 400);
    if (error instanceof DataBoxError) return json({ error: NO_KEY }, 503);
    throw error;
  }
  return json({ error: "Not found" }, 404);
}

/**
 * A day's missing art, filled in on view: what's found within a short budget
 * comes back now and is kept; the rest carries on after the response
 * (waitUntil) and shows next time. Never fails the request.
 */
async function withDayArt<D extends null | { entries: Array<{ id: string; kind: string; source: string; title: string; subtitle?: string; url?: string; art?: { id: string; w: number; h: number; tone?: string } }> }>(day: D, waitUntil?: (p: Promise<unknown>) => void): Promise<D> {
  if (!day) return day;
  const missing = day.entries.filter((e) => !e.art && e.source !== "places" && ART_KINDS.includes(e.kind));
  if (!missing.length) return day;
  try {
    const done = await attachDayArt(missing, {}, { budgetMs: 800, waitUntil });
    const found = new Map<string, NonNullable<(typeof done)[number]["art"]>>();
    for (const e of done) if (e.art) found.set(e.id, e.art);
    for (const [id, art] of found) await setEntryArt(id, art);
    if (!found.size) return day;
    return { ...day, entries: day.entries.map((e) => (found.has(e.id) ? { ...e, art: found.get(e.id) } : e)) };
  } catch {
    return day;
  }
}
