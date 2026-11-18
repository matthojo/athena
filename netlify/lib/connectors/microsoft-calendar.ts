/**
 * Outlook Calendar's tools for microsoft-direct.ts, over Microsoft Graph.
 * The same names, arguments and JSON fields as Athena's Google Calendar
 * tools (google-calendar.ts), so the meetings recipe and Ask read them
 * unchanged:
 *
 *  - recurring meetings are expanded into their occurrences (calendarView),
 *    each with its own id, in start order;
 *  - timed events give start and end in UTC with a Z (Graph is asked for
 *    UTC); all-day events give dates, the end being the day after, and
 *    `allDay: true`;
 *  - lists give each event's essentials; get_event adds the description
 *    (as plain text) and the rest; attachments are named, never read;
 *  - long listings come in pages, never cut off mid-way.
 *
 * Every request is a GET, except respond_to_event's one reply (accept,
 * tentativelyAccept or decline), offered only for an account that's allowed
 * to answer invites (canRsvp).
 */
import { isValidTimeZone } from "../../../lib/dates";
import { CREATE_TOOL, FREE_BUSY_TOOL, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { CREATE_SCHEMA, readCreateArgs, type CreatedOut } from "./calendar-create";
import { ToolInputError, arg, clean, clip, mapLimit, tidyText } from "./google-api";
import { MAIN_ONLY, isChosen, pickChosen, type CalendarChoice, type ChosenCalendar } from "./calendar-choice";
import { toInstant } from "./google-calendar";
import { GRAPH, GraphApiError, graphUrl, person, utcIso, type GraphContext, type GraphTool } from "./microsoft-graph";

const enc = encodeURIComponent;
const LIST_BUDGET = 18_000;
const GRAPH_PAGE = 100;
const MAX_GRAPH_PAGES = 5;
const LIST_ATTENDEES = 15;
const DAY = 86_400_000;

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

interface Attendee {
  type?: string;
  status?: { response?: string };
  emailAddress?: { name?: string; address?: string };
}
interface When {
  dateTime?: string;
  timeZone?: string;
}
export interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  start?: When;
  end?: When;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  type?: string;
  seriesMasterId?: string;
  recurrence?: { pattern?: { type?: string; interval?: number; daysOfWeek?: string[] }; range?: { type?: string; endDate?: string } } | null;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  isOrganizer?: boolean;
  attendees?: Attendee[];
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  webLink?: string;
  hasAttachments?: boolean;
  lastModifiedDateTime?: string;
  categories?: string[];
}

const LIST_FIELDS =
  "id,subject,bodyPreview,start,end,isAllDay,isCancelled,showAs,type,seriesMasterId,location,organizer,isOrganizer,attendees,responseStatus,onlineMeeting,onlineMeetingUrl,webLink,hasAttachments,lastModifiedDateTime";

// ---------- Output ----------

const RESPONSE: Record<string, string> = { accepted: "accepted", declined: "declined", tentativelyAccepted: "maybe", notResponded: "no reply yet", none: "no reply yet" };

function attendeeLine(a: Attendee, self: string): string {
  const who = person(a) || "someone";
  const you = !!self && a.emailAddress?.address?.toLowerCase() === self;
  const tags = [you ? "you" : "", a.type === "optional" ? "optional" : ""].filter(Boolean);
  return `${who}${tags.length ? ` (${tags.join(", ")})` : ""}: ${RESPONSE[a.status?.response ?? ""] ?? "no reply yet"}`;
}

/** Outlook's "free / busy / out of office" as Google's event types, where they match. */
function eventType(e: GraphEvent): string | undefined {
  return e.showAs === "oof" ? "outOfOffice" : undefined;
}

/** All-day events: Graph gives midnight-to-midnight; Google-style dates are wanted. */
const dateOnly = (w: When | undefined) => w?.dateTime?.slice(0, 10);

