/**
 * Running the morning briefing: loading its data, handing the model's turn
 * to the background function, and delivering exactly one briefing a day.
 *
 *   07:30 run (netlify/functions/reminders.ts) claims `briefing:<day>` as before.
 *     AI configured → POST /.netlify/functions/briefing-write (background, up to 15 minutes),
 *       which writes with the model (lib/briefing-writer.ts) or falls back to the data briefing.
 *     Otherwise, or if that call fails → the data briefing, there and then.
 *   Every later run: handed off more than WATCHDOG_MINUTES ago and nothing sent yet
 *     → the data briefing (the background function died).
 *
 * Whoever delivers first claims `briefing-sent:<day>`; the other finds it
 * taken and sends nothing. So there is never a second note or push.
 */

import {
  claimReminder,
  createNote,
  getConnectionsDetailed,
  listNotes,
  listPeople,
  listReminders,
  listStalePeople,
  q,
  releaseReminder,
  type AthenaEvent,
} from "./db";
import { countPendingSuggestions, listDueCommitments, listFacts, listReading, listRenewals, listWaitingQuiet, personBrief } from "./memory";
import { addDays, upcomingOccurrences, zonedToInstant, zonedToday } from "./dates";
import { loadBriefingHelp, profilePromptBlock } from "./profile";
import { listPurchases, listTrips } from "./trips";
import { dayMainSpot, placeDays } from "./places-visits";
import { forecastToday } from "./weather";
import type { Briefing, BriefingInput, BriefingRenewal } from "./briefing";
import { hardDay, readWriterProfile, type MeetingPerson, type MeetingPrep, type WriterInput } from "./briefing-writer";
import { regularPayments } from "./money";
import { dueSoon } from "./recurring";
import { daysRange, entriesInRange } from "./days";
import { loadHealthPrefs, mergeSources, readHealthDays } from "./health";
import { busiestLines } from "./stations";
import { liveCandidate, type LineStatus, type TrainStatus } from "./live-travel-text";
import type { TripLike } from "./trip-text";
import { commuteDisruptions, liveTravelReady, trainStatus } from "../netlify/lib/live-travel";
import { flightStatus } from "../netlify/lib/live-flights";
import { flightCandidate, type FlightStatus } from "./flight-text";
import { morningBriefingLines, type LoadCheckin } from "./checkin-push";

import { loadCheckin } from "./checkins";

export const BRIEFING_WRITE_PATH = "/.netlify/functions/briefing-write";
/** After this long without a briefing, the 5-minute run sends the data one. */
export const WATCHDOG_MINUTES = 10;

export const claimKey = (day: string) => `briefing:${day}`;
export const sentKey = (day: string) => `briefing-sent:${day}`;

/** The people a timed event is with: its person, plus anyone linked to it in the graph. */
export async function meetingPeople(event: AthenaEvent): Promise<MeetingPerson[]> {
  const { outgoing, backlinks } = await getConnectionsDetailed("event", event.id);
  const linked = [...outgoing, ...backlinks].filter((c) => c.kind === "person").map((c) => c.id);
  const ids = [...new Set([...(event.person_id && event.kind !== "birthday" ? [event.person_id] : []), ...linked])];
  const briefs = await Promise.all(ids.slice(0, 3).map((id) => personBrief(id)));
  return briefs.flatMap((b) => {
    if (!b) return [];
    const last = [...b.interactions].sort((x, y) => Date.parse(String(y.at)) - Date.parse(String(x.at)))[0];
    return [
      {
        id: b.person.id,
        name: b.person.name,
        last_contacted_at: b.person.last_contacted_at,
        last_interaction: last ? { at: String(last.at), summary: last.summary } : null,
        forThem: b.open_loops.filter((c) => c.kind === "i_owe").map((c) => c.title),
        fromThem: b.open_loops.filter((c) => c.kind === "waiting_on").map((c) => c.title),
      },
    ];
  });
}

