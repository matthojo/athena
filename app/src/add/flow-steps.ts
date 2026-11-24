/**
 * A shared flow's trigger and every step, drawn as the flow editor draws them (flows/editor.ts, styles/flows.css)
 * but read-only: the same tiles, colours, value chips and branch lanes. A blank (`{ "blank": key }`) shows as a
 * gap named by its question, so the owner can see where their answer goes. Every step that changes something says
 * it waits for the owner's Go.
 */
import "../styles/flows.css";
import { h } from "../lib/dom";
import { badge, chip, flowIcon, givesRow, stepTile, triggerTile } from "../flows/parts";
import { BRANCH_WORDS, conditionWords, stepTitle, triggerTitle } from "../flows/words";
import { triggerGives } from "../../../lib/flow-trigger-gives";
import type { FlowStep, FlowValue, ValueRef } from "../../../lib/flow-types";
import type { SharedFlow, SharedFlowStep, SharedText } from "../../../lib/flow-share";
import { changesSomething, goWords } from "./words";

/** Words, value chips and blanks, in order. */
function sharedText(t: SharedText, label: (r: ValueRef) => FlowValue, askOf: (key: string) => string): HTMLElement {
  return h(
    "span",
    { class: "flow-text" },
    ...t.map((p) => {
      if (typeof p === "string") return p;
      if ("blank" in p) return h("span", { class: "add-blank", title: askOf(p.blank) }, h("span", { class: "visually-hidden" }, "Your answer to: "), askOf(p.blank));
      return chip(label(p));
    })
  );
}

/** A step's tile and title as the editor would give them: the step's file shape is close enough to read. */
const asStep = (s: SharedFlowStep) => s as unknown as FlowStep;

