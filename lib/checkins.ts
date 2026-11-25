/**
 * Check-ins: the store behind the routes (netlify/lib/checkins/routes.ts), the MCP tools
 * (netlify/lib/mcp/checkins.ts) and the nudges (loadCheckin). The contract and the owner's
 * decisions are lib/checkin-types.ts; the daily pick is lib/checkin-plan.ts.
 *
 * Storage (migration 0075). One `checkins` row per (date, kind): the day's plan (its questions as
 * they were when it was made) and the answers, sealed together under the data key like a health
 * day, so nothing is written or read without the key. status and done_at stay readable for
 * calendars and streaks. The settings are the plain settings row 'checkins': the routines and
 * the owner's own questions (presets are never stored).
 *
 * The plan is made the first time a day's check-in is read (getCheckin) and kept: a settings
 * change shows from the next day without one. Questions last asked in the HISTORY_DAYS before
 * take their turns (lib/checkin-plan.ts).
 *
 * Mirrors (CheckinMirror). An answer is copied out when it's saved and taken back out when it's
 * deleted. Each mirror is worked out again from the day's two check-ins, so saving twice changes
 * nothing and deleting one answer leaves the other check-in's:
 *  - day_mood: the latest mood answer of the day is the day's mood. With none left, the mood the
 *    check-in replaced comes back, unless the owner set one since (lib/days.ts mirrorCheckinDay).
 *  - day_journal: each check-in keeps one section in the day's journal, its heading
 *    (CHECKIN_HEADINGS) then prompt and answer pairs. Only that section is rewritten; the owner's
 *    text is never touched (lib/days.ts swapJournalSection).
 *  - health_energy, health_stress, health_mood_labels: the latest of each goes to Health under
 *    source "athena_checkin" (lib/health.ts setCheckinHealthDay); none left takes it out.
 *  - briefing: read by the briefing, not copied.
 */
import { addDays, daysBetween, zonedToday } from "./dates";
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { AthenaInputError, getOwnerTimeZone, qRaw } from "./db";
import { mirrorCheckinDay, readDate, type Mood } from "./days";
import { setCheckinHealthDay } from "./health";
import { askedHistory, planFor } from "./checkin-plan";
import { askDeeper } from "./checkin-deeper";
import { trendsOf, type TrendRow } from "./checkin-trends";
import type { Anthropic } from "./ai";
import {
  CHECKIN_KINDS,
  DEFAULT_CHECKIN_SETTINGS,
  MAX_ANSWER_CHARS,
  MAX_OWN_QUESTIONS,
  MAX_PER_DAY,
  MAX_TRENDS_DAYS,
  PRESET_QUESTIONS,
  type Checkin,
  type CheckinAnswer,
  type CheckinKind,
  type CheckinMirror,
  type CheckinQuestion,
  type CheckinSettings,
  type CheckinSettingsView,
  type CheckinSummary,
  type CheckinTrends,
  type CheckinValue,
  type DeeperReply,
  type QuestionType,
  type RoutineSettings,
} from "./checkin-types";

export const SETTINGS_KEY = "checkins";
/** The journal section's heading for each check-in. */
export const CHECKIN_HEADINGS: Record<CheckinKind, string> = { morning: "Morning preparation", evening: "Evening reflection" };
/** How far back earlier plans count for whose turn it is. */
export const HISTORY_DAYS = 60;
/** The longest range GET /api/checkins answers, in days. */
export const MAX_RANGE_DAYS = 400;
const MAX_DEEPER_QUESTION_CHARS = 300;

/** What's sealed in a row. `journal`: the section last written to the day's journal. */
interface Stored {
  plan: CheckinQuestion[];
  answers: Record<string, CheckinAnswer>;
  journal?: string;
}

interface Row {
  date: string;
  kind: CheckinKind;
  sealed: string;
  status: "open" | "done";
  done_at: string | null;
}

const isKind = (v: unknown): v is CheckinKind => typeof v === "string" && (CHECKIN_KINDS as readonly string[]).includes(v);

export function readKind(v: unknown): CheckinKind {
  if (!isKind(v)) throw new AthenaInputError(`kind: ${CHECKIN_KINDS.join(" or ")}`, 404);
  return v;
}

