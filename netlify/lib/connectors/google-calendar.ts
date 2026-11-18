/**
 * Google Calendar's tools for google-direct.ts, over the Calendar API
 * (www.googleapis.com/calendar/v3). The same names and arguments as Google's
 * Calendar MCP server; output is compact JSON for Claude:
 *
 *  - recurring events are expanded into their occurrences (singleEvents), in
 *    start order, each with its own id;
 *  - timed events keep their start and end exactly as the calendar gives
 *    them, with the offset; all-day events have dates and `allDay: true`;
 *  - lists give each event's essentials (who, when, where, the owner's own
 *    reply); get_event adds the description and the rest;
 *  - long listings come in pages, never cut off mid-way.
 *
 * Every request is a GET, except respond_to_event's one attendee patch (your
 * own reply, nothing else), offered only for an account that's allowed to
 * answer invites (canRsvp); free_busy's freeBusy POST (a read: guests' busy
 * times, never what they're doing); and move_event's start-and-end patch,
 * only for an event you organise; create_event's insert of one new event
 * (isCreateInsert) and undo_create_event's delete of one Athena added
 * (isCreatedDelete, checked against calendar_creates). Those three are
 * offered only with "Let Athena add and update events" on (canMove).
 */
import { CREATE_TOOL, FREE_BUSY_TOOL, GOOGLE_API_URL, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { CREATE_SCHEMA, readCreateArgs, type CreatedOut } from "./calendar-create";
import { isValidTimeZone, zonedToInstant } from "../../../lib/dates";
import { FOCUS_TIME_PROPERTIES, GoogleApiError, ToolInputError, apiUrl, arg, clean, clip, htmlToText, mapLimit, type DirectTool, type GoogleContext } from "./google-api";
import { MAIN_ONLY, isChosen, pickChosen, type CalendarChoice, type ChosenCalendar } from "./calendar-choice";

const CAL = GOOGLE_API_URL["google-calendar"];
const enc = encodeURIComponent;

/** What one listing returns at most (characters of JSON), so it never needs truncating. */
const LIST_BUDGET = 18_000;
/** Google's page size: fixed, so a page token always means the same page. */
const GOOGLE_PAGE = 100;
const MAX_GOOGLE_PAGES = 5;
const LIST_ATTENDEES = 15;

const EVENT_TYPES = ["EVENT_TYPE_UNSPECIFIED", "DEFAULT", "OUT_OF_OFFICE", "FOCUS_TIME", "WORKING_LOCATION", "BIRTHDAY", "FROM_GMAIL"] as const;
const API_EVENT_TYPE: Record<(typeof EVENT_TYPES)[number], string> = {
  EVENT_TYPE_UNSPECIFIED: "default",
  DEFAULT: "default",
  OUT_OF_OFFICE: "outOfOffice",
  FOCUS_TIME: "focusTime",
  WORKING_LOCATION: "workingLocation",
  BIRTHDAY: "birthday",
  FROM_GMAIL: "fromGmail",
};
/** Like Google's MCP server: working-location markers and birthdays only when asked for. */
const DEFAULT_TYPES = new Set(["default", "outOfOffice", "focusTime", "fromGmail"]);

interface Attendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
}
interface When {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}
export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: When;
  end?: When;
  eventType?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Attendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  recurringEventId?: string;
  recurrence?: string[];
  attachments?: Array<{ title?: string }>;
  updated?: string;
  transparency?: string;
}

// ---------- Times ----------

/**
 * A time the model gave: with an offset or Z it's that instant; without one
 * (2026-11-07T09:00, or a bare date) it's wall-clock time in `tz`, the
 * owner's calendar zone, as Google's MCP server read it.
 */
export function toInstant(raw: string, tz: string, what: string): Date {
  const s = raw.trim();
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (local) return new Date(zonedToInstant(local[1], local[2] ?? "00:00", tz).getTime() + Number(local[3] ?? 0) * 1000);
  const at = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? Date.parse(s) : NaN;
  if (Number.isNaN(at)) throw new ToolInputError(`${what} must be an ISO 8601 time, like 2026-11-07T09:00:00`);
  return new Date(at);
}

/** When an event starts, as an instant (all-day events at UTC midnight: close enough to sort by). */
function startMs(e: CalendarEvent): number {
  const s = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : "");
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---------- Output ----------

const RESPONSE: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "maybe", needsAction: "no reply yet" };

