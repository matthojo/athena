/**
 * Plays per hour on a folded Days entry (migration 0062): 24 counts, the
 * owner's local hours 0-23, beside the entry's `count`. Kept for listened
 * entries whose source gives each play's time (Last.fm, ListenBrainz, the
 * Life log run reading them), so Music can say when the owner listens.
 * Stored sealed as JSON text like the entry's other words (lib/days.ts).
 * Pure.
 */

export const HOURS = 24;

/** 24 whole counts with at least one play, or undefined for anything else. */
export function readHours(raw: unknown): number[] | undefined {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(v) || v.length !== HOURS) return undefined;
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) return undefined;
    out.push(n);
  }
  return out.some((n) => n > 0) ? out : undefined;
}

/** The hour of a local "HH:MM" (or "HH:MM:SS"), or undefined. */
export function hourOf(time: unknown): number | undefined {
  if (typeof time !== "string") return undefined;
  const m = /^(\d{1,2}):\d{2}/.exec(time.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  return h >= 0 && h < HOURS ? h : undefined;
}

export const emptyHours = (): number[] => new Array<number>(HOURS).fill(0);

/** One more play at `hour` (no-op when the hour is unknown). */
export function addPlay(hours: number[], hour: number | undefined): number[] {
  if (hour !== undefined) hours[hour]++;
  return hours;
}

export const sameHours = (a: number[] | undefined | null, b: number[] | undefined | null) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Fold timed plays into one entry's hours: for any music writer (the history
 * loads, the hourly sync on claude/media-sync, file imports). Each play is a
 * local "HH:MM" or an instant (Date, ISO string, epoch ms) read in `tz`.
 * Undefined when no play has a usable time.
 */
export function foldHours(plays: Array<string | number | Date | null | undefined>, tz?: string): number[] | undefined {
  const hours = emptyHours();
  let any = false;
  for (const p of plays) {
    const h = playHour(p, tz);
    if (h === undefined) continue;
    hours[h]++;
    any = true;
  }
  return any ? hours : undefined;
}

/** The local hour of one play: "HH:MM" as given, or an instant in `tz` (UTC without one). */
export function playHour(p: string | number | Date | null | undefined, tz?: string): number | undefined {
  if (p === null || p === undefined) return undefined;
  if (typeof p === "string" && /^\d{1,2}:\d{2}/.test(p.trim())) return hourOf(p);
  const t = p instanceof Date ? p.getTime() : typeof p === "number" ? p : Date.parse(p);
  if (!Number.isFinite(t)) return undefined;
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz ?? "UTC" }).format(new Date(t));
  const h = Number(hour);
  return h >= 0 && h < HOURS ? h : undefined;
}
