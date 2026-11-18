/**
 * Habits, money and home over REST (lib/habits.ts, lib/money.ts). All need
 * full access (the app's token or a full key); a capture key can't.
 *
 *  - GET  /api/life/habits?from&to: each habit's days, streak and weekday
 *    split (at most 400 days; default the last year).
 *  - GET  /api/life/money?from&to: months by category and merchant.
 *    Opened in the Function; no balance anywhere.
 *  - GET  /api/life/house: the home's energy as chart data, its cost when
 *    the tariff is known, the household bills (lib/house-data.ts).
 *  - GET  /api/life/music?period=month|year|all|YYYY: what was played,
 *    from Days' listened entries (lib/music-data.ts); ?artist=<name> instead
 *    gives one artist over everything held (404 when never played);
 *    ?playlists=1 the owner's playlists (lib/playlists.ts), ?playlist=<id>
 *    one with its tracks.
 *  - GET  /api/life/work?period=month|quarter|year|YYYY: the owner's own
 *    issues and PRs (lib/work-data.ts), counted by the work sync with no
 *    Claude; ?project=<name> instead gives one project's sheet (404 when
 *    none of the owner's issues are in it).
 *  - GET  /api/life/recurring: regular payments (lib/recurring.ts), opened
 *    from their sealed row; PUT { key, hidden } marks one "Not a
 *    subscription" (or brings it back) and answers with the new list.
 *  - GET  /api/life/spending?from&to: payments added by hand (lib/money.ts
 *    ManualPayment), newest first. POST { date?, time?, amount (minor
 *    units), currency?, category?, merchant? } adds one and answers with it;
 *    DELETE ?date&id takes one out. For anyone without a supported bank, or
 *    for cash.
 *  - GET  /api/life/readings: meter readings typed in by hand
 *    (lib/meter-readings.ts), newest first. POST { fuel, date?, value,
 *    unit? } adds one, DELETE ?id takes one out; both answer with the list.
 *    The use between readings becomes the home's days, for anyone whose
 *    meter Athena can't read.
 *  - GET  /api/life/prefs, PUT { money?, home? }: whether Days shows the
 *    money and home lines. Off until the owner turns them on.
 *
 * Nothing here logs an amount, a merchant or a reading.
 */
import { addDays, zonedParts, zonedToday } from "../../../lib/dates";
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { houseData } from "../../../lib/house-data";
import { musicArtist, musicData } from "../../../lib/music-data";
import type { ArtHint } from "../../../lib/art";

/** Album covers for Music, found and kept like any art (lib/art.ts): Music reads them on its next load. Never throws. */
async function learnCovers(hints: ArtHint[]): Promise<void> {
  try {
    const { attachArt } = await import("../../../lib/art");
    await attachArt(
      hints.map((h, i) => ({ entry: { id: String(i) }, hints: [h] })),
      { budgetMs: 8000 },
    );
  } catch {
    // Asked again on a later load.
  }
}
import { workData, workProject } from "../../../lib/work-data";
import { loadPlaylists } from "../../../lib/playlist-store";
import { playlistsView } from "../../../lib/playlists";
import { DataBoxError } from "../../../lib/data-box";
import { habitSummaries } from "../../../lib/habits";
import { addReading, loadReadings, removeReading } from "../../../lib/meter-readings";
import { addManualPayment, loadMoneyPrefs, manualPayments, markNotRegular, moneyMonths, regularPayments, removeManualPayment, saveMoneyPrefs } from "../../../lib/money";

type Json = (data: unknown, status?: number) => Response;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

function range(url: URL, today: string): { from: string; to: string } {
  const to = url.searchParams.get("to") || today;
  const from = url.searchParams.get("from") || addDays(to, -364);
  if (!DAY.test(from) || !DAY.test(to)) throw new AthenaInputError("from and to: YYYY-MM-DD");
  if (from > to) throw new AthenaInputError("from must be on or before to");
  if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86_400_000) throw new AthenaInputError(`At most ${MAX_DAYS} days at once`);
  return { from, to };
}