/** "Priya Shah <priya@example.com> (organiser): accepted" */
function attendeeLine(a: Attendee): string {
  const who = a.displayName && a.email ? `${a.displayName} <${a.email}>` : (a.email ?? a.displayName ?? "someone");
  const tags = [a.self ? "you" : "", a.organizer ? "organiser" : "", a.optional ? "optional" : ""].filter(Boolean);
  return `${who}${tags.length ? ` (${tags.join(", ")})` : ""}: ${RESPONSE[a.responseStatus ?? ""] ?? a.responseStatus ?? "no reply yet"}`;
}

function meetLink(e: CalendarEvent): string | undefined {
  return e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
}

/** One event: its essentials in a list, everything useful with `detail`. */
export function eventOut(e: CalendarEvent, detail: boolean) {
  const people = (e.attendees ?? []).filter((a) => !a.resource);
  const cap = detail ? 100 : LIST_ATTENDEES;
  const organizer = e.organizer && !e.organizer.self ? (e.organizer.displayName ? `${e.organizer.displayName} <${e.organizer.email}>` : e.organizer.email) : undefined;
  return clean({
    id: e.id,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay: e.start?.date && !e.start.dateTime ? true : undefined,
    status: e.status && e.status !== "confirmed" ? e.status : undefined,
    eventType: e.eventType && e.eventType !== "default" ? e.eventType : undefined,
    free: e.transparency === "transparent" ? true : undefined,
    location: e.location ? clip(e.location, 200) : undefined,
    organizer,
    myResponse: RESPONSE[people.find((a) => a.self)?.responseStatus ?? ""],
    attendees: people.slice(0, cap).map(attendeeLine),
    moreAttendees: people.length > cap ? people.length - cap : undefined,
    meetLink: meetLink(e),
    description: detail && e.description ? clip(htmlToText(e.description.slice(0, 60_000)), 3_000) : undefined,
    recurringEventId: detail ? e.recurringEventId : undefined,
    recurrence: detail ? e.recurrence : undefined,
    attachments: detail ? (e.attachments ?? []).map((a) => a.title ?? "").filter(Boolean) : undefined,
    updated: detail ? e.updated : undefined,
    htmlLink: e.htmlLink,
  });
}

// ---------- Paging: Athena's own page tokens, so a page can end mid-way through one of Google's ----------

interface Position {
  /** Google's page token (none for the first page). */
  p?: string;
  /** Events already returned from that page, or (search) from the sorted results. */
  s: number;
}

function readToken(raw: string | undefined): Position {
  if (!raw) return { s: 0 };
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Position;
    if (typeof v.s === "number" && v.s >= 0 && (v.p === undefined || typeof v.p === "string")) return v;
  } catch {
    // fall through
  }
  throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
}

const makeToken = (pos: Position) => Buffer.from(JSON.stringify(pos), "utf8").toString("base64url");

type EventsPage = { items?: CalendarEvent[]; nextPageToken?: string; timeZone?: string };

/**
 * Walk Google's pages from `from`, keeping events `keep` accepts, until there
 * are `want` of them or the JSON would get too long; returns where to carry on.
 */
async function collect(
  ctx: GoogleContext,
  url: (pageToken?: string) => string,
  from: Position,
  want: number,
  keep: (e: CalendarEvent) => boolean,
): Promise<{ events: ReturnType<typeof eventOut>[]; next?: string; timeZone?: string }> {
  const events: ReturnType<typeof eventOut>[] = [];
  let size = 0;
  let token = from.p;
  let skip = from.s;
  let timeZone: string | undefined;
  for (let pages = 0; pages < MAX_GOOGLE_PAGES; pages++) {
    const page = await ctx.get<EventsPage>(url(token));
    timeZone ??= page.timeZone;
    const items = page.items ?? [];
    for (let i = skip; i < items.length; i++) {
      if (events.length >= want || size > LIST_BUDGET) return { events, timeZone, next: makeToken({ p: token, s: i }) };
      if (!keep(items[i])) continue;
      const e = eventOut(items[i], false);
      events.push(e);
      size += JSON.stringify(e).length;
    }
    skip = 0;
    if (!page.nextPageToken) return { events, timeZone };
    token = page.nextPageToken;
    if (events.length >= want || size > LIST_BUDGET) break;
  }
  return { events, timeZone, next: makeToken({ p: token, s: 0 }) };
}

