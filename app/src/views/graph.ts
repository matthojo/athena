/**
 * The Graph: everything in Athena and how it links together, drawn as a
 * force-directed map (graph/renderer.ts). Chips by kind filter it and double
 * as the legend; search jumps to something; a switch hides notes with no
 * links. Tap a dot to light up it and its neighbours, and tap again (or Open
 * on the card) to open it with the app's own handlers. The List view is the
 * same graph as text, for screen readers and for reading rather than panning.
 *
 * main.ts loads this module (and styles/graph.css) on first visit, so none of
 * it is in the main bundle. Filters are remembered on the device; the layout
 * and pins last for the session, so opening something and coming back finds
 * the graph as you left it.
 */

import "../styles/graph.css";
import { h, svg } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { getGraph, onGraphChange, type GraphLoad } from "../db/graph";
import { ALL_KINDS, KIND_INFO, colorVar, describe, filterKey, filterLabel, isDetail, kindOne, labelFor, nodeIcon, titleFor } from "../graph/kinds";
import { createRenderer, type Positions } from "../graph/renderer";
import { openerFor, type OpenLink } from "../graph/open";
import { hueFor, initials, plural, relativeTime } from "../lib/format";
import type { ViewId } from "../components/nav";
import type { GraphKind, GraphLink, GraphNode } from "../types";
import { pageHead } from "../components/page-head";

interface Prefs {
  /** Kinds turned off: a GraphKind, or "record:<kind id>" for one of the owner's own kinds. */
  hidden: string[];
  hideUnlinked: boolean;
  mode: "map" | "list";
}

const PREFS_KEY = "athena.graph";
let lastPositions: Positions | undefined;

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      hidden: Array.isArray(p.hidden) ? p.hidden.filter((k) => ALL_KINDS.includes(k as GraphKind) || /^record:[0-9a-f-]{36}$/.test(k)) : [],
      hideUnlinked: !!p.hideUnlinked,
      mode: p.mode === "list" ? "list" : "map",
    };
  } catch {
    return { hidden: [], hideUnlinked: false, mode: "map" };
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // private mode: filters just reset next time
  }
}

const minus = () => svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>`);
const frame = () =>
  svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 9V6.5a2 2 0 0 1 2-2H9M15 4.5h2.5a2 2 0 0 1 2 2V9M19.5 15v2.5a2 2 0 0 1-2 2H15M9 19.5H6.5a2 2 0 0 1-2-2V15"/><circle cx="12" cy="12" r="2.2"/></svg>`);

/** A dot of a kind's colour: hollow for the layer-2 details, as on the graph. */
const swatch = (kind: GraphKind) => h("span", { class: `graph__swatch${isDetail(kind) ? " graph__swatch--ring" : ""}`, style: `--swatch: var(${colorVar(kind)})`, "aria-hidden": "true" });

/** A person's initials avatar, or a kind's icon in its colour. */
function markFor(n: GraphNode, size: "sm" | "md" = "sm"): HTMLElement {
  if (n.kind === "person") {
    const a = h("span", { class: `avatar ${size === "md" ? "avatar--row" : "graph__avatar"}`, "aria-hidden": "true" }, initials(titleFor(n)) || "?");
    a.style.setProperty("--h", String(hueFor(titleFor(n))));
    return a;
  }
  return h("span", { class: `tile tile--sm graph__tile`, style: `--swatch: var(${colorVar(n.kind)})`, "aria-hidden": "true" }, icons[nodeIcon(n)]());
}

