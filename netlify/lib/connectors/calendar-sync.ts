/**
 * The Calendar collection (recipe `calendar-sync`): the next N days of the
 * owner's calendars kept in step with Athena's events, with no model.
 *
 * Until this, a Meetings collection with upcoming-event sync asked Claude to
 * list the range and call athena_save_event once per event, every run, so
 * its cost grew with the calendar. Everything in that step is mechanical:
 * Google, Outlook and iCloud all answer list_events with the same JSON
 * (google-calendar.ts, microsoft-calendar.ts, icloud-calendar.ts), and the
 * save itself was already code (AthenaWriter's athena_save_event). Here code
 * builds those same calls from the listing:
 *
 * 1. Lists each chosen calendar account across the range, every page.
 * 2. Saves each event (not cancelled ones, working-location, out-of-office
 *    or focus markers, or "hold" blocks) through the writer, so twins, your
 *    answer, attendees and the meeting note link work exactly as before. An
 *    event that still matches what Athena holds is left alone.
 * 3. For each event Athena holds in the range that the listing didn't have,
 *    fetches it by id on the account it came from and archives it if that
 *    says cancelled or not found. A listing that failed archives nothing.
 *
 * A Meetings collection whose calendar accounts an enabled Calendar reads
 * stops syncing events itself (runner.ts, `withoutCoveredSync`), so only its
 * notes need Claude. The first time Calendar sees an event Meetings synced,
 * it takes over that record (`adopt`) instead of making a second one.
 */
import {
  collectedByRecipe,
  getCollected,
  getConnector,
  linkCollectedMeetings,
  listCollected,
  listCollections,
  markConnectorUsed,
  recordCollected,
  setArchivedByCollector,
  type Collection,
  type RunStatsJson,
} from "../../../lib/connectors";
import { addDays, zonedParts, zonedToday } from "../../../lib/dates";
import { getEvent } from "../../../lib/db";
import { fromCalendar } from "../../../lib/rsvp";
import { callTool, ConnectorNeedsSignIn, listAllowedTools, openConnector, type OpenConnector } from "./mcp-client";

export const CALENDAR_PROVIDERS = new Set(["google-calendar", "outlook-calendar", "icloud-calendar"]);
export const isCalendarProvider = (provider: string): boolean => CALENDAR_PROVIDERS.has(provider);

/** What the run needs from AthenaWriter (runner.ts), passed in so this file doesn't import the runner. */
export interface CalendarWriter {
  providers: string[];
  checksStyle: boolean;
  noteCalendarResult(connector: { id: string; provider: string }, args: Record<string, unknown>, text: string): void;
  run(name: string, raw: unknown): Promise<string>;
}

/** One event in a list_events or get_event reply, the fields this file reads. */
export interface ListedEvent {
  id?: string;
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: string;
  eventType?: string;
  location?: string;
  myResponse?: string;
  attendees?: string[];
  moreAttendees?: number;
  calendarId?: string;
}

/** The athena_save_event input (runner.ts) for one event. */
export interface SaveEventInput {
  external_id: string;
  title: string;
  start?: string;
  end?: string;
  date?: string;
  notes: string;
  my_response?: string;
  attendees?: Array<{ name?: string; email?: string }>;
}

