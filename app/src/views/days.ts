/**
 * Days, in the Library: one page per day, built from everything Athena
 * collects. Routes (all under #/days):
 *   #/days                      the feed, newest first, with Today on top
 *   #/days/<YYYY-MM-DD>         one day
 *   #/days/calendar?m=YYYY-MM   the calendar (?y=YYYY for the year)
 *   #/days/week/<monday>        a week's recap
 *   #/days/month/<YYYY-MM>      a month's recap
 *   #/days/search?q=&kind=…     search
 * Moving between them pushes history, so Back returns where you were.
 * Styles in styles/days.css; words in components/day-words.ts.
 */

import "../styles/days.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { dayIcons } from "../components/day-icons";
import { librarySegments } from "../components/library-nav";
import type { EntityKind } from "../types";
import type { ViewId } from "../components/nav";
import { renderFeed } from "./days-feed";
import { renderDay } from "./days-day";
import { renderCalendar } from "./days-calendar";
import { renderRecap } from "./days-recap";
import { renderSearch } from "./days-search";
import { pageHead as sharedHead } from "../components/page-head";

export interface DaysContext {
  path: string | null;
  query: string | null;
  isDesktop: () => boolean;
  go: (view: ViewId, opts?: { source?: string | null; noteId?: string | null }) => void;
  openLink: (kind: EntityKind, id: string) => void;
}

export interface DaysNav {
  /** Open a Days page: "2026-11-06", "calendar", "week/2026-11-02"… */
  to: (path: string | null, query?: string | null, opts?: { replace?: boolean; dir?: "next" | "prev" }) => void;
  openLink: (kind: EntityKind, id: string) => void;
  go: DaysContext["go"];
  isDesktop: () => boolean;
}

export interface Mounted {
  el: HTMLElement;
  destroy: () => void;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function renderDays(ctx: DaysContext): Mounted {
  const nav: DaysNav = {
    to(path, query = null, opts = {}) {
      const hash = `#/days${path ? `/${path}` : ""}${query ? `?${query}` : ""}`;
      if (location.hash === hash) return;
      document.documentElement.dataset.daysDir = opts.dir ?? "";
      if (!opts.replace) history.pushState({ ...((history.state as object | null) ?? {}), daysFrom: location.hash }, "", hash);
      ctx.go("days", { noteId: path, source: query });
      window.scrollTo({ top: 0 });
      document.getElementById("main")?.scrollTo({ top: 0 });
    },
    openLink: ctx.openLink,
    go: ctx.go,
    isDesktop: ctx.isDesktop,
  };
  const path = ctx.path ?? "";
  const params = new URLSearchParams(ctx.query ?? "");

  if (DATE.test(path)) return renderDay(path, nav, { write: params.has("write"), mood: params.has("mood") });
  if (path.startsWith("week/") && DATE.test(path.slice(5))) return renderRecap("week", path.slice(5), nav, { first: params.get("first") === "1" });
  if (path.startsWith("month/") && /^\d{4}-\d{2}$/.test(path.slice(6))) return renderRecap("month", path.slice(6), nav);
  if (path === "search") return renderSearch(params, nav, (head) => pageHead(head, nav, "search"));
  if (path === "calendar") return renderCalendar(params, nav, (head) => pageHead(head, nav, "calendar"));
  return renderFeed(nav, (head) => pageHead(head, nav, "feed"));
}

/** The Days header: Library sections, the title, Feed · Calendar and search. */
export function pageHead(extra: HTMLElement | null, nav: DaysNav, active: "feed" | "calendar" | "search"): HTMLElement {
  const tab = (id: "feed" | "calendar", label: string, icon: () => SVGSVGElement) => {
    const b = h("a", { class: "days-tab", href: id === "feed" ? "#/days" : "#/days/calendar", "aria-current": active === id ? "page" : undefined }, icon(), h("span", {}, label));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (active !== id) nav.to(id === "feed" ? null : "calendar", null, { replace: true });
    });
    return b;
  };
  const search = h("a", { class: "icon-btn days-search-btn", href: "#/days/search", "aria-label": "Search your days", "aria-current": active === "search" ? "page" : undefined }, icons.search());
  search.addEventListener("click", (e) => {
    e.preventDefault();
    if (active !== "search") nav.to("search");
  });
  return sharedHead({
    class: "days__head",
    rowClass: "days__title-row",
    segments: librarySegments("days", nav.go),
    title: "Days",
    actions: [h("nav", { class: "days-tabs", "aria-label": "Days" }, tab("feed", "Feed", dayIcons.feed), tab("calendar", "Calendar", dayIcons.calendarGrid)), search],
    below: [extra],
  });
}

/** The same "couldn't load" card everywhere in Days. */
export function failedCard(what: string, retry: () => void): HTMLElement {
  const b = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Try again");
  b.addEventListener("click", retry);
  return h(
    "div",
    { class: "card empty days-failed", role: "alert" },
    h("span", { class: "tile" }, icons.wifiOff()),
    h("p", { class: "empty__title" }, `Couldn't load ${what}`),
    h("p", { class: "empty__sub" }, navigator.onLine ? "Athena didn't answer. Try again in a moment." : "You're offline. Days need a connection."),
    b
  );
}
