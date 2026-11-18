/**
 * Finding a time and moving an event to it.
 *
 *  - findTimes: the owner's busy times from every calendar account they've
 *    switched on (only the calendars chosen there), their flights and trains
 *    (lib/trips.ts), their working hours (Settings → Days, loadWorkingHours),
 *    and each guest's busy times where Google's freeBusy or Outlook's
 *    getSchedule shows them. A guest whose calendar Athena can't see is
 *    named as such ("Couldn't see Sam's calendar") and left out of the
 *    search. Then lib/availability.ts picks the best three.
 *  - moveEvent: one event the owner organises, to a new start (and end), on
 *    its own calendar, with "Let Athena add and update events" on for
 *    that account (canMove). Only the start and end change; the adapters
 *    check the exact request (google-api.ts, microsoft-graph.ts,
 *    icloud-move.ts). Undo moves it back, refused if it moved again since.
 *  - prepareCreate / createEvent: one new event on a calendar the owner can
 *    write to, with "Let Athena add and update events" on for that account.
 *    prepareCreate only proposes (title, when, where, who gets an invite, and
 *    which calendar); createEvent runs after the owner taps Add in the
 *    confirm sheet, and records the event in calendar_creates
 *    (lib/calendar-creates.ts). Undo deletes that event and nothing else;
 *    guests get a cancellation. blockTime finds a free slot for a to-do and
 *    proposes a block on the owner's calendar, with no guests.
 *
 * Other people's events are never read here: only busy or free.
 * Everything that reaches a calendar goes through SchedulingPort, so lib/
 * stays free of the connector client; netlify/lib/connectors/calendar-scheduling.ts
 * is the real one and tests pass their own.
 */
import { AthenaInputError, getEvent, getOwnerTimeZone, q, type AthenaEvent } from "./db";
import { canMove } from "./connector-presets";
import { listConnectors } from "./connectors";
import { addDays, isValidDate, zonedParts, zonedToInstant, zonedToday } from "./dates";
import { busyFromEvents, busyFromTravel, findSlots, readWorkingHours, DEFAULT_HOURS, type CalendarEventLite, type GuestBusy, type WorkingHours } from "./availability";
import { calendarName } from "./rsvp";
import { listBookingsStarting, listTrips } from "./trips";
import { findPeople } from "./memory";
import { getCreate, markUndone, recordCreate } from "./calendar-creates";

export const CALENDAR_PROVIDERS = ["google-calendar", "outlook-calendar", "icloud-calendar"] as const;
/** The providers whose free/busy shows other people's calendars. */
const FREE_BUSY_PROVIDERS = new Set(["google-calendar", "outlook-calendar"]);

export interface PersonBusy {
  email: string;
  status: "known" | "unknown";
  busy: Array<{ start: string; end: string }>;
  hours?: { days: number[]; start: string; end: string; tz: string };
}

export interface Moved {
  before: { start: string; end: string };
  after: { start: string; end: string };
  /** How many guests the calendar tells. */
  guests: number;
  summary: string;
}

/** What findTimes and moveEvent need from the calendar accounts. Throws with a plain-English message when one can't. */
export interface SchedulingPort {
  /** The owner's events in a range, on the calendars they switched on for this account. */
  events(accountId: string, from: Date, to: Date): Promise<CalendarEventLite[]>;
  /** Busy times for these addresses: busy or free only. */
  freeBusy(accountId: string, emails: string[], from: Date, to: Date): Promise<PersonBusy[]>;
  /** A new start (and end) for one event the owner organises; `expect` is the start Athena last saw. */
  move(accountId: string, req: { calendarId: string; eventId: string; start: string; end?: string; expect?: string }): Promise<Moved>;
  /** The calendars on this account the owner switched on and can add events to, main first. */
  calendars(accountId: string): Promise<Array<{ id: string; name: string; primary: boolean }>>;
  /** Add one event (create_event). Only the fields here reach the calendar. */
  create(accountId: string, req: NewEvent & { calendarId: string }): Promise<Created>;
  /** Undo of create: delete one event Athena added (the adapter checks calendar_creates too). */
  removeCreated(accountId: string, req: { calendarId: string; eventId: string }): Promise<void>;
}

