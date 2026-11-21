/**
 * Sample habits, spending, electricity, gas and the home's weather, made up the same way every time
 * for a given date (a seeded generator, like db/sample-days.ts). Used by
 * sample mode for the Library's Habits and Money pages, and to add habit
 * entries and (when turned on) the money and home lines to sample days.
 */

import type { Day, DayEntry, DayHome, DayMoney, MoneyCategory } from "../../../lib/day-types";
import { localToday } from "../lib/time";
import type { HabitDayMark, HabitSummary, Habits, ManualPayment, Money, MoneyMonth, MoneyPrefs, RegularPayments, SpendingInput } from "./life";
import { detectRecurring, monthlyTotals, type RecurringInputDay } from "../../../lib/recurring";
import { homeMonths, householdBills, houseEnergy } from "../../../lib/house";
import type { HomeDayFigures } from "../../../lib/money";
import type { Rate, TariffStore } from "../../../lib/tariff";
import type { House, MeterReading, ReadingInput } from "./house";
import { readingDays } from "../../../lib/manual-entry";
import type { HabitInput, HabitsOn } from "./habits";
import { ATHENA_SOURCE, EVERY_DAY, WEEKDAYS_ONLY, shortWeek, weekStart as weekStartOf, doneThisWeek, isDone, isDueOn, isHabitIcon, nameKey, progressNote, scheduleWords, showsOn, streakOf, type OwnHabit } from "../../../lib/habit-rules";

const PREFS_KEY = "athena.sample.moneyPrefs";

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

