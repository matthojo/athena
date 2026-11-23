/**
 * The morning briefing and reminder planning, as pure functions over data
 * the reminders function has already loaded. No database or network here, so
 * the schedule maths and wording can be tested in isolation.
 *
 * Days and times are in the owner's time zone (`tz`, from settings.timezone);
 * timed events are UTC instants (lib/dates.ts).
 */

import { DEFAULT_TZ, addDays, daysBetween, upcomingOccurrences, zonedParts, zonedToday, type DatedThing } from "./dates";
import { formatAthenaLink, type LinkKind } from "./links";
import { bookingLine, deliveriesComingUp, deliveryLine, travelComingUp, type BookingLike, type PurchaseLike, type TripLike } from "./trip-text";
import { lineLine, trainBriefingLine, type LineStatus, type TrainStatus } from "./live-travel-text";
import { flightBriefingLine, type FlightStatus } from "./flight-text";

/** A to-do or something you're waiting on (lib/memory.ts Commitment, trimmed). */
export interface BriefingLoop {
  id: string;
  title: string;
  kind: string;
  due_on: string | null;
  person: { id: string; name: string } | null;
  updated_at: string;
}

/** A life-admin item with a renewal or expiry date. */
export interface BriefingRenewal {
  id: string;
  name: string;
  kind: string;
  renews_on: string;
  remind_days_before: number[];
}

export interface BriefingEvent extends DatedThing {
  id: string;
  title: string;
  kind: string;
  remind_days_before: number[];
  person_id: string | null;
  /** false = no push 30 minutes before (e.g. meetings synced from a calendar). */
  timed_push?: boolean;
  /** Set when a collection synced it from a calendar. */
  source?: string | null;
}

export interface BriefingPerson {
  id: string;
  name: string;
  last_contacted_at: string | null;
}

export interface BriefingNote {
  id: string;
  title: string;
  source: string | null;
  created_at: string;
}

export interface BriefingInput {
  now: Date;
  /** The owner's IANA time zone. */
  tz: string;
  events: BriefingEvent[];
  /** Live people, for naming birthdays. */
  people: BriefingPerson[];
  /** People overdue a catch-up. */
  catchUps: BriefingPerson[];
  /** Notes created yesterday or today (any source); filtered here. */
  recentNotes: BriefingNote[];
  /** Pending custom reminders; those due later today are listed. */
  reminders?: BriefingReminder[];
  /** To-dos due today or overdue. */
  due?: BriefingLoop[];
  /** Things you've been waiting on that have gone quiet. */
  waiting?: BriefingLoop[];
  /** Life-admin items renewing or expiring soon (or lapsed). */
  renewals?: BriefingRenewal[];
  /** Suggestions waiting in the review inbox. */
  pendingSuggestions?: number;
  /** Upcoming trips with their bookings (lib/trips.ts): each trip's next booking this week is listed. */
  trips?: TripLike[];
  /** Purchases still on their way: those arriving or out for delivery today are listed. */
  purchases?: PurchaseLike[];
  /** Live status for trains leaving in the next 3 hours, by booking id (netlify/lib/live-travel.ts). */
  /** Live times by booking id: trains from National Rail, flights from the flight connector (lib/briefing-run.ts). */
  trainStatus?: Record<string, TrainStatus | FlightStatus>;
  /** The owner's busiest TfL lines that aren't on Good Service right now, busiest first. */
  commute?: LineStatus[];
  /** The owner's "how to help" answers (lib/profile.ts loadBriefingHelp): length, and topics never to nudge about. */
  help?: { length: "short" | "standard" | "detailed"; neverNudge: string[] };
}

/** How many lines each list gets at each length. Short also leaves out the week ahead, meetings, catch-ups and yesterday. */
const LIMITS = {
  short: { due: 5, waiting: 3, catchUps: 0, yesterday: 0, extras: false },
  standard: { due: 8, waiting: 5, catchUps: 5, yesterday: 10, extras: true },
  detailed: { due: 12, waiting: 8, catchUps: 8, yesterday: 15, extras: true },
} as const;

