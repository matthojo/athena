/**
 * Sample check-ins, for sample mode and the screenshots: the server's routes
 * (lib/checkin-types.ts) answered from memory. Both routines are on, with
 * two questions of the owner's own (a scale and a written one); the last six months have answers, made
 * the same way every time for a given date (seeded, like db/sample-days.ts),
 * with a shape Health → Wellness can show (brighter weekends, less energy
 * by the evening, a rough month or so in late summer, a lighter last few
 * weeks), and today waits to be done. Edits live until the page reloads. The mood
 * scale sets the sample day's mood, and a written answer with the journal
 * mirror (Athena's own, the owner's own, or one from a shared set) swaps the check-in's
 * section in the sample day's journal, as the server's mirrors would
 * (lib/checkin-journal.ts).
 *
 * One set of check-in questions came from Community: "Sunday reset", since taken down, so it's switched off and its
 * two questions wait (db/sample-community.ts lists the withdrawal). Sets added from the `#/add` screen join here as
 * the server's would (lib/checkin-share.ts joinSharedCheckins).
 */

import { DEFAULT_CHECKIN_SETTINGS, ownMirror, PRESET_QUESTIONS, type Checkin, type CheckinKind, type CheckinQuestion, type CheckinSet, type CheckinSettings, type CheckinSettingsView, type CheckinSummary, type CheckinTrends, type CheckinValue, type DeeperReply, type ScaleValue } from "../../../lib/checkin-types";
import { askable, joinSharedCheckins, removeSetFrom, readSharedCheckins, type SharedCheckins } from "../../../lib/checkin-share";
import { journalSection, swapJournalSection } from "../../../lib/checkin-journal";
import { trendsOf } from "../../../lib/checkin-trends";
import { pickPlan } from "../components/checkin-rules";
import { localToday } from "../lib/time";

const OWN: CheckinQuestion = {
  id: "own_walk",
  type: "scale",
  prompt: "How much time did you spend outside?",
  kinds: ["evening"],
  low: "None",
  high: "Hours",
  lead: "Outside, I spent",
  levels: ["no time at all", "a few minutes", "about half an hour", "an hour or so", "most of the day"],
  mirror: ownMirror("scale"),
  preset: false,
};

/** A written question of the owner's own: its answers go to the day's journal, as Athena's written ones do. */
const OWN_WRITTEN: CheckinQuestion = {
  id: "own_notice",
  type: "text",
  prompt: "What did you notice on the way home?",
  kinds: ["evening"],
  placeholder: "A sound, a colour, the weather.",
  deeper: false,
  mirror: ownMirror("text"),
  preset: false,
};

/** How many days back the sample has answers. */
const HISTORY = 182;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The set taken down from sample Community (db/sample-community.ts SAMPLE_WITHDRAWN_SET). */
export const SAMPLE_SET_ID = "7d4c1e2a-3b5f-4a6d-8e9c-0f1a2b3c4d5e";
const SUNDAY: CheckinQuestion[] = [
  { id: "own_sunday1", type: "text", prompt: "What would you like to leave behind from this week?", kinds: ["evening"], placeholder: "Write it down, then let it go.", deeper: false, mirror: ownMirror("text"), preset: false, set: SAMPLE_SET_ID },
  { id: "own_sunday2", type: "text", prompt: "What would make next week feel a little lighter?", kinds: ["evening"], placeholder: "One small thing is plenty.", deeper: false, mirror: ownMirror("text"), preset: false, set: SAMPLE_SET_ID },
];

let settings: CheckinSettings = {
  ...clone(DEFAULT_CHECKIN_SETTINGS),
  morning: { ...clone(DEFAULT_CHECKIN_SETTINGS.morning), enabled: true },
  evening: { ...clone(DEFAULT_CHECKIN_SETTINGS.evening), enabled: true, questions: [...clone(DEFAULT_CHECKIN_SETTINGS.evening.questions), { id: OWN.id, pinned: false }, { id: OWN_WRITTEN.id, pinned: false }, ...SUNDAY.map((q) => ({ id: q.id, pinned: false }))] },
  own: [clone(OWN), clone(OWN_WRITTEN), ...clone(SUNDAY)],
};

let sets: CheckinSet[] = [
  { id: SAMPLE_SET_ID, name: "Sunday reset", summary: "Two questions to close the week gently.", author: "slow-sundays", version: "1.1", paused: true, catalogue_id: "m4n8p2q6r1s5t9v3", added_at: "2026-10-04T18:00:00.000Z" },
];
/** Sample mode's catalogue_hash for each set, as the server keeps it. */
const setHashes = new Map<string, string>([[SAMPLE_SET_ID, `sha256-${"3".repeat(64)}`]]);

