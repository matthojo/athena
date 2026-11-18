/**
 * iCloud: adding one event, and taking it back.
 *
 *  - newEventIcs writes the whole file: a VCALENDAR with one VEVENT that has
 *    only a UID and DTSTAMP (iCalendar needs both), DTSTART and DTEND in UTC,
 *    SUMMARY, and maybe LOCATION, DESCRIPTION and, with guests, an ORGANIZER
 *    (the owner) and one ATTENDEE each. iCloud sends the invites, as it does
 *    for an event made in Apple's Calendar.
 *  - isNewEventIcs checks a file is exactly that before it's PUT, with
 *    If-None-Match: * so it can only make a new file, never replace one.
 *  - deleteCreatedIcloudEvent deletes one file with If-Match on the ETag it
 *    just read. icloud-direct.ts calls it only for an event in
 *    calendar_creates. iCloud sends the guests a cancellation.
 */
import { randomUUID } from "node:crypto";
import { ToolInputError } from "./google-api";
import { IcloudError, type DavSession } from "./icloud-dav";
import { parseIcal, parseLine } from "./icloud-ical";
import { fold, logicalLines } from "./icloud-rsvp";
import type { CreateArgs } from "./calendar-create";

const PRODID = "-//Athena//Calendar//EN";

/** "20261112T140000Z" */
const utc = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** RFC 5545 TEXT: backslash, semicolon, comma and newline escaped. */
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** A quoted parameter value (CN): no quotes, no control characters. */
const param = (s: string) => s.replace(/["\u0000-\u001f]/g, "").slice(0, 200);

export function newEventIcs(a: Pick<CreateArgs, "summary" | "start" | "end" | "location" | "description" | "attendees">, opts: { uid: string; organizer: string; now: Date }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${utc(opts.now)}`,
    `DTSTART:${utc(a.start)}`,
    `DTEND:${utc(a.end)}`,
    `SUMMARY:${text(a.summary)}`,
    ...(a.location ? [`LOCATION:${text(a.location)}`] : []),
    ...(a.description ? [`DESCRIPTION:${text(a.description)}`] : []),
    ...(a.attendees.length ? [`ORGANIZER:mailto:${opts.organizer}`, ...a.attendees.map((g) => `ATTENDEE;${g.name ? `CN="${param(g.name)}";` : ""}ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${g.email}`)] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map((l) => (Buffer.byteLength(l, "utf8") > 75 ? fold(l, "\r\n") : l)).join("\r\n")}\r\n`;
}

const EVENT_PROPS = new Set(["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "LOCATION", "DESCRIPTION", "ORGANIZER", "ATTENDEE"]);
const UTC_STAMP = /^\d{8}T\d{6}Z$/;

/**
 * Is this file one new event and nothing more? The calendar wrapper (VERSION
 * and PRODID), and one VEVENT with only the properties above: UTC times, the
 * end after the start, no parameters except an ATTENDEE's CN, ROLE,
 * PARTSTAT and RSVP. No alarm, repeat rule, attachment, URL, colour,
 * transparency, class or time zone block.
 */
export function isNewEventIcs(ics: string): boolean {
  const lines = logicalLines(ics).map((l) => l.text).filter((l) => l !== "");
  const want = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "BEGIN:VEVENT"];
  if (lines.length < 9 || want.some((w, i) => lines[i] !== w) || lines[lines.length - 2] !== "END:VEVENT" || lines[lines.length - 1] !== "END:VCALENDAR") return false;
  const body = lines.slice(4, -2);
  const seen = new Map<string, number>();
  for (const l of body) {
    const p = parseLine(l);
    if (!p) return false;
    const name = p.name.toUpperCase();
    if (!EVENT_PROPS.has(name)) return false;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    const params = Object.keys(p.params);
    if (name === "ATTENDEE") {
      if (!params.every((k) => ["CN", "ROLE", "PARTSTAT", "RSVP"].includes(k)) || !/^mailto:[^\s@]+@[^\s@]+$/i.test(p.value)) return false;
    } else if (params.length) return false;
    if (name === "ORGANIZER" && !/^mailto:[^\s@]+@[^\s@]+$/i.test(p.value)) return false;
    if ((name === "DTSTART" || name === "DTEND" || name === "DTSTAMP") && !UTC_STAMP.test(p.value)) return false;
  }
  for (const one of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY"]) if (seen.get(one) !== 1) return false;
  for (const most of ["LOCATION", "DESCRIPTION", "ORGANIZER"]) if ((seen.get(most) ?? 0) > 1) return false;
  const guests = seen.get("ATTENDEE") ?? 0;
  if (guests > 50 || (guests > 0) !== (seen.get("ORGANIZER") === 1)) return false;
  const ev = parseIcal(ics)[0]?.children.find((c) => c.name === "VEVENT");
  const value = (n: string) => ev?.props.find((p) => p.name.toUpperCase() === n)?.value ?? "";
  return value("DTEND") > value("DTSTART");
}

/** A file name for the event: its UID, which is ours and safe in a URL. */
export const newUid = () => `${randomUUID().toUpperCase()}`;

/** PUT a new event into one calendar (If-None-Match: *). Resolves to its URL. */
export async function createIcloudEvent(session: DavSession, calendarHref: string, a: CreateArgs, opts: { organizer: string; now: Date; uid?: string }): Promise<{ url: string; file: string }> {
  if (a.attendees.length && !opts.organizer) throw new ToolInputError("iCloud didn't say which address is yours, so Athena can't send invites from it");
  const uid = opts.uid ?? newUid();
  const ics = newEventIcs(a, { uid, organizer: opts.organizer, now: opts.now });
  const file = `${uid}.ics`;
  const url = new URL(file, calendarHref).toString();
  try {
    await session.putIfNoneMatch(url, ics);
  } catch (error) {
    // The UID is new, so a file already there is this one, from a try whose answer was lost.
    if (error instanceof IcloudError && error.status === 412) return { url, file };
    if (error instanceof IcloudError && error.status === 403) throw new ToolInputError("iCloud won't let you add events to this calendar");
    throw error;
  }
  return { url, file };
}

/** Delete one event file, over the version just read (If-Match). Already gone counts as done. */
export async function deleteCreatedIcloudEvent(session: DavSession, url: string): Promise<void> {
  let got: { etag?: string };
  try {
    got = await session.request("GET", url);
  } catch (error) {
    if (error instanceof IcloudError && (error.status === 404 || error.status === 410)) return;
    throw error;
  }
  if (!got.etag) throw new ToolInputError("Athena couldn't check the event with iCloud, so it left it alone. Try again in a minute");
  try {
    await session.deleteIfMatch(url, got.etag);
  } catch (error) {
    if (error instanceof IcloudError && error.status === 404) return;
    if (error instanceof IcloudError && error.status === 412) throw new ToolInputError("The event changed in iCloud since Athena added it, so Athena left it alone. Delete it in Apple's Calendar app if you want it gone");
    throw error;
  }
}