export interface BriefingReminder {
  id: string;
  text: string;
  remind_at: string;
  about_type: string | null;
  about_id: string | null;
  about_title: string | null;
}

export interface Briefing {
  date: string;
  title: string;
  body: string;
  /** One-line push body, e.g. "Dentist 09:30 · Priya turns 35 in 3 days". */
  digest: string;
  /** True when there's anything in the digest worth a notification. */
  hasReminders: boolean;
}

/** Briefing time, local. */
export const BRIEFING_AT = { hour: 7, minute: 30 };
/** Timed events are pushed this long before they start. */
export const TIMED_LEAD_MINUTES = 30;

const LONG_DATE = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return LONG_DATE.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function whenText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function daysAgo(iso: string | null, now: Date): string {
  if (!iso) return "never logged";
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

const EXPIRES = new Set(["passport", "licence", "warranty"]);
const RENEWS = new Set(["insurance", "subscription"]);

/** "Passport expires in 26 days", "Car insurance renews tomorrow", "Boiler service lapsed 3 days ago". */
export function renewalText(r: BriefingRenewal, today: string): string {
  const n = daysBetween(today, r.renews_on);
  const verb = EXPIRES.has(r.kind) ? "expires" : RENEWS.has(r.kind) ? "renews" : "is due";
  if (n < 0) return `${r.name} ${EXPIRES.has(r.kind) ? "expired" : RENEWS.has(r.kind) ? "lapsed" : "was due"} ${-n === 1 ? "yesterday" : `${-n} days ago`}`;
  return `${r.name} ${verb} ${whenText(n)}`;
}

/** "Book the car's MOT · for Priya · 2 days late". */
function loopLine(c: BriefingLoop, today: string): string {
  const parts = [c.title];
  if (c.person) parts.push(`${c.kind === "waiting_on" ? "from" : "for"} ${formatAthenaLink("person", c.person.id, `@${c.person.name}`)}`);
  if (c.due_on && c.due_on < today) {
    const late = daysBetween(c.due_on, today);
    parts.push(late === 1 ? "due yesterday" : `${late} days late`);
  }
  return parts.join(" · ");
}

/** Is it time (local) to write today's briefing? True from 07:30 until midnight. */
export function isBriefingTime(now: Date, tz: string): boolean {
  const { hour, minute } = zonedParts(now, tz);
  return hour > BRIEFING_AT.hour || (hour === BRIEFING_AT.hour && minute >= BRIEFING_AT.minute);
}

/** The first `max` lines, then "…and N more". */
function capped<T>(items: T[], max: number, line: (item: T) => string, when: string): string[] {
  if (items.length <= max) return items.map(line);
  return [...items.slice(0, max - 1).map(line), `- …and ${items.length - (max - 1)} more ${when}`];
}

/**
 * The week ahead, sized to how busy it is: every item when there are a few;
 * when there are many, birthdays and dates you added stay listed one by one
 * and busy days (mostly synced meetings) become one line each.
 */
function comingUpLines<O extends { occurs_on: string; event: BriefingEvent }>(items: O[], describe: (o: O) => string): string[] {
  if (items.length <= 8) return items.map((o) => `- ${describe(o)}`);
  const lines: string[] = [];
  const byDay = new Map<string, O[]>();
  for (const o of items) byDay.set(o.occurs_on, [...(byDay.get(o.occurs_on) ?? []), o]);
  for (const [day, list] of byDay) {
    const personal = list.filter((o) => !o.event.source);
    const synced = list.filter((o) => o.event.source);
    for (const o of personal) lines.push(`- ${describe(o)}`);
    if (synced.length === 1) lines.push(`- ${describe(synced[0])}`);
    else if (synced.length > 1) lines.push(`- ${shortDay(day)}: ${synced.length} calendar events (${synced.slice(0, 2).map((o) => o.event.title).join(", ")}${synced.length > 2 ? ", …" : ""})`);
  }
  return lines.length <= 12 ? lines : [...lines.slice(0, 11), `- …and more this week`];
}

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
function shortDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return SHORT_DAY.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/**
 * A booking's briefing line: a train or flight with live times says how it's running
 * ("07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4",
 * "BA 432 Heathrow to Lisbon at 10:40: on time, gate B32, terminal 5").
 */
export function travelLine(b: BookingLike, today: string, tz: string, live?: Record<string, TrainStatus | FlightStatus>): string {
  const status = b.id && b.status !== "cancelled" ? live?.[b.id] : undefined;
  if (!status) return bookingLine(b, today, tz);
  return "provider" in status ? flightBriefingLine(b, status) : trainBriefingLine(b, status);
}

export function buildBriefing(input: BriefingInput): Briefing {
  const tz = input.tz;
  const today = zonedToday(input.now, tz);
  const yesterday = addDays(today, -1);
  const people = new Map(input.people.map((p) => [p.id, p]));

  const label = (e: BriefingEvent): string => {
    const person = e.kind === "birthday" && e.person_id ? people.get(e.person_id) : undefined;
    return person ? formatAthenaLink("person", person.id, `@${person.name}`) : formatAthenaLink("event", e.id, `@${e.title}`);
  };
  const plainName = (e: BriefingEvent): string => {
    const person = e.kind === "birthday" && e.person_id ? people.get(e.person_id) : undefined;
    return person ? person.name : e.title;
  };

  const occurrences = upcomingOccurrences(input.events, today, 14, tz);
  const todays = occurrences.filter((o) => o.days_until === 0);
  // This week, plus anything further out that asked to be mentioned today (e.g. "a week before").
  const soon = occurrences.filter((o) => o.days_until > 0 && (o.days_until <= 6 || o.event.remind_days_before.includes(o.days_until)));
  const reminderHits = occurrences.filter((o) => o.event.remind_days_before.includes(o.days_until));

  const describe = (o: (typeof occurrences)[number], withLink: boolean): string => {
    const name = withLink ? label(o.event) : plainName(o.event);
    if (o.event.kind === "birthday") {
      const turns = o.years ? `turns ${o.years}` : "has a birthday";
      return `${name} ${turns} ${whenText(o.days_until)}`;
    }
    const time = o.time ? ` at ${o.time}` : "";
    return o.days_until === 0 ? `${name}${time}` : `${name} ${whenText(o.days_until)}${time}`;
  };

  const limits = LIMITS[input.help?.length ?? "standard"];
  // A nudge (chase, catch up) never mentions a topic the owner asked to be left alone about.
  const topics = input.help?.neverNudge ?? [];
  const nudgeable = (...texts: Array<string | null | undefined>) => !topics.some((t) => texts.some((x) => x?.toLowerCase().includes(t)));
  const due = input.due ?? [];
  const waiting = (input.waiting ?? []).filter((c) => nudgeable(c.title, c.person?.name));
  const renewals = (input.renewals ?? []).filter((r) => daysBetween(today, r.renews_on) <= 30);
  const renewalHits = renewals.filter((r) => r.remind_days_before.includes(daysBetween(today, r.renews_on)));

  const laterToday = (input.reminders ?? [])
    .filter((r) => zonedToday(new Date(r.remind_at), tz) === today)
    .sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at));

  const sections: string[] = [];
  if (todays.length) sections.push(["## Today", ...capped(todays, 12, (o) => `- ${describe(o, true)}`, "today")].join("\n"));
  // Today's own reminders come straight after its dates: they're time-specific.
  if (laterToday.length) {
    sections.push(
      [
        "## Reminders",
        ...laterToday.map((r) => {
          const about =
            r.about_type && r.about_id && r.about_title
              ? ` (${formatAthenaLink(r.about_type as LinkKind, r.about_id, r.about_type === "note" ? r.about_title : `@${r.about_title}`)})`
              : "";
          return `- ${zonedParts(new Date(r.remind_at), tz).time} ${r.text}${about}`;
        }),
      ].join("\n"),
    );
  }
  // Travel this week: each trip's next booking, in the place's own time. Then today's parcels.
  const travel = travelComingUp(input.trips ?? [], today, input.now, 6);
  if (travel.length) sections.push(["## Travel", ...travel.map((t) => `- ${travelLine(t.booking, today, tz, input.trainStatus)}`)].join("\n"));
  // The owner's own lines, only when they aren't running normally.
  const commute = input.commute ?? [];
  if (commute.length) sections.push(["## Commute", ...commute.map((l) => `- ${lineLine(l)}`)].join("\n"));
  const parcels = deliveriesComingUp(input.purchases ?? [], today, tz, 0).filter((d) => d.state.days === 0);
  if (parcels.length) sections.push(["## Deliveries", ...parcels.map((d) => `- ${deliveryLine(d.purchase, today, tz)}`)].join("\n"));
  if (due.length) sections.push(["## To do", ...due.slice(0, limits.due).map((c) => `- ${loopLine(c, today)}`), ...(due.length > limits.due ? [`- …and ${due.length - limits.due} more`] : [])].join("\n"));
  if (soon.length && limits.extras) sections.push(["## Coming up", ...comingUpLines(soon, (o) => describe(o, true))].join("\n"));
  if (renewals.length) sections.push(["## Life admin", ...renewals.map((r) => `- ${renewalText(r, today)}`)].join("\n"));
  if (waiting.length) {
    sections.push(
      [
        "## Waiting on",
        ...waiting.slice(0, limits.waiting).map((c) => `- ${loopLine(c, today)} · quiet for ${daysBetween(zonedToday(new Date(c.updated_at), tz), today)} days. Worth a nudge?`),
      ].join("\n"),
    );
  }

  const meetings = input.recentNotes.filter((n) => n.source === "calendar-meetings" && zonedToday(new Date(n.created_at), tz) === today);
  if (meetings.length && limits.extras) {
    sections.push(["## Meetings", ...meetings.map((n) => `- ${formatAthenaLink("note", n.id, n.title || "Untitled")}`)].join("\n"));
  }

  const allCatchUps = input.catchUps.filter((p) => nudgeable(p.name));
  const catchUps = allCatchUps.slice(0, limits.catchUps);
  if (catchUps.length) {
    sections.push(
      [
        "## Catch up",
        ...catchUps.map(
          (p) =>
            `- ${formatAthenaLink("person", p.id, `@${p.name}`)}: ${p.last_contacted_at ? `last spoke ${daysAgo(p.last_contacted_at, input.now)}` : "no catch-up logged yet"}`,
        ),
        ...(allCatchUps.length > catchUps.length ? [`- …and ${allCatchUps.length - catchUps.length} more`] : []),
      ].join("\n"),
    );
  }

  const captures = input.recentNotes.filter(
    (n) => n.source !== "briefing" && n.source !== "calendar-meetings" && zonedToday(new Date(n.created_at), tz) === yesterday,
  );
  if (captures.length && limits.yesterday) {
    sections.push(["## Yesterday", ...captures.slice(0, limits.yesterday).map((n) => `- ${formatAthenaLink("note", n.id, n.title || "Untitled")}`)].join("\n"));
  }

  const pending = input.pendingSuggestions ?? 0;
  if (pending) {
    sections.push(`## Inbox\n- ${pending} ${pending === 1 ? "thing" : "things"} your collections found but weren't sure about. Open your Inbox to add or dismiss them.`);
  }

  const body = sections.length ? sections.join("\n\n") : "Nothing scheduled, nobody overdue and nothing to review.";

  // A journey today or tomorrow leads the push: it's the thing you can't be late for.
  const travelSoon = travel.filter((t) => t.days_until <= 1);
  const digestParts = [...travelSoon.map((t) => travelLine(t.booking, today, tz, input.trainStatus)), ...commute.slice(0, 1).map(lineLine), ...reminderHits.map((o) => describe(o, false))];
  if (parcels.length) digestParts.push(parcels.length === 1 ? deliveryLine(parcels[0].purchase, today, tz) : `${parcels.length} deliveries today`);
  if (due.length) digestParts.push(due.length === 1 ? `${due[0].title} is due` : `${due.length} to-dos due`);
  digestParts.push(...renewalHits.map((r) => renewalText(r, today)));
  if (!digestParts.length && waiting.length) digestParts.push(`Chase ${waiting[0].person?.name ?? "up"}: ${waiting[0].title}`);
  if (!digestParts.length && catchUps.length) digestParts.push(`Catch up with ${catchUps[0].name}`);

  return {
    date: today,
    title: `Today, ${longDate(today)}`,
    body,
    digest: digestParts.length ? digestParts.slice(0, 4).join(" · ") : "Your morning briefing is ready.",
    hasReminders: reminderHits.length > 0 || due.length > 0 || renewalHits.length > 0 || travelSoon.length > 0 || parcels.length > 0 || commute.length > 0,
  };
}