// ---------- Settings ----------

const TYPES: QuestionType[] = ["scale", "choices", "areas", "text"];
/** The mirrors an own question may have, by type. */
const MIRRORS: Record<QuestionType, CheckinMirror[]> = {
  scale: [null, "day_mood", "health_energy", "health_stress"],
  choices: [null, "health_mood_labels"],
  areas: [null, "briefing"],
  text: [null, "day_journal", "briefing"],
};
const OWN_FIELDS = ["id", "type", "prompt", "kinds", "low", "high", "lead", "levels", "options", "more", "placeholder", "deeper", "mirror", "preset"];
const OWN_ID = /^own_[A-Za-z0-9_-]{1,40}$/;

const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

function words(v: unknown, what: string, max: number, opts: { required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new AthenaInputError(`${what}: some words`);
    return undefined;
  }
  if (typeof v !== "string") throw new AthenaInputError(`${what}: some words`);
  const s = oneLine(v);
  if (!s && opts.required) throw new AthenaInputError(`${what}: some words`);
  if (s.length > max) throw new AthenaInputError(`${what}: at most ${max} characters`);
  return s || undefined;
}

function wordList(v: unknown, what: string, opts: { min: number; max: number; each: number }): string[] | undefined {
  if (v === undefined || v === null) {
    if (opts.min) throw new AthenaInputError(`${what}: a list of words`);
    return undefined;
  }
  if (!Array.isArray(v)) throw new AthenaInputError(`${what}: a list of words`);
  const list = v.map((x, i) => words(x, `${what}[${i}]`, opts.each, { required: true })!);
  if (new Set(list.map((x) => x.toLowerCase())).size !== list.length) throw new AthenaInputError(`${what}: each word once`);
  if (list.length < opts.min || list.length > opts.max) throw new AthenaInputError(`${what}: ${opts.min} to ${opts.max} words`);
  return list.length ? list : undefined;
}

