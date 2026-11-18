/**
 * The "Graph" section at the foot of a profile or note: a small map of the
 * item and what it links to (graph/local.ts). Only this shell is in the main
 * bundle. The renderer, d3-force and the graph data load when the section
 * first nears the screen, so opening a profile costs nothing extra until you
 * scroll down to it. The section hides itself when nothing is linked.
 */

import { h } from "../lib/dom";
import type { EntityKind } from "../types";
import type { LocalGraphMount } from "../graph/local";

export interface LocalGraphSection {
  el: HTMLElement;
  /** A note's body changed: redraw with its current links. */
  update: (body?: string) => void;
  destroy: () => void;
}

const DEPTH_KEY = "athena.localGraphDepth";

export function localGraphSection(o: {
  kind: EntityKind;
  id: string;
  title: () => string;
  body?: () => string;
  openLink: (kind: EntityKind, id: string) => void;
}): LocalGraphSection {
  let depth: 1 | 2 = 1;
  try {
    depth = localStorage.getItem(DEPTH_KEY) === "2" ? 2 : 1;
  } catch {
    // storage unavailable: direct links only
  }
  let mount: LocalGraphMount | null = null;
  let dead = false;

  const depthBtn = h("button", { class: "chip chip--sm local-graph__depth", type: "button", "aria-pressed": String(depth === 2) }, "Two steps out");
  depthBtn.addEventListener("click", () => {
    depth = depth === 2 ? 1 : 2;
    depthBtn.setAttribute("aria-pressed", String(depth === 2));
    try {
      localStorage.setItem(DEPTH_KEY, String(depth));
    } catch {
      // fine
    }
    mount?.setDepth(depth);
  });
  const openFull = h("button", { class: "link-btn local-graph__full", type: "button" }, "Open graph");
  openFull.addEventListener("click", () => {
    // A hash change closes any sheet this sits in and main.ts routes to the Graph page.
    location.hash = `#/graph/${encodeURIComponent(o.id)}`;
  });
  const stage = h("div", { class: "local-graph__stage" });
  const caption = h("div", { class: "local-graph__caption", "aria-live": "polite" });
  const el = h(
    "section",
    { class: "note__links local-graph", "aria-label": "Graph" },
    h("div", { class: "local-graph__head" }, h("h2", { class: "group__label" }, "Graph"), depthBtn, h("span", { class: "local-graph__spacer" }), openFull),
    stage,
    caption
  );

  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void import("../graph/local")
        .then(({ mountLocalGraph }) => {
          if (dead) return;
          mount = mountLocalGraph({
            kind: o.kind,
            id: o.id,
            title: o.title,
            body: o.body?.(),
            depth,
            stage,
            caption,
            onEmpty: (empty) => {
              el.hidden = empty;
            },
            openLink: o.openLink,
          });
        })
        .catch(() => {
          el.hidden = true; // offline before the chunk was cached
        });
    },
    { rootMargin: "240px 0px" }
  );
  io.observe(el);

  return {
    el,
    update: (body) => mount?.update(body),
    destroy() {
      dead = true;
      io.disconnect();
      mount?.destroy();
    },
  };
}
