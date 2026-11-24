/**
 * Navigation in two forms, both owned by main.ts, arranged by how often
 * they're used (docs/notes/ia-review.md, option A):
 *  - dock(): the floating mobile pill (Home · Days · Ask orb · To do ·
 *    Library), the orb at its centre. Library opens its index. A new note on
 *    a phone starts from Home's own button (components/new-note-button.ts),
 *    and Team from the button above Home's Ask box (components/home-ask.ts).
 *  - sidebar(): the desktop rail — "Search or jump to…" (⌘K), new note (C),
 *    then pinned, never scrolling: Home, Days, To do, Ask, Team, Flows, and Inbox with
 *    This week (Week in review for the current week). Below them the Library
 *    scrolls, in the groups its index uses, each folding open on its
 *    own; which are folded is remembered on this device. Archived and
 *    Settings sit at the foot, always in view above the sync status card.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { dayIcons } from "./day-icons";
import { brandMark } from "./brand-mark";
import { statusCard, type StatusActions } from "./status";
import type { SyncStatus } from "../db/data";
import { isLibraryView, libraryGroups, type LibraryGroup } from "./library-nav";
import { thisWeekPath, type KindView } from "../lib/routes";
import { watchWaiting } from "../team/waiting";

export type ViewId =
  | "home"
  | "library"
  | "notes"
  | "ask"
  | "team"
  | "flows"
  | "community"
  | "people"
  | "places"
  | "organisations"
  | "events"
  | "archived"
  | "reminders"
  | "loops"
  | "admin"
  | "reading"
  | "music"
  | "work"
  | "goals"
  | "review"
  | "week"
  | "graph"
  | "settings"
  | "trips"
  | "purchases"
  | "health"
  | "habits"
  | "money"
  | "house"
  | "days"
  | "saved"
  | "recipes"
  | KindView;

export { isKindView, kindIdOf, kindView, type KindView } from "../lib/routes";

export { isLibraryView };

export interface NavActions {
  go: (view: ViewId, opts?: { source?: string | null; noteId?: string | null; focusSearch?: boolean }) => void;
  compose: () => void;
  /** ⌘K: search notes or jump to a place. */
  jump: () => void;
}

const orb = () => h("span", { class: "orb", "aria-hidden": "true" });

function setCurrent(items: HTMLElement[], id: string, value: "page" | "true" = "page") {
  for (const item of items) {
    if (item.dataset.id === id) item.setAttribute("aria-current", value);
    else item.removeAttribute("aria-current");
  }
}

/** One icon drawn twice: the outline for a resting tab, a heavier stroke for the current one. */
function pair(icon: () => Element): [Element, Element] {
  const line = icon();
  const bold = icon();
  line.setAttribute("class", "icon-line");
  bold.setAttribute("class", "icon-solid icon-bold");
  return [line, bold];
}

export function dock(actions: NavActions): { el: HTMLElement; setActive: (view: ViewId) => void } {
  const item = (id: ViewId, label: string, line: () => Element, solid?: () => Element) => {
    const [a, b] = solid ? [line(), solid()] : pair(line);
    const btn = h("button", { class: "dock__item", type: "button", "data-id": id }, a, b, h("span", {}, label));
    btn.addEventListener("click", () => actions.go(id));
    return btn;
  };

  const home = item("home", "Home", icons.home, icons.homeSolid);
  const days = item("days", "Days", dayIcons.days);
  const todo = item("loops", "To do", icons.loop);
  const library = item("library", "Library", icons.library);
  const ask = h("button", { class: "dock__orb", type: "button", "data-id": "ask", "aria-label": "Ask" }, orb());
  ask.addEventListener("click", () => actions.go("ask"));

  // Two tabs either side of the orb, so it sits at the centre. Team is on Home, above the Ask box (owner, 13 Nov 2026).
  const el = h(
    "nav",
    { class: "dock", "aria-label": "Primary" },
    h("div", { class: "dock__bar" }, h("div", { class: "dock__side dock__side--start" }, home, days), ask, h("div", { class: "dock__side dock__side--end" }, todo, library))
  );
  const items = [home, days, ask, todo, library];
  return { el, setActive: (view) => setCurrent(items, isLibraryView(view) ? "library" : view) };
}

/** Which Library groups are folded in the sidebar, kept on this device. */
const FOLDS_KEY = "athena.sidebar.folded";