/** Markers, not meetings (recipes.ts step 6b): the same types the Meetings recipe skips. */
const NOT_SAVED_TYPES = new Set(["workingLocation", "outOfOffice", "focusTime"]);
/** "Hold", "Focus time", "Block: planning": time kept for yourself, not an event. */
const HOLD_TITLE = /^\s*(?:on\s+)?(?:hold|focus(?:\s+(?:time|block))?|block(?:ed)?(?:\s+time)?)\s*(?:$|[:\-–—(|·])/i;
/** get_event's answer for an event that's gone (each adapter's ToolInputError). */
const NOT_FOUND = /^not found\b/i;
const PAGE_SIZE = 250;
const MAX_PAGES = 8;
/** Events listed with only some of their guests: fetched whole for the guest list, at most this many a run. */
const MAX_DETAIL_FETCHES = 20;
/** Names in an event's one-line note before "and N others". */
const NOTE_NAMES = 4;

/** Why an event isn't saved, or null when it is. */
export function skipReason(e: ListedEvent): string | null {
  if (!e.id) return "no id";
  if (e.status === "cancelled") return "cancelled";
  if (e.eventType && NOT_SAVED_TYPES.has(e.eventType)) return "marker";
  if (e.summary && HOLD_TITLE.test(e.summary)) return "hold";
  if (!e.start) return "no start";
  return null;
}

/**
 * One line of an attendee list, as the adapters write it:
 * "Priya Shah <priya@example.com> (organiser): accepted". Null for a line
 * that isn't a person ("someone").
 */
export function attendeeOf(line: string): { name?: string; email?: string; you: boolean; declined: boolean } | null {
  const m = /^(.*?)(?: \(([^()]*)\))?: ([^:]*)$/.exec(line.trim());
  const who = (m ? m[1] : line).trim();
  const tags = (m?.[2] ?? "").split(",").map((t) => t.trim().toLowerCase());
  const reply = (m?.[3] ?? "").trim().toLowerCase();
  if (!who || who === "someone") return null;
  const angled = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(who);
  const name = angled ? angled[1].trim() : who.includes("@") ? "" : who;
  const email = angled ? angled[2].trim() : who.includes("@") && !/\s/.test(who) ? who : "";
  if (!name && !email) return null;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), you: tags.includes("you"), declined: reply === "declined" };
}

/** "Room 4 · with Priya Shah, Sam Lee and Ana Ruiz", or "" for an event with neither. */
export function eventNote(location: string | undefined, names: string[], more = 0): string {
  const shown = names.slice(0, NOTE_NAMES);
  const rest = names.length - shown.length + more;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
  return [location?.replace(/\s+/g, " ").trim() ?? "", list ? `with ${list}` : ""].filter(Boolean).join(" · ").slice(0, 1000);
}

/**
 * The athena_save_event input for one listed event, as recipes.ts step 6b
 * describes it: the start and end exactly as the calendar gives them (a date
 * for an all-day event), your reply, and everyone else on the invite who
 * hasn't declined. Attendees are left out (links unchanged) when the listing
 * cut the guest list short and `full` isn't the whole event.
 */
export function saveInput(e: ListedEvent & { id: string; start: string }, full = !e.moreAttendees): SaveEventInput {
  const people = (e.attendees ?? []).map(attendeeOf).filter((a) => a !== null);
  const others = people.filter((a) => !a.you && !a.declined);
  const names = others.map((a) => a.name ?? a.email ?? "").filter(Boolean);
  const allDay = e.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(e.start);
  return {
    external_id: e.id,
    title: (e.summary ?? "").trim().slice(0, 200) || "(no title)",
    ...(allDay ? { date: e.start.slice(0, 10) } : { start: e.start, ...(e.end && /T\d{2}:\d{2}/.test(e.end) ? { end: e.end } : {}) }),
    notes: eventNote(e.location, names, full ? 0 : (e.moreAttendees ?? 0)),
    ...(e.myResponse ? { my_response: e.myResponse } : {}),
    ...(full ? { attendees: others.map(({ name, email }) => ({ ...(name ? { name } : {}), ...(email ? { email } : {}) })) } : {}),
  };
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => (!a && !b) || (!!a && !!b && Date.parse(a) === Date.parse(b));

/**
 * Does Athena already hold this event as the calendar has it? Then saving it
 * again would change nothing, and is skipped. Compares what the save writes:
 * title, times, the one-line note (which names the guests), your answer, the
 * calendar it's on, and that this collection holds it.
 */
export function unchanged(
  held: { title: string; date: string | null; starts_at: string | null; ends_at?: string | null; notes: string; source: string | null; rsvp_calendar?: string | null; calendar_connector_id?: string | null; calendar_id?: string | null },
  input: SaveEventInput,
  where: { source: string; connectorId: string; calendarId: string },
): boolean {
  if (held.source !== where.source || held.calendar_connector_id !== where.connectorId || held.calendar_id !== where.calendarId) return false;
  if (held.title.trim() !== input.title || held.notes.trim() !== input.notes) return false;
  if ((held.rsvp_calendar ?? "none") !== fromCalendar(input.my_response)) return false;
  if (input.date) return !held.starts_at && held.date === input.date;
  return sameInstant(held.starts_at, input.start) && (!input.end || sameInstant(held.ends_at, input.end));
}

/** A new title or time, against what Athena holds. */
export function moved(held: { title: string; date: string | null; starts_at: string | null }, input: SaveEventInput): boolean {
  if (held.title.trim() !== input.title) return true;
  return input.date ? !!held.starts_at || held.date !== input.date : !sameInstant(held.starts_at, input.start);
}

/** Connector ids in any enabled Calendar collection: a Meetings collection leaves their events to it. */
export async function calendarSyncAccounts(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const c of await listCollections()) if (c.recipe === "calendar-sync" && c.enabled) for (const id of c.connector_ids) ids.add(id);
  return ids;
}

