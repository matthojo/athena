/**
 * Finding a time, moving an event and adding one, for the app
 * (lib/scheduling.ts, served by netlify/lib/scheduling/routes.ts). Sample
 * mode has no server: it makes up a believable week (Priya's calendar seen,
 * Marcus's not, a work Google calendar and a home iCloud one) and pretends
 * to move and add things, saying so.
 */
import { isSampleMode, request } from "./api";
import { localToday } from "../lib/time";

export interface WorkingHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  start: string;
  end: string;
  buffer: number;
}

export const DEFAULT_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", buffer: 10 };

export interface SlotCard {
  minutes: number;
  tz: string;
  title: string;
  slots: Array<{ start: string; end: string }>;
  people: Array<{ name: string; email: string; seen: boolean }>;
  unread: string[];
  event?: { id: string; title: string; starts_at: string | null; can_move: boolean; why?: string };
}

export interface MoveProposal {
  event_id: string;
  title: string;
  from: string | null;
  start: string;
  end?: string;
}

export type CreateKind = "meeting" | "booking" | "focus";

export interface CalendarOption {
  account_id: string;
  calendar_id: string;
  name: string;
  account: string;
  provider: string;
  primary: boolean;
}

/** An event to confirm before it's added: nothing is on a calendar yet. */
export interface CreateProposal {
  kind: CreateKind;
  title: string;
  start: string;
  end: string;
  tz: string;
  location?: string;
  description?: string;
  attendees: Array<{ name: string; email: string }>;
  missing: string[];
  calendars: CalendarOption[];
  calendar: { account_id: string; calendar_id: string } | null;
  why?: string;
}

export interface CreateUndo {
  op: "create_event";
  id: string;
}

export interface CreateResult {
  id: string;
  title: string;
  start: string;
  end: string;
  tz: string;
  guests: number;
  where: string;
  calendar: string;
  link: string;
  undo: CreateUndo;
}

export interface CreateInput {
  kind?: CreateKind;
  title: string;
  start: string;
  end?: string;
  minutes?: number;
  location?: string;
  description?: string;
  who?: Array<{ name?: string; email?: string }>;
}

export type SchedulingCard = { kind: "slots"; card: SlotCard } | { kind: "move"; move: MoveProposal } | { kind: "create"; create: CreateProposal };

export interface MoveUndo {
  op: "move_event";
  id: string;
  start: string;
  end: string;
  expect: string;
}

export interface MoveResult {
  event: { id: string; title: string; starts_at: string | null };
  before: { start: string; end: string };
  after: { start: string; end: string };
  guests: number;
  where: string;
  undo: MoveUndo;
}

export interface FindInput {
  minutes?: number;
  who?: Array<{ name?: string; email?: string }>;
  from?: string;
  to?: string;
  event_id?: string;
  title?: string;
}

const HOURS_KEY = "athena.sample.working-hours";

export async function fetchWorkingHours(): Promise<WorkingHours> {
  if (isSampleMode()) {
    try {
      const raw = localStorage.getItem(HOURS_KEY);
      return raw ? { ...DEFAULT_HOURS, ...(JSON.parse(raw) as Partial<WorkingHours>) } : { ...DEFAULT_HOURS };
    } catch {
      return { ...DEFAULT_HOURS };
    }
  }
  return request<WorkingHours>("/scheduling/hours");
}

export async function saveWorkingHours(patch: Partial<WorkingHours>): Promise<WorkingHours> {
  if (isSampleMode()) {
    const next = { ...(await fetchWorkingHours()), ...patch };
    try {
      localStorage.setItem(HOURS_KEY, JSON.stringify(next));
    } catch {
      // Private window: it holds for this visit.
    }
    return next;
  }
  return request<WorkingHours>("/scheduling/hours", { method: "PUT", body: JSON.stringify(patch) });
}

const FOCUS_KEY = "athena.sample.focus-time";

/** "Block time as Focus time" (Settings → Days): off until turned on. */
export async function fetchFocusTime(): Promise<boolean> {
  if (isSampleMode()) {
    try {
      return localStorage.getItem(FOCUS_KEY) === "1";
    } catch {
      return false;
    }
  }
  return (await request<{ on: boolean }>("/scheduling/focus")).on;
}