function zoneFor(ctx: GoogleContext, args: Record<string, unknown>): string {
  const tz = arg.str(args, "timeZone", { max: 64 });
  if (tz && !isValidTimeZone(tz)) throw new ToolInputError(`timeZone "${tz}" isn't an IANA time zone, like Europe/London`);
  return tz ?? ctx.timeZone ?? "UTC";
}

// ---------- The calendars the owner chose (calendar-choice.ts) ----------

type ListedCalendar = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  selected?: boolean;
  description?: string;
  backgroundColor?: string;
};

const LIST_FIELDS = "items(id,summary,summaryOverride,primary,accessRole,timeZone,selected,description,backgroundColor),nextPageToken";

/** Every calendar in the owner's list (their own and ones they subscribe to), up to 750. */
export async function readCalendarList(ctx: Pick<GoogleContext, "get">): Promise<ListedCalendar[]> {
  const out: ListedCalendar[] = [];
  let pageToken: string | undefined;
  for (let pages = 0; pages < 3; pages++) {
    const r = await ctx.get<{ items?: ListedCalendar[]; nextPageToken?: string }>(apiUrl(CAL, "/users/me/calendarList", { maxResults: 250, pageToken, fields: LIST_FIELDS }));
    out.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const nameOf = (c: ListedCalendar) => c.summaryOverride || c.summary || c.id;

/** The calendars switched on, for openGoogle: the primary alone until the owner chooses. */
export async function chosenGoogleCalendars(ctx: Pick<GoogleContext, "get">, chosen: readonly string[] | null | undefined): Promise<ChosenCalendar[]> {
  if (!chosen) return MAIN_ONLY;
  return pickChosen(await readCalendarList(ctx), chosen).map((c) => ({ id: c.id, name: nameOf(c), primary: !!c.primary }));
}

const chosenOf = (ctx: GoogleContext) => (ctx.calendars ? ctx.calendars() : Promise.resolve(MAIN_ONLY));

const notRead = (id: string) => new ToolInputError(`Not found: Athena doesn't read the calendar ${id}. list_calendars shows the ones it reads`);

/** Every event on one calendar in the range, up to Google's page limit, for listings that merge calendars. */
async function allIn(ctx: GoogleContext, calendarId: string, params: Record<string, string | number | boolean | undefined>): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let pages = 0; pages < MAX_GOOGLE_PAGES; pages++) {
    const page = await ctx.get<EventsPage>(apiUrl(CAL, `/calendars/${enc(calendarId)}/events`, { ...params, singleEvents: true, maxResults: 250, pageToken }));
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** One page of events merged from several calendars, each saying which calendar it's on (and its id, for get_event). */
function mergedPage(found: Array<{ e: CalendarEvent; cal: ChosenCalendar }>, offset: number, want: number) {
  const events: Record<string, unknown>[] = [];
  let size = 0;
  let i = offset;
  for (; i < found.length && events.length < want && size <= LIST_BUDGET; i++) {
    const e = { ...eventOut(found[i].e, false), calendar: found[i].cal.name, calendarId: found[i].cal.id };
    events.push(e);
    size += JSON.stringify(e).length;
  }
  return { events, next: i < found.length ? makeToken({ s: i }) : undefined };
}

const DAY = 86_400_000;

/**
 * Every calendar on the account for the owner to choose from (GET
 * /api/connectors/:id/calendars): colour, whether it's shared or
 * subscribed, and how many events it has in the next 30 days.
 */
export async function googleCalendarChoices(ctx: GoogleContext, chosen: readonly string[] | null | undefined): Promise<CalendarChoice[]> {
  const all = await readCalendarList(ctx);
  const on = new Set(pickChosen(all, chosen).map((c) => c.id));
  const from = ctx.now().getTime();
  const counts = await mapLimit(all, 3, (c) =>
    ctx
      .get<EventsPage>(
        apiUrl(CAL, `/calendars/${enc(c.id)}/events`, {
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(from + 30 * DAY).toISOString(),
          singleEvents: true,
          maxResults: 250,
          fields: "items(status,eventType)",
        }),
      )
      .then((p) => (p.items ?? []).filter((e) => e.status !== "cancelled" && DEFAULT_TYPES.has(e.eventType ?? "default")).length)
      .catch(() => 0),
  );
  return all.map((c, i) => {
    // Public calendars (holidays, sports) have ids like en.uk#holiday@group.v.calendar.google.com.
    const subscribed = /#|@group\.v\.calendar\.google\.com$/.test(c.id);
    const shared = !c.primary && c.accessRole !== "owner" && !subscribed;
    // Someone's own calendar shared with you has their address as its id, and usually their name.
    const person = shared && c.id.includes("@") && !/\.calendar\.google\.com$/.test(c.id);
    return clean({
      id: c.id,
      name: nameOf(c),
      color: c.backgroundColor,
      primary: c.primary || undefined,
      shared,
      owner: person && nameOf(c) !== c.id ? nameOf(c) : undefined,
      sharedByYou: false,
      subscribed: subscribed || undefined,
      upcoming: counts[i],
      chosen: on.has(c.id),
    }) as CalendarChoice;
  });
}

// ---------- Tools ----------

const listCalendars: DirectTool = {
  name: "list_calendars",
  summary: "See your calendars",
  description:
    "List the calendars the owner has in Google Calendar (their own and ones they subscribe to): each one's id (use it as calendarId), name, whether it's their primary calendar, their access and its time zone.",
  inputSchema: {
    type: "object",
    properties: {
      pageSize: { type: "integer", description: "1–250 (default 100)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const r = await ctx.get<{ items?: ListedCalendar[]; nextPageToken?: string }>(
      apiUrl(CAL, "/users/me/calendarList", {
        maxResults: arg.int(args, "pageSize", { min: 1, max: 250, fallback: 100 }),
        pageToken: arg.str(args, "pageToken", { max: 500 }),
        fields: LIST_FIELDS,
      }),
    );
    // Only the calendars the owner lets Athena read.
    const chosen = await chosenOf(ctx);
    const calendars = (r.items ?? []).filter((c) => chosen.some((x) => x.id === c.id || (!!c.primary && x.id === "primary"))).map((c) =>
      clean({
        id: c.id,
        summary: c.summaryOverride || c.summary,
        primary: c.primary || undefined,
        accessRole: c.accessRole,
        timeZone: c.timeZone,
        hidden: c.selected === false ? true : undefined,
        description: c.description ? clip(c.description, 200) : undefined,
      }),
    );
    return clean({ calendars, nextPageToken: r.nextPageToken });
  },
};

const listEvents: DirectTool = {
  name: "list_events",
  summary: "See events in a date range",
  description:
    "List events on the owner's calendars in a time range, in start order, with recurring events as separate occurrences. " +
    "By default this reads every calendar the owner lets Athena read, and when that's more than one, says which calendar each event is on (calendar, calendarId); give calendarId for just one. " +
    "Default range: from now for 7 days. Times without an offset (2026-11-07T09:00:00) are in the owner's calendar time zone unless timeZone says otherwise. " +
    "Each event has its id, summary, start and end (timed: with their offset; all-day: dates, with the end date the day after it finishes, and allDay true), status when not confirmed (cancelled, tentative), " +
    "location, organiser, attendees with their replies, the owner's own reply (myResponse), meeting link and htmlLink. Descriptions aren't included: use get_event for those. " +
    "Working-location markers and birthdays are left out unless eventType asks for them. If nextPageToken comes back, call again with it for the rest.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "A calendar's id from list_calendars, for just that one. Default (or \"primary\"): every calendar Athena reads." },
      startTime: { type: "string", description: "Start of the range, ISO 8601. Default: now." },
      endTime: { type: "string", description: "End of the range, ISO 8601, after startTime. Default: startTime + 7 days." },
      fullText: { type: "string", description: "Only events containing these words (title, description, location, attendees)." },
      eventType: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] } },
      orderBy: { type: "string", description: "startTime (default) or lastModified." },
      pageSize: { type: "integer", description: "Events to return, 1–250 (default 50)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
      timeZone: { type: "string", description: "IANA zone for times given without an offset, e.g. Europe/Zurich." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const asked = arg.str(args, "calendarId", { max: 300 });
    const chosen = await chosenOf(ctx);
    if (asked && asked !== "primary" && !isChosen(chosen, asked, ctx.email)) throw notRead(asked);
    // By default every calendar the owner switched on: the primary alone until they choose more.
    const cals = asked && asked !== "primary" ? [{ id: asked, name: "", primary: false }] : chosen;
    const calendarId = cals[0].id;
    const tz = zoneFor(ctx, args);
    const start = arg.str(args, "startTime", { max: 60 });
    const end = arg.str(args, "endTime", { max: 60 });
    const timeMin = start ? toInstant(start, tz, "startTime") : ctx.now();
    const timeMax = end ? toInstant(end, tz, "endTime") : new Date(timeMin.getTime() + 7 * 86_400_000);
    if (timeMax.getTime() <= timeMin.getTime()) throw new ToolInputError("endTime must be after startTime");
    const types = arg.strings(args, "eventType", 10).map((t) => {
      if (!(t in API_EVENT_TYPE)) throw new ToolInputError(`eventType must be one of ${EVENT_TYPES.join(", ")}`);
      return API_EVENT_TYPE[t as keyof typeof API_EVENT_TYPE];
    });
    const wanted = types.length ? new Set(types) : DEFAULT_TYPES;
    const orderBy = arg.str(args, "orderBy", { max: 40 }) === "lastModified" ? "updated" : "startTime";
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 250, fallback: 50 });
    const from = readToken(arg.str(args, "pageToken", { max: 2000 }));
    const q = arg.str(args, "fullText", { max: 500 });
    const keep = (e: CalendarEvent) => wanted.has(e.eventType ?? "default");
    if (cals.length > 1) {
      const params = { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), orderBy, q, timeZone: arg.str(args, "timeZone") };
      const lists = await mapLimit(cals, 3, async (cal) => (await allIn(ctx, cal.id, params)).filter(keep).map((e) => ({ e, cal })));
      const at = (e: CalendarEvent) => Date.parse(e.updated ?? "") || 0;
      const found = lists.flat().sort(orderBy === "updated" ? (a, b) => at(b.e) - at(a.e) : (a, b) => startMs(a.e) - startMs(b.e));
      const p = mergedPage(found, from.s, pageSize);
      return clean({ events: p.events, timeZone: ctx.timeZone, nextPageToken: p.next });
    }
    const page = await collect(
      ctx,
      (pageToken) =>
        apiUrl(CAL, `/calendars/${enc(calendarId)}/events`, {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy,
          maxResults: GOOGLE_PAGE,
          q,
          timeZone: arg.str(args, "timeZone"),
          pageToken,
        }),
      from,
      pageSize,
      keep,
    );
    return clean({ events: page.events, timeZone: page.timeZone, nextPageToken: page.next });
  },
};

