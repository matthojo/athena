/**
 * Tracking (lib/tracker-types.ts; the words are lib/tracker-words.ts). One
 * calm panel on a saved item, a standalone tracker's page and a reply:
 *
 *  - Each tracker is one block, sentence first ("£34 at Copperkettle. You asked to
 *    hear at £30 or less." / "In stock at Fenn & Hale since Tuesday."), a
 *    quieter line under it, then its picture: a step line for a number, a
 *    timeline of runs for a state. One check is the sentence alone.
 *  - Under the picture: who checked last and the page it was read on; "All
 *    12 checks" opens every check with its link and who made it, each
 *    removable with Undo; "Add a check" keeps one the owner made.
 *  - "Tell me when": at or under, at or over, becomes a state, or whenever it
 *    changes. Set in a tap or two, cleared in one (with Undo), said in the
 *    sentence and drawn on the picture in the second chart colour.
 *
 * Mark spec (dataviz skill): a 2px round line in --chart-1, a hairline at the
 * saved value, the best so far in --chart-2, an 8px end dot with a 2px
 * surface ring, a hairline crosshair; a state's runs as rounded bars, the
 * hoped-for state in --chart-1, others neutral, the one asked for in
 * --chart-2. Text stays in ink tokens. Pointer and arrow keys read each check.
 *
 * Every value is the page's own (valueWords): never rounded or converted. A
 * source's name is someone else's words, so it's set as text, never markup.
 */
import { h, svg as svgMarkup } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { openContextMenu } from "./context-menu";
import { addCheck, clearTarget, listTrackers, onTrackersChange, removeCheck, restoreCheck, setTarget, stopTracking, type TrackerPoint, type TrackerView } from "../db/trackers";
import { agoWords, cantWords, cap, checkerWords, defaultOp, hostOf, labelWords, numberSeries, readTracker, rowDay, sourceOf, stateRuns, targetWords, trackerDetail, trackerGlance, trackerSentence, valueWords, toUnits, whenWords, whoState, whoWords, type TrackerRead, type WhoState } from "../lib/tracker-words";
import type { TrackerTarget } from "../../../lib/tracker-types";
import { listTeam, onTeamChange, updateAssistant, type TeamAssistant } from "../db/team";
import { loadAskWeb } from "../db/api";
import { renderAvatarTile } from "../team/avatar";
import { nextRun } from "../team/setup-voice";
import { webOn, webPatch } from "../team/web-access";
import { ASK_WEB_SETTING } from "../team/web-words";
import { openCheckerSheet } from "./track-sheet";
import "../styles/tracking.css";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const safeHref = (raw: string | null | undefined) => (raw && /^https?:\/\//i.test(raw) ? raw : null);
const time = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
const isPrice = (t: TrackerView) => t.preset === "price";
let uid = 0;

/** Draws at the element's real width, and again when it changes. */
function atWidth(root: HTMLElement, build: (w: number) => void): void {
  let width = 0;
  build(300);
  if (typeof ResizeObserver === "undefined") return;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w > 0 && Math.abs(w - width) > 1) {
      width = w;
      build(w);
    }
  }).observe(root);
}

/** The crosshair, tooltip and arrow keys a picture shares. */
function readable(root: HTMLElement, count: number, say: (i: number) => string) {
  const live = h("span", { class: "visually-hidden", "aria-live": "polite" });
  const tip = h("div", { class: "tk-chart__tip", "aria-hidden": "true" });
  let index = count - 1;
  let show: (i: number) => void = () => undefined;
  const hide = () => root.classList.remove("is-hovering");
  root.addEventListener("focus", () => show(index));
  root.addEventListener("blur", hide);
  root.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
    if (next === null) return;
    e.preventDefault();
    index = Math.max(0, Math.min(count - 1, next));
    show(index);
    live.textContent = say(index);
  });
  return {
    tip,
    live,
    /** Wire one drawing: where each check is, the moving parts, and the hit area. */
    wire(W: number, el: SVGSVGElement, pts: Array<{ x: number; y: number }>, cross: SVGLineElement, dot: SVGCircleElement, hit: SVGRectElement, tipText: (i: number) => Node[]) {
      show = (i: number) => {
        index = i;
        const c = pts[i];
        cross.setAttribute("x1", String(c.x));
        cross.setAttribute("x2", String(c.x));
        dot.setAttribute("cx", String(c.x));
        dot.setAttribute("cy", String(c.y));
        tip.replaceChildren(...tipText(i));
        const tw = tip.offsetWidth;
        const left = Math.min(Math.max(c.x - tw / 2, 0), W - tw);
        tip.style.transform = `translate(${left}px, ${Math.max(c.y - tip.offsetHeight - 12, -tip.offsetHeight - 2)}px)`;
        root.classList.add("is-hovering");
      };
      const nearest = (clientX: number) => {
        const r = el.getBoundingClientRect();
        const at = ((clientX - r.left) / r.width) * W;
        let best = 0;
        pts.forEach((c, i) => {
          if (Math.abs(c.x - at) <= Math.abs(pts[best].x - at)) best = i;
        });
        return best;
      };
      hit.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
      hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
      hit.addEventListener("pointerleave", () => document.activeElement !== root && hide());
    },
  };
}

const tipFor = (r: TrackerRead, p: TrackerPoint): Node[] => {
  const where = sourceOf(p);
  return [h("strong", {}, r.tracker.kind === "state" ? cap(p.value) : valueWords(r.tracker, p.value)), h("span", {}, ` ${where ? `${where} · ` : ""}${rowDay(p.checked_at)}`)];
};
const sayFor = (r: TrackerRead, p: TrackerPoint) => `${rowDay(p.checked_at)}: ${r.tracker.kind === "state" ? p.value : valueWords(r.tracker, p.value)}${sourceOf(p) ? ` at ${sourceOf(p)}` : ""}`;