function seeded(key: string): () => number {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return () => {
    x = Math.imul(x ^ (x >>> 15), 2246822507);
    x = Math.imul(x ^ (x >>> 13), 3266489909);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
}

// ---------- Habits ----------

interface SampleHabit {
  id: string;
  name: string;
  source: "habitify" | "todoist";
  /** Chance of done, Monday first. */
  odds: number[];
  started: number;
  goal?: { of: number; unit: string };
}

const HABITS: SampleHabit[] = [
  { id: "read", name: "Read 20 pages", source: "habitify", odds: [0.8, 0.75, 0.8, 0.7, 0.55, 0.85, 0.9], started: 320 },
  { id: "water", name: "Drink water", source: "habitify", odds: [0.7, 0.7, 0.65, 0.7, 0.5, 0.45, 0.55], started: 280, goal: { of: 5, unit: "glasses" } },
  { id: "stretch", name: "Stretch", source: "habitify", odds: [0.6, 0.55, 0.6, 0.5, 0.4, 0.3, 0.35], started: 200 },
  { id: "phone", name: "No phone in bed", source: "habitify", odds: [0.65, 0.7, 0.6, 0.6, 0.4, 0.35, 0.5], started: 150 },
  { id: "plants", name: "Water the plants", source: "todoist", odds: [0.95, 0, 0, 0.9, 0, 0, 0.6], started: 360 },
];

function markFor(h: SampleHabit, date: string, today: string): HabitDayMark | null {
  const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000;
  if (age < 0 || age > h.started) return null;
  const odds = h.odds[weekday(date)];
  // Todoist only says what was done; a plain weekly chore has no "missed".
  if (h.source === "todoist" && odds === 0) return null;
  const r = seeded(`${h.id}:${date}`);
  // Today isn't over: the evening habits aren't ticked yet.
  const done = date === today ? h.id === "water" || (h.id === "read" && r() > 0.5) : r() < odds;
  if (h.source === "todoist" && !done) return null;
  if (!done && h.goal) return { date, done, note: `${1 + Math.floor(r() * (h.goal.of - 1))} of ${h.goal.of} ${h.goal.unit}` };
  if (!done && r() < 0.25) return { date, done, note: "skipped" };
  return { date, done };
}

// ---------- Athena's own habits (db/habits.ts in sample mode) ----------

const OWN_KEY = "athena.sample.ownHabits";

interface OwnStore {
  habits: OwnHabit[];
  /** "id|date" → count the owner set here; anything else is made up from the seed. */
  ticks: Record<string, number>;
  /** false hides the imported sample habits (for a look at the empty page). */
  imports?: boolean;
}

function defaultOwn(today: string): OwnStore {
  const at = (n: number) => `${addDays(today, -n)}T09:00:00.000Z`;
  const base = { unit: null, target: null, per_week: null, archived_at: null, updated_at: at(1) };
  return {
    habits: [
      { ...base, id: "00000000-0000-4000-8000-0000000000a1", name: "Evening run", days: WEEKDAYS_ONLY, icon: "heart", position: 0, starts_on: addDays(today, -150), created_at: at(150) },
      { ...base, id: "00000000-0000-4000-8000-0000000000a2", name: "Fruit and veg", days: EVERY_DAY, target: 5, unit: "portions", icon: "leaf", position: 1, starts_on: addDays(today, -110), created_at: at(110) },
      { ...base, id: "00000000-0000-4000-8000-0000000000a3", name: "Practise piano", days: EVERY_DAY, per_week: 3, icon: "music", position: 2, starts_on: addDays(today, -90), created_at: at(90) },
    ],
    ticks: {},
  };
}

let own: OwnStore | null = null;
function ownStore(): OwnStore {
  if (own) return own;
  try {
    const raw = localStorage.getItem(OWN_KEY);
    if (raw) return (own = JSON.parse(raw) as OwnStore);
  } catch {
    // Private mode: the made-up habits only.
  }
  return (own = defaultOwn(localToday()));
}
function keepOwn(): void {
  try {
    localStorage.setItem(OWN_KEY, JSON.stringify(ownStore()));
  } catch {
    // Private mode: lasts until reload.
  }
}

/** A made-up count for a day: weekday habits mostly kept, the piano about three times a week, fruit and veg often short of five. */
function madeUp(h: OwnHabit, date: string, today: string): number {
  if (date > today || date < h.starts_on) return 0;
  const r = seeded(`own:${h.id}:${date}`);
  if (date === today) return h.target ? 3 : 0;
  // This week the piano is one short, so Today has it.
  if (h.per_week) return date >= weekStartOf(today) ? (weekday(date) === 1 || weekday(date) === 3 ? 1 : 0) : r() < 0.48 ? 1 : 0;
  if (!isDueOn(h, date)) return 0;
  // The evening run hasn't been missed in a month, so its streak is worth showing.
  if (h.id === "00000000-0000-4000-8000-0000000000a1" && date >= addDays(today, -30)) return 1;
  if (h.target) {
    const x = r();
    return x < 0.62 ? h.target : x < 0.9 ? 2 + Math.floor(r() * (h.target - 2)) : 0;
  }
  return r() < (weekday(date) === 4 ? 0.6 : 0.86) ? 1 : 0;
}

const ownProgress = (h: OwnHabit, date: string, today = localToday()) => ownStore().ticks[`${h.id}|${date}`] ?? madeUp(h, date, today);

function ownDone(h: OwnHabit, from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (let d = from; d <= to; d = addDays(d, 1)) if (isDone(ownProgress(h, d), h.target)) out.add(d);
  return out;
}

export async function sampleHabitsOn(date?: string): Promise<HabitsOn> {
  const today = localToday();
  const day = date ?? today;
  const habits = [...ownStore().habits].sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || a.position - b.position);
  const on = habits
    .filter((h) => !h.archived_at)
    .map((h) => {
      const done = ownDone(h, addDays(day, -200), today);
      const progress = ownProgress(h, day);
      const s = streakOf(h, done, today, day);
      return { id: h.id, progress, done: isDone(progress, h.target), shows: showsOn(h, day, done) || progress > 0, ...(h.per_week ? { week_done: doneThisWeek(done, day) } : {}), streak: s.streak, streak_unit: s.unit };
    });
  return later({ today, date: day, habits, on }, 40);
}

export async function saveSampleHabit(patch: HabitInput, id?: string): Promise<OwnHabit> {
  const store = ownStore();
  const today = localToday();
  const name = patch.name?.replace(/\s+/g, " ").trim();
  if (name !== undefined && store.habits.some((h) => h.id !== id && nameKey(h.name) === nameKey(name))) throw new Error(`You already have a habit called “${name}”.`);
  const now = new Date().toISOString();
  let h = id ? store.habits.find((x) => x.id === id) : undefined;
  if (!h) {
    if (!name) throw new Error("Give the habit a name");
    h = { id: crypto.randomUUID(), name, days: EVERY_DAY, per_week: null, target: null, unit: null, icon: "check", position: store.habits.length, starts_on: today, archived_at: null, created_at: now, updated_at: now };
    store.habits.push(h);
  }
  Object.assign(h, {
    ...(name ? { name } : {}),
    ...(patch.days !== undefined ? { days: patch.days || EVERY_DAY } : {}),
    ...(patch.per_week !== undefined ? { per_week: patch.per_week } : {}),
    ...(patch.target !== undefined ? { target: patch.target && patch.target > 1 ? patch.target : null } : {}),
    ...(patch.unit !== undefined ? { unit: patch.unit || null } : {}),
    ...(isHabitIcon(patch.icon) ? { icon: patch.icon } : {}),
    ...(patch.archived !== undefined ? { archived_at: patch.archived ? now : null } : {}),
    updated_at: now,
  });
  keepOwn();
  return later({ ...h }, 60);
}

