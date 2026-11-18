/**
 * iCloud Calendar's tools for icloud-direct.ts, over CalDAV. The same names,
 * arguments and compact JSON as google-calendar.ts, so Meetings, precheck
 * and Ask read an iCloud calendar as they read a Google one:
 *
 *  - one time-range REPORT per calendar, asking iCloud to expand recurring
 *    events; anything it leaves as a series is expanded here
 *    (icloud-ical.ts), so each occurrence is its own event with its own id;
 *  - times in the owner's zone, with the offset; all-day events as dates
 *    with `allDay: true`, the end date the day after they finish;
 *  - long listings in pages (Athena's own page tokens), never cut off mid-way.
 *
 * An event's id is its file on iCloud plus, for an occurrence, when it
 * originally started, so get_event can read it back with one GET.
 * Every request is a PROPFIND, REPORT or GET (icloud-dav.ts).
 */
import { isValidTimeZone } from "../../../lib/dates";
import { ToolInputError, arg, clean, clip, mapLimit } from "./google-api";
import { toInstant } from "./google-calendar";
import { CREATE_TOOL, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { CREATE_SCHEMA, readCreateArgs, type CreatedOut } from "./calendar-create";
import { createIcloudEvent, deleteCreatedIcloudEvent } from "./icloud-create";
import { moveIcloudEvent } from "./icloud-move";
import { answerIcloudInvite, PARTSTAT } from "./icloud-rsvp";
import { DavSession, IcloudError, find, findAll, lastSegment, type DavResponse } from "./icloud-dav";
import {
  instantOf,
  isoInZone,
  occurrences,
  parseIcal,
  parseTime,
  parseTimeValue,
  prop,
  props,
  recurrenceStamp,
  textOf,
  zoneAliases,
  ianaZone,
  type IcalComponent,
  type IcalProp,
  type Occurrence,
} from "./icloud-ical";

/** What one listing returns at most (characters of JSON), so it never needs truncating. */
const LIST_BUDGET = 18_000;
const LIST_ATTENDEES = 15;
const DAY = 86_400_000;
/** The longest range one list_events call reads. */
const MAX_RANGE_DAYS = 400;

export interface IcloudCalendar {
  id: string;
  href: string;
  name: string;
  primary: boolean;
  accessRole: "owner" | "writer" | "reader";
  timeZone?: string;
  color?: string;
  description?: string;
  /** Someone else's calendar: who shared it, from the invite ("Rowan Thorne"). */
  sharedBy?: string;
  /** The owner's own calendar, shared with other people. */
  sharedOut?: boolean;
}

export interface IcloudCalendarContext {
  session: DavSession;
  /** The calendar home, absolute, ending in "/". */
  home: string;
  /** The owner's own addresses, lower-cased, for "you" and their reply. */
  emails: string[];
  /** The owner's zone, for output and times given without an offset. */
  timeZone: string;
  now(): Date;
  /** The owner's calendars, read once per open. */
  calendars(): Promise<IcloudCalendar[]>;
  /** "Let Athena answer invites" is on: respond_to_event may change your own PARTSTAT (icloud-rsvp.ts). */
  answering?: boolean;
  /** "Let Athena add and update events" is on: move_event may change one event's start and end (icloud-move.ts). */
  moving?: boolean;
  /** Undo of create_event: is this event one Athena added (calendar_creates)? Unset: nothing may be deleted. */
  createdByAthena?(calendarId: string, eventId: string): Promise<boolean>;
}

export interface IcloudTool {
  name: string;
  description: string;
  summary: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
  run(ctx: IcloudCalendarContext, args: Record<string, unknown>): Promise<unknown>;
}

// ---------- Calendars ----------

const CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><c:calendar-description/><c:calendar-timezone/><ic:calendar-color/><d:current-user-privilege-set/><cs:invite/></d:prop></d:propfind>`;

/** The calendars in the home that hold events (not Reminders lists, the inbox or outbox), primary first. */
export async function readCalendars(session: DavSession, home: string): Promise<IcloudCalendar[]> {
  const all = await session.multistatus("PROPFIND", home, CALENDARS_BODY, 1);
  const cals: IcloudCalendar[] = [];
  for (const r of all) {
    const type = r.props.get("resourcetype");
    if (!find(type, "calendar")) continue;
    const comps = findAll(r.props.get("supported-calendar-component-set"), "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
    if (comps.length && !comps.includes("VEVENT")) continue;
    const privs = r.props.get("current-user-privilege-set");
    const canWrite = !privs || !!(find(privs, "write") || find(privs, "all") || find(privs, "write-content"));
    const shared = !!find(type, "shared");
    const tzText = r.props.get("calendar-timezone")?.text ?? "";
    const tzCals = tzText ? parseIcal(tzText) : [];
    const tzid = tzCals.flatMap((c) => c.children.filter((x) => x.name === "VTIMEZONE")).map((z) => prop(z, "TZID")?.value)[0];
    const zone = tzid ? ianaZone(tzid, "", zoneAliases(tzCals)) : "";
    // Who shared it: the invite's organiser (calendarserver.org's sharing extension, as iCloud sends it).
    const invite = r.props.get("invite");
    const organizer = find(invite, "organizer");
    const who = organizer
      ? [find(invite, "organizer-first")?.text.trim(), find(invite, "organizer-last")?.text.trim()].filter(Boolean).join(" ") || find(organizer, "common-name")?.text.trim()
      : undefined;
    cals.push({
      sharedBy: shared ? who || undefined : undefined,
      sharedOut: !!find(type, "shared-owner"),
      id: lastSegment(r.href),
      href: r.href.endsWith("/") ? r.href : `${r.href}/`,
      name: r.props.get("displayname")?.text.trim() || lastSegment(r.href),
      primary: false,
      accessRole: shared ? (canWrite ? "writer" : "reader") : canWrite ? "owner" : "reader",
      timeZone: zone || undefined,
      color: r.props.get("calendar-color")?.text.trim().slice(0, 7) || undefined,
      description: r.props.get("calendar-description")?.text.trim() || undefined,
    });
  }
  // iCloud's default calendar is "home" on older accounts; otherwise the first of the owner's own.
  const primary = cals.find((c) => c.id === "home") ?? cals.find((c) => c.accessRole === "owner" && /^(home|calendar)$/i.test(c.name)) ?? cals.find((c) => c.accessRole === "owner") ?? cals[0];
  if (primary) primary.primary = true;
  return [...cals.filter((c) => c.primary), ...cals.filter((c) => !c.primary)];
}

async function calendarFor(ctx: IcloudCalendarContext, id: string | undefined): Promise<IcloudCalendar> {
  const cals = await ctx.calendars();
  const want = !id || id === "primary" ? undefined : id;
  const cal = want ? cals.find((c) => c.id === want || c.name.toLowerCase() === want.toLowerCase()) : cals.find((c) => c.primary);
  if (!cal) throw new ToolInputError(want ? `There's no calendar ${want}. Use an id from list_calendars` : "This iCloud account has no calendars");
  return cal;
}