/** One event: its essentials in a list, everything useful with `detail`. */
export function eventOut(e: GraphEvent, self: string, detail: boolean, attachments?: string[]) {
  const people = (e.attendees ?? []).filter((a) => a.type !== "resource");
  const cap = detail ? 100 : LIST_ATTENDEES;
  const organiserAddress = e.organizer?.emailAddress?.address?.toLowerCase();
  const organizer = e.isOrganizer || (self && organiserAddress === self) ? undefined : person(e.organizer) || undefined;
  const mine = e.isOrganizer ? undefined : RESPONSE[e.responseStatus?.response ?? ""];
  return clean({
    id: e.id,
    summary: e.subject?.trim() || "(no title)",
    start: e.isAllDay ? dateOnly(e.start) : utcIso(e.start?.dateTime),
    end: e.isAllDay ? dateOnly(e.end) : utcIso(e.end?.dateTime),
    allDay: e.isAllDay ? true : undefined,
    status: e.isCancelled ? "cancelled" : e.showAs === "tentative" ? "tentative" : undefined,
    eventType: eventType(e),
    free: e.showAs === "free" ? true : undefined,
    location: e.location?.displayName ? clip(e.location.displayName, 200) : undefined,
    organizer,
    myResponse: mine,
    attendees: people.slice(0, cap).map((a) => attendeeLine(a, self)),
    moreAttendees: people.length > cap ? people.length - cap : undefined,
    meetLink: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? undefined,
    description: detail && e.body?.content ? clip(tidyText(e.body.content), 3_000) || undefined : undefined,
    recurringEventId: detail ? e.seriesMasterId : undefined,
    recurrence: detail && e.recurrence?.pattern ? [recurrenceLine(e.recurrence)] : undefined,
    attachments: detail ? attachments : undefined,
    updated: detail ? utcIso(e.lastModifiedDateTime) : undefined,
    htmlLink: e.webLink,
  });
}

/** "weekly every 1 on monday, wednesday until 2026-12-31" */
function recurrenceLine(r: NonNullable<GraphEvent["recurrence"]>): string {
  const p = r.pattern ?? {};
  const days = p.daysOfWeek?.length ? ` on ${p.daysOfWeek.join(", ")}` : "";
  const until = r.range?.type === "endDate" && r.range.endDate ? ` until ${r.range.endDate}` : r.range?.type === "noEnd" ? " with no end" : "";
  return `${p.type ?? "repeats"} every ${p.interval ?? 1}${days}${until}`;
}

// ---------- Paging ----------

interface Position {
  /** The Graph page to read (first-page URL or an @odata.nextLink). */
  l: string;
  /** Events already returned from it, or (search) from the sorted results. */
  s: number;
}

function readToken(raw: string | undefined): Position | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Position;
    if (typeof v.s === "number" && v.s >= 0 && typeof v.l === "string" && (v.l === "" || v.l.startsWith(`${GRAPH}/`))) return v;
  } catch {
    // fall through
  }
  throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
}

const makeToken = (p: Position) => Buffer.from(JSON.stringify(p), "utf8").toString("base64url");

type Page = { value?: GraphEvent[]; "@odata.nextLink"?: string };

function zoneFor(ctx: GraphContext, args: Record<string, unknown>): string {
  const tz = arg.str(args, "timeZone", { max: 64 });
  if (tz && !isValidTimeZone(tz)) throw new ToolInputError(`timeZone "${tz}" isn't an IANA time zone, like Europe/London`);
  return tz ?? ctx.timeZone ?? "UTC";
}

