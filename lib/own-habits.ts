/**
 * The owner's own habits (migration 0036): made, edited and ticked in Athena,
 * beside the ones other apps send. lib/habit-rules.ts has the rules (due
 * days, streaks, targets, names); this file has the SQL.
 *
 * A tick is a `habit` day entry with source 'athena' and the external id
 * `habit:<id>:<date>`, written through writeEntries like any other source,
 * so the Day, the year grid, Patterns and the evening nudge read it as they
 * read Habitify's. Setting a day back to 0 removes the entry (undo).
 *
 * An N-a-week habit's whole week that ended short counts its undone days as
 * missed: on the Habits page, in Ask and in Patterns.
 *
 * Sealed (SECURITY.md §11): a habit's name and unit, and the entries' titles
 * and notes. Names are matched and kept unique here, never in SQL.
 */
import { AthenaInputError, q, qRaw, sealer, tx } from "./db";
import { addDays, isValidDate } from "./dates";
import { extKeys, writeEntries } from "./days";
import { touchDays } from "./day-touch";
import {
  ATHENA_SOURCE,
  EVERY_DAY,
  MAX_HABITS,
  MAX_NAME,
  MAX_TARGET,
  clampProgress,
  doneThisWeek,
  isDone,
  isDueOn,
  isHabitIcon,
  matchHabit,
  nameKey,
  needsToday,
  pickDue,
  progressNote,
  progressOf,
  scheduleWords,
  shortWeek,
  showsOn,
  streakOf,
  weekStart,
  type OwnHabit,
} from "./habit-rules";

export type { OwnHabit };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = `id, name, days, per_week, target, unit, icon, position, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, archived_at, created_at, updated_at`;
const extId = (id: string, date: string) => `habit:${id}:${date}`;
const EXT = /^habit:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

type Row = Omit<OwnHabit, "archived_at" | "created_at" | "updated_at"> & { archived_at: Date | string | null; created_at: Date | string; updated_at: Date | string };
const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : v);
const toHabit = (r: Row): OwnHabit => ({ ...r, icon: isHabitIcon(r.icon) ? r.icon : "check", archived_at: iso(r.archived_at), created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! });

export async function listOwnHabits(opts: { includeArchived?: boolean } = {}): Promise<OwnHabit[]> {
  const rows = await q<Row>(`SELECT ${COLS} FROM habits WHERE ($1::boolean OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL, position, created_at`, [opts.includeArchived ?? false]);
  return rows.map(toHabit);
}

export async function getOwnHabit(id: string): Promise<OwnHabit | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<Row>(`SELECT ${COLS} FROM habits WHERE id = $1`, [id]);
  return row ? toHabit(row) : null;
}

// ---------- making and changing ----------

export interface HabitPatch {
  name?: string;
  days?: number;
  per_week?: number | null;
  target?: number | null;
  unit?: string | null;
  icon?: string;
  archived?: boolean;
  position?: number;
}

function readPatch(raw: unknown): HabitPatch {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: HabitPatch = {};
  if (o.name !== undefined) {
    const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
    if (!name || !nameKey(name)) throw new AthenaInputError("Give the habit a name");
    if (name.length > MAX_NAME) throw new AthenaInputError(`Keep the name under ${MAX_NAME} characters`);
    out.name = name;
  }
  if (o.days !== undefined) {
    const d = Number(o.days);
    if (!Number.isInteger(d) || d < 0 || d > EVERY_DAY) throw new AthenaInputError("days: the weekdays as a number, Monday 1 to Sunday 64");
    out.days = d;
  }
  if (o.per_week !== undefined) {
    if (o.per_week === null) out.per_week = null;
    else {
      const n = Number(o.per_week);
      if (!Number.isInteger(n) || n < 1 || n > 7) throw new AthenaInputError("per_week: 1 to 7 times a week");
      out.per_week = n;
    }
  }
  if (o.target !== undefined) {
    if (o.target === null || o.target === "" || Number(o.target) <= 1) out.target = null;
    else {
      const n = Number(o.target);
      if (!Number.isInteger(n) || n > MAX_TARGET) throw new AthenaInputError(`target: a whole number up to ${MAX_TARGET}`);
      out.target = n;
    }
  }
  if (o.unit !== undefined) {
    const u = typeof o.unit === "string" ? o.unit.replace(/\s+/g, " ").trim().slice(0, 24) : "";
    out.unit = u || null;
  }
  if (o.icon !== undefined) {
    if (!isHabitIcon(o.icon)) throw new AthenaInputError("icon: one of the habit icons");
    out.icon = o.icon;
  }
  if (o.archived !== undefined) out.archived = o.archived === true;
  if (o.position !== undefined && Number.isInteger(Number(o.position))) out.position = Number(o.position);
  return out;
}

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;
const lock = (run: Run) => run(`SELECT pg_advisory_xact_lock(hashtext('athena:habits'))`);