const store = new Map<string, Checkin>();
const key = (date: string, kind: CheckinKind) => `${date}|${kind}`;
const library = (): CheckinQuestion[] => [...PRESET_QUESTIONS, ...settings.own];
/** What a day's plan may pick: a switched-off set's questions wait. */
const askableNow = (): CheckinQuestion[] => askable(library(), new Set(sets.filter((x) => x.paused).map((x) => x.id)));
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seeded(k: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WRITTEN: Record<string, string[]> = {
  intention: ["Finishing the draft before lunch, then a proper walk.", "One focused morning and no meetings after four.", "Getting outside before it gets dark."],
  why: ["Slept well and the week has room in it.", "Too many small things at once.", "A good talk with Sam last night."],
  grateful: ["Coffee with Priya.", "A quiet hour with a book.", "The sun coming out at lunch."],
  went_well: ["The review went better than I expected.", "Cooked something new and it worked.", "Cleared the inbox before five."],
  learned: ["That I work better with the door shut.", "How the new heating timer works."],
  tomorrow: ["Start with the hardest thing.", "Leave the laptop closed after dinner."],
  own_notice: ["The first frost on the cars.", "Someone practising the trumpet two streets over.", "How early it gets dark now."],
};

/** Each scale's usual answer, and how evenings, weekends and the last few weeks move it. */
const SHAPE: Record<string, { base: number; evening?: number; weekend?: number; lately?: number; rough?: number }> = {
  mood: { base: 3.4, evening: 0.3, weekend: 0.5, lately: 0.4, rough: -1.5 },
  energy: { base: 3.4, evening: -0.6, weekend: 0.3, lately: 0.2, rough: -1 },
  rested: { base: 3.1, weekend: 0.6, lately: 0.3, rough: -0.8 },
  stress: { base: 3.2, evening: -0.3, weekend: -0.7, lately: -0.4, rough: 1 },
  productive: { base: 3.4, weekend: -0.5 },
  own_walk: { base: 2.6, weekend: 1.2, lately: 0.3 },
};

/** Words and areas, weighted: some come up most days, some now and then. */
const WEIGHTS: Record<string, Record<string, number>> = {
  emotions: { Calm: 5, Happy: 4, Tired: 4, Grateful: 3, Motivated: 3, Stressed: 3, Relaxed: 2, Content: 2, Focused: 2, Anxious: 1, Proud: 1, Hopeful: 1 },
  influences: { Work: 6, Family: 4, Rest: 3, Fitness: 3, Friends: 3, Sleep: 2, Home: 2, Nature: 2, Health: 1, Money: 1 },
  focus: { Work: 7, Family: 3, Fitness: 3, Learning: 2, Home: 2, "Self-care": 2, Creativity: 1, Friends: 1 },
};

function sampleValue(q: CheckinQuestion, r: () => number, ctx: { kind: CheckinKind; weekend: boolean; lately: boolean; rough: boolean }): CheckinValue {
  if (r() < 0.12) return { skipped: true };
  if (q.type === "scale") {
    const s = SHAPE[q.id] ?? { base: 3.2 };
    const v = s.base + (ctx.kind === "evening" ? s.evening ?? 0 : 0) + (ctx.weekend ? s.weekend ?? 0 : 0) + (ctx.lately ? s.lately ?? 0 : 0) + (ctx.rough ? s.rough ?? 0 : 0) + (r() - 0.5) * 1.8;
    return { scale: Math.min(5, Math.max(1, Math.round(v))) as ScaleValue };
  }
  if (q.type === "text") {
    const xs = WRITTEN[q.id] ?? ["A good day, mostly."];
    return { text: xs[Math.floor(r() * xs.length)] };
  }
  const weights = WEIGHTS[q.id] ?? Object.fromEntries((q.options ?? []).map((o) => [o, 1]));
  // Work weighs less at weekends, rest and time outside more.
  const w = Object.entries(weights).map(([o, n]) => [o, ctx.weekend ? (o === "Work" ? n / 4 : o === "Rest" || o === "Nature" || o === "Relaxed" ? n * 2 : n) : n] as const);
  const total = w.reduce((a, [, n]) => a + n, 0);
  const n = 1 + Math.floor(r() * 3);
  const picks = new Set<string>();
  for (let tries = 0; picks.size < Math.min(n, w.length) && tries < 20; tries++) {
    let x = r() * total;
    for (const [o, wt] of w) {
      x -= wt;
      if (x <= 0) {
        picks.add(o);
        break;
      }
    }
  }
  return { picks: [...picks] };
}

/** When each question was last in a plan, before `date`. */
function lastAsked(kind: CheckinKind, date: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of store.values()) {
    if (c.kind !== kind || c.date >= date) continue;
    for (const q of c.plan) if (!out[q.id] || out[q.id] < c.date) out[q.id] = c.date;
  }
  return out;
}