// ---------- the Sunday review nudge ----------

/** Sunday 18:00 local onwards: time to nudge the weekly review. */
export function isWeeklyReviewTime(now: Date, tz: string = DEFAULT_TZ): boolean {
  const { date, hour } = zonedParts(now, tz);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 && hour >= 18;
}

/** "Ticked off 5 things and saw 4 people. 3 still open, 1 overdue." */
export function weeklyDigest(w: { done: number; people: number; open: number; overdue: number }): string {
  const bits: string[] = [];
  if (w.done) bits.push(`ticked off ${w.done} ${w.done === 1 ? "thing" : "things"}`);
  if (w.people) bits.push(`saw ${w.people} ${w.people === 1 ? "person" : "people"}`);
  const first = bits.length ? `${bits.join(" and ").replace(/^./, (c) => c.toUpperCase())}.` : "A quiet week.";
  const open = w.open ? ` ${w.open} still open${w.overdue ? `, ${w.overdue} overdue` : ""}.` : "";
  return `${first}${open}`;
}

// ---------- before a meeting ----------

export interface MeetingPerson {
  name: string;
  last_contacted_at: string | null;
  /** To-dos for them, and things you're waiting on from them. */
  forThem: string[];
  fromThem: string[];
}

/**
 * The 30-minute push for a timed event with people linked to it: who, when
 * you last spoke, and what's open between you. Falls back to the time alone.
 */
