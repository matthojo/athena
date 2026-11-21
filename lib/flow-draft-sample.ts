/**
 * Sample mode's flows for Ask's stand-in (app/src/views/ask.ts, through
 * app/src/components/ask-flow-card.ts): what propose_flow would draw for a
 * "whenever…" message, made up around the mockups. Each is a real AskFlowCard,
 * and lib/flow-draft.test.ts checks each against the contract the way a drawn
 * one is checked. Nothing here reaches a server.
 *
 * Pure: the app imports it.
 */
import type { AskFlowCard, FlowValue } from "./flow-types";

const v = (key: string, label: string, kind: FlowValue["kind"]): FlowValue => ({ key, label, kind });
// What an event trigger gives (lib/flow-triggers.ts triggerGives) and what each tool step gives (lib/flow-catalog.ts), written
// out because the app loads this file; lib/flow-draft.test.ts checks they match.
const TITLE = v("title", "the title", "text");
const COUNT = v("count", "how many came in", "number");

/** Every sample flow has the same made-up id: Edit steps opens sample mode's flow page. */
export const SAMPLE_FLOW_ID = "5a3e0000-0000-4000-8000-000000f10001";

export interface SampleFlow {
  /** delivery: mockup 2's parcel flow, whose one-off the app adds as a receipt. */
  kind: "delivery" | "renewal" | "other";
  text: string;
  card: AskFlowCard;
}

/** The sample flow for a "whenever…" message. */
export function sampleFlow(sentence: string): SampleFlow {
  const s = sentence.toLowerCase();
  if (/\b(parcel|delivery|deliveries|order)\b/.test(s)) {
    return {
      kind: "delivery",
      text: "I can do that every time one arrives. It only adds reminders, so it can run on its own once you turn it on.",
      card: {
        flow_id: SAMPLE_FLOW_ID,
        flow: {
          name: "Delivery day",
          trigger: { kind: "event", event: { source: "collected", kind: "delivery" } },
          trigger_gives: [v("item", "the order", "text"), v("company", "the shop", "organisation"), v("delivery_date", "the delivery date", "date"), TITLE, COUNT],
          steps: [{ id: "s1", title: null, kind: "tool", tool: "add_reminder", go: "auto", gives: [v("reminder", "the reminder", "text")], input: { text: ["Parcel from ", { from: "trigger", key: "company" }], date: [{ from: "trigger", key: "delivery_date" }], time: ["08:00"] } }],
          assistant_id: null,
        },
      },
    };
  }
  if (/\brenew(al|als|s)?\b/.test(s)) {
    return {
      kind: "renewal",
      text: "Here's a flow for renewals. It only looks and tells you, so nothing changes without you.",
      card: {
        flow_id: SAMPLE_FLOW_ID,
        flow: {
          name: "Renewal check",
          trigger: { kind: "event", event: { source: "collected", kind: "renewal" } },
          trigger_gives: [v("item", "what renews", "text"), v("company", "the company", "organisation"), v("renewal_date", "the renewal date", "date"), TITLE, COUNT],
          steps: [
            { id: "s1", title: null, kind: "tool", tool: "money", go: "auto", input: { merchant: [{ from: "trigger", key: "company" }] }, gives: [v("total", "the total", "money"), v("latest", "the latest payment", "money"), v("count", "how many", "number")] },
            {
              id: "s2",
              title: null,
              kind: "check",
              condition: { left: { from: "s1", key: "latest" }, op: "exists" },
              yes: [
                { id: "s3", title: null, kind: "wait", days: 7, before: { from: "trigger", key: "renewal_date" }, at: "09:00" },
                { id: "s4", title: null, kind: "notify", text: [{ from: "trigger", key: "company" }, " renews soon. Last time you paid ", { from: "s1", key: "latest" }, "."] },
              ],
              no: [],
            },
          ],
          assistant_id: null,
        },
      },
    };
  }
  const said = sentence.replace(/^\s*(every\s*time|whenever|each\s*time)\s*/i, "").replace(/[.!?]+$/, "").trim();
  return {
    kind: "other",
    text: "I've set up the start of a flow for that. Edit steps to finish it, then turn it on.",
    card: {
      flow_id: SAMPLE_FLOW_ID,
      flow: {
        name: (said.charAt(0).toUpperCase() + said.slice(1)).slice(0, 40).trim() || "New flow",
        trigger: { kind: "event", event: { source: "collected", kind: "email" } },
        trigger_gives: [v("item", "the email", "email"), TITLE, COUNT],
        steps: [{ id: "s1", title: null, kind: "notify", text: ["New email: ", { from: "trigger", key: "title" }] }],
        assistant_id: null,
      },
    },
  };
}
