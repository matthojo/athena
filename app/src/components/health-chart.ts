/**
 * The Health page's charts. One series each, so no legend: the card's title
 * names it. Mark spec per the dataviz skill and charts.css: columns with a
 * 4px rounded data end on a square base, a 2px surface gap between them,
 * one hairline baseline and one labelled hairline at a round value; the
 * weight line is 2px with 8px weigh-in markers ringed in the surface.
 * Pointer, touch and arrow keys drive the same tooltip; a visually hidden
 * table carries every value. Drawn at the container's real width.
 */

import "../styles/charts.css";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export interface ChartPoint {
  /** What the tooltip and table call it: "Fri 6 Nov", "Week of 3 Nov". */
  label: string;
  /** Under the axis, for the few points that get one. */
  tick?: string;
  value: number | null;
  /** With `stack`: the value split into parts, bottom first, adding up to `value`. */
  parts?: number[];
}

/** One part of a stacked bar: its name (tooltip, table, legend) and its CSS class (its colour). */
export interface StackPart {
  name: string;
  cls: string;
}

export interface ChartOptions {
  kind: "bars" | "line";
  points: ChartPoint[];
  /** "Sleep, a night": the hidden table's caption and the chart's name. */
  label: string;
  format: (v: number) => string;
  /** The labelled hairline: a round value near the top ("8h", "10k"). */
  reference?: (max: number) => { value: number; text: string };
  height?: number;
  /** Bars split into parts, bottom first (the Sleep card's stages). */
  stack?: StackPart[];
}

