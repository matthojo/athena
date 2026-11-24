/**
 * House's charts, drawn as inline SVG at the container's real width (no
 * library). Mark spec per the dataviz skill and charts.css: columns with a
 * 4px rounded data end on a square base and a 2px surface gap between them,
 * one hairline baseline, a 2px line for "a usual day", 8px markers ringed
 * in the surface. Electricity is series 1 (cobalt), gas series 2 (mint).
 * The heatmap is one hue, light to dark.
 *
 * Pointer, touch and arrow keys drive the same tooltip; a visually hidden
 * table carries every value. Gas and electricity never share a y-axis: the
 * monthly trend is two small charts, one per fuel.
 */

import "../styles/charts.css";
import { clockOfDay } from "../lib/clock";

const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function hiddenTable(caption: string, head: string[], rows: string[][]): HTMLElement {
  const box = document.createElement("div");
  box.className = "visually-hidden";
  const table = document.createElement("table");
  const cap = document.createElement("caption");
  cap.textContent = caption;
  table.append(cap);
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const t of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = t;
    tr.append(th);
  }
  thead.append(tr);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const row = document.createElement("tr");
    r.forEach((v, i) => {
      const c = document.createElement(i ? "td" : "th");
      if (!i) (c as HTMLTableCellElement).scope = "row";
      c.textContent = v;
      row.append(c);
    });
    tbody.append(row);
  }
  table.append(thead, tbody);
  box.append(table);
  return box;
}

/** Draw now at a guess, then again at the real width whenever it changes. */
export function sized(root: HTMLElement, build: (w: number) => void) {
  let current = 0;
  build(root.clientWidth || 320);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && Math.abs(w - current) > 1) {
        current = w;
        build(w);
      }
    }).observe(root);
  }
}

const roundTop = (left: number, top: number, bw: number, base: number, r: number) => {
  const rr = Math.min(r, base - top, bw / 2);
  return `M${left},${base} V${top + rr} Q${left},${top} ${left + rr},${top} H${left + bw - rr} Q${left + bw},${top} ${left + bw},${top + rr} V${base} Z`;
};

// ---------- Bars ----------

export interface BarSeries {
  name: string;
  /** "is-electric" or "is-gas": the colour. */
  cls: string;
}

export interface BarPoint {
  /** For the tooltip and the table: "Fri 6 Nov", "18:30". */
  label: string;
  tick?: string;
  /** One per series; null for none. */
  values: Array<number | null>;
  /** A dimmer bar (a half hour still to come). */
  faint?: boolean;
}

export interface BarOptions {
  label: string;
  series: BarSeries[];
  points: BarPoint[];
  format: (v: number, series: number) => string;
  /** A faint 2px line across the bars ("a usual day"), on series 0's scale. */
  line?: { name: string; values: number[] };
  /** A hairline marking one point ("now"). */
  marker?: { index: number; text: string };
  /** Points shaded behind the bars (the cheap hours). */
  bands?: { name: string; on: boolean[] };
  /** Extra tooltip line per point. */
  note?: (i: number) => string;
  height?: number;
  /** Tapping a point picks it (the daily chart's day detail). */
  onPick?: (i: number) => void;
  selected?: number;
}

