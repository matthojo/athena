/**
 * Single-series trend chart for a dashboard metric card. Mark spec per the
 * dataviz skill (2px line, 10% area, hairline baseline, 8px end marker with a
 * surface ring). Interactive by default: pointer hover/touch and keyboard
 * arrows drive the same crosshair + tooltip, and a visually hidden table
 * carries every value so the tooltip never gates the data.
 *
 * Rendered at the container's real pixel width (ResizeObserver) so stroke
 * and marker sizes stay exact instead of being scaled by a stretched viewBox.
 */

import type { MetricPoint } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export interface SparklineOptions {
  points: MetricPoint[];
  color: string;
  label: string;
  formatValue?: (v: number) => string;
  height?: number;
}

export function sparkline(opts: SparklineOptions): HTMLDivElement {
  const { points, color, label } = opts;
  const H = opts.height ?? 48;
  const fmt = opts.formatValue ?? ((v: number) => String(Math.round(v * 10) / 10));

  const container = document.createElement("div");
  container.className = "spark viz-root";
  if (!points.length) {
    container.style.height = `${H}px`;
    return container;
  }

  container.tabIndex = 0;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", `${label}, last ${points.length} weeks. Use arrow keys to read each week.`);

  const table = document.createElement("table");
  table.className = "visually-hidden";
  table.innerHTML = "<caption></caption><thead><tr><th scope=\"col\">Week of</th><th scope=\"col\">Value</th></tr></thead>";
  table.caption!.textContent = label;
  const tbody = document.createElement("tbody");
  for (const p of points) {
    const tr = document.createElement("tr");
    const d = document.createElement("td");
    d.textContent = DATE.format(Date.parse(p.recorded_at));
    const v = document.createElement("td");
    v.textContent = fmt(p.value);
    tr.append(d, v);
    tbody.append(tr);
  }
  table.append(tbody);

  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  let showAt: (i: number) => void = () => {};
  let hide: () => void = () => {};
  let index = points.length - 1;

  function build(W: number) {
    container.replaceChildren();
    const pad = { top: 6, bottom: 6, left: 4, right: 6 };
    const innerW = W - pad.left - pad.right;
    const innerH = H - pad.top - pad.bottom;
    const baseY = H - pad.bottom;

    const coords = points.map((p, i) => ({
      x: points.length === 1 ? pad.left + innerW : pad.left + (i / (points.length - 1)) * innerW,
      y: pad.top + innerH - ((p.value - min) / range) * innerH,
      p,
    }));

    const line = coords.map((c, i) => `${i ? "L" : "M"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${baseY} L${coords[0].x.toFixed(1)},${baseY} Z`;

    const svgEl = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    svgEl.append(
      el("line", { class: "spark__grid", x1: pad.left, x2: W - pad.right, y1: baseY, y2: baseY }),
      el("path", { class: "spark__area", d: area, fill: color }),
      el("path", { class: "spark__line", d: line, stroke: color })
    );
    const last = coords[coords.length - 1];
    svgEl.append(el("circle", { class: "spark__end", cx: last.x, cy: last.y, r: 4, fill: color }));

    const cross = el("line", { class: "spark__crosshair", x1: 0, x2: 0, y1: pad.top - 2, y2: baseY });
    const dot = el("circle", { class: "spark__cursor-dot", r: 4, fill: color, cx: 0, cy: 0 });
    const hit = el("rect", { class: "spark__hit", x: 0, y: 0, width: W, height: H });
    svgEl.append(cross, dot, hit);

    const tip = document.createElement("div");
    tip.className = "spark__tooltip";
    container.append(svgEl, tip, table, live);

    showAt = (i: number) => {
      index = i;
      const c = coords[i];
      cross.setAttribute("x1", String(c.x));
      cross.setAttribute("x2", String(c.x));
      dot.setAttribute("cx", String(c.x));
      dot.setAttribute("cy", String(c.y));
      tip.textContent = fmt(c.p.value);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = DATE.format(Date.parse(c.p.recorded_at));
      tip.append(meta);
      const tw = tip.offsetWidth;
      const left = Math.min(Math.max(c.x - tw / 2, -4), W - tw + 4);
      tip.style.transform = `translate(${left}px, ${c.y - tip.offsetHeight - 10}px)`;
      container.classList.add("is-hovering");
    };
    hide = () => container.classList.remove("is-hovering");

    const nearest = (clientX: number) => {
      const rect = svgEl.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * W;
      let best = 0;
      coords.forEach((c, i) => {
        if (Math.abs(c.x - x) < Math.abs(coords[best].x - x)) best = i;
      });
      return best;
    };

    hit.addEventListener("pointermove", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerdown", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerleave", () => {
      if (document.activeElement !== container) hide();
    });
  }

  container.addEventListener("focus", () => showAt(index));
  container.addEventListener("blur", () => hide());
  container.addEventListener("keydown", (e) => {
    const next =
      e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? points.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(points.length - 1, next));
    showAt(i);
    live.textContent = `${DATE.format(Date.parse(points[i].recorded_at))}: ${fmt(points[i].value)}`;
  });

  let currentW = 0;
  build(160);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && Math.abs(w - currentW) > 1) {
        currentW = w;
        build(w);
      }
    }).observe(container);
  }

  return container;
}