/** The fields an event Athena adds may have: nothing else is ever sent. */
export interface NewEvent {
  summary: string;
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  description?: string;
  attendees: Array<{ email: string; name?: string }>;
  /** A to-do's focus block: no guests, busy. */
  block?: true;
  /** As Google's Focus time (Settings → Days, "Block time as Focus time"); other calendars ignore it. */
  focusTime?: true;
}

export interface Created {
  id: string;
  calendarId: string;
  link: string;
  guests: number;
}

// ---------- Working hours (Settings → Days) ----------

const HOURS_KEY = "days_working_hours";

export async function loadWorkingHours(): Promise<WorkingHours> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [HOURS_KEY]);
    return readWorkingHours(row?.value);
  } catch {
    return { ...DEFAULT_HOURS };
  }
}

export async function saveWorkingHours(raw: unknown): Promise<WorkingHours> {
  if (!raw || typeof raw !== "object") throw new AthenaInputError("Send { days, start, end, buffer }");
  const merged = { ...(await loadWorkingHours()), ...(raw as object) };
  const hours = readWorkingHours(merged);
  // Anything the owner sent that didn't survive the check is a mistake worth saying, not a silent default.
  for (const k of ["start", "end", "buffer"] as const) {
    if ((raw as Record<string, unknown>)[k] !== undefined && (raw as Record<string, unknown>)[k] !== hours[k]) throw new AthenaInputError(k === "buffer" ? "buffer: 0 to 60 minutes" : "Working hours: a start before the end, as HH:MM");
  }
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [HOURS_KEY, JSON.stringify(hours)],
  );
  return hours;
}

// ---------- Focus time (Settings → Days) ----------

const FOCUS_KEY = "days_focus_time";

/** "Block time as Focus time": off until the owner turns it on. */
export async function loadFocusTime(): Promise<boolean> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [FOCUS_KEY]);
    return row?.value === true;
  } catch {
    return false;
  }
}

export async function saveFocusTime(on: unknown): Promise<boolean> {
  if (typeof on !== "boolean") throw new AthenaInputError("Send { on: true } or { on: false }");
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [FOCUS_KEY, JSON.stringify(on)],
  );
  return on;
}

// ---------- Finding times ----------

export interface Invitee {
  name?: string;
  email?: string;
}

export interface SlotOffer {
  start: string;
  end: string;
}

