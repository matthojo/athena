/**
 * TfL journey history (an Oyster or contactless account on tfl.gov.uk →
 * Journey history → Download as CSV, or the weekly statement email's
 * attachment), turned into days of journeys. Shared by the app and the
 * server (no Node or DOM imports).
 *
 * Columns: Date, Start Time, End Time, Journey/Action, Charge, Credit,
 * Balance, Note (found by name). "Highbury & Islington to Old Street" is a
 * journey; "Bus journey, route 73" a bus; top-ups, refunds and season tickets
 * aren't journeys and are left out. Line names in brackets
 * ("[London Overground]") are dropped from the stations. Charges, credit and
 * balance are never read: money lives elsewhere.
 */
import { parseCsv } from "./netflix-csv";
import { ImportFileError, isoDay } from "./loop-csv";
import { clock } from "./daylio-csv";

export interface Journey {
  /** "Highbury & Islington → Old Street", "Bus 73". */
  title: string;
  /** HH:MM, when the source says. */
  start?: string;
  end?: string;
  minutes?: number;
  bus?: boolean;
  /** "no touch-out". */
  note?: string;
}

export interface JourneyDay {
  day: string;
  journeys: Journey[];
}

export interface JourneyParse {
  days: JourneyDay[];
  journeys: number;
  minutes: number;
  /** Stations and buses most often, at most five, busiest first. */
  top: string[];
  skipped: { undated: number; future: number; other: number };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "14-Mar-2024", "14/03/2024", "2024-03-14". */
export function tflDate(raw: string): string | null {
  const s = raw.trim();
  const iso = isoDay(s);
  if (iso) return iso;
  let m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s](\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    return mi < 0 ? null : isoDay(`${m[3]}-${mi + 1}-${m[1]}`);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? isoDay(`${m[3]}-${m[2]}-${m[1]}`) : null;
}

const station = (s: string) =>
  s
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\((?:[^)]*line[^)]*|platforms? [^)]*)\)/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s*·\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** One Journey/Action cell as a journey; null for a top-up, refund or anything else. */
export function readJourney(raw: string): Omit<Journey, "start" | "end" | "minutes"> | null {
  const s = raw.replace(/\s+/g, " ").trim();
  const bus = /^bus journey,?\s*route\s+([\w-]{1,6})/i.exec(s);
  if (bus) return { title: `Bus ${bus[1].toUpperCase()}`, bus: true };
  const noOut = /\[no touch-out\]/i.test(s);
  const noIn = /\[no touch-in\]/i.test(s);
  const same = /^entered and exited (.+)$/i.exec(s);
  if (same) {
    const at = station(same[1]);
    return at ? { title: at, note: "entered and exited" } : null;
  }
  const m = /^(.+?) to (.+)$/i.exec(s);
  if (!m || /top[- ]?up|refund|season ticket|travelcard|incomplete journey|payment/i.test(s)) return null;
  const from = noIn ? "" : station(m[1]);
  const to = noOut ? "" : station(m[2]);
  if (!from && !to) return null;
  return {
    title: from && to ? `${from} → ${to}` : from ? `From ${from}` : `To ${to}`,
    ...(noOut ? { note: "no touch-out" } : noIn ? { note: "no touch-in" } : {}),
  };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function parseTfl(text: string, opts: { today?: string } = {}): JourneyParse {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const di = head.indexOf("date");
  const si = head.findIndex((h) => /^start( time)?$/.test(h));
  const ei = head.findIndex((h) => /^end( time)?$/.test(h));
  const ji = head.findIndex((h) => /^journey/.test(h));
  if (di < 0 || ji < 0) throw new ImportFileError("unreadable");
  const body = rows.slice(1);
  if (!body.length) throw new ImportFileError("empty");
  const skipped = { undated: 0, future: 0, other: 0 };
  const by = new Map<string, Journey[]>();
  const seen = new Map<string, number>();
  for (const r of body) {
    const j = readJourney(r[ji] ?? "");
    if (!j) {
      skipped.other++;
      continue;
    }
    const day = tflDate(r[di] ?? "");
    if (!day) {
      skipped.undated++;
      continue;
    }
    if (opts.today && day > opts.today) {
      skipped.future++;
      continue;
    }
    const start = si >= 0 ? clock(r[si] ?? "") : "";
    const end = ei >= 0 ? clock(r[ei] ?? "") : "";
    let minutes: number | undefined;
    if (start && end) {
      const d = (toMin(end) - toMin(start) + 1440) % 1440;
      if (d > 0 && d <= 240) minutes = d;
    }
    const list = by.get(day) ?? by.set(day, []).get(day)!;
    list.push({ ...j, ...(start ? { start } : {}), ...(end ? { end } : {}), ...(minutes ? { minutes } : {}) });
    for (const part of j.title.split(" → ")) {
      const k = part.replace(/^(From|To) /, "");
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  const days = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, js]) => ({ day, journeys: js.sort((a, b) => (a.start ?? "99").localeCompare(b.start ?? "99")) }));
  const journeys = days.reduce((n, d) => n + d.journeys.length, 0);
  if (!journeys && !skipped.undated) throw new ImportFileError("empty");
  return {
    days,
    journeys,
    minutes: days.reduce((n, d) => n + d.journeys.reduce((k, j) => k + (j.minutes ?? 0), 0), 0),
    top: [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([s]) => s),
    skipped,
  };
}
