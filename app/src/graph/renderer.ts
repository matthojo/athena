/**
 * The graph on a <canvas>: a force-directed layout (d3-force, ticked by our
 * own frame loop so it goes quiet once settled) with pan, zoom, drag-to-pin,
 * hover and tap. Shared by the Graph page ("full") and the small graphs on
 * profiles and notes ("local"), which differ only in what the pointer may do:
 *
 *  - full: drag empty space to pan, pinch or wheel to zoom, drag a dot to pin
 *    it where you drop it, tap a dot to light it and its neighbours up, tap it
 *    again (or double-click) to open it. Arrow keys pan, + and - zoom, 0 fits,
 *    Escape clears.
 *  - local: laid out and framed before it's drawn. On touch it only takes
 *    taps, so the page still scrolls under your thumb; a mouse can drag dots.
 *
 * With prefers-reduced-motion the layout settles before the first paint and
 * the camera jumps rather than glides. Colours are CSS custom properties on
 * the host element (styles/graph.css), re-read when the colour scheme flips.
 * Labels are drawn in screen space at a fixed size with a halo, largest dots
 * first, skipping any that would collide.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { h } from "../lib/dom";
import { initials } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { colorVar, isDetail, labelFor, radiusFor } from "./kinds";
import type { GraphLink, GraphNode } from "../types";
import { onSchemeChange } from "../lib/appearance";

interface SimNode extends SimulationNodeDatum {
  id: string;
  data: GraphNode;
  r: number;
  /** Steps from the centre in a local graph (0, 1, 2); 1 on the full graph. */
  ring: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode;
  target: SimNode;
}

export type Positions = Map<string, { x: number; y: number; pinned: boolean }>;

export interface RendererOptions {
  mode: "full" | "local";
  /** A local graph's subject, held at the centre. */
  centerId?: string;
  /** Screen pixels covered at the bottom (the selection card), so framing avoids them. */
  bottomInset?: () => number;
  /** Where dots were last time (a remount keeps its layout and pins). */
  positions?: Positions;
  onSelect?: (node: GraphNode | null) => void;
  onOpen?: (node: GraphNode) => void;
  /** A dot was pinned by dragging it. */
  onPin?: (node: GraphNode) => void;
}

export interface GraphRenderer {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Show these dots and links; dots already on screen keep their places. `depth` is a local graph's rings. */
  setGraph(nodes: GraphNode[], links: GraphLink[], depth?: Map<string, number>): void;
  select(id: string | null, opts?: { reveal?: boolean }): void;
  selectedId(): string | null;
  neighbours(id: string): GraphNode[];
  zoomBy(factor: number): void;
  fit(): void;
  isPinned(id: string): boolean;
  unpin(id: string): void;
  positions(): Positions;
  destroy(): void;
}

type Camera = { k: number; tx: number; ty: number };

const TAU = Math.PI * 2;
const MAX_LABELS = 140;
const FALLBACK: Record<string, string> = {
  "--graph-bg": "#fcfdfe",
  "--graph-link": "rgba(80, 90, 110, 0.28)",
  "--graph-link-hot": "#2c5fdd",
  "--graph-label": "#4c5058",
  "--graph-label-strong": "#15181e",
  "--graph-ring": "#2c5fdd",
  "--graph-on-node": "#ffffff",
  "--graph-person": "#2c5fdd",
  "--graph-note": "#8a8f99",
  "--graph-place": "#0f9a7a",
  "--graph-organisation": "#c38a1e",
  "--graph-event": "#d2584f",
  "--graph-record": "#b5487c",
  "--graph-saved": "#767700",
  "--graph-detail": "#8a7fb8",
};

