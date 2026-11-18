/**
 * The owner's Days choices that should look the same on every device:
 *  - the mood style (Moons, Levels or Faces), kept in the settings table
 *    under `days_mood_style` and served by GET/PUT /api/settings;
 *  - memories on Home: on or off, and the days hidden from them
 *    (`days_memories`, GET/PATCH /api/days/memories).
 * The app keeps a copy of each in localStorage so the first paint doesn't wait.
 */
import { AthenaInputError, q } from "./db";
import type { MemoryPrefs } from "./memory-types";

export const MOOD_STYLES = ["moons", "levels", "faces"] as const;
export type MoodStyle = (typeof MOOD_STYLES)[number];
export const DEFAULT_MOOD_STYLE: MoodStyle = "moons";
const KEY = "days_mood_style";

export const isMoodStyle = (v: unknown): v is MoodStyle => typeof v === "string" && (MOOD_STYLES as readonly string[]).includes(v);

/** What's stored, checked: anything else is the default. */
export const readMoodStyle = (raw: unknown): MoodStyle => (isMoodStyle(raw) ? raw : DEFAULT_MOOD_STYLE);

export async function loadMoodStyle(): Promise<MoodStyle> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [KEY]);
    return readMoodStyle(row?.value);
  } catch {
    return DEFAULT_MOOD_STYLE;
  }
}

export async function saveMoodStyle(style: unknown): Promise<MoodStyle> {
  if (!isMoodStyle(style)) throw new AthenaInputError(`mood_style: one of ${MOOD_STYLES.join(", ")}`);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(style)],
  );
  return style;
}

// ---------- Memories on Home ----------
// One row, `days_memories`: { on, hidden }. On by default. `hidden` is the
// days the owner said "Not this one" to: they never come back as a memory.
// Served by GET/PATCH /api/days/memories (netlify/lib/days/routes.ts).

export type { MemoryPrefs };
export const DEFAULT_MEMORY_PREFS: MemoryPrefs = { on: true, hidden: [] };
export const MAX_HIDDEN_MEMORIES = 1000;
const MEMORIES_KEY = "days_memories";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What's stored, checked: anything unreadable is the default. */
export function readMemoryPrefs(raw: unknown): MemoryPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEMORY_PREFS, hidden: [] };
  const o = raw as { on?: unknown; hidden?: unknown };
  const hidden = Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((d): d is string => typeof d === "string" && DATE.test(d)))].sort().slice(-MAX_HIDDEN_MEMORIES) : [];
  return { on: o.on !== false, hidden };
}

/** A change: turn memories on or off, hide a day, or bring one back. */
export interface MemoryPrefsPatch {
  on?: boolean;
  hide?: string;
  show?: string;
}

export function applyMemoryPatch(prefs: MemoryPrefs, patch: unknown): MemoryPrefs {
  if (!patch || typeof patch !== "object") throw new AthenaInputError("Send { on }, { hide } or { show }");
  const p = patch as { on?: unknown; hide?: unknown; show?: unknown };
  if (p.on === undefined && p.hide === undefined && p.show === undefined) throw new AthenaInputError("Send { on }, { hide } or { show }");
  if (p.on !== undefined && typeof p.on !== "boolean") throw new AthenaInputError("on: true or false");
  for (const k of ["hide", "show"] as const) if (p[k] !== undefined && !(typeof p[k] === "string" && DATE.test(p[k] as string))) throw new AthenaInputError(`${k}: a date, YYYY-MM-DD`);
  let hidden = prefs.hidden.filter((d) => d !== p.show);
  if (typeof p.hide === "string" && !hidden.includes(p.hide)) hidden = [...hidden, p.hide].sort().slice(-MAX_HIDDEN_MEMORIES);
  return { on: typeof p.on === "boolean" ? p.on : prefs.on, hidden };
}

export async function loadMemoryPrefs(): Promise<MemoryPrefs> {
  try {
    const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [MEMORIES_KEY]);
    return readMemoryPrefs(row?.value);
  } catch {
    return { ...DEFAULT_MEMORY_PREFS, hidden: [] };
  }
}

export async function saveMemoryPrefs(patch: unknown): Promise<MemoryPrefs> {
  const next = applyMemoryPatch(await loadMemoryPrefs(), patch);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MEMORIES_KEY, JSON.stringify(next)],
  );
  return next;
}
