/**
 * House's Trends (views/house.ts): one component, two choices. Fuel
 * (Electricity, Gas) and view (This month, Last year, 12 months, and for gas
 * Weather), each kept per device. A view is a headline figure, one plain
 * line and one chart:
 *
 *  - This month: the forecast as a month bar (solid so far, faint to the
 *    month's end, ticks for last month and the same month last year), and
 *    this month against last as a pair of bars.
 *  - Last year: the same month last year and the year so far, as pairs of
 *    bars on one scale with change chips.
 *  - 12 months: kWh a day by month over the last 24, both windows shaded and
 *    each average dashed.
 *  - Weather: each day's gas against its average temperature, the fitted
 *    line, this month's days picked out, and the change as used and allowing
 *    for the weather.
 *
 * A view without the data for it says when it will show, in its place, so
 * the tabs never move. "Show figures" under the chart holds the view's
 * numbers as a table. Inline SVG and HTML bars at the card's real width,
 * tokens only, both themes; mark spec as charts.css and house-charts.ts.
 * Every chart has an aria-label in words.
 */
import { h } from "../lib/dom";
import { el, hiddenTable, sized } from "./house-charts";
import {
  changeArrow,
  changeWord,
  hdd,
  HDD_BASE,
  needWords,
  VIEW_KINDS,
  WEATHER_MISSING_WORDS,
  type Against,
  type EnergyTrends,
  type GasFit,
  type GasPoint,
  type Side,
  type TrendRow,
  type TrendView,
} from "../../../lib/house-trends";
import type { MonthPoint } from "../../../lib/house";
import { pence, type Fuel } from "../../../lib/tariff";

const monthLong = (m: string, year = false) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const monthShort = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const pounds = (p: number) => `£${Math.round(p / 100).toLocaleString("en-GB")}`;
const kwhTotal = (v: number) => `${Math.round(v).toLocaleString("en-GB")} kWh`;
const kwhDay = (v: number) => `${v.toFixed(1)} kWh`;
const fuelCls = (f: Fuel) => (f === "gas" ? "is-gas" : "is-electric");
const FUEL_NAME: Record<Fuel, string> = { electricity: "Electricity", gas: "Gas" };

/** "good" when less is used, "warn" when more, "same" under 3%. */
const tone = (change: number) => (Math.round(Math.abs(change) * 100) < 3 ? "same" : change < 0 ? "good" : "warn");

export function changeChip(change: number): HTMLElement {
  return h("span", { class: `tc-chip is-${tone(change)}` }, changeWord(change), h("span", { "aria-hidden": "true" }, ` ${changeArrow(change)}`));
}

/** A view's headline: a small line above, one large figure with its unit, and a chip when there's a change to show. */
function headline(o: { eyebrow: string; big: string; unit: string; chip?: number; words?: boolean }): HTMLElement {
  return h(
    "div",
    { class: "tc-headline" },
    h("p", { class: "tc-headline__eyebrow" }, o.eyebrow),
    h("p", { class: "tc-headline__row" }, h("span", { class: `tc-headline__big${o.words ? " is-words" : ""}` }, o.big), h("span", { class: "tc-headline__unit" }, o.unit), o.chip !== undefined ? changeChip(o.chip) : null)
  );
}

// ---------- The forecast ----------

