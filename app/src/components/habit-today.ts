/**
 * Today's habits on the Today block (Home and the Days feed): the owner's own
 * habits due today as one-tap ticks (components/habit-tick.ts), with how
 * many are done. A weekly habit shows until the week's count is met. Hidden
 * when there are no habits made in Athena, so Today stays as it was.
 */

import { h } from "../lib/dom";
import { habitTick } from "./habit-tick";
import { loadHabitsOn, onHabitsChange, type HabitsOn } from "../db/habits";
import { isDone } from "../../../lib/habit-rules";

/** "4 in a row", "3 weeks running", "2 of 3 this week". */
export function streakAside(d: { streak: number; streak_unit: "day" | "week"; week_done?: number }, perWeek: number | null): string | null {
  if (perWeek) return d.streak >= 2 ? `${d.streak} weeks running` : `${d.week_done ?? 0} of ${perWeek} this week`;
  return d.streak >= 2 ? `${d.streak} in a row` : null;
}

export function todayHabits(today: string): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "today-habits", hidden: true });
  let dead = false;

  function paint(data: HabitsOn) {
    if (dead) return;
    const byId = new Map(data.habits.map((x) => [x.id, x]));
    const due = data.on.filter((d) => d.shows && byId.has(d.id));
    if (!due.length) {
      el.hidden = true;
      return;
    }
    const done = due.filter((d) => isDone(d.progress, byId.get(d.id)!.target)).length;
    el.hidden = false;
    el.replaceChildren(
      h(
        "div",
        { class: "today-habits__head" },
        h("p", { class: "today__label" }, "Habits today"),
        h("span", { class: "today-habits__count" }, done === due.length ? (due.length === 1 ? "Done" : `All ${due.length} done`) : `${done} of ${due.length} done`)
      ),
      h(
        "div",
        { class: "today-habits__list", role: "list" },
        ...due.map((d) => {
          const habit = byId.get(d.id)!;
          const t = habitTick(habit, d.progress, { date: today, aside: streakAside(d, habit.per_week) });
          t.setAttribute("role", "listitem");
          return t;
        })
      )
    );
  }

  const load = () => loadHabitsOn(today).then(paint, () => undefined);
  void load();
  const off = onHabitsChange(() => void load());
  return {
    el,
    destroy() {
      dead = true;
      off();
    },
  };
}
