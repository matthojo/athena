/**
 * iCloud: your answer to one invite, as the smallest change to the event's
 * iCalendar file that says it. Only the PARTSTAT on your own ATTENDEE line
 * changes (ACCEPTED, TENTATIVE or DECLINED); every other byte stays as
 * iCloud sent it, other people's lines included. iCloud then tells the
 * organiser, as it does when you answer in Apple's Calendar app (RFC 6638).
 *
 * The write is one conditional PUT (If-Match on the ETag Athena just read),
 * so a change made meanwhile is never overwritten: a 412 re-reads the event
 * and tries once more. Nothing here creates, moves, edits or deletes an
 * event. icloud-direct.ts offers it only with "Let Athena answer invites" on.
 */
import { ToolInputError } from "./google-api";
import { IcloudError, type DavSession } from "./icloud-dav";
import { parseIcal, parseLine, parseTime, recurrenceStamp, zoneAliases } from "./icloud-ical";

export type Partstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";
export const PARTSTAT: Readonly<Record<string, Partstat>> = { going: "ACCEPTED", maybe: "TENTATIVE", declined: "DECLINED" };

/** One logical line: where it sits in the file (folded continuations included, its line ending not) and its unfolded text. */
export interface Line {
  start: number;
  end: number;
  text: string;
  folded: boolean;
}

/** The file's logical lines, each with its exact span in the original text. */
export function logicalLines(raw: string): Line[] {
  const out: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(raw)); ) {
    if (m[0] === "") break;
    const start = m.index;
    const end = start + m[1].length;
    const last = out[out.length - 1];
    if (last && /^[ \t]/.test(m[1])) {
      last.end = end;
      last.text += m[1].slice(1);
      last.folded = true;
    } else out.push({ start, end, text: m[1], folded: false });
  }
  return out;
}

/** The parameters part of a line, split on semicolons outside quotes. */
function splitHead(line: string): { head: string[]; value: string } {
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) break;
  }
  const head: string[] = [];
  let cur = "";
  quoted = false;
  for (const ch of line.slice(0, i)) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      head.push(cur);
      cur = "";
    } else cur += ch;
  }
  head.push(cur);
  return { head, value: line.slice(i) };
}

/** The same line with PARTSTAT set (added after the other parameters when it had none). */
export function withPartstat(line: string, partstat: Partstat): string {
  const { head, value } = splitHead(line);
  const at = head.findIndex((p, i) => i > 0 && /^PARTSTAT=/i.test(p));
  if (at > 0) head[at] = `${head[at].slice(0, "PARTSTAT=".length)}${partstat}`;
  else head.push(`PARTSTAT=${partstat}`);
  return `${head.join(";")}${value}`;
}

/** Fold at 75 octets, never inside a character (RFC 5545 3.1), with the file's own line ending. */
export function fold(text: string, eol: string): string {
  const parts: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join(`${eol} `);
}

const mailOf = (line: string) =>
  parseLine(line)
    ?.value.replace(/^mailto:/i, "")
    .trim()
    .toLowerCase() ?? "";

/**
 * One date of a repeating invite that has no copy of its own: Athena asks
 * "all of them, or just this one?" (rsvp-control.ts). The app and Ask spot
 * this message by its first words, so keep them.
 */
export const SERIES_QUESTION = "This invite repeats. Answer all of them, or just this one in Apple's Calendar app";

export interface Rewrite {
  /** The new file: the original with only your ATTENDEE line changed. Equal to the original when it already said this. */
  text: string;
  changed: boolean;
}

/**
 * Your answer written into one event's file. `recurrenceId` (from the event
 * id) picks a changed occurrence's own copy; without one it's the event
 * itself. A date with no copy of its own asks first (SERIES_QUESTION);
 * `series` answers the whole series instead, on the master event. Throws a
 * ToolInputError saying why when there's no invite of yours to answer.
 */