// ---------- Reading events ----------

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A time-range REPORT: every event overlapping [from, to), with iCloud asked to expand series. */
function rangeQuery(fromMs: number, toMs: number): string {
  const s = stamp(fromMs);
  const e = stamp(toMs);
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

export interface Found extends Occurrence {
  /** The event's file, relative to the calendar home ("home/ABC.ics"). */
  path: string;
  calendar: IcloudCalendar;
}

/** Each occurrence on a calendar that overlaps [from, to), in start order. */
export async function eventsIn(ctx: IcloudCalendarContext, cal: IcloudCalendar, fromMs: number, toMs: number): Promise<Found[]> {
  const replies: DavResponse[] = await ctx.session.multistatus("REPORT", cal.href, rangeQuery(fromMs, toMs), 1);
  const out: Found[] = [];
  for (const r of replies) {
    const data = r.props.get("calendar-data")?.text;
    if (!data) continue;
    const path = relativePath(ctx.home, r.href);
    if (!path) continue;
    for (const o of occurrences(data, fromMs, toMs, ctx.timeZone)) out.push({ ...o, path, calendar: cal });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** "home/ABC.ics" for an address in the home; null for anything else. */
function relativePath(home: string, href: string): string | null {
  if (!href.startsWith(home)) return null;
  const rest = href.slice(home.length);
  return /^[^/]+\/[^/]+$/.test(rest) ? rest : null;
}

// ---------- Ids ----------

/** An event's id: its file (base64url) and, for an occurrence, its original start. */
export function eventId(path: string, recurrenceId?: string): string {
  const file = Buffer.from(path, "utf8").toString("base64url");
  return recurrenceId ? `${file}.${recurrenceId}` : file;
}

export function readEventId(id: string): { path: string; recurrenceId?: string } {
  const m = /^([A-Za-z0-9_-]{4,1400})(?:\.(\d{8}(?:T\d{6}Z)?))?$/.exec(id.trim());
  const path = m ? Buffer.from(m[1], "base64url").toString("utf8") : "";
  if (!m || !/^[^/]+\/[^/]+$/.test(path) || path.split("/").some((p) => p === ".." || p === ".")) {
    throw new ToolInputError(`Not found: ${id} isn't an event id this calendar gave out. Use one from list_events or search_events`);
  }
  return { path, recurrenceId: m[2] };
}

// ---------- Output ----------

const RESPONSE: Record<string, string> = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "maybe", "NEEDS-ACTION": "no reply yet", DELEGATED: "delegated" };

const mailOf = (p: IcalProp) => p.value.replace(/^mailto:/i, "").trim();
const nameOf = (p: IcalProp) => (p.params.CN ?? "").trim();

/** "Priya Shah <priya@example.com> (organiser): accepted" */
function attendeeLine(p: IcalProp, self: boolean, organizer: boolean): string {
  const email = mailOf(p);
  const name = nameOf(p);
  const who = name && email && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email || name || "someone";
  const tags = [self ? "you" : "", organizer ? "organiser" : "", (p.params.ROLE ?? "").toUpperCase() === "OPT-PARTICIPANT" ? "optional" : ""].filter(Boolean);
  return `${who}${tags.length ? ` (${tags.join(", ")})` : ""}: ${RESPONSE[(p.params.PARTSTAT ?? "").toUpperCase()] ?? "no reply yet"}`;
}

const VIDEO = /https:\/\/[^\s<>"']*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|facetime\.apple\.com|webex\.com|whereby\.com)[^\s<>"']*/i;

function meetLink(e: IcalComponent): string | undefined {
  const url = textOf(e, "URL") ?? textOf(e, "X-APPLE-URL");
  if (url && VIDEO.test(url)) return url;
  return VIDEO.exec(`${textOf(e, "LOCATION") ?? ""}\n${textOf(e, "DESCRIPTION") ?? ""}`)?.[0];
}

/** LAST-MODIFIED (20261106T120000Z) as an ISO time. */
function updatedOf(e: IcalComponent): string | undefined {
  const t = parseTime(prop(e, "LAST-MODIFIED") ?? prop(e, "DTSTAMP"), "UTC");
  return t ? new Date(instantOf(t)).toISOString() : undefined;
}

/** One occurrence: its essentials in a list, everything useful with `detail`. Field for field as google-calendar.ts's eventOut. */
export function eventOut(o: Found, ctx: Pick<IcloudCalendarContext, "emails" | "timeZone">, detail: boolean, withCalendar = false) {
  const e = o.event;
  const mine = new Set(ctx.emails);
  const org = prop(e, "ORGANIZER");
  const orgMail = org ? mailOf(org).toLowerCase() : "";
  const people = props(e, "ATTENDEE").filter((a) => !/^(ROOM|RESOURCE)$/i.test(a.params.CUTYPE ?? ""));
  const cap = detail ? 100 : LIST_ATTENDEES;
  const self = people.find((a) => mine.has(mailOf(a).toLowerCase()));
  const status = (textOf(e, "STATUS") ?? "").toUpperCase();
  const tz = ctx.timeZone;
  return clean({
    id: eventId(o.path, o.recurrenceId),
    summary: textOf(e, "SUMMARY") ?? "(no title)",
    start: o.start.allDay ? o.start.date : isoInZone(o.startMs, tz),
    end: o.start.allDay ? o.end.date : isoInZone(o.endMs, tz),
    allDay: o.start.allDay ? true : undefined,
    status: status === "TENTATIVE" ? "tentative" : status === "CANCELLED" ? "cancelled" : undefined,
    calendar: withCalendar ? o.calendar.name : undefined,
    location: textOf(e, "LOCATION") ? clip(textOf(e, "LOCATION")!, 200) : undefined,
    organizer: org && !mine.has(orgMail) ? (nameOf(org) ? `${nameOf(org)} <${mailOf(org)}>` : mailOf(org)) : undefined,
    myResponse: self ? RESPONSE[(self.params.PARTSTAT ?? "").toUpperCase()] ?? "no reply yet" : undefined,
    attendees: people.slice(0, cap).map((a) => attendeeLine(a, a === self, !!orgMail && mailOf(a).toLowerCase() === orgMail)),
    moreAttendees: people.length > cap ? people.length - cap : undefined,
    meetLink: meetLink(e),
    description: detail && textOf(e, "DESCRIPTION") ? clip(textOf(e, "DESCRIPTION")!, 3_000) : undefined,
    recurringEventId: detail && o.recurrenceId ? eventId(o.path) : undefined,
    recurrence: detail ? o.recurrence : undefined,
    attachments: detail ? props(e, "ATTACH").map((a) => a.params.FILENAME ?? "").filter(Boolean) : undefined,
    updated: detail ? updatedOf(e) : undefined,
  });
}

// ---------- Paging ----------

function readToken(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof v.s === "number" && Number.isInteger(v.s) && v.s >= 0) return v.s;
  } catch {
    // fall through
  }
  throw new ToolInputError("pageToken isn't one this tool gave out. Leave it out to start from the beginning");
}

const makeToken = (s: number) => Buffer.from(JSON.stringify({ s }), "utf8").toString("base64url");

/** One page from `offset`: up to `want` events, and no more JSON than the budget. */
function page(found: Found[], offset: number, want: number, out: (o: Found) => Record<string, unknown>) {
  const events: Record<string, unknown>[] = [];
  let size = 0;
  let i = offset;
  for (; i < found.length && events.length < want && size <= LIST_BUDGET; i++) {
    const e = out(found[i]);
    events.push(e);
    size += JSON.stringify(e).length;
  }
  return { events, nextPageToken: i < found.length ? makeToken(i) : undefined };
}

function zoneFor(ctx: IcloudCalendarContext, args: Record<string, unknown>): string {
  const tz = arg.str(args, "timeZone", { max: 64 });
  if (tz && !isValidTimeZone(tz)) throw new ToolInputError(`timeZone "${tz}" isn't an IANA time zone, like Europe/London`);
  return tz ?? ctx.timeZone;
}

/** Every word somewhere in the event: title, notes, place, people. */
function matches(o: Occurrence, words: string[]): boolean {
  const e = o.event;
  const hay = [textOf(e, "SUMMARY"), textOf(e, "DESCRIPTION"), textOf(e, "LOCATION"), ...[...props(e, "ATTENDEE"), ...props(e, "ORGANIZER")].flatMap((p) => [nameOf(p), mailOf(p)])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);

// ---------- Tools ----------

const listCalendars: IcloudTool = {
  name: "list_calendars",
  summary: "See your calendars",
  description:
    "List the owner's iCloud calendars (their own and ones shared with them): each one's id (use it as calendarId), name, whether it's their primary calendar, their access and its time zone.",
  inputSchema: {
    type: "object",
    properties: {
      pageSize: { type: "integer", description: "1–250 (default 100)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const size = arg.int(args, "pageSize", { min: 1, max: 250, fallback: 100 });
    const from = readToken(arg.str(args, "pageToken", { max: 500 }));
    const cals = await ctx.calendars();
    const calendars = cals.slice(from, from + size).map((c) =>
      clean({ id: c.id, summary: c.name, primary: c.primary || undefined, accessRole: c.accessRole, timeZone: c.timeZone, description: c.description ? clip(c.description, 200) : undefined }),
    );
    return clean({ calendars, nextPageToken: from + size < cals.length ? makeToken(from + size) : undefined });
  },
};

const listEvents: IcloudTool = {
  name: "list_events",
  summary: "See events in a date range",
  description:
    "List events on the owner's iCloud calendars in a time range, in start order, with recurring events as separate occurrences. " +
    "iCloud has no single main calendar, so by default this reads every calendar and says which one each event is on; give calendarId for just one. " +
    "Default range: from now for 7 days. Times without an offset (2026-11-07T09:00:00) are in the owner's time zone unless timeZone says otherwise. " +
    "Each event has its id, summary, start and end (timed: with their offset; all-day: dates, with the end date the day after it finishes, and allDay true), status when not confirmed (tentative), " +
    "location, organiser, attendees with their replies, the owner's own reply (myResponse) and meeting link. Descriptions aren't included: use get_event for those. " +
    "Cancelled events are left out. If nextPageToken comes back, call again with it for the rest.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "A calendar's id from list_calendars, for just that one. Default (or \"primary\"): every calendar." },
      startTime: { type: "string", description: "Start of the range, ISO 8601. Default: now." },
      endTime: { type: "string", description: "End of the range, ISO 8601, after startTime. Default: startTime + 7 days." },
      fullText: { type: "string", description: "Only events containing these words (title, notes, location, attendees)." },
      eventType: { type: "array", items: { type: "string" }, description: "Accepted for compatibility with Google Calendar; iCloud events have no types." },
      orderBy: { type: "string", description: "startTime (default) or lastModified." },
      pageSize: { type: "integer", description: "Events to return, 1–250 (default 50)." },
      pageToken: { type: "string", description: "nextPageToken from the previous call." },
      timeZone: { type: "string", description: "IANA zone for times given without an offset, e.g. Europe/Zurich." },
    },
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const wanted = arg.str(args, "calendarId", { max: 300 });
    // Google's default is the primary calendar; iCloud people spread events over several, so the default here is all of them.
    const cals = !wanted || wanted === "primary" ? await ctx.calendars() : [await calendarFor(ctx, wanted)];
    if (!cals.length) throw new ToolInputError("This iCloud account has no calendars");
    const tz = zoneFor(ctx, args);
    const start = arg.str(args, "startTime", { max: 60 });
    const end = arg.str(args, "endTime", { max: 60 });
    const from = start ? toInstant(start, tz, "startTime").getTime() : ctx.now().getTime();
    const to = end ? toInstant(end, tz, "endTime").getTime() : from + 7 * DAY;
    if (to <= from) throw new ToolInputError("endTime must be after startTime");
    if (to - from > MAX_RANGE_DAYS * DAY) throw new ToolInputError(`Ask for ${MAX_RANGE_DAYS} days or fewer at a time`);
    arg.strings(args, "eventType", 10);
    const q = arg.str(args, "fullText", { max: 500 });
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 250, fallback: 50 });
    const offset = readToken(arg.str(args, "pageToken", { max: 2000 }));
    let found = (await mapLimit(cals, 3, (c) => eventsIn(ctx, c, from, to))).flat().sort((a, b) => a.startMs - b.startMs);
    if (q) found = found.filter((o) => matches(o, wordsOf(q)));
    if (arg.str(args, "orderBy", { max: 40 }) === "lastModified") {
      const at = (o: Found) => Date.parse(updatedOf(o.event) ?? "") || 0;
      found = [...found].sort((a, b) => at(b) - at(a));
    }
    const p = page(found, offset, pageSize, (o) => eventOut(o, ctx, false, cals.length > 1));
    return clean({ events: p.events, timeZone: ctx.timeZone, nextPageToken: p.nextPageToken });
  },
};