/** One of the owner's own questions, checked. */
function readOwnQuestion(raw: unknown, i: number): CheckinQuestion {
  const at = `own[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError(`${at}: a question`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!OWN_FIELDS.includes(k)) throw new AthenaInputError(`${at}: unknown field ${k}`);
  if (typeof o.id !== "string" || !OWN_ID.test(o.id)) throw new AthenaInputError(`${at}.id: "own_" and up to 40 letters, digits, - or _`);
  if (!TYPES.includes(o.type as QuestionType)) throw new AthenaInputError(`${at}.type: one of ${TYPES.join(", ")}`);
  const type = o.type as QuestionType;
  if (o.preset !== undefined && o.preset !== false) throw new AthenaInputError(`${at}.preset: false (the owner's own)`);
  if (!Array.isArray(o.kinds) || !o.kinds.length || !o.kinds.every(isKind) || new Set(o.kinds).size !== o.kinds.length) throw new AthenaInputError(`${at}.kinds: morning, evening or both`);
  const mirror = (o.mirror ?? null) as CheckinMirror;
  if (!MIRRORS[type].includes(mirror)) throw new AthenaInputError(`${at}.mirror: for a ${type} question, one of ${MIRRORS[type].map(String).join(", ")}`);
  const q: CheckinQuestion = { id: o.id, type, prompt: words(o.prompt, `${at}.prompt`, 200, { required: true })!, kinds: CHECKIN_KINDS.filter((k) => (o.kinds as string[]).includes(k)), mirror, preset: false };
  const extra = (fields: string[]) => {
    for (const f of OWN_FIELDS.slice(4, 12)) if (!fields.includes(f) && o[f] !== undefined && o[f] !== null) throw new AthenaInputError(`${at}.${f}: not for a ${type} question`);
  };
  if (type === "scale") {
    extra(["low", "high", "lead", "levels"]);
    const low = words(o.low, `${at}.low`, 40);
    const high = words(o.high, `${at}.high`, 40);
    const lead = words(o.lead, `${at}.lead`, 60);
    const levels = wordList(o.levels, `${at}.levels`, { min: 0, max: 5, each: 40 });
    if (levels && levels.length !== 5) throw new AthenaInputError(`${at}.levels: five, one for each step from 1 to 5`);
    Object.assign(q, low ? { low } : {}, high ? { high } : {}, lead ? { lead } : {}, levels ? { levels } : {});
  } else if (type === "choices" || type === "areas") {
    extra(["options", "more"]);
    const options = wordList(o.options, `${at}.options`, { min: 1, max: 30, each: 40 })!;
    const more = wordList(o.more, `${at}.more`, { min: 0, max: 30, each: 40 });
    if (more?.some((m) => options.some((x) => x.toLowerCase() === m.toLowerCase()))) throw new AthenaInputError(`${at}.more: words not already in options`);
    Object.assign(q, { options }, more ? { more } : {});
  } else {
    extra(["placeholder", "deeper"]);
    const placeholder = words(o.placeholder, `${at}.placeholder`, 120);
    if (o.deeper !== undefined && typeof o.deeper !== "boolean") throw new AthenaInputError(`${at}.deeper: true or false`);
    Object.assign(q, placeholder ? { placeholder } : {}, { deeper: o.deeper === true });
  }
  return q;
}

function readRoutine(raw: unknown, kind: CheckinKind, library: Map<string, CheckinQuestion>): RoutineSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError(`${kind}: enabled, per_day and questions`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["enabled", "per_day", "questions"].includes(k)) throw new AthenaInputError(`${kind}: unknown field ${k}`);
  if (typeof o.enabled !== "boolean") throw new AthenaInputError(`${kind}.enabled: true or false`);
  if (!Number.isInteger(o.per_day) || (o.per_day as number) < 1 || (o.per_day as number) > MAX_PER_DAY) throw new AthenaInputError(`${kind}.per_day: 1 to ${MAX_PER_DAY}`);
  if (!Array.isArray(o.questions)) throw new AthenaInputError(`${kind}.questions: a list of { id, pinned }`);
  const seen = new Set<string>();
  const questions = o.questions.map((r, i) => {
    const at = `${kind}.questions[${i}]`;
    const e = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
    if (!e || Object.keys(e).some((k) => k !== "id" && k !== "pinned") || typeof e.id !== "string" || typeof e.pinned !== "boolean") throw new AthenaInputError(`${at}: { id, pinned }`);
    const q = library.get(e.id);
    if (!q) throw new AthenaInputError(`${at}: there's no question ${JSON.stringify(e.id.slice(0, 60))}`);
    if (!q.kinds.includes(kind)) throw new AthenaInputError(`${at}: "${q.prompt}" isn't a ${kind} question`);
    if (seen.has(e.id)) throw new AthenaInputError(`${at}: "${q.prompt}" is in the list twice`);
    seen.add(e.id);
    return { id: e.id, pinned: e.pinned };
  });
  return { enabled: o.enabled, per_day: o.per_day as number, questions };
}

/** What PUT /api/checkins/settings saves, checked. Throws AthenaInputError with what to fix. */
export function checkSettings(raw: unknown): CheckinSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError("Send the settings as JSON: morning, evening and own");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["morning", "evening", "own", "library"].includes(k)) throw new AthenaInputError(`Unknown field ${k}. Fields: morning, evening, own`);
  const ownRaw = o.own ?? [];
  if (!Array.isArray(ownRaw)) throw new AthenaInputError("own: a list of questions");
  if (ownRaw.length > MAX_OWN_QUESTIONS) throw new AthenaInputError(`own: at most ${MAX_OWN_QUESTIONS} questions of your own`);
  const own = ownRaw.map(readOwnQuestion);
  const ids = new Set<string>();
  for (const q of own) {
    if (ids.has(q.id)) throw new AthenaInputError(`own: ${q.id} is there twice`);
    ids.add(q.id);
  }
  const library = new Map(libraryOf({ own }).map((q) => [q.id, q]));
  return { morning: readRoutine(o.morning, "morning", library), evening: readRoutine(o.evening, "evening", library), own };
}

/** Every question that can be picked: Athena's presets, then the owner's own. */
export function libraryOf(s: Pick<CheckinSettings, "own">): CheckinQuestion[] {
  return [...PRESET_QUESTIONS, ...s.own];
}