export interface SlotCard {
  minutes: number;
  tz: string;
  /** "a 30 min call with Priya": what was asked for, for the card's head. */
  title: string;
  slots: SlotOffer[];
  /** Each guest: whether their calendar was seen. Never what's on it. */
  people: Array<{ name: string; email: string; seen: boolean }>;
  /** Calendars of the owner's that couldn't be read (the slots may clash with them). */
  unread: string[];
  /** When an existing event would move: it, and whether Athena may move it. */
  event?: { id: string; title: string; starts_at: string | null; can_move: boolean; why?: string };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The range to search: the owner's dates, whole days in their zone; by default the next 7 days. */
function range(fromDate: string | undefined, toDate: string | undefined, tz: string, now: Date): { from: Date; to: Date } {
  const today = zonedToday(now, tz);
  const a = fromDate && isValidDate(fromDate) && fromDate >= today ? fromDate : today;
  let b = toDate && isValidDate(toDate) && toDate >= a ? toDate : addDays(a, 6);
  if (b > addDays(a, 30)) b = addDays(a, 30);
  return { from: zonedToInstant(a, "00:00", tz), to: zonedToInstant(addDays(b, 1), "00:00", tz) };
}

/** A guest's address: the one given, or the email of the one person in Athena with that name. */
async function addressOf(i: Invitee): Promise<{ name: string; email: string }> {
  const email = i.email?.trim().toLowerCase() ?? "";
  const name = i.name?.trim() || email.split("@")[0] || "Someone";
  if (/^[^\s@]+@[^\s@]+$/.test(email)) return { name, email };
  if (!i.name?.trim()) return { name, email: "" };
  const found = await findPeople(i.name).catch(() => []);
  const strong = found.filter((f) => f.matched_on === "name" || f.matched_on === "email");
  const person = (strong.length === 1 ? strong[0] : found.length === 1 ? found[0] : undefined)?.person;
  return { name: person?.name ?? name, email: person?.email?.trim().toLowerCase() ?? "" };
}

/** "Design review" → the Athena event and whether its calendar account lets Athena move it. */
async function moveTarget(id: string): Promise<{ event: AthenaEvent; accountId: string | null; can: boolean; why?: string }> {
  const event = await getEvent(id);
  if (!event) throw new AthenaInputError("That event isn't there any more", 404);
  if (!event.calendar_connector_id || !event.calendar_event_id) return { event, accountId: null, can: false, why: "Athena doesn't know which calendar this event is on, so it can't move it." };
  const account = (await listConnectors()).find((c) => c.id === event.calendar_connector_id);
  if (!account) return { event, accountId: null, can: false, why: "The calendar account this event came from isn't connected any more." };
  if (!canMove(account)) return { event, accountId: account.id, can: false, why: `Turn on “Let Athena add and update events” for ${account.name} to move it from here.` };
  if (account.status !== "connected") return { event, accountId: account.id, can: false, why: `Sign in to ${account.name} again, in Sources.` };
  return { event, accountId: account.id, can: true };
}

/**
 * The best three times for a call or meeting. `who` are the guests; `event_id`
 * an existing event to move (its own time doesn't count as busy, and its
 * length is used when `minutes` isn't given).
 */
export async function findTimes(
  input: { minutes?: number; who?: Invitee[]; from?: string; to?: string; event_id?: string; title?: string },
  deps: { scheduling: SchedulingPort; now?: Date; tz?: string },
): Promise<SlotCard> {
  const now = deps.now ?? new Date();
  const tz = deps.tz ?? (await getOwnerTimeZone());
  const target = input.event_id ? await moveTarget(input.event_id) : null;
  if (input.minutes !== undefined && !(input.minutes >= 5 && input.minutes <= 8 * 60)) throw new AthenaInputError("How long: 5 minutes to 8 hours");
  const { from, to } = range(input.from, input.to, tz, now);
  const [hours, accounts] = await Promise.all([loadWorkingHours(), listConnectors()]);
  const calendars = accounts.filter((c) => (CALENDAR_PROVIDERS as readonly string[]).includes(c.provider) && c.status === "connected");

  // The owner's own busy times, from every calendar account they've connected.
  const unread: string[] = [];
  const events: CalendarEventLite[] = [];
  await Promise.all(
    calendars.map(async (c) => {
      try {
        events.push(...(await deps.scheduling.events(c.id, from, to)));
      } catch {
        unread.push(c.account_label ? `${c.name} (${c.account_label})` : c.name);
      }
    }),
  );
  const moving = target?.event.calendar_event_id;
  const own = busyFromEvents(moving ? events.filter((e) => e.id !== moving) : events, tz);
  // Moving an event: its own length, from its calendar, unless one was asked for.
  const its = moving ? events.find((e) => e.id === moving && e.start && e.end && !e.allDay) : undefined;
  const minutes = Math.round(input.minutes ?? (its ? (Date.parse(its.end!) - Date.parse(its.start!)) / 60_000 : 30)) || 30;
  const [legs, trips] = await Promise.all([listBookingsStarting(new Date(from.getTime() - 86_400_000), to).catch(() => []), listTrips({ upcomingOnly: true }).catch(() => [])]);
  const travel = busyFromTravel(legs, trips, tz);

  // Guests: each address asked of each account that shows other people's calendars, until one does.
  const people = await Promise.all((input.who ?? []).slice(0, 10).map(addressOf));
  const askable = calendars.filter((c) => FREE_BUSY_PROVIDERS.has(c.provider));
  const guests: GuestBusy[] = [];
  const seen = new Map<string, boolean>();
  const pending = [...new Set(people.filter((p) => p.email).map((p) => p.email))];
  for (const c of askable) {
    const want = pending.filter((e) => !seen.get(e));
    if (!want.length) break;
    try {
      for (const r of await deps.scheduling.freeBusy(c.id, want, from, to)) {
        if (r.status !== "known" || seen.get(r.email.toLowerCase())) continue;
        seen.set(r.email.toLowerCase(), true);
        guests.push({ who: r.email, busy: r.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })), ...(r.hours ? { hours: r.hours } : {}) });
      }
    } catch {
      // This account couldn't answer: the next one may.
    }
  }

  const slots = findSlots({
    from: from.getTime(),
    to: to.getTime(),
    minutes,
    tz,
    hours,
    busy: [...own.busy, ...travel.busy],
    blockedDays: [...own.blockedDays, ...travel.blockedDays],
    awayDays: travel.awayDays,
    guests,
    now: now.getTime(),
  });
  const names = people.map((p) => firstName(p.name));
  const what = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} min`;
  const title = input.title?.trim() || (target ? target.event.title : `A ${what} ${people.length ? "call" : "slot"}${names.length ? ` with ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}` : ""}`);
  return {
    minutes,
    tz,
    title: title.slice(0, 200),
    slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    people: people.map((p) => ({ name: p.name, email: p.email, seen: !!p.email && !!seen.get(p.email) })),
    unread: unread.sort(),
    ...(target ? { event: { id: target.event.id, title: target.event.title, starts_at: target.event.starts_at, can_move: target.can, ...(target.why ? { why: target.why } : {}) } } : {}),
  };
}

/** "Couldn't see Sam's calendar", for each guest whose calendar wasn't shown. */
export function unseenLines(card: Pick<SlotCard, "people">): string[] {
  return card.people.filter((p) => !p.seen).map((p) => (p.email ? `Couldn't see ${firstName(p.name)}'s calendar` : `No email for ${firstName(p.name)}, so Athena couldn't check their calendar`));
}