export async function setSampleHabitDay(id: string, date: string, progress: number): Promise<void> {
  ownStore().ticks[`${id}|${date}`] = progress;
  keepOwn();
  await later(null, 80);
}

/** Athena's habits on a sample day, as entries (count 0 with "3 of 5 portions" for a target not met yet). */
function ownEntries(date: string, today: string): DayEntry[] {
  return ownStore()
    .habits.filter((h) => !h.archived_at)
    .flatMap((h): DayEntry[] => {
      const p = ownProgress(h, date, today);
      if (!p) return [];
      return [{ id: `${date}-own-${h.id}`, kind: "habit", source: ATHENA_SOURCE, title: h.name, group: "habits", ...(isDone(p, h.target) ? {} : { count: 0 }), ...(h.target ? { note: progressNote(p, h.target, h.unit) } : {}) }];
    });
}

function ownSummary(h: OwnHabit, from: string, to: string, today: string): HabitSummary {
  const done = ownDone(h, addDays(from, -200) < h.starts_on ? h.starts_on : addDays(from, -200), today);
  const days: HabitDayMark[] = [];
  for (let d = from > h.starts_on ? from : h.starts_on; d <= to && d <= today; d = addDays(d, 1)) {
    const p = ownProgress(h, d, today);
    if (p) days.push({ date: d, done: isDone(p, h.target), ...(h.target ? { note: progressNote(p, h.target, h.unit) } : {}) });
    else if (h.per_week ? shortWeek(h, d, done, today) : isDueOn(h, d) && d < today) days.push({ date: d, done: false });
  }
  const tally = Array.from({ length: 7 }, () => ({ done: 0, all: 0 }));
  for (const d of days) {
    tally[weekday(d.date)].all++;
    if (d.done) tally[weekday(d.date)].done++;
  }
  const s = streakOf(h, done, today);
  const progress_today = ownProgress(h, today, today);
  return {
    name: h.name,
    source: ATHENA_SOURCE,
    days,
    done: days.filter((d) => d.done).length,
    streak: h.archived_at ? 0 : s.streak,
    longest: s.longest,
    streak_unit: s.unit,
    weekdays: tally.map((t) => (t.all ? Math.round((t.done / t.all) * 100) / 100 : null)),
    own: { ...h, schedule: scheduleWords(h), progress_today, shows_today: !h.archived_at && (showsOn(h, today, done) || progress_today > 0), ...(h.per_week ? { week_done: doneThisWeek(done, today) } : {}) },
  };
}

/** The habit entries for one sample day: Athena's own, Habitify's and Todoist's. */
export function sampleHabitEntries(date: string, today = localToday()): DayEntry[] {
  const out: DayEntry[] = ownEntries(date, today);
  if (ownStore().imports === false) return out;
  for (const h of HABITS) {
    const m = markFor(h, date, today);
    if (!m) continue;
    out.push({ id: `${date}-habit-${h.id}`, kind: "habit", source: h.source, title: h.name, group: "habits", ...(m.done ? {} : { count: 0 }), ...(m.note ? { note: m.note } : {}) });
  }
  return out;
}

function summarise(h: SampleHabit, from: string, to: string, today: string): HabitSummary | null {
  const days: HabitDayMark[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const m = markFor(h, d, today);
    if (m) days.push(m);
  }
  if (!days.length) return null;
  const done = new Set(days.filter((d) => d.done).map((d) => d.date));
  let streak = 0;
  for (let d = done.has(today) ? today : addDays(today, -1); done.has(d); d = addDays(d, -1)) streak++;
  let longest = 0;
  let run = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    run = done.has(d) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const tally = Array.from({ length: 7 }, () => ({ done: 0, all: 0 }));
  for (const d of days) {
    tally[weekday(d.date)].all++;
    if (d.done) tally[weekday(d.date)].done++;
  }
  return { name: h.name, source: h.source, days, done: done.size, streak, longest, weekdays: tally.map((t) => (t.all ? Math.round((t.done / t.all) * 100) / 100 : null)) };
}