const searchEvents: IcloudTool = {
  name: "search_events",
  summary: "Search your calendar",
  description:
    "Search all the owner's iCloud calendars for events matching words (in the title, notes, location or attendees), from a year ago to a year ahead. " +
    "The closest to today come first, past or upcoming; each with the same fields as list_events plus the calendar it's on. If nextPageToken comes back, call again with it for more.",
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
    const words = wordsOf(arg.str(args, "query", { required: true, max: 500 })!);
    if (!words.length) throw new ToolInputError("query is required");
    const pageSize = arg.int(args, "pageSize", { min: 1, max: 100, fallback: 25 });
    const offset = readToken(arg.str(args, "pageToken", { max: 2000 }));
    const now = ctx.now().getTime();
    const cals = await ctx.calendars();
    const lists = await mapLimit(cals, 3, (c) => eventsIn(ctx, c, now - 365 * DAY, now + 365 * DAY));
    const found = lists
      .flat()
      .filter((o) => matches(o, words))
      .sort((a, b) => Math.abs(a.startMs - now) - Math.abs(b.startMs - now));
    return clean(page(found, offset, pageSize, (o) => eventOut(o, ctx, false, cals.length > 1)));
  },
};

const getEvent: IcloudTool = {
  name: "get_event",
  summary: "Read one event in full",
  description:
    "Read one calendar event in full by its id: everything list_events gives plus its notes, every attendee, recurrence and attachments. " +
    "A cancelled event comes back with status cancelled; one that was deleted comes back as not found.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "Not needed: the id says which calendar. Accepted for compatibility." },
      eventId: { type: "string", description: "The event's id, from list_events or search_events." },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: true },
  async run(ctx, args) {
    const raw = arg.str(args, "eventId", { required: true, max: 1500 })!;
    const { path, recurrenceId } = readEventId(raw);
    const notFound = () => new ToolInputError(`Not found: there's no event ${raw}. It may have been deleted`);
    const cals = await ctx.calendars();
    const cal = cals.find((c) => c.href === `${ctx.home}${path.split("/")[0]}/`);
    if (!cal) throw notFound();
    let text: string;
    try {
      text = (await ctx.session.request("GET", `${ctx.home}${path}`)).text;
    } catch (error) {
      if (error instanceof IcloudError && (error.status === 404 || error.status === 410)) throw notFound();
      throw error;
    }
    const o = oneOccurrence(text, ctx.timeZone, recurrenceId);
    if (!o) throw notFound();
    return eventOut({ ...o, path, calendar: cal }, ctx, true);
  },
};