const searchEvents: DirectTool = {
  name: "search_events",
  summary: "Search your calendar",
  description:
    "Search every calendar the owner lets Athena read for events matching words (in the title, description, location or attendees), from a year ago to a year ahead. " +
    "The closest to today come first, past or upcoming; each with the same fields as list_events, including the calendar it's on when there's more than one. If nextPageToken comes back, call again with it for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for, e.g. a person's name or a project." },
      pageSize: { type: "integer", description: "Events to return, 1–100 (default 25)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const query = arg.str(args, "query", { required: true, max: 500 })!;
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 100, fallback: 25 });
    const offset = readToken(arg.str(args, "pageToken", { max: 2000 })).s;
    const now = ctx.now().getTime();
    const year = 365 * 86_400_000;
    // Every calendar the owner lets Athena read (the primary alone until they choose more).
    const cals = await chosenOf(ctx);
    const params = { q: query, timeMin: new Date(now - year).toISOString(), timeMax: new Date(now + year).toISOString(), orderBy: "startTime" };
    const lists = await mapLimit(cals, 3, async (cal) => (await allIn(ctx, cal.id, params)).filter((e) => DEFAULT_TYPES.has(e.eventType ?? "default")).map((e) => ({ e, cal })));
    const found = lists.flat().sort((a, b) => Math.abs(startMs(a.e) - now) - Math.abs(startMs(b.e) - now));
    if (cals.length > 1) {
      const p = mergedPage(found, offset, pageSize);
      return clean({ events: p.events, nextPageToken: p.next });
    }
    const events: ReturnType<typeof eventOut>[] = [];
    let size = 0;
    let i = offset;
    for (; i < found.length && events.length < pageSize && size <= LIST_BUDGET; i++) {
      const e = eventOut(found[i].e, false);
      events.push(e);
      size += JSON.stringify(e).length;
    }
    return clean({ events, nextPageToken: i < found.length ? makeToken({ s: i }) : undefined });
  },
};