export function barChart(o: BarOptions): HTMLElement {
  const H = o.height ?? 148;
  const root = document.createElement("div");
  root.className = "hc viz-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${o.label}. Use the arrow keys to read each value${o.onPick ? ", Enter to open a day" : ""}.`);
  const head = ["", ...o.series.map((s) => s.name), ...(o.line ? [o.line.name] : [])];
  const rows = o.points.map((p, i) => [p.label, ...p.values.map((v, j) => (v === null ? "–" : o.format(v, j))), ...(o.line ? [o.format(o.line.values[i] ?? 0, 0)] : [])]);
  const table = hiddenTable(o.label, head, rows);
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  const tip = document.createElement("div");
  tip.className = "hc__tip";
  let index = o.selected ?? o.points.length - 1;
  let showAt: (i: number) => void = () => undefined;
  const hide = () => root.classList.remove("is-hovering");

  const build = (W: number) => {
    const pad = { top: 16, bottom: 22 };
    const base = H - pad.bottom;
    const innerH = base - pad.top;
    const n = o.points.length;
    const max = Math.max(1e-9, ...o.points.flatMap((p) => p.values.filter((v): v is number => v !== null)), ...(o.line?.values ?? [])) * 1.08;
    const y = (v: number) => pad.top + innerH - (v / max) * innerH;
    const slot = W / n;
    const x = (i: number) => slot * i + slot / 2;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    if (o.bands) {
      o.bands.on.forEach((on, i) => on && svg.append(el("rect", { class: "hc__band", x: slot * i, y: pad.top - 4, width: slot + 0.5, height: base - pad.top + 4 })));
    }
    svg.append(el("line", { class: "hc__grid", x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
    const k = o.series.length;
    const gap = 2;
    const groupW = Math.max(2, Math.min(slot - gap, k * 14));
    const bw = Math.max(1.5, (groupW - (k - 1) * gap) / k);
    const groups: SVGGElement[] = [];
    o.points.forEach((p, i) => {
      const g = el("g", { class: `hc__group${p.faint ? " is-faint" : ""}${o.selected === i ? " is-selected" : ""}` });
      p.values.forEach((v, j) => {
        if (v === null || v <= 0) return;
        const left = x(i) - groupW / 2 + j * (bw + gap);
        const top = Math.min(y(v), base - 1);
        g.append(el("path", { class: `hc__bar ${o.series[j].cls}`, d: roundTop(left, top, bw, base, 4) }));
      });
      groups.push(g);
      svg.append(g);
    });
    if (o.line) {
      const d = o.line.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      svg.append(el("path", { class: "hc__usual", d }));
    }
    if (o.marker && o.marker.index >= 0 && o.marker.index < n) {
      const mx = Math.round(x(o.marker.index)) + 0.5;
      svg.append(el("line", { class: "hc__marker", x1: mx, x2: mx, y1: pad.top - 6, y2: base }));
      const t = el("text", { class: "hc__marker-text", x: mx, y: pad.top - 8, "text-anchor": mx < 30 ? "start" : mx > W - 30 ? "end" : "middle" });
      t.textContent = o.marker.text;
      svg.append(t);
    }
    let lastTick = -Infinity;
    o.points.forEach((p, i) => {
      if (!p.tick) return;
      const tx = x(i);
      if (tx - lastTick < 40) return;
      lastTick = tx;
      const t = el("text", { class: "hc__tick", x: tx, y: H - 6, "text-anchor": tx < 16 ? "start" : tx > W - 16 ? "end" : "middle" });
      t.textContent = p.tick;
      svg.append(t);
    });
    const hit = el("rect", { class: "hc__hit", x: 0, y: 0, width: W, height: H });
    svg.append(hit);
    root.replaceChildren(svg, tip, table, live);

    showAt = (i: number) => {
      index = i;
      const p = o.points[i];
      groups.forEach((g, j) => g.classList.toggle("is-current", j === i));
      tip.replaceChildren();
      const title = document.createElement("span");
      title.className = "hc__tip-title";
      title.textContent = p.label;
      tip.append(title);
      p.values.forEach((v, j) => {
        if (v === null) return;
        const line = document.createElement("span");
        line.className = "hc__tip-row";
        const sw = document.createElement("i");
        sw.className = `hc__swatch ${o.series[j].cls}`;
        line.append(sw, document.createTextNode(`${o.series.length > 1 ? `${o.series[j].name} ` : ""}${o.format(v, j)}`));
        tip.append(line);
      });
      if (o.line) {
        const line = document.createElement("span");
        line.className = "hc__tip-row hc__tip-row--muted";
        line.textContent = `${o.line.name} ${o.format(o.line.values[i] ?? 0, 0)}`;
        tip.append(line);
      }
      const extra = o.note?.(i);
      if (extra) {
        const line = document.createElement("span");
        line.className = "hc__tip-row hc__tip-row--muted";
        line.textContent = extra;
        tip.append(line);
      }
      const top = Math.min(...p.values.filter((v): v is number => v !== null).map(y), base);
      const tw = tip.offsetWidth;
      tip.style.transform = `translate(${Math.min(Math.max(x(i) - tw / 2, 0), W - tw)}px, ${Math.max(top - tip.offsetHeight - 10, -tip.offsetHeight + 8)}px)`;
      root.classList.add("is-hovering");
    };
    const nearest = (clientX: number) => {
      const r = svg.getBoundingClientRect();
      return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
    };
    hit.addEventListener("pointermove", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerdown", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerleave", () => document.activeElement !== root && hide());
    if (o.onPick) hit.addEventListener("click", (e) => o.onPick!(nearest(e.clientX)));
  };

  root.addEventListener("focus", () => showAt(index));
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && o.onPick) {
      e.preventDefault();
      o.onPick(index);
      return;
    }
    const next = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? o.points.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(o.points.length - 1, next));
    showAt(i);
    const p = o.points[i];
    live.textContent = `${p.label}: ${p.values.map((v, j) => (v === null ? "" : `${o.series.length > 1 ? `${o.series[j].name} ` : ""}${o.format(v, j)}`)).filter(Boolean).join(", ")}`;
  });
  sized(root, build);
  return root;
}

