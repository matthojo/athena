/**
 * AI spend: the shapes the server sends and the app reads (lib/spend.ts, netlify/lib/spend-routes.ts,
 * app/src/db/spend.ts), and the words both use. Pure: no database, environment or Node.
 *
 * Money in these shapes is in the owner's own currency (`currency`), already converted. The server keeps
 * dollars; only it converts.
 */

/** What a model call was for. Pictures are their own area, whoever asked for them. */
export const SPEND_AREAS = ["ask", "assistant", "background", "pictures"] as const;
export type SpendArea = (typeof SPEND_AREAS)[number];

/** Where today's spend stands against a budget. "none": no budget set. "near": 80% or more. */
export type BudgetState = "none" | "under" | "near" | "reached";

/** At this share of the budget, Athena says it's getting close (one push a day). */
export const NEAR_AT = 0.8;

/** One line of the split: Ask, one assistant, background work or pictures. */
export interface SpendLine {
  area: SpendArea;
  /** For an assistant's line. */
  assistant_id?: string;
  /** The assistant's name, or null when it's been deleted. */
  name?: string | null;
  spent: number;
  /** Some of it was counted at the dearest known price (a model with no published price). */
  estimated: boolean;
}

export interface SpendDay {
  /** YYYY-MM-DD in the owner's zone. */
  day: string;
  spent: number;
  estimated: boolean;
}

/** One assistant's own cap, with what it spent today. */
export interface AssistantCap {
  assistant_id: string;
  name: string | null;
  spent: number;
  /** Null: no cap of its own; only the daily budget applies. */
  cap: number | null;
  /** Allowed on top today with "Allow more". */
  extra: number;
  state: BudgetState;
}

/** GET /api/spend. */
export interface SpendView {
  /** ISO 4217, the owner's Region currency, or USD when it names none. */
  currency: string;
  /** Language for formatting money ("en-GB"), from the Region. */
  locale: string;
  /** The exchange rate used, when it isn't dollars: units to $1, and when it was fetched. */
  rate: { value: number; as_of: string; stale: boolean } | null;
  /** True when the Region names a currency Athena has no rate for yet, so the figures are dollars. */
  rate_missing: boolean;
  today: {
    day: string;
    spent: number;
    estimated: boolean;
    lines: SpendLine[];
  };
  /** The last 7 days, oldest first, today last; and the split over all 7. */
  week: {
    days: SpendDay[];
    spent: number;
    lines: SpendLine[];
  };
  budget: {
    /** The daily budget the owner set, or null for none. */
    daily: number | null;
    /** Added today with "Allow more". */
    extra: number;
    /** daily + extra: what today stops at. Null with no budget. */
    limit: number | null;
    state: BudgetState;
    /** The next midnight in the owner's zone (ISO): when today's spend starts again from nothing. */
    resets_at: string;
    /** What one tap of "Allow more" adds, in this currency (1, or a round equivalent of about a dollar). */
    step: number;
  };
  assistants: AssistantCap[];
  /** Models counted at an estimated high price today or this week, by name. */
  estimated_models: string[];
}

/** PATCH /api/spend/budget: amounts in the owner's currency. Null clears; a missing key leaves it. */
export interface BudgetPatch {
  daily?: number | null;
  /** By assistant id. */
  assistants?: Record<string, number | null>;
}

/** POST /api/spend/allow-more. Without an assistant, it raises today's budget for all of Athena. */
export interface AllowMoreBody {
  assistant_id?: string;
}

/**
 * What a reply carries when the budget stopped it (Ask and assistant chats): the notice block and its one button.
 * `amount` and `step` are in `currency`.
 */
export interface BudgetNotice {
  scope: "all" | "assistant";
  assistant_id?: string;
  name?: string | null;
  currency: string;
  locale: string;
  /** The budget or cap that was reached, including anything already allowed on top. */
  limit: number;
  step: number;
  resets_at: string;
}

/**
 * An Ask reply when today's budget couldn't be checked (the database was away): the app offers Run anyway, which
 * sends the same message again with `run_anyway` set to this one-time token (docs/ai-models.md).
 */
export interface UncheckedNotice {
  scope: "unchecked";
  run_anyway: string;
}

/** The most a daily budget or a cap can be, in any currency's units: a guard against a typo. */
export const MAX_BUDGET = 1_000_000;

// ---------- words ----------

/** "£1.20", "$0.04", "¥150". Small amounts keep two decimals; whole amounts drop them ("£3"). Pure. */
export function money(amount: number, currency: string, locale = "en-GB"): string {
  const whole = Math.abs(amount - Math.round(amount)) < 0.005 && Math.abs(amount) >= 1;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      // "$3", not "US$3": the owner reads their own currency.
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : undefined,
      maximumFractionDigits: whole ? 0 : undefined,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** "Less than £0.01" for tiny non-zero spend, so a figure never reads as nothing when something ran. Pure. */
export function spentWords(amount: number, currency: string, locale?: string): string {
  if (amount > 0 && amount < 0.005) return `Less than ${money(0.01, currency, locale)}`;
  // Spend keeps its pence even when whole ("£3.00 of £3"); budgets drop them.
  try {
    return new Intl.NumberFormat(locale ?? "en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(amount);
  } catch {
    return money(amount, currency, locale);
  }
}

/** Where spend stands. Pure. */
export function budgetState(spent: number, limit: number | null): BudgetState {
  if (limit === null) return "none";
  // A thousandth of a penny's give, so £2.40 of £3 is 80% and not 79.99…%.
  if (spent >= limit - 1e-5) return "reached";
  if (spent >= limit * NEAR_AT - 1e-5) return "near";
  return "under";
}

/** What "Allow more" adds: 1 of the currency, or for a currency worth much less than a dollar, a round amount near $1. Pure. */
export function allowStep(rate: number): number {
  if (!(rate > 3)) return 1;
  const exp = 10 ** Math.floor(Math.log10(rate));
  const lead = rate / exp;
  return (lead <= 1.5 ? 1 : lead < 3.5 ? 2 : lead < 7.5 ? 5 : 10) * exp;
}

/** The area's name in the split. Pure. */
export function areaName(line: Pick<SpendLine, "area" | "name">): string {
  if (line.area === "ask") return "Ask";
  if (line.area === "pictures") return "Pictures";
  if (line.area === "background") return "Background work";
  return line.name ?? "A deleted assistant";
}

/** The reply Ask gives when the budget stopped it, in the owner's words. Pure. */
export function budgetReplyText(n: BudgetNotice): string {
  const limit = money(n.limit, n.currency, n.locale);
  if (n.scope === "assistant") return `${n.name ?? "This assistant"} has used today's ${limit}, so it has stopped until midnight. The rest of Athena carries on.`;
  return `That's today's AI budget of ${limit} used, so Athena has stopped until midnight, Ask included.`;
}