export function settingsView(s: CheckinSettings): CheckinSettingsView {
  return { ...structuredClone(s), library: structuredClone(libraryOf(s)) };
}

export async function loadCheckinSettings(): Promise<CheckinSettings> {
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
  if (!row) return structuredClone(DEFAULT_CHECKIN_SETTINGS);
  try {
    return checkSettings(row.value);
  } catch {
    // Saved settings are checked when they're saved; a preset that has since gone shouldn't lock the owner out.
    console.warn("Athena check-ins: saved settings didn't read, using the defaults");
    return structuredClone(DEFAULT_CHECKIN_SETTINGS);
  }
}

export async function saveCheckinSettings(raw: unknown): Promise<CheckinSettingsView> {
  const s = checkSettings(raw);
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SETTINGS_KEY, JSON.stringify(s)]);
  return settingsView(s);
}

// ---------- Answers ----------

/** Text as the owner wrote it: line breaks kept, the rest tidied. */
function cleanText(v: string): string {
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** An answer to `q`, checked against its type. Throws AthenaInputError with what to fix. */
export function readValue(q: CheckinQuestion, raw: unknown): CheckinValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError("Send the answer as JSON");
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  const only = (allowed: string[], shape: string) => {
    if (!keys.length || keys.some((k) => !allowed.includes(k))) throw new AthenaInputError(`Answer "${q.prompt}" with ${shape}, or { skipped: true }`);
  };
  if ("skipped" in o) {
    if (o.skipped !== true || keys.length !== 1) throw new AthenaInputError("skipped: true, on its own");
    return { skipped: true };
  }
  if (q.type === "scale") {
    only(["scale"], "{ scale: 1 to 5 }");
    if (!Number.isInteger(o.scale) || (o.scale as number) < 1 || (o.scale as number) > 5) throw new AthenaInputError("scale: a whole number from 1 to 5");
    return { scale: o.scale as 1 | 2 | 3 | 4 | 5 };
  }
  if (q.type === "choices" || q.type === "areas") {
    only(["picks"], "{ picks: [words] }");
    const allowed = [...(q.options ?? []), ...(q.more ?? [])];
    if (!Array.isArray(o.picks) || !o.picks.length) throw new AthenaInputError("picks: at least one, or skip the question");
    const picks: string[] = [];
    for (const p of o.picks) {
      const found = typeof p === "string" ? allowed.find((a) => a.toLowerCase() === p.trim().toLowerCase()) : undefined;
      if (!found) throw new AthenaInputError(`picks: ${JSON.stringify(typeof p === "string" ? p.slice(0, 40) : p)} isn't one of the choices`);
      if (!picks.includes(found)) picks.push(found);
    }
    return { picks };
  }
  only(["text", "deeper"], "{ text }");
  if (typeof o.text !== "string") throw new AthenaInputError("text: what you wrote");
  const text = cleanText(o.text);
  if (!text) throw new AthenaInputError("text: write something, or skip the question");
  if (text.length > MAX_ANSWER_CHARS) throw new AthenaInputError(`text: at most ${MAX_ANSWER_CHARS} characters`);
  if (o.deeper === undefined || o.deeper === null) return { text };
  if (!q.deeper) throw new AthenaInputError("deeper: this question doesn't go deeper");
  const d = o.deeper && typeof o.deeper === "object" && !Array.isArray(o.deeper) ? (o.deeper as Record<string, unknown>) : null;
  if (!d || Object.keys(d).some((k) => k !== "question" && k !== "text") || typeof d.question !== "string") throw new AthenaInputError("deeper: { question, text }");
  const question = oneLine(d.question);
  if (!question || question.length > MAX_DEEPER_QUESTION_CHARS) throw new AthenaInputError(`deeper.question: the follow-up question, at most ${MAX_DEEPER_QUESTION_CHARS} characters`);
  if (d.text !== undefined && d.text !== null && typeof d.text !== "string") throw new AthenaInputError("deeper.text: what you wrote");
  const more = typeof d.text === "string" ? cleanText(d.text) : "";
  if (more.length > MAX_ANSWER_CHARS) throw new AthenaInputError(`deeper.text: at most ${MAX_ANSWER_CHARS} characters`);
  return { text, deeper: more ? { question, text: more } : { question } };
}

