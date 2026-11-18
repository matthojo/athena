/**
 * Habits, money and home for the app: the Library's Habits and Money pages
 * (House has its own, db/house.ts)
 * (GET /api/life/habits, /api/life/money) and the Settings → Days choice of
 * showing money and home on each day (GET/PUT /api/life/prefs). lib/money.ts
 * and lib/habits.ts on the server have the rules; nothing is cached on the
 * device. Sample mode answers from db/sample-life.ts.
 */

import { isSampleMode, request } from "./api";
import type { MoneyCategory } from "../../../lib/day-types";
import type { RegularPayment } from "../../../lib/recurring";
import type { OwnHabit } from "../../../lib/habit-rules";

export type { MoneyCategory, RegularPayment };

export interface HabitDayMark {
  date: string;
  done: boolean;
  note?: string;
}

export interface HabitSummary {
  name: string;
  source: string;
  days: HabitDayMark[];
  done: number;
  streak: number;
  longest: number;
  weekdays: Array<number | null>;
  /** Athena's own habits: an N-a-week habit's streak is in weeks. */
  streak_unit?: "day" | "week";
  /** Athena's own habits only: the habit, its schedule in words and today's count. */
  own?: OwnHabit & { schedule: string; progress_today: number; shows_today: boolean; week_done?: number };
}

export interface Habits {
  from: string;
  to: string;
  today: string;
  habits: HabitSummary[];
}

export interface MoneyMonth {
  month: string;
  currency: string;
  spent: number;
  categories: Array<{ category: MoneyCategory; amount: number }>;
  merchants: Array<{ name: string; amount: number; count: number }>;
  days: number;
}

export interface Money {
  from: string;
  to: string;
  months: MoneyMonth[];
}

/** Regular payments (lib/recurring.ts, GET /api/life/recurring): subscriptions and bills found in the bank payments. */
export interface RegularPayments {
  today: string;
  items: RegularPayment[];
  totals: Array<{ currency: string; amount: number; count: number }>;
  hidden: Array<{ key: string; name: string }>;
}

/** A payment the owner added by hand (lib/money.ts ManualPayment): for anyone without a supported bank, or for cash. */
export interface ManualPayment {
  id: string;
  date: string;
  time: string;
  /** Minor units. */
  amount: number;
  currency: string;
  category: MoneyCategory;
  merchant?: string;
}

export interface SpendingInput {
  date?: string;
  time?: string;
  amount: number;
  currency?: string;
  category?: MoneyCategory;
  merchant?: string;
}

export interface MoneyPrefs {
  money: boolean;
  home: boolean;
}

const sample = () => import("./sample-life");
const qs = (from?: string, to?: string) => (from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : "");

export async function loadHabits(from?: string, to?: string): Promise<Habits> {
  return isSampleMode() ? (await sample()).sampleHabits(from, to) : request<Habits>(`/life/habits${qs(from, to)}`);
}

export async function loadMoney(from?: string, to?: string): Promise<Money> {
  return isSampleMode() ? (await sample()).sampleMoney(from, to) : request<Money>(`/life/money${qs(from, to)}`);
}

export async function loadRegular(): Promise<RegularPayments> {
  return isSampleMode() ? (await sample()).sampleRegular() : request<RegularPayments>("/life/recurring");
}

/** "Not a subscription" (hidden: true), or bring one back. Answers with the new list. */
export async function markRegular(key: string, hidden: boolean): Promise<RegularPayments> {
  return isSampleMode() ? (await sample()).markSampleRegular(key, hidden) : request<RegularPayments>("/life/recurring", { method: "PUT", body: JSON.stringify({ key, hidden }) });
}

/** Payments added by hand, newest first (GET /api/life/spending). */
export async function loadSpending(from?: string, to?: string): Promise<ManualPayment[]> {
  if (isSampleMode()) return (await (await sample()).sampleSpending(from, to)).payments;
  return (await request<{ payments: ManualPayment[] }>(`/life/spending${qs(from, to)}`)).payments;
}

/** Add a payment by hand (POST /api/life/spending). */
export async function addSpending(input: SpendingInput): Promise<ManualPayment> {
  return isSampleMode() ? (await sample()).addSampleSpending(input) : request<ManualPayment>("/life/spending", { method: "POST", body: JSON.stringify(input) });
}

/** Take out a payment added by hand (DELETE /api/life/spending). */
export async function removeSpending(date: string, id: string): Promise<void> {
  if (isSampleMode()) return (await sample()).removeSampleSpending(date, id);
  await request<{ ok: true }>(`/life/spending?${new URLSearchParams({ date, id })}`, { method: "DELETE" });
}

export async function loadMoneyPrefs(): Promise<MoneyPrefs> {
  return isSampleMode() ? (await sample()).samplePrefs() : request<MoneyPrefs>("/life/prefs");
}

export async function saveMoneyPrefs(patch: Partial<MoneyPrefs>): Promise<MoneyPrefs> {
  return isSampleMode() ? (await sample()).saveSamplePrefs(patch) : request<MoneyPrefs>("/life/prefs", { method: "PUT", body: JSON.stringify(patch) });
}

/** The words for each category, as the server's lines use them. */
export const CATEGORY_WORDS: Record<MoneyCategory, string> = {
  eating_out: "Eating out",
  takeaway: "Takeaway",
  groceries: "Groceries",
  transport: "Transport",
  shopping: "Shopping",
  bills: "Bills",
  entertainment: "Going out",
  holidays: "Holidays",
  personal_care: "Personal care",
  general: "Other",
};

/** "£42", "£4.50": whole pounds from £10, as on the server. */
export function money(minor: number, currency = "GBP"): string {
  const big = Math.abs(minor) >= 1000;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 }).format((big ? Math.round(minor / 100) * 100 : minor) / 100);
}