export function meetingContext(time: string, people: MeetingPerson[], now: Date): string {
  if (!people.length) return `At ${time} today`;
  const p = people[0];
  const first = p.name.split(/\s+/)[0];
  const others = people.length > 1 ? ` and ${people.length - 1} more` : "";
  const parts = [`At ${time} with ${first}${others}`];
  if (p.last_contacted_at) parts.push(`last spoke ${daysAgo(p.last_contacted_at, now)}`);
  if (p.forThem.length) parts.push(`you said you'd ${p.forThem[0].charAt(0).toLowerCase()}${p.forThem[0].slice(1)}`);
  else if (p.fromThem.length) parts.push(`waiting on: ${p.fromThem[0]}`);
  return parts.join(" · ");
}

export interface TimedReminder {
  key: string;
  event: BriefingEvent;
  occursOn: string;
  startsAt: Date;
  /** Local "HH:MM" in the owner's zone, for the push text. */
  localTime: string;
}

/**
 * Timed events starting within the next TIMED_LEAD_MINUTES: each is due
 * from 30 minutes before its start until it starts. The 5-minute schedule
 * therefore always lands at least once in that window; `key` (claimed in
 * reminder_log) makes sure it's sent only once. Start instants are UTC, so
 * this works the same in any zone; `tz` only decides which day is "today".
 */
export function dueTimedReminders(events: BriefingEvent[], now: Date, tz: string): TimedReminder[] {
  const today = zonedToday(now, tz);
  const out: TimedReminder[] = [];
  for (const o of upcomingOccurrences(events.filter((e) => e.timed_push !== false), addDays(today, -1), 2, tz)) {
    if (!o.starts_at || !o.time) continue;
    const startsAt = new Date(o.starts_at);
    const from = startsAt.getTime() - TIMED_LEAD_MINUTES * 60_000;
    if (now.getTime() >= from && now.getTime() < startsAt.getTime()) {
      out.push({ key: `event:${o.event.id}:${o.starts_at}`, event: o.event, occursOn: o.occurs_on, startsAt, localTime: o.time });
    }
  }
  return out;
}