// ---------- Rows ----------

function open(row: Row): Stored {
  return JSON.parse(openStrict(row.sealed)) as Stored;
}

function toCheckin(date: string, kind: CheckinKind, s: Stored, row?: Pick<Row, "status" | "done_at"> | null): Checkin {
  return {
    date,
    kind,
    plan: s.plan,
    answers: s.answers,
    status: row?.status ?? "open",
    ...(row?.done_at ? { done_at: new Date(row.done_at).toISOString() } : {}),
  };
}

async function readRows(date: string): Promise<Row[]> {
  return qRaw<Row>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, sealed, status, done_at FROM checkins WHERE date = $1::date`, [date]);
}

async function readRow(date: string, kind: CheckinKind): Promise<Row | null> {
  return (await readRows(date)).find((r) => r.kind === kind) ?? null;
}

async function writeStored(date: string, kind: CheckinKind, s: Stored): Promise<void> {
  await qRaw(`UPDATE checkins SET sealed = $3, updated_at = now() WHERE date = $1::date AND kind = $2`, [date, kind, sealText(JSON.stringify(s))]);
}

function needKey(): void {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
}

// ---------- Reading and planning ----------

/**
 * A day's check-in as planned, or null when the routine is off or nothing has been planned for
 * that day. Never makes a plan. For the nudges and the briefing.
 */
export async function loadCheckin(date: string, kind: CheckinKind): Promise<Checkin | null> {
  readDate(date);
  const settings = await loadCheckinSettings();
  if (!settings[kind].enabled) return null;
  const row = await readRow(date, kind);
  return row ? toCheckin(date, kind, open(row), row) : null;
}

/** A day's check-in as stored, whether or not its routine is on now; null when nothing was planned. Never makes a plan. */
export async function readCheckin(date: string, kind: CheckinKind): Promise<Checkin | null> {
  readDate(date);
  const row = await readRow(date, kind);
  return row ? toCheckin(date, kind, open(row), row) : null;
}

/** When each question was last asked in this kind's plans before `date`. Rows that won't open are passed over. */
async function historyBefore(date: string, kind: CheckinKind) {
  const rows = await qRaw<Row>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, sealed, status, done_at FROM checkins WHERE kind = $1 AND date < $2::date AND date >= $3::date`,
    [kind, date, addDays(date, -HISTORY_DAYS)],
  );
  const plans: Array<{ date: string; plan: CheckinQuestion[] }> = [];
  for (const r of rows) {
    try {
      plans.push({ date: r.date, plan: open(r).plan });
    } catch {
      // Under a key this copy doesn't have: its questions just don't count towards whose turn it is.
    }
  }
  return askedHistory(plans);
}

/**
 * GET /api/checkins/:date/:kind. Today's plan (or tomorrow's, for time-zone slack) is made the first
 * time it's read and kept. A routine that's off, or a past day with nothing planned, gives an empty
 * plan and stores nothing.
 */
export async function getCheckin(date: string, kind: CheckinKind, opts: { now?: Date; tz?: string } = {}): Promise<Checkin> {
  readDate(date);
  const existing = await readRow(date, kind);
  if (existing) return toCheckin(date, kind, open(existing), existing);
  const settings = await loadCheckinSettings();
  if (!settings[kind].enabled) return { date, kind, plan: [], answers: {}, status: "open" };
  const today = zonedToday(opts.now ?? new Date(), opts.tz ?? (await getOwnerTimeZone()));
  if (date > addDays(today, 1)) throw new AthenaInputError("That day's check-in can't be planned yet");
  // A past day nobody opened stays unplanned: today's settings say nothing about what was asked then.
  if (date < today) return { date, kind, plan: [], answers: {}, status: "open" };
  needKey();
  const plan = planFor(settings[kind], libraryOf(settings), await historyBefore(date, kind), kind);
  const stored: Stored = { plan, answers: {} };
  // Two devices opening the day at once agree: the first plan in wins.
  await qRaw(`INSERT INTO checkins (date, kind, sealed) VALUES ($1::date, $2, $3) ON CONFLICT (date, kind) DO NOTHING`, [date, kind, sealText(JSON.stringify(stored))]);
  const row = (await readRow(date, kind))!;
  return toCheckin(date, kind, open(row), row);
}

