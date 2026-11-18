/**
 * Habits on a day page: one chip per habit, done ones filled with a tick,
 * the rest outlined, a counted goal's progress inside the chip ("3 of 5").
 * The words over it say how the day went: "3 of 5 done".
 *
 * The owner's own habits come first and can be ticked on any day up to
 * today (components/habit-tick.ts), including ones due that day with
 * nothing ticked yet. Habits from other apps (Habitify, Todoist, Loop,
 * Daylio, Bearable) stay as they were sent, under their app's name.
 */

import "../styles/life.css";
import "../styles/own-habits.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { habitTick } from "./habit-tick";
import { loadHabitsOn, onHabitsChange, type HabitsOn } from "../db/habits";
import { isDone, progressOf } from "../../../lib/habit-rules";
import type { DayEntry } from "../db/days-app";

const SHORT_NOTE = /^(\d+(?:\.\d+)?) of (\d+(?:\.\d+)?)\b/;
const APP: Record<string, string> = { athena: "Athena", habitify: "Habitify", todoist: "Todoist", loop: "Loop", daylio: "Daylio", bearable: "Bearable" };
const doneEntry = (e: DayEntry) => (e.count ?? 1) > 0;

function staticChip(e: DayEntry): HTMLElement {
  const isDone_ = doneEntry(e);
  const short = e.note?.match(SHORT_NOTE);
  const extra = isDone_ ? null : short ? `${short[1]} of ${short[2]}` : e.note === "skipped" ? "skipped" : null;
  return h(
    "li",
    { class: `habit-chip${isDone_ ? " habit-chip--done" : ""}`, "data-ids": e.id, "data-name": e.title },
    isDone_ ? h("span", { class: "habit-chip__tick", "aria-hidden": "true" }, icons.check()) : null,
    h("span", { class: "habit-chip__name" }, e.title),
    extra ? h("span", { class: "habit-chip__note" }, extra) : null,
    h("span", { class: "visually-hidden" }, `${isDone_ ? ", done" : e.note ? `, ${e.note}` : ", not done"}, from ${APP[e.source] ?? e.source}`)
  );
}

const byDone = (a: DayEntry, b: DayEntry) => Number(doneEntry(b)) - Number(doneEntry(a)) || a.title.localeCompare(b.title);

/** The day's habits. With `date`, Athena's own habits for that day load in and can be ticked. */
export function habitSection(entries: DayEntry[], date?: string): HTMLElement {
  const sub = h("span", { class: "day-sec__sub" });
  const lists = h("div", { class: "habit-day-groups" });
  const sec = h(
    "section",
    { class: "day-sec day-sec--habit day-habits", "aria-labelledby": "day-sec-habit" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-sec-habit" }, "Habits"), sub),
    lists
  );

  function paint(own: HabitsOn | null) {
    const imported = entries.filter((e) => e.source !== "athena");
    const ownEntries = entries.filter((e) => e.source === "athena");
    const groups: HTMLElement[] = [];
    let done = 0;
    let all = 0;
    // Athena's: tickable when the habit is live, else as it was written.
    const live = new Map((own?.habits ?? []).filter((x) => !x.archived_at).map((x) => [x.name.toLowerCase(), x]));
    const ticks: HTMLElement[] = [];
    const seen = new Set<string>();
    if (own && date) {
      for (const d of own.on) {
        const habit = own.habits.find((x) => x.id === d.id);
        const entry = habit && ownEntries.find((e) => e.title.toLowerCase() === habit.name.toLowerCase());
        if (!habit || (!d.shows && !entry)) continue;
        seen.add(habit.name.toLowerCase());
        const progress = entry ? progressOf(entry, habit.target) : d.progress;
        const t = habitTick(habit, progress, { date, look: "chip" });
        ticks.push(h("li", { class: "habit-day__item" }, t));
        all++;
        if (isDone(progress, habit.target)) done++;
      }
    }
    for (const e of ownEntries.filter((e) => !seen.has(e.title.toLowerCase()) && !live.has(e.title.toLowerCase())).sort(byDone)) {
      ticks.push(staticChip(e));
      all++;
      if (doneEntry(e)) done++;
    }
    if (ticks.length) groups.push(h("div", { class: "habit-day-group" }, h("ul", { class: "habit-chips", role: "list", "aria-label": "Your habits" }, ...ticks)));
    const sources = [...new Set(imported.map((e) => e.source))].sort((a, b) => (APP[a] ?? a).localeCompare(APP[b] ?? b));
    for (const src of sources) {
      const xs = imported.filter((e) => e.source === src).sort(byDone);
      all += xs.length;
      done += xs.filter(doneEntry).length;
      groups.push(
        h(
          "div",
          { class: "habit-day-group" },
          ticks.length || sources.length > 1 ? h("p", { class: "habit-day-group__label" }, `From ${APP[src] ?? src}`) : null,
          h("ul", { class: "habit-chips", role: "list" }, ...xs.map(staticChip))
        )
      );
    }
    sec.hidden = all === 0;
    sub.textContent = done === all ? (all === 1 ? "Done" : `All ${all} done`) : `${done} of ${all} done`;
    lists.replaceChildren(...groups);
  }

  paint(null);
  if (date) {
    let off: (() => void) | null = null;
    const load = () =>
      loadHabitsOn(date).then(
        (x) => {
          if (!sec.isConnected && off) {
            off();
            return;
          }
          paint(x);
        },
        () => undefined
      );
    void load();
    let soon: number | undefined;
    off = onHabitsChange(() => {
      clearTimeout(soon);
      soon = window.setTimeout(() => void load(), 250);
    });
  }
  return sec;
}
