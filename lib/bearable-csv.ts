/**
 * Bearable's CSV export (Settings → Export data, free on every plan), turned
 * into days. Shared by the app and the server (no Node or DOM imports).
 *
 * One row per thing logged: a date, the time of day, a category, a rating or
 * amount, a detail and notes. Columns are found by name, so a reordered or
 * extended file still reads. What Athena takes:
 *  - Mood → the day's mood (1–5). A file that rates mood out of 10 is halved,
 *    rounded up. Several on a day are averaged.
 *  - Energy → the day's energy, 1–5: from the detail's word (v. low, low,
 *    ok, high, v. high), else the rating the same way as mood.
 *  - Symptoms → name and severity: "Headache (Moderate)" in the detail, the
 *    severity (1–4) in the rating, else from the word in brackets (Mild 1,
 *    Moderate 2, Severe 3, Unbearable or Extreme 4). Health, so the server
 *    seals them with the day's health figures (sensitive_blobs, source
 *    bearable), never in Days.
 *  - Factors (and habits) → habits done, by name ("Caffeine", "Walk").
 * Everything else (sleep, nutrition, meds, measurements, gratitude) is left
 * out. Checked against two public parsers of real exports (coornail.net's
 * analysis, abocha/streamlit_bearable_dashboard); the factor category's
 * exact name isn't in either, so "Factors" and "Habits" are both read.
 * Several values in one cell are split on "|".
 */
import { parseCsv } from "./netflix-csv";
import { habitKey, habitName, ImportFileError, isoDay } from "./loop-csv";
import { dayMood, moodStats, type MoodDay } from "./daylio-csv";

export interface Symptom {
  name: string;
  /** 1 mild to 4 unbearable, as Bearable rates it. */
  severity?: number;
}

export interface BearableDay extends MoodDay {
  /** 1–5. */
  energy?: number;
  symptoms?: Symptom[];
}

export interface BearableParse {
  days: BearableDay[];
  habits: string[];
  marks: number;
  moods: number;
  journals: number;
  /** Days with symptoms or energy (sealed with health). */
  health_days: number;
  rows: number;
  skipped: { undated: number; future: number };
}

const num = (raw: string | undefined): number | undefined => {
  const m = /-?\d+(?:\.\d+)?/.exec(raw ?? "");
  return m ? Number(m[0]) : undefined;
};

/** A date in any of the file's date columns: ISO, or day first with slashes. */
function readDay(r: string[], cols: number[]): string | null {
  for (const i of cols) {
    const raw = (r[i] ?? "").trim();
    const iso = isoDay(raw);
    if (iso) return iso;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
    if (m) return isoDay(`${m[3]}-${m[2]}-${m[1]}`);
  }
  return null;
}

const split = (raw: string | undefined) => (raw ?? "").split("|").map(habitName).filter(Boolean);

const ENERGY_WORDS: Record<string, number> = { "v. low": 1, "very low": 1, low: 2, ok: 3, high: 4, "v. high": 5, "very high": 5 };
const SEVERITY_WORDS: Record<string, number> = { mild: 1, moderate: 2, severe: 3, unbearable: 4, extreme: 4 };
const SEVERITY = /\s*\((mild|moderate|severe|unbearable|extreme)\)\s*$/i;

export function parseBearable(text: string, opts: { today?: string } = {}): BearableParse {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const dateCols = head.map((h, i) => (/^date( formatted)?$|^day$/.test(h) ? i : -1)).filter((i) => i >= 0);
  const ci = head.indexOf("category");
  const vi = head.findIndex((h) => /^(rating\/amount|rating|amount|value)$/.test(h));
  const di = head.findIndex((h) => /^(detail|details|name)$/.test(h));
  if (!dateCols.length || ci < 0 || (vi < 0 && di < 0)) throw new ImportFileError("unreadable");
  const body = rows.slice(1);
  if (!body.length) throw new ImportFileError("empty");
  const skipped = { undated: 0, future: 0 };
  interface Acc {
    moods: number[];
    energy: number[];
    habits: Map<string, string>;
    symptoms: Map<string, Symptom>;
  }
  const by = new Map<string, Acc>();
  let read = 0;
  let outOf10 = false;
  for (const r of body) {
    const cat = (r[ci] ?? "").trim().toLowerCase();
    const isMood = /^mood/.test(cat);
    const isEnergy = /^energy/.test(cat);
    if (isMood && (num(r[vi]) ?? 0) > 5) outOf10 = true;
    if (isEnergy && !ENERGY_WORDS[(r[di] ?? "").trim().toLowerCase()] && (num(r[vi]) ?? 0) > 5) outOf10 = true;
  }
  for (const r of body) {
    const day = readDay(r, dateCols);
    if (!day) {
      skipped.undated++;
      continue;
    }
    if (opts.today && day > opts.today) {
      skipped.future++;
      continue;
    }
    const cat = (r[ci] ?? "").trim().toLowerCase();
    const a = by.get(day) ?? by.set(day, { moods: [], energy: [], habits: new Map(), symptoms: new Map() }).get(day)!;
    const v = vi >= 0 ? num(r[vi]) : undefined;
    const scaled = v === undefined ? undefined : outOf10 ? Math.ceil(v / 2) : v;
    read++;
    if (/^mood/.test(cat)) {
      if (scaled !== undefined && scaled >= 1) a.moods.push(Math.min(5, scaled));
    } else if (/^energy/.test(cat)) {
      const word = ENERGY_WORDS[(r[di] ?? "").trim().toLowerCase()];
      if (word) a.energy.push(word);
      else if (scaled !== undefined && scaled >= 1) a.energy.push(Math.min(5, scaled));
    } else if (/^symptom/.test(cat)) {
      for (const raw of (r[di] ?? "").split("|")) {
        const word = SEVERITY.exec(raw)?.[1]?.toLowerCase();
        const name = habitName(raw.replace(SEVERITY, ""));
        if (!name) continue;
        const severity = v !== undefined && v >= 0 ? Math.min(4, Math.round(v)) : word ? SEVERITY_WORDS[word] : undefined;
        a.symptoms.set(habitKey(name), { name, ...(severity !== undefined ? { severity } : {}) });
      }
    } else if (/^(factor|habit)/.test(cat)) {
      for (const name of split(r[di])) a.habits.set(habitKey(name), name);
    } else read--;
  }
  if (!read) throw new ImportFileError("empty");
  const days: BearableDay[] = [...by.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, a]) => {
      const mood = dayMood(a.moods);
      const energy = dayMood(a.energy);
      return {
        day,
        habits: [...a.habits.values()].map((name) => ({ name, done: true })),
        ...(mood ? { mood } : {}),
        ...(energy ? { energy } : {}),
        ...(a.symptoms.size ? { symptoms: [...a.symptoms.values()] } : {}),
      };
    })
    .filter((d) => d.habits.length || d.mood || d.energy || d.symptoms);
  return { days, ...moodStats(days), health_days: days.filter((d) => d.energy || d.symptoms).length, rows: read, skipped };
}