export async function saveFocusTime(on: boolean): Promise<boolean> {
  if (isSampleMode()) {
    try {
      localStorage.setItem(FOCUS_KEY, on ? "1" : "0");
    } catch {
      // Private window: it holds for this visit.
    }
    return on;
  }
  return (await request<{ on: boolean }>("/scheduling/focus", { method: "PUT", body: JSON.stringify({ on }) })).on;
}

// ---------- sample mode ----------

export const SAMPLE_EVENT_ID = "5a3e0000-0000-4000-8000-0000000e0001";
const SAMPLE_TZ = "Europe/London";

/** The next `n` weekdays after today, as YYYY-MM-DD. */
function weekdays(n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${localToday()}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** "2026-11-12", "14:00" in London as an instant (GMT in winter, BST in summer). */
function london(date: string, time: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = new Intl.DateTimeFormat("en-GB", { timeZone: SAMPLE_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(guess);
  const [h, m] = shown.split(":").map(Number);
  const [wh, wm] = time.split(":").map(Number);
  return new Date(guess.getTime() - ((h * 60 + m) - (wh * 60 + wm)) * 60_000).toISOString();
}

/** The sample Design review: tomorrow-ish at 15:00, organised by you. */
export function sampleEvent(): { id: string; title: string; starts_at: string } {
  return { id: SAMPLE_EVENT_ID, title: "Design review", starts_at: london(weekdays(1)[0], "15:00") };
}

export function sampleCard(input: FindInput = {}): SlotCard {
  const minutes = input.minutes ?? 30;
  const [a, b, c] = weekdays(4).slice(1);
  const plus = (iso: string) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
  const starts = [london(a, "11:00"), london(b, "14:30"), london(c, "10:00")];
  const who = input.who?.length ? input.who : [{ name: "Priya Shah" }, { name: "Marcus Webb" }];
  const people = who.map((w, i) => ({ name: w.name ?? w.email ?? "Someone", email: w.email ?? `${(w.name ?? "someone").split(" ")[0].toLowerCase()}@example.com`, seen: i === 0 }));
  const event = input.event_id ? { ...sampleEvent(), can_move: true } : undefined;
  const first = (n: string) => n.split(" ")[0];
  const names = people.map((p) => first(p.name));
  return {
    minutes,
    tz: SAMPLE_TZ,
    title: input.title ?? (event ? event.title : `A ${minutes} min call with ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}`),
    slots: starts.map((s) => ({ start: s, end: plus(s) })),
    people,
    unread: [],
    ...(event ? { event } : {}),
  };
}

function sampleMove(id: string, start: string, end: string | undefined, from: { start: string; end: string }): MoveResult {
  const length = Date.parse(from.end) - Date.parse(from.start);
  const after = { start, end: end ?? new Date(Date.parse(start) + length).toISOString() };
  return {
    event: { id, title: "Design review", starts_at: after.start },
    before: from,
    after,
    guests: 2,
    where: "Google Calendar",
    undo: { op: "move_event", id, start: from.start, end: from.end, expect: after.start },
  };
}

// ---------- the API ----------

export async function findTimes(input: FindInput): Promise<SlotCard> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 450));
    return sampleCard(input);
  }
  return request<SlotCard>("/scheduling/find", { method: "POST", body: JSON.stringify(input) });
}

/** Move it, after the owner tapped Move in the confirm sheet. */
export async function moveEvent(eventId: string, start: string, end?: string): Promise<MoveResult> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 500));
    const was = sampleEvent();
    return sampleMove(eventId, start, end, { start: was.starts_at, end: new Date(Date.parse(was.starts_at) + 30 * 60_000).toISOString() });
  }
  return request<MoveResult>("/scheduling/move", { method: "POST", body: JSON.stringify({ event_id: eventId, start, ...(end ? { end } : {}) }) });
}

/** Undo: back where it was. */
export async function undoMove(undo: MoveUndo): Promise<MoveResult> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 350));
    return sampleMove(undo.id, undo.start, undo.end, { start: undo.expect, end: undo.expect });
  }
  return request<MoveResult>("/scheduling/undo", { method: "POST", body: JSON.stringify({ undo }) });
}

// ---------- adding events ----------

/** Sample mode's two calendars: work on Google, home on iCloud. */
export const SAMPLE_CALENDARS: CalendarOption[] = [
  { account_id: "5a3e0000-0000-4000-8000-0000000ca101", calendar_id: "primary", name: "Work", account: "Google Calendar (work)", provider: "google-calendar", primary: true },
  { account_id: "5a3e0000-0000-4000-8000-0000000ca102", calendar_id: "home", name: "Home", account: "iCloud Calendar (personal)", provider: "icloud-calendar", primary: true },
];