const getEvent: DirectTool = {
  name: "get_event",
  summary: "Read one event in full",
  description:
    "Read one calendar event in full by its id: everything list_events gives plus its description, every attendee, recurrence and attachments. " +
    "A cancelled event comes back with status cancelled; one that was deleted comes back as not found.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "The calendarId list_events gave with the event. Default: every calendar Athena reads, the primary first." },
      eventId: { type: "string", description: "The event's id, from list_events or search_events." },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const asked = arg.str(args, "calendarId", { max: 300 });
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    const chosen = await chosenOf(ctx);
    if (asked && asked !== "primary" && !isChosen(chosen, asked, ctx.email)) throw notRead(asked);
    // Without a calendarId, each calendar Athena reads in turn, the primary first.
    const cals = asked && asked !== "primary" ? [{ id: asked, name: "" }] : chosen;
    for (const cal of cals) {
      try {
        const e = eventOut(await ctx.get<CalendarEvent>(apiUrl(CAL, `/calendars/${enc(cal.id)}/events/${enc(eventId)}`)), true);
        return cals.length > 1 ? { ...e, calendar: cal.name, calendarId: cal.id } : e;
      } catch (error) {
        if (!(error instanceof GoogleApiError && (error.status === 404 || error.status === 410))) throw error;
      }
    }
    throw new ToolInputError(`Not found: there's no event ${eventId} on ${cals.length > 1 ? "the calendars Athena reads" : "that calendar"}. It may have been deleted`);
  },
};