export async function sampleHabits(from?: string, to?: string): Promise<Habits> {
  const today = localToday();
  const end = to ?? today;
  const start = from ?? addDays(end, -364);
  const imported = (ownStore().imports === false ? [] : HABITS)
    .map((h) => summarise(h, start, end, today))
    .filter((h): h is HabitSummary => !!h)
    .sort((a, b) => b.done - a.done);
  const mine = [...ownStore().habits].sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || a.position - b.position).map((h) => ownSummary(h, start, end, today));
  return later({ from: start, to: end, today, habits: [...mine, ...imported] });
}

// ---------- Money ----------

interface Payment {
  merchant: string;
  category: MoneyCategory;
  amount: number;
  kind?: "debit";
}

/**
 * Subscriptions and bills, on their days, so Regular payments has something
 * real to find (lib/recurring.ts runs over these like it does on the server).
 * Netflix went up a month ago, the gym's payment this month hasn't come, a
 * weekly coffee at the same café stays out, and Disney+ stopped in the summer.
 */
function regularOn(date: string, today: string): Payment[] {
  const out: Payment[] = [];
  const dom = Number(date.slice(8));
  const dow = weekday(date);
  const month = Number(date.slice(5, 7));
  if (dom === 14) out.push({ merchant: "SPOTIFY P1A2B3", category: "entertainment", amount: 1199 });
  if (dom === 3) out.push({ merchant: "NETFLIX.COM", category: "entertainment", amount: date >= addDays(today, -35) ? 1299 : 1099 });
  if (dom === 22) out.push({ merchant: "Apple.com/bill", category: "general", amount: 299 });
  if (dom === 9) out.push({ merchant: "Patreon", category: "general", amount: 500 });
  if (dom === 18) out.push({ merchant: "giffgaff", category: "bills", amount: 1000, kind: "debit" });
  if (dom === 15) out.push({ merchant: "Hackney Council", category: "bills", amount: 16800, kind: "debit" });
  // The gym: this month's payment hasn't come yet.
  if (dom === 1 && date.slice(0, 7) !== today.slice(0, 7)) out.push({ merchant: "PureGym Ltd", category: "personal_care", amount: 2499, kind: "debit" });
  if (date.slice(5) === "11-20") out.push({ merchant: "AMAZON PRIME*2B3XY", category: "shopping", amount: 9500 });
  if (dom === 7 && date < addDays(today, -110)) out.push({ merchant: "Disney Plus", category: "entertainment", amount: 799 });
  // A veg box every Tuesday, the same price.
  if (dow === 1) out.push({ merchant: "Riverford Organic", category: "groceries", amount: 2295 });
  // Saturday coffee at the same café: regular, but not a subscription.
  if (dow === 5) out.push({ merchant: "Monmouth Coffee", category: "eating_out", amount: 340 });
  // The rest of the household: water, broadband, the TV licence, rent, home insurance.
  if (dom === 5) out.push({ merchant: "Thames Water", category: "bills", amount: 4150, kind: "debit" });
  if (dom === 11) out.push({ merchant: "Hyperoptic Ltd", category: "bills", amount: 3500, kind: "debit" });
  if (dom === 20) out.push({ merchant: "TV Licensing", category: "bills", amount: 1413, kind: "debit" });
  if (dom === 28) out.push({ merchant: "Foxtons Lettings", category: "bills", amount: 185000, kind: "debit" });
  if (dom === 12) out.push({ merchant: "Home Insurance DD", category: "bills", amount: 1462, kind: "debit" });
  // Octopus by direct debit, more in winter.
  if (dom === 1) out.push({ merchant: "Octopus Energy", category: "bills", amount: [10200, 9800, 9100, 8400, 7600, 7400, 7400, 7600, 8000, 8600, 9300, 9800][month - 1], kind: "debit" });
  return out;
}