/** One chart. Empty points draw an empty frame of the same height. */
export function healthChart(opts: ChartOptions): HTMLDivElement {
  const H = opts.height ?? 132;
  const root = document.createElement("div");
  root.className = `hchart hchart--${opts.kind} viz-root`;
  const present = opts.points.map((p, i) => ({ ...p, i })).filter((p): p is ChartPoint & { i: number; value: number } => p.value !== null);
  if (!present.length) {
    root.style.height = `${H}px`;
    return root;
  }

  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${opts.label}. Use the arrow keys to read each value.`);

  // A table won't clip itself, so the hidden box is a div around it.
  const tableBox = document.createElement("div");
  tableBox.className = "visually-hidden";
  const table = document.createElement("table");
  tableBox.append(table);
  const cap = document.createElement("caption");
  cap.textContent = opts.label;
  table.append(cap);
  const stack = opts.kind === "bars" ? opts.stack : undefined;
  if (stack) {
    const head = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const name of ["", "Total", ...stack.map((x) => x.name)]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = name;
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
  }
  const tbody = document.createElement("tbody");
  for (const p of present) {
    const tr = document.createElement("tr");
    const a = document.createElement("th");
    a.scope = "row";
    a.textContent = p.label;
    const b = document.createElement("td");
    b.textContent = opts.format(p.value);
    tr.append(a, b);
    if (stack) for (let j = 0; j < stack.length; j++) {
      const td = document.createElement("td");
      td.textContent = p.parts?.[j] ? opts.format(p.parts[j]) : "–";
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");

  const values = present.map((p) => p.value);
  const rawMax = Math.max(...values);
  const ref = opts.reference?.(rawMax);
  let index = present.length - 1;
  let showAt: (k: number) => void = () => undefined;
  let hide: () => void = () => undefined;

  function build(W: number) {
    root.replaceChildren();
    const pad = { top: 18, bottom: 22, left: 0, right: 0 };
    const baseY = H - pad.bottom;
    const innerH = baseY - pad.top;
    const n = opts.points.length;
    let lo = 0;
    let hi = Math.max(rawMax, ref?.value ?? 0) || 1;
    if (opts.kind === "line") {
      // Weight moves in tenths: frame the weigh-ins, not zero.
      const min = Math.min(...values);
      const span = Math.max(rawMax - min, 1);
      lo = min - span * 0.35;
      hi = rawMax + span * 0.35;
    }
    const y = (v: number) => pad.top + innerH - ((v - lo) / (hi - lo)) * innerH;
    const slot = W / n;
    const x = (i: number) => slot * i + slot / 2;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    svg.append(el("line", { class: "hchart__grid", x1: 0, x2: W, y1: baseY + 0.5, y2: baseY + 0.5 }));
    let refLabel: SVGTextElement | null = null;
    if (ref && opts.kind === "bars") {
      const ry = Math.round(y(ref.value)) + 0.5;
      svg.append(el("line", { class: "hchart__grid hchart__grid--ref", x1: 0, x2: W, y1: ry, y2: ry }));
      refLabel = el("text", { class: "hchart__ref", x: W, y: ry - 5, "text-anchor": "end" });
      refLabel.textContent = ref.text;
    }

    const marks: SVGElement[] = [];
    if (opts.kind === "bars") {
      const gap = 2;
      const bw = Math.max(2, Math.min(slot - gap, 28));
      const r = Math.min(4, bw / 2);
      for (const p of present) {
        const top = Math.min(y(p.value), baseY - 1);
        const left = x(p.i) - bw / 2;
        const hgt = baseY - top;
        const rr = Math.min(r, hgt);
        // Rounded at the data end, square on the baseline.
        const d = `M${left},${baseY} V${top + rr} Q${left},${top} ${left + rr},${top} H${left + bw - rr} Q${left + bw},${top} ${left + bw},${top + rr} V${baseY} Z`;
        if (stack && p.parts?.some((v) => v > 0)) {
          // Parts from the baseline up, a 2px surface gap between them; only the top one is rounded.
          const g = el("g", { class: "hchart__bar hchart__bar--stack" });
          const shown = p.parts.map((v, j) => [v, j] as const).filter(([v]) => v > 0);
          let at = baseY;
          shown.forEach(([v, j], k) => {
            const hPart = (v / p.value) * hgt;
            const last = k === shown.length - 1;
            const y0 = last ? top : at - hPart + 1;
            const y1 = k === 0 ? at : at - 1;
            if (y1 - y0 < 0.5) {
              at -= hPart;
              return;
            }
            const r2 = last ? Math.min(r, y1 - y0) : 0;
            g.append(
              el("path", {
                class: `hchart__part ${stack[j].cls}`,
                d: `M${left},${y1} V${y0 + r2} Q${left},${y0} ${left + r2},${y0} H${left + bw - r2} Q${left + bw},${y0} ${left + bw},${y0 + r2} V${y1} Z`,
              })
            );
            at -= hPart;
          });
          marks.push(g);
          svg.append(g);
          continue;
        }
        const bar = el("path", { class: "hchart__bar", d });
        marks.push(bar);
        svg.append(bar);
      }
    } else {
      const pts = present.map((p) => `${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`);
      svg.append(el("path", { class: "hchart__line", d: `M${pts.join(" L")}` }));
      for (const p of present) {
        const dot = el("circle", { class: "hchart__dot", cx: x(p.i), cy: y(p.value), r: present.length > 40 ? 2.5 : 4 });
        marks.push(dot);
        svg.append(dot);
      }
    }

    // The reference value reads over the bars, haloed in the surface.
    if (refLabel) svg.append(refLabel);

    // Ticks: the ones the caller marked, never crowded.
    let lastTickX = -Infinity;
    opts.points.forEach((p, i) => {
      if (!p.tick) return;
      const tx = x(i);
      if (tx - lastTickX < 44) return;
      lastTickX = tx;
      const anchor = tx < 20 ? "start" : tx > W - 20 ? "end" : "middle";
      const t = el("text", { class: "hchart__tick", x: tx, y: H - 6, "text-anchor": anchor });
      t.textContent = p.tick;
      svg.append(t);
    });

    const cross = el("line", { class: "hchart__cross", x1: 0, x2: 0, y1: pad.top - 4, y2: baseY });
    svg.prepend(cross);
    const hit = el("rect", { class: "hchart__hit", x: 0, y: 0, width: W, height: H });
    svg.append(hit);
    const tip = document.createElement("div");
    tip.className = "hchart__tip";
    root.append(svg, tip, tableBox, live);

    showAt = (k: number) => {
      index = k;
      const p = present[k];
      const cx = x(p.i);
      marks.forEach((m, j) => m.classList.toggle("is-current", j === k));
      cross.setAttribute("x1", String(cx));
      cross.setAttribute("x2", String(cx));
      tip.replaceChildren(document.createTextNode(opts.format(p.value)));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = p.label;
      tip.append(meta);
      if (stack && p.parts?.some((v) => v > 0)) {
        const list = document.createElement("span");
        list.className = "hchart__tip-parts";
        // Top of the bar first, as it reads.
        for (let j = stack.length - 1; j >= 0; j--) {
          if (!p.parts[j]) continue;
          const row = document.createElement("span");
          row.className = "hchart__tip-part";
          const sw = document.createElement("i");
          sw.className = `hchart__swatch ${stack[j].cls}`;
          row.append(sw, document.createTextNode(`${stack[j].name} ${opts.format(p.parts[j])}`));
          list.append(row);
        }
        tip.append(list);
      }
      const tw = tip.offsetWidth;
      const left = Math.min(Math.max(cx - tw / 2, 0), W - tw);
      tip.style.transform = `translate(${left}px, ${Math.max(y(p.value) - tip.offsetHeight - 10, -tip.offsetHeight - 2)}px)`;
      root.classList.add("is-hovering");
    };
    hide = () => {
      root.classList.remove("is-hovering");
      marks.forEach((m) => m.classList.remove("is-current"));
    };
    const nearest = (clientX: number) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      let best = 0;
      present.forEach((p, k) => {
        if (Math.abs(x(p.i) - px) < Math.abs(x(present[best].i) - px)) best = k;
      });
      return best;
    };
    hit.addEventListener("pointermove", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerdown", (e) => showAt(nearest(e.clientX)));
    hit.addEventListener("pointerleave", () => document.activeElement !== root && hide());
  }

  root.addEventListener("focus", () => showAt(index));
  root.addEventListener("blur", () => hide());
  root.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? present.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const k = Math.max(0, Math.min(present.length - 1, next));
    showAt(k);
    live.textContent = `${present[k].label}: ${opts.format(present[k].value)}`;
  });

  let currentW = 0;
  build(320);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0 && Math.abs(w - currentW) > 1) {
        currentW = w;
        build(w);
      }
    }).observe(root);
  }
  return root;
}

/** Google's encoded polyline → [lat, lng] pairs. Bad input gives what decoded before it. */
export function decodeRoute(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      if (i >= s.length) return null;
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    const a = next();
    const b = next();
    if (a === null || b === null) break;
    lat += a;
    lng += b;
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/** A route's shape, drawn small with no map: where you went, not where you live. */
export function routeSketch(encoded: string, size = 44): SVGSVGElement | null {
  const pts = decodeRoute(encoded);
  if (pts.length < 2) return null;
  const midLat = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * k);
  const ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const pad = 6;
  const scale = (size - pad * 2) / span;
  const offX = (size - (Math.max(...xs) - minX) * scale) / 2;
  const offY = (size - (Math.max(...ys) - minY) * scale) / 2;
  const d = xs.map((xv, j) => `${j ? "L" : "M"}${((xv - minX) * scale + offX).toFixed(1)},${((ys[j] - minY) * scale + offY).toFixed(1)}`).join(" ");
  const svg = el("svg", { class: "route", viewBox: `0 0 ${size} ${size}`, width: size, height: size, "aria-hidden": "true" });
  svg.append(el("path", { class: "route__line", d }));
  const [sx, sy] = [(xs[0] - minX) * scale + offX, (ys[0] - minY) * scale + offY];
  svg.append(el("circle", { class: "route__start", cx: sx, cy: sy, r: 2.5 }));
  return svg;
}
