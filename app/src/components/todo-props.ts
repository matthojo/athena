/**
 * A to-do's properties as a row of pills under its title: when it's due,
 * who it's with, its priority, its area and where it gets done. Each pill
 * says its value (or, in grey with a dashed outline, what it's for) and
 * opens a small popover to change it: a month calendar with quick picks for
 * the date, the people picker, and short menus for the rest. Only the
 * property being changed shows its picker, so the sheet stays short.
 *
 * Popovers are `popover="auto"` panels put inside the open sheet's dialog,
 * so they sit in the top layer above it and dismiss on Escape or a tap
 * outside.
 */

import { h, svg } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { personPicker } from "./person-picker";
import { contextById, liveContexts, type ContextKind } from "../db/todo-contexts";
import { KIND_WORDS } from "./todo-context-ui";
import { dueLabel } from "./loop-row";
import { addDays, daysBetween } from "../../../lib/dates";
import { localToday } from "../lib/time";
import { PRIORITY_LABEL, type TodoPriority } from "../../../lib/todo-details";
import type { PersonRef } from "../types";

// ---------- the popover ----------

let popSeq = 0;

/** Open a panel by `anchor`, built fresh each time; gone again when it closes. */
export function openPopover(anchor: HTMLElement, build: (close: () => void) => HTMLElement, opts: { className?: string; label: string; width?: number } = { label: "" }): void {
  const host = anchor.closest("dialog") ?? document.body;
  const pop = h("div", { class: `menu todo-pop ${opts.className ?? ""}`, id: `todo-pop-${++popSeq}`, popover: "auto", role: "dialog", "aria-label": opts.label }) as HTMLElement & {
    showPopover: () => void;
    hidePopover: () => void;
  };
  const close = () => {
    try {
      pop.hidePopover();
    } catch {
      pop.remove();
    }
  };
  pop.append(build(close));
  host.append(pop);
  pop.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "closed") {
      pop.remove();
      anchor.setAttribute("aria-expanded", "false");
      if (document.activeElement === document.body || !document.activeElement) anchor.focus({ preventScroll: true });
    }
  });
  pop.showPopover();
  anchor.setAttribute("aria-expanded", "true");
  place(pop, anchor, opts.width);
  // Whatever wants the keyboard first (a search box, the selected day).
  requestAnimationFrame(() => pop.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }));
}