const REPLY: Record<string, "accepted" | "tentative" | "declined" | "needsAction"> = { going: "accepted", maybe: "tentative", declined: "declined", none: "needsAction" };

/**
 * Your reply to one invite: Google's attendee patch with only you in it
 * (attendeesOmitted), so nothing else about the event can change. The
 * organiser is told, as when you answer in Google Calendar.
 */
const respondToEvent: DirectTool = {
  name: RSVP_TOOL,
  summary: "Answer an invite",
  description: "Set the owner's own reply to one invite: going, maybe or declined. Changes nothing else about the event.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "Default: the primary calendar." },
      eventId: { type: "string" },
      answer: { type: "string", enum: ["going", "maybe", "declined", "none"] },
    },
    required: ["eventId", "answer"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { max: 300 }) ?? "primary";
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    const status = REPLY[arg.str(args, "answer", { required: true, max: 20 })!];
    if (!status) throw new ToolInputError("answer must be going, maybe or declined");
    if (!ctx.patchRsvp) throw new ToolInputError("This account isn't allowed to answer invites");
    const url = apiUrl(CAL, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    let e: CalendarEvent;
    try {
      e = await ctx.get<CalendarEvent>(apiUrl(CAL, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { fields: "id,status,attendees(email,self,organizer,responseStatus)" }));
    } catch (error) {
      if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) throw new ToolInputError("Google Calendar doesn't have this event any more");
      throw error;
    }
    if (e.status === "cancelled") throw new ToolInputError("This event was cancelled");
    const me = e.attendees?.find((a) => a.self);
    if (!me?.email) throw new ToolInputError("You aren't a guest on this event, so there's no invite to answer");
    await ctx.patchRsvp(`${url}?sendUpdates=all`, { attendeesOmitted: true, attendees: [{ email: me.email, responseStatus: status }] });
    return { id: e.id, myResponse: RESPONSE[status] };
  },
};

// ---------- Free/busy and moving ----------

/** One guest's busy times as Google gives them: busy or free, never what or where. */
export interface GuestFreeBusy {
  email: string;
  /** "known": Google showed their calendar; "unknown": it didn't (not shared, outside the organisation, no such calendar). */
  status: "known" | "unknown";
  busy: Array<{ start: string; end: string }>;
}