/** Does the event mention every word (title, preview, place, people)? */
function mentions(e: GraphEvent, words: string[]): boolean {
  const hay = [e.subject, e.bodyPreview, e.location?.displayName, person(e.organizer), ...(e.attendees ?? []).map(person)].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

const wordsOf = (q: string | undefined) => (q ?? "").toLowerCase().split(/\s+/).map((w) => w.replace(/^"|"$/g, "")).filter(Boolean);

const calendarPath = (id: string) => (id === "primary" ? "/me/calendar" : `/me/calendars/${enc(id)}`);

function startMs(e: GraphEvent): number {
  const ms = Date.parse(`${e.start?.dateTime?.slice(0, 19) ?? ""}Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---------- The calendars the owner chose (calendar-choice.ts) ----------

type ListedCalendar = { id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { name?: string; address?: string }; hexColor?: string; color?: string };

/** Outlook's named colours, for calendars without a hex colour of their own. */
const COLORS: Record<string, string> = {
  lightBlue: "#4f9be0",
  lightGreen: "#5fb760",
  lightOrange: "#ef9b4f",
  lightGray: "#9a9a9a",
  lightYellow: "#d9b52e",
  lightTeal: "#3fb4a8",
  lightPink: "#e07fae",
  lightBrown: "#a9805e",
  lightRed: "#de5f5f",
};

/** Every calendar the owner has in Outlook (their own and ones shared with them), up to 750. */
export async function readOutlookCalendars(ctx: Pick<GraphContext, "get">): Promise<ListedCalendar[]> {
  const out: ListedCalendar[] = [];
  let url: string | undefined = graphUrl("/me/calendars", { $top: 250, $select: "id,name,isDefaultCalendar,canEdit,owner,hexColor,color" });
  for (let pages = 0; url && pages < 3; pages++) {
    const r: { value?: ListedCalendar[]; "@odata.nextLink"?: string } = await ctx.get(url);
    out.push(...(r.value ?? []));
    url = r["@odata.nextLink"];
  }
  return out;
}

/** The calendars switched on, for openMicrosoft: the main one alone until the owner chooses. */
export async function chosenOutlookCalendars(ctx: Pick<GraphContext, "get">, chosen: readonly string[] | null | undefined): Promise<ChosenCalendar[]> {
  if (!chosen) return MAIN_ONLY;
  const all = (await readOutlookCalendars(ctx)).map((c) => ({ id: c.id, name: c.name ?? "Calendar", primary: !!c.isDefaultCalendar }));
  return pickChosen(all, chosen);
}

const chosenOf = (ctx: GraphContext) => (ctx.calendars ? ctx.calendars() : Promise.resolve(MAIN_ONLY));

/** Is this calendar one Athena reads? The main calendar's real id is looked up only for the main-only default. */
async function reads(ctx: GraphContext, chosen: ChosenCalendar[], id: string): Promise<boolean> {
  if (isChosen(chosen, id)) return true;
  if (!chosen.some((c) => c.id === "primary")) return false;
  const main = await ctx.get<{ id?: string }>(graphUrl("/me/calendar", { $select: "id" })).catch(() => ({ id: undefined }));
  return main.id === id;
}

const notRead = (id: string) => new ToolInputError(`Not found: Athena doesn't read the calendar ${id}. list_calendars shows the ones it reads`);

/** Every event on one calendar in [from, to), up to Graph's page limit, for listings that merge calendars. */
async function allIn(ctx: GraphContext, calendarId: string, from: Date, to: Date, orderBy = "start/dateTime"): Promise<GraphEvent[]> {
  const out: GraphEvent[] = [];
  let url: string | undefined = graphUrl(`${calendarPath(calendarId)}/calendarView`, {
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $orderby: orderBy,
    $top: 250,
    $select: LIST_FIELDS,
  });
  for (let pages = 0; url && pages < MAX_GRAPH_PAGES; pages++) {
    let page: Page;
    try {
      page = await ctx.get<Page>(url);
    } catch (error) {
      if (error instanceof GraphApiError && error.status === 404) throw new ToolInputError(`Not found: there's no calendar ${calendarId}. list_calendars shows the ones there are`);
      throw error;
    }
    out.push(...(page.value ?? []));
    url = page["@odata.nextLink"];
  }
  return out;
}

/** One page of events merged from several calendars, each saying which calendar it's on (and its id, for get_event). */
function mergedPage(found: Array<{ e: GraphEvent; cal: ChosenCalendar }>, self: string, offset: number, want: number) {
  const events: Record<string, unknown>[] = [];
  let size = 0;
  let i = offset;
  for (; i < found.length && events.length < want && size <= LIST_BUDGET; i++) {
    const e = { ...eventOut(found[i].e, self, false), calendar: found[i].cal.name, calendarId: found[i].cal.id };
    events.push(e);
    size += JSON.stringify(e).length;
  }
  return { events, next: i < found.length ? makeToken({ l: "", s: i }) : undefined };
}

/**
 * Every calendar on the account for the owner to choose from (GET
 * /api/connectors/:id/calendars): colour, who shared it, and how many
 * events it has in the next 30 days.
 */
export async function outlookCalendarChoices(ctx: GraphContext, chosen: readonly string[] | null | undefined): Promise<CalendarChoice[]> {
  const all = await readOutlookCalendars(ctx);
  const on = new Set(pickChosen(all.map((c) => ({ id: c.id, primary: !!c.isDefaultCalendar })), chosen).map((c) => c.id));
  const from = ctx.now();
  const to = new Date(from.getTime() + 30 * DAY);
  const counts = await mapLimit(all, 3, async (c) => {
    let n = 0;
    try {
    let url: string | undefined = graphUrl(`/me/calendars/${enc(c.id)}/calendarView`, { startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: 250, $select: "id,isCancelled" });
    for (let pages = 0; url && pages < 2; pages++) {
      const page: { value?: Array<{ isCancelled?: boolean }>; "@odata.nextLink"?: string } = await ctx.get(url);
      n += (page.value ?? []).filter((e) => !e.isCancelled).length;
      url = page["@odata.nextLink"];
    }
    } catch {
      // One calendar that won't say how busy it is still shows, as quiet.
    }
    return n;
  });
  const self = ctx.email.toLowerCase();
  return all.map((c, i) => {
    const theirs = !!c.owner?.address && c.owner.address.toLowerCase() !== self;
    const hex = c.hexColor && /^#[0-9a-f]{6}$/i.test(c.hexColor) ? c.hexColor : COLORS[c.color ?? ""];
    return clean({
      id: c.id,
      name: c.name ?? "Calendar",
      color: hex,
      primary: c.isDefaultCalendar || undefined,
      shared: theirs,
      owner: theirs ? c.owner?.name?.trim() || c.owner?.address : undefined,
      sharedByYou: false,
      upcoming: counts[i] ?? 0,
      chosen: on.has(c.id),
    }) as CalendarChoice;
  });
}

// ---------- Tools ----------

const listCalendars: GraphTool = {
  name: "list_calendars",
  summary: "See your calendars",
  description:
    "List the owner's Outlook calendars (their own and ones shared with them): each one's id (use it as calendarId), name, whether it's their main calendar, their access and its owner.",
  inputSchema: {
    type: "object",
    properties: {
      pageSize: { type: "integer", description: "1–250 (default 100)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const from = readToken(arg.str(args, "pageToken", { max: 4000 }));
    const r = await ctx.get<{
      value?: Array<{ id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { name?: string; address?: string } }>;
      "@odata.nextLink"?: string;
    }>(from?.l || graphUrl("/me/calendars", { $top: arg.int(args, "pageSize", { min: 1, max: 250, fallback: 100 }), $select: "id,name,isDefaultCalendar,canEdit,owner" }));
    // Only the calendars the owner lets Athena read.
    const chosen = await chosenOf(ctx);
    const calendars = (r.value ?? []).filter((c) => chosen.some((x) => x.id === c.id || (!!c.isDefaultCalendar && x.id === "primary"))).map((c) => {
      const theirs = !!c.owner?.address && c.owner.address.toLowerCase() !== ctx.email.toLowerCase();
      return clean({
        id: c.id,
        summary: c.name,
        primary: c.isDefaultCalendar || undefined,
        accessRole: theirs ? (c.canEdit ? "writer" : "reader") : "owner",
        owner: theirs ? person({ emailAddress: c.owner }) : undefined,
      });
    });
    const link = r["@odata.nextLink"];
    return clean({ calendars, nextPageToken: link ? makeToken({ l: link, s: 0 }) : undefined });
  },
};

const listEvents: GraphTool = {
  name: "list_events",
  summary: "See events in a date range",
  description:
    "List events on the owner's Outlook calendars in a time range, in start order, with recurring meetings as separate occurrences. " +
    "By default this reads every calendar the owner lets Athena read, and when that's more than one, says which calendar each event is on (calendar, calendarId); give calendarId for just one. " +
    "Default range: from now for 7 days. Times without an offset (2026-11-07T09:00:00) are read as UTC unless timeZone says otherwise. " +
    "Each event has its id, summary, start and end (timed: UTC with Z; all-day: dates, with the end date the day after it finishes, and allDay true), status when not confirmed (cancelled, tentative), " +
    "location, organiser, attendees with their replies, the owner's own reply (myResponse), meeting link and htmlLink. Descriptions aren't included: use get_event for those. " +
    "eventType OUT_OF_OFFICE keeps only out-of-office time. If nextPageToken comes back, call again with it for the rest.",
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
    const asked = arg.str(args, "calendarId", { max: 500 });
    const chosen = await chosenOf(ctx);
    if (asked && asked !== "primary" && !(await reads(ctx, chosen, asked))) throw notRead(asked);
    // By default every calendar the owner switched on: the main one alone until they choose more.
    const cals = asked && asked !== "primary" ? [{ id: asked, name: "", primary: false }] : chosen;
    const calendarId = cals[0].id;
    const tz = zoneFor(ctx, args);
    const start = arg.str(args, "startTime", { max: 60 });
    const end = arg.str(args, "endTime", { max: 60 });
    const timeMin = start ? toInstant(start, tz, "startTime") : ctx.now();
    const timeMax = end ? toInstant(end, tz, "endTime") : new Date(timeMin.getTime() + 7 * DAY);
    if (timeMax.getTime() <= timeMin.getTime()) throw new ToolInputError("endTime must be after startTime");
    const types = arg.strings(args, "eventType", 10).map((t) => {
      if (!(t in API_EVENT_TYPE)) throw new ToolInputError(`eventType must be one of ${EVENT_TYPES.join(", ")}`);
      return API_EVENT_TYPE[t as keyof typeof API_EVENT_TYPE];
    });
    const wanted = types.length ? new Set(types) : null;
    const words = wordsOf(arg.str(args, "fullText", { max: 500 }));
    const orderBy = arg.str(args, "orderBy", { max: 40 }) === "lastModified" ? "lastModifiedDateTime desc" : "start/dateTime";
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 250, fallback: 50 });
    const from = readToken(arg.str(args, "pageToken", { max: 4000 }));
    const keep = (e: GraphEvent) => (!wanted || wanted.has(eventType(e) ?? "default")) && (!words.length || mentions(e, words));
    if (cals.length > 1) {
      const lists = await mapLimit(cals, 3, async (cal) => (await allIn(ctx, cal.id, timeMin, timeMax, orderBy)).filter(keep).map((e) => ({ e, cal })));
      const at = (e: GraphEvent) => Date.parse(e.lastModifiedDateTime ?? "") || 0;
      const found = lists.flat().sort(orderBy.startsWith("lastModified") ? (a, b) => at(b.e) - at(a.e) : (a, b) => startMs(a.e) - startMs(b.e));
      const p = mergedPage(found, ctx.email.toLowerCase(), from?.s ?? 0, pageSize);
      return clean({ events: p.events, nextPageToken: p.next });
    }

    let url =
      from?.l ||
      graphUrl(`${calendarPath(calendarId)}/calendarView`, {
        startDateTime: timeMin.toISOString(),
        endDateTime: timeMax.toISOString(),
        $orderby: orderBy,
        $top: GRAPH_PAGE,
        $select: LIST_FIELDS,
      });
    let skip = from?.s ?? 0;
    const events: ReturnType<typeof eventOut>[] = [];
    let size = 0;
    const self = ctx.email.toLowerCase();
    for (let pages = 0; pages < MAX_GRAPH_PAGES; pages++) {
      let page: Page;
      try {
        page = await ctx.get<Page>(url);
      } catch (error) {
        if (error instanceof GraphApiError && error.status === 404) throw new ToolInputError(`Not found: there's no calendar ${calendarId}. list_calendars shows the ones there are`);
        throw error;
      }
      const items = page.value ?? [];
      for (let i = skip; i < items.length; i++) {
        if (events.length >= pageSize || size > LIST_BUDGET) return clean({ events, nextPageToken: makeToken({ l: url, s: i }) });
        if (!keep(items[i])) continue;
        const e = eventOut(items[i], self, false);
        events.push(e);
        size += JSON.stringify(e).length;
      }
      skip = 0;
      const link = page["@odata.nextLink"];
      if (!link) return clean({ events });
      url = link;
      if (events.length >= pageSize || size > LIST_BUDGET) break;
    }
    return clean({ events, nextPageToken: makeToken({ l: url, s: 0 }) });
  },
};

/** Rings around today, nearest first: a search reads a ring only when the nearer ones haven't filled the page. */
const SEARCH_RINGS: Array<[number, number]> = [
  [0, 30],
  [30, 120],
  [120, 365],
];

const searchEvents: GraphTool = {
  name: "search_events",
  summary: "Search your calendar",
  description:
    "Search every Outlook calendar the owner lets Athena read for events matching words (in the title, description preview, location or attendees), from a year ago to a year ahead. " +
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
    const words = wordsOf(arg.str(args, "query", { required: true, max: 500 }));
    if (!words.length) throw new ToolInputError("query is required");
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 100, fallback: 25 });
    const offset = readToken(arg.str(args, "pageToken", { max: 4000 }))?.s ?? 0;
    const now = ctx.now().getTime();
    // Every calendar the owner lets Athena read (the main one alone until they choose more).
    const cals = await chosenOf(ctx);
    const found: Array<{ e: GraphEvent; cal: ChosenCalendar }> = [];
    const window = async (from: number, to: number) => {
      const lists = await mapLimit(cals, 3, async (cal) => (await allIn(ctx, cal.id, new Date(from), new Date(to))).filter((e) => mentions(e, words)).map((e) => ({ e, cal })));
      found.push(...lists.flat());
    };
    // Each ring is wholly closer to today than the next, so stopping after a ring keeps the order right.
    for (const [near, far] of SEARCH_RINGS) {
      if (near === 0) await window(now - far * DAY, now + far * DAY);
      else await Promise.all([window(now - far * DAY, now - near * DAY), window(now + near * DAY, now + far * DAY)]);
      if (found.length > offset + pageSize) break;
    }
    found.sort((a, b) => Math.abs(startMs(a.e) - now) - Math.abs(startMs(b.e) - now));
    const self = ctx.email.toLowerCase();
    if (cals.length > 1) {
      const p = mergedPage(found, self, offset, pageSize);
      return clean({ events: p.events, nextPageToken: p.next });
    }
    const events: ReturnType<typeof eventOut>[] = [];
    let size = 0;
    let i = offset;
    for (; i < found.length && events.length < pageSize && size <= LIST_BUDGET; i++) {
      const e = eventOut(found[i].e, self, false);
      events.push(e);
      size += JSON.stringify(e).length;
    }
    return clean({ events, nextPageToken: i < found.length ? makeToken({ l: "", s: i }) : undefined });
  },
};

