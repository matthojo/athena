/**
 * The old weekly review (#/week), retired: Week in review
 * (#/days/week/<monday>, views/days-recap.ts) is the one week review now, and
 * what this page had that it lacked (still open, catch up with, renewals)
 * moved there. parseRoute already sends #/week to it; this stays only for
 * callers that still ask main.ts for the "week" view by name (go("week")).
 * routeHash wrote the new address before this rendered, so it nudges main.ts
 * to read the URL again, as a back or forward would.
 */

import { h } from "../lib/dom";
import type { EntityKind } from "../types";
import type { ViewId } from "../components/nav";

export interface WeekContext {
  openLink: (kind: EntityKind, id: string) => void;
  go: (view: ViewId) => void;
}

export function renderWeek(_ctx: WeekContext): { el: HTMLElement; destroy: () => void } {
  let dead = false;
  queueMicrotask(() => {
    if (!dead) window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  return { el: h("div", { class: "view" }), destroy: () => (dead = true) };
}
