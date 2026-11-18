/**
 * Each week's kept moment (docs/notes/affection-2026-11.md, moment 6): one
 * photo, cover or line the owner picks at the end of the Week in review, which
 * becomes that week's cover in the Days feed and month view.
 *
 * Kept in the settings table (key/JSONB, no migration) under `week_moments`:
 * `{ [monday]: { kind: "photo" | "entry" | "line", ref, date, art? } }`.
 *   - photo: ref is the day photo's file id.
 *   - entry: ref is the day entry's id (a show, album or book with art).
 *   - line:  ref is the day's date; the words stay sealed with the day.
 * `date` is the day it came from. `art` is only the image's id, size and tone,
 * so the cover draws without opening the day. Nothing the owner wrote (titles,
 * lines, places) is copied here: those are sealed where they live. The chosen
 * photo stays in Athena's files and is never shared.
 *
 * Served by GET /api/week-moments and PUT/DELETE /api/week-moments/:monday
 * (netlify/lib/week-moments-routes.ts).
 */
import { addDays, isValidDate } from "./dates";
import { AthenaInputError, q } from "./db";

export const KEY = "week_moments";
export const MOMENT_KINDS = ["photo", "entry", "line"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

export interface MomentArt {
  id: string;
  w: number;
  h: number;
  tone?: string;
}

export interface WeekMoment {
  kind: MomentKind;
  ref: string;
  /** The day it came from, inside the week. */
  date: string;
  art?: MomentArt;
}

export type WeekMoments = Record<string, WeekMoment>;

const REF = /^[A-Za-z0-9:._-]{1,200}$/;
const TONE = /^[a-z0-9#().,%\s/-]{1,64}$/i;

export const isMonday = (date: string) => isValidDate(date) && new Date(`${date}T12:00:00Z`).getUTCDay() === 1;

function readArt(raw: unknown): MomentArt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 20_000 ? Math.round(v) : null);
  const w = size(a.w);
  const h = size(a.h);
  if (typeof a.id !== "string" || !REF.test(a.id) || !w || !h) return undefined;
  return { id: a.id, w, h, ...(typeof a.tone === "string" && TONE.test(a.tone) ? { tone: a.tone } : {}) };
}

/** One moment, checked against its week; throws AthenaInputError with what's wrong. */
export function readMoment(monday: string, raw: unknown): WeekMoment {
  if (!isMonday(monday)) throw new AthenaInputError("The week is its Monday, as YYYY-MM-DD");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError("Send { kind, ref, date }");
  const b = raw as Record<string, unknown>;
  if (typeof b.kind !== "string" || !(MOMENT_KINDS as readonly string[]).includes(b.kind)) throw new AthenaInputError(`kind: one of ${MOMENT_KINDS.join(", ")}`);
  if (typeof b.ref !== "string" || !REF.test(b.ref)) throw new AthenaInputError("ref: the photo, entry or day it points at");
  if (typeof b.date !== "string" || !isValidDate(b.date) || b.date < monday || b.date > addDays(monday, 6)) throw new AthenaInputError("date: a day in that week");
  const kind = b.kind as MomentKind;
  if (kind === "line" && b.ref !== b.date) throw new AthenaInputError("A line's ref is its day");
  const art = kind === "line" ? undefined : readArt(b.art);
  return { kind, ref: b.ref, date: b.date, ...(art ? { art } : {}) };
}

/** What's stored, checked: anything malformed is left out rather than shown. */
export function readMoments(raw: unknown): WeekMoments {
  const out: WeekMoments = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [monday, m] of Object.entries(raw as Record<string, unknown>)) {
    try {
      out[monday] = readMoment(monday, m);
    } catch {
      // A bad row is skipped; the week just has no cover.
    }
  }
  return out;
}

export async function loadWeekMoments(): Promise<WeekMoments> {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
  return readMoments(row?.value);
}

/** Keep (or change) a week's moment. One week's write never touches another's. */
export async function keepWeekMoment(monday: string, raw: unknown): Promise<WeekMoment> {
  const moment = readMoment(monday, raw);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
     ON CONFLICT (key) DO UPDATE SET value = (CASE WHEN jsonb_typeof(settings.value) = 'object' THEN settings.value ELSE '{}'::jsonb END) || EXCLUDED.value, updated_at = now()`,
    [KEY, monday, JSON.stringify(moment)],
  );
  return moment;
}

/** Let a week go back to no moment (Undo, or a change of mind). */
export async function clearWeekMoment(monday: string): Promise<void> {
  if (!isMonday(monday)) throw new AthenaInputError("The week is its Monday, as YYYY-MM-DD");
  await q(`UPDATE settings SET value = value - $2::text, updated_at = now() WHERE key = $1 AND jsonb_typeof(value) = 'object'`, [KEY, monday]);
}