const getEvent: GraphTool = {
  name: "get_event",
  summary: "Read one event in full",
  description:
    "Read one Outlook calendar event in full by its id: everything list_events gives plus its description, every attendee, how it repeats and attachment names. " +
    "A cancelled event comes back with status cancelled; one that was deleted comes back as not found.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "Default: the main calendar. Any calendar's event can be read by its id alone." },
      eventId: { type: "string", description: "The event's id, from list_events or search_events." },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { max: 500 });
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    if (calendarId && calendarId !== "primary" && !(await reads(ctx, await chosenOf(ctx), calendarId))) throw notRead(calendarId);
    const path = calendarId && calendarId !== "primary" ? `/me/calendars/${enc(calendarId)}/events/${enc(eventId)}` : `/me/events/${enc(eventId)}`;
    let e: GraphEvent;
    try {
      e = await ctx.get<GraphEvent>(graphUrl(path, { $select: `${LIST_FIELDS},body,recurrence,categories` }), { text: true });
    } catch (error) {
      if (error instanceof GraphApiError && (error.status === 404 || error.status === 410)) {
        throw new ToolInputError(`Not found: there's no event ${eventId} on that calendar. It may have been deleted`);
      }
      throw error;
    }
    let names: string[] | undefined;
    if (e.hasAttachments) {
      const r = await ctx
        .get<{ value?: Array<{ name?: string; isInline?: boolean }> }>(graphUrl(`/me/events/${enc(eventId)}/attachments`, { $select: "name,isInline" }))
        .catch(() => ({ value: [] }));
      names = (r.value ?? []).filter((a) => !a.isInline && a.name).map((a) => a.name!);
    }
    return eventOut(e, ctx.email.toLowerCase(), true, names);
  },
};

