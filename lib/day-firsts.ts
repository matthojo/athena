/**
 * What Home's memory needs from the server (GET /api/days/firsts?around=):
 *
 *  - firsts: a place's first visit, a person's first logged catch-up, the
 *    first run over 5 km and the first finished book, when the first was at
 *    least a year ago and its anniversary falls within three days of `around`.
 *  - days: who you saw and where you went on the candidate days (the same
 *    week in each of the last six years, and each first's date), so the app
 *    can say "lunch with Priya at Dishoom" and skip a day with someone
 *    who has since been archived.
 *  - never: the owner's "Never nudge about" topics, which memories honour too.
 *
 * The app picks one memory a day (app/src/lib/memories.ts). Memories are
 * shown only in the app, never in a push. Nothing here logs what it reads.
 */
import { openStrict } from "./data-box";
import { addDays } from "./dates";
import { getOwnerTimeZone, q, qRaw } from "./db";
import { readHealthDays } from "./health";
import { workoutKind } from "./health-line";
import { placeDays, type PlaceDay } from "./places-visits";
import { loadBriefingHelp } from "./profile";
import type { DayFirst, DayFirstKind, MemoryContext, MemoryDay } from "./memory-types";

export type { DayFirst, DayFirstKind, MemoryContext, MemoryDay };

/** Anniversaries this close to `around` count. */
export const FIRSTS_WINDOW = 3;
/** How many earlier years the same week is read for. */
export const MEMORY_YEARS = 6;
/** A run counts from this distance. */
export const FIRST_RUN_METRES = 5000;

const ROUTINE = new Set(["home", "work"]);