/** Under the anchor, or over it when there's no room below; never off the side of the screen. */
function place(pop: HTMLElement, anchor: HTMLElement, width?: number) {
  const r = anchor.getBoundingClientRect();
  const w = Math.min(width ?? 272, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.right = "auto";
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  const height = pop.offsetHeight;
  const below = window.innerHeight - r.bottom - 12;
  const top = below >= height || below > r.top ? r.bottom + 6 : Math.max(12, r.top - height - 6);
  pop.style.top = `${Math.min(top, Math.max(12, window.innerHeight - height - 12))}px`;
}

// ---------- the pill ----------

export interface PropPill {
  el: HTMLButtonElement;
  paint: () => void;
}

function pill(opts: { name: string; paint: (btn: HTMLButtonElement) => void; open: (btn: HTMLButtonElement) => void }): PropPill {
  const el = h("button", { class: "tprop", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "data-prop": opts.name }) as HTMLButtonElement;
  el.addEventListener("click", () => opts.open(el));
  const paint = () => opts.paint(el);
  paint();
  return { el, paint };
}

/** A pill's insides: its mark, its words, and whether it holds a value. */
function fill(btn: HTMLButtonElement, mark: Node, text: string, set: boolean, aria: string, tone?: string) {
  btn.replaceChildren(mark, h("span", { class: "tprop__text" }, text));
  btn.dataset.set = String(set);
  if (tone) btn.dataset.tone = tone;
  else delete btn.dataset.tone;
  btn.setAttribute("aria-label", aria);
}

/** A menu row inside a popover: mark, label, an optional hint on the right, ticked when chosen. */
function popRow(opts: { mark: Node | null; label: string; hint?: string; on?: boolean; danger?: boolean; run: () => void }): HTMLButtonElement {
  const b = h(
    "button",
    { class: `menu__item todo-pop__row${opts.danger ? " menu__item--danger" : ""}`, type: "button", role: "menuitemradio", "aria-checked": String(!!opts.on) },
    opts.mark ?? h("span", { class: "todo-pop__blank", "aria-hidden": "true" }),
    h("span", { class: "menu__label" }, opts.label),
    opts.hint ? h("span", { class: "todo-pop__hint" }, opts.hint) : null,
    opts.on ? icons.check() : null
  ) as HTMLButtonElement;
  b.addEventListener("click", opts.run);
  return b;
}

/** Arrow keys between a popover's rows. */
function arrowRows(list: HTMLElement) {
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLElement>(".todo-pop__row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  });
}

// ---------- due date ----------

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const FULL = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const utc = (d: string) => new Date(`${d}T12:00:00Z`);
const weekday = (d: string) => utc(d).getUTCDay(); // 0 Sunday

/** The quick picks: today, tomorrow, this weekend (Saturday), next week (Monday); none that repeats another. */
export function quickDates(today = localToday()): { label: string; value: string; icon: IconName }[] {
  const wd = weekday(today);
  const tomorrow = addDays(today, 1);
  const picks: { label: string; value: string; icon: IconName }[] = [
    { label: "Today", value: today, icon: "star" },
    { label: "Tomorrow", value: tomorrow, icon: "calendar" },
  ];
  const saturday = addDays(today, (6 - wd + 7) % 7);
  if (wd >= 1 && wd <= 4) picks.push({ label: "This weekend", value: saturday, icon: "cup" });
  const monday = addDays(today, (8 - wd) % 7 || 7);
  if (monday !== tomorrow) picks.push({ label: "Next week", value: monday, icon: "arrowRight" });
  return picks;
}

/** A month grid, Monday first, with the chosen day filled and today ringed. */
function monthGrid(chosen: string | null, onPick: (d: string) => void): HTMLElement {
  const today = localToday();
  let month = (chosen ?? today).slice(0, 7);
  const title = h("span", { class: "tcal__title", "aria-live": "polite" });
  const prev = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tcal__nav", type: "button", "aria-label": "Previous month" }, icons.back());
  const next = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tcal__nav tcal__nav--next", type: "button", "aria-label": "Next month" }, icons.chevronRight());
  const grid = h("div", { class: "tcal__grid", role: "grid" });
  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    paint();
  };
  prev.addEventListener("click", () => shift(-1));
  next.addEventListener("click", () => shift(1));

  function paint(focusDay?: string) {
    const first = `${month}-01`;
    title.textContent = MONTH_YEAR.format(utc(first));
    const lead = (weekday(first) + 6) % 7;
    const start = addDays(first, -lead);
    const heads = ["M", "T", "W", "T", "F", "S", "S"].map((l) => h("span", { class: "tcal__head", "aria-hidden": "true" }, l));
    const days: HTMLElement[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i >= 35 && d.slice(0, 7) !== month) break;
      const b = h(
        "button",
        {
          class: "tcal__day",
          type: "button",
          tabindex: d === (focusDay ?? chosen ?? today) ? 0 : -1,
          "data-day": d,
          "data-out": d.slice(0, 7) !== month ? "" : undefined,
          "data-past": d < today ? "" : undefined,
          "data-today": d === today ? "" : undefined,
          "aria-pressed": String(d === chosen),
          "aria-label": FULL.format(utc(d)),
        },
        String(Number(d.slice(8)))
      );
      b.addEventListener("click", () => onPick(d));
      days.push(b);
    }
    grid.replaceChildren(...heads, ...days);
    if (focusDay) grid.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
  }
  // Arrow keys move by day and week, across months.
  grid.addEventListener("keydown", (e) => {
    const at = (document.activeElement as HTMLElement | null)?.dataset.day;
    if (!at) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const to = addDays(at, step);
    if (to.slice(0, 7) !== month) month = to.slice(0, 7);
    paint(to);
  });
  paint();
  return h("div", { class: "tcal" }, h("div", { class: "tcal__bar" }, title, h("span", { class: "tcal__navs" }, prev, next)), grid);
}

