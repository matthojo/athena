/**
 * Mood for a day: five steps, Rough to Great, set with one tap. The owner
 * picks how a step is drawn (Settings, Days), the same everywhere mood shows:
 *  - moons: a circle filled to its level, a little for Rough, full for Great
 *  - levels: five rising bars, filled up to the step
 *  - faces: a line face from sad to happy, in the app's icon style
 * The word always sits beside it on the day, so the picture never has to
 * carry the meaning alone. A radio group: arrows move, Space or a tap sets,
 * a tap on the chosen step clears it.
 */

import { fetchSettings, isSampleMode, saveMoodStyleSetting } from "../db/api";
import { h } from "../lib/dom";
import { MOODS, moodWord } from "./day-words";
import { settle } from "../lib/finish-motion";
import type { Mood } from "../db/days-app";

// ---------- The style: the same on every device ----------
// The server keeps the choice (GET/PUT /api/settings, mood_style); this
// device keeps a copy so the first paint doesn't wait, and syncMoodStyle()
// brings it in line once the app has loaded.

export type MoodStyle = "moons" | "levels" | "faces";
export const MOOD_STYLES: { id: MoodStyle; name: string }[] = [
  { id: "moons", name: "Moons" },
  { id: "levels", name: "Levels" },
  { id: "faces", name: "Faces" },
];
const KEY = "athena.days.mood-style";
const isStyle = (v: unknown): v is MoodStyle => v === "moons" || v === "levels" || v === "faces";

let current: MoodStyle | null = null;

export function moodStyle(): MoodStyle {
  if (current) return current;
  let saved: unknown = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* private mode: the default */
  }
  return (current = isStyle(saved) ? saved : "moons");
}

/** Change the style, redraw every mood on screen in it, and save it for every device. */
export function setMoodStyle(style: MoodStyle, opts: { save?: boolean } = {}): void {
  if (opts.save !== false && !isSampleMode()) void saveMoodStyleSetting(style).catch(() => undefined);
  applyStyle(style);
}

/** Read the style saved on the server and use it here if it differs. Quietly does nothing offline. */
export async function syncMoodStyle(): Promise<void> {
  if (isSampleMode()) return;
  try {
    const { mood_style } = await fetchSettings();
    if (isStyle(mood_style) && mood_style !== moodStyle()) setMoodStyle(mood_style, { save: false });
  } catch {
    /* offline: this device's copy stands */
  }
}

function applyStyle(style: MoodStyle): void {
  current = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* private mode: this visit only */
  }
  document.querySelectorAll<HTMLElement>(".mood-glyph:not([data-style-fixed])").forEach((g) => draw(g, style));
}

// ---------- Drawing ----------

const NS = "http://www.w3.org/2000/svg";
const sv = (tag: string, attrs: Record<string, string | number>) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** How full the moon is at each step. */
const LEVEL: Record<Mood, number> = { 1: 0.2, 2: 0.38, 3: 0.55, 4: 0.72, 5: 1 };

/** The part of a circle below a line, as a path: the moon's fill. */
function moonFill(level: number): SVGElement {
  const cx = 12;
  const cy = 12;
  const r = 9;
  if (level >= 1) return sv("circle", { class: "mood-glyph__fill", cx, cy, r });
  const y0 = cy + r - 2 * r * level;
  const w = Math.sqrt(Math.max(0, r * r - (y0 - cy) ** 2));
  const f = (n: number) => n.toFixed(2);
  return sv("path", { class: "mood-glyph__fill", d: `M${f(cx - w)},${f(y0)} L${f(cx + w)},${f(y0)} A${r},${r} 0 ${level > 0.5 ? 1 : 0} 1 ${f(cx - w)},${f(y0)} Z` });
}

/** Each face's mouth, sad to happy. */
const MOUTH: Record<Mood, string> = {
  1: "M8.2 17.2Q12 12.2 15.8 17.2",
  2: "M9.2 16Q12 14.9 14.8 16",
  3: "M9 15.2H15",
  4: "M8.8 14.3Q12 17.1 15.2 14.3",
  5: "M8.4 13.6H15.6A3.6 3.6 0 0 1 8.4 13.6Z",
};

