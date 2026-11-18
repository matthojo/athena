/**
 * iCloud: a new start and end for one event you organise, as the smallest
 * change to its iCalendar file. Only DTSTART and DTEND change (each keeps
 * its own TZID, or stays in UTC), and SEQUENCE goes up by one when there are
 * guests, as RFC 5546 asks, so their calendars take the update; iCloud then
 * sends it to them, as it does when you move an event in Apple's Calendar.
 * Every other byte stays as iCloud sent it.
 *
 * Refused: an event someone else organises, an all-day event, a repeating
 * event (Athena never adds a copy of one date), a cancelled one, or one
 * with DURATION when the length would change. The write is one conditional
 * PUT (If-Match on the ETag Athena just read), like icloud-rsvp.ts; a 412
 * re-reads and tries once more. icloud-direct.ts offers it only with "Let
 * Athena move events you organise" on.
 */
import { ToolInputError } from "./google-api";
import { IcloudError, type DavSession } from "./icloud-dav";
import { durationMs, ianaZone, instantOf, parseIcal, parseLine, parseTime, zoneAliases } from "./icloud-ical";
import { fold, logicalLines, type Line } from "./icloud-rsvp";
import { zonedParts } from "../../../lib/dates";

const mailOf = (line: string) =>
  parseLine(line)
    ?.value.replace(/^mailto:/i, "")
    .trim()
    .toLowerCase() ?? "";