// ---------- The week ----------

export interface HeatOptions {
  label: string;
  /** Row names, oldest first: "Mon 2". */
  rows: string[];
  /** rows × slots. */
  cells: number[][];
  max: number;
  format: (v: number) => string;
  /** Columns a day: 48 half hours (the default) or 24 hours (Music's listening times). */
  slots?: 24 | 48;
}

const STEPS = 6;
const hh = (slot: number) => clockOfDay(`${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`);

/** Day × half hour, darker for more. A step scale, so the legend can say what each shade means. */
export function heatmap(o: HeatOptions): HTMLElement {
  const root = document.createElement("div");
  root.className = "hc hc--heat viz-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  const n = o.slots ?? 48;
  const per = 48 / n;
  const at48 = (c: number) => hh(c * per);
  root.setAttribute("aria-label", `${o.label}. Use the arrow keys to read each ${n === 48 ? "half hour" : "hour"}.`);
  // The table by hour: 48 columns is too many to listen to.
  const table = hiddenTable(o.label, ["", ...Array.from({ length: 24 }, (_, h) => hh(h * 2))], o.rows.map((r, i) => [r, ...Array.from({ length: 24 }, (_, h) => o.format(n === 48 ? o.cells[i][h * 2] + o.cells[i][h * 2 + 1] : o.cells[i][h]))]));
  const tip = document.createElement("div");
  tip.className = "hc__tip";
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  let at = { r: o.rows.length - 1, c: (n * 3) / 4 };
  let showAt: (r: number, c: number) => void = () => undefined;
  const step = (v: number) => (o.max ? Math.min(STEPS - 1, Math.floor((v / o.max) * STEPS)) : 0);

  const build = (W: number) => {
    const labelW = 44;
    const top = 2;
    const rowH = 22;
    const H = top + o.rows.length * rowH + 20;
    const cw = (W - labelW) / n;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    const cells: SVGRectElement[][] = [];
    o.rows.forEach((name, r) => {
      const t = el("text", { class: "hc__tick hc__tick--row", x: 0, y: top + r * rowH + rowH / 2 + 4 });
      t.textContent = name;
      svg.append(t);
      cells.push(
        o.cells[r].map((v, c) => {
          const rect = el("rect", { class: `hc__cell hc__cell--${step(v)}`, x: labelW + c * cw + 0.5, y: top + r * rowH + 1, width: Math.max(1, cw - 1), height: rowH - 2, rx: 2 });
          svg.append(rect);
          return rect;
        })
      );
    });
    for (const c of [0, n / 4, n / 2, (n * 3) / 4]) {
      const t = el("text", { class: "hc__tick", x: labelW + c * cw, y: H - 5 });
      t.textContent = at48(c);
      svg.append(t);
    }
    const hit = el("rect", { class: "hc__hit", x: labelW, y: 0, width: W - labelW, height: top + o.rows.length * rowH });
    svg.append(hit);
    root.replaceChildren(svg, tip, table, live);
    showAt = (r, c) => {
      at = { r, c };
      cells.flat().forEach((x) => x.classList.remove("is-current"));
      cells[r][c].classList.add("is-current");
      tip.textContent = "";
      const title = document.createElement("span");
      title.className = "hc__tip-title";
      title.textContent = `${o.rows[r]}, ${at48(c)}`;
      const v = document.createElement("span");
      v.className = "hc__tip-row";
      v.textContent = o.format(o.cells[r][c]);
      tip.append(title, v);
      const tw = tip.offsetWidth;
      const cx = labelW + c * cw + cw / 2;
      tip.style.transform = `translate(${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px, ${top + r * rowH - tip.offsetHeight - 6}px)`;
      root.classList.add("is-hovering");
    };
    const pick = (e: PointerEvent) => {
      const b = svg.getBoundingClientRect();
      const px = ((e.clientX - b.left) / b.width) * W;
      const py = ((e.clientY - b.top) / b.height) * H;
      showAt(Math.max(0, Math.min(o.rows.length - 1, Math.floor((py - top) / rowH))), Math.max(0, Math.min(n - 1, Math.floor((px - labelW) / cw))));
    };
    hit.addEventListener("pointermove", pick);
    hit.addEventListener("pointerdown", pick);
    hit.addEventListener("pointerleave", () => document.activeElement !== root && root.classList.remove("is-hovering"));
  };
  root.addEventListener("focus", () => showAt(at.r, at.c));
  root.addEventListener("blur", () => root.classList.remove("is-hovering"));
  root.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    const r = Math.max(0, Math.min(o.rows.length - 1, at.r + d[0]));
    const c = Math.max(0, Math.min(n - 1, at.c + d[1]));
    showAt(r, c);
    live.textContent = `${o.rows[r]}, ${at48(c)}: ${o.format(o.cells[r][c])}`;
  });
  sized(root, build);
  const legend = document.createElement("div");
  legend.className = "hc-scale";
  legend.setAttribute("aria-hidden", "true");
  legend.append(document.createTextNode("Less"));
  for (let i = 0; i < STEPS; i++) {
    const s = document.createElement("i");
    s.className = `hc-scale__step hc__cell--${i}`;
    legend.append(s);
  }
  legend.append(document.createTextNode("More"));
  const wrap = document.createElement("div");
  wrap.className = "hc-heat-wrap";
  wrap.append(root, legend);
  return wrap;
}