/** Everything buildBriefing needs, for `now` in `tz`. */
export async function loadBriefingInput(now: Date, tz: string, events: AthenaEvent[]): Promise<BriefingInput> {
  const today = zonedToday(now, tz);
  const yesterdayStart = zonedToInstant(addDays(today, -1), "00:00", tz);
  const [people, catchUps, recent, reminders, due, waiting, renewals, pending, trips, purchases, help, regular] = await Promise.all([
    listPeople(1000),
    listStalePeople(),
    listNotes({ since: yesterdayStart, limit: 200 }),
    listReminders(),
    listDueCommitments(today),
    listWaitingQuiet(5),
    listRenewals(30, today),
    countPendingSuggestions(),
    listTrips({ upcomingOnly: true, today }),
    listPurchases({ inProgressOnly: true }),
    loadBriefingHelp(),
    // Regular payments due today or tomorrow, from the bank: a name and a date, never an amount (lib/recurring.ts).
    regularPayments(today).then((r) => dueSoon(r.items, today), () => []),
  ]);
  const tracked = new Set(renewals.map(({ asset }) => asset.name.trim().toLowerCase()));
  const [live, commute] = await Promise.all([loadTrainStatus(trips, now), loadCommute(today)]);
  return {
    now,
    tz,
    events,
    people,
    catchUps,
    recentNotes: recent.filter((n) => Date.parse(n.created_at) >= yesterdayStart.getTime()),
    reminders,
    due,
    waiting,
    renewals: renewals.map(({ asset }): BriefingRenewal => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      renews_on: asset.renews_on!,
      remind_days_before: asset.remind_days_before,
    })).concat(regular.filter((p) => !tracked.has(p.name.toLowerCase())).map((p) => ({ id: `regular:${p.key}`, name: p.name, kind: p.kind, renews_on: p.on, remind_days_before: [0, 1] }))),
    pendingSuggestions: pending,
    trips,
    purchases,
    help,
    trainStatus: live,
    commute,
  };
}

/** How far back the commute is read from the TfL journey history (lib/tfl-csv.ts imports). */
export const COMMUTE_DAYS = 60;

/**
 * Live status for the trains in `trips` leaving in the next 3 hours, by
 * booking id, and for flights from 3 hours before they leave
 * (netlify/lib/live-flights.ts: OpenSky). Trains are off
 * without a National Rail key (Sources, or ATHENA_RDM_KEY); a booking nobody can answer for is left out, and
 * the briefing words it as before.
 */
export async function loadTrainStatus(trips: TripLike[], now: Date): Promise<Record<string, TrainStatus | FlightStatus>> {
  const bookings = trips.flatMap((t) => t.bookings).filter((b) => b.id);
  const trains = (await liveTravelReady({ now })).trains ? bookings.filter((b) => liveCandidate(b, now)).slice(0, 4) : [];
  const flights = bookings.filter((b) => flightCandidate(b, now)).slice(0, 4);
  const out: Record<string, TrainStatus | FlightStatus> = {};
  await Promise.all([
    ...trains.map(async (b) => {
      const s = await trainStatus(b, { now }).catch(() => null);
      if (s) out[b.id!] = s;
    }),
    ...flights.map(async (b) => {
      const s = await flightStatus(b, { now });
      if (s) out[b.id!] = s;
    }),
  ]);
  return out;
}

/**
 * The owner's busiest TfL lines (from the journey history they imported, the
 * last COMMUTE_DAYS days) that aren't on Good Service now. Off (empty)
 * without a TfL key (Sources, or ATHENA_TFL_KEY) or a journey history. Only TfL's own status list is
 * fetched: no station or line leaves Athena.
 */
export async function loadCommute(today: string): Promise<LineStatus[]> {
  if (!(await liveTravelReady()).lines) return [];
  try {
    const days = await entriesInRange(addDays(today, -COMMUTE_DAYS), addDays(today, -1), { kind: "other", limit: 2000 });
    const titles = days.flatMap((d) => d.entries.filter((e) => e.source === "tfl").map((e) => e.title));
    return await commuteDisruptions(busiestLines(titles));
  } catch (error) {
    console.error("Athena briefing: commute lines", error);
    return [];
  }
}