// ---------- Moving ----------

export interface MoveUndo {
  op: "move_event";
  id: string;
  start: string;
  end: string;
  /** Where it was moved to: Undo is refused if it has moved again since. */
  expect: string;
}

export interface MoveResult {
  event: AthenaEvent;
  moved: Moved;
  /** "Google Calendar", "Outlook", "iCloud Calendar". */
  where: string;
  undo: MoveUndo;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Move one of the owner's events: on its calendar first, then in Athena.
 * `expect` (Undo's) refuses it if the event isn't where Athena left it.
 */
export async function moveEvent(id: string, when: { start: string; end?: string; expect?: string }, deps: { scheduling: SchedulingPort }): Promise<MoveResult> {
  if (!ISO.test(when.start) || (when.end && !ISO.test(when.end))) throw new AthenaInputError("start and end: ISO 8601 times with an offset");
  if (when.end && Date.parse(when.end) <= Date.parse(when.start)) throw new AthenaInputError("end must be after start");
  const target = await moveTarget(id);
  if (!target.can || !target.accountId) throw new AthenaInputError(target.why ?? "Athena can't move this event");
  const ev = target.event;
  const account = (await listConnectors()).find((c) => c.id === target.accountId);
  const moved = await deps.scheduling.move(target.accountId, {
    calendarId: ev.calendar_id || "primary",
    eventId: ev.calendar_event_id!,
    start: new Date(Date.parse(when.start)).toISOString(),
    ...(when.end ? { end: new Date(Date.parse(when.end)).toISOString() } : {}),
    ...(when.expect ? { expect: when.expect } : {}),
  });
  const tz = await getOwnerTimeZone();
  await q(`UPDATE events SET starts_at = $2::timestamptz, ends_at = $4::timestamptz, date = $3::date, updated_at = now() WHERE id = $1`, [id, moved.after.start, zonedParts(new Date(moved.after.start), tz).date, moved.after.end]);
  return {
    event: (await getEvent(id))!,
    moved,
    where: calendarName(account?.provider),
    undo: { op: "move_event", id, start: moved.before.start, end: moved.before.end, expect: moved.after.start },
  };
}

export const isMoveUndo = (raw: unknown): raw is MoveUndo => !!raw && typeof raw === "object" && (raw as { op?: unknown }).op === "move_event";

/** Undo: back to where it was, on the calendar and in Athena, unless it has moved again since. */
export async function applyMoveUndo(raw: unknown, deps: { scheduling?: SchedulingPort }): Promise<MoveResult> {
  const u = raw as Partial<MoveUndo>;
  if (!isMoveUndo(raw) || typeof u.id !== "string" || !/^[0-9a-f-]{36}$/i.test(u.id) || typeof u.start !== "string" || typeof u.end !== "string" || typeof u.expect !== "string") {
    throw new AthenaInputError("That can't be undone");
  }
  if (!deps.scheduling) throw new AthenaInputError("That can't be undone here");
  return moveEvent(u.id, { start: u.start, end: u.end, expect: u.expect }, { scheduling: deps.scheduling });
}

// ---------- Adding events ----------

/** "meeting": with guests (Book it, Ask); "booking": from an email, no guests (Check in); "focus": a block for a to-do, no guests. */
export type CreateKind = "meeting" | "booking" | "focus";

/** One calendar an event can go on. */
export interface CalendarOption {
  account_id: string;
  calendar_id: string;
  /** "Work", "Home": the calendar's own name. */
  name: string;
  /** "Google Calendar (work)". */
  account: string;
  provider: string;
  primary: boolean;
}

export interface CreateProposal {
  kind: CreateKind;
  title: string;
  start: string;
  end: string;
  tz: string;
  location?: string;
  description?: string;
  /** Who gets an invite. Never anyone for a booking or a focus block. */
  attendees: Array<{ name: string; email: string }>;
  /** Names Athena has no address for: they don't get an invite. */
  missing: string[];
  /** Every calendar the owner can add to, and the one picked: each account's main calendar, the first account's by default. */
  calendars: CalendarOption[];
  calendar: { account_id: string; calendar_id: string } | null;
  /** Why nothing can be added yet (no account has the switch on). */
  why?: string;
}

export interface CreateUndo {
  op: "create_event";
  /** The calendar_creates row. */
  id: string;
}

export interface CreateResult {
  id: string;
  title: string;
  start: string;
  end: string;
  tz: string;
  guests: number;
  /** "Google Calendar", "Outlook", "iCloud Calendar". */
  where: string;
  calendar: string;
  /** "Open in calendar". */
  link: string;
  undo: CreateUndo;
}

const accountLabel = (c: { name: string; account_label?: string | null }) => (c.account_label ? `${c.name} (${c.account_label})` : c.name);

/** The calendars Athena may add to: every connected calendar account with the switch on, each account's main calendar first. */
export async function writableCalendars(deps: { scheduling: SchedulingPort }): Promise<{ calendars: CalendarOption[]; why?: string }> {
  const accounts = (await listConnectors()).filter((c) => (CALENDAR_PROVIDERS as readonly string[]).includes(c.provider));
  const on = accounts.filter((c) => canMove(c) && c.status === "connected");
  if (!on.length) {
    const off = accounts[0];
    return { calendars: [], why: off ? `Turn on “Let Athena add and update events” for ${off.name} in Sources to add events from here.` : "Connect a calendar in Sources to add events from here." };
  }
  const lists = await Promise.all(
    on.map(async (c) => {
      try {
        return (await deps.scheduling.calendars(c.id)).map((k) => ({ account_id: c.id, calendar_id: k.id, name: k.name || "Main calendar", account: accountLabel(c), provider: c.provider, primary: k.primary }));
      } catch {
        return [] as CalendarOption[];
      }
    }),
  );
  const calendars = lists.flat();
  return calendars.length ? { calendars } : { calendars, why: "Athena couldn't read your calendars just now. Try again in a minute." };
}

export interface GuestsResolved {
  people: Array<{ name: string; email: string }>;
  /** Names with no address in Athena. */
  missing: string[];
  /** Names that match more than one person: ask which. */
  ambiguous: Array<{ name: string; options: Array<{ name: string; email: string }> }>;
}

/** Guests by name or address: an address as given, a name only when one person in Athena has it and an email. */
export async function resolveGuests(who: Invitee[] | undefined): Promise<GuestsResolved> {
  const out: GuestsResolved = { people: [], missing: [], ambiguous: [] };
  const seen = new Set<string>();
  for (const i of (who ?? []).slice(0, 20)) {
    const email = i.email?.trim().toLowerCase() ?? "";
    const given = i.name?.trim() ?? "";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (!seen.has(email)) out.people.push({ name: given || email.split("@")[0], email });
      seen.add(email);
      continue;
    }
    if (!given) continue;
    const found = await findPeople(given).catch(() => []);
    const strong = found.filter((f) => f.matched_on === "name" || f.matched_on === "email");
    const pool = (strong.length ? strong : found).filter((f) => f.person.email);
    if (pool.length === 1 || (strong.length === 1 && strong[0].person.email)) {
      const p = (strong.length === 1 ? strong[0] : pool[0]).person;
      const e = p.email!.trim().toLowerCase();
      if (!seen.has(e)) out.people.push({ name: p.name, email: e });
      seen.add(e);
    } else if (pool.length > 1) {
      out.ambiguous.push({ name: given, options: pool.slice(0, 5).map((f) => ({ name: f.person.name, email: f.person.email!.trim().toLowerCase() })) });
    } else out.missing.push(found.length === 1 ? found[0].person.name : given);
  }
  return out;
}

/**
 * The event to confirm: title, when, where, who gets an invite and which
 * calendar. Nothing is added here. A booking or a focus block never invites
 * anyone, whatever's asked.
 */
export async function prepareCreate(
  input: { kind?: CreateKind; title: string; start: string; end?: string; minutes?: number; location?: string; description?: string; who?: Invitee[] },
  deps: { scheduling: SchedulingPort; tz?: string },
): Promise<CreateProposal & { ambiguous: GuestsResolved["ambiguous"] }> {
  const kind = input.kind ?? "meeting";
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new AthenaInputError("What's it called?");
  if (!ISO.test(input.start)) throw new AthenaInputError("start: an ISO 8601 time with an offset");
  const start = Date.parse(input.start);
  const minutes = input.minutes ?? (kind === "focus" ? 60 : 30);
  if (input.end !== undefined && !ISO.test(input.end)) throw new AthenaInputError("end: an ISO 8601 time with an offset");
  const end = input.end ? Date.parse(input.end) : start + minutes * 60_000;
  if (!(end > start) || end - start > 24 * 3_600_000) throw new AthenaInputError("It has to end after it starts, within a day");
  const tz = deps.tz ?? (await getOwnerTimeZone());
  const guests = kind === "meeting" ? await resolveGuests(input.who) : { people: [], missing: [], ambiguous: [] };
  const { calendars, why } = await writableCalendars(deps);
  const main = calendars.find((c) => c.primary) ?? calendars[0];
  return {
    kind,
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    tz,
    ...(input.location?.trim() ? { location: input.location.trim().slice(0, 500) } : {}),
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 4000) } : {}),
    attendees: guests.people,
    missing: guests.missing,
    ambiguous: guests.ambiguous,
    calendars,
    calendar: main ? { account_id: main.account_id, calendar_id: main.calendar_id } : null,
    ...(why ? { why } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where "Open in calendar" goes when the calendar gave no link of its own. */
function dayLink(provider: string | undefined, startIso: string, tz: string): string {
  const d = zonedParts(new Date(startIso), tz).date.replace(/-/g, "/");
  if (provider === "google-calendar") return `https://calendar.google.com/calendar/r/day/${d}`;
  if (provider === "outlook-calendar") return `https://outlook.office.com/calendar/view/day/${d}`;
  return "https://www.icloud.com/calendar/";
}

/**
 * Add the event, after the owner tapped Add in the confirm sheet: on the
 * calendar they picked, with "Let Athena add and update events" on for its
 * account. Recorded in calendar_creates, which is what Undo may delete.
 */
export async function createEvent(
  input: {
    kind?: CreateKind;
    account_id: string;
    calendar_id: string;
    title: string;
    start: string;
    end: string;
    location?: string;
    description?: string;
    attendees?: Array<{ name?: string; email: string }>;
  },
  deps: { scheduling: SchedulingPort; tz?: string },
): Promise<CreateResult> {
  const kind = input.kind ?? "meeting";
  if (!UUID_RE.test(input.account_id)) throw new AthenaInputError("account_id: a calendar account's id");
  if (!input.calendar_id || input.calendar_id.length > 1500) throw new AthenaInputError("calendar_id: which calendar");
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new AthenaInputError("What's it called?");
  if (!ISO.test(input.start) || !ISO.test(input.end)) throw new AthenaInputError("start and end: ISO 8601 times with an offset");
  const start = Date.parse(input.start);
  const end = Date.parse(input.end);
  if (!(end > start) || end - start > 24 * 3_600_000) throw new AthenaInputError("It has to end after it starts, within a day");
  const attendees = kind === "meeting" ? (input.attendees ?? []) : [];
  if (kind !== "meeting" && input.attendees?.length) throw new AthenaInputError(kind === "focus" ? "A focus block goes on your calendar only, with no guests" : "Adding a booking doesn't invite anyone");
  if (attendees.length > 50 || attendees.some((a) => !EMAIL_RE.test(a.email?.trim() ?? ""))) throw new AthenaInputError("Guests: up to 50 email addresses");
  const account = (await listConnectors()).find((c) => c.id === input.account_id);
  if (!account || !(CALENDAR_PROVIDERS as readonly string[]).includes(account.provider)) throw new AthenaInputError("That calendar account isn't connected any more", 404);
  if (!canMove(account)) throw new AthenaInputError(`Turn on “Let Athena add and update events” for ${account.name} to add events from here.`);
  if (account.status !== "connected") throw new AthenaInputError(`Sign in to ${account.name} again, in Sources.`);
  const tz = deps.tz ?? (await getOwnerTimeZone());
  const made = await deps.scheduling.create(account.id, {
    calendarId: input.calendar_id,
    summary: title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timeZone: tz,
    ...(input.location?.trim() ? { location: input.location.trim().slice(0, 500) } : {}),
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 4000) } : {}),
    attendees: attendees.map((a) => ({ email: a.email.trim().toLowerCase(), ...(a.name?.trim() ? { name: a.name.trim().slice(0, 200) } : {}) })),
    // A to-do's block is busy; as Google's Focus time only when the owner chose that.
    ...(kind === "focus" ? { block: true as const, ...((await loadFocusTime()) ? { focusTime: true as const } : {}) } : {}),
  });
  const startIso = new Date(start).toISOString();
  const link = made.link || dayLink(account.provider, startIso, tz);
  const row = await recordCreate({ connector_id: account.id, calendar_id: made.calendarId, event_id: made.id, url: link });
  return {
    id: row.id,
    title,
    start: startIso,
    end: new Date(end).toISOString(),
    tz,
    guests: made.guests,
    where: calendarName(account.provider),
    calendar: accountLabel(account),
    link,
    undo: { op: "create_event", id: row.id },
  };
}

