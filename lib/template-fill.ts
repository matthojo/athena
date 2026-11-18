/**
 * Fill a template from what Athena already holds (lib/templates.ts has the
 * rules). Each field reads one source: the calendar event, the people at it
 * (details, the latest catch-up, open to-dos both ways), an Email digest
 * note about it, a trip and its bookings, the week's days, to-dos and
 * projects. No model is involved: every value is copied from a record and
 * cited, and a field with nothing behind it stays a blank for the owner.
 *
 * Health, money, mood and journal never go in: a week's days give only each
 * day's line, or where it went.
 */
import { getConnectionsDetailed, getEvent, getOwnerTimeZone, getPerson, listProjects, q, type AthenaEvent } from "./db";
import { sameMeeting } from "./event-twins";
import { listCommitments, listFacts, listInteractions, type Commitment } from "./memory";
import { getTrip, type Trip } from "./trips";
import { bookingName, shortDay, tripDates } from "./trip-text";
import { addDays, zonedToday } from "./dates";
import { getDay } from "./days";
import { isEncryptedPlaceholder } from "./encrypted";
import { fillTemplate, parseTemplate, splitTitle, type Cite, type FieldValue, type FieldValues, type FilledTemplate } from "./templates";

export interface FillContext {
  event_id?: string | null;
  person_ids?: string[];
  trip_id?: string | null;
  project_id?: string | null;
  /** Any day in the week to review, "YYYY-MM-DD"; this week when unset. */
  week_of?: string | null;
}

export interface FillResult extends FilledTemplate {
  title: string;
  /** Links the new note should carry (the meeting, its people, the project). */
  about: Array<{ kind: "event" | "person" | "project"; id: string }>;
}

const MAX_LINES = 8;
const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const readable = (s: string | null | undefined): s is string => !!s && !isEncryptedPlaceholder(s);
const one = (lines: string[], sources: Cite[]): FieldValue | null => (lines.length ? { lines: lines.slice(0, MAX_LINES), sources } : null);

function when(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(at).replace(",", "");
}
const dayLabel = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