/**
 * One event out of its file: a single event, a whole series (its first
 * occurrence, with its rule), or the occurrence `recurrenceId` names.
 * Cancelled ones are kept, so get_event can say so.
 */
export function oneOccurrence(text: string, ownerZone: string, recurrenceId?: string): Occurrence | null {
  const cals = parseIcal(text);
  const aliases = zoneAliases(cals);
  const events = cals.flatMap((c) => c.children.filter((x) => x.name === "VEVENT"));
  const master = events.find((e) => !prop(e, "RECURRENCE-ID"));
  /** The occurrences in the few days around `ms`. */
  const near = (ms: number) => occurrences(text, ms - 2 * DAY, ms + 2 * DAY, ownerZone, { keepCancelled: true });
  if (recurrenceId) {
    // A changed occurrence is found around where it is now; an unchanged one around its original start.
    // Ids handed out before all-day stamps were dates (20260930T000000Z) still find their occurrence.
    if (master && parseTime(prop(master, "DTSTART"), ownerZone, aliases)?.allDay) recurrenceId = recurrenceId.slice(0, 8);
    const changed = events.find((e) => {
      const rid = parseTime(prop(e, "RECURRENCE-ID"), ownerZone, aliases);
      return rid && recurrenceStamp(rid, parseTime(prop(e, "DTSTART"), ownerZone, aliases)?.allDay) === recurrenceId;
    });
    const at = changed ? parseTime(prop(changed, "DTSTART"), ownerZone, aliases) : parseTimeValue(recurrenceId, recurrenceId.length === 8 ? { VALUE: "DATE" } : {}, ownerZone);
    return at ? (near(instantOf(at)).find((o) => o.recurrenceId === recurrenceId) ?? null) : null;
  }
  const e = master ?? events[0];
  const start = e && parseTime(prop(e, "DTSTART"), ownerZone, aliases);
  if (!e || !start) return null;
  const around = near(instantOf(start));
  const first = around.find((o) => !o.recurrenceId || o.recurrenceId === recurrenceStamp(start)) ?? around[0];
  return first ? { ...first, recurrenceId: undefined } : null;
}