/** A stable angle per id, so new dots appear around their neighbour the same way every time. */
function angleFor(id: string): number {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 33 + id.charCodeAt(i)) % 3600;
  return (x / 3600) * TAU;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function createRenderer(opts: RendererOptions): GraphRenderer {
  const full = opts.mode === "full";
  const reduced = prefersReducedMotion();
  const canvas = h("canvas", { class: "graph-canvas" }) as HTMLCanvasElement;
  const el = h("div", { class: `graph-surface graph-surface--${opts.mode}` }, canvas);
  const ctx = canvas.getContext("2d")!;

  let w = 0;
  let hgt = 0;
  let dpr = 1;
  let cam: Camera = { k: 1, tx: 0, ty: 0 };
  let nodes: SimNode[] = [];
  let order: SimNode[] = [];
  let links: SimLink[] = [];
  const byId = new Map<string, SimNode>();
  const adj = new Map<string, Set<string>>();
  const pinned = new Set<string>();
  /** Every dot ever shown, so one hidden by a filter keeps its place for when it returns. */
  const placed = new Map<string, SimNode>();
  let hubs = new Set<string>();
  let selected: string | null = null;
  let hovered: string | null = null;
  /** Keep framing everything until the user moves the camera. */
  let autoFit = true;
  let firstLayout = true;
  let dead = false;

  // ---------- layout ----------

  const linkForce = forceLink<SimNode, SimLink>([])
    .id((d) => d.id)
    .distance((l) => (isDetail(l.source.data.kind) || isDetail(l.target.data.kind) ? 14 : full ? 36 : 30) + l.source.r + l.target.r);
  const sim = forceSimulation<SimNode>([])
    .stop()
    .alphaDecay(0.035)
    .alphaMin(0.004)
    .velocityDecay(0.42)
    .force("link", linkForce)
    .force(
      "charge",
      forceManyBody<SimNode>()
        .strength((d) => (isDetail(d.data.kind) ? -28 : -70 - d.r * 5))
        .distanceMax(full ? 380 : 240)
        .theta(0.9)
    )
    .force("collide", forceCollide<SimNode>((d) => d.r + (isDetail(d.data.kind) ? 1.5 : 3)).strength(0.85));

  /**
   * Gravity toward the middle keeps loose dots (unlinked notes) in a ring
   * close by rather than drifting off. It pulls harder across the narrow side
   * of the canvas, so a phone's tall canvas gets a tall graph to fill it.
   */
  let aspect = 1;
  function setGravity() {
    const stretch = Math.pow(Math.min(1.8, Math.max(0.55, aspect)), 0.85);
    const pull = (d: SimNode) => (isDetail(d.data.kind) ? 0.03 : 0.1);
    sim.force("x", forceX<SimNode>(0).strength((d) => pull(d) * stretch)).force("y", forceY<SimNode>(0).strength((d) => pull(d) / stretch));
  }
  setGravity();

  /** Run the layout to rest without drawing (reduced motion, local graphs). */
  function settle() {
    for (let i = 0; i < 600 && sim.alpha() >= sim.alphaMin(); i++) sim.tick();
  }

  function setGraph(gnodes: GraphNode[], glinks: GraphLink[], depth?: Map<string, number>) {
    const prev = new Map(byId);
    byId.clear();
    adj.clear();
    nodes = gnodes.map((g) => {
      // A dot a filter hid comes back where it was (pinned, if it was).
      const n: SimNode = placed.get(g.id) ?? { id: g.id, data: g, r: 0, ring: 1 };
      placed.set(g.id, n);
      n.data = g;
      n.ring = depth?.get(g.id) ?? 1;
      n.r = radiusFor(g) * (n.ring === 2 ? 0.82 : 1);
      byId.set(g.id, n);
      adj.set(g.id, new Set());
      return n;
    });
    links = [];
    for (const l of glinks) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (!s || !t || s === t) continue;
      links.push({ source: s, target: t });
      adj.get(s.id)!.add(t.id);
      adj.get(t.id)!.add(s.id);
    }

    // Where each dot starts: last time's place, else beside a neighbour that has one.
    let added = 0;
    let restored = 0;
    for (const n of nodes) {
      if (n.x !== undefined) continue;
      const saved = opts.positions?.get(n.id);
      if (saved) {
        n.x = saved.x;
        n.y = saved.y;
        if (saved.pinned) pinned.add(n.id);
        restored++;
        continue;
      }
      added++;
    }
    if (added) {
      for (const n of nodes) {
        if (n.x !== undefined) continue;
        const anchor = [...adj.get(n.id)!].map((id) => byId.get(id)!).find((m) => m.x !== undefined);
        if (!anchor) continue;
        const a = angleFor(n.id);
        n.x = anchor.x! + Math.cos(a) * (anchor.r + 24);
        n.y = anchor.y! + Math.sin(a) * (anchor.r + 24);
      }
    }
    for (const n of nodes) {
      if (pinned.has(n.id)) {
        n.fx = n.x;
        n.fy = n.y;
      } else if (n.id !== opts.centerId) {
        n.fx = null;
        n.fy = null;
      }
    }
    const centre = opts.centerId ? byId.get(opts.centerId) : undefined;
    if (centre) {
      centre.fx = 0;
      centre.fy = 0;
    }

    // Big dots draw last (on top); hubs are labelled even when zoomed out.
    order = [...nodes].sort((a, b) => Number(!isDetail(a.data.kind)) - Number(!isDetail(b.data.kind)) || a.r - b.r);
    const pages = nodes.filter((n) => !isDetail(n.data.kind) && n.data.degree >= 2).sort((a, b) => b.data.degree - a.data.degree);
    hubs = new Set(pages.slice(0, Math.max(4, Math.min(30, Math.round(nodes.length / 10)))).map((n) => n.id));

    sim.nodes(nodes);
    linkForce.links(links);

    if (selected && !byId.has(selected)) select(null);
    if (hovered && !byId.has(hovered)) hovered = null;

    // A remount that found nearly every dot's old place barely stirs; a first
    // layout starts hot; a filter change warms it enough to close the gaps.
    const fresh = nodes.length !== prev.size || nodes.some((n) => !prev.has(n.id));
    const resumed = firstLayout && restored > nodes.length * 0.8;
    const startAlpha = firstLayout ? (resumed ? 0.1 : 1) : fresh ? 0.5 : 0.08;
    sim.alpha(Math.max(sim.alpha(), startAlpha));
    if (reduced || !full) settle();
    else if (firstLayout && !resumed) sim.tick(24);
    if (firstLayout && w) frameAll();
    else if (autoFit && (reduced || !full)) frameAll();
    firstLayout = false;
    requestFrame();
  }

  // ---------- camera ----------

  const toWorld = (sx: number, sy: number) => ({ x: (sx - cam.tx) / cam.k, y: (sy - cam.ty) / cam.k });
  const minK = full ? 0.06 : 0.2;
  const maxK = full ? 4 : 3;
  const clampK = (k: number) => Math.min(maxK, Math.max(minK, k));
  const inset = () => Math.min(hgt * 0.5, opts.bottomInset?.() ?? 0);

  function fitCamera(): Camera {
    const pad = full ? 32 : 18;
    // The full graph keeps clear of the controls floating along its top and the line of stats at its foot.
    const top = full ? 40 : 0;
    const bottom = inset() + (full ? 16 : 0);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x! - n.r);
      maxX = Math.max(maxX, n.x! + n.r);
      minY = Math.min(minY, n.y! - n.r);
      maxY = Math.max(maxY, n.y! + n.r + 16); // room for the label under the lowest dot
    }
    if (!nodes.length || !Number.isFinite(minX)) return { k: 1, tx: w / 2, ty: (hgt - bottom) / 2 };
    const availW = Math.max(40, w - pad * 2);
    const availH = Math.max(40, hgt - pad * 2 - top - bottom);
    const k = clampK(Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY), full ? 1.7 : 1.85));
    return { k, tx: w / 2 - ((minX + maxX) / 2) * k, ty: pad + top + availH / 2 - ((minY + maxY) / 2) * k };
  }

  function frameAll(lerp = 1) {
    const t = fitCamera();
    cam = lerp >= 1 ? t : { k: cam.k + (t.k - cam.k) * lerp, tx: cam.tx + (t.tx - cam.tx) * lerp, ty: cam.ty + (t.ty - cam.ty) * lerp };
  }

  let tween: { from: Camera; to: Camera; start: number; dur: number } | null = null;

  function animateTo(to: Camera) {
    if (reduced) {
      cam = to;
      tween = null;
      requestFrame();
      return;
    }
    tween = { from: { ...cam }, to, start: performance.now(), dur: 460 };
    requestFrame();
  }

  /** Glide along a straight line in the world, zooming in log space. */
  function stepTween(now: number): boolean {
    if (!tween) return false;
    const p = Math.min(1, (now - tween.start) / tween.dur);
    const e = 1 - Math.pow(1 - p, 4);
    const { from, to } = tween;
    const centre = (c: Camera) => ({ x: (w / 2 - c.tx) / c.k, y: (hgt / 2 - c.ty) / c.k });
    const a = centre(from);
    const b = centre(to);
    const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
    const cx = a.x + (b.x - a.x) * e;
    const cy = a.y + (b.y - a.y) * e;
    cam = { k, tx: w / 2 - cx * k, ty: hgt / 2 - cy * k };
    if (p >= 1) tween = null;
    return !!tween;
  }

  function zoomAt(sx: number, sy: number, factor: number) {
    const k = clampK(cam.k * factor);
    const p = toWorld(sx, sy);
    cam = { k, tx: sx - p.x * k, ty: sy - p.y * k };
    autoFit = false;
    tween = null;
    requestFrame();
  }

  /** Bring a dot to the middle of what's visible, close enough to read. */
  function reveal(n: SimNode) {
    autoFit = false;
    const k = clampK(Math.min(Math.max(cam.k, full ? 1.3 : 1), 2.2));
    const midY = (hgt - inset()) / 2;
    animateTo({ k, tx: w / 2 - n.x! * k, ty: midY - n.y! * k });
  }

  /**
   * After a tap, nudge the camera (never zoom) so the dot and its neighbours
   * aren't under the card or off an edge: as much of the group as fits, the
   * dot itself always.
   */
  function keepClear(n: SimNode) {
    requestAnimationFrame(() => {
      const group = [n, ...[...(adj.get(n.id) ?? [])].map((id) => byId.get(id)!)];
      const { k, tx, ty } = cam;
      const top = 56;
      const bottom = hgt - inset() - 24;
      const xs = group.map((m) => m.x! * k + tx);
      const ys = group.map((m) => m.y! * k + ty);
      const [minX, maxX, minY, maxY] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...ys) - 20, Math.max(...ys) + 24];
      const shift = (lo: number, hi: number, min: number, max: number, own: number) => {
        if (hi - lo > max - min) return Math.min(max - 30, Math.max(min + 30, own)) - own; // too big: just keep the dot in view
        return lo < min ? min - lo : hi > max ? max - hi : 0;
      };
      const dx = shift(minX, maxX, 12, w - 12, n.x! * k + tx);
      const dy = shift(minY, maxY, top, bottom, n.y! * k + ty);
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        autoFit = false;
        animateTo({ k, tx: tx + dx, ty: ty + dy });
      }
    });
  }

  // ---------- frames ----------

  let raf = 0;
  let dragging: SimNode | null = null;

  function requestFrame() {
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    let busy = false;
    // Reduced motion and local graphs settle up front; they only move while a dot is dragged.
    if (dragging || (!reduced && full && sim.alpha() >= sim.alphaMin())) {
      sim.tick();
      busy = true;
    }
    if (stepTween(now)) busy = true;
    if (autoFit && busy && !tween && full) frameAll(0.2);
    draw();
    if (busy) requestFrame();
  }

  // ---------- colours ----------

  let colors: Record<string, string> = { ...FALLBACK };
  let font = "Geist, system-ui, sans-serif";

  function readColors() {
    const cs = getComputedStyle(el);
    // Most graph colours are color-mix() recipes of the theme's colours (tokens.css). A probe's
    // computed colour is the mix worked out, which a canvas can take.
    const probe = h("span", { hidden: "" });
    el.append(probe);
    const resolve = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const next: Record<string, string> = {};
    for (const name of Object.keys(FALLBACK)) {
      const value = cs.getPropertyValue(name).trim() && resolve(name);
      // A colour the canvas can't parse leaves fillStyle unchanged: use the fallback then.
      ctx.fillStyle = FALLBACK[name];
      const before = ctx.fillStyle;
      if (value) ctx.fillStyle = value;
      next[name] = value && (ctx.fillStyle !== before || value === FALLBACK[name]) ? value : FALLBACK[name];
    }
    probe.remove();
    colors = next;
    font = cs.getPropertyValue("--font-ui").trim() || font;
  }
  const colorOf = (n: SimNode) => colors[colorVar(n.data.kind)];

  const stopScheme = onSchemeChange(() => {
    readColors();
    requestFrame();
  });

  // ---------- drawing ----------

  function draw() {
    if (!w || !hgt) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, hgt);
    if (!nodes.length) return;

    const focus = hovered ?? selected;
    const hot = focus ? new Set([focus, ...(adj.get(focus) ?? [])]) : null;
    const { k, tx, ty } = cam;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.lineCap = "round";

    // Links: hairlines, and the lit ones on top in the accent.
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = colors["--graph-link"];
    ctx.globalAlpha = hot ? 0.35 : 1;
    ctx.beginPath();
    for (const l of links) {
      if (hot && (l.source.id === focus || l.target.id === focus)) continue;
      ctx.moveTo(l.source.x!, l.source.y!);
      ctx.lineTo(l.target.x!, l.target.y!);
    }
    ctx.stroke();
    if (hot) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6 / k;
      ctx.strokeStyle = colors["--graph-link-hot"];
      ctx.beginPath();
      for (const l of links) {
        if (l.source.id !== focus && l.target.id !== focus) continue;
        ctx.moveTo(l.source.x!, l.source.y!);
        ctx.lineTo(l.target.x!, l.target.y!);
      }
      ctx.stroke();
    }

    // Dots: a halo in the background colour so links stop short of each dot,
    // then the dot (pages solid, details as rings).
    for (const n of order) {
      const dim = hot && !hot.has(n.id);
      ctx.globalAlpha = dim ? 0.14 : n.ring === 2 ? 0.62 : 1;
      ctx.fillStyle = colors["--graph-bg"];
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r + 1.6 / k, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      if (isDetail(n.data.kind)) {
        ctx.lineWidth = n.r * 0.42;
        ctx.strokeStyle = colorOf(n);
        ctx.arc(n.x!, n.y!, n.r * 0.79, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = colorOf(n);
        ctx.arc(n.x!, n.y!, n.r, 0, TAU);
        ctx.fill();
      }
    }

    // Rings: the selection, the local graph's subject, and pinned dots.
    ctx.globalAlpha = 1;
    const ring = (n: SimNode, gap: number, width: number, color: string, dash?: number[]) => {
      ctx.setLineDash(dash ?? []);
      ctx.lineWidth = width / k;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r + gap / k, 0, TAU);
      ctx.stroke();
    };
    const centre = opts.centerId ? byId.get(opts.centerId) : undefined;
    if (centre && centre.id !== selected) ring(centre, 3.5, 1.5, colors["--graph-label"]);
    for (const id of pinned) {
      const n = byId.get(id);
      if (n && id !== selected) ring(n, 3, 1.2, colors["--graph-label"], [2.5 / k, 2.5 / k]);
    }
    const sel = selected ? byId.get(selected) : undefined;
    if (sel) ring(sel, 4, 2.2, colors["--graph-ring"]);
    ctx.setLineDash([]);

    drawText(hot, focus);
  }

  const widths = new Map<string, number>();
  function textWidth(text: string): number {
    let wd = widths.get(text);
    if (wd === undefined) {
      wd = ctx.measureText(text).width;
      if (widths.size > 4000) widths.clear();
      widths.set(text, wd);
    }
    return wd;
  }

  function drawText(hot: Set<string> | null, focus: string | null) {
    const { k, tx, ty } = cam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;

    // Initials inside people's dots once they're big enough to hold them.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors["--graph-on-node"];
    for (const n of nodes) {
      if (n.data.kind !== "person") continue;
      const sr = n.r * k;
      if (sr < 11 || (hot && !hot.has(n.id))) continue;
      const sx = n.x! * k + tx;
      const sy = n.y! * k + ty;
      if (sx < -sr || sy < -sr || sx > w + sr || sy > hgt + sr) continue;
      ctx.font = `600 ${Math.min(17, Math.round(sr * 0.72))}px ${font}`;
      ctx.fillText(initials(n.data.title), sx, sy + 0.5);
    }

    // Labels, most important first; any that would collide are skipped.
    const show = (n: SimNode): boolean => {
      if (hot) return hot.has(n.id);
      if (n.id === selected || pinned.has(n.id)) return true;
      if (!full) return n.ring <= 1 || n.r * k >= 7;
      if (isDetail(n.data.kind)) return k >= 1.7;
      return k >= 0.68 || n.r * k >= 8 || (hubs.has(n.id) && k >= 0.45);
    };
    const rank = (n: SimNode) => (n.id === focus ? 1e6 : 0) + (n.id === opts.centerId ? 5e5 : 0) + (hot?.has(n.id) ? 1e4 : 0) + (isDetail(n.data.kind) ? 0 : 1e3) + n.r;
    const candidates = nodes.filter(show).sort((a, b) => rank(b) - rank(a));
    const size = full ? 12 : 11.5;
    ctx.font = `500 ${size}px ${font}`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    type Box = { x: number; y: number; w: number; h: number; id?: string; detail?: boolean };
    const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    // Dots are obstacles too, so a label never sits on another dot. Faded dots
    // don't count, and a page's label may cross the small detail rings around
    // it; a detail's own label only goes where it covers no dot at all.
    const dots: Box[] = [];
    for (const n of nodes) {
      if (hot && !hot.has(n.id)) continue;
      const sr = Math.max(2, n.r * k);
      const sx = n.x! * k + tx;
      const sy = n.y! * k + ty;
      if (sx < -sr || sy < -sr || sx > w + sr || sy > hgt + sr) continue;
      dots.push({ x: sx - sr, y: sy - sr, w: sr * 2, h: sr * 2, id: n.id, detail: isDetail(n.data.kind) });
    }
    const labelled: Box[] = [];
    let count = 0;
    for (const n of candidates) {
      if (count >= MAX_LABELS) break;
      const sx = n.x! * k + tx;
      const sy = n.y! * k + ty;
      if (sx < 0 || sx > w || sy < 0 || sy > hgt) continue; // a label away from its dot would mislead
      const text = truncate(labelFor(n.data), full ? 30 : 24);
      const tw = textWidth(text);
      const strict = isDetail(n.data.kind);
      const free = (b: Box) => !labelled.some((p) => overlaps(b, p)) && !dots.some((d) => d.id !== n.id && (strict || !d.detail) && overlaps(b, d));
      // Under the dot if there's room, else over it, else beside it; the
      // focus is always labelled. Labels slide inward rather than run off an edge.
      const sr = n.r * k;
      const below = { x: Math.min(Math.max(sx - tw / 2 - 2, 4), w - tw - 8), y: sy + sr + 3, w: tw + 4, h: size + 3 };
      const above = { ...below, y: sy - sr - 3 - (size + 3) };
      const right = { ...below, x: sx + sr + 5, y: sy - (size + 3) / 2 };
      const leftSide = { ...right, x: sx - sr - 5 - (tw + 4) };
      // Beside is for a lit neighbourhood and the small graphs; in the overview it reads as belonging to the wrong dot.
      const beside = hot || !full;
      const options = [below, above, ...(beside && right.x + right.w < w ? [right] : []), ...(beside && leftSide.x > 0 ? [leftSide] : [])];
      const box = options.find(free) ?? (n.id === focus ? below : null);
      if (!box) continue;
      labelled.push(box);
      count++;
      const strong = n.id === focus || n.id === selected || n.id === opts.centerId;
      ctx.globalAlpha = n.ring === 2 && !hot ? 0.75 : 1;
      const cx = box.x + box.w / 2;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = colors["--graph-bg"];
      ctx.strokeText(text, cx, box.y + 2);
      ctx.fillStyle = strong ? colors["--graph-label-strong"] : colors["--graph-label"];
      ctx.fillText(text, cx, box.y + 2);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- size ----------

  function resize() {
    const rect = el.getBoundingClientRect();
    const nw = Math.round(rect.width);
    const nh = Math.round(rect.height);
    const ndpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!nw || !nh || (nw === w && nh === hgt && ndpr === dpr)) return;
    const centre = w ? toWorld(w / 2, hgt / 2) : { x: 0, y: 0 };
    const firstSize = !w;
    w = nw;
    hgt = nh;
    dpr = ndpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    if (firstSize) readColors();
    // A new shape (first size, rotation, a resized window) reshapes the layout to match.
    const nextAspect = hgt / w;
    if (Math.abs(nextAspect - aspect) > 0.15) {
      aspect = nextAspect;
      setGravity();
      if (nodes.length) {
        sim.alpha(Math.max(sim.alpha(), firstSize ? 0.6 : 0.3));
        if (reduced || !full) settle();
      }
    }
    if (autoFit) frameAll();
    else cam = { ...cam, tx: w / 2 - centre.x * cam.k, ty: hgt / 2 - centre.y * cam.k };
    draw();
    requestFrame();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  void document.fonts?.ready.then(() => !dead && requestFrame());

  // ---------- selection ----------

  function select(id: string | null, o: { reveal?: boolean } = {}) {
    const next = id && byId.has(id) ? id : null;
    if (next !== selected) {
      selected = next;
      opts.onSelect?.(next ? byId.get(next)!.data : null);
    }
    if (next && o.reveal) reveal(byId.get(next)!);
    requestFrame();
  }

  function tap(n: SimNode | null) {
    if (!n) return select(null);
    if (n.id === selected) return opts.onOpen?.(n.data);
    select(n.id);
    if (full) keepClear(n);
  }

  // ---------- pointer ----------

  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function hit(sx: number, sy: number, touch: boolean): SimNode | null {
    const p = toWorld(sx, sy);
    const slop = (touch ? 14 : 6) / cam.k;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x! - p.x, n.y! - p.y) - n.r;
      if (d < slop && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /** Keep a pointer's moves coming here once it leaves the canvas (best effort). */
  function capture(id: number) {
    try {
      canvas.setPointerCapture(id);
    } catch {
      // the pointer has already gone
    }
  }

  type Gesture =
    | { type: "press"; id: number; start: { x: number; y: number }; node: SimNode | null; touch: boolean }
    | { type: "drag"; id: number; node: SimNode }
    | { type: "pan"; id: number; last: { x: number; y: number } }
    | { type: "pinch"; startDist: number; startK: number; anchor: { x: number; y: number } };

  const points = new Map<number, { x: number; y: number }>();
  let gesture: Gesture | null = null;

  function setCursor() {
    canvas.style.cursor = gesture?.type === "pan" || gesture?.type === "drag" ? "grabbing" : hovered ? "pointer" : full ? "grab" : "default";
  }

  function onDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    points.set(e.pointerId, p);
    if (points.size === 2 && full) {
      capture(e.pointerId);
      if (gesture?.type === "drag") release(gesture);
      const [a, b] = [...points.values()];
      gesture = { type: "pinch", startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1, startK: cam.k, anchor: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
      autoFit = false;
      tween = null;
      return;
    }
    if (points.size > 1) return;
    if (full) capture(e.pointerId);
    gesture = { type: "press", id: e.pointerId, start: p, node: hit(p.x, p.y, e.pointerType !== "mouse"), touch: e.pointerType !== "mouse" };
  }

  function onMove(e: PointerEvent) {
    const p = local(e);
    if (!gesture && e.pointerType === "mouse") {
      const n = hit(p.x, p.y, false);
      if ((n?.id ?? null) !== hovered) {
        hovered = n?.id ?? null;
        setCursor();
        requestFrame();
      }
      return;
    }
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, p);
    if (!gesture) return;
    if (gesture.type === "pinch") {
      const [a, b] = [...points.values()];
      if (!b) return;
      const k = clampK((gesture.startK * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.startDist);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      cam = { k, tx: mid.x - gesture.anchor.x * k, ty: mid.y - gesture.anchor.y * k };
      requestFrame();
      return;
    }
    if (gesture.id !== e.pointerId) return;
    if (gesture.type === "press") {
      if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < (gesture.touch ? 8 : 4)) return;
      // Local graphs on touch leave dragging to the page's scroll.
      if (!full && gesture.touch) {
        gesture = null;
        return;
      }
      if (gesture.node) {
        const n = gesture.node;
        if (!full) capture(e.pointerId);
        gesture = { type: "drag", id: e.pointerId, node: n };
        dragging = n;
        hovered = n.id;
        sim.alphaTarget(0.25);
        if (sim.alpha() < 0.25) sim.alpha(0.25);
      } else if (full) {
        gesture = { type: "pan", id: e.pointerId, last: gesture.start };
        autoFit = false;
        tween = null;
      } else {
        gesture = null;
        return;
      }
      setCursor();
    }
    if (gesture.type === "drag") {
      const wp = toWorld(p.x, p.y);
      gesture.node.fx = wp.x;
      gesture.node.fy = wp.y;
      requestFrame();
    } else if (gesture.type === "pan") {
      cam = { ...cam, tx: cam.tx + p.x - gesture.last.x, ty: cam.ty + p.y - gesture.last.y };
      gesture.last = p;
      requestFrame();
    }
  }

  /** A dropped dot stays where it was put (the subject of a local graph goes home). */
  function release(g: Extract<Gesture, { type: "drag" }>) {
    dragging = null;
    hovered = null;
    sim.alphaTarget(0);
    if (g.node.id === opts.centerId) {
      g.node.fx = 0;
      g.node.fy = 0;
    } else {
      pinned.add(g.node.id);
      opts.onPin?.(g.node.data);
    }
    if (!full) {
      settle();
      requestFrame();
    }
  }

  function onUp(e: PointerEvent) {
    const g = gesture;
    points.delete(e.pointerId);
    if (g?.type === "pinch") {
      if (!points.size) gesture = null;
      return;
    }
    if (!g || ("id" in g && g.id !== e.pointerId)) return;
    gesture = null;
    // A press that never moved past the drag threshold is a tap on what it started on.
    if (g.type === "press" && e.type === "pointerup") tap(g.node);
    if (g.type === "drag") release(g);
    setCursor();
    requestFrame();
  }

  function onLeave() {
    if (hovered && !gesture) {
      hovered = null;
      setCursor();
      requestFrame();
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = local(e);
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0018)));
  }

  function onDblClick(e: MouseEvent) {
    const p = local(e);
    const n = hit(p.x, p.y, false);
    if (n) opts.onOpen?.(n.data);
  }

  function onKey(e: KeyboardEvent) {
    const step = 60;
    if (e.key === "+" || e.key === "=") zoomBy(1.3);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.3);
    else if (e.key === "0") fit();
    else if (e.key === "Escape" && selected) select(null);
    else if (e.key === "Enter" && selected) opts.onOpen?.(byId.get(selected)!.data);
    else if (e.key.startsWith("Arrow")) {
      const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      autoFit = false;
      animateTo({ ...cam, tx: cam.tx + dx, ty: cam.ty + dy });
    } else return;
    e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("dblclick", onDblClick);
  if (full) {
    canvas.tabIndex = 0;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);
  }

  // ---------- public ----------

  function zoomBy(factor: number) {
    autoFit = false;
    const k = clampK(cam.k * factor);
    const c = toWorld(w / 2, (hgt - inset()) / 2);
    animateTo({ k, tx: w / 2 - c.x * k, ty: (hgt - inset()) / 2 - c.y * k });
  }

  function fit() {
    autoFit = true;
    animateTo(fitCamera());
  }

  return {
    el,
    canvas,
    setGraph,
    select,
    selectedId: () => selected,
    neighbours: (id) => [...(adj.get(id) ?? [])].map((x) => byId.get(x)!.data),
    zoomBy,
    fit,
    isPinned: (id) => pinned.has(id),
    unpin(id) {
      const n = byId.get(id);
      pinned.delete(id);
      if (n && id !== opts.centerId) {
        n.fx = null;
        n.fy = null;
        sim.alpha(Math.max(sim.alpha(), 0.2));
        if (reduced || !full) settle();
      }
      requestFrame();
    },
    positions() {
      const out: Positions = new Map();
      for (const n of placed.values()) if (n.x !== undefined) out.set(n.id, { x: n.x, y: n.y!, pinned: pinned.has(n.id) });
      return out;
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      stopScheme();
      sim.stop();
    },
  };
}