export const isCreateUndo = (raw: unknown): raw is CreateUndo => !!raw && typeof raw === "object" && (raw as { op?: unknown }).op === "create_event";

/** Undo: delete the one event Athena added, and nothing else. Guests get a cancellation. Refused once it's been undone. */
export async function applyCreateUndo(raw: unknown, deps: { scheduling?: SchedulingPort }): Promise<{ id: string; undone: true }> {
  const u = raw as Partial<CreateUndo>;
  if (!isCreateUndo(raw) || typeof u.id !== "string" || !UUID_RE.test(u.id)) throw new AthenaInputError("That can't be undone");
  if (!deps.scheduling) throw new AthenaInputError("That can't be undone here");
  const row = await getCreate(u.id);
  if (!row) throw new AthenaInputError("Athena has no record of adding that event", 404);
  if (row.undone_at) throw new AthenaInputError("That event was already removed");
  const account = (await listConnectors()).find((c) => c.id === row.connector_id);
  if (!account) throw new AthenaInputError("The calendar account it went on isn't connected any more");
  if (!canMove(account)) throw new AthenaInputError(`Turn on “Let Athena add and update events” for ${account.name} to take it back from here, or delete it in ${calendarName(account.provider)}.`);
  await deps.scheduling.removeCreated(account.id, { calendarId: row.calendar_id, eventId: row.event_id });
  await markUndone(row.id);
  return { id: row.id, undone: true };
}