/** Monday of the week `date` is in. */
function monday(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

interface Gathered {
  event: AthenaEvent | null;
  people: Array<{ id: string; name: string }>;
  trip: Trip | null;
  project: { id: string; name: string } | null;
}

async function gather(ctx: FillContext): Promise<Gathered> {
  const event = ctx.event_id ? await getEvent(ctx.event_id) : null;
  const people = new Map<string, string>();
  if (event) {
    if (event.person_id) {
      const p = await getPerson(event.person_id);
      if (p && readable(p.name)) people.set(p.id, p.name);
    }
    const links = await getConnectionsDetailed("event", event.id);
    for (const c of [...links.outgoing, ...links.backlinks]) if (c.kind === "person" && readable(c.title)) people.set(c.id, c.title);
  }
  for (const id of ctx.person_ids ?? []) {
    const p = await getPerson(id);
    if (p && readable(p.name)) people.set(p.id, p.name);
  }
  const trip = ctx.trip_id ? await getTrip(ctx.trip_id) : null;
  const project = ctx.project_id ? ((await listProjects(500)).find((p) => p.id === ctx.project_id) ?? null) : null;
  return { event, people: [...people].map(([id, name]) => ({ id, name })), trip, project: project ? { id: project.id, name: project.name } : null };
}

const LOOP_WORDS: Record<Commitment["kind"], (name: string) => string> = {
  todo: () => "",
  i_owe: (n) => `You owe ${n}: `,
  waiting_on: (n) => `Waiting on ${n}: `,
  decision: (n) => `Decided with ${n}: `,
};

/** The values for every field the template uses. */
export async function fieldValues(body: string, ctx: FillContext, opts: { now?: Date; tz?: string } = {}): Promise<{ values: FieldValues; got: Gathered }> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const today = zonedToday(now, tz);
  const got = await gather(ctx);
  const { event, people, trip, project } = got;
  const eventCite: Cite[] = event ? [{ label: event.title, kind: "event", id: event.id, detail: event.starts_at ? when(new Date(event.starts_at), tz) : dayLabel(event.date) }] : [];
  const personCite = (p: { id: string; name: string }, detail?: string): Cite => ({ label: p.name, kind: "person", id: p.id, detail });
  const values: FieldValues = {};
  const keys = new Set(parseTemplate(body).map((f) => f.key));
  const solo = people.length === 1 ? people[0] : null;

  for (const key of keys) {
    switch (key) {
      case "meeting":
        values[key] = event && readable(event.title) ? one([event.title], eventCite) : null;
        break;
      case "date":
        values[key] = event ? one([event.starts_at ? when(new Date(event.starts_at), tz) : dayLabel(event.date)], eventCite) : one([dayLabel(today)], [{ label: "Today" }]);
        break;
      case "today":
        values[key] = one([new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${today}T12:00:00Z`))], [{ label: "Today" }]);
        break;
      case "attendees":
        values[key] = event && people.length ? one(people.map((p) => p.name), eventCite) : null;
        break;
      case "person":
        values[key] = people.length ? one([people.map((p) => p.name).join(", ")], people.map((p) => personCite(p))) : null;
        break;
      case "last time we spoke": {
        const lines: string[] = [];
        const sources: Cite[] = [];
        for (const p of people.slice(0, 4)) {
          const [last] = await listInteractions({ personId: p.id, limit: 1 });
          if (!last || !readable(last.summary)) continue;
          const day = shortDay(zonedToday(new Date(last.at), tz));
          lines.push(`${people.length > 1 ? `${p.name}, ` : ""}${day}: ${clip(last.summary, 240)}`);
          sources.push(personCite(p, `catch-up on ${day}`));
        }
        values[key] = one(lines, sources);
        break;
      }
      case "about them": {
        if (!solo) {
          values[key] = null;
          break;
        }
        const facts = (await listFacts({ subjectKind: "person", subjectId: solo.id })).filter((f) => readable(f.value)).slice(0, 5);
        values[key] = one(
          facts.map((f) => `${f.key.replace(/_/g, " ")}: ${clip(f.value)}`),
          facts.length ? [personCite(solo, "saved details")] : [],
        );
        break;
      }
      case "open loops": {
        const lines: string[] = [];
        const sources: Cite[] = [];
        for (const p of people.slice(0, 4)) {
          const open = (await listCommitments({ personId: p.id, status: "open", limit: 6 })).filter((c) => readable(c.title) && c.kind !== "decision");
          for (const c of open) {
            lines.push(`[ ] ${LOOP_WORDS[c.kind](p.name)}${clip(c.title)}`);
            sources.push({ label: c.title, kind: "todo", id: c.id });
          }
        }
        // "[ ] …" lines become a checklist (lib/templates.ts fillTemplate).
        values[key] = one(lines, sources.slice(0, 4));
        break;
      }
      case "agenda from email":
        values[key] = await agendaFromEmail(event, people, now);
        break;
      case "trip":
        values[key] = trip && readable(trip.title) ? one([trip.title], [{ label: `Trip · ${trip.title}` }]) : null;
        break;
      case "trip dates": {
        const dates = trip ? tripDates(trip.starts_on, trip.ends_on, today) : "";
        values[key] = trip && dates ? one([dates], [{ label: `Trip · ${trip.title}` }]) : null;
        break;
      }
      case "trip legs": {
        const legs = (trip?.bookings ?? []).filter((b) => readable(b.title) || readable(b.provider));
        values[key] = trip ? one(legs.map((b) => `${shortDay(b.start_date)}: ${bookingName(b)}`), [{ label: `Trip · ${trip.title}`, detail: `${legs.length} booking${legs.length === 1 ? "" : "s"}` }]) : null;
        break;
      }
      case "week": {
        const start = monday(ctx.week_of ?? today);
        values[key] = one([`${dayLabel(start)} to ${dayLabel(addDays(start, 6))}`], [{ label: "This week" }]);
        break;
      }
      case "this week's days": {
        const start = monday(ctx.week_of ?? today);
        const lines: string[] = [];
        for (let i = 0; i < 7; i++) {
          const date = addDays(start, i);
          if (date > today) break;
          const d = await getDay(date).catch(() => null);
          const line = d?.line && readable(d.line) ? d.line : d?.places_line && readable(d.places_line) ? d.places_line : "";
          if (line) lines.push(`${dayLabel(date)}: ${clip(line)}`);
        }
        values[key] = one(lines, lines.length ? [{ label: "Days", detail: `${lines.length} day${lines.length === 1 ? "" : "s"}` }] : []);
        break;
      }
      case "this week's done to-dos": {
        const start = monday(ctx.week_of ?? today);
        const since = new Date(`${start}T00:00:00Z`);
        const done = (await listCommitments({ status: "done", doneSince: since, limit: 20 })).filter((c) => readable(c.title));
        values[key] = one(
          done.map((c) => c.title),
          done.length ? [{ label: "To-dos", detail: `${done.length} done` }] : [],
        );
        break;
      }
      case "open to-dos": {
        const open = (await listCommitments({ status: "open", kinds: ["todo", "i_owe"], dueBy: addDays(today, 7), limit: 10 })).filter((c) => readable(c.title));
        values[key] = one(
          open.map((c) => `[ ] ${c.title}${c.due_on ? ` (due ${shortDay(c.due_on)})` : ""}`),
          open.length ? [{ label: "To-dos", detail: `${open.length} due in the next week` }] : [],
        );
        break;
      }
      case "project":
        values[key] = project ? one([project.name], [{ label: project.name, kind: "project", id: project.id }]) : null;
        break;
      case "project people":
      case "open to-dos for project": {
        if (!project) {
          values[key] = null;
          break;
        }
        const links = await getConnectionsDetailed("project", project.id);
        const all = [...links.outgoing, ...links.backlinks];
        if (key === "project people") {
          const ps = [...new Map(all.filter((c) => c.kind === "person" && readable(c.title)).map((c) => [c.id, c.title])).entries()];
          values[key] = one(
            ps.map(([, n]) => n),
            ps.slice(0, 4).map(([id, name]) => ({ label: name, kind: "person" as const, id })),
          );
        } else {
          const ids = new Set(all.filter((c) => c.kind === "commitment").map((c) => c.id));
          const open = ids.size ? (await listCommitments({ status: "open", limit: 200 })).filter((c) => ids.has(c.id) && readable(c.title)) : [];
          values[key] = one(
            open.map((c) => `[ ] ${c.title}`),
            open.length ? [{ label: project.name, kind: "project", id: project.id, detail: `${open.length} open` }] : [],
          );
        }
        break;
      }
      case "my name": {
        const name = (await listFacts({ subjectKind: "me" })).find((f) => f.key === "name" && readable(f.value));
        values[key] = name ? one([name.value], [{ label: "Your profile" }]) : null;
        break;
      }
      default:
        values[key] = null;
    }
  }
  return { values, got };
}

/**
 * The newest Email digest note from the last three weeks that names the
 * meeting or one of its people: its list items (or opening lines) as the
 * agenda. Only notes Athena already collected are read here; nothing is
 * fetched from the mailbox.
 */
async function agendaFromEmail(event: AthenaEvent | null, people: Array<{ id: string; name: string }>, now: Date): Promise<FieldValue | null> {
  if (!event) return null;
  const since = new Date(now.getTime() - 21 * 86_400_000).toISOString();
  const notes = await q<{ id: string; title: string; body: string; updated_at: string }>(
    `SELECT id, title, body, updated_at FROM notes WHERE archived_at IS NULL AND source LIKE 'email-digest%' AND updated_at >= $1 ORDER BY updated_at DESC LIMIT 60`,
    [since],
  );
  const names = [event.title, ...people.map((p) => p.name)].filter((n) => readable(n) && n.length > 2).map((n) => n.toLowerCase());
  const meetingWord = event.title.toLowerCase();
  const hit = notes.find((n) => {
    if (!readable(n.title) || !readable(n.body)) return false;
    const text = `${n.title}\n${n.body}`.toLowerCase();
    // The meeting's own title, or one of its people and the word agenda.
    return text.includes(meetingWord) || (/\bagenda\b/.test(text) && names.some((x) => text.includes(x)));
  });
  if (!hit) return null;
  const items = hit.body
    .split("\n")
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(l)?.[1])
    .filter((l): l is string => !!l && !/athena:\/\//.test(l))
    .map((l) => clip(l));
  const lines = items.length
    ? items
    : hit.body
        .split(/\n+/)
        .filter((l) => l.trim() && !l.startsWith("#"))
        .slice(0, 2)
        .map((l) => clip(l, 240));
  return one(lines, [{ label: hit.title, kind: "note", id: hit.id, detail: "Email digest" }]);
}

/** Fill a template's body for this context. */
export async function fillFromAthena(template: { name: string; body: string }, ctx: FillContext, opts: { now?: Date; tz?: string } = {}): Promise<FillResult> {
  const { values, got } = await fieldValues(template.body, ctx, opts);
  const filled = fillTemplate(template.body, values);
  const about: FillResult["about"] = [
    ...(got.event ? [{ kind: "event" as const, id: got.event.id }] : []),
    ...got.people.map((p) => ({ kind: "person" as const, id: p.id })),
    ...(got.project ? [{ kind: "project" as const, id: got.project.id }] : []),
  ];
  // The opening heading is the note's title; without one, what it's about, else the template's name.
  const split = splitTitle(filled.body, got.event?.title ?? got.trip?.title ?? got.project?.name ?? template.name);
  return { ...filled, ...split, about };
}

export interface PrepareSuggestion {
  event_id: string;
  title: string;
  starts_at: string;
  people: Array<{ id: string; name: string }>;
}

/**
 * Whether a meeting already has notes: a note linked to it either way round,
 * except a daily note. The morning briefing (type "daily") links every one of
 * today's meetings in passing, which isn't preparing for them; counting it hid
 * today's meetings and offered tomorrow's instead.
 */
export const hasMeetingNotes = (links: Array<{ kind: string; subtitle?: string | null }>): boolean =>
  links.some((c) => c.kind === "note" && c.subtitle !== "daily");

/**
 * For Today's "Prepare notes": timed meetings in the next 36 hours with at
 * least one person Athena knows, that don't already have notes
 * (hasMeetingNotes), soonest first.
 */
export async function prepareSuggestions(opts: { now?: Date; limit?: number } = {}): Promise<PrepareSuggestion[]> {
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + 36 * 3_600_000).toISOString();
  const events = await q<{ id: string; title: string; starts_at: string }>(
    `SELECT id, title, starts_at FROM events
      WHERE archived_at IS NULL AND starts_at IS NOT NULL AND starts_at >= $1 AND starts_at < $2 AND rsvp <> 'declined'
      ORDER BY starts_at LIMIT 20`,
    [now.toISOString(), until],
  );
  const out: PrepareSuggestion[] = [];
  for (const e of events) {
    if (!readable(e.title)) continue;
    const links = await getConnectionsDetailed("event", e.id);
    const all = [...links.outgoing, ...links.backlinks];
    if (hasMeetingNotes(all)) continue;
    const people = [...new Map(all.filter((c) => c.kind === "person" && readable(c.title)).map((c) => [c.id, c.title])).entries()].map(([id, name]) => ({ id, name }));
    if (!people.length) continue;
    // The same meeting saved twice (lib/event-twins.ts) is offered once, with everyone from both.
    const twin = out.find((o) => sameMeeting(o, e));
    if (twin) {
      for (const p of people) if (!twin.people.some((x) => x.id === p.id)) twin.people.push(p);
      continue;
    }
    if (out.length >= (opts.limit ?? 3)) break;
    out.push({ event_id: e.id, title: e.title, starts_at: e.starts_at, people });
  }
  return out;
}

