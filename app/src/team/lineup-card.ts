/**
 * The lineup card (docs/team.md "How it runs" → Lineup): who works on an
 * assignment, in order. The owner reorders, swaps, removes, sets each
 * checkpoint (or one of the three presets) and whether questions take the
 * suggested answer, then taps Go. Nothing runs before Go. Used by New
 * assignment (team/new-assignment.ts) and Ask's start_assignment card.
 */
import "../styles/team-assign.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { listTeam, type TeamAssistant } from "../db/team";
import { startAssignment, type Assignment } from "../db/assignments";
import { avatarFromSeed, renderAvatarTile } from "./avatar";
import { applyPreset, canRemove, CHECKPOINT_WORD, guestSeed, LAST_STAGE_NOTE, lineupProblem, lineupWho, moveStage, presetOf, PRESETS, removeStage, ROLE_NAME, setCheckpoint, swapStage } from "./assign-words";
import { ROLE_KEYS, type Lineup, type RoleKey } from "../../../lib/assignment-types";

export interface LineupCardOptions {
  lineup: Lineup;
  /** The plain lineup, when the model's didn't check out. */
  fallback?: boolean;
  /** The draft the server keeps this lineup as (Ask's start_assignment): Go starts that one. */
  draftId?: string | null;
  /** Already started (Ask's card, reopened): the card only says so. */
  startedId?: string | null;
  /** Each edit, so whoever holds the card can keep it. */
  onChange?: (l: Lineup) => void;
  onStarted?: (a: Assignment) => void;
}

/** A line saying it started, with the way to its page. */
function startedEl(id: string, title: string): HTMLElement {
  return h("section", { class: "card lineup lineup--started", "aria-label": "Assignment started" }, h("p", { class: "lineup__title" }, title), h("p", { class: "lineup__note" }, "Started. The stages post in Team chat as they go."), h("a", { class: "btn btn--soft btn--sm", href: `#/team/assignment/${encodeURIComponent(id)}` }, "Open the assignment"));
}