function paymentsOn(date: string): Payment[] {
  if (date > localToday()) return [];
  const r = seeded(`money:${date}`);
  const dow = weekday(date);
  const weekend = dow >= 5;
  const out: Payment[] = [];
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (!weekend && r() < 0.8) out.push({ merchant: "TfL Travel Charge", category: "transport", amount: 280 + Math.round(r() * 3) * 140 });
  if (!weekend && r() < 0.55) out.push({ merchant: pick(["Pret A Manger", "Leon", "Itsu", "Franco Manca"]), category: "eating_out", amount: 650 + Math.round(r() * 800) });
  if (r() < 0.32) out.push({ merchant: pick(["Waitrose & Partners", "Sainsbury's", "Ocado", "Co-op"]), category: "groceries", amount: 1400 + Math.round(r() * 4800) });
  if ((dow === 4 || dow === 5) && r() < 0.55) {
    const out2 = r() < 0.5;
    out.push({ merchant: out2 ? pick(["Dishoom", "Padella", "Bao"]) : pick(["Deliveroo", "Just Eat"]), category: out2 ? "eating_out" : "takeaway", amount: 2000 + Math.round(r() * 3500) });
  }
  if (r() < 0.12) out.push({ merchant: pick(["Amazon", "Uniqlo", "Daunt Books", "Muji"]), category: "shopping", amount: 1200 + Math.round(r() * 5000) });
  if (weekend && r() < 0.35) out.push({ merchant: pick(["Barbican Centre", "Picturehouse", "The Lexington"]), category: "entertainment", amount: 1100 + Math.round(r() * 2500) });
  return [...out, ...regularOn(date, localToday()), ...sampleManual().filter((p) => p.date === date).map((p) => ({ merchant: p.merchant ?? "Other", category: p.category, amount: p.amount }))];
}

// ---------- Added by hand ----------

const MANUAL_KEY = "athena.sample.manualSpending";

function sampleManual(): ManualPayment[] {
  try {
    const v = JSON.parse(localStorage.getItem(MANUAL_KEY) ?? "[]");
    return Array.isArray(v) ? (v as ManualPayment[]) : [];
  } catch {
    return [];
  }
}

function saveSampleManual(list: ManualPayment[]): void {
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify(list));
  } catch {
    // Private mode: it lasts as long as the page.
  }
}

export async function sampleSpending(from?: string, to?: string): Promise<{ payments: ManualPayment[] }> {
  const end = to ?? localToday();
  const start = from ?? addDays(end, -364);
  const payments = sampleManual()
    .filter((p) => p.date >= start && p.date <= end)
    .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return later({ payments }, 60);
}