async function nameTaken(run: Run, name: string, except?: string): Promise<OwnHabit | null> {
  const all = (await run<Row>(`SELECT ${COLS} FROM habits`)).map(toHabit);
  return all.find((h) => h.id !== except && nameKey(h.name) === nameKey(name)) ?? null;
}

const taken = (h: OwnHabit) =>
  new AthenaInputError(h.archived_at ? `You have an archived habit called “${h.name}”. Bring it back from its sheet instead.` : `You already have a habit called “${h.name}”.`);

/** Make a habit. It counts from `today` (the owner's day). */
export async function createOwnHabit(raw: unknown, today: string): Promise<OwnHabit> {
  const p = readPatch(raw);
  if (!p.name) throw new AthenaInputError("Give the habit a name");
  const days = p.days ?? EVERY_DAY;
  if (!p.per_week && !days) throw new AthenaInputError("Choose at least one day, or a number of times a week");
  const s = await sealer();
  return tx(async (run) => {
    await lock(run);
    const clash = await nameTaken(run, p.name!);
    if (clash) throw taken(clash);
    const [{ n }] = await run<{ n: number }>(`SELECT count(*)::int AS n FROM habits WHERE archived_at IS NULL`);
    if (n >= MAX_HABITS) throw new AthenaInputError(`That's ${MAX_HABITS} habits already. Archive one first.`);
    const [row] = await run<Row>(
      `INSERT INTO habits (name, days, per_week, target, unit, icon, position, starts_on)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(max(position) + 1, 0) FROM habits WHERE archived_at IS NULL), $7::date) RETURNING ${COLS}`,
      [s.text(p.name!), days || EVERY_DAY, p.per_week ?? null, p.target ?? null, s.maybe(p.target ? (p.unit ?? null) : null), p.icon ?? "check", today],
    );
    return toHabit(row);
  });
}