/**
 * A Meetings collection's own event sync is off while an enabled Calendar
 * reads every one of its calendar accounts: Claude then writes only notes.
 * With an account Calendar doesn't read, Meetings keeps syncing (twins stop
 * the overlap becoming copies).
 */
export function coveredByCalendar(calendarIds: string[], covered: ReadonlySet<string>): boolean {
  return calendarIds.length > 0 && calendarIds.every((id) => covered.has(id));
}

export async function withoutCoveredSync<C extends Pick<Collection, "recipe" | "lookahead_days" | "connector_ids">>(collection: C): Promise<C> {
  if (collection.recipe !== "calendar-meetings" || collection.lookahead_days <= 0) return collection;
  const covered = await calendarSyncAccounts();
  if (!covered.size) return collection;
  const accounts = await Promise.all(collection.connector_ids.map((id) => getConnector(id).catch(() => null)));
  const calendars = accounts.filter((a) => a !== null && isCalendarProvider(a.provider)).map((a) => a!.id);
  return coveredByCalendar(calendars, covered) ? { ...collection, lookahead_days: 0 } : collection;
}

// ---------- A run (runner.ts) ----------

export interface CalendarSyncRun {
  status: "succeeded" | "failed";
  summary: string;
  error?: string;
  stats: RunStatsJson;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** "2 new, 1 changed, 1 cancelled", or "Up to date" (collection-words.ts says it the same way). */
export function calendarSyncLine(n: { created: number; changed: number; archived: number }): string {
  const parts = [n.created ? `${n.created.toLocaleString("en-GB")} new` : "", n.changed ? `${n.changed.toLocaleString("en-GB")} changed` : "", n.archived ? `${n.archived.toLocaleString("en-GB")} cancelled` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Up to date";
}

interface Listed {
  open: OpenConnector;
  event: ListedEvent & { id: string; start: string };
  calendarId: string;
}

/** Every page of list_events across the range, or null when it failed (nothing is archived for that account then). */
async function listAll(open: OpenConnector, writer: CalendarWriter, from: string, to: string, tz: string): Promise<ListedEvent[] | null> {
  const out: ListedEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args: Record<string, unknown> = { startTime: from, endTime: to, timeZone: tz, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) };
    const r = await callTool(open, "list_events", args, { full: true });
    if (r.isError) return null;
    writer.noteCalendarResult(open.connector, args, r.text);
    let body: { events?: ListedEvent[]; nextPageToken?: string };
    try {
      body = JSON.parse(r.text) as typeof body;
    } catch {
      return null;
    }
    if (!Array.isArray(body.events)) return null;
    out.push(...body.events);
    if (!body.nextPageToken) return out;
    pageToken = body.nextPageToken;
  }
  // More pages than a run reads: save what came, but don't take anything missing as gone.
  return null;
}