const SAMPLE_PEOPLE: Record<string, { name: string; email: string }> = {
  priya: { name: "Priya Shah", email: "priya@example.com" },
  marcus: { name: "Marcus Webb", email: "marcus@example.com" },
  elena: { name: "Elena Costa", email: "elena@example.com" },
};

/** The sample's event to confirm: guests matched by first name, Jo has no address. */
export function sampleProposal(input: CreateInput): CreateProposal {
  const kind = input.kind ?? "meeting";
  const start = Date.parse(input.start);
  const end = input.end ? Date.parse(input.end) : start + (input.minutes ?? (kind === "focus" ? 60 : 30)) * 60_000;
  const attendees: CreateProposal["attendees"] = [];
  const missing: string[] = [];
  if (kind === "meeting") {
    for (const w of input.who ?? []) {
      const key = (w.name ?? w.email ?? "").split(/[\s@]/)[0].toLowerCase();
      const known = SAMPLE_PEOPLE[key];
      if (w.email && !known) attendees.push({ name: w.name ?? w.email, email: w.email });
      else if (known) attendees.push(known);
      else if (w.name) missing.push(w.name);
    }
  }
  // A booking from a personal email goes on the home calendar; everything else on work.
  const cal = kind === "booking" ? SAMPLE_CALENDARS[1] : SAMPLE_CALENDARS[0];
  return {
    kind,
    title: input.title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    tz: SAMPLE_TZ,
    ...(input.location ? { location: input.location } : {}),
    ...(input.description ? { description: input.description } : {}),
    attendees,
    missing,
    calendars: SAMPLE_CALENDARS,
    calendar: { account_id: cal.account_id, calendar_id: cal.calendar_id },
  };
}

/** The event to confirm, with each guest's address and the calendar it goes on. Nothing is added. */
export async function prepareCreate(input: CreateInput): Promise<CreateProposal> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 300));
    return sampleProposal(input);
  }
  return request<CreateProposal>("/scheduling/prepare", { method: "POST", body: JSON.stringify(input) });
}

/** "Block time for this": the first free slot for a to-do, as a focus block to confirm. */
export async function blockTime(input: { title: string; minutes?: number; due?: string | null }): Promise<CreateProposal> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 450));
    const day = weekdays(1)[0];
    const start = london(day, "10:00");
    return sampleProposal({ kind: "focus", title: input.title, start, minutes: input.minutes ?? 60 });
  }
  return request<CreateProposal>("/scheduling/block", { method: "POST", body: JSON.stringify(input) });
}

/** Add it, after the owner tapped Add in the confirm sheet. */
export async function createEvent(p: Pick<CreateProposal, "kind" | "title" | "start" | "end" | "location" | "description" | "attendees">, calendar: { account_id: string; calendar_id: string }): Promise<CreateResult> {
  const attendees = p.kind === "meeting" ? p.attendees : [];
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 500));
    const cal = SAMPLE_CALENDARS.find((c) => c.account_id === calendar.account_id) ?? SAMPLE_CALENDARS[0];
    return {
      id: "5a3e0000-0000-4000-8000-0000000c0001",
      title: p.title,
      start: p.start,
      end: p.end,
      tz: SAMPLE_TZ,
      guests: attendees.length,
      where: cal.provider === "icloud-calendar" ? "iCloud Calendar" : "Google Calendar",
      calendar: cal.account,
      link: cal.provider === "icloud-calendar" ? "https://www.icloud.com/calendar/" : "https://calendar.google.com/calendar/r",
      undo: { op: "create_event", id: "5a3e0000-0000-4000-8000-0000000c0001" },
    };
  }
  return request<CreateResult>("/scheduling/create", {
    method: "POST",
    body: JSON.stringify({ kind: p.kind, ...calendar, title: p.title, start: p.start, end: p.end, location: p.location, description: p.description, attendees }),
  });
}

/** Undo: delete the event Athena added. Guests get a cancellation. */
export async function undoCreate(undo: CreateUndo): Promise<void> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 350));
    return;
  }
  await request("/scheduling/undo", { method: "POST", body: JSON.stringify({ undo }) });
}
