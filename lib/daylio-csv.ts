/**
 * Daylio's CSV export (More → Export entries → CSV), turned into days: a
 * mood, the activities as habits done, and the notes as journal text.
 * Shared by the app and the server (no Node or DOM imports).
 *
 * Headers seen: `full_date,date,weekday,time,mood,activities,note_title,note`
 * (current), the same without `note_title` (before titles), and
 * `year,date,weekday,time,mood,activities,note` (old, "March 14"). Activities
 * are joined by " | ". Moods are the default five (rad 5, good 4, meh 3,
 * bad 2, awful 1) in English; a renamed or extra mood isn't guessed: it's
 * counted and left out. Several entries on a day give the day their rounded
 * average, and their notes in time order.
 *
 * On the server, a mood fills a day only when the owner hasn't set one
 * (Athena's own mood always wins), and the notes go under "From Daylio" at
 * the end of the day's journal, once.
 */
import { parseCsv } from "./netflix-csv";
import { habitKey, habitName, habitStats, ImportFileError, isoDay, type HabitDay } from "./loop-csv";

export type Mood = 1 | 2 | 3 | 4 | 5;

/** A day from a mood app: habits, and maybe a mood and journal text. */
export interface MoodDay extends HabitDay {
  mood?: Mood;
  /** Plain text, paragraphs split by a blank line. */
  journal?: string;
}

export interface MoodParse {
  days: MoodDay[];
  habits: string[];
  marks: number;
  /** Days with a mood. */
  moods: number;
  /** Days with notes. */
  journals: number;
  /** Rows read. */
  rows: number;
  skipped: { undated: number; future: number; unknown_moods: string[] };
}

export const DAYLIO_MOODS: Record<string, Mood> = { rad: 5, good: 4, meh: 3, bad: 2, awful: 1 };

/** The heading the notes go under in the journal. */
export const DAYLIO_HEADING = "From Daylio";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "March 14" or "14 March", with the year column. */
function oldDate(year: string, raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const m = /^([a-z]+)\.?\s+(\d{1,2})$/.exec(s) ?? /^(\d{1,2})\s+([a-z]+)\.?$/.exec(s);
  if (!m) return null;
  const [mon, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const mi = MONTHS.indexOf(mon.slice(0, 3));
  if (mi < 0 || !/^\d{4}$/.test(year.trim())) return null;
  return isoDay(`${year.trim()}-${mi + 1}-${day}`);
}

/** "21:40", "9:40 pm" → "21:40"; "" when unreadable. */
export function clock(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(raw.trim());
  if (!m) return "";
  let hh = Number(m[1]);
  if (m[3]) hh = (hh % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  return hh > 23 || Number(m[2]) > 59 ? "" : `${String(hh).padStart(2, "0")}:${m[2]}`;
}

/** A note as plain text: Daylio's <br> as line breaks, tags and entities out. */
export function plainNote(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

/** The rounded average of a day's moods. */
export const dayMood = (moods: number[]): Mood | undefined => (moods.length ? (Math.min(5, Math.max(1, Math.round(moods.reduce((a, b) => a + b, 0) / moods.length))) as Mood) : undefined);

interface Row {
  day: string;
  time: string;
  mood?: number;
  habits: string[];
  note?: string;
}

/** Rows to days: habits once each, moods averaged, notes in time order as "21:40 · Title" paragraphs. */
export function rowsToDays(rows: Row[]): MoodDay[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) (by.get(r.day) ?? by.set(r.day, []).get(r.day)!).push(r);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rs]) => {
      rs.sort((a, b) => a.time.localeCompare(b.time));
      const habits = new Map<string, string>();
      for (const r of rs) for (const h of r.habits) if (!habits.has(habitKey(h))) habits.set(habitKey(h), h);
      const mood = dayMood(rs.map((r) => r.mood).filter((m): m is number => m !== undefined));
      const journal = rs
        .filter((r) => r.note)
        .map((r) => r.note!)
        .join("\n\n");
      return { day, habits: [...habits.values()].map((name) => ({ name, done: true })), ...(mood ? { mood } : {}), ...(journal ? { journal } : {}) };
    });
}

export function moodStats(days: MoodDay[]): Pick<MoodParse, "habits" | "marks" | "moods" | "journals"> {
  return { ...habitStats(days), moods: days.filter((d) => d.mood).length, journals: days.filter((d) => d.journal).length };
}

export function parseDaylio(text: string, opts: { today?: string } = {}): MoodParse {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (n: string) => head.indexOf(n);
  const [fi, yi, di, ti, mi, ai, nti, ni] = ["full_date", "year", "date", "time", "mood", "activities", "note_title", "note"].map(col);
  if (mi < 0 || (fi < 0 && (yi < 0 || di < 0))) throw new ImportFileError("unreadable");
  const body = rows.slice(1);
  if (!body.length) throw new ImportFileError("empty");
  const skipped = { undated: 0, future: 0, unknown_moods: [] as string[] };
  const unknown = new Set<string>();
  const out: Row[] = [];
  for (const r of body) {
    const day = fi >= 0 ? isoDay(r[fi] ?? "") : oldDate(r[yi] ?? "", r[di] ?? "");
    if (!day) {
      skipped.undated++;
      continue;
    }
    if (opts.today && day > opts.today) {
      skipped.future++;
      continue;
    }
    const label = (r[mi] ?? "").trim();
    const mood = DAYLIO_MOODS[label.toLowerCase()];
    if (label && !mood) unknown.add(label.slice(0, 40));
    const habits = ai >= 0 ? (r[ai] ?? "").split("|").map(habitName).filter(Boolean) : [];
    const time = ti >= 0 ? clock(r[ti] ?? "") : "";
    const title = nti >= 0 ? plainNote(r[nti] ?? "").replace(/\s+/g, " ") : "";
    const note = ni >= 0 ? plainNote(r[ni] ?? "") : "";
    // "21:40 · A good walk" over the note; a title alone is the whole paragraph.
    const top = [time, title].filter(Boolean).join(" · ");
    const text_ = note ? (top ? `${top}\n${note}` : note) : title ? top : "";
    out.push({ day, time, ...(mood ? { mood } : {}), habits, ...(text_ ? { note: text_ } : {}) });
  }
  skipped.unknown_moods = [...unknown];
  const days = rowsToDays(out);
  return { days, ...moodStats(days), rows: out.length, skipped };
}