const REPLY: Record<string, string> = { going: "accept", maybe: "tentativelyAccept", declined: "decline" };

/** Your reply to one invite, with Graph's own accept, tentativelyAccept or decline. Nothing else about the event changes. */
const respondToEvent: GraphTool = {
  name: RSVP_TOOL,
  summary: "Answer an invite",
  description: "Set the owner's own reply to one invite: going, maybe or declined. Changes nothing else about the event.",
  inputSchema: {
    type: "object",
    properties: { eventId: { type: "string" }, answer: { type: "string", enum: ["going", "maybe", "declined"] } },
    required: ["eventId", "answer"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    const answer = arg.str(args, "answer", { required: true, max: 20 })!;
    const action = REPLY[answer];
    if (!action) throw new ToolInputError(answer === "none" ? "Outlook can't take an answer back to no reply" : "answer must be going, maybe or declined");
    if (!ctx.respond) throw new ToolInputError("This account isn't allowed to answer invites");
    let e: GraphEvent;
    try {
      e = await ctx.get<GraphEvent>(graphUrl(`/me/events/${enc(eventId)}`, { $select: "id,isOrganizer,isCancelled" }));
    } catch (error) {
      if (error instanceof GraphApiError && (error.status === 404 || error.status === 410)) throw new ToolInputError("Outlook doesn't have this event any more");
      throw error;
    }
    if (e.isCancelled) throw new ToolInputError("This event was cancelled");
    if (e.isOrganizer) throw new ToolInputError("It's your own event, so there's no invite to answer");
    await ctx.respond(`${GRAPH}/me/events/${enc(eventId)}/${action}`, { sendResponse: true });
    return { id: e.id, myResponse: answer === "going" ? "accepted" : answer };
  },
};

// ---------- Free/busy and moving ----------

/** One person's busy times as Graph's getSchedule gives them: busy or free, and their working hours, never what or where. */
export interface ScheduleOut {
  email: string;
  status: "known" | "unknown";
  busy: Array<{ start: string; end: string }>;
  hours?: { days: number[]; start: string; end: string; tz: string };
}

const DAY_NUMBER: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
/** Graph's busy-ish statuses. "free" and "workingElsewhere" aren't busy; "unknown" isn't known. */
const BUSY_STATUS = new Set(["busy", "oof", "tentative"]);

/** Windows zone names Graph uses for working hours, mapped to IANA for the common ones; an IANA name passes through. */
const WINDOWS_ZONE: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Singapore Standard Time": "Asia/Singapore",
  UTC: "UTC",
};