/**
 * Your reply to one invite: only your own ATTENDEE line's PARTSTAT changes,
 * with a conditional PUT (icloud-rsvp.ts). Offered only with "Let Athena
 * answer invites" on; iCloud tells the organiser.
 */
const respondToEvent: IcloudTool = {
  name: RSVP_TOOL,
  summary: "Answer an invite",
  description: "Set the owner's own reply to one invite: going, maybe or declined. Changes nothing else about the event.",
  inputSchema: {
    type: "object",
    properties: {
      calendarId: { type: "string", description: "Not needed: the id says which calendar. Accepted for compatibility." },
      eventId: { type: "string" },
      answer: { type: "string", enum: ["going", "maybe", "declined"] },
      series: { type: "boolean", description: "For one date of a repeating invite: answer every date instead. Only when the owner chose \"All of them\"." },
    },
    required: ["eventId", "answer"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const raw = arg.str(args, "eventId", { required: true, max: 1500 })!;
    const answer = arg.str(args, "answer", { required: true, max: 20 })!;
    const partstat = PARTSTAT[answer];
    if (!partstat) throw new ToolInputError(answer === "none" ? "iCloud can't take an answer back to no reply" : "answer must be going, maybe or declined");
    if (!ctx.answering) throw new ToolInputError("This account isn't allowed to answer invites");
    const { path, recurrenceId } = readEventId(raw);
    const r = await answerIcloudInvite(ctx.session, `${ctx.home}${path}`, { emails: ctx.emails, partstat, recurrenceId, ownerZone: ctx.timeZone, series: args.series === true });
    return { id: raw, myResponse: r.myResponse };
  },
};

/**
 * A new start and end for one event the owner organises: only DTSTART and
 * DTEND change (and SEQUENCE, for guests), with a conditional PUT
 * (icloud-move.ts). Offered only with "Let Athena add and update events" on.
 */
const moveEvent: IcloudTool = {
  name: MOVE_TOOL,
  summary: "Move one of your events",
  description: "Give a one-off event the owner organises a new start and end. Changes nothing else; iCloud tells guests.",
  inputSchema: {
    type: "object",
    properties: { calendarId: { type: "string" }, eventId: { type: "string" }, start: { type: "string" }, end: { type: "string" }, expect: { type: "string" } },
    required: ["eventId", "start"],
  },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const raw = arg.str(args, "eventId", { required: true, max: 1500 })!;
    if (!ctx.moving) throw new ToolInputError("This account isn't allowed to move events");
    const { path, recurrenceId } = readEventId(raw);
    if (recurrenceId) throw new ToolInputError("This event repeats. Athena only moves one-off events on iCloud; move this one in Apple's Calendar app");
    const start = toInstant(arg.str(args, "start", { required: true, max: 60 })!, ctx.timeZone, "start").getTime();
    const rawEnd = arg.str(args, "end", { max: 60 });
    const rawExpect = arg.str(args, "expect", { max: 60 });
    const r = await moveIcloudEvent(ctx.session, `${ctx.home}${path}`, {
      emails: ctx.emails,
      start,
      end: rawEnd ? toInstant(rawEnd, ctx.timeZone, "end").getTime() : undefined,
      expect: rawExpect ? Date.parse(rawExpect) : undefined,
      ownerZone: ctx.timeZone,
    });
    const iso = (ms: number) => new Date(ms).toISOString();
    return { id: raw, summary: r.summary, before: { start: iso(r.before.start), end: iso(r.before.end) }, after: { start: iso(r.after.start), end: iso(r.after.end) }, guests: r.guests };
  },
};

