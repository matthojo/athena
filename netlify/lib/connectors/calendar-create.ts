/**
 * create_event's arguments, read the same way for Google, Outlook and
 * iCloud: a title, a start and end, the owner's zone, maybe a place and a
 * description, and guests as addresses. Nothing else is read, so nothing
 * else can reach a calendar. The adapters turn these into each provider's
 * request, which is checked again by shape (isCreateInsert, isCreatePost,
 * isNewEventIcs) before it's sent.
 */
import { isValidTimeZone, zonedToInstant } from "../../../lib/dates";
import { ToolInputError, arg } from "./google-api";

/** google-calendar.ts's toInstant, kept here so the adapters can import this file without a cycle. */
function toInstant(raw: string, tz: string, what: string): Date {
  const s = raw.trim();
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (local) return new Date(zonedToInstant(local[1], local[2] ?? "00:00", tz).getTime() + Number(local[3] ?? 0) * 1000);
  const at = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? Date.parse(s) : NaN;
  if (Number.isNaN(at)) throw new ToolInputError(`${what} must be an ISO 8601 time, like 2026-11-07T09:00:00`);
  return new Date(at);
}

export const CREATE_ARGS = ["calendarId", "summary", "start", "end", "timeZone", "location", "description", "attendees", "block", "focusTime"];

export const CREATE_SCHEMA = {
  type: "object" as const,
  properties: {
    calendarId: { type: "string", description: "Default: the main calendar." },
    summary: { type: "string", description: "The title." },
    start: { type: "string", description: "ISO 8601 with offset." },
    end: { type: "string", description: "ISO 8601 with offset, after start." },
    timeZone: { type: "string", description: "The owner's IANA zone." },
    location: { type: "string" },
    description: { type: "string" },
    attendees: { type: "array", items: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } } }, description: "Guests, who get an invite." },
    block: { type: "boolean", description: "A focus block for a to-do: no guests, shown as busy." },
    focusTime: { type: "boolean", description: "With block: as Google's Focus time. Google Calendar only." },
  },
  required: ["summary", "start", "end"],
};

export interface CreateArgs {
  calendarId?: string;
  summary: string;
  start: Date;
  end: Date;
  timeZone?: string;
  location?: string;
  description?: string;
  attendees: Array<{ email: string; name?: string }>;
  block?: true;
  focusTime?: true;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read create_event's arguments, refusing any it doesn't know. `self` (the account's own addresses) are never invited. */
export function readCreateArgs(args: Record<string, unknown>, tz: string, self: string[] = []): CreateArgs {
  const extra = Object.keys(args).filter((k) => !CREATE_ARGS.includes(k));
  if (extra.length) throw new ToolInputError(`create_event doesn't take ${extra.join(", ")}`);
  const summary = arg.str(args, "summary", { required: true, max: 300 })!.trim();
  if (!summary) throw new ToolInputError("summary is required");
  const zone = arg.str(args, "timeZone", { max: 80 });
  if (zone && !isValidTimeZone(zone)) throw new ToolInputError("timeZone must be an IANA zone, like Europe/London");
  const at = zone ?? tz;
  const start = toInstant(arg.str(args, "start", { required: true, max: 60 })!, at, "start");
  const end = toInstant(arg.str(args, "end", { required: true, max: 60 })!, at, "end");
  if (end.getTime() <= start.getTime()) throw new ToolInputError("end must be after start");
  if (end.getTime() - start.getTime() > 24 * 3_600_000) throw new ToolInputError("An event Athena adds is at most a day long");
  const location = arg.str(args, "location", { max: 500 })?.trim() || undefined;
  const description = arg.str(args, "description", { max: 4000 })?.trim() || undefined;
  const raw = args.attendees;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 50)) throw new ToolInputError("attendees: up to 50 guests");
  const mine = new Set(self.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  const attendees: CreateArgs["attendees"] = [];
  for (const a of (raw as unknown[] | undefined) ?? []) {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "email" && k !== "name")) throw new ToolInputError("attendees: each one is { email, name }");
    const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 320) throw new ToolInputError(`attendees: ${email || "a guest"} isn't an email address`);
    if (mine.has(email) || seen.has(email)) continue;
    seen.add(email);
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 200) : "";
    attendees.push({ email, ...(name ? { name } : {}) });
  }
  for (const k of ["block", "focusTime"]) if (args[k] !== undefined && typeof args[k] !== "boolean") throw new ToolInputError(`${k} must be true or false`);
  const block = args.block === true;
  const focusTime = args.focusTime === true;
  if (focusTime && !block) throw new ToolInputError("focusTime is only for a block");
  if (block && attendees.length) throw new ToolInputError("A block has no guests");
  return { calendarId: arg.str(args, "calendarId", { max: 1500 }), summary, ...(block ? { block: true as const } : {}), ...(focusTime ? { focusTime: true as const } : {}), start, end, ...(zone ? { timeZone: zone } : {}), ...(location ? { location } : {}), ...(description ? { description } : {}), attendees };
}

/** What every adapter's create_event returns. */
export interface CreatedOut {
  id: string;
  calendarId: string;
  link: string;
  guests: number;
  summary: string;
  start: string;
  end: string;
}
