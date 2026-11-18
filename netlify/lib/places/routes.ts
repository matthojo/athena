/**
 * Places and visits over REST (lib/places-visits.ts has the rules). All
 * need full access (the app's token or a full key); a capture key can't.
 *
 *  - GET  /api/places/status: days with places, the first and last, days
 *    still waiting for names, which Life log they go into, whether Swarm is
 *    connected, and the owner's zone (the import groups days in it). No
 *    place and no coordinates.
 *  - POST /api/places/timeline: { days: [{ date, visits: [{ start, end,
 *    lat, lng, place_id?, name?, kind? }] }] } from a Google Maps Timeline
 *    file, parsed in the browser. At most 31 days or 1,500 visits a request.
 *    Safe to send again: what's already there isn't added twice.
 *  - POST /api/places/names: names (Nominatim, one a second) and weather for
 *    days still waiting, for about eight seconds. The import sheet calls it
 *    until nothing's waiting; the nightly Life log run carries on otherwise.
 *  - GET  /api/places/:id/visits: when you've been to one Place.
 *  - GET  /api/places/visits/manual?from=&to=: visits added by hand, newest
 *    first (the last year by default; ?date= for one day). POST { date,
 *    time: "HH:MM", minutes, place_id } or { …, address, name? } adds one
 *    (a saved Place's spot, else its address on the map; a typed address
 *    looked up once) and rebuilds the day. DELETE ?date=&id= takes one out
 *    and rebuilds the day.
 *
 * Nothing here logs a place or a coordinate.
 */
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { textUpTo } from "../body-limit";
import { DataBoxError } from "../../../lib/data-box";
import { addDays, isValidDate, zonedToday } from "../../../lib/dates";
import { addManualVisit, importTimeline, listManualVisits, nameWaitingDays, placesStatus, placeVisits, removeManualVisit } from "../../../lib/places-visits";

type Json = (data: unknown, status?: number) => Response;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_KEY = "Athena can't save places right now: its encryption key isn't set here.";

/** Handles /api/places/{status,timeline,names,visits/manual} and /api/places/:id/visits; null for anything else (the Places records routes). */
export async function handlePlacesRoutes(req: Request, segments: string[], json: Json): Promise<Response | null> {
  const [, , second, third] = segments;
  try {
    if (segments.length === 3 && second === "status") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json({ ...(await placesStatus()), tz: await getOwnerTimeZone() });
    }
    if (segments.length === 3 && second === "timeline") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const text = await textUpTo(req, 1_500_000);
      if (text === null) return json({ error: "That's too much for one request: send at most 31 days" }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "Send JSON" }, 400);
      }
      return json(await importTimeline(body, { deadline: Date.now() + 12_000 }));
    }
    if (segments.length === 3 && second === "names") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return json(await nameWaitingDays(8_000));
    }
    if (segments.length === 4 && second === "visits" && third === "manual") {
      const q = new URL(req.url).searchParams;
      if (req.method === "GET") {
        const tz = await getOwnerTimeZone();
        const one = q.get("date");
        const to = one ?? q.get("to") ?? zonedToday(new Date(), tz);
        const from = one ?? q.get("from") ?? addDays(to, -365);
        if (!isValidDate(from) || !isValidDate(to) || from > to) return json({ error: "from and to: YYYY-MM-DD, from first" }, 400);
        return json({ visits: await listManualVisits(from, to) });
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        return json({ visit: await addManualVisit(body, { deadline: Date.now() + 8_000 }) }, 201);
      }
      if (req.method === "DELETE") {
        const date = q.get("date") ?? "";
        const id = q.get("id") ?? "";
        if (!isValidDate(date) || !UUID.test(id)) return json({ error: "Send date and id" }, 400);
        return (await removeManualVisit(date, id, { deadline: Date.now() + 8_000 })) ? json({ ok: true }) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "visits" && UUID.test(second)) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json({ visits: await placeVisits(second) });
    }
  } catch (error) {
    if (error instanceof AthenaInputError) return json({ error: error.message }, error.status ?? 400);
    if (error instanceof DataBoxError) return json({ error: NO_KEY }, 503);
    throw error;
  }
  return null;
}
