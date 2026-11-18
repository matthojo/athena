/**
 * A small graph of one thing and what it links to, for the foot of a profile
 * or a note: the item held at the centre, its direct links around it and,
 * with "Two steps out", the pages those link to as well. Tap a dot to name it
 * in the caption, tap again (or Open) to open it.
 *
 * Laid out and framed before it's drawn, and capped in size, so it costs a
 * phone one quick layout. The shell (components/local-graph.ts) loads this
 * module when its section first scrolls into view.
 */

import "../styles/graph.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { getGraph, onGraphChange } from "../db/graph";
import { parseAthenaLinks } from "../../../lib/links";
import { createRenderer } from "./renderer";
import { openerFor, type OpenLink } from "./open";
import { describe, isDetail, labelFor, titleFor } from "./kinds";
import type { EntityKind, Graph, GraphLink, GraphNode } from "../types";

const CAP_NEAR = 36;
const CAP_TOTAL = 60;

/** The item, its neighbours and (depth 2) their page neighbours, with every link between them. */
export function neighbourhood(graph: Graph, id: string, depth: 1 | 2): { nodes: GraphNode[]; links: GraphLink[]; depthOf: Map<string, number> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const l of graph.links) {
    (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
    (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
  }
  // Pages before details, then the best connected, so a capped graph keeps what matters.
  const ranked = (ids: string[]) =>
    ids
      .map((x) => byId.get(x)!)
      .filter(Boolean)
      .sort((a, b) => Number(isDetail(a.kind)) - Number(isDetail(b.kind)) || b.degree - a.degree);
  const depthOf = new Map<string, number>([[id, 0]]);
  for (const n of ranked(adj.get(id) ?? []).slice(0, CAP_NEAR)) depthOf.set(n.id, 1);
  if (depth === 2) {
    const ring1 = [...depthOf.keys()].filter((x) => x !== id);
    const further = ranked([...new Set(ring1.flatMap((x) => adj.get(x) ?? []))].filter((x) => !depthOf.has(x)));
    for (const n of further.filter((m) => !isDetail(m.kind)).slice(0, CAP_TOTAL - depthOf.size)) depthOf.set(n.id, 2);
  }
  const nodes = [...depthOf.keys()].map((x) => byId.get(x)!).filter(Boolean);
  const links = graph.links.filter((l) => depthOf.has(l.source) && depthOf.has(l.target));
  return { nodes, links, depthOf };
}

/** The graph with this note's links taken from its body as it is now (it may not have synced yet). */
function withBody(graph: Graph, note: GraphNode, body: string): Graph {
  const known = new Map(graph.nodes.map((n) => [n.id, n]));
  const targets = new Set(parseAthenaLinks(body).filter((l) => known.get(l.id)?.kind === l.kind && l.id !== note.id).map((l) => l.id));
  const links = graph.links.filter((l) => !(l.source === note.id && l.relation === "mentions"));
  const linked = new Set(links.flatMap((l) => (l.source === note.id ? [l.target] : l.target === note.id ? [l.source] : [])));
  for (const t of targets) if (!linked.has(t)) links.push({ source: note.id, target: t, relation: "mentions" });
  const nodes = known.has(note.id) ? graph.nodes : [...graph.nodes, note];
  return { nodes, links };
}

export interface LocalGraphMount {
  setDepth: (depth: 1 | 2) => void;
  /** A note's body changed: redraw with its current links. */
  update: (body?: string) => void;
  destroy: () => void;
}

export function mountLocalGraph(o: {
  kind: EntityKind;
  id: string;
  title: () => string;
  body?: string;
  depth: 1 | 2;
  stage: HTMLElement;
  caption: HTMLElement;
  /** Whether there's anything to show (nothing linked hides the section). */
  onEmpty: (empty: boolean) => void;
  openLink: OpenLink;
}): LocalGraphMount {
  let graph: Graph | null = null;
  let depth = o.depth;
  let body = o.body;
  let dead = false;
  let near: GraphNode[] = [];

  const renderer = createRenderer({
    mode: "local",
    centerId: o.id,
    onSelect: paintCaption,
    onOpen: (n) => openerFor(n, neighbours(n.id), o.openLink)?.run(),
  });
  renderer.canvas.setAttribute("role", "img");
  o.stage.replaceChildren(renderer.el);

  const neighbours = (id: string) => renderer.neighbours(id);

  function paintCaption(n: GraphNode | null) {
    if (!n || n.id === o.id) {
      o.caption.replaceChildren(h("span", { class: "local-graph__hint" }, near.length ? "Tap a dot to see what it is" : ""));
      return;
    }
    const opener = openerFor(n, neighbours(n.id), o.openLink);
    const text = h("span", { class: "local-graph__picked" }, h("span", { class: "local-graph__title" }, titleFor(n)), h("span", { class: "local-graph__kind" }, describe(n)));
    if (!opener) return o.caption.replaceChildren(text);
    const b = h("button", { class: "btn btn--soft btn--sm local-graph__go", type: "button" }, h("span", {}, opener.label), icons.chevronRight());
    b.addEventListener("click", () => opener.run());
    o.caption.replaceChildren(text, b);
  }

  function draw() {
    if (!graph || dead) return;
    const self: GraphNode = graph.nodes.find((n) => n.id === o.id) ?? { id: o.id, kind: o.kind as GraphNode["kind"], title: o.title(), sub: "", at: null, degree: 0 };
    const g = o.kind === "note" && body !== undefined ? withBody(graph, self, body) : graph.nodes.some((n) => n.id === o.id) ? graph : { nodes: [...graph.nodes, self], links: graph.links };
    const hood = neighbourhood(g, o.id, depth);
    near = hood.nodes.filter((n) => hood.depthOf.get(n.id) === 1);
    o.onEmpty(!near.length);
    if (!near.length) return;
    // A handful of dots gets a shorter stage rather than a lot of empty space.
    o.stage.classList.toggle("local-graph__stage--small", hood.nodes.length <= 4);
    renderer.setGraph(hood.nodes, hood.links, hood.depthOf);
    const others = hood.nodes.length - 1;
    renderer.canvas.setAttribute("aria-label", `${titleFor(self)} and ${others} linked ${others === 1 ? "thing" : "things"}: ${near.slice(0, 8).map(labelFor).join(", ")}${near.length > 8 ? "…" : ""}`);
    const sel = renderer.selectedId();
    paintCaption(sel ? (hood.nodes.find((n) => n.id === sel) ?? null) : null);
  }

  async function load() {
    try {
      graph = (await getGraph()).graph;
    } catch {
      graph = null;
      o.onEmpty(true);
      return;
    }
    draw();
  }

  void load();
  const unsub = onGraphChange(() => void load());

  return {
    setDepth(d) {
      depth = d;
      draw();
    },
    update(next) {
      body = next;
      draw();
    },
    destroy() {
      dead = true;
      unsub();
      renderer.destroy();
    },
  };
}