/** The days in [from, to] with a check-in, oldest first. Reads status only: no key needed. */
export async function listCheckins(from: string, to: string): Promise<CheckinSummary[]> {
  readDate(from, "from");
  readDate(to, "to");
  if (to < from) throw new AthenaInputError("to: on or after from");
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new AthenaInputError(`At most ${MAX_RANGE_DAYS} days at a time`);
  const rows = await qRaw<{ date: string; kind: CheckinKind; status: "open" | "done" }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, status FROM checkins WHERE date BETWEEN $1::date AND $2::date ORDER BY date, kind`,
    [from, to],
  );
  const out = new Map<string, CheckinSummary>();
  for (const r of rows) {
    const s = out.get(r.date) ?? { date: r.date };
    s[r.kind] = r.status;
    out.set(r.date, s);
  }
  return [...out.values()];
}

/**
 * GET /api/checkins/trends: the scale answers and picks in [from, to], for Health → Wellness
 * (lib/checkin-trends.ts). Opens each row, so it needs the key; a row under a key this copy doesn't
 * have is passed over. Never plans a day.
 */
export async function checkinTrends(from: string, to: string): Promise<CheckinTrends> {
  readDate(from, "from");
  readDate(to, "to");
  if (to < from) throw new AthenaInputError("to: on or after from");
  if (daysBetween(from, to) + 1 > MAX_TRENDS_DAYS) throw new AthenaInputError(`At most ${MAX_TRENDS_DAYS} days at a time`);
  needKey();
  const rows = await qRaw<Row>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, sealed, status, done_at FROM checkins WHERE date BETWEEN $1::date AND $2::date`, [from, to]);
  const opened: TrendRow[] = [];
  for (const r of rows) {
    try {
      const s = open(r);
      opened.push({ date: r.date, kind: r.kind, status: r.status, plan: s.plan, answers: s.answers });
    } catch {
      // Sealed under a key this copy doesn't have: left out of the trend.
    }
  }
  return trendsOf(opened);
}

// ---------- Mirrors ----------

/** A check-in's section for the day's journal: its heading, then each written answer under its prompt. Null: nothing written. Pure. */
export function journalSection(kind: CheckinKind, s: Pick<Stored, "plan" | "answers">): string | null {
  const pairs: string[] = [];
  for (const q of s.plan) {
    if (q.mirror !== "day_journal") continue;
    const v = s.answers[q.id]?.value;
    if (!v || !("text" in v)) continue;
    pairs.push(`${q.prompt}\n${v.text}`);
    if (v.deeper?.text) pairs.push(`${v.deeper.question}\n${v.deeper.text}`);
  }
  return pairs.length ? `${CHECKIN_HEADINGS[kind]}\n${pairs.join("\n\n")}` : null;
}

/** The latest answer of the day, across both check-ins, for questions with this mirror. Pure. */
export function latestFor(checkins: Array<Pick<Stored, "plan" | "answers">>, mirror: CheckinMirror): CheckinValue | null {
  let best: CheckinAnswer | null = null;
  for (const c of checkins) {
    for (const q of c.plan) {
      const a = c.answers[q.id];
      if (q.mirror !== mirror || !a || "skipped" in a.value) continue;
      if (!best || a.answered_at > best.answered_at) best = a;
    }
  }
  return best?.value ?? null;
}

