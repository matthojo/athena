/**
 * On an assistant's page (mockup 10): "<Name>'s flows", each as a card, and
 * Give <Name> a flow. Hidden until the flows load; quiet if they don't.
 */
import "../styles/flows.css";
import { h } from "../lib/dom";
import { listFlows, onFlowsChange, type FlowListResponse } from "../db/flows";
import type { TeamAssistant } from "../../../lib/team-types";
import { flowCard } from "./card";
import { flowIcon } from "./parts";
import { openGiveSheet } from "./hand-sheet";

export function assistantFlowsSection(get: () => TeamAssistant | undefined, alive: () => boolean): { el: HTMLElement; paint: () => void; destroy: () => void } {
  const title = h("h2", { class: "td-sec__title flow-sec__title" });
  const list = h("div", { class: "flow-list flow-list--compact" });
  const give = h("button", { class: "flow-give-btn", type: "button" }, flowIcon("plus"), h("span", {}));
  const el = h("section", { class: "td-sec flow-asst", hidden: true }, title, list, give);
  let data: FlowListResponse | null = null;

  give.addEventListener("click", () => {
    const a = get();
    if (!a) return;
    openGiveSheet({
      assistant: a,
      onGiven: (f) => (location.hash = `#/flows/${encodeURIComponent(f.id)}`),
      onNew: () => (location.hash = "#/flows/new"),
    });
  });

  function paint() {
    const a = get();
    if (!a || !data) return;
    const mine = data.flows.filter((f) => f.assistant_id === a.id);
    title.textContent = `${a.name}'s flows`;
    give.lastElementChild!.textContent = `Give ${a.name} a flow`;
    list.replaceChildren(
      ...(mine.length
        ? mine.map((f) => flowCard(f, data!.latest[f.id], { compact: true, open: () => (location.hash = `#/flows/${encodeURIComponent(f.id)}`) }))
        : [h("p", { class: "flow-note" }, `${a.name} doesn't run any flows yet. A flow keeps its steps, and ${a.name} can think between them.`)])
    );
    el.hidden = false;
  }

  const load = () =>
    listFlows()
      .then((d) => {
        if (!alive()) return;
        data = d;
        paint();
      })
      .catch(() => undefined);
  const off = onFlowsChange(() => void load());
  void load();
  return { el, paint, destroy: off };
}
