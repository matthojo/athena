/**
 * The Days feed: Today on top (mood in one tap, what's happened so far, On
 * this day), then every day newest first, grouped by month. Each finished
 * week opens with a line about it, and each finished month with a link to
 * its recap. Older days load as you reach the end.
 */

import { todayBlock } from "../components/day-today";
import { daysConvertCard } from "../components/days-convert";
import { isSampleMode } from "../db/api";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { dayCard, earlierCard, weekCard } from "../components/day-card";
import { moodPicker } from "../components/day-mood";
import { addDays, dayFigures, fallbackLine, glance, list, longDate, monthName, monthOf, sameDayEarlier, weekLabel, weekStart } from "../components/day-words";
import { loadDay, loadDays, onDaysChange, saveDay, type Day, type DaySummary } from "../db/days-app";
import { localToday } from "../lib/time";
import { failedCard, type DaysNav, type Mounted } from "./days";
import { miniMonth } from "./days-calendar";

const PAGE = 42;

export function renderFeed(nav: DaysNav, head: (extra: HTMLElement | null) => HTMLElement): Mounted {
  const today = localToday();
  let oldest = today;
  let loading = false;
  let ended = false;
  let dead = false;
  const days = new Map<string, DaySummary>();

  const todayEl = todayBlock({ place: "feed", openDay: (date, o) => nav.to(date, o?.write ? "write" : null) });
  const todaySlot = h("div", { class: "days-today-slot" }, todayEl.el);
  const list_ = h("div", { class: "days-feed", "aria-busy": "true" }, skeleton());
  const more = h("div", { class: "days-more" });
  // While old Life log notes wait to move into Days (days-data's card).
  const convertSlot = h("div", { class: "days-convert-slot" });
  void daysConvertCard({ sample: isSampleMode() }).then((card) => card && !dead && convertSlot.append(card));
  const body = h("div", { class: "days-feed-wrap" }, convertSlot, todaySlot, list_, more);
  // From 1024px: this month and this week beside the feed.
  const rail = h("aside", { class: "days-rail", "aria-label": "This month and this week" });
  const el = h("div", { class: "view days days--feed" }, head(null), h("div", { class: "days-feed-layout" }, body, rail));

  async function load(first = false) {
    if (loading || ended) return;
    loading = true;
    const to = first ? today : addDays(oldest, -1);
    const from = addDays(to, -(PAGE - 1));
    more.replaceChildren(h("p", { class: "days-more__note" }, "Loading earlier days…"));
    try {
      const r = await loadDays(from, to);
      if (dead) return;
      for (const d of r.days) days.set(d.date, d);
      oldest = from;
      // Nothing in two pages running: that's the start.
      if (!r.days.length && !first) ended = true;
      if (first && !r.days.length) {
        const r2 = await loadDays(addDays(from, -PAGE * 3), addDays(from, -1));
        for (const d of r2.days) days.set(d.date, d);
        oldest = addDays(from, -PAGE * 3);
        if (!r2.days.length) ended = true;
      }
      paint();
    } catch {
      if (dead) return;
      if (first) {
        list_.removeAttribute("aria-busy");
        list_.replaceChildren(failedCard("your days", () => void load(true)));
        more.replaceChildren();
      } else {
        const b = h("button", { class: "btn btn--soft", type: "button" }, "Try again");
        b.addEventListener("click", () => void load());
        more.replaceChildren(h("p", { class: "days-more__note" }, "Couldn't load earlier days."), b);
      }
    } finally {
      loading = false;
    }
  }

  function paint() {
    list_.removeAttribute("aria-busy");
    paintRail();
    const sorted = [...days.values()].filter((d) => d.date < today).sort((a, b) => b.date.localeCompare(a.date));
    if (!sorted.length && ended) {
      list_.replaceChildren(emptyState());
      more.replaceChildren();
      return;
    }
    const out: HTMLElement[] = [];
    let month = "";
    let group: HTMLElement | null = null;
    let week = "";
    let lastGroup: HTMLElement | null = null;
    // A finished week's line closes it, under its last (Monday's) card.
    const closeWeek = () => {
      if (!week || !lastGroup) return;
      const w = week;
      const sunday = addDays(w, 6);
      if (sunday >= today) return;
      const g = glance([...days.values()], w, sunday);
      if (g.days >= 2) lastGroup.append(h("li", { class: "days-month__week" }, weekCard(g, w, `#/days/week/${w}`, weekLabel(w, today), () => nav.to(`week/${w}`))));
    };
    for (const d of sorted) {
      const m = monthOf(d.date);
      if (m !== month) {
        month = m;
        const finished = m < monthOf(today);
        const recapLink = finished ? h("a", { class: "days-month__recap", href: `#/days/month/${m}` }, "Month in review", icons.chevronRight()) : null;
        recapLink?.addEventListener("click", (e) => {
          e.preventDefault();
          nav.to(`month/${m}`);
        });
        group = h("ol", { class: "days-month__list", role: "list" });
        out.push(h("section", { class: "days-month", "aria-label": monthName(m) }, h("div", { class: "days-month__head" }, h("h2", { class: "days-month__name" }, monthName(m, m.slice(0, 4) !== today.slice(0, 4))), recapLink), group));
      }
      const w = weekStart(d.date);
      if (w !== week) {
        closeWeek();
        week = w;
      }
      group!.append(h("li", {}, dayCard(d, today, { onOpen: (date) => nav.to(date) })));
      lastGroup = group;
    }
    closeWeek();
    list_.replaceChildren(...out);
    more.replaceChildren();
    if (ended) more.append(h("p", { class: "days-more__note" }, sorted.length ? "That's the first day Athena has." : ""));
    else {
      const b = h("button", { class: "btn btn--soft days-more__btn", type: "button" }, "Show earlier days");
      b.addEventListener("click", () => void load());
      more.append(b);
      observe(b);
    }
  }

  function paintRail() {
    const month = today.slice(0, 7);
    const mon = weekStart(today);
    const g = glance([...days.values()], mon, today);
    const week = g.days
      ? h(
          "section",
          { class: "days-rail__sec", "aria-labelledby": "rail-week" },
          h("h2", { class: "days-rail__title", id: "rail-week" }, "This week so far"),
          weekCard(g, mon, `#/days/week/${mon}`, weekLabel(mon, today), () => nav.to(`week/${mon}`))
        )
      : null;
    const cal = h("a", { class: "btn btn--ghost btn--sm days-rail__more", href: "#/days/calendar" }, "Open the calendar", icons.chevronRight());
    cal.addEventListener("click", (e) => {
      e.preventDefault();
      nav.to("calendar");
    });
    rail.replaceChildren(
      h("section", { class: "days-rail__sec", "aria-label": "This month at a glance" }, miniMonth(month, new Map([...days].filter(([d]) => d.startsWith(month))), today, (m) => nav.to("calendar", `m=${m}`)), cal),
      ...(week ? [week] : [])
    );
  }

  // Load more as the end comes near.
  let io: IntersectionObserver | null = null;
  function observe(target: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    io?.disconnect();
    io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(), { rootMargin: "600px 0px" });
    io.observe(target);
  }

  // Days changed somewhere else (the live channel): the cards loaded so far are read again, and repainted only if they differ.
  const offDays = onDaysChange(async (dates) => {
    if (loading || oldest === today || (dates.length && dates.every((d) => d < oldest))) return;
    const from = oldest;
    const r = await loadDays(from, today).catch(() => null);
    if (dead || !r || from !== oldest) return;
    const byDate = (a: DaySummary, b: DaySummary) => a.date.localeCompare(b.date);
    if (JSON.stringify([...days.values()].sort(byDate)) === JSON.stringify([...r.days].sort(byDate))) return;
    days.clear();
    for (const d of r.days) days.set(d.date, d);
    paint();
  });

  void load(true);
  return {
    el,
    destroy() {
      dead = true;
      offDays();
      io?.disconnect();
      todayEl.destroy();
    },
  };
}


export { blankDay as blank, onThisDay } from "../components/day-today";

function skeleton(): HTMLElement {
  const card = () => h("div", { class: "day-card day-card--skeleton", "aria-hidden": "true" }, h("span", { class: "skeleton day-card__sk-date" }), h("span", { class: "day-card__body" }, h("span", { class: "skeleton day-card__sk-line" }), h("span", { class: "skeleton day-card__sk-fig" }), h("span", { class: "skeleton day-card__sk-art" })));
  return h("div", { class: "days-skeleton" }, h("span", { class: "visually-hidden" }, "Loading your days"), card(), card(), card(), card());
}

function emptyState(): HTMLElement {
  const b = h("a", { class: "btn btn--soft", href: "#/settings/accounts" }, "Connect apps");
  return h(
    "div",
    { class: "card empty days-empty" },
    h("span", { class: "tile" }, icons.calendar()),
    h("p", { class: "empty__title" }, "Your days start here"),
    h("p", { class: "empty__sub" }, "Tomorrow morning, today will be here as a page. It fills in from the apps you connect, and you can add a mood or a few words to any day."),
    b
  );
}
