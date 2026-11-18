/**
 * Health on a day page, in sentences: "Slept 7h 40m" with "40 min more than
 * usual" under it, and a small line of the two weeks before with the day
 * marked at its end. Workouts follow as one line each with the route sketch.
 * The sentence carries the meaning; the sparkline is a quiet picture of it.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { dayIcons } from "./day-icons";
import { routeSketch } from "./health-chart";
import { slimStageBar } from "./sleep-stages";
import { stagesLine } from "../../../lib/health-line";
import { addDays, healthSentences, smoothPath, hoursMinutes, km, workoutPhrase, type HealthFigures, type HealthSentence } from "./day-words";
import type { DayHealth } from "../db/days-app";

const NS = "http://www.w3.org/2000/svg";
const sv = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * The two weeks before, then the day (15 daily figures, null where there's
 * none): a smooth 2px line over a soft wash and one hairline baseline, with
 * a dot on the day. The same marks and height as the Health page's charts.
 */
export function daySpark(values: (number | null)[], opts: { width?: number; height?: number } = {}): SVGSVGElement | null {
  values = values.slice(-15);
  const known = values.map((v, i) => [i, v] as const).filter((x): x is readonly [number, number] => x[1] !== null);
  if (known.length < 3 || values[values.length - 1] === null) return null;
  const W = opts.width ?? 112;
  const H = opts.height ?? 44;
  const nums = known.map((k) => k[1]);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const pad = { top: 6, bottom: 6, left: 4, right: 6 };
  const base = H - pad.bottom;
  const x = (i: number) => pad.left + (i / Math.max(1, values.length - 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - min) / range) * (H - pad.top - pad.bottom - 4);
  const pts = known.map(([i, v]) => [x(i), y(v)] as [number, number]);
  const line = smoothPath(pts);
  const usual = nums.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, nums.length - 1);
  const svg = sv("svg", { class: "day-spark", viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" }) as SVGSVGElement;
  svg.append(
    sv("line", { class: "day-spark__usual", x1: pad.left, x2: W - pad.right, y1: y(usual).toFixed(1), y2: y(usual).toFixed(1) }),
    sv("line", { class: "day-spark__base", x1: pad.left, x2: W - pad.right, y1: base, y2: base }),
    sv("path", { class: "day-spark__area", d: `${line} L${pts[pts.length - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z` }),
    sv("path", { class: "day-spark__line", d: line })
  );
  const [lx, ly] = pts[pts.length - 1];
  svg.append(sv("circle", { class: "day-spark__end", cx: lx.toFixed(1), cy: ly.toFixed(1), r: 4 }));
  return svg;
}

/**
 * A full-width sparkline drawn at the row's real width, so a wide screen
 * gets a longer line, not a taller one (48px, like the Health page).
 */
function fitSpark(values: (number | null)[]): HTMLElement | null {
  if (!daySpark(values)) return null;
  const box = h("span", { class: "day-spark-fit", "aria-hidden": "true" });
  let w = 0;
  const draw = (width: number) => {
    if (width < 40 || Math.abs(width - w) < 2) return;
    w = width;
    box.replaceChildren(daySpark(values, { width, height: 48 })!);
  };
  draw(320);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver((e) => draw(Math.round(e[0].contentRect.width))).observe(box);
  return box;
}

const ICON: Record<HealthSentence["id"], () => SVGSVGElement> = {
  sleep: icons.bed,
  steps: dayIcons.steps,
  heart: icons.heart,
  weight: icons.target,
};

export function healthSection(health: DayHealth, before: (HealthFigures & { date?: string })[], opts: { hero?: boolean; date?: string } = {}): HTMLElement {
  const date = opts.date;
  const sentences = healthSentences(health, before);
  // One figure a day for the 14 days before (a gap where a day has none), then the day.
  const byDate = new Map(before.filter((d) => d.date).map((d) => [d.date!, d]));
  const dates = date ? Array.from({ length: 14 }, (_, i) => addDays(date, i - 14)) : null;
  const series = (f: (d: HealthFigures) => number | undefined) => [
    ...(dates ? dates.map((d) => byDate.get(d)) : before.slice(-14)).map((d) => (d ? (f(d) ?? null) : null)),
    f(health) ?? null,
  ];
  const field: Record<HealthSentence["id"], (d: HealthFigures) => number | undefined> = {
    sleep: (d) => d.sleep_minutes,
    steps: (d) => d.steps,
    heart: (d) => d.resting_hr,
    weight: (d) => d.weight_kg,
  };
  const rows = sentences.map((s) =>
    h(
      "li",
      { class: `day-health__row day-health__row--${s.id}` },
      h("span", { class: "day-health__icon", "aria-hidden": "true" }, ICON[s.id]()),
      h(
        "span",
        { class: "day-health__words" },
        h("span", { class: "day-health__text" }, s.text),
        s.aside ? h("span", { class: "day-health__aside" }, s.aside) : null
      ),
      opts.hero ? fitSpark(series(field[s.id])) : daySpark(series(field[s.id])),
      s.id === "sleep" && health.sleep_stages ? stagesRow(health.sleep_stages) : null
    )
  );
  const workouts = (health.workouts ?? []).map((w) => {
    const route = (w as { route?: string }).route;
    const sketch = route ? routeSketch(route, 40) : null;
    const meta = [w.start, hoursMinutes(w.minutes), w.distance_m && w.minutes ? pace(w.minutes, w.distance_m) : null].filter(Boolean).join(" · ");
    return h(
      "li",
      { class: "day-health__row day-health__row--workout" },
      h("span", { class: `day-health__icon${sketch ? " day-health__icon--route" : ""}`, "aria-hidden": "true" }, sketch ?? icons.flag()),
      h("span", { class: "day-health__words" }, h("span", { class: "day-health__text" }, w.name ? `${workoutPhrase(w)}: ${w.name}` : workoutPhrase(w)), h("span", { class: "day-health__aside" }, meta))
    );
  });
  return h(
    "section",
    { class: `day-sec day-health${opts.hero ? " day-health--hero" : ""}`, "aria-labelledby": "day-health-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-health-title" }, "Body"), h("span", { class: "day-sec__sub" }, before.length >= 4 ? "Compared with the two weeks before" : "")),
    h("ul", { class: "day-health__list", role: "list" }, ...rows, ...workouts)
  );
}

/** Under "Slept 7h 40m (1h 25m deep)": the night by stage as a slim bar, REM named beside it (deep is already in the sentence). */
function stagesRow(stages: NonNullable<DayHealth["sleep_stages"]>): HTMLElement | null {
  const bar = slimStageBar(stages);
  if (!bar) return null;
  const words = stages.deep ? (stages.rem ? `${hoursMinutes(stages.rem)} REM` : null) : stagesLine(stages);
  return h("span", { class: "day-health__stages" }, bar, words ? h("span", { class: "day-health__stage-words", "aria-hidden": "true" }, words) : null);
}

/** "5:02 /km". */
function pace(minutes: number, metres: number): string {
  const per = minutes / (metres / 1000);
  const m = Math.floor(per);
  const s = Math.round((per - m) * 60);
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

export { km };
