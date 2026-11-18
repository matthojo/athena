/**
 * To do (internally "open loops"): everything in motion — your to-dos (some
 * for someone), what you're waiting on from others — grouped by when it's
 * due, with decisions one filter away. A quick-add line at the top takes the
 * filter's kind; the full sheet adds who and when. Ticked items slide into
 * "Done" for a fortnight, then drop off.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { choiceChips } from "../components/fields";
import { loopRow } from "../components/loop-row";
import { openCommitmentSheet } from "../components/commitment-sheet";
import { showToast } from "../components/toast";
import { dismissSuggested, linkSuggested, personSuggestion } from "../components/person-suggestion";
import { loadTodoPeople, type TodoPeople } from "../db/todo-people";
import { groupLoops, loadCommitments, loadSuggestions, onMemoryChange, openLoops, saveCommitment } from "../db/memory";
import { plural } from "../lib/format";
import { readTodoView, writeTodoView, type GroupBy, type TodoView } from "../lib/todo-view";
import { contextFilterChip, menuChip } from "../components/todo-context-ui";
import { contextById, onContextsChange, contextsSnapshot } from "../db/todo-contexts";
import { filterByContext, groupByContext, type ContextFilter } from "../../../lib/todo-context";
import { localToday } from "../lib/time";
import { flip } from "../lib/finish-motion";
import type { Commitment, CommitmentKind } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

export interface LoopsContext {
  go: (view: ViewId) => void;
}

type Filter = "all" | CommitmentKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "To do" },
  { value: "waiting_on", label: "Waiting on" },
  { value: "decision", label: "Decisions" },
];

const QUICK_PLACEHOLDER: Record<Filter, string> = {
  all: "Add a to-do",
  todo: "Add a to-do",
  i_owe: "Add a to-do",
  waiting_on: "What are you waiting for?",
  decision: "Record a decision",
};

const EMPTY: Record<Filter, { title: string; sub: string }> = {
  all: { title: "Nothing waiting", sub: "Promises from meetings and email land here once you connect a source. Add the next thing on your mind any time." },
  todo: { title: "Nothing to do", sub: "Add what you need to do, and who it's for if it's for someone." },
  i_owe: { title: "Nothing to do", sub: "Add what you need to do, and who it's for if it's for someone." },
  waiting_on: { title: "Not waiting on anyone", sub: "Add what other people have promised you. Athena nudges you when it goes quiet." },
  decision: { title: "No decisions recorded", sub: "Write down what you decided and why, so future you knows." },
};

const GROUP_LABEL: Record<GroupBy, string> = { due: "Due date", area: "Area", where: "Where" };
type ContextView = TodoView;
const readView = readTodoView;
const writeView = writeTodoView;
/** A filter on a context that's since been removed falls back to "any". */
const liveFilter = (f: ContextFilter): ContextFilter => (f && f !== "none" && !contextById(f) ? null : f);

/** "To do" covers both plain to-dos and things you'll do for someone (i_owe). */
const inFilterKind = (filter: Filter, kind: CommitmentKind) =>
  filter === "all" ? kind !== "decision" : filter === "todo" ? kind === "todo" || kind === "i_owe" : kind === filter;

