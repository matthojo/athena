/**
 * The keys of the values a suggested flow's trigger gives (Flow.trigger_gives).
 * Triggers own these (triggerGives in lib/flow-triggers.ts). That isn't merged
 * yet, so the names are copied here rather than imported; keep them in step
 * with it. Pure.
 */
import type { FlowTrigger } from "./flow-types";
import type { EventFilter } from "./team-types";

export const TRIGGER_KEYS = {
  /** Every event: the item's title. */
  title: "title",
  /** Every event: how many came in. */
  count: "count",
  /** Every event: the record itself (for a saved event, the saved item). */
  item: "item",
  /** A collected event's date, by kind. A booking gives when it starts, a datetime. */
  date: { delivery: "expected", booking: "starts_at", appointment: "date", deadline: "date", renewal: "renewal_date" } as Record<string, string>,
} as const;

/** What an event trigger's item carries besides `title` and `count`, as triggerGives names it. */
function eventItemKeys(f: EventFilter): string[] {
  if (f.source === "saved") return ["item", "website"];
  if (f.source === "note") return ["item", "tags"];
  switch ((f.kind ?? "").trim().toLowerCase()) {
    case "renewal":
      return ["item", "company", "renewal_date"];
    case "delivery":
      return ["item", "company", "expected"];
    case "booking":
      return ["item", "booking", "company", "starts_at"];
    case "event":
    case "appointment":
    case "deadline":
      return ["item", "date"];
    default:
      return ["item"];
  }
}

/** The keys a trigger gives, as suggestions use them. Suggestions only ever start from event triggers. */
export function suggestedTriggerKeys(trigger: FlowTrigger): string[] {
  if (trigger.kind !== "event") return [];
  return [...eventItemKeys(trigger.event), TRIGGER_KEYS.title, TRIGGER_KEYS.count];
}
