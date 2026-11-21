/**
 * What each flow trigger gives later steps, by key: the chips a step can use, and the keys triggers fill in a run's
 * values (lib/flow-triggers.ts pickValues). The one list: the engine, drafting and suggestions read it through
 * lib/flow-triggers.ts, and the app's sample mode reads it here. Pure, with no imports beyond types, so the app can.
 */
import type { FlowTrigger, FlowValue, ValueKind } from "./flow-types";
import type { EventFilter } from "./team-types";

const v = (key: string, label: string, kind: ValueKind): FlowValue => ({ key, label, kind });
const lower = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The record an event trigger's item is, and what else it carries. Pure. */
function eventItem(f: EventFilter): FlowValue[] {
  if (f.source === "saved") return [v("item", "the saved item", "saved"), v("website", "the website", "text")];
  if (f.source === "note") return [v("item", "the note", "note"), v("tags", "the tags", "text")];
  const kind = lower(f.kind);
  switch (kind) {
    case "renewal":
      return [v("item", "what renews", "text"), v("company", "the company", "organisation"), v("renewal_date", "the renewal date", "date")];
    case "delivery":
      return [v("item", "the order", "text"), v("company", "the shop", "organisation"), v("delivery_date", "the delivery date", "date")];
    case "booking":
      return [v("item", "the trip", "trip"), v("booking", "the booking", "text"), v("company", "who it's with", "organisation"), v("starts_at", "when it starts", "datetime")];
    case "event":
    case "appointment":
    case "deadline":
      return [v("item", kind === "event" ? "the event" : `the ${kind}`, "event"), v("date", "the date", "date")];
    case "todo":
    case "alert":
      return [v("item", "the to-do", "todo")];
    case "email":
      return [v("item", "the email", "email")];
    default:
      return [v("item", kind ? `the ${kind.replace(/[_-]+/g, " ")}` : "the item", "note")];
  }
}

/**
 * What a trigger gives later steps, by key: the chips a step can use. Pure.
 * The values passed to FlowStarter.start use these keys; one that isn't known
 * for a particular run (a renewal with no provider) is left out of `values`.
 */
export function triggerGives(trigger: FlowTrigger): FlowValue[] {
  switch (trigger.kind) {
    case "schedule":
      return [v("date", "the date", "date"), v("time", "the time", "datetime")];
    case "manual":
      return [v("date", "the date", "date")];
    case "event":
      return [...eventItem(trigger.event), v("title", "the title", "text"), v("count", "how many came in", "number")];
    case "before":
      if (trigger.what === "event") return [v("event", "the event", "event"), v("people", "the people", "person"), v("starts_at", "when it starts", "datetime"), v("title", "the title", "text")];
      switch (lower(trigger.eventKind)) {
        case "birthday":
        case "anniversary": {
          const k = lower(trigger.eventKind);
          return [v("event", `the ${k}`, "event"), v("person", "the person", "person"), v("date", "the date", "date"), v("years", k === "birthday" ? "the age" : "how many years", "number"), v("title", "the title", "text")];
        }
        case "renewal":
          return [v("item", "what renews", "text"), v("company", "the company", "organisation"), v("renewal_date", "the renewal date", "date"), v("title", "the title", "text")];
        case "deadline":
        case "appointment":
          return [v("event", `the ${lower(trigger.eventKind)}`, "event"), v("date", "the date", "date"), v("title", "the title", "text")];
        default:
          return [v("event", "the event", "event"), v("date", "the date", "date"), v("title", "the title", "text")];
      }
  }
}
