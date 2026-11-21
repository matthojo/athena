/**
 * Ask's flow card (mockup 2, "Ask makes a flow"): the flow propose_flow drew
 * (lib/flow-draft-ask.ts), kept paused. Its trigger and steps as a mini
 * vertical flow, each value a chip, branches indented under their check or
 * question, and two ways on: Turn on (PATCH /api/flows/<id> { paused: false })
 * and Edit steps (#/flows/<id>). Turned on, it says so and offers Turn off.
 *
 * Sample mode's flows are made up here too (sampleFlowReply), so Ask's sample
 * stand-in can show the card without a server.
 */
import "../styles/ask-flow-card.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { ApiError, isSampleMode, request } from "../db/api";
import type { AskFlowCard, FlowStep, FlowTrigger } from "../../../lib/flow-types";
import type { AssistantChange } from "../types";
import { stepParts, triggerWords, valueLabels, type WordPart } from "../../../lib/flow-draft-words";
import { sampleFlow } from "../../../lib/flow-draft-sample";

export { FLOW_WORDS } from "../../../lib/flow-draft-words";

/** A flow card as the conversation keeps it: whether it's been turned on here since. */
export type KeptFlowCard = AskFlowCard & { on?: boolean };

export interface AskFlowCardOptions {
  card: KeptFlowCard;
  /** Each time it's turned on or off here, so the conversation keeps it. */
  onChange?: (on: boolean) => void;
}

function triggerIcon(t: FlowTrigger): IconName {
  switch (t.kind) {
    case "schedule":
      return "clock";
    case "before":
      return "calendar";
    case "manual":
      return "play";
    case "event":
      return t.event.source === "saved" ? "bookmark" : t.event.source === "note" ? "note" : "mail";
  }
}

function stepIcon(s: FlowStep): IconName {
  switch (s.kind) {
    case "tool":
      if (s.tool === "add_reminder") return "bell";
      if (s.tool === "add_todo" || s.tool === "add_to_list") return "check";
      return s.go === "auto" && /^(find|money|regular_payments|weather|trips|purchases|flight_status|train_status)/.test(s.tool) ? "search" : "pen";
    case "check":
      return "sliders";
    case "ask":
      return "chat";
    case "wait":
      return "hourglass";
    case "notify":
      return "bell";
    case "think":
      return "sparkle";
    case "assignment":
      return "team";
  }
}

/** A line's words, each value a chip. */
function words(parts: WordPart[]): HTMLElement {
  return h("span", { class: "flowcard__words" }, ...parts.map((p) => (typeof p === "string" ? p : h("span", { class: "flowcard__chip" }, p.chip))));
}

function tile(icon: IconName, tone: "trigger" | "step" | "think"): HTMLElement {
  const t = h("span", { class: `flowcard__tile flowcard__tile--${tone}`, "aria-hidden": "true" });
  t.append(icons[icon]());
  return t;
}

function stepList(steps: FlowStep[], labels: Map<string, string>): HTMLElement {
  const list = h("ol", { class: "flowcard__list" });
  for (const s of steps) {
    const row = h("li", { class: "flowcard__row" }, tile(stepIcon(s), s.kind === "think" ? "think" : "step"), h("span", { class: "flowcard__line" }, words(stepParts(s, labels)), s.kind === "tool" && s.go === "ask" ? h("span", { class: "flowcard__go" }, "Waits for your Go") : null));
    list.append(row);
    const branches: Array<[string, FlowStep[]]> = s.kind === "check" ? [["Yes", s.yes], ["No", s.no]] : s.kind === "ask" ? s.choices.map((c) => [c.label, c.steps]) : [];
    for (const [label, inner] of branches) {
      if (!inner.length) continue;
      list.append(h("li", { class: "flowcard__branch" }, h("span", { class: "flowcard__branch-label" }, label), stepList(inner, labels)));
    }
  }
  return list;
}

