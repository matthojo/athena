/**
 * Habits, in the Library beside Goals: each habit's year as a grid of days
 * (weeks across, Monday at the top), how many days in a row it's been kept,
 * and which weekdays it holds up best. The owner's own habits come first,
 * each with today's tick and an edit sheet (components/habit-sheet.ts);
 * then the ones Habitify, Todoist, Loop, Daylio and Bearable send, read-only
 * and labelled with their app (GET /api/life/habits). A sentence first, then
 * the pictures.
 */

import "../styles/life.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { loadHabits, type HabitSummary, type Habits } from "../db/life";
import type { ViewId } from "../components/nav";
import { loadPatterns } from "../db/patterns";
import { patternSlot } from "../components/patterns-block";
import { openHabitSheet } from "../components/habit-sheet";
import { habitDisc, habitTick } from "../components/habit-tick";
import { onHabitsChange } from "../db/habits";
import { pageHead } from "../components/page-head";

const SOURCE: Record<string, string> = { athena: "Athena", habitify: "Habitify", todoist: "Todoist", loop: "Loop", daylio: "Daylio", bearable: "Bearable" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** The opening sentence: what's going well now. */
function lede(all: HabitSummary[]): string {
  const habits = all.filter((x) => !x.own?.archived_at);
  const running = habits.filter((x) => x.streak >= 2).sort((a, b) => b.streak - a.streak);
  // Kept: done on most of the days it was logged in the last week.
  const kept = habits.filter((x) => {
    const week = x.days.filter((d) => d.date > addDays(x.days[x.days.length - 1]?.date ?? "", -7));
    return week.length > 0 && week.filter((d) => d.done).length / week.length >= 0.6;
  }).length;
  const first = kept ? `You kept ${kept === habits.length ? (kept === 1 ? "your habit" : `all ${kept} habits`) : `${kept} of ${habits.length} habits`} going this past week.` : "A quieter week for habits.";
  const best = running[0];
  return best ? `${first} ${best.name} is on a run of ${plural(best.streak, best.streak_unit === "week" ? "week" : "day")}.` : first;
}

/** The year as a grid: up to 53 weeks of 7 days, today's week last, as many whole weeks as fit the card. */
function yearGrid(x: HabitSummary, today: string): HTMLElement {
  const marks = new Map(x.days.map((d) => [d.date, d]));
  const end = addDays(today, 6 - weekday(today));
  const grid = h("div", { class: "habit-grid", role: "img", "aria-label": `${x.name}: done on ${plural(x.done, "day")} in the last year` });
  let shown = 0;
  const draw = (weeks: number) => {
    if (weeks === shown) return;
    shown = weeks;
    const start = addDays(end, -(weeks * 7 - 1));
    const cells: HTMLElement[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const m = marks.get(d);
      const state = d > today ? "none" : m ? (m.done ? "done" : "missed") : "empty";
      cells.push(h("span", { class: `habit-grid__day habit-grid__day--${state}${d === today ? " habit-grid__day--today" : ""}` }));
    }
    grid.replaceChildren(...cells);
  };
  // A column is a cell and its gap; a narrow screen shows the latest whole weeks, never half a column.
  const fit = (width: number) => {
    const cell = window.matchMedia("(min-width: 900px)").matches ? 13 : 11;
    draw(Math.max(8, Math.min(53, Math.floor((width - 4 + 2) / cell))));
  };
  draw(53);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver((e) => fit(e[0].contentRect.width)).observe(grid);
  return grid;
}

function weekSplit(x: HabitSummary): HTMLElement {
  return h(
    "div",
    { class: "habit-week", "aria-hidden": "true" },
    ...x.weekdays.map((share, i) =>
      h("span", { class: "habit-week__day" }, h("span", { class: "habit-week__bar" }, h("span", { class: "habit-week__fill", style: `height:${Math.round((share ?? 0) * 100)}%` })), WEEKDAYS[i][0])
    )
  );
}

/**
 * The longest run, only while the current one is closing in on it (within
 * three): beside a broken run it reads as a loss (docs/notes/affection-2026-11.md,
 * voice fix 6). Runs are shown only while they're running.
 */
export function showLongest(x: Pick<HabitSummary, "streak" | "longest">): boolean {
  return x.streak >= 1 && x.longest >= 3 && x.longest > x.streak && x.longest - x.streak <= 3;
}

function card(x: HabitSummary, today: string): HTMLElement {
  const logged = x.days.length;
  const best = x.weekdays.map((v, i) => [v, i] as const).filter(([v]) => v !== null && logged >= 14).sort((a, b) => b[0]! - a[0]!)[0];
  const facts = [
    `Done on <strong>${plural(x.done, "day")}</strong>${x.source === "todoist" || x.own?.per_week ? "" : ` of ${logged.toLocaleString("en-GB")}`}`,
    x.streak_unit === "week"
      ? x.streak >= 2 ? `<strong>${x.streak} weeks running</strong>` : null
      : x.streak >= 2 ? `<strong>${x.streak} in a row</strong> now` : x.streak === 1 && !x.own ? "done today or yesterday" : null,
    showLongest(x) ? `longest run ${x.longest}` : null,
  ].filter(Boolean);
  const line = h("p", { class: "habit-card__line" });
  line.innerHTML = facts.join(" · ");
  const own = x.own;
  // Athena's own: the name opens its sheet, today's tick sits beside it, the schedule under it.
  const head = own
    ? h(
        "div",
        { class: "habit-card__head habit-card__head--own" },
        // The disc is today's tick when it's due today.
        own.shows_today ? habitTick(own, own.progress_today, { date: today, look: "disc" }) : habitDisc(own, own.archived_at ? 0 : own.progress_today),
        h(
          "div",
          { class: "habit-card__title" },
          editButton(own, x.name),
          h("span", { class: "habit-card__source" }, own.archived_at ? `Archived · ${own.schedule}` : `${SOURCE.athena} · ${own.schedule}${own.target ? ` · ${own.target} ${own.unit ?? ""}`.trimEnd() : ""}`)
        ),
        own.target && own.shows_today ? h("span", { class: "habit-card__today" }, `${own.progress_today} of ${own.target} today`) : own.shows_today && own.progress_today ? h("span", { class: "habit-card__today" }, "Done today") : null
      )
    : h("div", { class: "habit-card__head" }, h("h2", { class: "habit-card__name" }, x.name), h("span", { class: "habit-card__source" }, `From ${SOURCE[x.source] ?? x.source}`));
  return h(
    "li",
    { class: `habit-card${own ? " habit-card--own" : ""}${own?.archived_at ? " habit-card--archived" : ""}` },
    head,
    line,
    yearGrid(x, today),
    h(
      "div",
      { class: "habit-card__foot" },
      // An N-a-week habit can be done on any day, so a weekday split says nothing.
      own?.per_week ? h("span", {}) : weekSplit(x),
      best && !own?.per_week ? h("p", { class: "habit-card__line" }, `Best on ${WEEKDAY_NAMES[best[1]]}`) : null
    )
  );
}

function editButton(own: NonNullable<HabitSummary["own"]>, name: string): HTMLElement {
  const b = h("button", { class: "habit-card__name habit-card__edit", type: "button", "aria-label": `${name}: edit` }, name, icons.chevronRight());
  b.addEventListener("click", () => openHabitSheet(own));
  return b;
}

const newHabit = (cls = "btn btn--primary btn--sm", text = "New habit") => {
  const b = h("button", { class: cls, type: "button" }, icons.plus(), text);
  b.addEventListener("click", () => openHabitSheet(null));
  return b;
};

/** Nothing at all yet: make the first one, or bring them in from an app. */
function empty(go: (view: ViewId) => void): HTMLElement {
  const open = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.plug(), "Connect an app");
  open.addEventListener("click", () => go("settings"));
  return h(
    "div",
    { class: "life-empty habit-empty" },
    h("span", { class: "tile", "aria-hidden": "true" }, icons.check()),
    h("p", { class: "life-empty__title" }, "Start with one habit"),
    h("p", { class: "life-empty__text" }, "Choose the days it's for, and tick it off on Today. Athena keeps track of the days you do it. It can also read the habits you keep in Habitify, Todoist, Loop, Daylio or Bearable."),
    h("div", { class: "habit-empty__actions" }, newHabit("btn btn--primary btn--sm", "Make a habit"), open)
  );
}

