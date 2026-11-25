/**
 * Sample check-ins, for sample mode and the screenshots: the server's routes
 * (lib/checkin-types.ts) answered from memory. Both routines are on, with
 * one question of the owner's own; the last six months have answers, made
 * the same way every time for a given date (seeded, like db/sample-days.ts),
 * with a shape Health → Wellness can show (brighter weekends, less energy
 * by the evening, a rough month or so in late summer, a lighter last few
 * weeks), and today waits to be done. Edits live until the page reloads. The mood
 * scale sets the sample day's mood, as the server's mirror would.
 */

import { DEFAULT_CHECKIN_SETTINGS, PRESET_QUESTIONS, type Checkin, type CheckinKind, type CheckinQuestion, type CheckinSettings, type CheckinSettingsView, type CheckinSummary, type CheckinTrends, type CheckinValue, type DeeperReply, type ScaleValue } from "../../../lib/checkin-types";
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
  mirror: null,
  preset: false,
};

/** How many days back the sample has answers. */
const HISTORY = 182;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

let settings: CheckinSettings = {
  ...clone(DEFAULT_CHECKIN_SETTINGS),
  morning: { ...clone(DEFAULT_CHECKIN_SETTINGS.morning), enabled: true },
  evening: { ...clone(DEFAULT_CHECKIN_SETTINGS.evening), enabled: true, questions: [...clone(DEFAULT_CHECKIN_SETTINGS.evening.questions), { id: OWN.id, pinned: false }] },
  own: [clone(OWN)],
};

const store = new Map<string, Checkin>();
const key = (date: string, kind: CheckinKind) => `${date}|${kind}`;
const library = (): CheckinQuestion[] => [...PRESET_QUESTIONS, ...settings.own];
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
  const c: Checkin = { date, kind, plan: clone(pickPlan(routine, library(), lastAsked(kind, date))), answers: {}, status: "open" };
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
  return { ...clone(settings), library: clone(library()) };
}

export async function saveSampleCheckinSettings(next: CheckinSettings): Promise<CheckinSettingsView> {
  await wait(80);
  settings = clone(next);
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

async function mirror(date: string, q: CheckinQuestion | undefined, value: CheckinValue | null): Promise<void> {
  if (q?.mirror !== "day_mood") return;
  const { patchSampleDay } = await import("./sample-days");
  await patchSampleDay(date, { mood: value && "scale" in value ? value.scale : null }).catch(() => undefined);
}

export async function answerSampleCheckin(date: string, kind: CheckinKind, questionId: string, value: CheckinValue | null): Promise<Checkin> {
  await wait(60);
  const c = store.get(key(date, kind)) ?? plan(date, kind);
  if (value === null) delete c.answers[questionId];
  else c.answers[questionId] = { question_id: questionId, value: clone(value), answered_at: new Date().toISOString() };
  await mirror(date, c.plan.find((q) => q.id === questionId), value);
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
