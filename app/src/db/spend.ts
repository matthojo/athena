/**
 * AI spend for the app (lib/spend-types.ts; routes in netlify/lib/spend-routes.ts): today's spend and the week,
 * the daily budget, each assistant's cap, and "Allow more". Every screen that shows spend (Settings → AI spend,
 * an assistant's cap, the notice in an Ask reply) reads the same last copy and repaints on onSpendChange.
 *
 * Changing the budget needs a connection; the last copy seen is kept for this visit so a screen opens at once.
 * Sample mode answers from db/sample-spend.ts and never touches the network.
 */
import { isSampleMode, request } from "./api";
import type { AllowMoreBody, BudgetPatch, SpendView } from "../../../lib/spend-types";

export type { SpendView, BudgetPatch, BudgetNotice, AssistantCap, SpendLine, SpendDay } from "../../../lib/spend-types";

const sample = () => import("./sample-spend");

let last: SpendView | null = null;
const listeners = new Set<(v: SpendView) => void>();

/** Repaint when spend or the budget changes here. */
export function onSpendChange(fn: (v: SpendView) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(v: SpendView): SpendView {
  last = v;
  listeners.forEach((fn) => fn(v));
  return v;
}

/** The last copy seen on this visit, for a screen that opens before the network answers. */
export const spendSnapshot = (): SpendView | null => last;

export async function loadSpend(): Promise<SpendView> {
  if (isSampleMode()) return changed((await sample()).sampleSpend());
  return changed(await request<SpendView>("/spend"));
}

export async function saveBudget(patch: BudgetPatch): Promise<SpendView> {
  if (isSampleMode()) return changed((await sample()).sampleSetBudget(patch));
  return changed(await request<SpendView>("/spend/budget", { method: "PATCH", body: JSON.stringify(patch) }));
}

export async function allowMore(body: AllowMoreBody = {}): Promise<SpendView> {
  if (isSampleMode()) return changed((await sample()).sampleAllowMore(body));
  return changed(await request<SpendView>("/spend/allow-more", { method: "POST", body: JSON.stringify(body) }));
}