export async function addSampleSpending(input: SpendingInput): Promise<ManualPayment> {
  const today = localToday();
  const date = input.date || today;
  if (date > today) throw new Error("That day hasn't happened yet");
  if (!(Number.isInteger(input.amount) && input.amount > 0)) throw new Error("Add an amount above £0");
  const now = new Date();
  const time = input.time || (date === today ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` : "12:00");
  const made: ManualPayment = { id: `sample-${Date.now().toString(36)}`, date, time, amount: input.amount, currency: input.currency ?? "GBP", category: input.category ?? "general", ...(input.merchant?.trim() ? { merchant: input.merchant.trim() } : {}) };
  saveSampleManual([...sampleManual(), made]);
  return later(made, 60);
}

export async function removeSampleSpending(date: string, id: string): Promise<void> {
  saveSampleManual(sampleManual().filter((p) => !(p.id === id && p.date === date)));
  return later(undefined, 60);
}

// ---------- Regular payments ----------

const REGULAR_HIDDEN_KEY = "athena.sample.regularHidden";

function regularHidden(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(REGULAR_HIDDEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Regular payments found in the sample days, by the same rules as the server. */
export async function sampleRegular(): Promise<RegularPayments> {
  const today = localToday();
  const days: RecurringInputDay[] = [];
  for (let d = addDays(today, -760); d <= today; d = addDays(d, 1)) {
    const ps = paymentsOn(d);
    if (ps.length) days.push({ date: d, currency: "GBP", payments: ps });
  }
  const all = detectRecurring(days, today);
  const hiddenKeys = regularHidden();
  const items = all.filter((r) => !hiddenKeys.includes(r.key));
  return later({ today, items, totals: monthlyTotals(items), hidden: hiddenKeys.map((key) => ({ key, name: all.find((r) => r.key === key)?.name ?? key })) });
}

export async function markSampleRegular(key: string, hidden: boolean): Promise<RegularPayments> {
  const next = new Set(regularHidden());
  if (hidden) next.add(key);
  else next.delete(key);
  try {
    localStorage.setItem(REGULAR_HIDDEN_KEY, JSON.stringify([...next]));
  } catch {
    // Private mode: it lasts as long as the page.
  }
  return sampleRegular();
}

const WORDS: Record<MoneyCategory, string> = {
  eating_out: "eating out",
  takeaway: "takeaway",
  groceries: "groceries",
  transport: "transport",
  shopping: "shopping",
  bills: "bills",
  entertainment: "going out",
  holidays: "holidays",
  personal_care: "personal care",
  general: "other",
};

const gbp = (minor: number) => {
  const big = minor >= 1000;
  return `£${big ? Math.round(minor / 100) : (minor / 100).toFixed(2)}`;
};

function dayMoney(date: string): DayMoney | null {
  const ps = paymentsOn(date);
  if (!ps.length) return null;
  const by = new Map<MoneyCategory, number>();
  for (const p of ps) by.set(p.category, (by.get(p.category) ?? 0) + p.amount);
  const categories = [...by.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  const spent = ps.reduce((s, p) => s + p.amount, 0);
  const line = categories.length === 1 ? `${gbp(spent)} spent, all ${WORDS[categories[0].category]}` : [`${gbp(spent)} spent`, ...categories.slice(0, 2).map((c) => `${WORDS[c.category]} ${gbp(c.amount)}`)].join(" · ");
  return { line, currency: "GBP", spent, count: ps.length, categories };
}

// ---------- Home ----------

/** The sample home moved to a time-of-use tariff here, and set the dishwasher and washing to run in its cheap hours. */
const SAMPLE_TOU_FROM = "2026-09-14";

function halfHours(date: string): number[] {
  const r = seeded(`home:${date}`);
  const weekend = weekday(date) >= 5;
  const away = !weekend && r() < 0.15;
  const tou = date >= SAMPLE_TOU_FROM;
  return Array.from({ length: 48 }, (_, i) => {
    const h = i / 2;
    let kw = 0.06 + r() * 0.03; // the fridge and the router
    if (tou && h >= 1 && h < 3.5 && r() < 0.8) kw += 0.35 + r() * 0.2; // on a timer, in the cheap hours
    if (h >= 7 && h < 8.5) kw += 0.25;
    if (weekend && h >= 10 && h < 17) kw += 0.15 + r() * 0.2;
    if (!away && h >= 18 && h < 22.5) kw += 0.35 + r() * 0.3;
    if (h >= 19 && h < 19.5 && !away) kw += 0.6; // the oven
    return Math.round(kw * 1000) / 1000;
  });
}

function dayHome(date: string): DayHome | null {
  if (date >= localToday()) return null; // the meter's readings arrive a day late
  const hh = halfHours(date);
  const kwh = hh.reduce((s, v) => s + v, 0);
  const by_hour = Array.from({ length: 24 }, (_, i) => Math.round((hh[i * 2] + hh[i * 2 + 1]) * 100) / 100);
  let best = 0;
  let at = 0;
  for (let i = 0; i <= 20; i++) {
    const s = by_hour[i] + by_hour[i + 1] + by_hour[i + 2] + by_hour[i + 3];
    if (s > best) [best, at] = [s, i];
  }
  const pad = (n: number) => `${String(n % 24).padStart(2, "0")}:00`;
  const gas_kwh = gasOn(date);
  const line = `${best / kwh >= 0.4 ? `${kwh.toFixed(1)} kWh, mostly ${pad(at)}–${pad(at + 4)}` : `${kwh.toFixed(1)} kWh`} · gas ${gas_kwh.toFixed(1)} kWh`;
  const evening = hh.slice(36, 46).reduce((s, v) => s + v, 0) / kwh;
  return { line, kwh: Math.round(kwh * 10) / 10, gas_kwh, by_hour, evening_share: Math.round(evening * 100) / 100 };
}

/**
 * The sample home's daily mean temperature, °C: a London year (about 5° in
 * January, 19° in late July), a few degrees either way day to day, and a cold
 * snap over the last week, so gas allowing for the weather has something to say.
 */
export function sampleTemp(date: string, today = localToday()): number {
  const r = seeded(`temp:${date}`);
  const doy = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${date.slice(0, 4)}-01-01T12:00:00Z`)) / 86_400_000;
  const season = 12 - 7 * Math.cos((2 * Math.PI * (doy - 20)) / 365);
  const days = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000;
  const snap = days >= 1 && days <= 7 ? -3.5 : 0;
  return Math.round((season + (r() - 0.5) * 5 + snap) * 10) / 10;
}

/**
 * The sample home's gas: hot water all year, and heating that follows the
 * weather (kWh for each degree the day is below 15.5°). The loft was
 * insulated in the spring, so a cold day costs a little less than last winter.
 */
function gasOn(date: string, today = localToday()): number {
  const r = seeded(`gas:${date}`);
  const hdd = Math.max(0, 15.5 - sampleTemp(date, today));
  const perDegree = date < addDays(today, -220) ? 2.9 : 2.5;
  return Math.round((6 + r() * 1.5 + hdd * perDegree * (0.9 + r() * 0.2)) * 10) / 10;
}

// ---------- Prefs ----------

