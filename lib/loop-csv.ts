/**
 * Loop Habit Tracker's export (Settings → Export as CSV: a zip with
 * Habits.csv, a Checkmarks.csv for every habit at the top, and one folder per
 * habit, "001 Meditate/Checkmarks.csv" with Date,Value), turned into habit
 * days. Shared by the app and the server: no Node or DOM imports, no value
 * imports but the CSV reader.
 *
 * Values (as the spec maps them): 2 is done. 0 (not done), 1 (covered by
 * the habit's frequency) and 3 (Loop's own "skip this day" mark) are
 * skipped. -1 (no answer yet) adds nothing. A measurable habit stores the
 * amount times 1000, so anything over 3 is an amount: done, with the amount
 * as its note.
 *
 * The habit folders win when the zip has them; otherwise the wide
 * Checkmarks.csv (Date, then a column per habit) does, which is also what the
 * owner may pick on its own.
 */
import { parseCsv } from "./netflix-csv";

/** One habit on one day. `done: false` is a day the owner marked as skipped. */
export interface HabitMark {
  name: string;
  done: boolean;
  /** "skipped", "3 km", "2 of 3". */
  note?: string;
}

export interface HabitDay {
  day: string;
  habits: HabitMark[];
}

export interface HabitParse {
  /** Oldest first. */
  days: HabitDay[];
  /** Every habit with at least one tick or skip, A to Z. */
  habits: string[];
  /** Ticks and skips. */
  marks: number;
  skipped: { undated: number; future: number };
}

export class ImportFileError extends Error {
  constructor(public readonly reason: "unreadable" | "empty") {
    super(reason);
  }
}

/** A habit's or activity's name: one line, no "·" (the Day's separator), capped. */
export const habitName = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, 120);

/** A habit's key for ids: case and spacing ignored. */
export const habitKey = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "habit";

/** YYYY-MM-DD, a real date from 2000 on; null otherwise. */
export function isoDay(raw: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "3", "2.5": an amount as Loop shows it. */
const amount = (v: number) => String(Math.round(v / 10) / 100);

/** One Checkmarks value as a mark; null when it adds nothing. */
export function loopMark(name: string, raw: string, unit = ""): HabitMark | null {
  const v = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(v)) return null;
  if (v === 2) return { name, done: true };
  if (v === 0 || v === 1 || v === 3) return { name, done: false, note: "skipped" };
  if (v > 3) return { name, done: true, note: `${amount(v)}${unit ? ` ${unit}` : ""}` };
  return null;
}

/** "001 Meditate/Checkmarks.csv" → "Meditate"; null for any other file. */
function folderHabit(path: string): string | null {
  const m = /(?:^|\/)([^/]+)\/Checkmarks\.csv$/i.exec(path);
  return m ? habitName(m[1].replace(/^\d{1,4}\s+/, "")) || null : null;
}

/** Habits.csv's units for measurable habits, by name. */
function units(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const ni = head.indexOf("name");
  const ui = head.indexOf("unit");
  if (ni < 0 || ui < 0) return out;
  for (const r of rows.slice(1)) if (r[ni]?.trim() && r[ui]?.trim()) out.set(habitName(r[ni]), habitName(r[ui]).slice(0, 20));
  return out;
}

/**
 * The export, read: every file from the zip (or the one CSV chosen) by its
 * path. `today` drops anything later.
 */
export function parseLoopExport(files: Array<{ name: string; text: string }>, opts: { today?: string } = {}): HabitParse {
  // The top-level Habits.csv: the shallowest one.
  const habitsCsv = files.filter((f) => /(?:^|\/)Habits\.csv$/i.test(f.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0]?.text;
  const unitOf = units(habitsCsv);
  const per = new Map<string, Map<string, HabitMark>>();
  const skipped = { undated: 0, future: 0 };
  const add = (rawDay: string, mark: HabitMark | null) => {
    const day = isoDay(rawDay);
    if (!day) {
      if (rawDay.trim()) skipped.undated++;
      return;
    }
    if (!mark) return;
    if (opts.today && day > opts.today) {
      skipped.future++;
      return;
    }
    const m = per.get(day) ?? per.set(day, new Map()).get(day)!;
    m.set(habitKey(mark.name), mark);
  };

  const folders = files.map((f) => ({ f, habit: folderHabit(f.name) })).filter((x): x is { f: { name: string; text: string }; habit: string } => !!x.habit);
  let read = false;
  if (folders.length) {
    for (const { f, habit } of folders) {
      const rows = parseCsv(f.text);
      // Loop writes no header here ("2024-03-14,2"); one with a header is read too.
      for (const r of rows) {
        if (r.length < 2 || /^date$/i.test(r[0].trim())) continue;
        read = true;
        add(r[0], loopMark(habit, r[1], unitOf.get(habit)));
      }
    }
  } else {
    const wide = files.find((f) => /(?:^|\/)Checkmarks\.csv$/i.test(f.name)) ?? (files.length === 1 ? files[0] : undefined);
    if (!wide) throw new ImportFileError("unreadable");
    const rows = parseCsv(wide.text);
    const head = rows[0] ?? [];
    if (!/^date$/i.test(head[0]?.trim() ?? "")) throw new ImportFileError("unreadable");
    const names = head.slice(1).map((n) => habitName(n));
    if (!names.some(Boolean)) throw new ImportFileError("unreadable");
    for (const r of rows.slice(1)) {
      read = true;
      names.forEach((name, i) => name && add(r[0] ?? "", loopMark(name, r[i + 1] ?? "", unitOf.get(name))));
    }
  }
  if (!read) throw new ImportFileError("empty");
  const days = [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, m]) => ({ day, habits: [...m.values()] }));
  return { days, ...habitStats(days), skipped };
}

/** Habit names (A to Z) and ticks plus skips, over these days. */
export function habitStats(days: HabitDay[]): { habits: string[]; marks: number } {
  const names = new Map<string, string>();
  let marks = 0;
  for (const d of days)
    for (const h of d.habits) {
      marks++;
      if (!names.has(habitKey(h.name))) names.set(habitKey(h.name), h.name);
    }
  return { habits: [...names.values()].sort((a, b) => a.localeCompare(b)), marks };
}

/** Whole days per request: at most `maxDays` and `maxItems` marks (or whatever `size` counts). */
export function batchDays<D extends { day: string }>(days: D[], size: (d: D) => number, maxDays = 90, maxItems = 400): D[][] {
  const out: D[][] = [];
  let cur: D[] = [];
  let items = 0;
  for (const d of days) {
    const n = Math.max(1, size(d));
    if (cur.length && (cur.length >= maxDays || items + n > maxItems)) {
      out.push(cur);
      cur = [];
      items = 0;
    }
    cur.push(d);
    items += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