export function duePill(opts: { value: () => string | null; onChange: (d: string | null) => void }): PropPill {
  return pill({
    name: "due",
    paint(btn) {
      const v = opts.value();
      if (!v) return fill(btn, icons.calendar(), "Date", false, "Due date: none. Set one");
      const d = dueLabel(v);
      // Within the week the weekday reads best; further out, the date.
      const n = daysBetween(localToday(), v);
      const text = d.tone === "late" || n <= 1 ? d.text : n < 7 ? WEEKDAY.format(utc(v)) : DAY_MONTH.format(utc(v));
      fill(btn, d.tone === "late" ? icons.clock() : icons.calendar(), text, true, `Due ${FULL.format(utc(v))}. Change`, d.tone || undefined);
    },
    open(btn) {
      openPopover(
        btn,
        (close) => {
          const pick = (d: string | null) => {
            close();
            if (d !== opts.value()) opts.onChange(d);
          };
          const now = opts.value();
          const rows = h(
            "div",
            { class: "todo-pop__rows", role: "menu" },
            ...quickDates().map((q) => popRow({ mark: icons[q.icon](), label: q.label, hint: WEEKDAY.format(utc(q.value)), on: now === q.value, run: () => pick(q.value) })),
            now ? popRow({ mark: icons.close(), label: "Remove date", run: () => pick(null) }) : null
          );
          arrowRows(rows);
          const cal = monthGrid(now, (d) => pick(d));
          cal.querySelector<HTMLElement>('.tcal__day[tabindex="0"]')?.setAttribute("data-autofocus", "");
          return h("div", { class: "todo-pop__due" }, rows, h("div", { class: "menu__sep" }), cal);
        },
        { label: "Due date", className: "todo-pop--due", width: 288 }
      );
    },
  });
}

// ---------- person ----------

const firstName = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];

export function personPill(opts: { value: () => PersonRef | null; label: () => string; onChange: (p: PersonRef | null) => void }): PropPill {
  return pill({
    name: "person",
    paint(btn) {
      const p = opts.value();
      if (!p) return fill(btn, icons.person(), opts.label(), false, `${opts.label()}: nobody. Choose someone`);
      // Reads as a phrase: "With Priya Shah", "Waiting on Marcus Webb".
      fill(btn, h("span", { class: "tprop__avatar", "aria-hidden": "true" }, firstName(p.name).slice(0, 1).toUpperCase()), `${opts.label()} ${p.name}`, true, `${opts.label()} ${p.name}. Change`);
    },
    open(btn) {
      openPopover(
        btn,
        (close) => {
          const current = opts.value();
          const picker = personPicker({
            value: null,
            label: opts.label(),
            placeholder: "Search people",
            onChange: (p) => {
              if (!p) return;
              close();
              opts.onChange(p);
            },
          });
          const wrap = h("div", { class: "todo-pop__person" }, picker.el);
          if (current) {
            wrap.prepend(
              h("p", { class: "todo-pop__label" }, opts.label()),
              h(
                "div",
                { class: "todo-pop__rows" },
                popRow({ mark: h("span", { class: "tprop__avatar", "aria-hidden": "true" }, firstName(current.name).slice(0, 1).toUpperCase()), label: current.name, on: true, run: close }),
                popRow({
                  mark: icons.close(),
                  label: "Remove",
                  run: () => {
                    close();
                    opts.onChange(null);
                  },
                })
              ),
              h("div", { class: "menu__sep" })
            );
          }
          requestAnimationFrame(() => picker.focus());
          return wrap;
        },
        { label: opts.label(), className: "todo-pop--person", width: 300 }
      );
    },
  });
}

// ---------- priority ----------