/** The id Athena's tools use for an event's file ("calendarId/file.ics", base64url), as readEventId reads it. */
const eventIdOf = (calendarId: string, file: string) => Buffer.from(`${calendarId}/${file}`, "utf8").toString("base64url");

/**
 * Add one event: a new file in the chosen calendar, PUT with If-None-Match: *
 * (icloud-create.ts), holding only the fields isNewEventIcs allows. iCloud
 * sends the invites. Offered only with "Let Athena add and update events" on.
 */
const createEvent: IcloudTool = {
  name: CREATE_TOOL,
  summary: "Add an event",
  description: "Add one event to a calendar the owner chose, after they confirmed it in the app. iCloud sends guests the invite.",
  inputSchema: CREATE_SCHEMA,
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    if (!ctx.moving) throw new ToolInputError("This account isn't allowed to add events");
    const a = readCreateArgs(args, ctx.timeZone, ctx.emails);
    const cal = await calendarFor(ctx, a.calendarId);
    if (cal.accessRole === "reader") throw new ToolInputError(`You can't add events to ${cal.name}`);
    const { file } = await createIcloudEvent(ctx.session, new URL(cal.href, ctx.home).toString(), a, { organizer: ctx.emails[0] ?? "", now: ctx.now() });
    const out: CreatedOut = { id: eventIdOf(cal.id, file), calendarId: cal.id, link: "", guests: a.attendees.length, summary: a.summary, start: a.start.toISOString(), end: a.end.toISOString() };
    return out;
  },
};