export function rewritePartstat(raw: string, opts: { emails: string[]; partstat: Partstat; recurrenceId?: string; ownerZone: string; series?: boolean }): Rewrite {
  const lines = logicalLines(raw);
  const mine = new Set(opts.emails.map((e) => e.toLowerCase()));
  const aliases = zoneAliases(parseIcal(raw));
  // Each VEVENT: its own lines only, not those of an alarm inside it (an email alarm has ATTENDEE lines too).
  const events: Array<{ lines: Line[] }> = [];
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
  const propOf = (e: { lines: Line[] }, name: string) => e.lines.find((l) => new RegExp(`^${name}[;:]`, "i").test(l.text));
  const allDay = (() => {
    const master = events.find((e) => !propOf(e, "RECURRENCE-ID"));
    const start = master && propOf(master, "DTSTART");
    return !!(start && parseTime(parseLine(start.text) ?? undefined, opts.ownerZone, aliases)?.allDay);
  })();
  const stampOf = (e: { lines: Line[] }) => {
    const rid = propOf(e, "RECURRENCE-ID");
    const t = rid ? parseTime(parseLine(rid.text) ?? undefined, opts.ownerZone, aliases) : null;
    return t ? recurrenceStamp(t, allDay) : undefined;
  };
  let target: { lines: Line[] } | undefined;
  if (opts.recurrenceId) {
    const want = allDay ? opts.recurrenceId.slice(0, 8) : opts.recurrenceId;
    target = events.find((e) => stampOf(e) === want);
    // An occurrence with no copy of its own: answering just it would mean adding a copy, which Athena never does. You choose: all of them, or Apple's app.
    if (!target && opts.series) target = events.find((e) => !propOf(e, "RECURRENCE-ID"));
    else if (!target) throw new ToolInputError(SERIES_QUESTION);
  } else target = events.find((e) => !propOf(e, "RECURRENCE-ID")) ?? events[0];
  if (!target) throw new ToolInputError("iCloud doesn't have this event any more");
  const status = propOf(target, "STATUS");
  if (status && /:CANCELLED\s*$/i.test(status.text)) throw new ToolInputError("This event was cancelled");
  const organizer = propOf(target, "ORGANIZER");
  if (organizer && mine.has(mailOf(organizer.text))) throw new ToolInputError("It's your own event, so there's no invite to answer");
  const me = target.lines.find((l) => /^ATTENDEE[;:]/i.test(l.text) && mine.has(mailOf(l.text)));
  if (!me) throw new ToolInputError("You aren't a guest on this event, so there's no invite to answer");
  const next = withPartstat(me.text, opts.partstat);
  if (next === me.text || (parseLine(me.text)?.params.PARTSTAT ?? "").toUpperCase() === opts.partstat) return { text: raw, changed: false };
  const eol = /\r\n/.test(raw) ? "\r\n" : "\n";
  const written = me.folded || Buffer.byteLength(me.text, "utf8") > 75 ? fold(next, eol) : next;
  return { text: raw.slice(0, me.start) + written + raw.slice(me.end), changed: true };
}

/** What iCloud's own reply calls this answer, for the tool's output. */
const SAID: Record<Partstat, string> = { ACCEPTED: "accepted", TENTATIVE: "maybe", DECLINED: "declined" };

/**
 * Read the event, change your PARTSTAT, and PUT it back only if nobody
 * changed it meanwhile (If-Match). On 412, read it again and try once more.
 */
export async function answerIcloudInvite(
  session: DavSession,
  url: string,
  opts: { emails: string[]; partstat: Partstat; recurrenceId?: string; ownerZone: string; series?: boolean },
): Promise<{ myResponse: string; sent: boolean }> {
  for (let attempt = 0; ; attempt++) {
    let got: { text: string; etag?: string };
    try {
      got = await session.request("GET", url);
    } catch (error) {
      if (error instanceof IcloudError && (error.status === 404 || error.status === 410)) throw new ToolInputError("iCloud doesn't have this event any more");
      throw error;
    }
    if (!got.etag) throw new ToolInputError("Athena couldn't check the event with iCloud, so it left it alone. Try again in a minute");
    const r = rewritePartstat(got.text, opts);
    if (!r.changed) return { myResponse: SAID[opts.partstat], sent: false };
    try {
      await session.putIfMatch(url, r.text, got.etag);
      return { myResponse: SAID[opts.partstat], sent: true };
    } catch (error) {
      if (error instanceof IcloudError && error.status === 412 && attempt === 0) continue;
      if (error instanceof IcloudError && error.status === 412) throw new ToolInputError("The event changed in iCloud while Athena was answering. Try again");
      if (error instanceof IcloudError && error.status === 403) throw new ToolInputError("iCloud won't let you answer on this calendar");
      throw error;
    }
  }
}

/** Is this PUT body only your answer? The original with one ATTENDEE line's PARTSTAT changed. For tests and the guard. */
export function onlyPartstatChanged(before: string, after: string, emails: string[]): boolean {
  const a = logicalLines(before);
  const b = logicalLines(after);
  if (a.length !== b.length) return false;
  const mine = new Set(emails.map((e) => e.toLowerCase()));
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (before.slice(a[i].start, a[i].end) === after.slice(b[i].start, b[i].end)) continue;
    const pa = parseLine(a[i].text);
    const pb = parseLine(b[i].text);
    if (!pa || !pb || pa.name !== "ATTENDEE" || pb.name !== "ATTENDEE" || !mine.has(mailOf(a[i].text))) return false;
    if (withPartstat(a[i].text, (pb.params.PARTSTAT ?? "") as Partstat) !== b[i].text) return false;
    changed++;
  }
  // Outside the changed lines, every byte is the same.
  const strip = (s: string, ls: Line[]) => ls.map((l, i) => (i === 0 ? s.slice(0, l.start) : s.slice(ls[i - 1].end, l.start))).join("") + s.slice(ls[ls.length - 1]?.end ?? 0);
  return changed <= 1 && strip(before, a) === strip(after, b);
}