/**
 * Graph's getSchedule reply, read: only each item's status, start and end
 * (Graph can add a subject and place for colleagues; those are dropped
 * here and never leave this function), plus the person's working hours. A
 * schedule with an error, or whose view is all unknown, is unknown.
 */
export function parseSchedule(reply: unknown, emails: string[]): ScheduleOut[] {
  const rows = ((reply as { value?: unknown[] } | null)?.value ?? []) as Array<Record<string, unknown>>;
  const byLower = new Map(rows.filter((r) => typeof r?.scheduleId === "string").map((r) => [(r.scheduleId as string).toLowerCase(), r]));
  return emails.map((email): ScheduleOut => {
    const r = byLower.get(email.toLowerCase());
    const view = typeof r?.availabilityView === "string" ? (r.availabilityView as string) : "";
    if (!r || r.error || (view && /^4+$/.test(view))) return { email, status: "unknown", busy: [] };
    const items = Array.isArray(r.scheduleItems) ? (r.scheduleItems as Array<Record<string, unknown>>) : [];
    const busy = items
      .filter((i) => BUSY_STATUS.has(String(i.status)))
      .map((i) => ({ start: utcIso((i.start as When | undefined)?.dateTime), end: utcIso((i.end as When | undefined)?.dateTime) }))
      .filter((b): b is { start: string; end: string } => !!b.start && !!b.end && b.end > b.start);
    const w = r.workingHours as { daysOfWeek?: unknown; startTime?: unknown; endTime?: unknown; timeZone?: { name?: unknown } } | undefined;
    const zoneName = typeof w?.timeZone?.name === "string" ? w.timeZone.name : "";
    const tz = WINDOWS_ZONE[zoneName] ?? (isValidTimeZone(zoneName) ? zoneName : "");
    const days = Array.isArray(w?.daysOfWeek) ? (w!.daysOfWeek as unknown[]).map((d) => DAY_NUMBER[String(d).toLowerCase()]).filter((d) => d !== undefined) : [];
    const hhmm = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : "");
    const start = hhmm(w?.startTime);
    const end = hhmm(w?.endTime);
    const hours = tz && days.length && start && end && end > start ? { days, start, end, tz } : undefined;
    return { email, status: "known", busy, ...(hours ? { hours } : {}) };
  });
}

