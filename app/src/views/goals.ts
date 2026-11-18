/**
 * Goals: a handful of things you're working towards, each with what "done"
 * looks like and how far along you are. Progress is a slider in the sheet;
 * the weekly review shows every active goal's bar.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { openEditorSheet } from "../components/editor-sheet";
import { autoTextarea, choiceChips, field, input } from "../components/fields";
import { showToast } from "../components/toast";
import { customFieldsSection } from "../components/custom-fields";
import { deleteMemoryForever, loadGoals, onMemoryChange, saveGoal, setMemoryArchived } from "../db/memory";
import { calendarDate, inDays, relativeTime } from "../lib/format";
import { daysBetween } from "../../../lib/dates";
import { localToday } from "../lib/time";
import type { Goal, GoalPeriod } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

const PERIOD: Record<GoalPeriod, string> = { week: "This week", month: "This month", quarter: "This quarter", year: "This year" };

export function openGoalSheet(initial: Goal | null): void {
  let rec = initial;
  const period = choiceChips<GoalPeriod>(
    "Period",
    (["week", "month", "quarter", "year"] as GoalPeriod[]).map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) })),
    initial?.period ?? "quarter",
    (p) => rec && save({ period: p })
  );
  const target = input("text", initial?.target ?? "", { placeholder: "What done looks like", autocomplete: "off" });
  const due = input("date", initial?.due_on ?? "", { "aria-label": "Due" });
  const progress = h("input", { class: "range", type: "range", min: 0, max: 100, step: 5, "aria-label": "Progress" }) as HTMLInputElement;
  progress.value = String(initial?.progress ?? 0);
  const pct = h("span", { class: "range__value" }, `${progress.value}%`);
  progress.addEventListener("input", () => {
    pct.textContent = `${progress.value}%`;
    progress.style.setProperty("--p", `${progress.value}%`);
  });
  progress.style.setProperty("--p", `${progress.value}%`);
  const status = choiceChips<Goal["status"]>(
    "Status",
    [
      { value: "active", label: "Active" },
      { value: "done", label: "Done" },
      { value: "dropped", label: "Dropped" },
    ],
    initial?.status ?? "active",
    (s) => rec && save({ status: s })
  );
  const notes = autoTextarea(initial?.notes ?? "", { name: "notes", placeholder: "Why it matters, how it's going", "aria-label": "Notes" }, 56);

  let saving: Promise<void> = Promise.resolve();
  function save(patch: Partial<Goal>) {
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveGoal(patch, rec.id);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }
  target.addEventListener("change", () => rec && save({ target: target.value.trim() }));
  due.addEventListener("change", () => rec && save({ due_on: due.value || null }));
  progress.addEventListener("change", () => rec && save({ progress: Number(progress.value) }));
  notes.addEventListener("change", () => rec && save({ notes: notes.value }));

  const fields = h(
    "div",
    { class: "card card--flush fields" },
    field("Period", period.el),
    field("Target", target),
    field("Due", due),
    field("Progress", progress, pct),
    ...(initial ? [field("Status", status.el)] : []),
    field("Notes", notes)
  );
  // The owner's own fields follow the built-in ones once the goal exists.
  const custom = customFieldsSection("goal");
  custom.attach(fields);
  custom.show(initial?.id ?? null);

  const editor = openEditorSheet({
    newLabel: "New goal",
    isNew: !initial,
    titleValue: initial?.title ?? "",
    placeholder: "What are you working towards?",
    mark: h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.target()),
    sections: [fields],
    onTitle: (title) => save({ title }),
    create: async () => {
      const created = await saveGoal({
        title: editor.title.value.trim(),
        period: period.value(),
        target: target.value.trim(),
        due_on: due.value || null,
        progress: Number(progress.value),
        notes: notes.value,
      });
      await custom.commit(created.id);
      showToast("Goal added", { icon: "target" });
      return true;
    },
    status: () => (rec ? `Updated ${relativeTime(rec.updated_at)}` : ""),
    archive: async () => {
      if (!rec) return;
      const { id } = rec;
      await setMemoryArchived("goal", id, true);
      showToast("Archived", { icon: "archive", action: { label: "Undo", run: () => void setMemoryArchived("goal", id, false) } });
    },
    remove: {
      what: initial ? `“${initial.title}”` : "It",
      run: async () => {
        if (rec) await deleteMemoryForever("goal", rec.id);
      },
    },
  });
  editor.sheet.dialog.addEventListener("close", () => custom.destroy());
}

export function renderGoals(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let items: Goal[] = [];
  let loaded = false;
  const count = h("span", { class: "page-count" });
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  add.addEventListener("click", () => openGoalSheet(null));
  const list = h("div", { class: "notes__list" });
  const el = h(
    "div",
    { class: "view lists goals" },
    pageHead({ segments: librarySegments("goals", ctx.go), title: "Goals", count, actions: [add] }),
    list
  );

  function card(g: Goal): HTMLElement {
    const today = localToday();
    const n = g.due_on ? daysBetween(today, g.due_on) : null;
    const b = h(
      "button",
      { class: "card pressable goal", type: "button", "data-status": g.status },
      h("span", { class: "goal__top" }, h("span", { class: "badge" }, PERIOD[g.period]), g.status !== "active" ? h("span", { class: "badge badge--accent" }, g.status === "done" ? "Done" : "Dropped") : null),
      h("span", { class: "goal__title" }, g.title),
      g.target ? h("span", { class: "goal__target" }, g.target) : null,
      h(
        "span",
        { class: "goal__progress" },
        h("span", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(g.progress), "aria-label": `${g.progress}% done` }, h("span", { class: "meter__fill", style: `--p:${g.progress}%` })),
        h("span", { class: "goal__pct" }, `${g.progress}%`)
      ),
      g.due_on && g.status === "active" ? h("span", { class: "goal__due", "data-tone": n !== null && n < 0 ? "late" : undefined }, n !== null && n < 0 ? `Was due ${calendarDate(g.due_on)}` : `By ${calendarDate(g.due_on)} · ${inDays(n ?? 0)}`) : null
    );
    b.addEventListener("click", () => openGoalSheet(g));
    return b;
  }

  function paint() {
    if (!loaded) return;
    const active = items.filter((g) => g.status === "active");
    const finished = items.filter((g) => g.status !== "active");
    count.textContent = String(active.length);
    if (!items.length) {
      const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Set a goal");
      btn.addEventListener("click", () => openGoalSheet(null));
      list.replaceChildren(
        h("div", { class: "empty" }, h("span", { class: "tile" }, icons.target()), h("p", { class: "empty__title" }, "No goals yet"), h("p", { class: "empty__sub" }, "Two or three is plenty. Each one shows up in your weekly review with how far along it is."), btn)
      );
      return;
    }
    list.replaceChildren(
      ...(active.length ? [h("div", { class: "goal-grid" }, ...active.map(card))] : [h("p", { class: "empty__sub" }, "Nothing active right now.")]),
      ...(finished.length
        ? [
            h(
              "details",
              { class: "group group--done" },
              h("summary", { class: "group__label" }, icons.chevronRight(), "Done and dropped", h("span", { class: "group__count" }, String(finished.length))),
              h("div", { class: "goal-grid" }, ...finished.map(card))
            ),
          ]
        : [])
    );
  }

  async function load() {
    const { items: loadedItems } = await loadGoals();
    items = loadedItems;
    loaded = true;
    paint();
  }

  void load();
  const unsub = onMemoryChange((t) => (t === "goal" || t === "all") && void load());
  return { el, destroy: unsub };
}