export function askFlowCard(o: AskFlowCardOptions): HTMLElement {
  const { flow, flow_id } = o.card;
  let on = o.card.on === true;
  let busy = false;
  const labels = valueLabels(flow.trigger_gives, flow.steps);
  const el = h("section", { class: "card flowcard", "aria-label": `Flow: ${flow.name}` });
  const status = h("p", { class: "flowcard__status", "aria-live": "polite" });
  const toggle = h("button", { class: "btn btn--sm", type: "button" });
  const edit = h("a", { class: "btn btn--soft btn--sm", href: `#/flows/${encodeURIComponent(flow_id)}` }, "Edit steps");
  const eyebrow = h("span", { class: "flowcard__eyebrow" });

  const paint = () => {
    eyebrow.textContent = on ? "Flow · on" : "New flow";
    el.classList.toggle("flowcard--on", on);
    toggle.textContent = on ? "Turn off" : "Turn on";
    toggle.className = `btn btn--sm ${on ? "btn--soft" : "btn--primary"}`;
    toggle.disabled = busy;
    status.textContent = on ? "On. You can turn it off here or in Flows." : "Off until you turn it on.";
  };

  toggle.addEventListener("click", async () => {
    if (busy) return;
    const next = !on;
    busy = true;
    paint();
    try {
      if (!isSampleMode()) await request(`/flows/${encodeURIComponent(flow_id)}`, { method: "PATCH", body: JSON.stringify({ paused: !next }) });
      on = next;
      o.onChange?.(on);
      showToast(next ? (isSampleMode() ? "Turned on. In sample mode nothing runs." : `${flow.name} is on.`) : `${flow.name} is off.`, { icon: "check" });
    } catch (error) {
      const gone = error instanceof ApiError && error.status === 404;
      showToast(gone ? "That flow isn't there any more." : `Couldn't turn it ${next ? "on" : "off"}. Try again.`, { icon: "close" });
    } finally {
      busy = false;
      paint();
    }
  });

  const head = h(
    "div",
    { class: "flowcard__head" },
    h("div", { class: "flowcard__title" }, eyebrow, h("span", { class: "flowcard__name" }, flow.name)),
    h("span", { class: "flowcard__meta" }, flow.assistant_id ? "Run by an assistant" : "No AI credits"),
  );
  const trigger = h("ol", { class: "flowcard__list flowcard__list--top" }, h("li", { class: "flowcard__row" }, tile(triggerIcon(flow.trigger), "trigger"), h("span", { class: "flowcard__line" }, words([triggerWords(flow.trigger)]))));
  const steps = flow.steps.length ? stepList(flow.steps, labels) : h("p", { class: "flowcard__empty" }, "No steps yet. Add them in Edit steps.");
  el.append(head, h("div", { class: "flowcard__flow" }, trigger, steps), status, h("div", { class: "flowcard__actions" }, toggle, edit));
  paint();
  return el;
}

// ---------- sample mode ----------

/**
 * Sample mode's reply to a "whenever…" message (lib/flow-draft-sample.ts), with the one-off a parcel flow does now
 * as a receipt, as mockup 2 shows. Made up; nothing reaches a server.
 */
export function sampleFlowReply(sentence: string): { text: string; card: KeptFlowCard; changes?: AssistantChange[] } {
  const made = sampleFlow(sentence);
  if (made.kind !== "delivery") return { text: made.text, card: made.card };
  const thursday = new Date();
  thursday.setDate(thursday.getDate() + ((4 - thursday.getDay() + 7) % 7 || 7));
  const day = thursday.toLocaleDateString("en-GB", { weekday: "long" });
  return {
    text: `${made.text}\n\nI've also added one for the parcel already on its way: ${day} at 08:00.`,
    card: made.card,
    changes: [{ kind: "reminder", id: "5a3e0000-0000-4000-8000-000000f10002", action: "created", title: "Parcel from Hartley & Co", detail: `Reminder · ${day}, 08:00`, label: `Parcel from Hartley & Co: Reminder, ${day}, 08:00`, open: null, undo: { op: "sample" } }],
  };
}