/** Handles /api/life/{habits,money,spending,readings,house,music,work,recurring,prefs}; null for anything else. */
export async function handleLifeRoutes(req: Request, url: URL, segments: string[], json: Json, waitUntil?: (p: Promise<unknown>) => void): Promise<Response | null> {
  const [, , second] = segments;
  if (segments.length !== 3) return null;
  try {
    const tz = await getOwnerTimeZone();
    const today = zonedToday(new Date(), tz);
    if (second === "habits") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const { from, to } = range(url, today);
      return json({ from, to, today, habits: await habitSummaries(from, to, today) });
    }
    if (second === "money") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const { from, to } = range(url, today);
      return json({ from, to, ...(await moneyMonths(from, to)) });
    }
    if (second === "spending") {
      if (req.method === "GET") {
        const to = url.searchParams.get("to") || today;
        const from = url.searchParams.get("from") || addDays(to, -364);
        if (!DAY.test(from) || !DAY.test(to) || from > to) throw new AthenaInputError("from and to: YYYY-MM-DD, from first");
        return json({ from, to, ...(await manualPayments(from, to)) });
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        return json(await addManualPayment(body, { today, tz, nowTime: zonedParts(new Date(), tz).time.slice(0, 5) }), 201);
      }
      if (req.method === "DELETE") {
        const date = url.searchParams.get("date") ?? "";
        const id = url.searchParams.get("id") ?? "";
        if (!DAY.test(date) || !id) throw new AthenaInputError("date (YYYY-MM-DD) and id");
        return (await removeManualPayment(date, id, { today, tz })) ? json({ ok: true }) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (second === "readings") {
      if (req.method === "GET") return json({ readings: await loadReadings() });
      if (req.method === "POST") return json({ readings: await addReading(await req.json().catch(() => null), { today, tz }) }, 201);
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id") ?? "";
        if (!id) throw new AthenaInputError("id");
        const next = await removeReading(id, { tz });
        return next ? json({ readings: next }) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (second === "house") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json(await houseData(today, new Date(), tz));
    }
    if (second === "music") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      // Playlists (lib/playlists.ts): the list, or one with its tracks. Not tied to a period.
      if (url.searchParams.get("playlists") === "1") return json(playlistsView(await loadPlaylists()));
      const playlist = url.searchParams.get("playlist");
      if (playlist !== null) {
        const found = (await loadPlaylists()).flatMap((s) => s.playlists.map((p) => ({ ...p, source: s.source, updated: s.updated }))).find((p) => p.id === playlist);
        return found ? json(found) : json({ error: "Not found" }, 404);
      }
      const artist = url.searchParams.get("artist")?.trim();
      if (artist !== undefined) {
        if (!artist || artist.length > 300) throw new AthenaInputError("artist: a name, at most 300 characters");
        const a = await musicArtist(artist, today);
        return a ? json(a) : json({ error: "Not found" }, 404);
      }
      // After the reply: genres for artists not known yet (netlify/lib/music-genres.ts), and covers for the most played albums without one (lib/art.ts, Deezer).
      return json(
        await musicData(url.searchParams.get("period"), today, {
          learn: waitUntil ? (names) => waitUntil(import("../music-genres").then((m) => m.learnMusicGenres(names, { budgetMs: 8000 })).then(() => undefined, () => undefined)) : undefined,
          learnCovers: waitUntil ? (hints) => waitUntil(learnCovers(hints)) : undefined,
        }),
      );
    }
    if (second === "work") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const project = url.searchParams.get("project")?.trim();
      if (project !== undefined) {
        if (!project || project.length > 300) throw new AthenaInputError("project: a name, at most 300 characters");
        const p = await workProject(project, today, tz);
        return p ? json(p) : json({ error: "Not found" }, 404);
      }
      return json(await workData(url.searchParams.get("period"), today, tz));
    }
    if (second === "recurring") {
      if (req.method === "GET") return json(await regularPayments(today));
      if (req.method === "PUT") {
        await markNotRegular(await req.json().catch(() => null));
        return json(await regularPayments(today));
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (second === "prefs") {
      if (req.method === "GET") return json(await loadMoneyPrefs());
      if (req.method === "PUT") return json(await saveMoneyPrefs(await req.json().catch(() => null)));
      return json({ error: "Method not allowed" }, 405);
    }
    return null;
  } catch (error) {
    if (error instanceof AthenaInputError) return json({ error: error.message }, 400);
    if (error instanceof DataBoxError) return json({ error: "Athena can't open your figures right now: its encryption key isn't set here." }, 503);
    throw error;
  }
}
