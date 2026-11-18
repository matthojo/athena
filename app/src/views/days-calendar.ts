/**
 * The calendar of days. Month: a grid, Monday first, each day tinted by how
 * full it was (one cobalt ramp, five fixed steps) with its mood under the
 * number; from 1024px each day also shows its lead artwork. Arrow keys move
 * through the days (one tab stop), Enter opens one. A week's kept moment
 * (the Week in review's "Pick this week's moment") is its cover here: the
 * day it came from shows it, on a phone too. Year: twelve small
 * months as heat, each opening its month.
 */

import { h } from "../lib/dom";
import { dayIcons } from "../components/day-icons";
import { artTile, photoArt } from "../components/day-art";
import { moodGlyph } from "../components/day-mood";
import { addDays, capital, count, dayNumber, glance, list, longDate, monthGrid, monthName, moodWord, nextMonth, plural, summaryFigures } from "../components/day-words";
import { loadDays, type DaySummary } from "../db/days-app";
import { localToday } from "../lib/time";
import { failedCard, type DaysNav, type Mounted } from "./days";
import { dayLevel } from "../components/day-colour";
import { keptMomentsNow, loadWeekMoments } from "../db/week-moments";
import type { WeekMoment } from "../lib/week-moment";
import "../styles/week-moment.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function renderCalendar(params: URLSearchParams, nav: DaysNav, head: (extra: HTMLElement | null) => HTMLElement): Mounted {
  const today = localToday();
  const year = params.get("y");
  const mode: "month" | "year" = year ? "year" : "month";
  const month = /^\d{4}-\d{2}$/.test(params.get("m") ?? "") ? params.get("m")! : today.slice(0, 7);
  const yearOf = year && /^\d{4}$/.test(year) ? year : month.slice(0, 4);
  let dead = false;

  const switcher = h("div", { class: "chip-row days-cal__mode", role: "radiogroup", "aria-label": "Show" });
  for (const [id, label] of [["month", "Month"], ["year", "Year"]] as const) {
    const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(id === mode) }, label);
    b.addEventListener("click", () => id !== mode && nav.to("calendar", id === "year" ? `y=${yearOf}` : `m=${yearOf === today.slice(0, 4) ? today.slice(0, 7) : `${yearOf}-01`}`, { replace: true }));
    switcher.append(b);
  }

  const body = h("div", { class: "days-cal", "aria-busy": "true" });
  const el = h("div", { class: "view days days--calendar" }, head(null), body);

  const stepper = (label: string, title: string, prevTo: string, nextTo: string | null) => {
    const btn = (to: string | null, aria: string, icon: () => SVGSVGElement, dir: "prev" | "next") => {
      const b = h("button", { class: "icon-btn icon-btn--ghost", type: "button", "aria-label": aria, disabled: to === null }, icon());
      if (to) b.addEventListener("click", () => nav.to("calendar", to, { replace: true, dir }));
      return b;
    };
    return h(
      "div",
      { class: "days-cal__bar" },
      h("h2", { class: "days-cal__title", "aria-live": "polite" }, title),
      h("span", { class: "days-cal__spacer" }),
      switcher,
      btn(prevTo, `Previous ${label}`, dayIcons.chevronLeft, "prev"),
      btn(nextTo, `Next ${label}`, dayIcons.chevronRight, "next")
    );
  };

  async function load() {
    body.setAttribute("aria-busy", "true");
    const from = mode === "month" ? `${month}-01` : `${yearOf}-01-01`;
    const to = mode === "month" ? addDays(`${nextMonth(month)}-01`, -1) : `${yearOf}-12-31`;
    if (mode === "month") body.replaceChildren(stepper("month", monthName(month, month.slice(0, 4) !== today.slice(0, 4)), `m=${nextMonth(month, -1)}`, month < today.slice(0, 7) ? `m=${nextMonth(month)}` : null), monthView(month, new Map(), today, nav, true));
    else body.replaceChildren(stepper("year", yearOf, `y=${Number(yearOf) - 1}`, yearOf < today.slice(0, 4) ? `y=${Number(yearOf) + 1}` : null), yearView(yearOf, new Map(), today, nav));
    try {
      const [r, moments] = await Promise.all([loadDays(from, to > today ? today : to), mode === "month" ? loadWeekMoments().catch(() => keptMomentsNow()) : Promise.resolve({})]);
      if (dead) return;
      const byDate = new Map(r.days.map((d) => [d.date, d]));
      body.removeAttribute("aria-busy");
      if (mode === "month") {
        body.replaceChildren(stepper("month", monthName(month, month.slice(0, 4) !== today.slice(0, 4)), `m=${nextMonth(month, -1)}`, month < today.slice(0, 7) ? `m=${nextMonth(month)}` : null), monthView(month, byDate, today, nav, false, keptByDay(moments)), monthSummary(month, r.days, today, nav) ?? "");
      } else {
        body.replaceChildren(stepper("year", yearOf, `y=${Number(yearOf) - 1}`, yearOf < today.slice(0, 4) ? `y=${Number(yearOf) + 1}` : null), yearSummary(yearOf, r.days), yearView(yearOf, byDate, today, nav), legend());
      }
    } catch {
      if (dead) return;
      body.removeAttribute("aria-busy");
      body.append(failedCard("the calendar", () => void load()));
    }
  }
  void load();
  return { el, destroy: () => (dead = true) };
}