/** Google's freeBusy reply, read: start and end of each busy time, and whether each calendar could be seen. */
export function parseFreeBusy(reply: unknown, emails: string[]): GuestFreeBusy[] {
  const calendars = ((reply as { calendars?: Record<string, { busy?: Array<{ start?: unknown; end?: unknown }>; errors?: unknown[] }> } | null)?.calendars ?? {}) as Record<
    string,
    { busy?: Array<{ start?: unknown; end?: unknown }>; errors?: unknown[] }
  >;
  const byLower = new Map(Object.entries(calendars).map(([k, v]) => [k.toLowerCase(), v]));
  return emails.map((email) => {
    const c = byLower.get(email.toLowerCase());
    if (!c || (Array.isArray(c.errors) && c.errors.length)) return { email, status: "unknown", busy: [] };
    const busy = (Array.isArray(c.busy) ? c.busy : [])
      .filter((b) => typeof b?.start === "string" && typeof b?.end === "string" && Number.isFinite(Date.parse(b.start as string)) && Number.isFinite(Date.parse(b.end as string)))
      .map((b) => ({ start: new Date(Date.parse(b.start as string)).toISOString(), end: new Date(Date.parse(b.end as string)).toISOString() }));
    return { email, status: "known", busy };
  });
}

const freeBusy: DirectTool = {
  name: FREE_BUSY_TOOL,
  summary: "See when people are busy",
  description: "When each of up to 20 people is busy in a time range, from Google's free/busy. Busy or free only: never what, where or with whom. status unknown means Google didn't show that calendar.",
  inputSchema: {
    type: "object",
    properties: {
      emails: { type: "array", items: { type: "string" }, description: "Addresses, up to 20." },
      startTime: { type: "string", description: "ISO 8601." },
      endTime: { type: "string", description: "ISO 8601, after startTime, at most 31 days later." },
    },
    required: ["emails", "startTime", "endTime"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const emails = arg.strings(args, "emails", 20).map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e));
    if (!emails.length) throw new ToolInputError("emails: at least one address");
    const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
    const from = toInstant(arg.str(args, "startTime", { required: true, max: 60 })!, tz, "startTime");
    const to = toInstant(arg.str(args, "endTime", { required: true, max: 60 })!, tz, "endTime");
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 31 * 86_400_000) throw new ToolInputError("endTime must be after startTime, and within 31 days of it");
    if (!ctx.freeBusy) throw new ToolInputError("This account can't read free/busy");
    const reply = await ctx.freeBusy({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: emails.map((id) => ({ id })) });
    return { people: parseFreeBusy(reply, emails) };
  },
};

/** A Google start or end at a new instant, in the event's own zone when it has one (so a repeating rule or a guest's view keeps its zone). */
function whenAt(at: Date, was: When | undefined): { dateTime: string; timeZone?: string } {
  const dateTime = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return was?.timeZone ? { dateTime, timeZone: was.timeZone } : { dateTime };
}

/**
 * A new start and end for one event the owner organises, and nothing else:
 * one PATCH with only start and end (isMovePatch), sendUpdates=all so guests
 * get Google's update. Refused for an event someone else organises, an
 * all-day event, a whole repeating series, or a cancelled one. `expect` (the
 * start Athena last saw) refuses a move when the event has moved since.
 */
const moveEvent: DirectTool = {
  name: MOVE_TOOL,
  summary: "Move one of your events",
  description: "Give an event the owner organises a new start and end. Changes nothing else; guests get Google's update.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "Default: the primary calendar." },
      eventId: { type: "string" },
      start: { type: "string", description: "New start, ISO 8601 with offset." },
      end: { type: "string", description: "New end. Default: the same length as now." },
      expect: { type: "string", description: "The start Athena last saw: refused if the event has moved since." },
    },
    required: ["eventId", "start"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { max: 300 }) ?? "primary";
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    if (!ctx.patchMove) throw new ToolInputError("This account isn't allowed to move events");
    const chosen = await chosenOf(ctx);
    if (calendarId !== "primary" && !isChosen(chosen, calendarId, ctx.email)) throw notRead(calendarId);
    const url = apiUrl(CAL, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    let e: CalendarEvent;
    try {
      e = await ctx.get<CalendarEvent>(apiUrl(CAL, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { fields: "id,status,summary,start,end,organizer,recurrence,attendees(self,resource)" }));
    } catch (error) {
      if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) throw new ToolInputError("Google Calendar doesn't have this event any more");
      throw error;
    }
    if (e.status === "cancelled") throw new ToolInputError("This event was cancelled");
    if (!e.organizer?.self) throw new ToolInputError("Someone else organises this event, so only they can move it");
    if (!e.start?.dateTime || !e.end?.dateTime) throw new ToolInputError("Athena only moves events with a start and end time, not all-day ones");
    if (e.recurrence?.length) throw new ToolInputError("This is a whole repeating series. Athena only moves one date at a time");
    const was = { start: new Date(Date.parse(e.start.dateTime)), end: new Date(Date.parse(e.end.dateTime)) };
    const expect = arg.str(args, "expect", { max: 60 });
    if (expect && Date.parse(expect) !== was.start.getTime()) throw new ToolInputError("This event has moved since Athena last looked. Check it and try again");
    const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
    const start = toInstant(arg.str(args, "start", { required: true, max: 60 })!, tz, "start");
    const rawEnd = arg.str(args, "end", { max: 60 });
    const end = rawEnd ? toInstant(rawEnd, tz, "end") : new Date(start.getTime() + (was.end.getTime() - was.start.getTime()));
    if (end.getTime() <= start.getTime()) throw new ToolInputError("end must be after start");
    const guests = (e.attendees ?? []).filter((a) => !a.self && !a.resource).length;
    if (start.getTime() !== was.start.getTime() || end.getTime() !== was.end.getTime()) {
      await ctx.patchMove(`${url}?sendUpdates=all`, { start: whenAt(start, e.start), end: whenAt(end, e.end) });
    }
    return { id: e.id, summary: e.summary ?? "", before: { start: was.start.toISOString(), end: was.end.toISOString() }, after: { start: start.toISOString(), end: end.toISOString() }, guests };
  },
};