/** Undo of create_event: delete that one file (If-Match). Only for an event in calendar_creates; iCloud sends guests a cancellation. */
const undoCreateEvent: IcloudTool = {
  name: UNDO_CREATE_TOOL,
  summary: "Take back an event Athena added",
  description: "Delete one event Athena added, as the Undo on its receipt. Refused for any other event. Guests get a cancellation.",
  inputSchema: { type: "object", properties: { calendarId: { type: "string" }, eventId: { type: "string" } }, required: ["calendarId", "eventId"] },
  annotations: { readOnlyHint: false },
  async run(ctx, args) {
    const calendarId = arg.str(args, "calendarId", { required: true, max: 300 })!;
    const raw = arg.str(args, "eventId", { required: true, max: 1500 })!;
    if (!ctx.moving || !ctx.createdByAthena) throw new ToolInputError("This account isn't allowed to add or remove events");
    const { path, recurrenceId } = readEventId(raw);
    if (recurrenceId || path.split("/")[0] !== calendarId) throw new ToolInputError("Athena only removes events it added itself");
    if (!(await ctx.createdByAthena(calendarId, raw))) throw new ToolInputError("Athena only removes events it added itself");
    await deleteCreatedIcloudEvent(ctx.session, `${ctx.home}${path}`);
    return { id: raw, deleted: true };
  },
};

export const ICLOUD_CALENDAR_TOOLS: IcloudTool[] = [listCalendars, listEvents, searchEvents, getEvent, respondToEvent, moveEvent, createEvent, undoCreateEvent];