/** Change a habit. A new name is written onto its past ticks too, so its history stays one habit everywhere. */
export async function updateOwnHabit(id: string, raw: unknown): Promise<OwnHabit | null> {
  const before = await getOwnHabit(id);
  if (!before) return null;
  const p = readPatch(raw);
  const next = { ...before, ...p };
  if (!next.per_week && !next.days) throw new AthenaInputError("Choose at least one day, or a number of times a week");
  const s = await sealer();
  const renamed = p.name !== undefined && p.name !== before.name;
  const habit = await tx(async (run) => {
    await lock(run);
    if (renamed) {
      const clash = await nameTaken(run, p.name!, id);
      if (clash) throw taken(clash);
    }
    if (p.archived === false && before.archived_at) {
      const [{ n }] = await run<{ n: number }>(`SELECT count(*)::int AS n FROM habits WHERE archived_at IS NULL`);
      if (n >= MAX_HABITS) throw new AthenaInputError(`That's ${MAX_HABITS} habits already. Archive one first.`);
    }
    const [row] = await run<Row>(
      `UPDATE habits SET name = $2, days = $3, per_week = $4, target = $5, unit = $6, icon = $7, position = $8,
         archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [id, s.text(next.name), next.days || EVERY_DAY, next.per_week ?? null, next.target ?? null, s.maybe(next.target ? (next.unit ?? null) : null), next.icon, next.position, p.archived ?? null],
    );
    return toHabit(row);
  });
  if (renamed) {
    const ticks = await ticksOf([id]);
    for (const t of ticks) await qRaw(`UPDATE day_entries SET title = $2, updated_at = now() WHERE id = $1`, [t.entry_id, s.text(habit.name)]);
    if (ticks.length) await touchDays([...new Set(ticks.map((t) => t.date))]);
  }
  return habit;
}

// ---------- ticks ----------

interface Tick {
  entry_id: string;
  habit_id: string;
  date: string;
  count: number;
  note: string | null;
  hidden: boolean;
}

/** Athena's habit entries (all, or for some habits, or in a range), opened. */
async function ticksOf(ids?: string[], from?: string, to?: string): Promise<Tick[]> {
  const rows = await q<{ id: string; external_id: string; date: string; count: number; note: string | null; archived_at: string | null }>(
    `SELECT id, external_id, to_char(date, 'YYYY-MM-DD') AS date, count, note, archived_at FROM day_entries
     WHERE source = $1 AND kind = 'habit' AND folded_into IS NULL AND ($2::date IS NULL OR date >= $2::date) AND ($3::date IS NULL OR date <= $3::date)`,
    [ATHENA_SOURCE, from ?? null, to ?? null],
  );
  const out: Tick[] = [];
  for (const r of rows) {
    const m = r.external_id.match(EXT);
    if (!m || (ids && !ids.includes(m[1]))) continue;
    out.push({ entry_id: r.id, habit_id: m[1], date: m[2], count: r.count, note: r.note, hidden: !!r.archived_at });
  }
  return out;
}

export interface TickResult {
  habit_id: string;
  date: string;
  progress: number;
  done: boolean;
  /** What it was before, for Undo. */
  previous: number;
}

/**
 * Set a day's count for a habit: 0 clears the day, a plain habit's 1 ticks
 * it, a target's count is kept as "3 of 8 glasses" and done once it's
 * reached. A day before the habit started moves its start back.
 */
export async function setHabitDay(id: string, date: string, rawProgress: unknown, today: string): Promise<TickResult | null> {
  if (!isValidDate(date)) throw new AthenaInputError("date: YYYY-MM-DD");
  if (date > today) throw new AthenaInputError("That day hasn't happened yet");
  const habit = await getOwnHabit(id);
  if (!habit) return null;
  if (habit.archived_at) throw new AthenaInputError("That habit is archived. Bring it back to tick it.");
  const progress = clampProgress(Number(rawProgress));
  const keys = extKeys(ATHENA_SOURCE, extId(id, date));
  const [prev] = await q<{ id: string; count: number; note: string | null; archived_at: string | null }>(
    `SELECT id, count, note, archived_at FROM day_entries WHERE source = $1 AND ext_key = ANY($2::text[]) LIMIT 1`,
    [ATHENA_SOURCE, keys],
  );
  const previous = prev && !prev.archived_at ? progressOf(prev, habit.target) : 0;
  const result: TickResult = { habit_id: id, date, progress, done: isDone(progress, habit.target), previous };
  // Hidden on the day, or cleared: the old entry goes, so a tick always shows.
  if (prev && (prev.archived_at || progress === 0)) {
    await qRaw(`DELETE FROM day_entries WHERE id = $1`, [prev.id]);
    if (progress === 0) await touchDays([date]);
  }
  if (progress === 0) return result;
  if (date < habit.starts_on) await qRaw(`UPDATE habits SET starts_on = $2::date, updated_at = now() WHERE id = $1`, [id, date]);
  await writeEntries([
    {
      date,
      entry: {
        kind: "habit",
        source: ATHENA_SOURCE,
        external_id: extId(id, date),
        title: habit.name,
        count: result.done ? 1 : 0,
        ...(habit.target ? { note: progressNote(progress, habit.target, habit.unit) } : {}),
      },
    },
  ]);
  return result;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };

/** A day as the Shortcut may say it: YYYY-MM-DD, "today" or "yesterday". */
function readDay(raw: unknown, today: string): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || s === "today") return today;
  if (s === "yesterday") return addDays(today, -1);
  const d = s.slice(0, 10);
  if (!isValidDate(d)) throw new AthenaInputError("date: YYYY-MM-DD, today or yesterday");
  return d;
}

/**
 * POST /api/habits/log from the Shortcut: the habit by name (any case), and
 * optionally how many to add and which day. A plain habit is ticked; a
 * target counts up by `count` (1 when not given). A count of 0 clears it.
 */
export async function logHabit(raw: unknown, today: string): Promise<TickResult & { name: string; message: string }> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const said = typeof o.habit === "string" ? o.habit : typeof o.name === "string" ? o.name : "";
  const habits = await listOwnHabits();
  if (!habits.length) throw new AthenaInputError("You have no habits in Athena yet. Make one in Library → Habits.");
  let found = matchHabit(habits, said);
  // Several could be meant: the one due today, if only one is.
  if ("error" in found && found.error === "many") {
    const ticks = await ticksOf(found.candidates.map((h) => h.id), weekStart(today), today);
    const due = pickDue(found.candidates, (h) => showsOn(h, today, new Set(ticks.filter((t) => t.habit_id === h.id && t.count > 0 && !t.hidden).map((t) => t.date))));
    if (due) found = { habit: due };
  }
  if ("error" in found) {
    // A capture key reaches this, and it reads nothing back: the errors never list the owner's habits (security review H1).
    if (!said.trim()) throw new AthenaInputError("Say which habit.");
    throw new AthenaInputError(found.error === "many" ? `“${said.trim()}” could be more than one habit. Say the whole name.` : `No habit called “${said.trim()}”. Check its name in Library → Habits.`);
  }
  const habit = found.habit;
  const date = readDay(o.date, today);
  let count: number | undefined;
  if (o.count !== undefined && o.count !== null && o.count !== "") {
    const c = typeof o.count === "string" ? (WORDS[o.count.trim().toLowerCase()] ?? Number(o.count)) : Number(o.count);
    if (!Number.isFinite(c) || c < 0) throw new AthenaInputError("count: how many, as a number");
    count = Math.round(c);
  }
  const [tick] = await ticksOf([habit.id], date, date);
  const now = tick && !tick.hidden ? progressOf(tick, habit.target) : 0;
  const next = count === 0 ? 0 : habit.target ? now + (count ?? 1) : 1;
  const r = (await setHabitDay(habit.id, date, next, today))!;
  const when = date === today ? "today" : date === addDays(today, -1) ? "yesterday" : date;
  const message = r.progress === 0
    ? `Cleared ${habit.name} for ${when}.`
    : habit.target
      ? `${habit.name}: ${progressNote(r.progress, habit.target, habit.unit)} ${when}.${r.done && !isDone(r.previous, habit.target) ? " Done." : ""}`
      : `Ticked ${habit.name} for ${when}.`;
  return { ...r, name: habit.name, message };
}

// ---------- reading them back ----------

/** Days an Athena habit was due and left unticked, with no entry at all (a target part-done has one): for Patterns, which reads entries. */
export async function ownMissedDays(from: string, to: string, today: string): Promise<Array<{ date: string; title: string }>> {
  const out: Array<{ date: string; title: string }> = [];
  for (const x of await ownSummaries(from, to, today)) for (const d of x.days) if (!d.done && !d.note) out.push({ date: d.date, title: x.name });
  return out;
}

export interface OwnHabitDay {
  habit: OwnHabit;
  /** Ticked so far that day (a target's count). */
  progress: number;
  done: boolean;
  /** It belongs on that day's list (lib/habit-rules.ts showsOn). */
  shows: boolean;
  /** Weekly habits: done this week so far. */
  week_done?: number;
  streak: number;
  streak_unit: "day" | "week";
}

/** Every live habit on one day: its count, whether it's due and its streak. For Today, a Day page and the nudge. */
export async function ownHabitsOn(date: string, today: string): Promise<OwnHabitDay[]> {
  const habits = await listOwnHabits();
  if (!habits.length) return [];
  // A streak looks back at most a year and a bit.
  const ticks = await ticksOf(habits.map((h) => h.id), addDays(date, -400), today);
  return habits.map((habit) => {
    const mine = ticks.filter((t) => t.habit_id === habit.id && !t.hidden);
    const done = new Set(mine.filter((t) => t.count > 0).map((t) => t.date));
    const that = mine.find((t) => t.date === date);
    const progress = progressOf(that, habit.target);
    const s = streakOf(habit, done, today, date);
    return {
      habit,
      progress,
      done: isDone(progress, habit.target),
      shows: showsOn(habit, date, done) || progress > 0,
      ...(habit.per_week ? { week_done: doneThisWeek(done, date) } : {}),
      streak: s.streak,
      streak_unit: s.unit,
    };
  });
}

/** Habits still owed today, for the evening nudge (due, not done; a weekly one only when today can't be spared). */
export async function owedToday(today: string): Promise<string[]> {
  const habits = await listOwnHabits();
  if (!habits.length) return [];
  const ticks = await ticksOf(habits.map((h) => h.id), weekStart(today), today);
  return habits
    .filter((h) => needsToday(h, today, new Set(ticks.filter((t) => t.habit_id === h.id && t.count > 0 && !t.hidden).map((t) => t.date))))
    .map((h) => h.name);
}

export interface OwnSummary {
  name: string;
  source: typeof ATHENA_SOURCE;
  days: Array<{ date: string; done: boolean; note?: string }>;
  done: number;
  streak: number;
  longest: number;
  streak_unit: "day" | "week";
  weekdays: Array<number | null>;
  /** The habit itself, for the edit sheet and its words. */
  own: OwnHabit & { schedule: string; progress_today: number; shows_today: boolean; week_done?: number };
}

/** Each habit made in Athena, archived ones too, as the Library's Habits page shows it: missed due days are marked, days it isn't due are left blank. */
export async function ownSummaries(from: string, to: string, today: string): Promise<OwnSummary[]> {
  const habits = await listOwnHabits({ includeArchived: true });
  if (!habits.length) return [];
  // A streak looks back further than the range shown.
  const ticks = await ticksOf(habits.map((h) => h.id), addDays(from, -400), to);
  return habits.map((habit) => {
    const mine = ticks.filter((t) => t.habit_id === habit.id && !t.hidden);
    const byDate = new Map(mine.map((t) => [t.date, t]));
    const done = new Set(mine.filter((t) => t.count > 0).map((t) => t.date));
    const stop = [to, today, habit.archived_at ? habit.archived_at.slice(0, 10) : to].sort()[0];
    const days: OwnSummary["days"] = [];
    for (let d = habit.starts_on > from ? habit.starts_on : from; d <= stop; d = addDays(d, 1)) {
      const t = byDate.get(d);
      if (t) days.push({ date: d, done: t.count > 0, ...(t.note ? { note: t.note } : {}) });
      else if (habit.per_week ? shortWeek(habit, d, done, today) : isDueOn(habit, d) && d < today) days.push({ date: d, done: false });
    }
    const tally = Array.from({ length: 7 }, () => ({ done: 0, all: 0 }));
    for (const d of days) {
      const w = tally[(new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7];
      w.all++;
      if (d.done) w.done++;
    }
    const s = streakOf(habit, done, today, stop);
    const t0 = byDate.get(today);
    const progress_today = progressOf(t0, habit.target);
    return {
      name: habit.name,
      source: ATHENA_SOURCE,
      days,
      done: days.filter((d) => d.done).length,
      streak: habit.archived_at ? 0 : s.streak,
      longest: s.longest,
      streak_unit: s.unit,
      weekdays: tally.map((w) => (w.all ? Math.round((w.done / w.all) * 100) / 100 : null)),
      own: {
        ...habit,
        schedule: scheduleWords(habit),
        progress_today,
        shows_today: !habit.archived_at && (showsOn(habit, today, done) || progress_today > 0),
        ...(habit.per_week ? { week_done: doneThisWeek(done, today) } : {}),
      },
    };
  });
}

/**
 * For Ask ("Did I read every day this week?"): each habit over [from, to],
 * Athena's and other apps', with the days done, missed and, for Athena's,
 * not due. Today not done yet is "open", not missed.
 */
export async function habitDays(from: string, to: string, today: string): Promise<Array<{ name: string; source: string; schedule?: string; target?: string; done: string[]; missed: string[]; not_due?: string[]; open?: string[]; notes?: Record<string, string> }>> {
  const { habitSummaries } = await import("./habits");
  const all = await habitSummaries(from, to, today);
  const own = new Map((await listOwnHabits({ includeArchived: true })).map((h) => [h.name, h]));
  return all.map((x) => {
    const habit = x.source === ATHENA_SOURCE ? own.get(x.name) : undefined;
    const notes = Object.fromEntries(x.days.filter((d) => d.note).map((d) => [d.date, d.note!]));
    const base = { name: x.name, source: x.source, done: x.days.filter((d) => d.done).map((d) => d.date), missed: x.days.filter((d) => !d.done).map((d) => d.date), ...(Object.keys(notes).length ? { notes } : {}) };
    if (!habit) return base;
    const not_due: string[] = [];
    const open: string[] = [];
    for (let d = from; d <= to && d <= today; d = addDays(d, 1)) {
      if (d < habit.starts_on) continue;
      if (!habit.per_week && !isDueOn(habit, d) && !base.done.includes(d)) not_due.push(d);
      if (d === today && !base.done.includes(d) && isDueOn(habit, d)) open.push(d);
    }
    return { ...base, schedule: scheduleWords(habit), ...(habit.target ? { target: progressNote(habit.target, habit.target, habit.unit).replace(/^\d+ of /, "") } : {}), ...(not_due.length ? { not_due } : {}), ...(open.length ? { open } : {}) };
  });
}
