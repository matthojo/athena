/**
 * Add a step (mockup 5): the catalogue in its groups (find, add, decide,
 * tell me, assistants and Team), with a search. Thinking needs an
 * assistant; a branch can't go deeper than FLOW_LIMITS.depth. Picking one
 * opens its settings (step-sheet.ts).
 */
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import type { CatalogEntry } from "../../../lib/flow-types";
import { flowIcon, tile, stepIconName } from "./parts";
import { GROUPS, searchCatalog, unavailable } from "./steps";

export interface AddStepOptions {
  catalog: readonly CatalogEntry[];
  /** "After “Find what I paid last year”", "At the start", "In “If so”". */
  where: string;
  hasAssistant: boolean;
  canBranch: boolean;
  onPick: (entry: CatalogEntry) => void;
  /** Hand the flow to an assistant, from the locked thinking row. */
  onHand?: () => void;
}

const toneOf = (e: CatalogEntry) => (e.kind === "think" || e.kind === "assignment" ? "think" : e.kind === "ask" ? "you" : "step");

export function openAddStep(o: AddStepOptions): void {
  const q = h("input", { class: "flow-search__input", type: "search", placeholder: "Search steps", "aria-label": "Search steps", autocomplete: "off" }) as HTMLInputElement;
  const groups = h("div", { class: "flow-add" });
  const body = h("div", { class: "flow-sheet" }, h("p", { class: "flow-sheet__where" }, o.where), h("label", { class: "flow-search" }, flowIcon("search"), q), groups);
  const sheet = openSheet({ label: "Add a step", title: "Add a step", body, variant: "tall" });

  const row = (e: CatalogEntry) => {
    const why = unavailable(e, { hasAssistant: o.hasAssistant, canBranch: o.canBranch });
    const b = h(
      "button",
      { class: "flow-add__opt", type: "button", "aria-disabled": why && !(e.needsAssistant && o.onHand) ? "true" : undefined },
      tile(toneOf(e), stepIconName({ kind: e.kind, tool: e.tool }), "md"),
      h("span", { class: "flow-add__text" }, h("b", {}, e.label), h("small", {}, why ?? e.hint)),
      e.money || why ? h("span", { class: "flow-add__lock", title: e.money ? "Reads your spending" : (why ?? "") }, flowIcon("lock")) : null
    );
    b.addEventListener("click", () => {
      if (why) {
        if (e.needsAssistant && o.onHand) {
          sheet.close();
          o.onHand();
        }
        return;
      }
      sheet.close();
      o.onPick(e);
    });
    return b;
  };

  const paint = () => {
    const found = searchCatalog(o.catalog, q.value);
    const out: Node[] = [];
    for (const g of GROUPS) {
      const items = found.filter((e) => e.group === g.group);
      if (!items.length) continue;
      out.push(h("h3", { class: "flow-add__group" }, g.label), h("div", { class: "flow-add__list" }, ...items.map(row)));
    }
    if (!out.length) out.push(h("p", { class: "flow-add__none" }, `No step matches “${q.value.trim()}”.`));
    groups.replaceChildren(...out);
  };
  q.addEventListener("input", paint);
  paint();
}