/** The month as a bar: solid for what's been used, faint for the rest of the forecast, a tick at last month's total and the same month last year's. */
export function forecastBar(r: TrendRow, priced: boolean): HTMLElement {
  const month = r.this.from.slice(0, 7);
  const so = r.so_far!;
  const v = (s: { kwh: number; cost_p?: number }) => (priced ? s.cost_p! : s.kwh);
  const fmt = (n: number) => (priced ? pounds(n) : kwhTotal(n));
  const marks = r.against.map((a) => ({ name: a.other.from.slice(0, 4) === month.slice(0, 4) ? monthShort(a.other.from.slice(0, 7)) : `${monthShort(a.other.from.slice(0, 7))} ${a.other.from.slice(0, 4)}`, value: v(a.other) }));
  const total = v(r.this);
  const now = v(so);
  const max = Math.max(total, ...marks.map((m) => m.value)) * 1.05 || 1;
  const days = Number(r.this.to.slice(8, 10));
  const label = `${monthLong(month)}: ${fmt(now)} so far after ${so.days} days, ${fmt(total)} forecast for the month. ${marks.map((m) => `${m.name}: ${fmt(m.value)}`).join(". ")}.`;
  const bar = h("div", { class: "tc-progress", role: "img", "aria-label": label });
  sized(bar, (W) => {
    const top = 6;
    const bh = 16;
    const x = (n: number) => Math.round((n / max) * W);
    // Ticks below the bar; a label too close to the one before drops to a second line.
    const sorted = [...marks].sort((a, b) => a.value - b.value);
    const rows: number[] = [];
    const xs: number[] = [];
    sorted.forEach((m, i) => {
      const mx = Math.min(W - 1, Math.max(1, x(m.value)));
      xs.push(mx);
      rows.push(i > 0 && rows[i - 1] === 0 && Math.abs(xs[i - 1] - mx) < 104 ? 1 : 0);
    });
    const H = top + bh + 20 + Math.max(0, ...rows) * 15;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    svg.append(el("rect", { class: "tc-progress__track", x: 0, y: top, width: W, height: bh, rx: bh / 2 }));
    svg.append(el("rect", { class: `tc-progress__rest ${fuelCls(r.fuel)}`, x: 0, y: top, width: Math.max(bh, x(total)), height: bh, rx: bh / 2 }));
    svg.append(el("rect", { class: `tc-progress__now ${fuelCls(r.fuel)}`, x: 0, y: top, width: Math.max(bh, x(now)), height: bh, rx: bh / 2 }));
    sorted.forEach((m, i) => {
      const mx = xs[i];
      svg.append(el("line", { class: "tc-progress__tick", x1: mx, x2: mx, y1: top - 4, y2: top + bh + 4 + rows[i] * 15 }));
      const t = el("text", { class: "tc-progress__label", x: mx, y: top + bh + 16 + rows[i] * 15, "text-anchor": mx < 56 ? "start" : mx > W - 56 ? "end" : "middle" });
      t.textContent = `${m.name} ${fmt(m.value)}`;
      svg.append(t);
    });
    bar.replaceChildren(svg);
  });
  return h(
    "div",
    { class: "tc-forecast" },
    bar,
    h(
      "p",
      { class: "tc-legend" },
      h("span", { class: "tc-legend__item" }, h("i", { class: `tc-key ${fuelCls(r.fuel)}`, "aria-hidden": "true" }), `${fmt(now)} so far, ${so.days} of ${days} days`),
      h("span", { class: "tc-legend__item" }, h("i", { class: `tc-key tc-key--rest ${fuelCls(r.fuel)}`, "aria-hidden": "true" }), "Forecast to the month's end")
    )
  );
}

// ---------- Paired bars ----------

const TITLES: Partial<Record<TrendRow["kind"], string>> = { month: "Month on month", year: "Same month last year", rolling: "Rolling 12 months", ytd: "Year to date" };

/** Now and before for each comparison, every bar on the same scale (kWh a day), with the change as a chip. */
/** `bare`: rows the view's headline already speaks for, drawn without their chip and sub-label. */
export function comparisonBars(rows: TrendRow[], bare: TrendRow[] = []): HTMLElement | null {
  const list = rows.filter((r) => r.kind !== "forecast");
  if (!list.length) return null;
  const max = Math.max(...list.flatMap((r) => [r.this.per_day, r.against[0].other.per_day])) || 1;
  // The longest bar leaves room for its figure at the end.
  const pct = (v: number) => `${Math.max(1, (v / max) * 76).toFixed(1)}%`;
  const bar = (s: Side, which: "now" | "before", r: TrendRow) =>
    h(
      "div",
      { class: `tc-bar is-${which}` },
      h("span", { class: "tc-bar__who" }, which === "now" ? "Now" : "Before"),
      h("span", { class: "tc-bar__track" }, h("span", { class: `tc-bar__fill ${fuelCls(r.fuel)}`, style: `width:${pct(s.per_day)}` }), h("span", { class: "tc-bar__val", style: `left:calc(${pct(s.per_day)} + 6px)` }, kwhDay(s.per_day)))
    );
  return h(
    "div",
    { class: "tc-cmps" },
    ...list.map((r) => {
      const a = r.against[0];
      const words = `${TITLES[r.kind]}: ${r.this.name}, ${kwhDay(r.this.per_day)} a day, against ${a.other.name}, ${kwhDay(a.other.per_day)} a day. ${changeWord(a.change)}${a.cost_change !== undefined ? `; ${changeWord(a.cost_change).toLowerCase()} in pounds` : ""}.`;
      return h(
        "div",
        { class: "tc-cmp", role: "img", "aria-label": words },
        h("div", { class: "tc-cmp__head", "aria-hidden": "true" }, h("span", { class: "tc-cmp__name" }, TITLES[r.kind]!), bare.includes(r) ? null : changeChip(a.change)),
        bare.includes(r) ? null : h("p", { class: "tc-cmp__sub", "aria-hidden": "true" }, `${r.this.name} against ${a.other.name}`),
        h("div", { class: "tc-cmp__bars", "aria-hidden": "true" }, bar(r.this, "now", r), bar(a.other, "before", r)),
        a.cost_change !== undefined ? h("p", { class: "tc-cmp__cost", "aria-hidden": "true" }, `In £: ${changeWord(a.cost_change).toLowerCase()}`) : null
      );
    })
  );
}