function plan(date: string, kind: CheckinKind): Checkin {
  const today = localToday();
  const routine = settings[kind];
  // Earlier days first, so the turns work out the way the server's would.
  if (date > addDays(today, -HISTORY) && date < today) for (let d = addDays(today, -HISTORY); d < date; d = addDays(d, 1)) if (!store.has(key(d, kind))) plan(d, kind);
  const c: Checkin = { date, kind, plan: clone(pickPlan(routine, askableNow(), lastAsked(kind, date))), answers: {}, status: "open" };
  if (date < today && date >= addDays(today, -HISTORY) && c.plan.length) {
    const r = seeded(`${date}:${kind}`);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const ctx = { kind, weekend: dow === 0 || dow === 6, lately: date >= addDays(today, -28), rough: date >= addDays(today, -105) && date < addDays(today, -70) };
    const at = `${date}T${kind === "morning" ? "08:1" : "21:3"}${Math.floor(r() * 10)}:00`;
    for (const q of c.plan) c.answers[q.id] = { question_id: q.id, value: sampleValue(q, r, ctx), answered_at: at };
    c.status = "done";
    c.done_at = at;
  }
  store.set(key(date, kind), c);
  return c;
}

export async function sampleCheckinSettings(): Promise<CheckinSettingsView> {
  await wait(60);
  return { ...clone(settings), library: clone(library()), sets: clone(sets) };
}

// ---------- sets of questions (lib/checkin-share.ts), as lib/checkin-sets.ts keeps them ----------

const newOwnId = () => `own_${Math.random().toString(36).slice(2, 10)}`;
const newSetId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16)));

export interface SampleAddedCheckins {
  id: string;
  added: number;
  skipped: string[];
  off: CheckinKind[];
  full: string[];
}

/** Add a shared set, as the server's Add would: read again, joined after what's here, switched off when `start` is false. */
export async function sampleAddCheckins(raw: SharedCheckins, listing?: { id: string; hash: string; version: string | null }, opts: { start?: boolean } = {}): Promise<SampleAddedCheckins> {
  await wait(200);
  const shared = readSharedCheckins(raw);
  const id = newSetId();
  const j = joinSharedCheckins(settings, shared, { setId: id, newId: newOwnId });
  settings = j.settings;
  sets.push({ id, name: shared.name, summary: shared.summary, author: shared.author ?? null, version: shared.version ?? listing?.version ?? null, paused: opts.start === false, catalogue_id: listing?.id ?? null, added_at: new Date().toISOString() });
  if (listing) setHashes.set(id, listing.hash);
  return { id, added: j.added.length, skipped: j.skipped, off: j.off, full: j.full };
}

/** Update a set to a newer listing: its questions out, the new version's in. It keeps whether it's switched off. */
export async function sampleReplaceCheckins(id: string, raw: SharedCheckins, listing: { id: string; hash: string; version: string | null }): Promise<SampleAddedCheckins> {
  await wait(200);
  const shared = readSharedCheckins(raw);
  const at = sets.findIndex((x) => x.id === id);
  if (at < 0) throw new Error("That set of questions isn't there any more");
  const j = joinSharedCheckins(removeSetFrom(settings, id), shared, { setId: id, newId: newOwnId });
  settings = j.settings;
  sets[at] = { ...sets[at], name: shared.name, summary: shared.summary, author: shared.author ?? null, version: listing.version, catalogue_id: listing.id };
  setHashes.set(id, listing.hash);
  return { id, added: j.added.length, skipped: j.skipped, off: j.off, full: j.full };
}

export async function sampleSetPaused(id: string, paused: boolean): Promise<CheckinSettingsView> {
  await wait(80);
  sets = sets.map((x) => (x.id === id ? { ...x, paused } : x));
  return sampleCheckinSettings();
}

