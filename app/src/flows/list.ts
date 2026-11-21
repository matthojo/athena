/**
 * Flows (mockup 1): how today went in one line, what Athena noticed you do
 * by hand (Make it a flow · No thanks), then your flows, each with its trigger,
 * its shape, who runs it and how its last run went.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { pageHead } from "../components/page-head";
import { showToast } from "../components/toast";
import { createFlow, dismissSuggestion, listFlows, listSuggestions, onFlowsChange, type Flow, type FlowListResponse, type FlowSuggestion } from "../db/flows";
import { listTeam, type TeamAssistant } from "../db/team";
import { chain, tile } from "./parts";
import { flowCard } from "./card";
import { listLede } from "./words";
import { isJobFlow } from "../db/flows";
import { STARTERS } from "./new-sheet";

export interface ListContext {
  open: (id: string) => void;
  openNew: (text?: string) => void;
}

export function renderFlowList(ctx: ListContext): { el: HTMLElement; destroy: () => void } {
  const count = h("span", { class: "page-count", hidden: true });
  const newBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), h("span", {}, "New"));
  newBtn.addEventListener("click", () => ctx.openNew());
  const lede = h("p", { class: "page-lede" }, "A flow does the same few things for you each time something happens.");
  const sugs = h("div", { class: "flow-sugs" });
  const list = h("div", { class: "flow-list", "aria-busy": "true" });
  const el = h("div", { class: "view flows flows--list" }, pageHead({ title: "Flows", count, actions: [newBtn], lede }), sugs, list);
  let alive = true;
  let team: TeamAssistant[] = [];
  let data: FlowListResponse | null = null;

  function suggestion(s: FlowSuggestion): HTMLElement {
    const make = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Make it a flow");
    const later = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "No thanks");
    const card = h(
      "section",
      { class: "card flow-sug", "aria-label": s.title },
      h("div", { class: "flow-sug__head" }, tile("think", "sparkle", "lg"), h("div", {}, h("p", { class: "flow-sug__title" }, s.title), h("p", { class: "flow-sug__why" }, `${s.why} Want Athena to do it for you?`))),
      h("div", { class: "flow-sug__shape" }, chain({ trigger: s.flow.trigger, steps: s.flow.steps }, 4), h("span", { class: "flow-sug__name" }, s.flow.name)),
      h("div", { class: "flow-sug__acts" }, make, later)
    );
    make.addEventListener("click", async () => {
      make.disabled = later.disabled = true;
      try {
        const f = await createFlow({ ...s.flow, paused: true, origin: "suggestion" });
        void dismissSuggestion(s.id).catch(() => undefined);
        ctx.open(f.id);
      } catch (e) {
        make.disabled = later.disabled = false;
        showToast(e instanceof Error && e.message ? `Couldn't make it: ${e.message}` : "Couldn't make it. Try again.");
      }
    });
    // No thanks means never again (owner, 21 Nov 2026).
    later.addEventListener("click", async () => {
      card.remove();
      try {
        await dismissSuggestion(s.id);
        showToast("Athena won't suggest that one again.");
      } catch {
        // It may come back next time: nothing lost.
      }
    });
    return card;
  }

  function empty(): HTMLElement {
    return h(
      "div",
      { class: "flow-empty" },
      h("p", { class: "flow-empty__title" }, "No flows yet"),
      h("p", { class: "flow-empty__sub" }, "Start with when something happens, then say what Athena should do. For example:"),
      h(
        "div",
        { class: "flow-new__starters" },
        ...STARTERS.map((s) => {
          const b = h("button", { class: "flow-new__start", type: "button" }, tile("trigger", s.icon, "md"), h("span", {}, s.text));
          b.addEventListener("click", () => ctx.openNew(s.text));
          return b;
        })
      )
    );
  }

  function paint() {
    if (!data) return;
    const { flows, latest, max } = data;
    count.hidden = !flows.length;
    count.textContent = String(flows.length);
    lede.textContent = listLede(flows, latest);
    // An assistant's triggers are flows too (lib/team-flows.ts), counted toward its own limit, not this one.
    newBtn.disabled = flows.filter((f) => !isJobFlow(f)).length >= max;
    newBtn.title = flows.length >= max ? `You have ${max} flows, the most Athena keeps.` : "";
    list.removeAttribute("aria-busy");
    if (!flows.length) return void list.replaceChildren(empty());
    // What waits for you first, then the newest runs.
    const order = (f: Flow) => {
      const r = latest[f.id];
      const waits = r?.status === "waiting" && !r.dry && (r.waits_for === "go" || r.waits_for === "answer") ? 0 : 1;
      return [waits, -(Date.parse(f.last_run_at ?? f.created_at) || 0)] as const;
    };
    const sorted = [...flows].sort((a, b) => {
      const [wa, ta] = order(a);
      const [wb, tb] = order(b);
      return wa - wb || ta - tb;
    });
    list.replaceChildren(h("h2", { class: "flow-sec__title" }, "Your flows"), ...sorted.map((f) => flowCard(f, latest[f.id], { assistant: team.find((a) => a.id === f.assistant_id) ?? null, open: () => ctx.open(f.id) })));
  }

  async function load() {
    try {
      const [d, t] = await Promise.all([listFlows(), listTeam().catch(() => [] as TeamAssistant[])]);
      if (!alive) return;
      data = d;
      team = t;
      paint();
    } catch {
      if (alive) {
        list.removeAttribute("aria-busy");
        list.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Your flows didn't load"), h("p", { class: "empty__sub" }, "Flows need a connection to your Athena. Check you're online and try again.")));
      }
    }
    // Suggestions are a nice-to-have: if they don't come, the page is the same without them.
    listSuggestions()
      .then((s) => alive && sugs.replaceChildren(...s.slice(0, 2).map(suggestion)))
      .catch(() => undefined);
  }

  const off = onFlowsChange(() => {
    void listFlows()
      .then((d) => {
        if (!alive) return;
        data = d;
        paint();
      })
      .catch(() => undefined);
  });

  void load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