// ---------- 12 months ----------

/** kWh a day by month over the two windows, each shaded, with its average as a dashed line. */
export function rollingChart(months: MonthPoint[], r: TrendRow): HTMLElement {
  const fuel = r.fuel;
  const a = r.against[0];
  const from = a.other.from.slice(0, 7);
  const to = r.this.to.slice(0, 7);
  const pts = months.filter((m) => m.month >= from && m.month <= to).map((m) => ({ month: m.month, v: m[fuel]?.per_day ?? null }));
  const label = `${FUEL_NAME[fuel]} in kWh a day by month, ${monthLong(from, true)} to ${monthLong(to, true)}. The last 12 months averaged ${kwhDay(r.this.per_day)} a day, the 12 before ${kwhDay(a.other.per_day)}: ${changeWord(a.change).toLowerCase()}.`;
  const root = h("div", { class: "hc tc-roll", role: "img", "aria-label": label });
  const split = r.this.from.slice(0, 7);
  sized(root, (W) => {
    const H = W < 560 ? 216 : 248;
    const pad = { top: 44, bottom: 34 };
    const base = H - pad.bottom;
    const vals = pts.map((p) => p.v).filter((v): v is number => v !== null);
    // Not from zero: the months move a little against their average, and a zero base would flatten that.
    const hi = Math.max(...vals, r.this.per_day, a.other.per_day);
    const lo = Math.min(...vals, r.this.per_day, a.other.per_day);
    const span = Math.max(hi - lo, hi * 0.2) || 1;
    const min = Math.max(0, lo - span * 0.35);
    const max = hi + span * 0.3;
    const n = pts.length;
    const step = W / Math.max(1, n);
    const x = (i: number) => step * i + step / 2;
    const y = (v: number) => base - ((v - min) / (max - min)) * (base - pad.top);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    const cut = pts.findIndex((p) => p.month >= split);
    const windows = [
      { from: 0, to: cut < 0 ? n : cut, avg: a.other.per_day, name: "12 before", cls: "is-before" },
      { from: cut < 0 ? n : cut, to: n, avg: r.this.per_day, name: "Last 12", cls: "is-now" },
    ];
    for (const w of windows) {
      if (w.to <= w.from) continue;
      svg.append(el("rect", { class: `tc-roll__window ${w.cls} ${fuelCls(fuel)}`, x: step * w.from, y: 0, width: step * (w.to - w.from), height: base }));
      // Each window says what it is and its average, at its top, clear of the line.
      const t = el("text", { class: "tc-roll__window-text tc-halo", x: step * w.from + 8, y: 15 });
      t.textContent = w.name === "Last 12" ? "Last 12 months" : "The 12 before";
      const avg = el("text", { class: "tc-roll__window-text tc-roll__window-avg tc-halo", x: step * w.from + 8, y: 30 });
      avg.textContent = `${kwhDay(w.avg)} a day`;
      svg.append(t, avg);
    }
    svg.append(el("line", { class: "hc__grid", x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
    // Two or three light gridlines at round kWh a day; their labels go on after the line, so their halo sits over it.
    const stepK = [0.5, 1, 2, 2.5, 5, 10, 20].find((s) => (max - min) / s <= 3.5) ?? 50;
    const gridLabels: SVGTextElement[] = [];
    for (let k = Math.ceil(min / stepK) * stepK; k <= max; k += stepK) {
      const gy = y(k);
      if (gy < pad.top - 2 || gy > base - 8) continue;
      svg.append(el("line", { class: "tc-roll__grid", x1: 0, x2: W, y1: gy, y2: gy }));
      const gt = el("text", { class: "hc__tick tc-roll__grid-text", x: 6, y: gy - 4 });
      gt.textContent = `${Number.isInteger(k) ? k : k.toFixed(1)} kWh`;
      gridLabels.push(gt);
    }
    // Each window's average as a dashed line (its figure is in the window's caption).
    windows.forEach((w) => {
      if (w.to > w.from) svg.append(el("line", { class: "tc-roll__avg", x1: step * w.from + 2, x2: step * w.to - 2, y1: y(w.avg), y2: y(w.avg) }));
    });
    let d = "";
    pts.forEach((p, i) => {
      if (p.v === null) return;
      d += `${d && pts[i - 1]?.v !== null ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
    });
    svg.append(el("path", { class: `hc__line ${fuelCls(fuel)}`, d }));
    svg.append(...gridLabels);
    const last = [...pts].reverse().findIndex((p) => p.v !== null);
    if (last >= 0) svg.append(el("circle", { class: `hc__dot ${fuelCls(fuel)}`, cx: x(n - 1 - last), cy: y(pts[n - 1 - last].v!), r: 4 }));
    // A tick every three months (Feb, May, Aug, Nov), and each year under its first quarter's tick.
    pts.forEach((p, i) => {
      const mm = Number(p.month.slice(5, 7));
      if (mm % 3 !== 2) return;
      svg.append(el("line", { class: "tc-roll__tick", x1: x(i), x2: x(i), y1: base, y2: base + 4 }));
      const t = el("text", { class: "hc__tick", x: x(i), y: base + 15, "text-anchor": "middle" });
      t.textContent = monthShort(p.month);
      svg.append(t);
      if (mm === 2 || i < 3) {
        const yt = el("text", { class: "hc__tick tc-roll__year", x: x(i), y: base + 28, "text-anchor": "middle" });
        yt.textContent = p.month.slice(0, 4);
        svg.append(yt);
      }
    });
    root.replaceChildren(svg, hiddenTable(label, ["Month", "kWh a day"], pts.map((p) => [monthLong(p.month, true), p.v === null ? "No readings" : kwhDay(p.v)])));
  });
  return root;
}

// ---------- Weather ----------

/** Each day's gas against its mean temperature, this month's days picked out, with the fitted line (a baseload, rising below 15.5°). */
export function weatherScatter(points: GasPoint[], fit: GasFit, month: string): HTMLElement {
  const label = `Each day's gas in kWh against the day's average temperature, ${points.length} days. The line is your usual: about ${fit.baseload.toFixed(0)} kWh a day with no heating, and ${fit.per_hdd.toFixed(1)} kWh more for each degree below ${HDD_BASE}°. ${monthLong(month)}'s days are picked out.`;
  const root = h("div", { class: "hc tc-scatter", role: "img", "aria-label": label });
  sized(root, (W) => {
    const H = Math.round(Math.min(240, Math.max(188, W * 0.52)));
    const pad = { left: 30, right: 8, top: 20, bottom: 32 };
    const ts = points.map((p) => p[1]);
    const ks = points.map((p) => p[2]);
    const tMin = Math.floor(Math.min(...ts, 0) / 5) * 5;
    const tMax = Math.ceil(Math.max(...ts, HDD_BASE + 2) / 5) * 5;
    const kMax = Math.ceil((Math.max(...ks, fit.baseload + fit.per_hdd * hdd(tMin)) * 1.05) / 10) * 10 || 10;
    const x = (t: number) => pad.left + ((t - tMin) / (tMax - tMin)) * (W - pad.left - pad.right);
    const y = (k: number) => H - pad.bottom - (k / kMax) * (H - pad.top - pad.bottom);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    svg.append(el("line", { class: "hc__grid", x1: pad.left, x2: W - pad.right, y1: H - pad.bottom + 0.5, y2: H - pad.bottom + 0.5 }));
    for (const k of [kMax / 2, kMax]) svg.append(el("line", { class: "tc-scatter__grid", x1: pad.left, x2: W - pad.right, y1: y(k), y2: y(k) }));
    for (let t = tMin; t <= tMax; t += 5) {
      const tx = el("text", { class: "hc__tick", x: x(t), y: H - pad.bottom + 15, "text-anchor": "middle" });
      tx.textContent = `${t}°`;
      svg.append(tx);
    }
    // No "0" on the y axis: it would sit on the x axis's first temperature.
    for (const k of [kMax / 2, kMax]) {
      const ty = el("text", { class: "hc__tick", x: pad.left - 6, y: y(k) + 4, "text-anchor": "end" });
      ty.textContent = String(Math.round(k));
      svg.append(ty);
    }
    const cap = el("text", { class: "hc__tick", x: W - pad.right, y: H - 2, "text-anchor": "end" });
    cap.textContent = "The day's average temperature";
    svg.append(cap);
    const capY = el("text", { class: "hc__tick", x: pad.left, y: 10 });
    capY.textContent = "kWh of gas a day";
    svg.append(capY);
    // Older days first and faint; this month's on top.
    for (const p of points.filter((q) => !q[0].startsWith(month))) svg.append(el("circle", { class: "tc-scatter__dot", cx: x(p[1]).toFixed(1), cy: y(p[2]).toFixed(1), r: 2.5 }));
    const line = `M${x(tMin).toFixed(1)},${y(fit.baseload + fit.per_hdd * hdd(tMin)).toFixed(1)} L${x(HDD_BASE).toFixed(1)},${y(fit.baseload).toFixed(1)} L${x(tMax).toFixed(1)},${y(fit.baseload).toFixed(1)}`;
    svg.append(el("path", { class: "tc-scatter__fit", d: line }));
    for (const p of points.filter((q) => q[0].startsWith(month))) svg.append(el("circle", { class: "tc-scatter__dot is-now", cx: x(p[1]).toFixed(1), cy: y(p[2]).toFixed(1), r: 4 }));
    root.replaceChildren(svg);
  });
  return root;
}

/** The scatter with the change as used and allowing for the weather beside it (below it on a phone). */
function weatherPanel(points: GasPoint[], fit: GasFit, month: string, a: Against | undefined): HTMLElement {
  const w = a?.weather;
  return h(
    "div",
    { class: "tc-weather" },
    weatherScatter(points, fit, month),
    h(
      "div",
      { class: "tc-weather__side" },
      w ? h("p", { class: "tc-weather__label" }, `${monthLong(month)} so far against ${a!.other.name}`) : null,
      w ? h("p", { class: "tc-weather__row" }, h("span", {}, "As used"), changeChip(w.change)) : null,
      w ? h("p", { class: "tc-weather__row" }, h("span", {}, "Average temperature"), h("span", { class: "tc-weather__temp" }, `${w.temp.toFixed(0)}° against ${w.other_temp.toFixed(0)}°`)) : null,
      h(
        "p",
        { class: "tc-legend", "aria-hidden": "true" },
        h("span", { class: "tc-legend__item" }, h("i", { class: "tc-key tc-key--dot is-now" }), monthLong(month)),
        h("span", { class: "tc-legend__item" }, h("i", { class: "tc-key tc-key--dot" }), "The past year"),
        h("span", { class: "tc-legend__item" }, h("i", { class: "tc-key tc-key--line" }), "Your usual")
      ),
      h("p", { class: "house-card__aside" }, `Your usual is about ${fit.baseload.toFixed(0)} kWh a day for hot water and cooking, and ${fit.per_hdd.toFixed(1)} kWh more for each degree the day's average is below ${HDD_BASE}°, from ${fit.days} days of your readings.`)
    )
  );
}

// ---------- The figures (Show figures) ----------

function sideCell(s: Side, total: boolean, priced: boolean, cls: string, month?: string): HTMLElement {
  const money = !priced || s.cost_p === undefined ? null : total ? pounds(s.cost_p) : pence(s.cost_per_day_p!);
  return h("span", { class: `house-trend__val ${cls}` }, h("span", { class: "house-trend__kwh" }, total ? kwhTotal(s.kwh) : kwhDay(s.per_day)), money ? h("span", { class: "house-trend__sub" }, money) : null, month ? h("span", { class: "house-trend__sub" }, `in ${month}`) : null);
}

function changeCell(a: Against): HTMLElement {
  return h(
    "span",
    { class: "house-trend__change" },
    h("span", { class: "house-trend__word" }, changeWord(a.change), h("span", { class: "house-trend__arrow", "aria-hidden": "true" }, ` ${changeArrow(a.change)}`)),
    a.cost_change !== undefined ? h("span", { class: "house-trend__sub" }, `${changeWord(a.cost_change).replace("About the same", "Same")} in £`) : null
  );
}

/** "Nov", or "Nov 2025" for another year than `of`'s: short, so a forecast figure's month fits a phone's column. */
const monthTag = (s: Side, of: Side) => `${monthShort(s.from.slice(0, 7))}${s.from.slice(0, 4) !== of.from.slice(0, 4) ? ` ${s.from.slice(0, 4)}` : ""}`;

function figureRow(r: TrendRow, weather: boolean): HTMLElement {
  const total = r.kind === "forecast";
  // £ only when both sides are priced: never a priced figure against an unpriced one.
  const pricedWith = (a: Against) => r.this.cost_p !== undefined && a.other.cost_p !== undefined;
  const a0 = r.against[0];
  const label = r.kind === "forecast" ? `${monthLong(r.this.from.slice(0, 7))} forecast` : TITLES[r.kind]!;
  const sub = r.kind === "month" || r.kind === "year" || r.kind === "ytd" ? `${r.this.name} against ${a0.other.name}` : r.kind === "forecast" ? "The whole month, at this month's rate" : null;
  return h(
    "li",
    { class: `house-trend is-${r.kind}` },
    h("span", { class: "house-trend__label" }, h("span", { class: "house-trend__name" }, label), sub ? h("span", { class: "house-trend__sub" }, sub) : null),
    sideCell(r.this, total, r.against.every(pricedWith), "is-this", total ? monthTag(r.this, r.this) : undefined),
    h(
      "span",
      { class: "house-trend__vs" },
      ...r.against.flatMap((a) => [sideCell(a.other, total, pricedWith(a), "is-other", total ? monthTag(a.other, r.this) : undefined), changeCell(a)]),
      weather && a0.weather ? h("span", { class: "house-trend__adj" }, `Allowing for the weather: ${changeWord(a0.weather.adjusted).toLowerCase()}`, h("span", { class: "house-trend__arrow", "aria-hidden": "true" }, ` ${changeArrow(a0.weather.adjusted)}`)) : null
    )
  );
}

function figures(rows: TrendRow[], fuel: Fuel, weather: boolean): HTMLElement {
  return h(
    "details",
    { class: "tc-figures" },
    h("summary", {}, "Show figures"),
    h(
      "div",
      { class: "house-trends__fuel" },
      h("div", { class: "house-trends__head", "aria-hidden": "true" }, h("span", {}), h("span", {}, "Now, a day"), h("span", {}, "Before, a day"), h("span", {}, "Change")),
      h("ul", { class: "house-trends", role: "list", "aria-label": `${FUEL_NAME[fuel]}: kWh a day, the forecast in kWh for the month` }, ...rows.map((r) => figureRow(r, weather)))
    )
  );
}

// ---------- One view ----------

/** In the view's place when the readings can't support it yet. */
const empty = (title: string, text: string) => h("div", { class: "tc-empty" }, h("p", { class: "tc-empty__title" }, title), h("p", { class: "tc-empty__text" }, text));

function viewBody(t: EnergyTrends, months: MonthPoint[], fuel: Fuel, view: TrendView): HTMLElement[] {
  const rows = t.rows.filter((r) => r.fuel === fuel && VIEW_KINDS[view].includes(r.kind));
  const line = (text: string) => (text ? h("p", { class: "tc-take" }, text) : null);
  const need = (kind: "year" | "ytd" | "rolling") => t.needs.find((n) => n.fuel === fuel && n.kind === kind);
  const out = (...xs: Array<HTMLElement | null>) => xs.filter((x): x is HTMLElement => !!x);

  if (view === "month") {
    const forecast = rows.find((r) => r.kind === "forecast" && r.so_far);
    const month = rows.find((r) => r.kind === "month");
    if (!forecast && !month) return out(empty("Not enough of this month yet", "This month shows once it has a few days of readings."));
    if (!forecast) {
      // Early in the month: the month so far is the headline, so its bars go without the chip.
      const a = month!.against[0];
      return out(headline({ eyebrow: `${month!.this.name}, against ${a.other.name}`, big: kwhDay(month!.this.per_day), unit: "a day", chip: a.change }), line(costLine(month!.this, a.other)), h("div", { class: "tc-chart" }, comparisonBars([month!], [month!])), figures(rows, fuel, false));
    }
    const priced = forecast.this.cost_p !== undefined && forecast.so_far!.cost_p !== undefined && forecast.against.every((a) => a.other.cost_p !== undefined);
    // The bars say how it compares with last month; the line, how the month compares with the same month last year.
    const lastYear = forecast.against.find((a) => a.other.from.slice(0, 4) !== forecast.this.from.slice(0, 4));
    const vsLastYear = lastYear ? (tone(lastYear.change) === "same" ? `About the same ${fuel} a day as ${lastYear.other.name}.` : `${changeWord(lastYear.change)} ${fuel} a day than ${lastYear.other.name}.`) : "";
    return out(
      headline({ eyebrow: `On course for, by ${Number(forecast.this.to.slice(8, 10))} ${monthShort(forecast.this.from.slice(0, 7))}`, big: priced ? pounds(forecast.this.cost_p!) : kwhTotal(forecast.this.kwh), unit: `in ${monthLong(forecast.this.from.slice(0, 7))}` }),
      line(vsLastYear),
      h("div", { class: "tc-chart" }, forecastBar(forecast, priced), comparisonBars(month ? [month] : [])),
      figures(rows, fuel, false)
    );
  }

  if (view === "year") {
    const main = rows.find((r) => r.kind === "year") ?? rows.find((r) => r.kind === "ytd");
    const n = need("year") ?? need("ytd");
    if (!main) return out(empty("Not a year of readings yet", n ? needWords(n) : "This shows once there's a year of readings."));
    const ytdNeed = !rows.some((r) => r.kind === "ytd") ? need("ytd") : undefined;
    const a = main.against[0];
    // Gas: what the weather did. Otherwise the cost, which the chip doesn't say.
    const said = a.weather ? tempLine(a.weather.temp, a.weather.other_temp, a.other.name) : costLine(main.this, a.other);
    return out(
      headline({ eyebrow: `${main.this.name}, against ${a.other.name}`, big: kwhDay(main.this.per_day), unit: "a day", chip: a.change }),
      line(said),
      h("div", { class: "tc-chart" }, comparisonBars(rows, [main])),
      ytdNeed ? h("p", { class: "house-card__aside" }, needWords(ytdNeed)) : null,
      figures(rows, fuel, false)
    );
  }

  if (view === "rolling") {
    const r = rows[0];
    const n = need("rolling");
    if (!r) return out(empty("Not two years of readings yet", n ? needWords(n) : "This shows once there are two years of readings."));
    // The captions carry both averages; the line says what they cost, or the year's highest month.
    const a = r.against[0];
    const costs = r.this.cost_per_day_p !== undefined && a.other.cost_per_day_p !== undefined ? `${pence(r.this.cost_per_day_p)} a day, against ${pence(a.other.cost_per_day_p)} the 12 before, with standing charges.` : "";
    const inWindow = months.filter((m) => m.month >= r.this.from.slice(0, 7) && m.month <= r.this.to.slice(0, 7) && m[fuel]);
    const top = [...inWindow].sort((x, y) => y[fuel]!.per_day - x[fuel]!.per_day)[0];
    const peak = top ? `The highest month was ${monthLong(top.month, true)}, at ${kwhDay(top[fuel]!.per_day)} a day.` : "";
    return out(headline({ eyebrow: "The last 12 months, against the 12 before", big: kwhDay(r.this.per_day), unit: "a day", chip: a.change }), line(costs || peak), h("div", { class: "tc-chart" }, rollingChart(months, r)), figures(rows, fuel, false));
  }

  // Weather: gas only. The headline is the change allowing for the weather; beside the scatter, the change as used and the temperatures.
  const g = t.gas_weather;
  if (!g || "missing" in g) return out(empty("Gas and the weather", WEATHER_MISSING_WORDS[g && "missing" in g ? g.missing : "unavailable"]));
  const m = rows.find((r) => r.kind === "month")?.against[0];
  const w = m?.weather;
  return out(
    w ? headline({ eyebrow: `Allowing for the weather, against ${m!.other.name}`, big: changeWord(w.adjusted), unit: "gas a day", words: true }) : headline({ eyebrow: "Gas and the weather", big: `${g.fit.per_hdd.toFixed(1)} kWh`, unit: "more for each colder degree" }),
    h("div", { class: "tc-chart" }, weatherPanel(g.points, g.fit, t.as_of.slice(0, 7), m)),
    rows.some((r) => r.against[0].weather) ? figures(rows.filter((r) => r.against[0].weather), fuel, true) : null
  );
}

/** What a day cost against then, when both are priced: "49p a day more than November 2025, with standing charges." */
function costLine(a: Side, b: Side): string {
  if (a.cost_per_day_p === undefined || b.cost_per_day_p === undefined) return "";
  const d = a.cost_per_day_p - b.cost_per_day_p;
  return Math.abs(d) < 2 ? `Much the same cost a day as ${b.name}.` : `${pence(Math.abs(d))} a day ${d > 0 ? "more" : "less"} than ${b.name}, with standing charges.`;
}

/** "It was 1° colder on average than November 2025." */
function tempLine(now: number, then: number, name: string): string {
  const colder = Math.round(then - now);
  return colder ? `It was ${Math.abs(colder)}° ${colder > 0 ? "colder" : "warmer"} on average than ${name}.` : `The weather was much the same as ${name}.`;
}

// ---------- The card ----------

const FUEL_KEY = "athena.house.trendsFuel";
const VIEW_KEY = "athena.house.trendsView";
const VIEW_NAME: Record<TrendView, string> = { month: "This month", year: "Last year", rolling: "12 months", weather: "Weather" };
let seq = 0;

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const keep = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Private mode: kept until the page reloads.
  }
};

/** The Trends card: fuel and view, each remembered on this device, and the view's panel. */
export function trendsCard(t: EnergyTrends, fuels: Fuel[], months: MonthPoint[]): HTMLElement {
  const id = `tc-${++seq}`;
  const have = fuels.filter((f) => t.rows.some((r) => r.fuel === f));
  let fuel: Fuel = have.includes(read(FUEL_KEY) as Fuel) ? (read(FUEL_KEY) as Fuel) : have[0];
  let view: TrendView = (["month", "year", "rolling", "weather"] as const).includes(read(VIEW_KEY) as TrendView) ? (read(VIEW_KEY) as TrendView) : "month";
  const viewsFor = (f: Fuel): TrendView[] => (f === "gas" ? ["month", "year", "rolling", "weather"] : ["month", "year", "rolling"]);

  const panel = h("div", { class: "tc-panel", role: "tabpanel", id: `${id}-panel`, tabindex: "0" });
  const tablist = h("div", { class: "segmented segmented--sub tc-views", role: "tablist", "aria-label": "Trends view" });
  const fuelButtons = have.map((f) => {
    const b = h("button", { class: "seg__item", type: "button", role: "radio", "aria-checked": String(f === fuel) }, h("i", { class: `tc-key ${fuelCls(f)}`, "aria-hidden": "true" }), FUEL_NAME[f]);
    b.addEventListener("click", () => {
      fuel = f;
      keep(FUEL_KEY, f);
      paint(true);
    });
    return b;
  });
  const fuelSeg = have.length > 1 ? h("div", { class: "seg tc-fuels", role: "radiogroup", "aria-label": "Fuel" }, ...fuelButtons) : null;

  const tabs = new Map<TrendView, HTMLButtonElement>();
  const choose = (v: TrendView, focus = false) => {
    view = v;
    keep(VIEW_KEY, v);
    paint(true);
    if (focus) tabs.get(v)?.focus();
  };
  /** What's shown: the chosen view, or This month while electricity has no Weather. */
  const shown = () => (viewsFor(fuel).includes(view) ? view : "month");
  const paintTabs = () => {
    const views = viewsFor(fuel);
    const on = shown();
    tabs.clear();
    tablist.replaceChildren(
      ...views.map((v) => {
        const b = h("button", { class: "segmented__item", type: "button", role: "tab", id: `${id}-${v}`, "aria-controls": `${id}-panel`, "aria-selected": String(v === on), tabindex: v === on ? "0" : "-1" }, VIEW_NAME[v]) as HTMLButtonElement;
        b.addEventListener("click", () => choose(v));
        b.addEventListener("keydown", (ev) => {
          const i = views.indexOf(v);
          const to = ev.key === "ArrowRight" ? views[(i + 1) % views.length] : ev.key === "ArrowLeft" ? views[(i + views.length - 1) % views.length] : ev.key === "Home" ? views[0] : ev.key === "End" ? views[views.length - 1] : null;
          if (!to) return;
          ev.preventDefault();
          choose(to, true);
        });
        tabs.set(v, b);
        return b;
      })
    );
  };
  const paint = (animate = false) => {
    // Weather is gas only: electricity shows this month, and the choice is kept for gas.
    const v = shown();
    fuelButtons.forEach((b, i) => b.setAttribute("aria-checked", String(have[i] === fuel)));
    paintTabs();
    panel.setAttribute("aria-labelledby", `${id}-${v}`);
    panel.replaceChildren(...viewBody(t, months, fuel, v));
    if (animate) {
      panel.classList.remove("is-entering");
      void panel.offsetWidth;
      panel.classList.add("is-entering");
    }
  };
  paint();
  return h("section", { class: "house-card tc-card" }, h("div", { class: "tc-card__top" }, h("h3", { class: "house-card__title" }, "Trends"), fuelSeg), tablist, panel);
}
