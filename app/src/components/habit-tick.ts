/**
 * One of the owner's own habits as a thing to tick: a pill with the habit's
 * icon in a disc. A tap ticks it (a target counts up one; a full one clears).
 * For a target, a long press or a right click opens a small stepper in place
 * to set the count, and ↑/↓ on the keyboard change it. Every change says what happened in a toast with
 * Undo. The count shows at once and is saved behind it (db/habits.ts), so
 * it works with no signal.
 *
 * Used on Today (components/habit-today.ts), the Library's Habits page and
 * a day's Habits chips (components/day-habits.ts).
 */

import "../styles/own-habits.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { setHabitDay, type OwnHabit } from "../db/habits";
import { settle } from "../lib/finish-motion";
import { clampProgress, isDone, nextTap, progressNote } from "../../../lib/habit-rules";

const LONG_PRESS_MS = 450;

/** The words a toast and a screen reader use for a count. */
export function countWords(habit: OwnHabit, progress: number): string {
  if (!habit.target) return progress > 0 ? "done" : "not done";
  return progressNote(progress, habit.target, habit.unit);
}

/** Save a new count, with a toast that can undo it. */
export function changeHabit(habit: OwnHabit, date: string, was: number, next: number): void {
  if (was === next) return;
  const message = habit.target
    ? isDone(next, habit.target) && !isDone(was, habit.target)
      ? `${habit.name} done`
      : `${habit.name}: ${progressNote(next, habit.target, habit.unit)}`
    : next > 0
      ? `Ticked ${habit.name}`
      : `Unticked ${habit.name}`;
  setHabitDay(habit.id, date, next, was).then(
    (how) =>
      showToast(how === "queued" ? `${message}. It saves when you're back online.` : message, {
        icon: how === "queued" ? "wifiOff" : "check",
        action: { label: "Undo", run: () => void setHabitDay(habit.id, date, was, next).catch(() => undefined) },
      }),
    (error) => showToast(error instanceof Error ? error.message : "That didn't save", { icon: "close", timeoutMs: 4000 })
  );
}

/** The disc: the habit's icon, a ring for a target's count, a tick once it's done. */
export function habitDisc(habit: OwnHabit, progress: number): HTMLElement {
  const done = isDone(progress, habit.target);
  const share = habit.target ? Math.min(1, progress / habit.target) : done ? 1 : 0;
  return h(
    "span",
    { class: `habit-disc${done ? " habit-disc--done" : ""}`, style: `--share:${share}`, "aria-hidden": "true" },
    done ? icons.check() : (icons[habit.icon as IconName] ?? icons.check)()
  );
}

export interface TickOptions {
  date: string;
  /** "tile" on Today, "chip" on a day page, "disc" (the disc alone) on a habit card. */
  look?: "tile" | "chip" | "disc";
  /** Shown after the name: a streak, "2 of 3 this week". */
  aside?: string | null;
}