/** Each kept moment by the day it came from (a week's moment is one of its days). */
function keptByDay(moments: Record<string, WeekMoment>): Map<string, WeekMoment> {
  const out = new Map<string, WeekMoment>();
  for (const [monday, m] of Object.entries(moments)) if (m.date >= monday && m.date <= addDays(monday, 6)) out.set(m.date, m);
  return out;
}

function monthView(month: string, byDate: Map<string, DaySummary>, today: string, nav: DaysNav, placeholder = false, kept = new Map<string, WeekMoment>()): HTMLElement {
  const weeks = monthGrid(month);
  const cells: HTMLElement[] = [];
  const grid = h("div", { class: `cal${placeholder ? " cal--loading" : ""}`, role: "grid", "aria-label": monthName(month) });
  grid.append(h("div", { class: "cal__row cal__row--head", role: "row" }, ...WEEKDAYS.map((w) => h("span", { class: "cal__dow", role: "columnheader", "aria-label": w }, w.slice(0, 1), h("span", { class: "cal__dow-rest", "aria-hidden": "true" }, w.slice(1))))));
  const focusDate = month === today.slice(0, 7) ? today : `${month}-01`;
  for (const week of weeks) {
    const row = h("div", { class: "cal__row", role: "row" });
    for (const date of week) {
      if (!date) {
        row.append(h("span", { class: "cal__cell cal__cell--pad", role: "gridcell", "aria-hidden": "true" }));
        continue;
      }
      const day = byDate.get(date);
      const future = date > today;
      const level = dayLevel(day);
      // The week's kept moment is its cover here: the day it came from shows it, on every screen.
      const moment = kept.get(date);
      const momentArt = moment && moment.kind !== "line" ? moment.art : undefined;
      const lead = momentArt ?? (day?.photo ? photoArt({ id: day.photo, thumb: true, added_at: "" }) : day?.art[0]);
      const label = [longDate(date, today), moment ? "This week's moment" : null, day ? day.line || list(summaryFigures(day.counts, 3)) : future ? null : "Nothing recorded", day?.mood ? `Mood: ${moodWord(day.mood)}` : null].filter(Boolean).join(". ");
      const cell = h(
        future ? "span" : "a",
        {
          class: `cal__cell cal__cell--h${level}${date === today ? " is-today" : ""}${future ? " is-future" : ""}${moment ? " is-kept" : ""}`,
          href: future ? undefined : `#/days/${date}`,
          "aria-label": label,
          "aria-current": date === today ? "date" : undefined,
          "aria-disabled": future ? "true" : undefined,
          tabindex: date === focusDate ? "0" : "-1",
          "data-date": date,
        },
        h("span", { class: "cal__num", "aria-hidden": "true" }, dayNumber(date)),
        lead && !placeholder ? h("span", { class: "cal__art", "aria-hidden": "true" }, artTile(lead, { photo: (momentArt ? moment!.kind === "photo" : !!day?.photo) ? "thumb" : undefined })) : null,
        day?.mood ? moodGlyph(day.mood, { label: false }) : null,
        moment?.kind === "line" && !placeholder ? h("span", { class: "cal__kept-line", "aria-hidden": "true" }, "\u201C") : null
      );
      if (!future)
        cell.addEventListener("click", (e) => {
          e.preventDefault();
          nav.to(date);
        });
      cells.push(cell);
      row.append(h("span", { class: "cal__slot", role: "gridcell" }, cell));
    }
    grid.append(row);
  }
  // Roving focus: arrows move a day or a week, Home/End the week's ends.
  grid.addEventListener("keydown", (e) => {
    const cur = (e.target as HTMLElement).closest<HTMLElement>(".cal__cell[data-date]");
    if (!cur) return;
    const date = cur.dataset.date!;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key as string];
    let target: string | null = delta ? addDays(date, delta) : null;
    if (e.key === "Home") target = addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (e.key === "End") target = addDays(date, 6 - ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (e.key === "Enter" || e.key === " ") {
      if (date <= today) {
        e.preventDefault();
        nav.to(date);
      }
      return;
    }
    if (!target) return;
    e.preventDefault();
    const next = cells.find((c) => c.dataset.date === target);
    if (next) {
      cells.forEach((c) => (c.tabIndex = -1));
      next.tabIndex = 0;
      next.focus();
    } else if (target.slice(0, 7) !== month && target <= today) {
      nav.to("calendar", `m=${target.slice(0, 7)}`, { replace: true, dir: target < date ? "prev" : "next" });
    }
  });
  return grid;
}