/** The data buildBriefing uses, plus what the writer adds. Each extra fails soft: the briefing goes out without it. */
export async function loadWriterInput(data: BriefingInput, events: AthenaEvent[], checkins: LoadCheckin = loadCheckin): Promise<WriterInput> {
  const today = zonedToday(data.now, data.tz);
  const timedToday = upcomingOccurrences(events, today, 0, data.tz).filter((o) => o.time && o.event.kind !== "birthday");
  const soft = <T>(p: Promise<T>, empty: T) => p.catch((error) => (console.error("Athena briefing:", error), empty));
  const [meetings, reading, facts, block, days, forecast, morning] = await Promise.all([
    soft(
      Promise.all(
        timedToday.slice(0, 6).map(async (o): Promise<MeetingPrep> => ({ event: { id: o.event.id, title: o.event.title }, time: o.time, people: await meetingPeople(o.event) })),
      ).then((ms) => ms.filter((m) => m.people.length)),
      [] as MeetingPrep[],
    ),
    soft(listReading({ status: "queued", limit: 50 }), []),
    soft(listFacts({ subjectKind: "me" }), []),
    profilePromptBlock(),
    soft(placeDays(addDays(today, -3), addDays(today, -1)), new Map()),
    soft(loadForecast(today, data.tz), null),
    // This morning's focus and intention, when the morning check-in has them (null while the routine is off).
    soft(checkins(today, "morning").then(morningBriefingLines), [] as string[]),
  ]);
  const latest = [...days.entries()].filter(([, d]) => d.weather).sort(([a], [b]) => b.localeCompare(a))[0];
  const { taste, name, tone, hardDayShort } = readWriterProfile(facts);
  // Only read yesterday's mood and the nights when the owner asked for a short briefing on a hard day.
  const goEasy = hardDayShort ? await soft(loadHardDay(today, data.tz), false) : false;
  return {
    data,
    meetings,
    reading: reading.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      author: r.author,
      notes: r.notes,
      recommender: r.recommender ? { id: r.recommender.id, name: r.recommender.name } : null,
      created_at: String(r.created_at),
    })),
    taste,
    weather: latest ? { date: latest[0], line: latest[1].weather! } : null,
    forecast: forecast && { town: forecast.town ?? latest?.[1].weather?.match(/ in (.+)$/)?.[1] ?? null, hours: forecast.hours },
    profileBlock: block,
    name,
    tone,
    ...(goEasy ? { goEasy } : {}),
    ...(morning.length ? { morning } : {}),
  };
}

/** How many nights the short-night rule looks back over. */
export const HARD_DAY_NIGHTS = 42;

/**
 * Whether today follows a hard day: yesterday's mood was Awful or Low, or
 * last night (today's sleep) was short for this owner (lib/briefing-writer.ts
 * hardDay). Read only for the writer's go_easy; nothing about it is stored.
 */
export async function loadHardDay(today: string, tz: string): Promise<boolean> {
  const yesterday = addDays(today, -1);
  const [range, health, prefs] = await Promise.all([
    daysRange(yesterday, yesterday, { tz }).catch(() => null),
    readHealthDays(addDays(today, -HARD_DAY_NIGHTS), today).catch(() => null),
    loadHealthPrefs().catch(() => undefined),
  ]);
  const mood = range?.days.find((d) => d.date === yesterday)?.mood ?? null;
  const sleepOn = (date: string) => {
    const sources = health?.days.get(date);
    return sources?.length ? mergeSources(sources, prefs).sleep_minutes : undefined;
  };
  const nights: number[] = [];
  for (let d = addDays(today, -HARD_DAY_NIGHTS); d < today; d = addDays(d, 1)) {
    const m = sleepOn(d);
    if (m) nights.push(m);
  }
  return hardDay({ mood, sleep_minutes: sleepOn(today) ?? null, nights });
}

/** Today's waking hours where yesterday was mostly spent, or null (no record, or Open-Meteo didn't answer). */
export async function loadForecast(today: string, tz: string, fetchImpl?: typeof fetch): Promise<NonNullable<WriterInput["forecast"]> | null> {
  const spot = await dayMainSpot(addDays(today, -1), tz);
  if (!spot) return null;
  const hours = await forecastToday(spot, { date: today, fetch: fetchImpl });
  return hours ? { town: spot.town ?? null, hours } : null;
}