function draw(g: HTMLElement, style: MoodStyle): void {
  const m = Number(g.dataset.mood) as Mood | 0;
  g.dataset.style = style;
  if (style === "levels") {
    g.replaceChildren(...[1, 2, 3, 4, 5].map((i) => h("i", { class: "mood-glyph__bar", "data-i": String(i) })));
    return;
  }
  const art = sv("svg", { class: "mood-glyph__art", viewBox: "0 0 24 24", "aria-hidden": "true" });
  if (style === "moons") {
    art.append(sv("circle", { class: "mood-glyph__ring", cx: 12, cy: 12, r: 9 }));
    if (m) art.append(moonFill(LEVEL[m]));
  } else {
    art.append(
      sv("circle", { class: "mood-glyph__ring", cx: 12, cy: 12, r: 9 }),
      sv("circle", { class: "mood-glyph__eye", cx: 9.2, cy: 10, r: 1.1 }),
      sv("circle", { class: "mood-glyph__eye", cx: 14.8, cy: 10, r: 1.1 }),
      sv("path", { class: "mood-glyph__mouth", d: m ? MOUTH[m] : MOUTH[3] })
    );
  }
  g.replaceChildren(art);
}

/**
 * One mood's picture, in the chosen style (or the one given, for Settings'
 * previews). Labelled "Mood: Good" unless the words are said beside it.
 */
export function moodGlyph(mood: Mood | null | undefined, opts: { size?: "sm" | "md"; label?: boolean; style?: MoodStyle } = {}): HTMLElement {
  const g = h("span", { class: `mood-glyph mood-glyph--${opts.size ?? "sm"}${mood ? "" : " mood-glyph--none"}`, "data-mood": mood ? String(mood) : undefined });
  if (opts.style) g.dataset.styleFixed = "";
  draw(g, opts.style ?? moodStyle());
  if (opts.label !== false && mood) {
    g.setAttribute("role", "img");
    g.setAttribute("aria-label", `Mood: ${moodWord(mood)}`);
  } else g.setAttribute("aria-hidden", "true");
  return g;
}

export function moodPicker(opts: { value: Mood | null; onChange: (m: Mood | null) => void; label?: string; compact?: boolean }): { el: HTMLElement; set: (m: Mood | null) => void; focus: () => void } {
  let value = opts.value;
  const group = h("div", { class: `mood-picker${opts.compact ? " mood-picker--compact" : ""}`, role: "radiogroup", "aria-label": opts.label ?? "How was the day?" });
  const buttons = MOODS.map(({ value: v, word }) => {
    const b = h(
      "button",
      { class: "mood-step", type: "button", role: "radio", "data-mood": String(v) },
      moodGlyph(v, { size: "md", label: false }),
      h("span", { class: "mood-step__word" }, word)
    );
    b.addEventListener("click", () => choose(value === v ? null : v));
    b.addEventListener("keydown", (e) => {
      const i = v - 1;
      const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? 4 : null;
      if (next === null) return;
      e.preventDefault();
      const j = Math.max(0, Math.min(4, next));
      buttons[j].focus();
      choose(MOODS[j].value);
    });
    return b;
  });
  group.append(...buttons);

  function paint() {
    buttons.forEach((b, i) => {
      const on = value === MOODS[i].value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on || (value === null && i === 2) ? 0 : -1;
    });
    group.dataset.mood = value ? String(value) : "";
  }

  function choose(m: Mood | null) {
    if (m === value) return;
    delete group.dataset.asked;
    value = m;
    paint();
    // The chosen step settles in, the same small motion as a habit's tick.
    if (m) settle(buttons[m - 1]);
    opts.onChange(m);
  }

  paint();
  return {
    el: group,
    set(m) {
      value = m;
      paint();
    },
    /** Ready for a choice, with a soft ring until one is made: the evening prompt's ?mood. */
    focus() {
      group.dataset.asked = "";
      buttons.find((b) => b.tabIndex === 0)?.focus({ preventScroll: true });
      group.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    },
  };
}
