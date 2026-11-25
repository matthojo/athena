/**
 * Mood as coloured dots (Health → Wellness, the Mood card): a dot a day over
 * four weeks, a week over six months, a month over a year
 * (components/wellness-words.ts dotGrid lays them out). Each dot is the
 * average of every mood answer in it, coloured by the nearest answer, low to
 * great: a diverging pair around a grey "okay" (tokens.css --mood-1 to 5,
 * validated). A hollow ring is a dot with no answer. Three steps are under
 * 3:1 on the card, so the levels are always named: a legend with the
 * question's words, the same tooltip on pointer and keyboard as the other
 * charts, and a visually hidden table with every value.
 */

import { h } from "../lib/dom";
import { stepOf, type DotCell, type DotGrid } from "./wellness-words";

export interface MoodDotsOptions {
  grid: DotGrid;
  /** The question's five levels, low first ("Low" … "Great"). */
  levels: string[];
  /** "Mood each day": the chart's name and the table's caption. */
  label: string;
  format: (v: number) => string;
}

export function moodDots(o: MoodDotsOptions): HTMLElement {
  const cells: Array<{ cell: DotCell; dot: HTMLElement }> = [];
  const tip = h("div", { class: "mdots__tip", "aria-hidden": "true" });
  const live = h("span", { class: "visually-hidden", "aria-live": "polite" });
  const text = (c: DotCell) => (c.value === null ? "No check-in" : o.format(c.value));

  const dotFor = (c: DotCell | null): HTMLElement => {
    if (!c) return h("span", { class: "mdots__cell mdots__cell--gap" });
    const dot = h("span", { class: `mdots__dot ${c.value === null ? "mdots__dot--none" : `mdots__dot--${stepOf(c.value)}`}` });
    const cell = h("span", { class: "mdots__cell", "data-i": String(cells.length) }, dot, c.caption ? h("span", { class: "mdots__caption" }, c.caption) : null);
    cells.push({ cell: c, dot });
    return cell;
  };

  const plot = h(
    "div",
    { class: `mdots__plot mdots__plot--${o.grid.kind}`, "aria-hidden": "true" },
    ...(o.grid.columns ? [h("span", { class: "mdots__label" }), ...o.grid.columns.map((c) => h("span", { class: "mdots__col" }, c))] : []),
    ...o.grid.rows.flatMap((r) => [...(o.grid.kind === "months" ? [] : [h("span", { class: "mdots__label" }, r.label ?? "")]), ...r.cells.map(dotFor)])
  );

  const legend = h(
    "ul",
    { class: "mdots__legend", "aria-label": "Key" },
    ...o.levels.map((word, i) => h("li", {}, h("i", { class: `mdots__swatch mdots__dot--${i + 1}`, "aria-hidden": "true" }), word)),
    h("li", {}, h("i", { class: "mdots__swatch mdots__dot--none", "aria-hidden": "true" }), "No check-in")
  );

  const table = h(
    "div",
    { class: "visually-hidden" },
    h("table", {}, h("caption", {}, o.label), h("tbody", {}, ...cells.map(({ cell }) => h("tr", {}, h("th", { scope: "row" }, cell.label), h("td", {}, text(cell))))))
  );

  const root = h("div", { class: "mdots viz-root", role: "group", tabindex: "0", "aria-label": `${o.label}. Use the arrow keys to read each one.` }, plot, tip, legend, table, live);

  let index = cells.length - 1;
  const show = (k: number) => {
    index = k;
    const { cell, dot } = cells[k];
    cells.forEach((x, j) => x.dot.classList.toggle("is-current", j === k));
    tip.replaceChildren(document.createTextNode(text(cell)), h("span", { class: "meta" }, cell.label));
    const box = root.getBoundingClientRect();
    const d = dot.getBoundingClientRect();
    const left = Math.min(Math.max(d.left - box.left + d.width / 2 - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth);
    tip.style.transform = `translate(${left}px, ${d.top - box.top - tip.offsetHeight - 6}px)`;
    root.classList.add("is-hovering");
  };
  const hide = () => {
    root.classList.remove("is-hovering");
    cells.forEach((x) => x.dot.classList.remove("is-current"));
  };
  plot.addEventListener("pointerover", (e) => {
    const at = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (at) show(Number(at.dataset.i));
  });
  plot.addEventListener("pointerleave", () => document.activeElement !== root && hide());
  root.addEventListener("focus", () => cells.length && show(index));
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? cells.length - 1 : null;
    if (next === null || !cells.length) return;
    e.preventDefault();
    const k = Math.max(0, Math.min(cells.length - 1, next));
    show(k);
    live.textContent = `${cells[k].cell.label}: ${text(cells[k].cell)}`;
  });
  return root;
}