export async function sampleRemoveSet(id: string): Promise<CheckinSettingsView> {
  await wait(80);
  settings = removeSetFrom(settings, id);
  sets = sets.filter((x) => x.id !== id);
  setHashes.delete(id);
  return sampleCheckinSettings();
}

/** A sample set as the Community check sees it: switched on or off, its listing and the hash it was added from. */
export function sampleSetOf(id: string): (CheckinSet & { hash: string | null }) | null {
  const x = sets.find((s) => s.id === id);
  return x ? { ...clone(x), hash: setHashes.get(id) ?? null } : null;
}

export async function saveSampleCheckinSettings(next: CheckinSettings): Promise<CheckinSettingsView> {
  await wait(80);
  // As the server's readOwnQuestion: Athena says where answers go, by type, whatever is sent.
  settings = { ...clone(next), own: next.own.map((q) => ({ ...clone(q), mirror: ownMirror(q.type) })) };
  return sampleCheckinSettings();
}

export async function sampleCheckin(date: string, kind: CheckinKind): Promise<Checkin> {
  await wait(80);
  return clone(store.get(key(date, kind)) ?? plan(date, kind));
}

export async function sampleCheckinRange(from: string, to: string): Promise<CheckinSummary[]> {
  const out: CheckinSummary[] = [];
  for (let d = from; d <= to && d <= localToday(); d = addDays(d, 1)) {
    const m = store.get(key(d, "morning")) ?? (settings.morning.enabled ? plan(d, "morning") : null);
    const e = store.get(key(d, "evening")) ?? (settings.evening.enabled ? plan(d, "evening") : null);
    if (!m?.plan.length && !e?.plan.length) continue;
    out.push({ date: d, ...(m?.plan.length ? { morning: m.status } : {}), ...(e?.plan.length ? { evening: e.status } : {}) });
  }
  return out;
}

/** The trends route (GET /api/checkins/trends), from the same store. */
export async function sampleCheckinTrends(from: string, to: string): Promise<CheckinTrends> {
  await sampleCheckinRange(from, to);
  await wait(80);
  const rows = [...store.values()].filter((c) => c.date >= from && c.date <= to).map((c) => clone({ date: c.date, kind: c.kind, status: c.status, plan: c.plan, answers: c.answers }));
  return trendsOf(rows);
}

/** The section each check-in last wrote to its day's journal, as the server keeps it in the check-in. */
const sections = new Map<string, string>();

async function mirror(c: Checkin, q: CheckinQuestion | undefined, value: CheckinValue | null): Promise<void> {
  if (q?.mirror === "day_mood") {
    const { patchSampleDay } = await import("./sample-days");
    await patchSampleDay(c.date, { mood: value && "scale" in value ? value.scale : null }).catch(() => undefined);
    return;
  }
  if (q?.mirror !== "day_journal") return;
  const { patchSampleDay, sampleDayNow } = await import("./sample-days");
  const k = key(c.date, c.kind);
  const swapped = swapJournalSection(sampleDayNow(c.date).journal, sections.get(k) ?? null, journalSection(c.kind, c));
  if (swapped.section) sections.set(k, swapped.section);
  else sections.delete(k);
  await patchSampleDay(c.date, { journal: swapped.journal || null }).catch(() => undefined);
}

export async function answerSampleCheckin(date: string, kind: CheckinKind, questionId: string, value: CheckinValue | null): Promise<Checkin> {
  await wait(60);
  const c = store.get(key(date, kind)) ?? plan(date, kind);
  if (value === null) delete c.answers[questionId];
  else c.answers[questionId] = { question_id: questionId, value: clone(value), answered_at: new Date().toISOString() };
  await mirror(c, c.plan.find((q) => q.id === questionId), value);
  return clone(c);
}

export async function finishSampleCheckin(date: string, kind: CheckinKind): Promise<Checkin> {
  await wait(60);
  const c = store.get(key(date, kind)) ?? plan(date, kind);
  c.status = "done";
  c.done_at ??= new Date().toISOString();
  return clone(c);
}

/** One follow-up, picked from what was written. The real one comes from the model. */
export async function sampleDeeper(text: string): Promise<DeeperReply> {
  await wait(700);
  if (!text.trim()) return { question: "What's the first thing that comes to mind?" };
  if (/\b(tired|stress|busy|too many|hard)\b/i.test(text)) return { question: "What's one thing you could drop or hand over this week?" };
  return { question: "What made that matter to you today?" };
}