/** Three rising bars, as many filled as the priority is high. */
export function priorityMark(p: TodoPriority): SVGSVGElement {
  const bar = (i: number, x: number, hgt: number) => `<rect x="${x}" y="${19 - hgt}" width="3.6" height="${hgt}" rx="1.2" ${i <= p ? 'fill="currentColor"' : 'fill="currentColor" opacity="0.22"'}/>`;
  const el = svg(`<svg viewBox="0 0 24 24" aria-hidden="true">${bar(1, 4.5, 6)}${bar(2, 10.2, 10)}${bar(3, 15.9, 14)}</svg>`);
  el.classList.add("prio-mark");
  el.dataset.priority = String(p);
  return el;
}

export function priorityPill(opts: { value: () => TodoPriority; onChange: (p: TodoPriority) => void }): PropPill {
  return pill({
    name: "priority",
    paint(btn) {
      const p = opts.value();
      fill(btn, priorityMark(p), p ? PRIORITY_LABEL[p] : "Priority", p > 0, p ? `Priority ${PRIORITY_LABEL[p].toLowerCase()}. Change` : "Priority: none. Set one");
      btn.dataset.priority = String(p);
    },
    open(btn) {
      openPopover(
        btn,
        (close) => {
          const now = opts.value();
          const rows = h(
            "div",
            { class: "todo-pop__rows", role: "menu" },
            ...([3, 2, 1, 0] as TodoPriority[]).map((p) => {
              const row = popRow({
                mark: priorityMark(p),
                label: PRIORITY_LABEL[p],
                hint: String(p === 0 ? 0 : 4 - p),
                on: p === now,
                run: () => {
                  close();
                  if (p !== now) opts.onChange(p);
                },
              });
              if (p === now) row.dataset.autofocus = "";
              return row;
            })
          );
          arrowRows(rows);
          // Number keys pick: 1 high, 2 medium, 3 low, 0 none.
          rows.addEventListener("keydown", (e) => {
            const map: Record<string, TodoPriority> = { "1": 3, "2": 2, "3": 1, "0": 0 };
            if (!(e.key in map)) return;
            e.preventDefault();
            close();
            if (map[e.key] !== now) opts.onChange(map[e.key]);
          });
          return rows;
        },
        { label: "Priority", width: 220 }
      );
    },
  });
}

// ---------- area and where ----------

const ctxIcon = (name: string) => (icons[name as IconName] ?? icons.tag)();

export function contextPill(kind: ContextKind, opts: { value: () => string | null; onChange: (id: string | null) => void }): PropPill {
  const words = KIND_WORDS[kind];
  return pill({
    name: kind,
    paint(btn) {
      const c = contextById(opts.value());
      if (!c) return fill(btn, kind === "area" ? icons.target() : icons.pin(), words.label, false, `${words.label}: not set. Choose one`);
      const mark = kind === "area" ? h("span", { class: "ctx-dot", "data-colour": c.colour, "aria-hidden": "true" }) : ctxIcon(c.icon);
      fill(btn, mark, c.name, true, `${words.label}: ${c.name}. Change`);
      btn.dataset.colour = c.colour;
    },
    open(btn) {
      openPopover(
        btn,
        (close) => {
          const now = opts.value();
          const pick = (id: string | null) => {
            close();
            if (id !== now) opts.onChange(id);
          };
          const live = liveContexts(kind);
          const rows = h(
            "div",
            { class: "todo-pop__rows", role: "menu" },
            ...live.map((c) => {
              const row = popRow({
                mark: kind === "area" ? h("span", { class: "ctx-dot", "data-colour": c.colour, "aria-hidden": "true" }) : ctxIcon(c.icon),
                label: c.name,
                on: c.id === now,
                run: () => pick(c.id),
              });
              if (c.id === now) row.dataset.autofocus = "";
              return row;
            }),
            now ? h("div", { class: "menu__sep" }) : null,
            now ? popRow({ mark: icons.close(), label: kind === "area" ? "No area" : "Clear where", run: () => pick(null) }) : null
          );
          if (!live.length) rows.append(h("p", { class: "todo-pop__empty" }, "None yet. Add some in Settings → To do."));
          if (!rows.querySelector("[data-autofocus]")) rows.querySelector(".todo-pop__row")?.setAttribute("data-autofocus", "");
          arrowRows(rows);
          return rows;
        },
        { label: words.label, width: 232 }
      );
    },
  });
}