function axis(r: TrackerRead): HTMLElement {
  const first = rowDay(r.first.checked_at);
  return h("div", { class: "tk-axis", "aria-hidden": "true" }, h("span", {}, first === "Today" ? time(r.first.checked_at) : first), h("span", {}, "Now"));
}

// ---------- a number: the step line ----------

function numberChart(r: TrackerRead, label: string, compact = false): HTMLElement {
  const t = r.tracker;
  const series = numberSeries(r);
  const root = h("div", { class: "tk-chart viz-root", tabindex: "0", role: "group", "aria-label": `${label}. Use the arrow keys to read each check.` });
  const read = readable(root, series.length, (i) => sayFor(r, series[i].point));
  const goalOn = !!t.target && t.target.op !== "change" && t.kind === "number";

  atWidth(root, (W) => {
    const H = compact ? 56 : W >= 640 ? 108 : 80;
    const pad = { top: 18, bottom: goalOn && !compact ? 20 : 10, left: 2, right: 8 };
    const innerW = W - pad.left - pad.right;
    const innerH = H - pad.top - pad.bottom;
    const saved = r.saved ? toUnits(r.saved.value, r.scale) : null;
    const goal = goalOn ? toUnits(t.target!.value, r.scale) : null;
    const values = series.map((p) => p.v);
    const lo = Math.min(...values, ...(goal !== null ? [goal] : []));
    const hi = Math.max(...values, ...(goal !== null ? [goal] : []));
    // A flat history sits in the middle, not on the floor.
    const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
    const yMin = hi === lo ? lo - span / 2 : lo;
    const t0 = series[0].t;
    // The right edge is now: the latest value holds until the next check.
    const t1 = Math.max(Date.now(), series[series.length - 1].t, t0 + 1);
    const tail = 14;
    const x = (v: number) => pad.left + ((v - t0) / (t1 - t0)) * (innerW - tail);
    const y = (v: number) => pad.top + innerH - ((v - yMin) / span) * innerH;
    const pts = series.map((p) => ({ ...p, x: x(p.t), y: y(p.v) }));
    // Step after: a value holds until the next check.
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${pts[i].x.toFixed(1)} V${pts[i].y.toFixed(1)}`;
    d += ` H${(W - pad.right).toFixed(1)}`;

    const el = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    if (saved !== null) {
      const sy = y(saved);
      el.append(svg("line", { class: "tk-chart__ref", x1: pad.left, x2: W - pad.right, y1: sy.toFixed(1), y2: sy.toFixed(1) }));
      // The line starts at the saved value, so its label sits at the start: above, unless it went higher.
      const below = hi > saved;
      const text = svg("text", { class: "tk-chart__reflabel", x: pad.left, y: (below ? sy + 14 : sy - 7).toFixed(1) });
      text.textContent = `Saved at ${valueWords(t, r.saved!.value)}`;
      if (!compact) el.append(text);
    }
    if (goal !== null) {
      const gy = y(goal);
      el.append(svg("line", { class: "tk-chart__goal", x1: pad.left, x2: W - pad.right, y1: gy.toFixed(1), y2: gy.toFixed(1) }));
      // Where the label goes: the first of right-above, right-below, left-below, left-above that the line doesn't
      // cross (and that fits), else right-above.
      const labelW = (`Your ${valueWords(t, t.target!.value)}`.length * 6.6) + 4;
      const segs: Array<[number, number, number, number]> = [];
      for (let i = 0; i < pts.length; i++) {
        const xEnd = i + 1 < pts.length ? pts[i + 1].x : W - pad.right;
        segs.push([pts[i].x, xEnd, pts[i].y, pts[i].y]);
        if (i + 1 < pts.length) segs.push([pts[i + 1].x, pts[i + 1].x, Math.min(pts[i].y, pts[i + 1].y), Math.max(pts[i].y, pts[i + 1].y)]);
      }
      const clear = (x0: number, x1: number, y0: number, y1: number) => y0 >= 2 && y1 <= H && !segs.some(([sx0, sx1, sy0, sy1]) => sx1 >= x0 - 3 && sx0 <= x1 + 3 && sy1 >= y0 - 3 && sy0 <= y1 + 3);
      const right = W - pad.right - 18;
      const spots = [
        { x: right, y: gy - 6, anchor: "end", box: [right - labelW, right, gy - 17, gy - 3] },
        { x: right, y: gy + 14, anchor: "end", box: [right - labelW, right, gy + 3, gy + 17] },
        { x: pad.left + 40, y: gy + 14, anchor: "start", box: [pad.left + 40, pad.left + 40 + labelW, gy + 3, gy + 17] },
        { x: pad.left + 40, y: gy - 6, anchor: "start", box: [pad.left + 40, pad.left + 40 + labelW, gy - 17, gy - 3] },
      ] as const;
      const spot = spots.find((o) => clear(o.box[0], o.box[1], o.box[2], o.box[3])) ?? spots[0];
      const text = svg("text", { class: "tk-chart__goallabel", x: spot.x.toFixed(1), y: spot.y.toFixed(1), "text-anchor": spot.anchor });
      text.textContent = `Your ${valueWords(t, t.target!.value)}`;
      if (!compact) el.append(text);
    }
    el.append(svg("path", { class: "tk-chart__line", d }));
    const last = pts[pts.length - 1];
    // The best so far, where it isn't the end: the second colour, ringed.
    const bestAt = r.best ? pts.findIndex((p) => p.point.id === r.best!.id) : -1;
    if (bestAt >= 0 && bestAt !== pts.length - 1 && pts[bestAt].v !== last.v) el.append(svg("circle", { class: "tk-chart__best", cx: pts[bestAt].x, cy: pts[bestAt].y, r: 4 }));
    el.append(svg("circle", { class: `tk-chart__end${last.best && pts.length > 1 ? " tk-chart__end--best" : ""}${r.target === "reached" && last.point.id === r.now.id ? " tk-chart__end--hit" : ""}`, cx: last.x, cy: last.y, r: 4 }));
    const cross = svg("line", { class: "tk-chart__cross", x1: 0, x2: 0, y1: pad.top - 4, y2: H - pad.bottom + 4 });
    const dot = svg("circle", { class: "tk-chart__cursor", r: 4, cx: 0, cy: 0 });
    const hit = svg("rect", { class: "tk-chart__hit", x: 0, y: 0, width: W, height: H });
    el.append(cross, dot, hit);
    root.replaceChildren(el, read.tip, read.live);
    read.wire(W, el, pts, cross, dot, hit, (i) => tipFor(r, pts[i].point));
  });
  return h("div", { class: "tk-figure" }, root, axis(r));
}

// ---------- a state: the timeline ----------

/** Which colour a state takes: the one asked for in the second colour, the hoped-for one in the first, the rest neutral. */
function stateTone(t: TrackerView, value: string): string {
  const v = value.toLowerCase();
  if (t.target?.op === "eq" && t.target.value.toLowerCase() === v) return "hit";
  const i = t.states.findIndex((s) => s.toLowerCase() === v);
  return i === 0 ? "good" : i === 1 ? "other" : "other2";
}

function stateChart(r: TrackerRead, label: string, compact = false): HTMLElement {
  const t = r.tracker;
  const runs = stateRuns(r);
  const root = h("div", { class: "tk-chart tk-chart--state viz-root", tabindex: "0", role: "group", "aria-label": `${label}. Use the arrow keys to read each check.` });
  const read = readable(root, r.points.length, (i) => sayFor(r, r.points[i]));
  const legend = h("p", { class: "tk-legend", "aria-hidden": "true" });

  atWidth(root, (W) => {
    const labelRow = compact ? 0 : 18;
    const barH = compact ? 8 : 12;
    const H = labelRow + barH + 6;
    const pad = { left: 0, right: 0 };
    const t0 = runs[0].from;
    const t1 = Math.max(Date.now(), runs[runs.length - 1].to);
    const x = (v: number) => pad.left + ((v - t0) / (t1 - t0 || 1)) * (W - pad.left - pad.right);
    const barY = labelRow + 2;
    const el = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
    let skipped = false;
    runs.forEach((run, i) => {
      const x0 = x(run.from);
      const x1 = i + 1 < runs.length ? x(run.to) - 2 : W - pad.right;
      el.append(svg("rect", { class: `tk-run tk-run--${stateTone(t, run.value)}`, x: x0.toFixed(1), y: barY, width: Math.max(2, x1 - x0).toFixed(1), height: barH, rx: Math.min(barH / 2, 6) }));
      if (!compact) {
        // Its name above it, where there's room before the next one.
        const room = (i + 1 < runs.length ? x(runs[i + 1].from) : W) - x0;
        const name = cap(run.value);
        if (room >= name.length * 6.6 + 8) {
          const text = svg("text", { class: `tk-run__label${i === runs.length - 1 ? " tk-run__label--now" : ""}`, x: x0.toFixed(1), y: 12 });
          text.textContent = name;
          el.append(text);
        } else skipped = true;
      }
    });
    // Each check, a small tick on the bar.
    const pts = r.points.map((p) => ({ x: Math.min(W - 3, Math.max(3, x(Date.parse(p.checked_at)))), y: barY + barH / 2 }));
    for (const p of pts) el.append(svg("circle", { class: "tk-run__tick", cx: p.x.toFixed(1), cy: p.y, r: compact ? 1.5 : 2 }));
    const cross = svg("line", { class: "tk-chart__cross", x1: 0, x2: 0, y1: barY - 4, y2: barY + barH + 4 });
    const dot = svg("circle", { class: "tk-chart__cursor tk-chart__cursor--state", r: 4, cx: 0, cy: 0 });
    const hit = svg("rect", { class: "tk-chart__hit", x: 0, y: 0, width: W, height: H });
    el.append(cross, dot, hit);
    root.replaceChildren(el, read.tip, read.live);
    read.wire(W, el, pts, cross, dot, hit, (i) => tipFor(r, r.points[i]));
    // When a name didn't fit on the bar, a key under it says which colour is which.
    const seen = [...new Set(runs.map((run) => run.value.toLowerCase()))];
    legend.replaceChildren(...(skipped || compact ? seen.map((v) => h("span", { class: "tk-legend__item" }, h("span", { class: `tk-legend__swatch tk-run--${stateTone(t, v)}` }), cap(v))) : []));
    legend.hidden = !(skipped || compact) || seen.length < 2;
  });
  return h("div", { class: "tk-figure" }, root, axis(r), legend);
}

// ---------- the list of checks ----------

function checkRow(r: TrackerRead, p: TrackerPoint, onRemove: (p: TrackerPoint) => void): HTMLElement {
  const t = r.tracker;
  const href = safeHref(p.url);
  const where = sourceOf(p);
  const isBest = !!r.best && r.points.length > 1 && toUnits(p.value, r.scale) === toUnits(r.best.value, r.scale) && p.id === r.best.id;
  const shown = t.kind === "state" ? cap(p.value) : valueWords(t, p.value);
  const remove =
    p.checked_by !== "save"
      ? (() => {
          const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tk-row__remove", type: "button", "aria-label": `Remove ${shown}${where ? ` at ${where}` : ""}, ${rowDay(p.checked_at)}` }, icons.close());
          b.addEventListener("click", () => onRemove(p));
          return b;
        })()
      : h("span", { class: "tk-row__keep", title: "Kept from when you saved it" });
  return h(
    "li",
    { class: "tk-row" },
    h("span", { class: "tk-row__when" }, rowDay(p.checked_at), h("span", { class: "tk-row__time" }, time(p.checked_at))),
    h("span", { class: `tk-row__value${t.kind === "state" ? ` tk-row__value--state tk-tone--${stateTone(t, p.value)}` : ""}` }, shown, isBest ? h("span", { class: "tk-row__best" }, t.direction === "lower" ? "Lowest" : "Highest") : null),
    h(
      "span",
      { class: "tk-row__where" },
      href ? h("a", { href, target: "_blank", rel: "noopener noreferrer", title: hostOf(p.url) ?? undefined }, where ?? hostOf(p.url) ?? "Page", icons.external()) : where ? h("span", {}, where) : null,
      h("span", { class: "tk-row__who" }, checkerWords(p))
    ),
    remove
  );
}

// ---------- forms ----------

/** A number input with what's written around it: "£ [34.99]", "[24.86] p/kWh". */
function numberInput(t: Pick<TrackerView, "prefix" | "suffix">, opts: { label: string; placeholder: string; id: string; value?: string }): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { class: "tk-input tk-input--num", id: opts.id, inputmode: "decimal", autocomplete: "off", placeholder: opts.placeholder, "aria-label": opts.label, value: opts.value ?? "" }) as HTMLInputElement;
  const el = h("span", { class: "tk-affixed" }, t.prefix ? h("span", { class: "tk-affixed__text", "aria-hidden": "true" }, t.prefix.trim()) : null, input, t.suffix ? h("span", { class: "tk-affixed__text", "aria-hidden": "true" }, t.suffix.trim()) : null);
  return { el, input };
}

function formButtons(primary: string): { save: HTMLButtonElement; cancel: HTMLButtonElement; row: HTMLElement } {
  const save = h("button", { class: "btn btn--primary btn--sm", type: "submit" }, primary) as HTMLButtonElement;
  const cancel = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Cancel") as HTMLButtonElement;
  return { save, cancel, row: h("div", { class: "tk-form__foot" }, save, cancel) };
}

/** A check the owner made: the value as the page showed it, where, and its link. */
function addForm(t: TrackerView, r: TrackerRead | null, done: () => void): HTMLElement {
  const id = `tk-add-${++uid}`;
  const err = h("p", { class: "tk-form__error", id: `${id}-err`, role: "alert", hidden: true });
  const link = h("input", { class: "tk-input", type: "url", inputmode: "url", autocomplete: "off", placeholder: "Link to the page (optional)", "aria-label": "Link to the page you read it on", "aria-describedby": err.id }) as HTMLInputElement;
  const { save, cancel, row } = formButtons(isPrice(t) ? "Keep price" : "Keep check");
  let value: () => string;
  let first: HTMLElement;
  const fields: HTMLElement[] = [];
  let where: HTMLInputElement | null = null;
  if (t.kind === "number") {
    const n = numberInput(t, { label: isPrice(t) ? "Price" : cap(t.label), placeholder: r?.now.value ?? (isPrice(t) ? "34.99" : "12"), id: `${id}-v` });
    n.input.setAttribute("aria-describedby", err.id);
    where = h("input", { class: "tk-input", autocomplete: "off", placeholder: isPrice(t) ? "Shop" : "Where (optional)", "aria-label": isPrice(t) ? "Shop" : "Where you read it", value: isPrice(t) || !r ? "" : (sourceOf(r.latest) ?? "") }) as HTMLInputElement;
    fields.push(h("div", { class: "tk-form__row" }, n.el, where));
    value = () => n.input.value;
    first = n.input;
  } else {
    let picked = r?.latest.value ?? t.states[0] ?? "";
    const chips = h("div", { class: "chip-row chip-row--wrap choice", role: "radiogroup", "aria-label": cap(t.label) });
    const paint = () => [...chips.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.v === picked)));
    for (const s of t.states) {
      const b = h("button", { class: "chip", type: "button", role: "radio", "data-v": s }, cap(s));
      b.addEventListener("click", () => {
        picked = s;
        paint();
      });
      chips.append(b);
    }
    paint();
    fields.push(chips);
    value = () => picked;
    first = chips.firstElementChild as HTMLElement;
  }
  const form = h("form", { class: "tk-form" }, h("p", { class: "tk-form__label" }, isPrice(t) ? "A price you saw" : `What's the ${t.label} now?`), ...fields, link, err, row);
  cancel.addEventListener("click", done);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    save.setAttribute("aria-busy", "true");
    try {
      await addCheck(t, { value: value(), source: where?.value || (t.kind === "state" && r ? sourceOf(r.latest) : null) || hostOf(link.value), url: link.value });
      showToast(isPrice(t) ? "Price kept" : "Check kept", { icon: "check" });
      done();
    } catch (error) {
      const m = error instanceof Error ? error.message : "";
      link.setAttribute("aria-invalid", String(/^url/.test(m)));
      err.textContent = /^value/.test(m) ? "Type it as the page shows it, like 34.99." : /^url/.test(m) ? "That link doesn't look right. Paste the page's address." : m || "Couldn't keep that check.";
      err.hidden = false;
    } finally {
      save.removeAttribute("aria-busy");
    }
  });
  queueMicrotask(() => first.focus());
  return form;
}