function readPrefs(): MoneyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<MoneyPrefs>;
    return { money: raw.money === true, home: raw.home === true };
  } catch {
    return { money: false, home: false };
  }
}

export async function samplePrefs(): Promise<MoneyPrefs> {
  return later(readPrefs(), 60);
}

export async function saveSamplePrefs(patch: Partial<MoneyPrefs>): Promise<MoneyPrefs> {
  const next = { ...readPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Private mode: the choice lasts until reload.
  }
  return later(next, 60);
}

/** A sample day with its habits, and money and home when the owner turned them on (Settings → Days). */
export function withSampleLife(day: Day): Day {
  const prefs = readPrefs();
  const habits = sampleHabitEntries(day.date).filter((e) => !day.entries.some((x) => x.id === e.id));
  const money = prefs.money ? dayMoney(day.date) : null;
  const home = prefs.home ? dayHome(day.date) : null;
  return { ...day, entries: [...day.entries, ...habits], ...(money ? { money } : {}), ...(home ? { home } : {}) };
}

export async function sampleMoney(from?: string, to?: string): Promise<Money> {
  const end = to ?? localToday();
  const start = from ?? addDays(end, -364);
  const months = new Map<string, MoneyMonth & { m: Map<string, { amount: number; count: number }> }>();
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const key = d.slice(0, 7);
    const ps = paymentsOn(d);
    if (ps.length) {
      const row = months.get(key) ?? { month: key, currency: "GBP", spent: 0, categories: [] as MoneyMonth["categories"], merchants: [], days: 0, m: new Map<string, { amount: number; count: number }>() };
      row.days++;
      for (const p of ps) {
        row.spent += p.amount;
        const c = row.categories.find((x) => x.category === p.category);
        if (c) c.amount += p.amount;
        else row.categories.push({ category: p.category, amount: p.amount });
        const m = row.m.get(p.merchant) ?? { amount: 0, count: 0 };
        m.amount += p.amount;
        m.count++;
        row.m.set(p.merchant, m);
      }
      months.set(key, row);
    }
  }
  return later({
    from: start,
    to: end,
    months: [...months.values()]
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(({ m, ...row }) => ({ ...row, categories: row.categories.sort((a, b) => b.amount - a.amount), merchants: [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 12) })),
  });
}

// ---------- House ----------

/**
 * The sample home's tariff: a flat price that went up on 1 October, and
 * from mid September a time-of-use tariff with cheap hours 00:30–05:30.
 * Gas stays flat, with the same October change.
 */
function sampleTariff(today: string): TariffStore {
  const at = (d: string, t = "00:00") => Math.floor(Date.parse(`${d}T${t}:00Z`) / 1000);
  const touUnit: Rate[] = [];
  for (let d = SAMPLE_TOU_FROM; d <= addDays(today, 1); d = addDays(d, 1)) {
    touUnit.push([at(d, "00:00"), at(d, "00:30"), 27.42], [at(d, "00:30"), at(d, "05:30"), 8.5], [at(d, "05:30"), at(addDays(d, 1)), 27.42]);
  }
  return {
    fetched_on: today,
    account: "A-SAMPLE01",
    agreements: [
      { fuel: "electricity", tariff: "E-1R-FLAT-24-04-01-C", product: "FLAT-24-04-01", from: `${addDays(today, -900)}T00:00:00Z`, to: `${SAMPLE_TOU_FROM}T00:00:00Z`, unit: [[at(addDays(today, -900)), at("2026-10-01"), 24.5]], standing: [[at(addDays(today, -900)), 0, 53.68]] },
      { fuel: "electricity", tariff: "E-1R-TOU-25-08-01-C", product: "TOU-25-08-01", from: `${SAMPLE_TOU_FROM}T00:00:00Z`, to: null, unit: touUnit, standing: [[at(SAMPLE_TOU_FROM), at("2026-10-01"), 49.8], [at("2026-10-01"), 0, 51.37]] },
      { fuel: "gas", tariff: "G-1R-FLAT-24-04-01-C", product: "FLAT-24-04-01", from: `${addDays(today, -900)}T00:00:00Z`, to: null, unit: [[at(addDays(today, -900)), at("2026-10-01"), 6.24], [at("2026-10-01"), 0, 5.93]], standing: [[at(addDays(today, -900)), at("2026-10-01"), 31.43], [at("2026-10-01"), 0, 33.56]] },
    ],
  };
}