/** Habits only from apps so far: a quiet line inviting one of your own. */
function invite(): HTMLElement {
  return h(
    "div",
    { class: "habit-invite" },
    h("p", { class: "habit-invite__text" }, h("strong", {}, "Keep a habit here too. "), "Make one in Athena and tick it off on Today, beside the ones your apps send."),
    newHabit("btn btn--soft btn--sm", "New habit")
  );
}

export function renderHabits(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "life-page", "aria-busy": "true" });
  const el = h(
    "div",
    { class: "view lists habits" },
    pageHead({ segments: librarySegments("habits", ctx.go), title: "Habits", actions: [newHabit("btn btn--soft btn--sm", "New")] }),
    body
  );
  let dead = false;
  let painted = false;
  const paint = (data: Habits) => {
    if (dead) return;
    body.removeAttribute("aria-busy");
    if (!data.habits.length) return body.replaceChildren(empty(ctx.go));
    const legend = h(
      "div",
      { class: "habit-legend", "aria-hidden": "true" },
      h("span", {}, h("span", { class: "habit-grid__day habit-grid__day--done" }), "Done"),
      h("span", {}, h("span", { class: "habit-grid__day habit-grid__day--missed" }), "Not done"),
      h("span", {}, h("span", { class: "habit-grid__day" }), "Nothing logged")
    );
    // A habit that goes with how you sleep or feel, from the last 90 days (lib/patterns.ts), when there is one.
    const pattern = patternSlot(loadPatterns(90), (ps) => ps.find((x) => x.factor_kind === "habit"), { label: "A pattern with your habits" });
    const mine = data.habits.filter((x) => x.own && !x.own.archived_at);
    const archived = data.habits.filter((x) => x.own?.archived_at);
    const apps = data.habits.filter((x) => !x.own);
    const group = (label: string | null, xs: HabitSummary[]) =>
      h("section", { class: "habit-group" }, label ? h("h2", { class: "habit-group__label" }, label) : null, h("ul", { class: "habit-cards", role: "list" }, ...xs.map((x) => card(x, data.today))));
    // A pattern only says something once there's history.
    const live = [...mine, ...apps];
    body.replaceChildren(
      ...[
        live.length ? h("p", { class: "life-page__lede" }, lede(data.habits)) : null,
        live.length ? legend : null,
        mine.length ? group(apps.length ? "Yours" : null, mine) : invite(),
        live.length ? pattern : null,
        apps.length ? group(mine.length ? "From your apps" : null, apps) : null,
        archived.length
          ? h("details", { class: "group group--done habit-archived" }, h("summary", { class: "group__label" }, icons.chevronRight(), "Archived", h("span", { class: "group__count" }, String(archived.length))), h("ul", { class: "habit-cards", role: "list" }, ...archived.map((x) => card(x, data.today))))
          : null,
      ].filter((x): x is HTMLElement => !!x)
    );
    painted = true;
  };
  const load = () => loadHabits().then(paint, () => {
    if (dead || painted) return;
    body.removeAttribute("aria-busy");
    body.replaceChildren(h("div", { class: "life-empty" }, h("p", { class: "life-empty__title" }, "Habits didn't load"), h("p", { class: "life-empty__text" }, "Check you're online, then come back to this page.")));
  });
  void load();
  // A habit made, changed or ticked: the page follows.
  let soon: number | undefined;
  const off = onHabitsChange(() => {
    clearTimeout(soon);
    soon = window.setTimeout(() => void load(), 250);
  });
  return {
    el,
    destroy: () => {
      dead = true;
      off();
    },
  };
}
