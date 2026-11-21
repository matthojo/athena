/**
 * The keys of the values a suggested flow's trigger gives (Flow.trigger_gives), read from triggers' own list
 * (lib/flow-triggers.ts triggerGives), so a suggested step only ever points at a value a run gets. Pure.
 */
import { triggerGives } from "./flow-triggers";
import type { FlowTrigger } from "./flow-types";

/** A collected item's kind as an event trigger for it. */
const collected = (kind: string): FlowTrigger => ({ kind: "event", event: { source: "collected", kind } });
/** The first date (or date and time) a trigger gives: what a follow-up's day reads from. */
const dateKey = (kind: string): string => triggerGives(collected(kind)).find((g) => g.kind === "date" || g.kind === "datetime")?.key ?? "date";

export const TRIGGER_KEYS = {
  /** Every event: the item's title. */
  title: "title",
  /** Every event: how many came in. */
  count: "count",
  /** Every event: the record itself (for a saved event, the saved item). */
  item: "item",
  /** A collected event's date, by kind, as triggers name it: a delivery's `delivery_date`, a booking's `starts_at` (a datetime). */
  date: Object.fromEntries(["delivery", "booking", "appointment", "deadline", "renewal"].map((k) => [k, dateKey(k)])) as Record<string, string>,
} as const;

/** The keys a trigger gives, as suggestions use them. Suggestions only ever start from event triggers. */
export function suggestedTriggerKeys(trigger: FlowTrigger): string[] {
  if (trigger.kind !== "event") return [];
  return triggerGives(trigger).map((g) => g.key);
}