const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** `date`'s anniversary in year `y` (29 February is the 28th in other years). */
export function anniversaryIn(date: string, y: number): string {
  const md = date.slice(5);
  return md === "02-29" && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`;
}

/**
 * How many days `date`'s anniversary is from `around` (0 on the day), and
 * how many years ago it was; null when it's less than a year ago or the
 * nearest anniversary is further than `window` days away.
 */
export function anniversaryGap(date: string, around: string, window = FIRSTS_WINDOW): { gap: number; years: number } | null {
  const y = Number(around.slice(0, 4));
  let best: { gap: number; years: number } | null = null;
  for (const yy of [y - 1, y, y + 1]) {
    const a = anniversaryIn(date, yy);
    const gap = Math.round((dayMs(around) - dayMs(a)) / 86_400_000);
    const years = yy - Number(date.slice(0, 4));
    if (years < 1 || Math.abs(gap) > window) continue;
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { gap, years };
  }
  return best;
}

/** The same week (`around` ± window) in each of the last `years` years. */
export function sameWeekEarlier(around: string, years = MEMORY_YEARS, window = FIRSTS_WINDOW): Array<{ from: string; to: string }> {
  const y = Number(around.slice(0, 4));
  return Array.from({ length: years }, (_, i) => {
    const mid = anniversaryIn(around, y - 1 - i);
    return { from: addDays(mid, -window), to: addDays(mid, window) };
  });
}

// ---------- Firsts ----------

/** Each live Place's first visit day and how many days since then you went back. */
async function placeFirsts(): Promise<DayFirst[]> {
  const rows = await qRaw<{ id: string; name: string; sealed: string }>(
    `SELECT p.id, p.name, g.sealed FROM places p JOIN place_geo g ON g.place_id = p.id WHERE p.archived_at IS NULL`,
  );
  const out: DayFirst[] = [];
  for (const r of rows) {
    let days: string[];
    try {
      days = Object.keys((JSON.parse(openStrict(r.sealed)) as { seen?: Record<string, unknown> }).seen ?? {}).sort();
    } catch {
      continue;
    }
    if (!days.length) continue;
    let name: string;
    try {
      name = r.name.startsWith("enc:") ? openStrict(r.name) : r.name;
    } catch {
      continue;
    }
    if (ROUTINE.has(name.trim().toLowerCase())) continue;
    out.push({ kind: "place", date: days[0], name, since: days.length - 1 });
  }
  return out;
}

/** Each live person's first logged catch-up (in person, a meeting or a call; not a message), and how many since. */
async function personFirsts(tz: string): Promise<DayFirst[]> {
  const rows = await q<{ name: string; first: string; n: number | string }>(
    `SELECT p.name, to_char(min(i.at AT TIME ZONE $1), 'YYYY-MM-DD') AS first, count(*) AS n
       FROM interaction_people ip
       JOIN interactions i ON i.id = ip.interaction_id AND i.archived_at IS NULL AND i.channel IN ('in_person', 'meeting', 'call')
       JOIN people p ON p.id = ip.person_id AND p.archived_at IS NULL
      GROUP BY p.id, p.name`,
    [tz],
  );
  return rows.map((r) => ({ kind: "person" as const, date: r.first, name: r.name, since: Number(r.n) - 1 }));
}

/** The first run over 5 km, read a few months at a time from the oldest health day. */
async function firstRun(before: string): Promise<DayFirst | null> {
  const [row] = await qRaw<{ first: string | null }>(`SELECT to_char(min(day), 'YYYY-MM-DD') AS first FROM sensitive_blobs WHERE domain = 'health'`);
  if (!row?.first) return null;
  for (let from = row.first; from <= before; from = addDays(from, 120)) {
    const to = addDays(from, 119) < before ? addDays(from, 119) : before;
    const { days } = await readHealthDays(from, to);
    for (const date of [...days.keys()].sort()) {
      for (const f of days.get(date) ?? []) {
        const run = (f.workouts ?? []).find((w) => workoutKind(w.type) === "run" && (w.distance_m ?? 0) > FIRST_RUN_METRES);
        if (run) return { kind: "run", date, name: "run", km: Math.round(run.distance_m! / 100) / 10 };
      }
    }
  }
  return null;
}

/** The first book marked done in Watch & read. */
async function firstBook(tz: string): Promise<DayFirst | null> {
  const [row] = await q<{ title: string; day: string }>(
    `SELECT title, to_char(finished_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day FROM reading_items
      WHERE kind = 'book' AND status = 'done' AND finished_at IS NOT NULL AND archived_at IS NULL
      ORDER BY finished_at LIMIT 1`,
    [tz],
  );
  return row ? { kind: "book", date: row.day, name: row.title } : null;
}

/** Firsts with an anniversary within three days of `around`, a year ago or more, nearest first. */
export async function firstsAround(around: string, opts: { tz?: string } = {}): Promise<DayFirst[]> {
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const yearAgo = addDays(around, -360);
  const settle = <T>(p: Promise<T>, empty: T) => p.catch(() => empty);
  const [places, people, run, book] = await Promise.all([settle(placeFirsts(), []), settle(personFirsts(tz), []), settle(firstRun(yearAgo), null), settle(firstBook(tz), null)]);
  const all = [...places, ...people, ...(run ? [run] : []), ...(book ? [book] : [])];
  return all
    .map((f) => ({ f, a: anniversaryGap(f.date, around) }))
    .filter((x): x is { f: DayFirst; a: { gap: number; years: number } } => !!x.a)
    .sort((x, y) => Math.abs(x.a.gap) - Math.abs(y.a.gap) || x.f.date.localeCompare(y.f.date))
    .map((x) => x.f);
}

// ---------- Who and where, per day ----------

async function peopleOn(dates: string[], tz: string): Promise<Map<string, { people: Map<string, boolean>; inPerson: boolean }>> {
  const out = new Map<string, { people: Map<string, boolean>; inPerson: boolean }>();
  if (!dates.length) return out;
  const rows = await q<{ day: string; channel: string; name: string; archived: boolean }>(
    `SELECT to_char(i.at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, i.channel, p.name, (p.archived_at IS NOT NULL) AS archived
       FROM interactions i
       JOIN interaction_people ip ON ip.interaction_id = i.id
       JOIN people p ON p.id = ip.person_id
      WHERE i.archived_at IS NULL
        AND i.channel IN ('in_person', 'meeting', 'call')
        AND (i.at AT TIME ZONE $1)::date = ANY($2::date[])`,
    [tz, dates],
  );
  for (const r of rows) {
    const d = out.get(r.day) ?? { people: new Map<string, boolean>(), inPerson: false };
    d.people.set(r.name, (d.people.get(r.name) ?? false) || r.archived);
    if (r.channel !== "call") d.inPerson = true;
    out.set(r.day, d);
  }
  return out;
}

/** Everything the app's memory picker reads, for `around` (a YYYY-MM-DD). */
export async function memoryContext(around: string, opts: { tz?: string } = {}): Promise<MemoryContext> {
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const weeks = sameWeekEarlier(around);
  const [firsts, never] = await Promise.all([firstsAround(around, { tz }), loadBriefingHelp().then((h) => h.neverNudge, () => [] as string[])]);
  const ranges = [...weeks, ...firsts.map((f) => ({ from: f.date, to: f.date }))];
  const dates = [...new Set(ranges.flatMap((r) => Array.from({ length: Math.round((dayMs(r.to) - dayMs(r.from)) / 86_400_000) + 1 }, (_, i) => addDays(r.from, i))))].sort();
  const [who, where] = await Promise.all([
    peopleOn(dates, tz).catch(() => new Map<string, { people: Map<string, boolean>; inPerson: boolean }>()),
    Promise.all(ranges.map((r) => placeDays(r.from, r.to).catch(() => new Map<string, PlaceDay>()))).then((ms) => {
      const all = new Map<string, PlaceDay>();
      for (const m of ms) for (const [d, v] of m) all.set(d, v);
      return all;
    }),
  ]);
  const days: MemoryDay[] = [];
  for (const date of dates) {
    const w = who.get(date);
    const p = where.get(date);
    const places = (p?.places ?? []).map((x) => x.name).filter((n) => !ROUTINE.has(n.trim().toLowerCase()));
    if (!w && !places.length) continue;
    days.push({
      date,
      people: w ? [...w.people].map(([name, archived]) => ({ name, archived })) : [],
      ...(w && !w.inPerson ? { call: true } : {}),
      ...(p?.line ? { line: p.line } : {}),
      places,
    });
  }
  return { around, firsts, days, never };
}
