/**
 * Money and home on a day page, each one line, only when the owner turned
 * them on in Settings → Days (the server leaves them out otherwise: they're
 * sealed). Money: "£42 spent" with the biggest categories under it and a
 * thin bar split by category. Home: the day's electricity with when most of
 * it was used and the day's 24 hours as small bars, and its gas, each only
 * when the account has that meter.
 */

import "../styles/life.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { CATEGORY_WORDS, money } from "../db/life";
import type { Day } from "../db/days-app";

const NS = "http://www.w3.org/2000/svg";
const sv = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** The day's 24 hours as bars, evening (18:00–23:00) in the accent, the rest quiet. */
export function hourBars(byHour: number[], opts: { width?: number; height?: number } = {}): SVGSVGElement {
  const W = opts.width ?? 112;
  const H = opts.height ?? 36;
  const max = Math.max(...byHour, 0.01);
  const step = W / 24;
  const svg = sv("svg", { class: "hour-bars", viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" }) as SVGSVGElement;
  svg.append(sv("line", { class: "hour-bars__base", x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
  byHour.forEach((v, i) => {
    const bh = Math.max(1.5, (v / max) * (H - 4));
    svg.append(sv("rect", { class: `hour-bars__bar${i >= 18 && i < 23 ? " hour-bars__bar--evening" : ""}`, x: (i * step + 0.75).toFixed(2), y: (H - 1 - bh).toFixed(2), width: (step - 1.5).toFixed(2), height: bh.toFixed(2), rx: 1 }));
  });
  return svg;
}

/** The day's spending split by category, largest first: one thin bar. */
function splitBar(categories: NonNullable<Day["money"]>["categories"], total: number): HTMLElement {
  return h(
    "span",
    { class: "money-split", "aria-hidden": "true" },
    ...categories.slice(0, 4).map((c, i) => h("span", { class: `money-split__part money-split__part--${i}`, style: `flex-grow:${Math.max(1, Math.round((c.amount / total) * 100))}` }))
  );
}

export function moneyHomeSection(day: Pick<Day, "money" | "home">): HTMLElement | null {
  const m = day.money;
  const home = day.home;
  if (!m && !home) return null;
  const rows: HTMLElement[] = [];
  if (m) {
    const parts = m.categories.slice(0, 3).map((c) => `${CATEGORY_WORDS[c.category].toLowerCase()} ${money(c.amount, m.currency)}`);
    rows.push(
      h(
        "li",
        { class: "day-health__row day-money__row" },
        h("span", { class: "day-health__icon", "aria-hidden": "true" }, icons.wallet()),
        h(
          "span",
          { class: "day-health__words" },
          h("span", { class: "day-health__text" }, `${money(m.spent, m.currency)} spent`),
          h("span", { class: "day-health__aside" }, m.categories.length === 1 ? `All ${CATEGORY_WORDS[m.categories[0].category].toLowerCase()}` : parts.join(" · ")),
          m.categories.length > 1 ? splitBar(m.categories, m.spent) : null
        )
      )
    );
  }
  // Each fuel only when the account has its meter: a gas-only home has no electricity row.
  if (home?.kwh !== undefined) {
    const when = home.line.match(/mostly (\d\d:\d\d–\d\d:\d\d)/)?.[1];
    rows.push(
      h(
        "li",
        { class: "day-health__row day-money__row" },
        h("span", { class: "day-health__icon", "aria-hidden": "true" }, icons.home()),
        h(
          "span",
          { class: "day-health__words" },
          h("span", { class: "day-health__text" }, `Used ${home.kwh.toFixed(1)} kWh${home.gas_kwh !== undefined ? " of electricity" : ""}`),
          h("span", { class: "day-health__aside" }, when ? `Mostly ${when}` : "Spread through the day")
        ),
        home.by_hour?.length === 24 ? hourBars(home.by_hour) : null
      )
    );
  }
  if (home?.gas_kwh !== undefined) {
    rows.push(
      h(
        "li",
        { class: "day-health__row day-money__row" },
        h("span", { class: "day-health__icon", "aria-hidden": "true" }, icons.flame()),
        h("span", { class: "day-health__words" }, h("span", { class: "day-health__text" }, `Used ${home.gas_kwh.toFixed(1)} kWh of gas`))
      )
    );
  }
  const title = m && home ? "Money and home" : m ? "Money" : "Home";
  return h(
    "section",
    { class: "day-sec day-health day-money", "aria-labelledby": "day-money-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-money-title" }, title), h("span", { class: "day-sec__sub" }, "Only you see this")),
    h("ul", { class: "day-health__list", role: "list" }, ...rows)
  );
}