/** "20261112T140000" in `tz`, or "20261112T140000Z" in UTC. */
function stamp(ms: number, tz: string): string {
  if (tz === "UTC") return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const p = zonedParts(new Date(ms), tz);
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${p.date.replace(/-/g, "")}T${p.time.replace(":", "")}${sec}`;
}

/** The same line with a new value, its parameters (TZID, VALUE) untouched. */
function withValue(line: string, value: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) return `${line.slice(0, i + 1)}${value}`;
  }
  return line;
}

export interface MoveRewrite {
  text: string;
  changed: boolean;
  before: { start: number; end: number };
  after: { start: number; end: number };
  guests: number;
  summary: string;
}

interface Event {
  lines: Line[];
}

/** The top-level VEVENTs, each with its own lines only (not an alarm's). */
function eventsOf(lines: Line[]): Event[] {
  const events: Event[] = [];
  const stack: string[] = [];
  for (const l of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(l.text.trim());
    const end = /^END:(.+)$/i.exec(l.text.trim());
    if (begin) {
      stack.push(begin[1].toUpperCase());
      if (stack[stack.length - 1] === "VEVENT") events.push({ lines: [] });
    } else if (end) stack.pop();
    else if (stack[stack.length - 1] === "VEVENT") events[events.length - 1].lines.push(l);
  }
  return events;
}

const propOf = (e: Event, name: string) => e.lines.find((l) => new RegExp(`^${name}[;:]`, "i").test(l.text));

/** The event's file with a new start and end. Throws a ToolInputError saying why when Athena won't move it. */
export function rewriteTimes(raw: string, opts: { emails: string[]; start: number; end?: number; expect?: number; ownerZone: string }): MoveRewrite {
  const lines = logicalLines(raw);
  const events = eventsOf(lines);
  const mine = new Set(opts.emails.map((e) => e.toLowerCase()));
  const aliases = zoneAliases(parseIcal(raw));
  if (!events.length) throw new ToolInputError("iCloud doesn't have this event any more");
  const e = events[0];
  if (events.length > 1 || propOf(e, "RRULE") || propOf(e, "RDATE") || propOf(e, "RECURRENCE-ID")) throw new ToolInputError("This event repeats. Athena only moves one-off events on iCloud; move this one in Apple's Calendar app");
  const status = propOf(e, "STATUS");
  if (status && /:CANCELLED\s*$/i.test(status.text)) throw new ToolInputError("This event was cancelled");
  const organizer = propOf(e, "ORGANIZER");
  if (organizer && !mine.has(mailOf(organizer.text))) throw new ToolInputError("Someone else organises this event, so only they can move it");
  const dtstart = propOf(e, "DTSTART");
  const startProp = dtstart && parseLine(dtstart.text);
  const startTime = startProp ? parseTime(startProp, opts.ownerZone, aliases) : null;
  if (!dtstart || !startProp || !startTime) throw new ToolInputError("iCloud didn't say when this event is");
  if (startTime.allDay) throw new ToolInputError("Athena only moves events with a start and end time, not all-day ones");
  const dtend = propOf(e, "DTEND");
  const endProp = dtend && parseLine(dtend.text);
  const duration = propOf(e, "DURATION");
  const wasStart = instantOf(startTime);
  const endTime = endProp ? parseTime(endProp, opts.ownerZone, aliases) : null;
  const wasEnd = endTime ? instantOf(endTime) : duration ? wasStart + (durationMs(parseLine(duration.text)?.value) ?? 0) : wasStart;
  if (opts.expect !== undefined && opts.expect !== wasStart) throw new ToolInputError("This event has moved since Athena last looked. Check it and try again");
  // Without an end, it keeps its length.
  const end = opts.end ?? opts.start + (wasEnd - wasStart);
  if (!(end > opts.start)) throw new ToolInputError("end must be after start");
  if (!dtend && duration && end - opts.start !== wasEnd - wasStart) throw new ToolInputError("This event keeps its length as a duration, so Athena can move it but not change how long it is");
  const guests = e.lines.filter((l) => /^ATTENDEE[;:]/i.test(l.text) && !mine.has(mailOf(l.text))).length;
  const summary = parseLine(propOf(e, "SUMMARY")?.text ?? "")?.value ?? "";
  const before = { start: wasStart, end: wasEnd };
  const after = { start: opts.start, end };
  if (opts.start === wasStart && end === wasEnd) return { text: raw, changed: false, before, after, guests, summary };
  const zoneOf = (p: NonNullable<ReturnType<typeof parseLine>>) => (/Z$/i.test(p.value.trim()) ? "UTC" : p.params.TZID ? ianaZone(p.params.TZID, opts.ownerZone, aliases) : opts.ownerZone);
  const eol = /\r\n/.test(raw) ? "\r\n" : "\n";
  const write = (l: Line, text: string) => (l.folded || Buffer.byteLength(text, "utf8") > 75 ? fold(text, eol) : text);
  const edits: Array<{ at: Line; text: string }> = [{ at: dtstart, text: write(dtstart, withValue(dtstart.text, stamp(opts.start, zoneOf(startProp)))) }];
  if (dtend && endProp) edits.push({ at: dtend, text: write(dtend, withValue(dtend.text, stamp(end, zoneOf(endProp)))) });
  // Guests' calendars take an organiser's change only with a higher SEQUENCE.
  const sequence = propOf(e, "SEQUENCE");
  let insert: { after: Line; text: string } | null = null;
  if (guests) {
    if (sequence) edits.push({ at: sequence, text: `SEQUENCE:${(Number(parseLine(sequence.text)?.value) || 0) + 1}` });
    else insert = { after: dtend ?? dtstart, text: "SEQUENCE:1" };
  }
  let text = raw;
  for (const { at, text: next } of [...edits].sort((a, b) => b.at.start - a.at.start)) {
    if (insert && insert.after === at) text = text.slice(0, at.start) + next + eol + insert.text + text.slice(at.end);
    else text = text.slice(0, at.start) + next + text.slice(at.end);
  }
  return { text, changed: true, before, after, guests, summary };
}

/**
 * Is this PUT body only a move? Outside the event's DTSTART, DTEND and
 * SEQUENCE lines (and one SEQUENCE line added), every byte is the same.
 */
export function onlyTimesChanged(before: string, after: string): boolean {
  const strip = (s: string) =>
    logicalLines(s)
      .filter((l) => !/^(DTSTART|DTEND|SEQUENCE)[;:]/i.test(l.text))
      .map((l) => s.slice(l.start, l.end))
      .join("\n");
  const a = logicalLines(before).filter((l) => /^(DTSTART|DTEND)[;:]/i.test(l.text)).length;
  const b = logicalLines(after).filter((l) => /^(DTSTART|DTEND)[;:]/i.test(l.text)).length;
  return a === b && strip(before) === strip(after);
}

/** Read the event, give it the new times, and PUT it back only if nobody changed it meanwhile (If-Match). On 412, read it again and try once more. */
export async function moveIcloudEvent(
  session: DavSession,
  url: string,
  opts: { emails: string[]; start: number; end?: number; expect?: number; ownerZone: string },
): Promise<{ before: { start: number; end: number }; after: { start: number; end: number }; guests: number; summary: string }> {
  for (let attempt = 0; ; attempt++) {
    let got: { text: string; etag?: string };
    try {
      got = await session.request("GET", url);
    } catch (error) {
      if (error instanceof IcloudError && (error.status === 404 || error.status === 410)) throw new ToolInputError("iCloud doesn't have this event any more");
      throw error;
    }
    if (!got.etag) throw new ToolInputError("Athena couldn't check the event with iCloud, so it left it alone. Try again in a minute");
    const r = rewriteTimes(got.text, opts);
    const { before, after, guests, summary } = r;
    if (!r.changed) return { before, after, guests, summary };
    if (!onlyTimesChanged(got.text, r.text)) throw new ToolInputError("Athena couldn't make that change safely, so it left the event alone");
    try {
      await session.putIfMatch(url, r.text, got.etag);
      return { before, after, guests, summary };
    } catch (error) {
      if (error instanceof IcloudError && error.status === 412 && attempt === 0) continue;
      if (error instanceof IcloudError && error.status === 412) throw new ToolInputError("The event changed in iCloud while Athena was moving it. Try again");
      if (error instanceof IcloudError && error.status === 403) throw new ToolInputError("iCloud won't let you change events on this calendar");
      throw error;
    }
  }
}
