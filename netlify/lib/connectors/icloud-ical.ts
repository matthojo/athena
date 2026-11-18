/**
 * iCalendar (RFC 5545) for icloud-calendar.ts: unfolding, properties and
 * their parameters, VEVENTs, times in their zones, and recurring events
 * expanded into occurrences.
 *
 * CalDAV servers can expand recurrences themselves (CALDAV:expand), and
 * Athena asks for that, but iCloud doesn't always do it: a reply may still
 * hold the series with its RRULE. `occurrences` handles both, so every
 * listing has one entry per occurrence either way. Expansion covers what
 * Calendar on a Mac or iPhone writes (DAILY, WEEKLY, MONTHLY, YEARLY with
 * INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS), RDATE and
 * EXDATE, and moved or cancelled occurrences (RECURRENCE-ID).
 */
import { isValidTimeZone, zonedParts, zonedToInstant } from "../../../lib/dates";

export interface IcalProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcalComponent {
  name: string;
  props: IcalProp[];
  children: IcalComponent[];
}

/** Unfold and split into components. Tolerant: a broken line is skipped, never thrown. */
export function parseIcal(text: string): IcalComponent[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const root: IcalComponent = { name: "#root", props: [], children: [] };
  const stack = [root];
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === "BEGIN") {
      const c: IcalComponent = { name: prop.value.toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.props.push(prop);
  }
  return root.children;
}

/** NAME;PARAM=a;PARAM="b:c":value (quoted parameter values may hold : and ;). */
export function parseLine(line: string): IcalProp | null {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  // vCard groups ("item1.EMAIL") are dropped here; icloud-contacts.ts reads them from the raw name.
  const name = parts[0].trim().toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    const k = (eq < 0 ? "TYPE" : p.slice(0, eq)).trim().toUpperCase();
    const v = (eq < 0 ? p : p.slice(eq + 1)).replace(/"/g, "").trim();
    params[k] = params[k] ? `${params[k]},${v}` : v;
  }
  return { name, params, value };
}

/** TEXT values: \n, \, \; and \\ escapes. */
export const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

export const prop = (c: IcalComponent, name: string): IcalProp | undefined => c.props.find((p) => p.name === name);
export const props = (c: IcalComponent, name: string): IcalProp[] => c.props.filter((p) => p.name === name);
export const textOf = (c: IcalComponent, name: string): string | undefined => {
  const p = prop(c, name);
  const v = p ? unescapeText(p.value).trim() : "";
  return v || undefined;
};

// ---------- Times ----------

/** A DATE or DATE-TIME as the calendar wrote it. */
export interface IcalTime {
  /** All-day: just a date. */
  allDay: boolean;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM:SS wall-clock time in `zone` (00:00:00 for a date). */
  time: string;
  /** IANA zone the wall-clock time is in; "UTC" for a Z time; the owner's for a floating one. */
  zone: string;
}

