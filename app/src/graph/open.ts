/**
 * Opening something from the graph, with the app's own handlers: a page
 * (note, person, place, organisation, event) through openLink, a to-do or a
 * reading item in its sheet, a fact through the person or place it's about.
 * A catch-up has no page of its own; with one person it opens them.
 */

import { openCommitmentSheet } from "../components/commitment-sheet";
import { openReadingSheet } from "../views/reading";
import { showToast } from "../components/toast";
import { loadCommitments, loadReading } from "../db/memory";
import { isPage, titleFor } from "./kinds";
import type { EntityKind, GraphNode } from "../types";

export type OpenLink = (kind: EntityKind, id: string) => void;

export interface Opener {
  /** Button text: "Open", or "Open Priya Shah" when it opens someone else's page. */
  label: string;
  run: () => void;
}

const firstName = (n: GraphNode) => (n.kind === "person" ? titleFor(n).replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0] : titleFor(n));

/** How to open a node, or null when there's nothing to open. `neighbours` are the nodes it links to. */
export function openerFor(n: GraphNode, neighbours: GraphNode[], openLink: OpenLink): Opener | null {
  if (isPage(n.kind)) return { label: "Open", run: () => openLink(n.kind as EntityKind, n.id) };
  const missing = () => showToast("That isn't available any more. It may be archived", { icon: "archive" });
  if (n.kind === "commitment") {
    return {
      label: "Open",
      run: () =>
        void loadCommitments().then(({ items }) => {
          const c = items.find((x) => x.id === n.id);
          if (c) openCommitmentSheet(c);
          else missing();
        }),
    };
  }
  if (n.kind === "reading") {
    return {
      label: "Open",
      run: () =>
        void loadReading().then(({ items }) => {
          const r = items.find((x) => x.id === n.id);
          if (r) openReadingSheet(r);
          else missing();
        }),
    };
  }
  const pages = neighbours.filter((x) => isPage(x.kind));
  if ((n.kind === "fact" || n.kind === "interaction") && pages.length === 1) {
    const [p] = pages;
    return { label: `Open ${firstName(p)}`, run: () => openLink(p.kind as EntityKind, p.id) };
  }
  return null;
}