export function sharedFlowSteps(flow: SharedFlow): HTMLElement {
  const gives = new Map<string, FlowValue[]>();
  const walk = (steps: SharedFlowStep[]) => {
    for (const s of steps) {
      if (s.kind === "tool" || s.kind === "think") gives.set(s.id, s.gives);
      if (s.kind === "check") (walk(s.yes), walk(s.no));
      if (s.kind === "ask") s.choices.forEach((c) => walk(c.steps));
    }
  };
  walk(flow.steps);
  const fromTrigger = triggerGives(flow.trigger);
  const label = (r: ValueRef): FlowValue => (r.from === "trigger" ? fromTrigger.find((v) => v.key === r.key) : gives.get(r.from)?.find((v) => v.key === r.key)) ?? { key: r.key, label: r.key.replace(/_/g, " "), kind: "text" };
  const askOf = (key: string) => flow.asks.find((a) => a.key === key)?.question ?? key;
  const text = (t: SharedText) => sharedText(t, label, askOf);
  const wire = () => h("div", { class: "flow-wire", "aria-hidden": "true" });

  function body(s: SharedFlowStep): Node | null {
    switch (s.kind) {
      case "tool": {
        const filled = Object.values(s.input).filter((t) => t.length);
        return filled.length ? h("span", { class: "add-step__inputs" }, ...filled.map(text)) : null;
      }
      case "check": {
        const right = s.condition.right;
        const parts: SharedText = [s.condition.left];
        const words = conditionWords({ ...s.condition, right: right && typeof right === "object" && "blank" in right ? undefined : (right as ValueRef | string | number | undefined) } as Parameters<typeof conditionWords>[0], (r) => label(r).label);
        // The condition's words, with its left value as a chip and a blank as its gap.
        const leftWords = label(s.condition.left).label;
        const rest = words.startsWith(leftWords) ? words.slice(leftWords.length) : ` ${words}`;
        parts.push(rest);
        if (right && typeof right === "object" && "blank" in right) parts.push(" ", right);
        return text(parts);
      }
      case "ask":
        return text(s.question);
      case "wait": {
        const at = s.at ? ` at ${s.at}` : "";
        if (s.before) return text([`Until ${s.days === 0 ? "the day of" : `${s.days} ${s.days === 1 ? "day" : "days"} before`} `, s.before, at]);
        return h("span", {}, `For ${s.days} ${s.days === 1 ? "day" : "days"}${at}`);
      }
      case "notify":
        return text(s.text);
      case "think":
        return text(s.task);
      case "assignment":
        return text(s.brief);
    }
  }

  function card(s: SharedFlowStep): HTMLElement {
    const metas: Node[] = [];
    if (s.kind === "think") metas.push(h("span", { class: "flow-card__meta" }, flowIcon("sparkle"), `${s.web ? "Asks to search the web · " : ""}A thinking step: it needs an assistant to run`));
    if (s.kind === "ask") metas.push(h("span", { class: "flow-card__meta" }, `${s.choices.length} choices · waits for your answer`));
    if (s.kind === "assignment") metas.push(h("span", { class: "flow-card__meta" }, "Starts an assignment. Its lineup waits for your Go"));
    if (s.kind === "tool" && (s.tool === "money" || s.tool === "regular_payments")) metas.push(h("span", { class: "flow-card__meta" }, flowIcon("lock"), "Reads your spending. Off until you allow it on the flow"));
    const go = goWords(s);
    if (go) metas.push(h("span", { class: "flow-card__meta" }, go));
    const tag = changesSomething(s) ? badge({ tone: "you", words: "Waits for your Go" }) : null;
    const title = stepTitle(asStep(s));
    const el = h(
      "div",
      { class: `flow-card flow-card--${s.kind === "think" ? "think" : "step"} add-step` },
      h("span", { class: "flow-card__node" }, stepTile(asStep(s)), h("span", { class: "flow-card__main" }, h("span", { class: "flow-card__title" }, title), body(s) ? h("span", { class: "flow-card__body" }, body(s)) : null, ...metas, tag))
    );
    const g = s.kind === "tool" || s.kind === "think" ? givesRow(s.gives) : null;
    return g ? h("div", { class: "flow-card-wrap add-step-wrap" }, el, g) : el;
  }

  function lane(s: SharedFlowStep, labelText: string, tone: "yes" | "no" | "choice", steps: SharedFlowStep[]): HTMLElement {
    return h(
      "div",
      { class: "flow-lane", role: "group", "aria-label": labelText },
      h("span", { class: `flow-lane__label flow-lane__label--${tone}` }, h("span", { class: "flow-lane__dot", "aria-hidden": "true" }), labelText),
      ...(steps.length ? list(steps) : [h("p", { class: "flow-lane__empty" }, "Nothing on this path")])
    );
  }

  function list(steps: SharedFlowStep[]): Node[] {
    const out: Node[] = [];
    steps.forEach((s, i) => {
      if (i) out.push(wire());
      out.push(card(s));
      if (s.kind === "check") out.push(wire(), h("div", { class: "flow-lanes" }, lane(s, BRANCH_WORDS.yes, "yes", s.yes), lane(s, BRANCH_WORDS.no, "no", s.no)));
      if (s.kind === "ask") out.push(wire(), h("div", { class: "flow-lanes" }, ...s.choices.map((c) => lane(s, `If you say “${c.label}”`, "choice", c.steps))));
    });
    return out;
  }

  const trigger = h(
    "div",
    { class: "flow-card add-step add-step--trigger" },
    h("span", { class: "flow-card__node" }, triggerTile(flow.trigger), h("span", { class: "flow-card__main" }, h("span", { class: "flow-card__title" }, triggerTitle(flow.trigger)), flow.trigger.kind === "manual" ? h("span", { class: "flow-card__meta" }, "Only when you tap Run now") : flow.trigger.kind === "schedule" ? h("span", { class: "flow-card__meta" }, "In your time zone") : null))
  );
  const tg = givesRow(fromTrigger);
  return h(
    "div",
    { class: "add-flow" },
    h("span", { class: "flow-eyebrow" }, "When"),
    tg ? h("div", { class: "flow-card-wrap add-step-wrap" }, trigger, tg) : trigger,
    wire(),
    h("span", { class: "flow-eyebrow" }, "Then"),
    h("div", { class: "add-flow__steps" }, ...list(flow.steps))
  );
}