export interface DeliverDeps {
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  createNote(note: { title: string; body: string; type: "daily"; source: "briefing"; tags: string[] }): Promise<{ id: string }>;
  push(message: { title: string; body: string; url: string; tag: string }): Promise<unknown>;
  /** Today's lighter plan after a short night (lib/proactive/briefing.ts), when there is one. */
  dayPlan?(date: string): Promise<{ section: string; push: string } | null>;
}

/**
 * The note's body with the writer's line kept at the top, as a quote: the
 * same line the push carries, and what Home's briefing card shows
 * (app/src/views/home.ts briefingLine). The data briefing has no line and is
 * stored as it is.
 */
export function bodyWithLead(body: string, lead: string | undefined): string {
  const line = lead?.replace(/\s+/g, " ").trim();
  if (!line) return body;
  return `> ${line}\n\n${body.replace(/^\s+/, "")}`;
}

/**
 * Write the "Today, …" note and push the digest, unless today's briefing
 * already went out. Returns the note id, or null when it had. The writer's
 * digest line is saved with the note, at its top (bodyWithLead).
 * After the note is saved a failed push is logged, not retried: a retry
 * would write a second note.
 */
export async function deliverBriefing(b: Briefing & { lead?: string }, opts: { push: boolean }, deps: DeliverDeps): Promise<string | null> {
  const key = sentKey(b.date);
  if (!(await deps.claim(key))) return null;
  let note: { id: string };
  const plan = deps.dayPlan ? await deps.dayPlan(b.date).catch(() => null) : null;
  try {
    const body = bodyWithLead(b.body, b.lead);
    note = await deps.createNote({ title: b.title, body: plan ? `${body.trimEnd()}\n\n${plan.section}\n` : body, type: "daily", source: "briefing", tags: ["briefing"] });
  } catch (error) {
    await deps.release(key);
    throw error;
  }
  if (opts.push) {
    try {
      await deps.push({ title: b.hasReminders ? "Today" : "Good morning", body: plan ? `${b.digest} ${plan.push}` : b.digest, url: `/#/notes/${note.id}`, tag: `briefing-${b.date}` });
    } catch (error) {
      console.error("Athena briefing: push failed", error);
    }
  }
  return note.id;
}

/** The real deliverer: reminder_log, notes and Web Push. */
export function dbDeliverDeps(send: DeliverDeps["push"]): DeliverDeps {
  return {
    claim: claimReminder,
    release: releaseReminder,
    createNote: (n) => createNote(n),
    push: send,
    async dayPlan(date) {
      const [{ dayPlanFor }, { dayPlanSection, DAY_PLAN_PUSH }, { getOwnerTimeZone }] = await Promise.all([import("./proactive/store"), import("./proactive/briefing"), import("./db")]);
      const n = await dayPlanFor(date);
      if (!n) return null;
      const tz = await getOwnerTimeZone();
      const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(iso));
      return { section: dayPlanSection(n, hhmm), push: DAY_PLAN_PUSH };
    },
  };
}

/** Handed off, not sent, and long enough ago that the background function must have died? */
export function watchdogDue(handedOffAt: Date | null, sent: boolean, now: Date): boolean {
  return !!handedOffAt && !sent && now.getTime() - handedOffAt.getTime() >= WATCHDOG_MINUTES * 60_000;
}

/** When today's briefing was claimed, and whether it went out. */
export async function briefingState(day: string): Promise<{ handedOffAt: Date | null; sent: boolean }> {
  const rows = await q<{ key: string; sent_at: string }>(`SELECT key, sent_at FROM reminder_log WHERE key = ANY($1)`, [[claimKey(day), sentKey(day)]]);
  const claimed = rows.find((r) => r.key === claimKey(day));
  return { handedOffAt: claimed ? new Date(claimed.sent_at) : null, sent: rows.some((r) => r.key === sentKey(day)) };
}

/** Ask the background function to write today's briefing. Throws when it can't be reached. */
export async function handOff(origin: string, day: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get("MCP_BEARER_TOKEN") ?? process.env.MCP_BEARER_TOKEN;
  if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
  const res = await fetchImpl(new URL(BRIEFING_WRITE_PATH, origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ date: day }),
  });
  if (!res.ok) throw new Error(`background function answered ${res.status}`);
}