/** A tickable habit. Repaints itself when its count changes. */
export function habitTick(habit: OwnHabit, progress: number, opts: TickOptions): HTMLElement {
  let current = progress;
  let stepping = false;
  let pressTimer: number | undefined;
  let pressed = false;
  const look = opts.look ?? "tile";
  const el = h("div", { class: `habit-tick habit-tick--${look}`, "data-habit": habit.id });
  const button = h("button", { class: "habit-tick__btn", type: "button" }) as HTMLButtonElement;

  function label() {
    const what = habit.target ? `${habit.name}, ${progressNote(current, habit.target, habit.unit)}` : `${habit.name}, ${current > 0 ? "done" : "not done"}`;
    return `${what}. ${habit.target ? "Tap to add one. Press and hold to set the count." : "Tap to tick."}`;
  }

  function paint() {
    const done = isDone(current, habit.target);
    el.classList.toggle("is-done", done);
    el.classList.toggle("is-stepping", stepping);
    button.setAttribute("aria-label", label());
    button.setAttribute("aria-pressed", String(done));
    const count = habit.target ? h("span", { class: "habit-tick__count" }, `${current}/${habit.target}`) : null;
    if (look === "disc") {
      button.replaceChildren(habitDisc(habit, current));
      el.replaceChildren(stepping ? stepper() : button);
      return;
    }
    button.replaceChildren(
      ...[
        habitDisc(habit, current),
        h("span", { class: "habit-tick__text" }, h("span", { class: "habit-tick__name" }, habit.name), opts.aside && look === "tile" ? h("span", { class: "habit-tick__aside" }, opts.aside) : null),
        count,
      ].filter((x): x is HTMLElement => !!x)
    );
    el.replaceChildren(stepping ? stepper() : button);
  }

  function set(next: number) {
    const n = clampProgress(next);
    if (n === current) return;
    const was = current;
    current = n;
    paint();
    // It settles into its new state: small, and the same as the mood choice.
    settle(button);
    changeHabit(habit, opts.date, was, n);
  }

  function stepper(): HTMLElement {
    const t = habit.target ?? 1;
    // One toast for the whole adjustment, when it closes.
    const minus = h("button", { class: "habit-step__btn", type: "button", "aria-label": `One less ${habit.unit ?? ""}`.trim() }, "−");
    const plus = h("button", { class: "habit-step__btn", type: "button", "aria-label": `One more ${habit.unit ?? ""}`.trim() }, icons.plus());
    const value = h("span", { class: "habit-step__value", "aria-live": "polite" });
    const close = h("button", { class: "habit-step__done", type: "button", "aria-label": "Done" }, icons.check());
    const start = current;
    let n = current;
    const show = () => {
      value.textContent = habit.target ? `${n} of ${t}` : n ? "Done" : "Not done";
      (minus as HTMLButtonElement).disabled = n <= 0;
    };
    let idle: number | undefined;
    const finish = () => {
      clearTimeout(idle);
      stepping = false;
      current = start;
      paint();
      set(n);
      button.focus();
    };
    const nudge = () => {
      clearTimeout(idle);
      idle = window.setTimeout(finish, 4000);
    };
    minus.addEventListener("click", () => {
      n = Math.max(0, n - 1);
      show();
      nudge();
    });
    plus.addEventListener("click", () => {
      n = habit.target ? n + 1 : 1;
      show();
      nudge();
    });
    close.addEventListener("click", finish);
    const box = h("div", { class: "habit-step", role: "group", "aria-label": `${habit.name}: set the count` }, h("span", { class: "habit-step__name" }, habit.name), minus, value, plus, close);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        clearTimeout(idle);
        stepping = false;
        paint();
        button.focus();
      }
    });
    show();
    nudge();
    requestAnimationFrame(() => plus.focus());
    return box;
  }

  // Only a count needs a stepper; a plain habit is a tap either way.
  const openStepper = () => {
    if (!habit.target) return;
    stepping = true;
    paint();
  };

  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pressed = false;
    if (!habit.target) return;
    pressTimer = window.setTimeout(() => {
      pressed = true;
      navigator.vibrate?.(8);
      openStepper();
    }, LONG_PRESS_MS);
  });
  const cancel = () => clearTimeout(pressTimer);
  button.addEventListener("pointerup", cancel);
  button.addEventListener("pointerleave", cancel);
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("contextmenu", (e) => {
    if (!habit.target) return;
    e.preventDefault();
    cancel();
    if (!pressed) openStepper();
  });
  button.addEventListener("click", (e) => {
    if (pressed) {
      e.preventDefault();
      pressed = false;
      return;
    }
    set(nextTap(current, habit.target));
  });
  button.addEventListener("keydown", (e) => {
    if (!habit.target || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    set(current + (e.key === "ArrowUp" ? 1 : -1));
  });

  paint();
  return el;
}