function readFolds(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolds(folded: Set<string>) {
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify([...folded]));
  } catch {
    // Private windows and full disks: the folds just won't be remembered.
  }
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function sidebar(
  actions: NavActions,
  statusActions: StatusActions
): {
  el: HTMLElement;
  setActive: (view: ViewId) => void;
  setStatus: (s: SyncStatus) => void;
  setCount: (id: ViewId, n: number) => void;
  /** The owner's own kinds changed: redraw the Library's sections. */
  setKinds: () => void;
} {
  const search = h("button", { class: "sidebar__search", type: "button" }, icons.search(), "Search or jump to…", h("kbd", {}, "⌘K"));
  search.addEventListener("click", actions.jump);

  const compose = h("button", { class: "btn btn--primary btn--block sidebar__new", type: "button" }, icons.plus(), "New note", h("kbd", {}, "C"));
  compose.addEventListener("click", actions.compose);

  const navItem = (id: ViewId, label: string, icon: Element, go = () => actions.go(id)) => {
    const b = h("button", { class: "side-item", type: "button", "data-id": id }, icon, h("span", { class: "side-item__label" }, label));
    b.addEventListener("click", go);
    return b;
  };
  const navItems = [
    navItem("home", "Home", icons.home()),
    navItem("days", "Days", dayIcons.days()),
    navItem("loops", "To do", icons.loop()),
    navItem("ask", "Ask", orb()),
    navItem("team", "Team", icons.team()),
    // Flows, under Team: something Athena does for you, like Team (owner, 21 Nov 2026). Home's pill and Library's row stay.
    navItem("flows", "Flows", icons.loop()),
  ];
  // The Team entry keeps a pulse: a soft dot while an assistant works, and a count of what waits for you (team/page-pulse.ts).
  const teamItem = navItems.find((b) => b.dataset.id === "team")!;
  // The count opens Team chat, where everything that waits is (docs/team.md "Team chat"); the name opens the Team page.
  teamItem.addEventListener("click", (e) => {
    if (!(e.target as Element).closest(".side-item__count")) return;
    e.stopImmediatePropagation();
    location.hash = "#/team/chat";
  }, true);
  watchWaiting((p) => {
    teamItem.classList.toggle("is-working", p.working.length > 0);
    teamItem.title = p.working.length ? `${p.working.join(", ")} ${p.working.length === 1 ? "is" : "are"} working` : "";
    setCount("team", p.waiting);
  });
  // This week is Week in review for the current week (the old #/week page is retired).
  const checkItems = [navItem("review", "Inbox", icons.inbox()), navItem("week", "This week", icons.week(), () => actions.go("days", { noteId: thisWeekPath() }))];
  const footItems = [navItem("archived", "Archived", icons.archive()), navItem("settings", "Settings", icons.sliders())];

  const libraryLabel = h("button", { class: "side-label side-label--link", type: "button", "data-id": "library" }, "Library");
  libraryLabel.addEventListener("click", () => actions.go("library"));
  const libraryNav = h("nav", { class: "side-groups", "aria-label": "Library" });
  interface GroupEl {
    el: HTMLElement;
    items: HTMLElement[];
    setOpen: (open: boolean, opts?: { remember?: boolean; reveal?: boolean }) => void;
  }
  let libraryItems: HTMLElement[] = [];
  let groupEls: GroupEl[] = [];
  const counts = new Map<ViewId, number>();
  const folded = readFolds();

  const all = () => [...navItems, ...checkItems, ...libraryItems, ...footItems, libraryLabel];

  /** A count beside an item (to-dos due, suggestions waiting); 0 hides it. */
  function setCount(id: ViewId, n: number) {
    counts.set(id, n);
    const item = all().find((b) => b.dataset.id === id);
    if (!item) return;
    let badge = item.querySelector<HTMLElement>(".side-item__count");
    if (!n) return badge?.remove();
    if (!badge) item.append((badge = h("span", { class: "side-item__count" })));
    badge.textContent = String(n);
  }

  const scroller = h("div", { class: "sidebar__scroll" }, libraryLabel, libraryNav);
  // Each edge fades only while there's more beyond it, so a list that fits sits still and clear.
  const edges = () => {
    scroller.classList.toggle("is-more-above", scroller.scrollTop > 2);
    scroller.classList.toggle("is-more-below", scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2);
  };
  scroller.addEventListener("scroll", edges, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(edges).observe(scroller);
    // The list can grow after the first reveal (counts, your own kinds): once it settles, look again.
    let settle = 0;
    new ResizeObserver(() => {
      edges();
      clearTimeout(settle);
      settle = window.setTimeout(() => revealCurrent(true), 160);
    }).observe(libraryNav);
  }
  // Once a fold settles, the list may have shifted under the current section: keep it clear of both edges.
  libraryNav.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "grid-template-rows") return;
    edges();
    revealCurrent(true);
  });

  /**
   * Keep the current section clear of the scroller's fading lower edge: when
   * it sits outside the calm middle, bring it to the centre. Nothing moves
   * when it's already in plain view.
   */
  function revealCurrent(smooth: boolean) {
    const item = libraryItems.find((b) => b.hasAttribute("aria-current")) ?? (libraryLabel.hasAttribute("aria-current") ? libraryLabel : null);
    if (!item || item.closest("[inert]") || scroller.scrollHeight <= scroller.clientHeight) return;
    const box = scroller.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    const fade = 44; // the 28px mask, plus a little air
    if (r.top >= box.top + 20 && r.bottom <= box.bottom - fade) return;
    const top = scroller.scrollTop + (r.top - box.top) - (scroller.clientHeight - r.height) / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  let active: ViewId = "home";
  let first = true;
  const paintActive = () => {
    // Week in review for this week lights This week; any other Days page lights Days.
    const thisWeek = location.hash === `#/days/${thisWeekPath()}` || /^#\/?week(\?|$)/.test(location.hash);
    const id = active === "days" && thisWeek ? "week" : active;
    setCurrent(all(), id);
    // Arriving in a folded group opens it; a dot marks a group folded by hand around the current page.
    for (const g of groupEls) {
      const holds = g.items.some((b) => b.dataset.id === id);
      g.el.classList.toggle("has-current", holds);
      if (holds && g.el.dataset.open === "false" && g.el.dataset.arrived !== id) g.setOpen(true, { remember: true });
      g.el.dataset.arrived = holds ? id : "";
    }
    const smooth = !first;
    first = false;
    requestAnimationFrame(() => revealCurrent(smooth));
  };

  /** One Library group: its name as a fold, then its sections. */
  function group(g: LibraryGroup, items: HTMLElement[]): GroupEl {
    const bodyId = `side-group-${g.id}`;
    const chevron = icons.chevronRight();
    chevron.setAttribute("class", "side-group__chev");
    chevron.setAttribute("aria-hidden", "true");
    const head = h(
      "button",
      { class: "side-group__head", type: "button", "aria-controls": bodyId },
      h("span", { class: "side-group__dot", "aria-hidden": "true" }),
      h("span", { class: "side-group__label" }, g.label),
      h("span", { class: "side-group__count", "aria-hidden": "true" }, String(items.length)),
      chevron
    );
    const body = h("div", { class: "side-group__body", id: bodyId, role: "group", "aria-label": g.label }, h("div", { class: "side-group__inner" }, ...items));
    const el = h("section", { class: "side-group", "data-group": g.id }, head, body);
    const setOpen = (open: boolean, opts: { remember?: boolean; reveal?: boolean } = {}) => {
      el.dataset.open = String(open);
      head.setAttribute("aria-expanded", String(open));
      body.inert = !open;
      requestAnimationFrame(() => {
        edges();
        if (reducedMotion()) revealCurrent(false);
      });
      if (opts.remember) {
        if (open) folded.delete(g.id);
        else folded.add(g.id);
        writeFolds(folded);
      }
      // Opened near the foot: once it has unfolded, ease the group up into view.
      if (open && opts.reveal) {
        setTimeout(
          () => {
            const box = scroller.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            const over = r.bottom - (box.bottom - 36);
            if (over > 0) scroller.scrollBy({ top: Math.min(over, r.top - box.top), behavior: reducedMotion() ? "auto" : "smooth" });
          },
          reducedMotion() ? 0 : 240
        );
      }
    };
    head.addEventListener("click", () => setOpen(el.dataset.open === "false", { remember: true, reveal: true }));
    setOpen(!folded.has(g.id));
    return { el, items, setOpen };
  }

  /** The Library's groups as its index has them; Archived and Settings live at the foot. */
  function paintLibrary() {
    libraryItems = [];
    groupEls = [];
    for (const g of libraryGroups()) {
      const items = g.items.filter((i) => i.view !== "archived" && i.view !== "settings").map((i) => navItem(i.view, i.label, icons[i.icon]()));
      if (!items.length) continue;
      libraryItems.push(...items);
      groupEls.push(group(g, items));
    }
    libraryNav.replaceChildren(...groupEls.map((g) => g.el));
    for (const [id, n] of counts) setCount(id, n);
    paintActive();
  }
  paintLibrary();

  const status = statusCard(statusActions);

  const el = h(
    "aside",
    { class: "sidebar", "aria-label": "Sidebar" },
    h("div", { class: "sidebar__brand" }, brandMark(), h("span", { class: "brand-name" }, "Athena")),
    search,
    compose,
    h("nav", { class: "side-nav side-nav--pinned", "aria-label": "Primary" }, ...navItems, h("span", { class: "side-nav__gap", "aria-hidden": "true" }), ...checkItems),
    scroller,
    h("nav", { class: "side-nav side-nav--foot", "aria-label": "More" }, ...footItems),
    status.el
  );

  return {
    el,
    setActive(view) {
      active = view;
      paintActive();
    },
    setStatus: status.update,
    setCount,
    setKinds: paintLibrary,
  };
}