/** Copy a check-in's answers for this mirror out again, from the day's two check-ins. Updates `stored.journal`. */
async function applyMirror(date: string, kind: CheckinKind, stored: Stored, mirror: CheckinMirror, opts: { now?: Date; tz?: string }): Promise<void> {
  if (mirror === null || mirror === "briefing") return;
  if (mirror === "day_journal") {
    const { section } = await mirrorCheckinDay(date, { journal: { was: stored.journal ?? null, now: journalSection(kind, stored) } });
    if (section) stored.journal = section;
    else delete stored.journal;
    return;
  }
  const others: Stored[] = [];
  for (const r of await readRows(date)) if (r.kind !== kind) others.push(open(r));
  const day = [stored, ...others];
  if (mirror === "day_mood") {
    const v = latestFor(day, "day_mood");
    await mirrorCheckinDay(date, { mood: v && "scale" in v ? (v.scale as Mood) : null });
    return;
  }
  const scale = (m: CheckinMirror) => {
    const v = latestFor(day, m);
    return v && "scale" in v ? v.scale : undefined;
  };
  const labels = latestFor(day, "health_mood_labels");
  await setCheckinHealthDay(date, { energy: scale("health_energy"), stress: scale("health_stress"), mood_labels: labels && "picks" in labels ? labels.picks : undefined }, opts);
}

// ---------- Answering ----------

async function planned(date: string, kind: CheckinKind, questionId: string): Promise<{ row: Row; stored: Stored; q: CheckinQuestion }> {
  readDate(date);
  const row = await readRow(date, kind);
  if (!row) throw new AthenaInputError("Nothing's planned for that check-in yet. Open it first", 404);
  needKey();
  const stored = open(row);
  const q = stored.plan.find((x) => x.id === questionId);
  if (!q) throw new AthenaInputError("That question isn't in this check-in", 404);
  return { row, stored, q };
}

/** PUT …/answers/:question_id. Saving the same answer again changes nothing. Applies the question's mirror. */
export async function answerCheckin(date: string, kind: CheckinKind, questionId: string, raw: unknown, opts: { now?: Date; tz?: string } = {}): Promise<Checkin> {
  const { row, stored, q } = await planned(date, kind, questionId);
  const value = readValue(q, raw);
  const before = stored.answers[q.id];
  if (!before || JSON.stringify(before.value) !== JSON.stringify(value)) stored.answers[q.id] = { question_id: q.id, value, answered_at: (opts.now ?? new Date()).toISOString() };
  await applyMirror(date, kind, stored, q.mirror, opts);
  await writeStored(date, kind, stored);
  return toCheckin(date, kind, stored, row);
}

/** DELETE …/answers/:question_id: the answer and its mirror taken back out. Deleting one that isn't there changes nothing. */
export async function clearAnswer(date: string, kind: CheckinKind, questionId: string, opts: { now?: Date; tz?: string } = {}): Promise<Checkin> {
  const { row, stored, q } = await planned(date, kind, questionId);
  delete stored.answers[q.id];
  await applyMirror(date, kind, stored, q.mirror, opts);
  await writeStored(date, kind, stored);
  return toCheckin(date, kind, stored, row);
}

/** POST …/done. Done again keeps the first time. */
export async function finishCheckin(date: string, kind: CheckinKind, opts: { now?: Date } = {}): Promise<Checkin> {
  readDate(date);
  needKey();
  const [row] = await qRaw<Row>(
    `UPDATE checkins SET status = 'done', done_at = COALESCE(done_at, $3::timestamptz), updated_at = now() WHERE date = $1::date AND kind = $2
     RETURNING to_char(date, 'YYYY-MM-DD') AS date, kind, sealed, status, done_at`,
    [date, kind, (opts.now ?? new Date()).toISOString()],
  );
  if (!row) throw new AthenaInputError("Nothing's planned for that check-in yet. Open it first", 404);
  return toCheckin(date, kind, open(row), row);
}

/** POST …/deeper: one follow-up question about what's written so far. Nothing is saved. */
export async function deeperFor(date: string, kind: CheckinKind, raw: unknown, deps: { client?: Anthropic; budgetMs?: number } = {}): Promise<DeeperReply> {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.question_id !== "string" || typeof o.text !== "string") throw new AthenaInputError("Send { question_id, text }");
  const { q } = await planned(date, kind, o.question_id);
  if (q.type !== "text" || !q.deeper) throw new AthenaInputError("This question doesn't go deeper");
  const text = cleanText(o.text);
  if (!text) throw new AthenaInputError("text: write something first");
  if (text.length > MAX_ANSWER_CHARS) throw new AthenaInputError(`text: at most ${MAX_ANSWER_CHARS} characters`);
  return askDeeper({ prompt: q.prompt, text }, deps);
}
