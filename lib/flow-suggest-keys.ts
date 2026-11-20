/**
 * The keys of the values a suggested flow's trigger gives (Flow.trigger_gives).
 * lib/flow-types.ts leaves these to triggers (lib/flow-triggers.ts), which isn't
 * merged yet, so these are the names suggestions assume, kept in one place so
 * they line up with one edit once it is. Pure.
 */
import type { FlowTrigger } from "./flow-types";

export const TRIGGER_KEYS = {
  /** Every collected or saved event: the item's title. */
  title: "title",
  /** A saved event: the saved item itself. */
  saved: "saved",
  /** A collected event's date, by kind. */
  date: { delivery: "delivery_date", booking: "date", appointment: "date", deadline: "date", renewal: "renewal_date" } as Record<string, string>,
} as const;

/** The keys a trigger gives, as suggestions use them. */
export function suggestedTriggerKeys(trigger: FlowTrigger): string[] {
  if (trigger.kind !== "event") return [];
  if (trigger.event.source === "saved") return [TRIGGER_KEYS.title, TRIGGER_KEYS.saved];
  const date = trigger.event.kind ? TRIGGER_KEYS.date[trigger.event.kind] : undefined;
  return date ? [TRIGGER_KEYS.title, date] : [TRIGGER_KEYS.title];
}