const OP_LABEL: Record<"lte" | "gte" | "change", string> = { lte: "At or under", gte: "At or over", change: "Any change" };

/** "Tell me when it's…": for a state, one tap on the state; for a number, the way and the value. */
function targetForm(r: TrackerRead, done: () => void): HTMLElement {
  const t = r.tracker;
  const id = `tk-goal-${++uid}`;
  const said = (next: TrackerView) => {
    const g = next.target!;
    showToast(g.op === "change" ? "You'll hear when it changes" : t.kind === "state" ? `You'll hear when it's ${g.value}` : `You'll hear at ${targetWords(t, g)}`, { icon: "check" });
  };
  const label = h("p", { class: "tk-form__label", id: `${id}-l` }, "Tell me when it's");
  if (t.kind === "state") {
    const chips = h("div", { class: "chip-row chip-row--wrap tk-goalchips", role: "group", "aria-labelledby": `${id}-l` });
    const pick = async (op: TrackerTarget["op"], value: string) => {
      try {
        said(await setTarget(t, { op, value }));
        done();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't set that", { icon: "wifiOff" });
      }
    };
    for (const s of t.states) {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(t.target?.op === "eq" && t.target.value === s) }, cap(s));
      b.addEventListener("click", () => void pick("eq", s));
      chips.append(b);
    }
    const any = h("button", { class: "chip", type: "button", "aria-pressed": String(t.target?.op === "change") }, "Any change");
    any.addEventListener("click", () => void pick("change", ""));
    chips.append(any);
    const cancel = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Cancel");
    cancel.addEventListener("click", done);
    queueMicrotask(() => (chips.firstElementChild as HTMLElement | null)?.focus());
    return h("div", { class: "tk-form" }, label, chips, h("div", { class: "tk-form__foot" }, cancel));
  }
  let op: "lte" | "gte" | "change" = t.target && t.target.op !== "eq" ? t.target.op : (defaultOp(t.kind, t.direction) as "lte" | "gte" | "change");
  const seg = h("div", { class: "seg tk-seg", role: "radiogroup", "aria-labelledby": `${id}-l` });
  const n = numberInput(t, { label: `${cap(t.label)} to hear at`, placeholder: r.now.value, id: `${id}-v`, value: t.target && t.target.op !== "change" ? t.target.value : "" });
  const err = h("p", { class: "tk-form__error", id: `${id}-err`, role: "alert", hidden: true });
  n.input.setAttribute("aria-describedby", err.id);
  const valueRow = h("div", { class: "tk-form__row tk-form__row--goal" }, n.el);
  const paint = () => {
    [...seg.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.op === op)));
    valueRow.hidden = op === "change";
  };
  for (const o of ["lte", "gte", "change"] as const) {
    const b = h("button", { class: "seg__item", type: "button", role: "radio", "data-op": o }, OP_LABEL[o]);
    b.addEventListener("click", () => {
      op = o;
      paint();
      if (o !== "change") n.input.focus();
    });
    seg.append(b);
  }
  paint();
  const { save, cancel, row } = formButtons("Tell me");
  const form = h("form", { class: "tk-form" }, label, seg, valueRow, err, row);
  cancel.addEventListener("click", done);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    save.setAttribute("aria-busy", "true");
    try {
      said(await setTarget(t, { op, value: n.input.value }));
      done();
    } catch {
      n.input.setAttribute("aria-invalid", "true");
      err.textContent = `Type it as digits, like ${r.now.value}.`;
      err.hidden = false;
    } finally {
      save.removeAttribute("aria-busy");
    }
  });
  queueMicrotask(() => n.input.focus());
  return form;
}