// ---------- Lines (the months) ----------

export interface LineOptions {
  label: string;
  cls: string;
  points: Array<{ label: string; tick?: string; value: number | null }>;
  format: (v: number) => string;
  /** Points to ring: this month and the same month last year. */
  ring?: number[];
  height?: number;
}

export function lineChart(o: LineOptions): HTMLElement {
  const H = o.height ?? 120;
  const root = document.createElement("div");
  root.className = "hc viz-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${o.label}. Use the arrow keys to read each month.`);
  const present = o.points.map((p, i) => ({ ...p, i })).filter((p): p is typeof p & { value: number } => p.value !== null);
  const table = hiddenTable(o.label, ["", o.label], present.map((p) => [p.label, o.format(p.value)]));
  const tip = document.createElement("div");
  tip.className = "hc__tip";
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  let k = present.length - 1;
  let showAt: (k: number) => void = () => undefined;
  const build = (W: number) => {
    const pad = { top: 14, bottom: 22, side: 6 };
    const base = H - pad.bottom;
    const max = Math.max(1e-9, ...present.map((p) => p.value)) * 1.1;
    const n = o.points.length;
    const x = (i: number) => pad.side + (n === 1 ? (W - 2 * pad.side) / 2 : (i / (n - 1)) * (W - 2 * pad.side));
    const y = (v: number) => pad.top + (base - pad.top) * (1 - v / max);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    svg.append(el("line", { class: "hc__grid", x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
    const d = present.map((p, j) => `${j ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    svg.append(el("path", { class: `hc__area ${o.cls}`, d: `${d} L${x(present[present.length - 1].i).toFixed(1)},${base} L${x(present[0].i).toFixed(1)},${base} Z` }));
    svg.append(el("path", { class: `hc__line ${o.cls}`, d }));
    const dots = present.map((p) => {
      const c = el("circle", { class: `hc__dot ${o.cls}${o.ring?.includes(p.i) ? " is-ringed" : ""}`, cx: x(p.i), cy: y(p.value), r: o.ring?.includes(p.i) ? 4 : 2.5 });
      svg.append(c);
      return c;
    });
    let lastTick = -Infinity;
    o.points.forEach((p, i) => {
      if (!p.tick || x(i) - lastTick < 34) return;
      lastTick = x(i);
      const t = el("text", { class: "hc__tick", x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" });
      t.textContent = p.tick;
      svg.append(t);
    });
    const hit = el("rect", { class: "hc__hit", x: 0, y: 0, width: W, height: H });
    svg.append(hit);
    root.replaceChildren(svg, tip, table, live);
    showAt = (j) => {
      k = j;
      const p = present[j];
      dots.forEach((c, i) => c.classList.toggle("is-current", i === j));
      tip.textContent = "";
      const title = document.createElement("span");
      title.className = "hc__tip-title";
      title.textContent = p.label;
      const v = document.createElement("span");
      v.className = "hc__tip-row";
      v.textContent = o.format(p.value);
      tip.append(title, v);
      const tw = tip.offsetWidth;
      tip.style.transform = `translate(${Math.min(Math.max(x(p.i) - tw / 2, 0), W - tw)}px, ${Math.max(y(p.value) - tip.offsetHeight - 10, -tip.offsetHeight + 8)}px)`;
      root.classList.add("is-hovering");
    };
    const nearest = (clientX: number) => {
      const b = svg.getBoundingClientRect();
      const px = ((clientX - b.left) / b.width) * W;
      let best = 0;
      present.forEach((p, j) => Math.abs(x(p.i) - px) < Math.abs(x(present[best].i) - px) && (best = j));
      return best;
    };
    hit.addEventListener("pointermove", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerdown", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerleave", () => document.activeElement !== root && root.classList.remove("is-hovering"));
  };
  root.addEventListener("focus", () => present.length && showAt(k));
  root.addEventListener("blur", () => root.classList.remove("is-hovering"));
  root.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowLeft" ? k - 1 : e.key === "ArrowRight" ? k + 1 : null;
    if (next === null || !present.length) return;
    e.preventDefault();
    const j = Math.max(0, Math.min(present.length - 1, next));
    showAt(j);
    live.textContent = `${present[j].label}: ${o.format(present[j].value)}`;
  });
  if (present.length) sized(root, build);
  return root;
}

// ---------- Radar (a mix: the genres played) ----------

export interface RadarSeries {
  name: string;
  /** One per axis, as a share (0–1) or any value on one scale. */
  values: number[];
}

export interface RadarOptions {
  label: string;
  /** The spokes, clockwise from the top: "Indie", "Electronic"… */
  axes: string[];
  /** The first is the subject (filled, series 1); a second is drawn behind it as a grey outline to compare against. */
  series: RadarSeries[];
  format: (v: number) => string;
  height?: number;
}

/**
 * A mix as a shape: one spoke per category, the value as the distance from
 * the middle. Rings are quarters of the largest value, recessive. The first
 * series is the subject (a 2px line over a 10% wash); a second is emphasis's
 * de-emphasis grey, a 2px outline only. Pointer, touch and arrow keys pick a
 * spoke; the tooltip and the hidden table carry every value.
 */
export function radarChart(o: RadarOptions): HTMLElement {
  const H = o.height ?? 260;
  const n = o.axes.length;
  const root = document.createElement("div");
  root.className = "hc hc--radar viz-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${o.label}. Use the arrow keys to read each one.`);
  const table = hiddenTable(o.label, ["", ...o.series.map((s) => s.name)], o.axes.map((a, i) => [a, ...o.series.map((s) => o.format(s.values[i] ?? 0))]));
  const tip = document.createElement("div");
  tip.className = "hc__tip";
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  let index = 0;
  let showAt: (i: number) => void = () => undefined;
  const hide = () => root.classList.remove("is-hovering");
  const cls = (j: number) => (j === 0 ? "is-subject" : "is-before");

  const build = (W: number) => {
    // Room for the spoke names either side; the ring never wider than the height allows.
    const labelW = Math.min(120, Math.max(64, W * 0.24));
    const r = Math.max(40, Math.min(W / 2 - labelW, H / 2 - 22));
    const cx = W / 2;
    const cy = H / 2;
    const max = Math.max(1e-9, ...o.series.flatMap((s) => s.values));
    const angle = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    const at = (i: number, v: number) => [cx + Math.cos(angle(i)) * r * (v / max), cy + Math.sin(angle(i)) * r * (v / max)] as const;
    const ring = (f: number) => o.axes.map((_, i) => at(i, max * f).map((c) => c.toFixed(1)).join(",")).join(" ");
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    for (const f of [0.25, 0.5, 0.75, 1]) svg.append(el("polygon", { class: `hc__ring${f === 1 ? " is-outer" : ""}`, points: ring(f) }));
    const spokes = o.axes.map((_, i) => {
      const [x, y] = at(i, max);
      const s = el("line", { class: "hc__spoke", x1: cx, y1: cy, x2: x.toFixed(1), y2: y.toFixed(1) });
      svg.append(s);
      return s;
    });
    // The comparison first, so the subject sits on top.
    const order = o.series.map((s, j) => ({ s, j })).reverse();
    for (const { s, j } of order) {
      const pts = s.values.map((v, i) => at(i, v).map((c) => c.toFixed(1)).join(",")).join(" ");
      if (j === 0) svg.append(el("polygon", { class: `hc__radar-area ${cls(j)}`, points: pts }));
      svg.append(el("polygon", { class: `hc__radar-line ${cls(j)}`, points: pts }));
    }
    const dots = o.series.map((s, j) =>
      s.values.map((v, i) => {
        const [x, y] = at(i, v);
        const c = el("circle", { class: `hc__radar-dot ${cls(j)}`, cx: x.toFixed(1), cy: y.toFixed(1), r: 4 });
        svg.append(c);
        return c;
      })
    );
    const names = o.axes.map((a, i) => {
      const ax = Math.cos(angle(i));
      const ay = Math.sin(angle(i));
      const x = cx + ax * (r + 8);
      const y = cy + ay * (r + 8) + (ay > 0.3 ? 10 : ay < -0.3 ? -2 : 4);
      const t = el("text", { class: "hc__tick hc__radar-name", x: x.toFixed(1), y: y.toFixed(1), "text-anchor": Math.abs(ax) < 0.3 ? "middle" : ax > 0 ? "start" : "end" });
      // Long names are cut to fit, measured once drawn; the tooltip and table have them whole.
      const room = Math.abs(ax) < 0.3 ? labelW * 2 : labelW - 8;
      t.textContent = a;
      svg.append(t);
      const fits = () => typeof t.getComputedTextLength !== "function" || t.getComputedTextLength() <= room;
      for (let n = a.length - 1; !fits() && n > 3; n--) t.textContent = `${a.slice(0, n).trimEnd()}…`;
      return t;
    });
    const hit = el("rect", { class: "hc__hit", x: 0, y: 0, width: W, height: H });
    svg.append(hit);
    root.replaceChildren(svg, tip, table, live);

    showAt = (i: number) => {
      index = i;
      spokes.forEach((s, k) => s.classList.toggle("is-current", k === i));
      names.forEach((s, k) => s.classList.toggle("is-current", k === i));
      dots.forEach((row) => row.forEach((d, k) => d.classList.toggle("is-current", k === i)));
      tip.replaceChildren();
      const title = document.createElement("span");
      title.className = "hc__tip-title";
      title.textContent = o.axes[i];
      tip.append(title);
      o.series.forEach((s, j) => {
        const line = document.createElement("span");
        line.className = `hc__tip-row${j ? " hc__tip-row--muted" : ""}`;
        const sw = document.createElement("i");
        sw.className = `hc__swatch ${cls(j)}`;
        line.append(sw, document.createTextNode(`${o.series.length > 1 ? `${s.name} ` : ""}${o.format(s.values[i] ?? 0)}`));
        tip.append(line);
      });
      const [px, py] = at(i, Math.max(...o.series.map((s) => s.values[i] ?? 0)));
      const tw = tip.offsetWidth;
      tip.style.transform = `translate(${Math.min(Math.max(px - tw / 2, 0), W - tw)}px, ${Math.max(py - tip.offsetHeight - 12, -tip.offsetHeight + 8)}px)`;
      root.classList.add("is-hovering");
    };
    // The nearest spoke by angle from the middle.
    const nearest = (e: PointerEvent) => {
      const b = svg.getBoundingClientRect();
      const px = ((e.clientX - b.left) / b.width) * W - cx;
      const py = ((e.clientY - b.top) / b.height) * H - cy;
      const a = Math.atan2(py, px) + Math.PI / 2;
      return ((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n;
    };
    hit.addEventListener("pointermove", (e) => showAt(nearest(e)));
    hit.addEventListener("pointerdown", (e) => showAt(nearest(e)));
    hit.addEventListener("pointerleave", () => document.activeElement !== root && hide());
  };

  root.addEventListener("focus", () => showAt(index));
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowLeft" || e.key === "ArrowUp" ? index - 1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const i = (next + n) % n;
    showAt(i);
    live.textContent = `${o.axes[i]}: ${o.series.map((s) => `${o.series.length > 1 ? `${s.name} ` : ""}${o.format(s.values[i] ?? 0)}`).join(", ")}`;
  });
  sized(root, build);
  if (o.series.length < 2) return root;
  // Two shapes: a legend, so neither is told apart by colour alone.
  const legend = document.createElement("div");
  legend.className = "hc-legend";
  for (const [j, s] of o.series.entries()) {
    const item = document.createElement("span");
    item.className = "hc-legend__item";
    const sw = document.createElement("i");
    sw.className = `hc-legend__key ${cls(j)}`;
    sw.setAttribute("aria-hidden", "true");
    item.append(sw, document.createTextNode(s.name));
    legend.append(item);
  }
  const wrap = document.createElement("div");
  wrap.className = "hc-radar-wrap";
  wrap.append(root, legend);
  return wrap;
}