/**
 * The first time this collection sees an event a Meetings collection synced,
 * it points at that record instead of making another (and keeps your
 * decision if you archived or deleted it).
 */
async function adopt(source: string, externalId: string, title: string, day: string, runId: string): Promise<void> {
  if (await getCollected(source, "event", externalId)) return;
  const [theirs] = await collectedByRecipe("calendar-meetings", "event", externalId, source);
  if (!theirs) return;
  await recordCollected({ source, kind: "event", externalId, recordId: theirs.record_id, title, itemDate: day, runId });
  if (theirs.archived_by_collector) await setArchivedByCollector(source, "event", externalId, true);
}

/** One run: each chosen calendar account, read and saved without a model. Counts only in the summary. */
export async function runCalendarSync(
  collection: Pick<Collection, "connector_ids" | "source" | "lookahead_days">,
  runId: string,
  writer: CalendarWriter,
  opts: { now: Date; tz: string },
): Promise<CalendarSyncRun> {
  const { now, tz } = opts;
  const source = collection.source;
  const today = zonedToday(now, tz);
  const last = addDays(today, Math.max(1, collection.lookahead_days));
  writer.checksStyle = false;

  const opened: OpenConnector[] = [];
  const blocked: string[] = [];
  const notes: string[] = [];
  const listedFrom = new Set<string>();
  const listed: Listed[] = [];
  let accounts = 0;
  let checked = 0;
  let failed = 0;
  const n = { created: 0, changed: 0, unchanged: 0, archived: 0, skipped: 0, errors: 0 };

  try {
    for (const id of collection.connector_ids) {
      const c = await getConnector(id).catch(() => null);
      if (!c || !isCalendarProvider(c.provider)) continue;
      accounts++;
      if (c.status === "needs_auth" || c.status === "pending") {
        blocked.push(id);
        continue;
      }
      let open: OpenConnector;
      try {
        open = await openConnector(id);
      } catch (error) {
        if (error instanceof ConnectorNeedsSignIn) blocked.push(id);
        else {
          failed++;
          notes.push(`Couldn't reach ${c.name}`);
        }
        continue;
      }
      opened.push(open);
      // Athena's own calendar adapters only: another server's JSON isn't one this reads.
      const tools = open.direct ? new Set((await listAllowedTools(open)).map((t) => t.name)) : new Set<string>();
      if (!tools.has("list_events")) {
        notes.push(open.direct ? `${c.name}: allow list_events under What Athena can read` : `${c.name} isn't read through Athena's own calendar connection`);
        continue;
      }
      if (!tools.has("get_event")) notes.push(`${c.name}: allow get_event so cancelled events are taken off`);
      writer.providers.push(c.provider);
      const events = await listAll(open, writer, today, addDays(last, 1), tz).catch((error) => {
        console.error("Athena calendar sync: a listing failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
        return null;
      });
      if (!events) {
        failed++;
        notes.push(`Couldn't read all of ${c.name}`);
        continue;
      }
      await markConnectorUsed(id);
      checked++;
      if (tools.has("get_event")) listedFrom.add(id);
      for (const e of events) {
        if (skipReason(e)) continue;
        listed.push({ open, event: e as Listed["event"], calendarId: e.calendarId || "primary" });
      }
    }

    // ---- save ----
    const seen = new Set<string>();
    let detailFetches = 0;
    let createsFull = false;
    for (const { open, event, calendarId } of listed) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      let input = saveInput(event);
      // A big invite comes listed with only some of its guests: read it whole, or leave its links as they are.
      if (event.moreAttendees && detailFetches < MAX_DETAIL_FETCHES) {
        detailFetches++;
        const r = await callTool(open, "get_event", { eventId: event.id, ...(calendarId !== "primary" ? { calendarId } : {}) }, { full: true }).catch(() => null);
        try {
          const whole = r && !r.isError ? (JSON.parse(r.text) as ListedEvent) : null;
          if (whole?.id === event.id && Array.isArray(whole.attendees)) input = saveInput({ ...event, attendees: whole.attendees, moreAttendees: undefined }, true);
        } catch {
          /* listed guests only: links stay as they are */
        }
      }
      const day = input.start ? zonedParts(new Date(input.start), tz).date : input.date!;
      if (day < addDays(today, -1) || day > last) continue;
      try {
        await adopt(source, event.id, input.title, day, runId);
        const prev = await getCollected(source, "event", event.id);
        const held = prev?.state === "live" ? await getEvent(prev.record_id) : null;
        if (held && unchanged(held, input, { source, connectorId: open.connector.id, calendarId })) {
          n.unchanged++;
          continue;
        }
        if (!prev && createsFull) continue;
        const out = JSON.parse(await writer.run("athena_save_event", input)) as { action?: string };
        if (out.action === "created") n.created++;
        // "Changed" is a new time or title, or one back from cancelled; a new guest or room is saved without saying so.
        else if (out.action === "restored" || (out.action === "updated" && (!held || moved(held, input)))) n.changed++;
        else if (out.action === "updated") n.unchanged++;
        else n.skipped++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        // The writer's cap on new events a run: the rest come next run.
        if (/^Event limit/.test(message)) createsFull = true;
        else {
          n.errors++;
          console.error("Athena calendar sync: an event wasn't saved", message.slice(0, 200));
        }
      }
    }

    // ---- cancelled and deleted ----
    const held = (await listCollected(source, "event", today, last, 1000)).filter((i) => i.state === "live" && !seen.has(i.external_id));
    for (const item of held) {
      const ev = await getEvent(item.record_id);
      const from = ev?.calendar_connector_id ?? null;
      const open = from && listedFrom.has(from) ? opened.find((o) => o.connector.id === from) : undefined;
      if (!ev || !open) continue;
      const r = await callTool(open, "get_event", { eventId: item.external_id, ...(ev.calendar_id && ev.calendar_id !== "primary" ? { calendarId: ev.calendar_id } : {}) }, { full: true }).catch(() => null);
      if (!r) continue;
      let reason: string | null = null;
      if (r.isError) reason = NOT_FOUND.test(r.text.trim()) ? "deleted" : null;
      else {
        try {
          reason = (JSON.parse(r.text) as ListedEvent).status === "cancelled" ? "cancelled" : null;
        } catch {
          reason = null;
        }
      }
      if (!reason) continue;
      try {
        const out = JSON.parse(await writer.run("athena_archive_collected", { kind: "event", external_id: item.external_id, reason })) as { action?: string };
        if (out.action === "archived") n.archived++;
      } catch {
        // The writer's cap on archives a run: the rest go next run.
        break;
      }
    }

    // A meeting's note (from Meetings) and its event (from here) link up, whichever came first.
    await linkCollectedMeetings(source).catch((error) => console.error("Athena calendar sync: linking meeting notes failed", error instanceof Error ? error.message : "unknown error"));
  } finally {
    for (const o of opened) await o.close().catch(() => undefined);
  }

  if (n.errors) notes.push(`${plural(n.errors, "event", "events")} couldn't be saved`);
  const stats: RunStatsJson = {
    calendar_events: listed.length,
    events_created: n.created,
    events_changed: n.changed,
    events_unchanged: n.unchanged,
    archived: n.archived,
    accounts_checked: checked,
    ...(blocked.length ? { blocked_by: blocked } : {}),
  };
  const summary = [calendarSyncLine(n), ...notes].join(". ");
  if (!accounts) return { status: "failed", summary: "", error: "None of the accounts is a calendar. Add Google Calendar, Outlook or iCloud Calendar.", stats };
  if (!checked && blocked.length === accounts) return { status: "failed", summary, error: "Every calendar needs signing in again.", stats };
  if (!checked && failed) return { status: "failed", summary, error: notes.join(". "), stats };
  return { status: "succeeded", summary, stats };
}