export function renderGraph(ctx: {
  focusId: string | null;
  openLink: OpenLink;
  go: (view: ViewId) => void;
  onSelectionChange: (id: string | null) => void;
}): { el: HTMLElement; destroy: () => void } {
  const prefs = readPrefs();
  const hidden = new Set<string>(prefs.hidden);
  let load: GraphLoad | null = null;
  let byId = new Map<string, GraphNode>();
  let neighbourIds = new Map<string, string[]>();
  let signature = "";
  let pendingFocus = ctx.focusId;
  let dead = false;

  // ---------- header: title, Map | List, search, chips ----------
  const count = h("span", { class: "page-count" });
  const modeBtn = (mode: Prefs["mode"], label: string, icon: SVGSVGElement) => {
    const b = h("button", { class: "graph__mode-btn", type: "button", "aria-pressed": String(prefs.mode === mode) }, icon, h("span", {}, label));
    b.addEventListener("click", () => setMode(mode));
    return b;
  };
  const mapBtn = modeBtn("map", "Map", icons.graph());
  const listBtn = modeBtn("list", "List", icons.listBullet());
  const modes = h("div", { class: "graph__modes", role: "group", "aria-label": "Show as" }, mapBtn, listBtn);

  const resultsId = `graph-results-${Math.random().toString(36).slice(2)}`;
  const input = h("input", {
    type: "search",
    name: "graph-search",
    placeholder: "Find a person, place or note",
    "aria-label": "Find on the graph",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": resultsId,
    autocomplete: "off",
    autocapitalize: "none",
    enterkeyhint: "search",
  }) as HTMLInputElement;
  const results = h("ul", { class: "graph__results", id: resultsId, role: "listbox", "aria-label": "Matches", hidden: true });
  const search = h("div", { class: "search graph__search" }, icons.search(), input, results);

  /** One chip per kind, by filter key; each of the owner's own kinds gets its own (made in index()). */
  const chips = new Map<string, HTMLButtonElement>();
  const chipFor = (key: string, kind: GraphKind, label: string) => {
    const b = h(
      "button",
      { class: "chip graph__chip", type: "button", "data-kind": kind, "data-key": key, "aria-pressed": String(!hidden.has(key)) },
      swatch(kind),
      label,
      h("span", { class: "chip__count" })
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      if (hidden.has(key)) hidden.delete(key);
      else hidden.add(key);
      b.setAttribute("aria-pressed", String(!hidden.has(key)));
      refilter();
    });
    chips.set(key, b);
    return b;
  };
  const chipRow = h(
    "div",
    { class: "chip-row graph__chips", role: "group", "aria-label": "Show on the graph" },
    ...ALL_KINDS.filter((kind) => kind !== "record").map((kind) => chipFor(kind, kind, KIND_INFO[kind].many))
  );

  // One row on a wide screen (title, search, Map | List); on a phone the search wraps below the title.
  const head = pageHead({
    class: "graph__head",
    rowClass: "graph__bar",
    segments: librarySegments("graph", ctx.go),
    title: "Graph",
    count,
    actions: [search, modes],
    below: [chipRow],
  });

  // ---------- the map ----------
  const card = h("section", { class: "graph__card", "aria-label": "Selected", hidden: true });
  const renderer = createRenderer({
    mode: "full",
    positions: lastPositions,
    bottomInset: () => (card.hidden ? 0 : card.offsetHeight + 12),
    onSelect: (n) => {
      paintCard(n);
      ctx.onSelectionChange(n?.id ?? null);
    },
    onOpen: open,
    onPin: () => paintCard(byId.get(renderer.selectedId() ?? "") ?? null),
  });
  renderer.canvas.setAttribute("role", "img");

  const unlinked = h("input", { type: "checkbox", role: "switch", class: "switch", name: "hide-unlinked" }) as HTMLInputElement;
  unlinked.checked = prefs.hideUnlinked;
  unlinked.addEventListener("change", refilter);
  const toggle = h("label", { class: "graph__toggle graph__float" }, unlinked, h("span", {}, "Hide notes with no links"));

  const zoomBtn = (label: string, icon: SVGSVGElement, run: () => void) => {
    const b = h("button", { class: "graph__zoom-btn", type: "button", "aria-label": label, title: label }, icon);
    b.addEventListener("click", run);
    return b;
  };
  const zoom = h(
    "div",
    { class: "graph__zoom graph__float", role: "group", "aria-label": "Zoom" },
    zoomBtn("Zoom in", icons.plus(), () => renderer.zoomBy(1.4)),
    zoomBtn("Zoom out", minus(), () => renderer.zoomBy(1 / 1.4)),
    zoomBtn("Fit everything in", frame(), () => renderer.fit())
  );
  const stats = h("p", { class: "graph__stats", "aria-live": "polite" });
  const status = h("div", { class: "graph__status" }, h("span", { class: "graph__pulse", "aria-hidden": "true" }), "Drawing your graph…");
  const stage = h("div", { class: "graph__stage" }, renderer.el, h("div", { class: "graph__top" }, toggle, zoom), stats, card, status);

  // ---------- the list ----------
  const list = h("div", { class: "graph__list", hidden: true });
  const body = h("div", { class: "graph__body" }, stage, list);
  const el = h("div", { class: "view graph" }, head, body);

  // ---------- filters ----------
  function persist() {
    savePrefs({ hidden: [...hidden], hideUnlinked: unlinked.checked, mode: prefs.mode });
  }

  /** A filter changed: show the new set, and frame it afresh as it settles. */
  function refilter() {
    persist();
    apply();
    renderer.fit();
  }

  /** What the filters let through: details only while something they hang off is shown. */
  function visible(): { nodes: GraphNode[]; links: GraphLink[] } {
    const graph = load?.graph ?? { nodes: [], links: [] };
    const pass = (n: GraphNode) => !hidden.has(filterKey(n)) && !(unlinked.checked && n.kind === "note" && n.degree === 0);
    const pages = new Set(graph.nodes.filter((n) => !isDetail(n.kind) && pass(n)).map((n) => n.id));
    const nodes = graph.nodes.filter((n) => pass(n) && (!isDetail(n.kind) || (neighbourIds.get(n.id) ?? []).some((id) => pages.has(id))));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, links: graph.links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }

  function apply() {
    const v = visible();
    // Hubs first, so they take the middle of the starting spiral and the layout is the same every visit.
    const nodes = [...v.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    renderer.setGraph(nodes, v.links);
    const total = load?.graph.nodes.length ?? 0;
    count.textContent = total ? String(total) : "";
    const things = `${v.nodes.length} ${plural(v.nodes.length, "thing", "things")}, ${v.links.length} ${plural(v.links.length, "connection", "connections")}`;
    const where = load?.state === "sample" ? " · Sample data" : load?.state === "offline" ? (load.savedAt ? ` · Offline, from ${relativeTime(load.savedAt)}` : " · Offline, from this device") : "";
    stats.textContent = `${things}${where}`;
    renderer.canvas.setAttribute("aria-label", `Graph of ${things}. Choose List to read it as text.`);
    if (prefs.mode === "list") paintList();
  }

  function index(l: GraphLoad) {
    byId = new Map(l.graph.nodes.map((n) => [n.id, n]));
    neighbourIds = new Map(l.graph.nodes.map((n) => [n.id, [] as string[]]));
    for (const link of l.graph.links) {
      neighbourIds.get(link.source)?.push(link.target);
      neighbourIds.get(link.target)?.push(link.source);
    }
    const perKind = new Map<string, number>();
    const ones = new Map<string, string>();
    for (const n of l.graph.nodes) {
      perKind.set(filterKey(n), (perKind.get(filterKey(n)) ?? 0) + 1);
      if (n.kind === "record") ones.set(filterKey(n), n.sub);
    }
    // The owner's own kinds: a chip each, after Events and before the details, named as the Library names them.
    for (const [key, chip] of chips) if (key.startsWith("record:")) (chip.remove(), chips.delete(key));
    const firstDetail = chips.get("interaction") ?? null;
    for (const key of [...ones.keys()].sort((a, b) => filterLabel(a, ones.get(a)).localeCompare(filterLabel(b, ones.get(b))))) {
      chipRow.insertBefore(chipFor(key, "record", filterLabel(key, ones.get(key))), firstDetail);
    }
    for (const [kind, chip] of chips) {
      const n = perKind.get(kind) ?? 0;
      chip.hidden = !n;
      chip.querySelector(".chip__count")!.textContent = String(n);
    }
  }

  const neighbours = (id: string) => (neighbourIds.get(id) ?? []).map((x) => byId.get(x)!).filter(Boolean);

  // ---------- open, select, jump ----------
  function open(n: GraphNode) {
    lastPositions = renderer.positions();
    const opener = openerFor(n, neighbours(n.id), ctx.openLink);
    if (opener) opener.run();
    else if (prefs.mode === "list") {
      setMode("map");
      renderer.select(n.id, { reveal: true });
    }
  }

  /** Make sure the filters show it, then glide to it and select it. */
  function jumpTo(id: string) {
    const n = byId.get(id);
    if (!n) return;
    let changed = false;
    if (hidden.has(filterKey(n))) {
      hidden.delete(filterKey(n));
      chips.get(filterKey(n))?.setAttribute("aria-pressed", "true");
      changed = true;
    }
    if (n.kind === "note" && n.degree === 0 && unlinked.checked) {
      unlinked.checked = false;
      changed = true;
    }
    if (isDetail(n.kind)) {
      for (const p of neighbours(id)) {
        if (!hidden.has(filterKey(p))) continue;
        hidden.delete(filterKey(p));
        chips.get(filterKey(p))?.setAttribute("aria-pressed", "true");
        changed = true;
      }
    }
    if (changed) {
      persist();
      apply();
    }
    if (prefs.mode === "list") setMode("map");
    renderer.select(id, { reveal: true });
  }

  function paintCard(n: GraphNode | null) {
    if (!n) {
      card.hidden = true;
      stats.hidden = false;
      return;
    }
    const near = neighbours(n.id).sort((a, b) => Number(isDetail(a.kind)) - Number(isDetail(b.kind)) || b.degree - a.degree);
    const opener = openerFor(n, near, ctx.openLink);
    const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Clear selection" }, icons.close());
    close.addEventListener("click", () => renderer.select(null));
    const linkChips = near.slice(0, 24).map((m) => {
      const b = h("button", { class: "link-chip graph__link", type: "button" }, swatch(m.kind), labelFor(m));
      b.addEventListener("click", () => jumpTo(m.id)); // turns its kind back on if a filter hid it
      return b;
    });
    const actions: HTMLElement[] = [];
    if (opener) {
      const b = h("button", { class: "btn btn--primary btn--sm graph__open", type: "button" }, h("span", {}, opener.label), icons.chevronRight());
      b.addEventListener("click", () => {
        lastPositions = renderer.positions();
        opener.run();
      });
      actions.push(b);
    }
    if (renderer.isPinned(n.id)) {
      const b = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Unpin");
      b.addEventListener("click", () => {
        renderer.unpin(n.id);
        paintCard(n);
      });
      actions.push(b);
    }
    card.replaceChildren(
      h(
        "div",
        { class: "graph__card-head" },
        markFor(n),
        h(
          "div",
          { class: "graph__card-text" },
          h("h2", { class: "graph__card-title" }, titleFor(n)),
          h("p", { class: "graph__card-meta" }, `${describe(n)} · ${n.degree ? `${n.degree} ${plural(n.degree, "link", "links")}` : "No links yet"}`)
        ),
        close
      ),
      ...(linkChips.length ? [h("div", { class: "chip-row graph__links", role: "group", "aria-label": "Linked to" }, ...linkChips)] : []),
      ...(actions.length ? [h("div", { class: "graph__card-actions" }, ...actions)] : [])
    );
    card.hidden = false;
    stats.hidden = true;
  }

  // ---------- search ----------
  let matches: GraphNode[] = [];
  let active = -1;

  /** Names that start with the words typed, or have a word that does: whole names first, pages before details, hubs first. */
  function findMatches(q: string, limit = 7): GraphNode[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const wordStart = new RegExp(`(^|[\\s\\-—–(/:'"“‘])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const scored: { n: GraphNode; score: number }[] = [];
    for (const n of byId.values()) {
      const texts = [labelFor(n), titleFor(n)].map((t) => t.toLowerCase());
      if (!texts.some((t) => wordStart.test(t))) continue;
      const first = texts.some((t) => t.startsWith(needle)) ? 0 : 1;
      scored.push({ n, score: first * 1000 + (isDetail(n.kind) ? 500 : 0) - n.degree });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.n);
  }

  function paintResults() {
    const open = prefs.mode === "map" && !!input.value.trim() && document.activeElement === input;
    results.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (!open) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    if (!matches.length) {
      results.replaceChildren(h("li", { class: "graph__result graph__result--empty", role: "presentation" }, "Nothing by that name"));
      return;
    }
    results.replaceChildren(
      ...matches.map((n, i) => {
        const li = h(
          "li",
          { class: "graph__result", role: "option", id: `${resultsId}-${i}`, "aria-selected": String(i === active) },
          swatch(n.kind),
          h("span", { class: "graph__result-label" }, labelFor(n)),
          h("span", { class: "graph__result-kind" }, kindOne(n))
        );
        // pointerdown, so the input keeps focus until the pick lands.
        li.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          pick(n);
        });
        return li;
      })
    );
    if (active >= 0) input.setAttribute("aria-activedescendant", `${resultsId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function pick(n: GraphNode) {
    input.value = "";
    matches = [];
    active = -1;
    paintResults();
    input.blur();
    jumpTo(n.id);
  }

  input.addEventListener("input", () => {
    if (prefs.mode === "list") return paintList();
    matches = findMatches(input.value);
    active = matches.length ? 0 : -1;
    paintResults();
  });
  input.addEventListener("focus", () => {
    matches = findMatches(input.value);
    paintResults();
  });
  input.addEventListener("blur", () => setTimeout(paintResults, 0));
  input.addEventListener("keydown", (e) => {
    if (prefs.mode === "list") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!matches.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      paintResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = matches[Math.max(0, active)];
      if (n) pick(n);
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      input.value = "";
      matches = [];
      paintResults();
    }
  });

  // ---------- list view ----------
  function paintList() {
    const { nodes } = visible();
    const needle = input.value.trim().toLowerCase();
    const matched = needle ? new Set(findMatches(needle, Infinity).map((n) => n.id)) : null;
    const shown = matched ? nodes.filter((n) => matched.has(n.id)) : nodes;
    if (!shown.length) {
      list.replaceChildren(
        h("div", { class: "empty" }, h("span", { class: "tile" }, icons.search()), h("p", { class: "empty__title" }, needle ? "Nothing by that name" : "Nothing to show"), h("p", { class: "empty__sub" }, needle ? "Try another word, or turn on more kinds above." : "Turn on some kinds above."))
      );
      return;
    }
    // In the chips' order: built-in kinds, with each of the owner's own kinds where the chips put them.
    const keys = [...chipRow.querySelectorAll<HTMLElement>("[data-key]")].map((c) => c.dataset.key!);
    const groups = keys
      .map((key) => ({ key, items: shown.filter((n) => filterKey(n) === key).sort((a, b) => b.degree - a.degree || titleFor(a).localeCompare(titleFor(b))) }))
      .filter((g) => g.items.length);
    list.replaceChildren(
      ...groups.map(({ key, items }) =>
        h(
          "section",
          { class: "group" },
          h("h2", { class: "group__label" }, filterLabel(key, items[0]?.sub), h("span", { class: "group__count" }, String(items.length))),
          h(
            "div",
            { class: "card card--flush list" },
            ...items.map((n) => {
              const near = neighbours(n.id);
              const names = near.slice(0, 3).map(labelFor);
              const more = near.length - names.length;
              const linked = near.length ? `Linked to ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "No links yet";
              const row = h(
                "button",
                { class: "row graph__row", type: "button" },
                markFor(n, "md"),
                h("span", { class: "row__body" }, h("span", { class: "row__title" }, titleFor(n)), h("span", { class: "row__snippet" }, linked)),
                h("span", { class: "row__time" }, n.degree ? `${n.degree} ${plural(n.degree, "link", "links")}` : "")
              );
              row.addEventListener("click", () => open(n));
              return row;
            })
          )
        )
      )
    );
  }

  function setMode(mode: Prefs["mode"]) {
    prefs.mode = mode;
    persist();
    mapBtn.setAttribute("aria-pressed", String(mode === "map"));
    listBtn.setAttribute("aria-pressed", String(mode === "list"));
    stage.hidden = mode === "list";
    list.hidden = mode !== "list";
    el.classList.toggle("graph--list", mode === "list");
    input.placeholder = mode === "list" ? "Filter the list" : "Find a person, place or note";
    results.hidden = true;
    if (mode === "list") paintList();
  }

  // ---------- data ----------
  async function refresh() {
    let next: GraphLoad;
    try {
      next = await getGraph();
    } catch {
      if (dead) return;
      status.replaceChildren("Couldn't draw the graph. Check your connection and try again.");
      return;
    }
    if (dead) return;
    const sig = `${next.state}|${next.graph.nodes.map((n) => `${n.id}:${n.title}:${n.sub}:${n.kind_id ?? ""}`).join(",")}|${next.graph.links.map((l) => `${l.source}-${l.target}`).join(",")}`;
    if (sig === signature) return;
    signature = sig;
    load = next;
    index(next);
    status.hidden = true;
    if (!next.graph.nodes.length) {
      const offline = next.state === "offline";
      status.hidden = false;
      status.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "tile" }, icons.graph()),
          h("p", { class: "empty__title" }, offline ? "Nothing on this device yet" : "Nothing to map yet"),
          h(
            "p",
            { class: "empty__sub" },
            offline ? "The graph needs a connection the first time. It'll appear once you're back online." : "Write a note and mention someone with @. They'll show up here, joined by a line."
          )
        )
      );
    }
    apply();
    if (pendingFocus) {
      const id = pendingFocus;
      pendingFocus = null;
      if (byId.has(id)) requestAnimationFrame(() => jumpTo(id));
    } else {
      const sel = renderer.selectedId();
      paintCard(sel ? (byId.get(sel) ?? null) : null);
    }
  }

  setMode(prefs.mode);
  void refresh();
  const unsub = onGraphChange(() => void refresh());

  return {
    el,
    destroy() {
      dead = true;
      lastPositions = renderer.positions();
      unsub();
      renderer.destroy();
    },
  };
}
