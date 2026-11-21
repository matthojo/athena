/**
 * A flow's card, on the Flows list and on an assistant's page: its name and
 * badge, what starts it, its shape, who runs it, and how its last run went.
 */
import { h } from "../lib/dom";
import type { Flow, FlowRun } from "../../../lib/flow-types";
import type { TeamAssistant } from "../../../lib/team-types";
import { badge, chain, face } from "./parts";
import { flowBadge, lastRunLine, triggerWords } from "./words";

/** For the Flows list and an assistant's page: a flow's card. */
export function flowCard(f: Flow, latest: FlowRun | undefined, o: { assistant?: TeamAssistant | null; open: () => void; compact?: boolean }): HTMLElement {
  const who = o.assistant ? h("span", { class: "flow-row__who" }, face(o.assistant.avatar, 22), `${o.assistant.name} runs this`) : h("span", { class: "flow-row__who" }, "Plain flow");
  const b = h(
    "button",
    { class: `card flow-row${o.compact ? " flow-row--compact" : ""}`, type: "button" },
    h("span", { class: "flow-row__head" }, h("span", { class: "flow-row__name" }, f.name), badge(flowBadge(f, latest))),
    h("span", { class: "flow-row__when" }, triggerWords(f.trigger)),
    h("span", { class: "flow-row__shape" }, chain(f), o.compact ? null : who),
    o.compact ? null : h("span", { class: "flow-row__last" }, lastRunLine(latest))
  );
  b.addEventListener("click", o.open);
  return b;
}