/** "2026-11-12T14:00:00": Graph's UTC wall clock, no offset. */
const graphTime = (at: Date) => at.toISOString().slice(0, 19);

const freeBusy: GraphTool = {
  name: FREE_BUSY_TOOL,
  summary: "See when people are busy",
  description: "When each of up to 20 people is busy in a time range, from Outlook's schedule, with their working hours when Outlook shares them. Busy or free only. status unknown means Outlook didn't show that calendar.",
  inputSchema: {
    type: "object",
    properties: {
      emails: { type: "array", items: { type: "string" } },
      startTime: { type: "string" },
      endTime: { type: "string" },
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
    if (!ctx.schedule) throw new ToolInputError("This account can't read free/busy");
    const reply = await ctx.schedule({ schedules: emails, startTime: { dateTime: graphTime(from), timeZone: "UTC" }, endTime: { dateTime: graphTime(to), timeZone: "UTC" }, availabilityViewInterval: 30 });
    return { people: parseSchedule(reply, emails) };
  },
};

/**
 * A new start and end for one event the owner organises: a PATCH of only
 * start and end, in UTC (isMovePatch). Outlook sends guests the update.
 * Refused for someone else's event, an all-day event, a whole series, or a
 * cancelled one; `expect` refuses it if the event moved since Athena looked.
 */
const moveEvent: GraphTool = {
  name: MOVE_TOOL,
  summary: "Move one of your events",
  description: "Give an event the owner organises a new start and end. Changes nothing else; Outlook sends guests the update.",
  inputSchema: {
    type: "object",
    properties: { eventId: { type: "string" }, start: { type: "string" }, end: { type: "string" }, expect: { type: "string" } },
    required: ["eventId", "start"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    if (!ctx.move) throw new ToolInputError("This account isn't allowed to move events");
    let e: GraphEvent;
    try {
      e = await ctx.get<GraphEvent>(graphUrl(`/me/events/${enc(eventId)}`, { $select: "id,subject,isOrganizer,isCancelled,isAllDay,start,end,type,attendees" }));
    } catch (error) {
      if (error instanceof GraphApiError && (error.status === 404 || error.status === 410)) throw new ToolInputError("Outlook doesn't have this event any more");
      throw error;
    }
    if (e.isCancelled) throw new ToolInputError("This event was cancelled");
    if (!e.isOrganizer) throw new ToolInputError("Someone else organises this event, so only they can move it");
    if (e.isAllDay) throw new ToolInputError("Athena only moves events with a start and end time, not all-day ones");
    if (e.type === "seriesMaster") throw new ToolInputError("This is a whole repeating series. Athena only moves one date at a time");
    const wasStart = utcIso(e.start?.dateTime);
    const wasEnd = utcIso(e.end?.dateTime);
    if (!wasStart || !wasEnd) throw new ToolInputError("Outlook didn't say when this event is");
    const expect = arg.str(args, "expect", { max: 60 });
    if (expect && Date.parse(expect) !== Date.parse(wasStart)) throw new ToolInputError("This event has moved since Athena last looked. Check it and try again");
    const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
    const start = toInstant(arg.str(args, "start", { required: true, max: 60 })!, tz, "start");
    const rawEnd = arg.str(args, "end", { max: 60 });
    const end = rawEnd ? toInstant(rawEnd, tz, "end") : new Date(start.getTime() + (Date.parse(wasEnd) - Date.parse(wasStart)));
    if (end.getTime() <= start.getTime()) throw new ToolInputError("end must be after start");
    if (start.getTime() !== Date.parse(wasStart) || end.getTime() !== Date.parse(wasEnd)) {
      await ctx.move(`${GRAPH}/me/events/${enc(eventId)}`, { start: { dateTime: graphTime(start), timeZone: "UTC" }, end: { dateTime: graphTime(end), timeZone: "UTC" } });
    }
    const guests = (e.attendees ?? []).filter((a) => a.type !== "resource").length;
    return { id: e.id, summary: e.subject ?? "", before: { start: wasStart, end: wasEnd }, after: { start: start.toISOString(), end: end.toISOString() }, guests };
  },
};

/**
 * Add one event: POST /me/events (or the chosen calendar's events), with only
 * a subject, UTC start and end, a place, a plain-text description and guests
 * (isCreatePost). Outlook sends the invites.
 */
const createEvent: GraphTool = {
  name: CREATE_TOOL,
  summary: "Add an event",
  description: "Add one event to a calendar the owner chose, after they confirmed it in the app. Outlook sends guests the invite.",
  inputSchema: CREATE_SCHEMA,
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (!ctx.create) throw new ToolInputError("This account isn't allowed to add events");
    const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
    const a = readCreateArgs(args, tz, [ctx.email]);
    const calendarId = a.calendarId ?? "primary";
    const chosen = ctx.calendars ? await ctx.calendars() : MAIN_ONLY;
    if (calendarId !== "primary" && !isChosen(chosen, calendarId)) throw new ToolInputError(`Not found: Athena doesn't read the calendar ${calendarId}. list_calendars shows the ones it reads`);
    if (calendarId !== "primary" && !/^[A-Za-z0-9_=+-]+$/.test(calendarId)) throw new ToolInputError("That isn't an Outlook calendar id");
    if (calendarId !== "primary") {
      // Only one of the owner's own calendars that they can write to, never one shared with them.
      let cal: { canEdit?: boolean; owner?: { address?: string } } | null = null;
      try {
        cal = await ctx.get(graphUrl(`/me/calendars/${calendarId}`, { $select: "id,canEdit,owner" }));
      } catch (error) {
        if (!(error instanceof GraphApiError && (error.status === 404 || error.status === 400))) throw error;
      }
      if (!cal?.canEdit || (cal.owner?.address ?? "").toLowerCase() !== ctx.email.toLowerCase()) throw new ToolInputError("Athena only adds events to your own Outlook calendars");
    }
    const url = calendarId === "primary" ? `${GRAPH}/me/events` : `${GRAPH}/me/calendars/${calendarId}/events`;
    const created = await ctx.create<{ id?: string; webLink?: string }>(url, {
      subject: a.summary,
      start: { dateTime: graphTime(a.start), timeZone: "UTC" },
      end: { dateTime: graphTime(a.end), timeZone: "UTC" },
      ...(a.location ? { location: { displayName: a.location } } : {}),
      ...(a.description ? { body: { contentType: "Text" as const, content: a.description } } : {}),
      ...(a.attendees.length ? { attendees: a.attendees.map((g) => ({ emailAddress: { address: g.email, ...(g.name ? { name: g.name } : {}) } })) } : {}),
      // A block is busy; Outlook has no Focus time Athena can set.
      ...(a.block ? { showAs: "busy" as const } : {}),
    });
    if (!created?.id) throw new ToolInputError("Outlook didn't say it added the event. Check Outlook before trying again");
    const out: CreatedOut = { id: created.id, calendarId, link: created.webLink ?? "", guests: a.attendees.length, summary: a.summary, start: a.start.toISOString(), end: a.end.toISOString() };
    return out;
  },
};

/** Undo of create_event: delete that one event (Outlook sends guests a cancellation). Only for an event in calendar_creates. */
const undoCreateEvent: GraphTool = {
  name: UNDO_CREATE_TOOL,
  summary: "Take back an event Athena added",
  description: "Delete one event Athena added, as the Undo on its receipt. Refused for any other event. Guests get a cancellation.",
  inputSchema: { type: "object", properties: { calendarId: { type: "string" }, eventId: { type: "string" } }, required: ["calendarId", "eventId"] },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { required: true, max: 600 })!;
    const eventId = arg.str(args, "eventId", { required: true, max: 1024 })!;
    if (!ctx.deleteCreated) throw new ToolInputError("This account isn't allowed to add or remove events");
    await ctx.deleteCreated(calendarId, eventId);
    return { id: eventId, deleted: true };
  },
};

export const OUTLOOK_CALENDAR_TOOLS: GraphTool[] = [listCalendars, listEvents, searchEvents, getEvent, respondToEvent, freeBusy, moveEvent, createEvent, undoCreateEvent];