/**
 * "Block time for this" on a to-do: the first free slot (lib/availability.ts,
 * the owner's working hours, no guests) before it's due, as a focus block to
 * confirm. On the owner's calendar only.
 */
export async function blockTime(
  input: { title: string; minutes?: number; due?: string | null },
  deps: { scheduling: SchedulingPort; now?: Date; tz?: string },
): Promise<CreateProposal & { ambiguous: GuestsResolved["ambiguous"] }> {
  const now = deps.now ?? new Date();
  const tz = deps.tz ?? (await getOwnerTimeZone());
  const minutes = input.minutes ?? 60;
  const today = zonedToday(now, tz);
  // Before it's due when that's a few days off; otherwise the coming week.
  const to = input.due && isValidDate(input.due) && input.due > today ? (input.due < addDays(today, 2) ? addDays(today, 2) : input.due) : addDays(today, 6);
  const card = await findTimes({ minutes, from: today, to, title: input.title }, { scheduling: deps.scheduling, now, tz });
  const slot = card.slots[0];
  if (!slot) throw new AthenaInputError(`No free ${minutes === 60 ? "hour" : minutes > 60 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`} in your working hours before then. Try a shorter block.`);
  return prepareCreate({ kind: "focus", title: input.title, start: slot.start, end: slot.end }, { scheduling: deps.scheduling, tz });
}
