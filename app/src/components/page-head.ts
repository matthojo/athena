/**
 * The one page head every top-level view starts with (docs/notes/night-e1.md):
 * the phone's Library segments, then the title with its count and actions on
 * one line, then the lede, then anything the page keeps up top (search, chip
 * rows, filters). It is the same `.notes__head` the views used before, so
 * lib/sticky-head.ts still frosts it once something scrolls under it. Where it
 * sits (the gutter after the sidebar, the top padding) is set once, in
 * styles/components.css under "Page head".
 */

import { h } from "../lib/dom";

type Child = Node | null | undefined | false;

export interface PageHeadOptions {
  /** The page's name, or an h1 the view fills in itself (a kind's name arrives later). */
  title: string | HTMLHeadingElement;
  /** A quiet number beside the title (`.page-count`). */
  count?: Child;
  /** Buttons and controls on the title's line, pushed to its far end. */
  actions?: Child[];
  /** One plain sentence under the title. */
  lede?: string | Node | null;
  /** Before the title on its line, on a phone only (a back arrow); the sidebar does its job on a wide screen. */
  lead?: Element | null;
  /** Above the title: the Library's segments on a phone. */
  segments?: Child;
  /** Below the lede: search, chip rows, filters. */
  below?: Child[];
  /** Extra classes on the header (`days__head`, `graph__head`). */
  class?: string;
  /** Extra classes on the title's line (`days__title-row`, `graph__bar`). */
  rowClass?: string;
}

export function pageHead(o: PageHeadOptions): HTMLElement {
  // A view's own h1 keeps its own look (Home's greeting); a plain name gets the page title's.
  const title = typeof o.title === "string" ? h("h1", { class: "page-title" }, o.title) : o.title;
  o.lead?.classList.add("page-head__lead");
  const actions = (o.actions ?? []).filter(Boolean) as Node[];
  const lede = o.lede == null ? null : typeof o.lede === "string" ? h("p", { class: "page-lede" }, o.lede) : o.lede;
  return h(
    "header",
    { class: `notes__head page-head${o.class ? ` ${o.class}` : ""}` },
    o.segments,
    h(
      "div",
      { class: `notes__title-row page-head__row${o.rowClass ? ` ${o.rowClass}` : ""}` },
      o.lead,
      title,
      o.count,
      actions.length ? h("span", { class: "notes__title-spacer" }) : null,
      ...actions
    ),
    lede,
    ...(o.below ?? [])
  );
}