function monthSummary(month: string, days: DaySummary[], today: string, nav: DaysNav): HTMLElement | null {
  if (!days.length) return h("p", { class: "days-cal__summary" }, month > today.slice(0, 7) ? "" : "Nothing recorded this month.");
  const r = glance(days, `${month}-01`, addDays(`${nextMonth(month)}-01`, -1));
  const finished = month < today.slice(0, 7);
  const link = h("a", { class: "btn btn--soft days-cal__recap", href: `#/days/month/${month}` }, finished ? `${monthName(month, false)} in review` : `${monthName(month, false)} so far`, dayIcons.chevronRight());
  link.addEventListener("click", (e) => {
    e.preventDefault();
    nav.to(`month/${month}`);
  });
  return h("div", { class: "days-cal__foot" }, h("p", { class: "days-cal__summary" }, `${capital(plural(days.length, "day"))} recorded. ${r.headline}.`), link);
}

function yearSummary(year: string, days: DaySummary[]): HTMLElement {
  const moods = days.filter((d) => d.mood).length;
  return h("p", { class: "days-cal__summary days-cal__summary--top" }, days.length ? `${capital(plural(days.length, "day"))} recorded in ${year}${moods ? `, ${count(moods)} with a mood` : ""}.` : `Nothing recorded in ${year}.`);
}

function yearView(year: string, byDate: Map<string, DaySummary>, today: string, nav: DaysNav): HTMLElement {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return h("div", { class: "cal-year" }, ...months.map((m) => miniMonth(m, byDate, today, (to) => nav.to("calendar", `m=${to}`, { replace: true }))));
}

/** One month as small heat squares, opening the month (the year view, and the feed's rail). */
export function miniMonth(m: string, byDate: Map<string, DaySummary>, today: string, open: (month: string) => void): HTMLElement {
  const future = m > today.slice(0, 7);
  const recorded = [...byDate.keys()].filter((d) => d.startsWith(m)).length;
  const name = monthName(m, false);
  const a = h(
    future ? "div" : "a",
    { class: `cal-mini${future ? " is-future" : ""}`, href: future ? undefined : `#/days/calendar?m=${m}`, "aria-label": future ? undefined : `${name}: ${recorded ? plural(recorded, "day") + " recorded" : "nothing recorded"}` },
    h("span", { class: "cal-mini__name", "aria-hidden": "true" }, name),
    h(
      "span",
      { class: "cal-mini__grid", "aria-hidden": "true" },
      // Weekday initials and day numbers show where the month is large enough (the feed's rail).
      ...WEEKDAYS.map((w) => h("span", { class: "cal-mini__dow" }, w.slice(0, 1))),
      ...monthGrid(m)
        .flat()
        .map((d) => {
          if (!d) return h("span", { class: "cal-mini__cell cal-mini__cell--pad" });
          const day = byDate.get(d);
          return h("span", { class: `cal-mini__cell cal__cell--h${dayLevel(day)}${d === today ? " is-today" : ""}${d > today ? " is-future" : ""}` }, h("span", { class: "cal-mini__n" }, dayNumber(d)));
        })
    )
  );
  if (!future)
    a.addEventListener("click", (e) => {
      e.preventDefault();
      open(m);
    });
  return a;
}

export function legend(): HTMLElement {
  return h(
    "p",
    { class: "cal-legend", "aria-hidden": "true" },
    h("span", {}, "Quieter"),
    ...[0, 1, 2, 3, 4].map((l) => h("span", { class: `cal-legend__swatch cal__cell--h${l}` })),
    h("span", {}, "Fuller")
  );
}