// ---------- who checks it ----------

/** The team and "Let Ask search the web", read once for every block on the page and again when the team changes. */
let teamOnce: Promise<TeamAssistant[]> | null = null;
let askWebOnce: Promise<boolean | null> | null = null;
export const loadCheckers = () =>
  Promise.all([
    (teamOnce ??= listTeam().catch(() => {
      teamOnce = null;
      return [] as TeamAssistant[];
    })),
    (askWebOnce ??= loadAskWeb().catch(() => null)),
  ]);
onTeamChange(() => {
  teamOnce = null;
  askWebOnce = null;
});

function stateFor(view: TrackerView, team: TeamAssistant[], askWeb: boolean | null): { state: WhoState; assistant: TeamAssistant | null } {
  const a = view.assistant_id ? (team.find((x) => x.id === view.assistant_id) ?? null) : null;
  const facts = a ? { id: a.id, name: a.name, web: webOn(a), paused: a.paused, next: nextRun(a.triggers) } : null;
  return { state: whoState(view, facts, askWeb), assistant: a };
}

/**
 * Who checks it, said on every block: "Penny checks this" with her avatar, opening her page, and when (her next
 * scheduled check, else the last); "You check this"; or "Nobody is checking this yet" with Choose. When its
 * checker can't check, one line says why, with the fix a tap away. The page it was read on sits at the end.
 */