export function renderLoops(ctx: LoopsContext): { el: HTMLElement; destroy: () => void } {
  let items: Commitment[] = [];
  // Who each unlinked to-do names, if anyone (db/todo-people.ts).
  let named: TodoPeople = {};
  let loaded = false;
  let filter: Filter = "all";
  const view = readView();
  const setView = (patch: Partial<ContextView>) => {
    Object.assign(view, patch);
    writeView(view);
    paintBar();
    paint();
  };

  const count = h("span", { class: "page-count" });
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  add.addEventListener("click", () => openCommitmentSheet(null, { kind: filter === "all" ? "todo" : filter }));

  const filters = choiceChips<Filter>("Show", FILTERS, filter, (f) => {
    filter = f;
    quick.placeholder = QUICK_PLACEHOLDER[f];
    paintBar();
    paint();
  });
  // One line that scrolls sideways on a phone, rather than wrapping.
  filters.el.classList.remove("chip-row--wrap");
  filters.el.classList.add("loops__filters");

  // Area and where/how filters (they combine), and how the list is grouped.
  const areaChip = contextFilterChip("area", () => liveFilter(view.area), (v) => setView({ area: v }));
  const whereChip = contextFilterChip("where", () => liveFilter(view.where), (v) => setView({ where: v }));
  const groupChip = menuChip<GroupBy>({
    aria: "Group by",
    value: () => view.group,
    active: () => view.group !== "due",
    label: () => (view.group === "due" ? "Group" : `By ${GROUP_LABEL[view.group].toLowerCase()}`),
    lead: () => icons.listBullet(),
    options: () => (["due", "area", "where"] as GroupBy[]).map((g) => ({ value: g, label: `By ${GROUP_LABEL[g].toLowerCase()}`, icon: g === "due" ? icons.calendar() : g === "area" ? icons.target() : icons.pin() })),
    onChange: (g) => setView({ group: g }),
  });
  const clearBtn = h("button", { class: "link-btn loops__clear", type: "button" }, "Clear");
  clearBtn.addEventListener("click", () => setView({ area: null, where: null }));
  const ctxBar = h("div", { class: "loops__ctx", role: "group", "aria-label": "Filter and group" }, areaChip.el, whereChip.el, groupChip.el, clearBtn);
  function paintBar() {
    areaChip.paint();
    whereChip.paint();
    groupChip.paint();
    ctxBar.hidden = filter === "decision";
    clearBtn.hidden = !(liveFilter(view.area) || liveFilter(view.where));
  }
  paintBar();

  const quick = h("input", { class: "quick-add__input", type: "text", name: "quick-add", placeholder: QUICK_PLACEHOLDER.all, autocomplete: "off", enterkeyhint: "done", "aria-label": "Add a to-do" }) as HTMLInputElement;
  const quickBtn = h("button", { class: "icon-btn icon-btn--sm quick-add__btn", type: "submit", "aria-label": "Add" }, icons.plus());
  const quickForm = h("form", { class: "quick-add" }, h("span", { class: "quick-add__ring", "aria-hidden": "true" }), quick, quickBtn);
  quickForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = quick.value.trim();
    if (!title) return;
    quick.value = "";
    try {
      // Added while filtered to a context: it lands in that context, so it stays in view.
      const area = liveFilter(view.area);
      const where = liveFilter(view.where);
      await saveCommitment({
        title,
        kind: filter === "all" ? "todo" : filter,
        ...(area && area !== "none" ? { area_id: area } : {}),
        ...(where && where !== "none" ? { where_id: where } : {}),
      });
    } catch (error) {
      quick.value = title;
      showToast(error instanceof Error ? error.message : "Couldn't add it", { icon: "wifiOff", timeoutMs: 4000 });
    }
  });

  const weekLink = h("button", { class: "link-btn loops__link", type: "button" }, icons.week(), "This week");
  weekLink.addEventListener("click", () => ctx.go("week"));
  const inboxLink = h("button", { class: "link-btn loops__link", type: "button", hidden: true });
  inboxLink.addEventListener("click", () => ctx.go("review"));

  // Only the tabs, title and filters stick; the rest scrolls with the list.
  const head = pageHead({ segments: librarySegments("loops", ctx.go), title: "To do", count, actions: [add], below: [filters.el, ctxBar] });
  const list = h("div", { class: "loops__list" });
  const el = h("div", { class: "view loops" }, head, h("div", { class: "loops__top" }, quickForm, h("div", { class: "loops__links" }, weekLink, inboxLink)), list);
  const onScroll = () => head.classList.toggle("is-scrolled", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });

  const open = (c: Commitment) => openCommitmentSheet(c);

  /** A to-do's row; one that names someone it isn't linked to gets "Link to …" under it. */
  function row(c: Commitment, hideContext?: "area" | "where") {
    const el = loopRow(c, { onOpen: open, hideContext });
    const who = named[c.id];
    if (who?.length && c.status === "open" && !c.person_id) el.append(personSuggestion(who, { link: (p) => void linkSuggested(c, p), dismiss: () => dismissSuggested(c.id) }));
    return el;
  }

  function group(label: string | Node, rows: Commitment[], tone?: "late", hideContext?: "area" | "where") {
    return h(
      "section",
      { class: "group", "data-tone": tone, "data-flip": `group:${typeof label === "string" ? label : label.textContent}` },
      h("h2", { class: "group__label" }, label, h("span", { class: "group__count" }, String(rows.length))),
      h("div", { class: "card card--flush list" }, ...rows.map((c) => row(c, hideContext)))
    );
  }

  /**
   * A repaint after the data changed (a tick saved, an Undo, a new to-do)
   * slides what stayed and opens out what's new; a filter change just swaps.
   */
  let animateNext = false;
  function paint() {
    if (!loaded) return;
    const animate = animateNext;
    animateNext = false;
    const show = (...nodes: Node[]) => (animate ? flip(list, () => list.replaceChildren(...nodes), { enter: true }) : list.replaceChildren(...nodes));
    const today = localToday();
    const byKind = items.filter((c) => inFilterKind(filter, c.kind));
    const contextual = filter !== "decision";
    const area = contextual ? liveFilter(view.area) : null;
    const where = contextual ? liveFilter(view.where) : null;
    const inFilter = filterByContext(byKind, { area, where }, contextsSnapshot());
    const openOnes = filter === "decision" ? [] : openLoops(inFilter);
    count.textContent = String(openLoops(items).length);

    if (filter === "decision") {
      const decisions = inFilter.sort((a, b) => b.created_at.localeCompare(a.created_at));
      show(decisions.length ? group("Decisions", decisions) : empty(null));
      return;
    }

    const g = groupLoops(openOnes, today);
    if (view.group !== "due" && openOnes.length) {
      // Grouped by area or where/how, each group soonest due first.
      const ordered = [...g.overdue, ...g.today, ...g.week, ...g.later, ...g.someday];
      const sections = groupByContext(ordered, view.group, contextsSnapshot()).map(({ context, items: rows }) =>
        group(context ? h("span", { class: "ctx-group" }, context.kind === "area" ? h("span", { class: "ctx-dot", "data-colour": context.colour, "aria-hidden": "true" }) : icons[(context.icon in icons ? context.icon : "tag") as keyof typeof icons](), context.name) : view.group === "area" ? "No area" : "Where not set", rows, undefined, view.group === "due" ? undefined : view.group)
      );
      show(...sections, ...doneSection(inFilter));
      return;
    }
    const sections: HTMLElement[] = [];
    if (g.overdue.length) sections.push(group("Overdue", g.overdue, "late"));
    if (g.today.length) sections.push(group("Today", g.today));
    if (g.week.length) sections.push(group("Next 7 days", g.week));
    if (g.later.length) sections.push(group("Later", g.later));
    if (g.someday.length) sections.push(group("No date", g.someday));
    if (!sections.length) sections.push(empty(area || where ? byKind : null));
    show(...sections, ...doneSection(inFilter));
  }

  /** Ticked in the last fortnight, folded away. */
  function doneSection(rows: Commitment[]): HTMLElement[] {
    const fortnight = Date.now() - 14 * 86_400_000;
    const done = rows
      .filter((c) => c.status === "done" && c.done_at && Date.parse(c.done_at) >= fortnight)
      .sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? ""));
    if (!done.length) return [];
    return [
      h(
        "details",
        { class: "group group--done", "data-flip": "group:done" },
        h("summary", { class: "group__label" }, icons.chevronRight(), "Done", h("span", { class: "group__count" }, String(done.length))),
        h("div", { class: "card card--flush list" }, ...done.map((c) => loopRow(c, { onOpen: open })))
      ),
    ];
  }

  /** Nothing in this view. With context filters on and to-dos outside them, offer to clear them. */
  function empty(unfiltered: Commitment[] | null) {
    if (unfiltered && openLoops(unfiltered).length) {
      const clear = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.close(), "Clear filters");
      clear.addEventListener("click", () => setView({ area: null, where: null }));
      return h("div", { class: "empty" }, h("span", { class: "tile" }, icons.loop()), h("p", { class: "empty__title" }, "Nothing here"), h("p", { class: "empty__sub" }, "No open to-dos match these filters."), clear);
    }
    const e = EMPTY[filter];
    return h("div", { class: "empty" }, h("span", { class: "tile" }, icons.loop()), h("p", { class: "empty__title" }, e.title), h("p", { class: "empty__sub" }, e.sub));
  }

  async function load() {
    const [{ items: loadedItems }, { items: pending }, people] = await Promise.all([loadCommitments(), loadSuggestions(), loadTodoPeople()]);
    items = loadedItems;
    named = people;
    animateNext = loaded;
    loaded = true;
    inboxLink.hidden = !pending.length;
    inboxLink.replaceChildren(icons.inbox(), `${pending.length} to review`);
    inboxLink.setAttribute("aria-label", `${pending.length} ${plural(pending.length, "suggestion", "suggestions")} to review`);
    paint();
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "loop" }, h("span", { class: "loop__check skeleton" }), h("span", { class: "loop__body" }, h("span", { class: "skeleton", style: "height:12px;width:55%" })))))
  );
  void load();
  const unsub = onMemoryChange((topic) => {
    if (topic === "commitment" || topic === "suggestion" || topic === "all") void load();
  });
  const unsubContexts = onContextsChange(() => {
    paintBar();
    paint();
  });
  return {
    el,
    destroy: () => {
      unsub();
      unsubContexts();
      window.removeEventListener("scroll", onScroll);
    },
  };
}