/** The same day `n` months before (the 31st becomes the month's last day). */
function monthsBefore(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
  return `${back.toISOString().slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * House in sample mode, by the same rules as the server (lib/house.ts):
 * 14 months of readings, and the home's temperatures with a cold snap last
 * week. localStorage "athena.sample.house": "kwh" shows it without an
 * account number, "empty" with nothing connected, "short" with six weeks of
 * readings, "long" with 26 months (every trend), "nohome" without a Home.
 */
export async function sampleHouse(): Promise<House> {
  const today = localToday();
  let mode = "";
  try {
    mode = localStorage.getItem("athena.sample.house") ?? "";
  } catch {
    // Private mode: the full sample.
  }
  const readings = sampleReadings();
  if (mode === "empty") {
    // Nothing connected: only what was typed in, as the server works it out (lib/meter-readings.ts).
    const typed = readingDays(readings) as Map<string, HomeDayFigures>;
    const energy = typed.size ? houseEnergy({ days: typed, months: homeMonths(typed), tariff: null, today, now: new Date(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London", weather: { missing: "unavailable" } }) : null;
    return later({ today, energy, meter: typed.size > 0, meter_account: false, readings, costs: "no_account" as const, bills: { bank: false, items: [], monthly: null } });
  }
  const days = new Map<string, HomeDayFigures>();
  const temps = new Map<string, number>();
  const start = mode === "short" ? addDays(today, -42) : monthsBefore(today, mode === "long" ? 26 : 14);
  for (let d = start; d < today; d = addDays(d, 1)) {
    const hh = halfHours(d);
    days.set(d, { kwh: Math.round(hh.reduce((s, v) => s + v, 0) * 1000) / 1000, half_hours: hh, gas_kwh: gasOn(d, today) });
    temps.set(d, sampleTemp(d, today));
  }
  const priced = mode !== "kwh";
  const weather = mode === "nohome" ? { missing: "no_home" as const } : { temps };
  const energy = houseEnergy({ days, months: homeMonths(days), tariff: priced ? sampleTariff(today) : null, today, now: new Date(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London", weather });
  const regular = await sampleRegular();
  // As the 15-minute look would have left them (lib/home-appliances.ts): one running, one finished earlier today, one idle, one offline.
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const appliances = [
    { name: "Dishwasher", what: "Dishwasher", brand: "Bosch", now: "Running Eco 50, 1h 20m left", running: true, last: { program: "Auto 2", ended: ago(26 * 60), minutes: 135 }, seen: ago(6) },
    { name: "Washing machine", what: "Washing machine", brand: "Siemens", now: "Finished", running: false, last: { program: "Cotton 40", ended: ago(95), minutes: 148 }, seen: ago(6) },
    { name: "Oven", what: "Oven", brand: "Neff", now: "Off", running: false, last: { program: "Hot Air", ended: ago(3 * 24 * 60), minutes: 52 }, seen: ago(6) },
    { name: "Tumble dryer", what: "Tumble dryer", brand: "Bosch", now: "Offline", running: false, seen: ago(6) },
  ];
  return later({ today, energy, meter: true, meter_account: true, readings, costs: priced ? ("priced" as const) : ("no_account" as const), bills: { bank: true, ...householdBills(regular.items) }, appliances });
}

// ---------- Meter readings typed in by hand ----------

const READINGS_KEY = "athena.sample.readings";

function sampleReadings(): MeterReading[] {
  try {
    const v = JSON.parse(localStorage.getItem(READINGS_KEY) ?? "[]");
    return (Array.isArray(v) ? (v as MeterReading[]) : []).sort((a, b) => b.date.localeCompare(a.date) || a.fuel.localeCompare(b.fuel));
  } catch {
    return [];
  }
}

function saveSampleReadings(list: MeterReading[]): MeterReading[] {
  try {
    localStorage.setItem(READINGS_KEY, JSON.stringify(list));
  } catch {
    // Private mode: they last as long as the page.
  }
  return sampleReadings();
}

export async function addSampleReading(input: ReadingInput): Promise<MeterReading[]> {
  const rest = sampleReadings().filter((r) => !(r.fuel === input.fuel && r.date === input.date));
  return later(saveSampleReadings([...rest, { id: `sample-${Date.now().toString(36)}`, ...input }]), 60);
}

export async function removeSampleReading(id: string): Promise<MeterReading[]> {
  return later(saveSampleReadings(sampleReadings().filter((r) => r.id !== id)), 60);
}

const later = <T>(v: T, ms = 120): Promise<T> => new Promise((res) => setTimeout(() => res(structuredClone(v)), ms));