function checkerRow(view: TrackerView, r: TrackerRead | null, page: string | null): HTMLElement {
  const el = h("div", { class: "tk-who" });
  // The page it was read on: its name where there's room, the icon alone where there isn't (the sentence names it).
  const where = (r && sourceOf(r.now)) ?? hostOf(page) ?? "the page";
  const pageLink = page ? h("a", { class: "tk-foot__link tk-who__page", href: page, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open ${where}`, title: hostOf(page) ?? undefined }, h("span", { class: "tk-who__pagename" }, where), icons.external()) : null;
  const paint = (team: TeamAssistant[], askWeb: boolean | null) => {
    const { state, assistant } = stateFor(view, team, askWeb);
    const when = whenWords(state, r?.latest ?? null);
    // A byline: the face (or a ring), who on the first line, when under it.
    const sub = h("span", { class: "tk-who__when" }, when ?? "");
    const words = h("span", { class: "tk-who__words" }, h("span", { class: "tk-who__title" }, whoWords(state)), when || state.kind === "nobody" ? sub : null);
    const who =
      state.kind === "assistant" && assistant
        ? h("a", { class: "tk-who__name", href: `#/team/${encodeURIComponent(assistant.id)}`, "aria-label": `${whoWords(state)}${when ? `. ${when}` : ""}. Open ${assistant.name}'s page` }, renderAvatarTile(assistant.avatar, { size: 28, animate: false }), words)
        : h("span", { class: `tk-who__name tk-who__name--${state.kind}` }, h("span", { class: "tk-who__ring", "aria-hidden": "true" }), words);
    if (state.kind === "nobody") {
      // Choose, where the when goes: one tap to the same choices as the sheet.
      const choose = h("button", { class: "tk-who__choose", type: "button", "aria-haspopup": "dialog" }, "Choose who checks it");
      choose.addEventListener("click", () => openCheckerSheet(view));
      sub.replaceChildren(...(when ? [h("span", {}, when)] : []), choose);
      sub.classList.add("tk-who__when--stack");
    }
    const row = h("div", { class: "tk-who__row" }, who);
    if (pageLink) row.append(pageLink);
    const parts: HTMLElement[] = [row];
    const cant = cantWords(state);
    if (cant && assistant) {
      const fix =
        state.kind === "assistant" && state.blocked === "ask-web"
          ? h("a", { class: "btn btn--soft btn--sm tk-cant__fix", href: ASK_WEB_SETTING.href }, cant.fix)
          : h("button", { class: "btn btn--soft btn--sm tk-cant__fix", type: "button" }, cant.fix);
      if (fix instanceof HTMLButtonElement)
        fix.addEventListener("click", async () => {
          const paused = state.kind === "assistant" && state.blocked === "paused";
          fix.setAttribute("aria-busy", "true");
          try {
            await updateAssistant(assistant.id, paused ? { paused: false } : webPatch(true));
            showToast(paused ? `${assistant.name} is back on` : `${assistant.name} can look things up online`, { icon: "check", action: { label: "Undo", run: () => void updateAssistant(assistant.id, paused ? { paused: true } : webPatch(false)) } });
          } catch (error) {
            showToast(error instanceof Error ? error.message : "Couldn't change that", { icon: "wifiOff" });
          } finally {
            fix.removeAttribute("aria-busy");
          }
        });
      parts.push(h("p", { class: "tk-cant", role: "note" }, h("span", { class: "tk-cant__text" }, cant.line), fix));
    }
    el.replaceChildren(...parts);
  };
  // The page link at once; who, as soon as the team is read (already read for a panel: a microtask).
  if (pageLink) el.append(h("div", { class: "tk-who__row" }, pageLink));
  void loadCheckers().then(([team, askWeb]) => paint(team, askWeb));
  return el;
}

// ---------- one tracker ----------

export interface BlockOptions {
  /** Show its label as a small heading: on when several stack, or on a tracker's own page. */
  heading?: boolean;
  /** After it's stopped (the panel leaves it out at once). */
  onStop?: () => void;
}

/** One tracker: its sentence, its picture, who checked, and what you can do with it. */
export function trackerBlock(view: TrackerView, opts: BlockOptions = {}): HTMLElement {
  const r = readTracker(view);
  const block = h("article", { class: `tk-block${r?.target === "reached" ? " is-reached" : ""}`, "aria-label": labelWords(view) });
  // Its label, and a quiet menu: add a check, stop tracking.
  const more = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tk-block__more", type: "button", "aria-label": `More for ${view.label}`, "aria-haspopup": "menu" }, icons.more());
  block.append(h("div", { class: "tk-block__head" }, opts.heading !== false ? h("h3", { class: "tk-block__label" }, labelWords(view)) : h("span", {}), more));
  if (!r) {
    // Started, with nothing read yet.
    block.append(h("p", { class: "tk-sentence" }, view.assistant_id ? "Nothing read yet. Its first check will show here." : "Nothing read yet. Add the first check when you see it."));
  } else {
    const words = trackerSentence(r);
    block.append(h("p", { class: "tk-sentence" }, r.target === "reached" ? h("span", { class: "tk-hit", "aria-hidden": "true" }) : null, h("strong", { class: "tk-lead" }, words.lead), words.rest));
    const detail = trackerDetail(r);
    if (detail) block.append(h("p", { class: "tk-detail" }, detail));
    const name = `${labelWords(view)} at each check, ${view.kind === "state" ? `now ${r.now.value}` : `from ${valueWords(view, r.first.value)} to ${valueWords(view, r.latest.value)}`}${view.target && view.target.op !== "change" ? `, with what you asked for: ${targetWords(view, view.target)}` : ""}`;
    if (r.points.length > 1) block.append(view.kind === "state" ? stateChart(r, name) : numberChart(r, name));
  }

  // Who checks it, when, and the page it was read on (every block says who).
  block.append(checkerRow(view, r, r ? safeHref(r.now.url) : safeHref(view.url)));

  // The bar: every check, and "Tell me when".
  const single = !r || r.points.length === 1;
  const listId = `tk-list-${view.id}`;
  const bar = h("div", { class: `tk-bar${single ? " tk-bar--single" : ""}` });
  const toggle = r && !single ? h("button", { class: "tk-toggle", type: "button", "aria-expanded": "false", "aria-controls": listId }, `All ${r.points.length} checks`, icons.chevronDown()) : null;
  const add = h("button", { class: "tk-toggle", type: "button" }, icons.plus(), isPrice(view) ? "Add a price" : "Add a check");
  const goal = goalControl(view, r, () => openForm((done) => targetForm(r!, done), bar));
  if (single) bar.append(add);
  else if (toggle) bar.append(toggle);
  if (r) bar.append(goal);

  const remove = async (p: TrackerPoint) => {
    await removeCheck(p);
    const shown = view.kind === "state" ? cap(p.value) : valueWords(view, p.value);
    showToast(`Removed ${shown}${sourceOf(p) ? ` at ${sourceOf(p)}` : ""}`, { icon: "trash", action: { label: "Undo", run: () => void restoreCheck(p) } });
  };
  const list = h("ol", { class: "tk-list", id: listId, hidden: true }, ...(r ? [...r.points].reverse().map((p) => checkRow(r, p, (x) => void remove(x))) : []));
  const note = h("p", { class: "tk-note" }, isPrice(view) ? "Each price is the page's own, with its link. Athena never estimates or converts one." : "Athena keeps each check as it was read, with its link when there is one.");
  const listFoot = h("div", { class: "tk-listfoot", hidden: true }, single ? null : add, note);
  toggle?.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = listFoot.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    block.classList.toggle("is-open", open);
  });
  function openForm(make: (done: () => void) => HTMLElement, after: HTMLElement) {
    block.querySelector(".tk-form")?.remove();
    const close = () => {
      form.remove();
      (after.querySelector("button") as HTMLButtonElement | null)?.focus();
    };
    const form = make(close);
    // Esc puts it away, as a sheet does.
    form.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    after.after(form);
  }
  add.addEventListener("click", () => openForm((done) => addForm(view, r, done), single ? bar : listFoot));
  const stop = async () => {
    try {
      const undo = await stopTracking(view);
      opts.onStop?.();
      showToast(`Stopped tracking ${view.saved_id ? view.label : view.name}`, { icon: "trash", timeoutMs: 6500, action: { label: "Undo", run: () => void undo() } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't stop tracking that", { icon: "wifiOff" });
    }
  };
  more.addEventListener("click", (e) =>
    openContextMenu(
      {
        label: labelWords(view),
        groups: [
          [
            { id: "add", label: isPrice(view) ? "Add a price you saw" : "Add a check", icon: "plus", run: () => openForm((done) => addForm(view, r, done), single ? bar : listFoot.hidden ? bar : listFoot) },
            ...(r ? [{ id: "goal", label: view.target ? "Change what you'll hear" : "Tell me when…", icon: "target" as const, run: () => openForm((done) => targetForm(r, done), bar) }] : []),
            { id: "who", label: "Who checks it?", icon: "person" as const, run: () => openCheckerSheet(view) },
          ],
          [{ id: "stop", label: `Stop tracking ${view.label}`, icon: "trash", destructive: true, run: stop }],
        ],
      },
      { anchor: more, by: e.detail === 0 ? "keyboard" : "mouse" }
    )
  );
  if (!r) {
    // Nothing read yet: the first check, and the way out.
    add.replaceChildren(icons.plus(), "Add the first check");
  }
  block.append(bar, list, listFoot);
  return block;
}

/** "Tell me when", or the target as a pill you tap to change, with × to clear in one tap. */
function goalControl(view: TrackerView, r: TrackerRead | null, open: () => void): HTMLElement {
  if (!view.target) {
    const b = h("button", { class: "tk-toggle tk-toggle--end", type: "button" }, icons.target(), "Tell me when");
    b.addEventListener("click", open);
    return b;
  }
  const words = view.target.op === "change" ? "When it changes" : view.kind === "state" ? `When it's ${view.target.value}` : cap(targetWords(view, view.target));
  const pill = h("button", { class: `tk-goal${r?.target === "reached" ? " is-hit" : ""}`, type: "button", "aria-label": `${words}. Change it` }, h("span", { class: "tk-goal__mark", "aria-hidden": "true" }), words);
  pill.addEventListener("click", open);
  const clear = h("button", { class: "tk-goal__clear", type: "button", "aria-label": `Stop telling me: ${words.toLowerCase()}` }, icons.close());
  clear.addEventListener("click", async () => {
    const was = view.target!;
    await clearTarget(view);
    showToast(`Cleared “${words.toLowerCase()}”`, { icon: "check", action: { label: "Undo", run: () => void setTarget(view, was) } });
  });
  return h("span", { class: "tk-goalwrap" }, pill, clear);
}

// ---------- marks ----------

/** A number that moves: a small step line. */
export const trendMark = () => svgMarkup(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.5h3.5v3.25h3.5v-1.5h3v4h2.5"/><circle cx="14.25" cy="10.25" r="0.4" fill="currentColor"/></svg>`);
/** A state: a bar in two runs. */
export const stateMark = () => svgMarkup(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 8h6.5"/><path d="M11 8h3" stroke-width="3.2"/></svg>`);
export const kindMark = (v: Pick<TrackerView, "kind">) => (v.kind === "state" ? stateMark() : trendMark());

// ---------- the panel ----------

export interface PanelOptions {
  /** After a tracker here is stopped. */
  onStop?: () => void;
  /** Opens "Track this" (components/track-sheet.ts); none hides the way to add one. */
  onTrackMore?: (() => void) | null;
  /** The heading ("Tracking"); none on a standalone tracker's own page. */
  title?: string | null;
}

/** Every tracker on one thing, stacked in one sunken panel. Null with none. */
export function trackingPanel(views: TrackerView[], opts: PanelOptions = {}): HTMLElement | null {
  if (!views.length) return null;
  const panel = h("section", { class: "tk", "aria-label": opts.title ?? "Tracking" });
  if (opts.title !== null) {
    const head = h("header", { class: "tk-head" }, h("h2", { class: "tk-title" }, opts.title ?? "Tracking"));
    if (opts.onTrackMore) {
      const more = h("button", { class: "tk-toggle tk-head__more", type: "button" }, icons.plus(), "Track something else");
      more.addEventListener("click", opts.onTrackMore);
      head.append(more);
    }
    panel.append(head);
  }
  for (const v of views) panel.append(trackerBlock(v, { onStop: opts.onStop }));
  return panel;
}

/** One quiet line in the panel's place: "Tracking didn't load" with Try again, or "Not tracked yet" with Track this. */
function quietPanel(icon: SVGElement, text: string, action: { label: string; run: () => void; busy?: boolean }, cls: string): HTMLElement {
  const b = h("button", { class: "btn btn--soft btn--sm tk-quiet__go", type: "button" }, action.label);
  b.addEventListener("click", () => {
    if (action.busy) b.setAttribute("aria-busy", "true");
    action.run();
  });
  return h("section", { class: `tk tk--quiet ${cls}`, "aria-label": "Tracking" }, h("p", { class: "tk-quiet" }, h("span", { class: "tk-quiet__icon", "aria-hidden": "true" }, icon), h("span", { class: "tk-quiet__text" }, text), b));
}

export interface TrackingForOptions {
  onTrackMore?: () => void;
  /** Hears how many there are, after each load (0 shows "Track this" elsewhere, for a link that isn't a product). */
  onCount?: (n: number, views: TrackerView[]) => void;
  /** It looks like a product (a price, a gift idea, a shop's page): with nothing tracked, Tracking keeps its place. */
  productLike?: boolean;
}

/**
 * A saved item's panel: loads its trackers (and who checks them) and redraws when they or the team change. When it
 * can't load, one quiet line with Try again; a product with nothing tracked says so, with Track this.
 */
export function trackingFor(savedId: string, opts: TrackingForOptions = {}): HTMLElement {
  const slot = h("div", { class: "tk-slot", hidden: true });
  let alive = true;
  const show = (el: HTMLElement | null) => {
    slot.replaceChildren(...(el ? [el] : []));
    slot.hidden = !el;
  };
  const paint = (fresh = false) =>
    Promise.all([listTrackers({ saved_id: savedId }, { fresh }), loadCheckers()]).then(
      ([views]) => {
        if (!alive) return;
        const el = trackingPanel(views, { onTrackMore: opts.onTrackMore }) ?? (opts.productLike && opts.onTrackMore ? quietPanel(icons.target(), "Not tracked yet", { label: "Track this", run: opts.onTrackMore }, "tk--none") : null);
        show(el);
        opts.onCount?.(views.length, views);
      },
      () => {
        if (!alive) return;
        show(quietPanel(icons.wifiOff(), "Tracking didn't load", { label: "Try again", run: () => void paint(true), busy: true }, "tk--failed"));
      }
    );
  void paint();
  const off = onTrackersChange(() => alive && void paint());
  const offTeam = onTeamChange(() => alive && void paint());
  untilGone(slot, () => {
    alive = false;
    off();
    offTeam();
  });
  return slot;
}

/** Stop listening once the element has left the page. */
export function untilGone(el: HTMLElement, done: () => void): void {
  let seen = false;
  const watch = new MutationObserver(() => {
    if (el.isConnected) seen = true;
    else if (seen) {
      watch.disconnect();
      done();
    }
  });
  queueMicrotask(() => (seen = el.isConnected));
  watch.observe(document.body, { childList: true, subtree: true });
}

// ---------- in a reply ----------

/** A reply that read a saved item's prices: its name, the value now, the line, and a way in. */
export function trackingReplyCard(savedId: string, opts: { name?: string; open?: () => void }): HTMLElement {
  const slot = h("div", { class: "tk-slot", hidden: true });
  void listTrackers({ saved_id: savedId }).then((views) => {
    const view = views.find((v) => v.preset === "price") ?? views.find((v) => v.kind === "number");
    const r = view ? readTracker(view) : null;
    if (!view || !r) return;
    const words = trackerSentence(r);
    const card = h("section", { class: `tk tk--reply${r.target === "reached" ? " is-reached" : ""}`, "aria-label": `${labelWords(view)} of ${opts.name ?? "a saved item"}` });
    card.append(h("p", { class: "tk-name" }, icons.tag(), h("span", { class: "tk-name__text" }, opts.name ?? view.name), h("strong", { class: "tk-name__value" }, words.lead)));
    if (r.points.length > 1) card.append(numberChart(r, `${labelWords(view)} of ${opts.name ?? view.name} at each check`, true));
    const t = view.target;
    const said = r.target === "reached" && t ? `At or ${t.op === "gte" ? "over" : "under"} your ${valueWords(view, t.value)}` : t && t.op !== "change" ? `You asked for ${targetWords(view, t)}` : r.latest.checked_by === "save" ? words.rest.replace(/^, /, "").replace(/\.$/, "") : `Checked ${agoWords(r.latest.checked_at, new Date(), true)}`;
    const row = h("div", { class: "tk-replyfoot" }, h("span", { class: r.target === "reached" ? "tk-replyfoot__hit" : "" }, said));
    if (opts.open) {
      const more = h("button", { class: "tk-toggle", type: "button", "aria-label": `Open ${opts.name ?? "the saved item"}` }, r.points.length > 1 ? `All ${r.points.length} checks` : "Open", icons.chevronRight());
      more.addEventListener("click", () => opts.open!());
      row.append(more);
    }
    card.append(row);
    slot.replaceChildren(card);
    slot.hidden = false;
  });
  return slot;
}

// ---------- a short row: an assistant's page, Saved's cards ----------

/** One tracker as a row that opens where it lives: its name, label, and a glance at where it stands. */
export function trackerRow(view: TrackerView, open: () => void): HTMLElement {
  const r = readTracker(view);
  const glance = r ? trackerGlance(r) : "Nothing read yet";
  const b = h(
    "button",
    { class: `tk-line${r?.target === "reached" ? " is-reached" : ""}`, type: "button" },
    h("span", { class: `tk-line__mark tk-line__mark--${view.kind}`, "aria-hidden": "true" }, kindMark(view)),
    h("span", { class: "tk-line__text" }, h("span", { class: "tk-line__name" }, view.name || cap(view.label)), h("span", { class: "tk-line__glance" }, h("span", { class: "tk-line__label" }, labelWords(view)), r?.target === "reached" ? h("span", { class: "tk-hit tk-hit--sm", "aria-hidden": "true" }) : null, glance)),
    icons.chevronRight()
  );
  b.addEventListener("click", open);
  return b;
}

/** Where a tracker lives: its saved item, or its own page in Saved. */
export const trackerHref = (v: Pick<TrackerView, "id" | "saved_id">): string => (v.saved_id ? `#/saved/${encodeURIComponent(v.saved_id)}` : `#/saved/tracker-${encodeURIComponent(v.id)}`);