/** A TZID as an IANA zone: "Europe/London", "/Europe/London", or a VTIMEZONE's X-LIC-LOCATION. */
export function ianaZone(tzid: string | undefined, fallback: string, aliases: Map<string, string> = new Map()): string {
  if (!tzid) return fallback;
  const t = tzid.replace(/^"|"$/g, "").trim();
  if (isValidTimeZone(t)) return t;
  const alias = aliases.get(t);
  if (alias && isValidTimeZone(alias)) return alias;
  const tail = /([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(t)?.[1];
  if (tail && isValidTimeZone(tail)) return tail;
  if (/^(utc|gmt|z)$/i.test(t)) return "UTC";
  return fallback;
}

/** Zones a calendar defines (VTIMEZONE), by TZID, as IANA names where they say one. */
export function zoneAliases(components: IcalComponent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const cal of components)
    for (const tz of cal.children.filter((c) => c.name === "VTIMEZONE")) {
      const id = prop(tz, "TZID")?.value;
      const loc = prop(tz, "X-LIC-LOCATION")?.value;
      if (id && loc) out.set(id, loc);
    }
  return out;
}

export function parseTime(p: IcalProp | undefined, ownerZone: string, aliases?: Map<string, string>): IcalTime | null {
  if (!p) return null;
  return parseTimeValue(p.value, p.params, ownerZone, aliases);
}

export function parseTimeValue(raw: string, params: Record<string, string>, ownerZone: string, aliases?: Map<string, string>): IcalTime | null {
  const v = raw.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || params.VALUE === "DATE") {
    if (!d) return null;
    return { allDay: true, date: `${d[1]}-${d[2]}-${d[3]}`, time: "00:00:00", zone: ownerZone };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
  if (!t) return null;
  const zone = t[7] ? "UTC" : ianaZone(params.TZID, ownerZone, aliases);
  return { allDay: false, date: `${t[1]}-${t[2]}-${t[3]}`, time: `${t[4]}:${t[5]}:${t[6]}`, zone };
}

/** The instant a wall-clock time happens (an all-day date: its start in the owner's zone). */
export function instantOf(t: IcalTime): number {
  if (t.zone === "UTC") return Date.parse(`${t.date}T${t.time}Z`);
  return zonedToInstant(t.date, t.time.slice(0, 5), t.zone).getTime() + Number(t.time.slice(6, 8)) * 1000;
}

/** RFC 5545 DURATION: "PT1H30M", "P1D", "-PT15M", "P2W" → milliseconds. */
export function durationMs(raw: string | undefined): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** "2026-11-07T09:00:00+00:00" for an instant, in `tz`. */
export function isoInZone(ms: number, tz: string): string {
  const at = new Date(ms);
  const p = zonedParts(at, tz);
  const sec = String(Math.floor((ms / 1000) % 60 + 60) % 60).padStart(2, "0");
  const asUtc = Date.parse(`${p.date}T${p.time}:${sec}Z`);
  const off = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${p.date}T${p.time}:${sec}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const addDaysUtc = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------- Events and their occurrences ----------

export interface Occurrence {
  /** The VEVENT its details come from: the series, or an occurrence that was changed. */
  event: IcalComponent;
  start: IcalTime;
  /** Exclusive end; for all-day events the day after the last day. */
  end: IcalTime;
  startMs: number;
  endMs: number;
  /** Part of a series: the occurrence's original start, as RECURRENCE-ID writes it (UTC, or a date). */
  recurrenceId?: string;
  /** The series' RRULE and RDATE/EXDATE lines, for get_event. */
  recurrence?: string[];
}

/**
 * RECURRENCE-ID form of an occurrence's original start: 20261107T090000Z, or
 * 20261107 for all-day. iCloud writes an expanded all-day occurrence's
 * RECURRENCE-ID as midnight UTC (20260930T000000Z); `allDay` says the series
 * is all-day, so that reads as the date too, and ids match however it was expanded.
 */
export function recurrenceStamp(t: IcalTime, allDay = t.allDay): string {
  if (allDay) return t.date.replaceAll("-", "");
  return new Date(instantOf(t)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Wall-clock arithmetic: an event at 09:00 London stays at 09:00 across the clock change. */
function shift(t: IcalTime, ms: number): IcalTime {
  if (t.allDay) return { ...t, date: addDaysUtc(t.date, Math.round(ms / 86_400_000)) };
  const wall = Date.parse(`${t.date}T${t.time}Z`) + ms;
  const iso = new Date(wall).toISOString();
  return { ...t, date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function endOf(e: IcalComponent, start: IcalTime, ownerZone: string, aliases: Map<string, string>): IcalTime {
  const end = parseTime(prop(e, "DTEND"), ownerZone, aliases);
  if (end && end.allDay === start.allDay) return end;
  const dur = durationMs(prop(e, "DURATION")?.value);
  if (dur !== null) return start.allDay ? shift(start, Math.max(dur, 86_400_000)) : { allDay: false, zone: "UTC", ...utcWall(instantOf(start) + Math.max(0, dur)) };
  return start.allDay ? shift(start, 86_400_000) : start;
}

const utcWall = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

function occurrence(event: IcalComponent, start: IcalTime, end: IcalTime, extra: Partial<Occurrence> = {}): Occurrence {
  return { event, start, end, startMs: instantOf(start), endMs: instantOf(end), ...extra };
}

/**
 * Every occurrence of the events in one calendar resource that overlaps
 * [fromMs, toMs): single events as they are, a series expanded (unless the
 * server already did), with changed occurrences in place of the ones they
 * replace and cancelled ones left out. `limit` caps a runaway rule.
 */
export function occurrences(text: string, fromMs: number, toMs: number, ownerZone: string, opts: { limit?: number; keepCancelled?: boolean } = {}): Occurrence[] {
  const limit = opts.limit ?? 2000;
  const cals = parseIcal(text);
  const aliases = zoneAliases(cals);
  const events = cals.flatMap((c) => c.children.filter((x) => x.name === "VEVENT"));
  const out: Occurrence[] = [];
  const overrides = new Map<string, IcalComponent>();
  for (const e of events) {
    const rid = parseTime(prop(e, "RECURRENCE-ID"), ownerZone, aliases);
    if (rid) overrides.set(recurrenceStamp(rid, parseTime(prop(e, "DTSTART"), ownerZone, aliases)?.allDay), e);
  }
  const overlaps = (o: Occurrence) => o.endMs > fromMs && o.startMs < toMs || (o.startMs === o.endMs && o.startMs >= fromMs && o.startMs < toMs);

  for (const e of events) {
    const start = parseTime(prop(e, "DTSTART"), ownerZone, aliases);
    if (!start) continue;
    const end = endOf(e, start, ownerZone, aliases);
    const rid = parseTime(prop(e, "RECURRENCE-ID"), ownerZone, aliases);
    const rrule = prop(e, "RRULE")?.value;
    const rdates = props(e, "RDATE");
    if (rid) {
      // A changed occurrence (or one the server expanded): stands alone.
      const o = occurrence(e, start, end, { recurrenceId: recurrenceStamp(rid, start.allDay) });
      if (overlaps(o)) out.push(o);
      continue;
    }
    if (!rrule && !rdates.length) {
      const o = occurrence(e, start, end);
      if (overlaps(o)) out.push(o);
      continue;
    }
    const length = instantOf(end) - instantOf(start);
    const recurrence = [...(rrule ? [`RRULE:${rrule}`] : []), ...rdates.map((p) => `RDATE:${p.value}`), ...props(e, "EXDATE").map((p) => `EXDATE:${p.value}`)];
    const excluded = new Set(
      props(e, "EXDATE").flatMap((p) =>
        p.value.split(",").map((v) => {
          const t = parseTimeValue(v, { ...p.params, ...(start.allDay ? { VALUE: "DATE" } : {}) }, ownerZone, aliases);
          return t ? recurrenceStamp(t.allDay === start.allDay ? t : { ...t, allDay: start.allDay }) : "";
        }),
      ),
    );
    const starts = rrule ? expandRule(start, rrule, toMs, limit, aliases) : [start];
    for (const p of rdates)
      for (const v of p.value.split(",")) {
        const t = parseTimeValue(v, p.params, start.zone, aliases);
        if (t) starts.push(t);
      }
    const seen = new Set<string>();
    for (const s of starts) {
      const stamp = recurrenceStamp(s);
      if (seen.has(stamp) || excluded.has(stamp)) continue;
      seen.add(stamp);
      // A changed occurrence is listed from its own VEVENT (above), not here.
      if (overrides.has(stamp)) continue;
      const sMs = instantOf(s);
      const o: Occurrence = {
        event: e,
        start: s,
        end: s.allDay ? shift(s, length) : { ...utcWall(sMs + length), allDay: false, zone: "UTC" },
        startMs: sMs,
        endMs: sMs + length,
        recurrenceId: stamp,
        recurrence,
      };
      if (overlaps(o)) out.push(o);
    }
  }
  // Cancelled events and occurrences drop out of listings, as Google's do.
  return out.filter((o) => opts.keepCancelled || (textOf(o.event, "STATUS") ?? "").toUpperCase() !== "CANCELLED").sort((a, b) => a.startMs - b.startMs);
}

// ---------- RRULE ----------

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  untilMs?: number;
  byDay: Array<{ n: number; day: number }>;
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
}

export function parseRule(raw: string, start: IcalTime, aliases?: Map<string, string>): Rule | null {
  const kv = new Map(
    raw.split(";").map((p) => {
      const [k, v = ""] = p.split("=");
      return [k.trim().toUpperCase(), v.trim().toUpperCase()] as const;
    }),
  );
  const freq = kv.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const nums = (k: string) => (kv.get(k) ?? "").split(",").filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  const until = kv.get("UNTIL");
  const untilT = until ? parseTimeValue(until, /^\d{8}$/.test(until) ? { VALUE: "DATE" } : start.allDay ? {} : { TZID: start.zone }, start.zone, aliases) : null;
  return {
    freq,
    interval: Math.max(1, Number(kv.get("INTERVAL")) || 1),
    count: kv.has("COUNT") ? Math.max(0, Number(kv.get("COUNT")) || 0) : undefined,
    // A date UNTIL includes that whole day.
    untilMs: untilT ? instantOf(untilT) + (untilT.allDay ? 86_400_000 - 1 : 0) : undefined,
    byDay: (kv.get("BYDAY") ?? "")
      .split(",")
      .filter(Boolean)
      .map((d) => {
        const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(d);
        return m ? { n: Number(m[1] ?? 0), day: WEEKDAYS.indexOf(m[2]) } : { n: 0, day: -1 };
      })
      .filter((d) => d.day >= 0),
    byMonthDay: nums("BYMONTHDAY"),
    byMonth: nums("BYMONTH").filter((m) => m >= 1 && m <= 12),
    bySetPos: nums("BYSETPOS"),
  };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Days in month `m` of `y` that BYDAY / BYMONTHDAY pick (an empty pick: the start's own day of the month). */
function monthDays(rule: Rule, y: number, m: number, startDay: number): string[] {
  const n = daysInMonth(y, m);
  let days: number[] = [];
  if (rule.byMonthDay.length) days = rule.byMonthDay.map((d) => (d > 0 ? d : n + d + 1)).filter((d) => d >= 1 && d <= n);
  if (rule.byDay.length) {
    const picked = new Set<number>();
    for (const { n: nth, day } of rule.byDay) {
      const all: number[] = [];
      for (let d = 1; d <= n; d++) if (weekday(ymd(y, m, d)) === day) all.push(d);
      if (nth === 0) all.forEach((d) => picked.add(d));
      else {
        const d = nth > 0 ? all[nth - 1] : all[all.length + nth];
        if (d) picked.add(d);
      }
    }
    days = days.length ? days.filter((d) => picked.has(d)) : [...picked];
  }
  if (!rule.byMonthDay.length && !rule.byDay.length) days = startDay <= n ? [startDay] : [];
  days.sort((a, b) => a - b);
  if (rule.bySetPos.length) days = rule.bySetPos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((d): d is number => d !== undefined);
  return [...new Set(days)].sort((a, b) => a - b).map((d) => ymd(y, m, d));
}

/** The start of each occurrence of a series, from DTSTART until `toMs` (or COUNT / UNTIL), in the start's own wall-clock time. */
export function expandRule(start: IcalTime, raw: string, toMs: number, limit = 2000, aliases?: Map<string, string>): IcalTime[] {
  const rule = parseRule(raw, start, aliases);
  if (!rule) return [start];
  const out: IcalTime[] = [];
  const startMs = instantOf(start);
  const [y0, m0, d0] = start.date.split("-").map(Number);
  let emitted = 0;
  const done = () => (rule.count !== undefined && emitted >= rule.count) || out.length >= limit;
  /** Add a candidate day; false once past the end. */
  const take = (date: string): boolean => {
    const t: IcalTime = { ...start, date };
    const ms = instantOf(t);
    if (ms < startMs) return true;
    if (rule.untilMs !== undefined && ms > rule.untilMs) return false;
    if (ms >= toMs && rule.count === undefined) return false;
    emitted++;
    if (ms < toMs) out.push(t);
    return !done() && (ms < toMs || rule.count !== undefined);
  };
  // Guard: a rule that never matches (BYMONTHDAY=31 every February) still ends.
  for (let step = 0; step < 50_000 && !done(); step++) {
    let dates: string[] = [];
    if (rule.freq === "DAILY") {
      const date = addDaysUtc(start.date, step * rule.interval);
      const [, m] = date.split("-").map(Number);
      if ((!rule.byMonth.length || rule.byMonth.includes(m)) && (!rule.byDay.length || rule.byDay.some((b) => b.day === weekday(date)))) dates = [date];
      else if (Date.parse(`${date}T00:00:00Z`) > toMs + 86_400_000 && rule.count === undefined) break;
      else continue;
    } else if (rule.freq === "WEEKLY") {
      // Weeks start on Monday (WKST=MO, Calendar's default).
      const back = (weekday(start.date) + 6) % 7;
      const monday = addDaysUtc(start.date, -back + step * 7 * rule.interval);
      const days = rule.byDay.length ? rule.byDay.map((b) => (b.day + 6) % 7) : [back];
      dates = [...new Set(days)].sort((a, b) => a - b).map((i) => addDaysUtc(monday, i));
    } else if (rule.freq === "MONTHLY") {
      const idx = m0 - 1 + step * rule.interval;
      const y = y0 + Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(m)) continue;
      dates = monthDays(rule, y, m, d0);
    } else {
      const y = y0 + step * rule.interval;
      const months = rule.byMonth.length ? rule.byMonth : [m0];
      for (const m of months) {
        // FREQ=YEARLY;BYDAY=… without BYMONTH isn't something Calendar writes: treated month by month.
        if (!rule.byDay.length && !rule.byMonthDay.length) {
          if (d0 <= daysInMonth(y, m)) dates.push(ymd(y, m, d0));
        } else dates.push(...monthDays(rule, y, m, d0));
      }
    }
    let more = true;
    for (const date of dates) {
      if (!(more = take(date))) break;
    }
    if (!more) break;
  }
  return out;
}