export function lineupCard(o: LineupCardOptions): HTMLElement {
  if (o.startedId) return startedEl(o.startedId, o.lineup.title);
  let l = structuredClone(o.lineup);
  let team: TeamAssistant[] = [];
  let going = false;
  const el = h("section", { class: "card lineup", "aria-label": "Lineup" });
  const said = h("p", { class: "visually-hidden", "aria-live": "polite" });

  const set = (next: Lineup, words?: string, focus?: string) => {
    l = next;
    o.onChange?.(structuredClone(l));
    paint();
    if (words) said.textContent = words;
    if (focus) el.querySelector<HTMLElement>(focus)?.focus();
  };

  function stageRow(i: number): HTMLElement {
    const s = l.stages[i];
    const last = i === l.stages.length - 1;
    const standing = s.assistant_id ? team.find((t) => t.id === s.assistant_id) : null;
    const who = lineupWho(standing ? { ...s, name: standing.name, job: standing.job } : s);
    const tile = renderAvatarTile(standing?.avatar ?? avatarFromSeed(s.seed ?? guestSeed(s)), { size: 40, animate: false });
    const up = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Move ${who.name} earlier`, "data-up": i, disabled: i === 0 }, icons.arrowUp());
    const down = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Move ${who.name} later`, "data-down": i, disabled: last }, icons.arrowDown());
    up.addEventListener("click", () => set(moveStage(l, i, i - 1), `${who.name} is now stage ${i}.`, `[data-up="${i - 1}"]:not(:disabled), [data-down="${i - 1}"]`));
    down.addEventListener("click", () => set(moveStage(l, i, i + 1), `${who.name} is now stage ${i + 2}.`, `[data-down="${i + 1}"]:not(:disabled), [data-up="${i + 1}"]`));
    const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove ${who.name}`, disabled: !canRemove(l) }, icons.close());
    remove.addEventListener("click", () => set(removeStage(l, i), `${who.name} removed.`, ".lineup__stage select"));

    // Swap: another role's guest, or one of your own assistants.
    const swap = h(
      "select",
      { class: "lineup__swap", "aria-label": `Swap ${who.name} for` },
      h("option", { value: "" }, "Swap…"),
      h("optgroup", { label: "A guest" }, ...ROLE_KEYS.filter((r) => r !== "custom" && (r !== s.role || !!s.assistant_id)).map((r) => h("option", { value: `role:${r}` }, ROLE_NAME[r]))),
      team.length ? h("optgroup", { label: "Your team" }, ...team.filter((t) => t.id !== s.assistant_id).map((t) => h("option", { value: `team:${t.id}` }, t.name))) : null
    ) as HTMLSelectElement;
    swap.addEventListener("change", () => {
      const [kind, id] = swap.value.split(":");
      const t = kind === "team" ? team.find((x) => x.id === id) : null;
      if (kind === "role") set(swapStage(l, i, { role: id as RoleKey }), `Stage ${i + 1} is now a guest ${ROLE_NAME[id as RoleKey]}.`);
      else if (t) set(swapStage(l, i, { assistant_id: t.id, name: t.name, job: t.job }), `Stage ${i + 1} is now ${t.name}.`);
      el.querySelectorAll<HTMLElement>(".lineup__swap")[i]?.focus();
    });

    const check = last
      ? h("span", { class: "lineup__check lineup__check--fixed" }, LAST_STAGE_NOTE)
      : (() => {
          const b = h("button", { class: "lineup__check", type: "button", "aria-pressed": String(s.checkpoint === "approve"), "aria-label": `After ${who.name}: ${CHECKPOINT_WORD[s.checkpoint]}` }, h("span", { class: "lineup__check-mark", "aria-hidden": "true" }), CHECKPOINT_WORD[s.checkpoint]);
          b.addEventListener("click", () => set(setCheckpoint(l, i, s.checkpoint === "approve" ? "auto" : "approve"), undefined, `.lineup__stage:nth-child(${i + 1}) .lineup__check`));
          return b;
        })();

    return h(
      "li",
      { class: "lineup__stage" },
      h("span", { class: "lineup__n", "aria-hidden": "true" }, String(i + 1)),
      tile,
      h("span", { class: "lineup__who" }, h("span", { class: "lineup__name" }, who.name), h("span", { class: "lineup__sub" }, who.line)),
      h("span", { class: "lineup__move" }, up, down, remove),
      h("p", { class: "lineup__task" }, s.task),
      h("span", { class: "lineup__set" }, check, swap)
    );
  }

  function paint() {
    const preset = presetOf(l);
    const presets = h(
      "div",
      { class: "lineup__presets", role: "radiogroup", "aria-label": "When to check with you" },
      ...PRESETS.map((p) => {
        const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(preset === p.key), "aria-pressed": String(preset === p.key) }, p.label);
        b.addEventListener("click", () => set(applyPreset(l, p.key), undefined, `.lineup__presets [role="radio"]:nth-child(${PRESETS.indexOf(p) + 1})`));
        return b;
      })
    );
    const take = l.suggestions === "take";
    const sugg = h(
      "div",
      { class: "lineup__presets", role: "radiogroup", "aria-label": "When a stage has a question" },
      ...(
        [
          ["ask", "Ask me"],
          ["take", "Use its suggested answer"],
        ] as const
      ).map(([key, label], n) => {
        const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(l.suggestions === key), "aria-pressed": String(l.suggestions === key) }, label);
        b.addEventListener("click", () => set({ ...l, suggestions: key }, undefined, `.lineup__sugg [role="radio"]:nth-child(${n + 1})`));
        return b;
      })
    );
    sugg.classList.add("lineup__sugg");
    const problem = lineupProblem(l);
    const goBtn = h("button", { class: "btn btn--primary lineup__go", type: "button", disabled: going || !!problem }, going ? "Starting…" : "Approve") as HTMLButtonElement;
    goBtn.addEventListener("click", async () => {
      going = true;
      paint();
      try {
        const a = await startAssignment(l, o.draftId);
        o.onStarted?.(a);
        el.replaceWith(startedEl(a.id, a.title));
      } catch (e) {
        showToast(e instanceof Error && e.message && !/^\d{3} /.test(e.message) ? e.message : "That didn't start. Try again in a moment.", { icon: "refresh" });
        going = false;
        paint();
      }
    });
    const parts: Array<HTMLElement | null> = [
      h("p", { class: "plan__head lineup__head" }, icons.team(), "The lineup"),
      h("p", { class: "lineup__title" }, l.title),
      o.fallback ? h("p", { class: "lineup__note" }, "This is a plain lineup. Athena couldn't fit one to the brief this time, so check it over.") : null,
      h("ol", { class: "lineup__stages" }, ...l.stages.map((_, i) => stageRow(i))),
      h("div", { class: "lineup__choice" }, h("p", { class: "lineup__label" }, "When to check with you"), presets),
      h("div", { class: "lineup__choice" }, h("p", { class: "lineup__label" }, "When a stage has a question"), sugg, take ? h("p", { class: "lineup__note" }, "A change still waits for your approval.") : null),
      h("div", { class: "lineup__foot" }, h("p", { class: "lineup__note" }, problem ?? "Nothing runs until you tap Approve."), goBtn),
      said,
    ];
    el.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  paint();
  void listTeam().then(
    (t) => {
      team = t;
      if (el.isConnected || !going) paint();
    },
    () => undefined
  );
  return el;
}