const stampOf = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Add one event: events.insert with sendUpdates=all, so each guest gets
 * Google's invite. The body holds only a title, start and end (in the
 * owner's zone), a place, a description and guests (isCreateInsert).
 */
const createEvent: DirectTool = {
  name: CREATE_TOOL,
  summary: "Add an event",
  description: "Add one event to a calendar the owner chose, after they confirmed it in the app. Guests get Google's invite.",
  inputSchema: CREATE_SCHEMA,
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (!ctx.insertEvent) throw new ToolInputError("This account isn't allowed to add events");
    const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
    const a = readCreateArgs(args, tz, [ctx.email]);
    const calendarId = a.calendarId ?? "primary";
    const chosen = await chosenOf(ctx);
    if (calendarId !== "primary" && !isChosen(chosen, calendarId, ctx.email)) throw notRead(calendarId);
    const zone = a.timeZone ?? (tz === "UTC" ? undefined : tz);
    const created = await ctx.insertEvent<CalendarEvent>(`${CAL}/calendars/${enc(calendarId)}/events?sendUpdates=all`, {
      summary: a.summary,
      start: { dateTime: stampOf(a.start), ...(zone ? { timeZone: zone } : {}) },
      end: { dateTime: stampOf(a.end), ...(zone ? { timeZone: zone } : {}) },
      ...(a.location ? { location: a.location } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(a.attendees.length ? { attendees: a.attendees.map((g) => ({ email: g.email, ...(g.name ? { displayName: g.name } : {}) })) } : {}),
      // Google only allows Focus time on the main calendar; anywhere else a block is a plain busy event.
      ...(a.focusTime && calendarId === "primary" ? { eventType: "focusTime" as const, focusTimeProperties: FOCUS_TIME_PROPERTIES } : {}),
    });
    if (!created?.id) throw new ToolInputError("Google didn't say it added the event. Check Google Calendar before trying again");
    const out: CreatedOut = { id: created.id, calendarId, link: created.htmlLink ?? "", guests: a.attendees.length, summary: a.summary, start: a.start.toISOString(), end: a.end.toISOString() };
    return out;
  },
};

/**
 * Undo of create_event: delete that one event, with sendUpdates=all so guests
 * get a cancellation. Only for an event in calendar_creates; anything else is
 * refused before a request is made.
 */
const undoCreateEvent: DirectTool = {
  name: UNDO_CREATE_TOOL,
  summary: "Take back an event Athena added",
  description: "Delete one event Athena added, as the Undo on its receipt. Refused for any other event. Guests get a cancellation.",
  inputSchema: { type: "object", properties: { calendarId: { type: "string" }, eventId: { type: "string" } }, required: ["calendarId", "eventId"] },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { required: true, max: 300 })!;
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    if (!ctx.deleteCreated) throw new ToolInputError("This account isn't allowed to add or remove events");
    await ctx.deleteCreated(calendarId, eventId);
    return { id: eventId, deleted: true };
  },
};

export const CALENDAR_TOOLS: DirectTool[] = [listCalendars, listEvents, searchEvents, getEvent, respondToEvent, freeBusy, moveEvent, createEvent, undoCreateEvent];
