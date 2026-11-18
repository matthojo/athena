/**
 * Patterns, as the app shows them (lib/patterns.ts): a small visual card per
 * pattern. Its outcome's icon and colour, the size as the big figure
 * ("+40 min"), the plain line, with-against-without on one scale, the days
 * it held as dots, and how sure as a three-step meter. Two sizes: the full
 * card (a row of up to three in the week and month in review) and a compact
 * chip (a day that fits, a Health card, an Ask answer). Every graphic has a
 * text equivalent. Styles in styles/patterns.css.
 */

import "../styles/patterns.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { dayIcons } from "./day-icons";
import { MEANINGFUL, minutesWords, patternFigure, patternLabels, SURE_WORDS, type Outcome, type Pattern } from "../../../lib/patterns";

const OUTCOME_NAME: Record<Outcome, string> = { sleep: "Sleep", deep: "Deep sleep", mood: "Mood", steps: "Steps", resting_hr: "Resting heart rate" };
const OUTCOME_ICON: Record<Outcome, () => SVGSVGElement> = { sleep: icons.bed, deep: icons.bed, mood: dayIcons.sun, steps: dayIcons.steps, resting_hr: icons.heart };

function factorIcon(p: Pattern): SVGSVGElement {
  switch (p.factor_kind) {
    case "workout":
      return p.factor_name === "yoga" || p.factor_name === "pilates" ? icons.leaf() : icons.flag();
    case "any_workout":
    case "long_run":
      return icons.flag();
    case "late_meeting":
      return icons.clock();
    case "busy_calendar":
      return icons.people();
    case "place":
      return icons.pin();
    case "watching":
      return icons.play();
    case "weekend":
      return icons.calendar();
    case "short_sleep":
      return icons.bed();
    case "tag":
      return icons.tag();
    case "habit":
      return icons.check();
    case "eating_out":
      return icons.wallet();
    case "home_evening":
      return icons.home();
    case "caffeine_late":
    case "water":
      return icons.cup();
    case "drinks":
      return icons.wine();
    case "late_meal":
      return icons.clock();
    case "mindful":
      return icons.leaf();
    case "commute":
      return icons.train();
    case "podcasts":
    case "listening":
      return icons.headphones();
  }
}

const thousands = (n: number) => Math.round(n).toLocaleString("en-GB");

/** One side's figure in the outcome's units; mood is the share of Good or Great (or Low or Rough) days. */
function sideValue(p: Pattern, side: "with" | "without"): { value: number; text: string } {
  if (p.outcome === "mood") {
    const share = side === "with" ? p.beat / Math.max(1, p.n_with) : p.beat_without / Math.max(1, p.n_without);
    return { value: share, text: `${Math.round(share * 100)}%` };
  }
  const v = side === "with" ? p.with_avg : p.without_avg;
  const text = p.outcome === "sleep" || p.outcome === "deep" ? minutesWords(v) : p.outcome === "steps" ? thousands(v) : `${Math.round(v)} bpm`;
  return { value: v, text };
}

/**
 * With against without on one shared scale: two rows, a dot each. Mood's
 * shares start at zero; the other figures zoom to the two values with room
 * either side, so a 40 minute gap in a 7 hour night can be seen.
 */
function compare(p: Pattern, compact: boolean): HTMLElement {
  const labels = patternLabels(p);
  const a = sideValue(p, "with");
  const b = sideValue(p, "without");
  let lo: number;
  let hi: number;
  if (p.outcome === "mood") {
    lo = 0;
    hi = 1;
  } else {
    const pad = Math.max(Math.abs(a.value - b.value) * 0.9, MEANINGFUL[p.outcome]);
    lo = Math.min(a.value, b.value) - pad;
    hi = Math.max(a.value, b.value) + pad;
  }
  const at = (v: number) => `${Math.max(2, Math.min(98, ((v - lo) / (hi - lo)) * 100)).toFixed(1)}%`;
  const row = (label: string, side: { value: number; text: string }, mine: boolean) =>
    h(
      "div",
      { class: `pcmp__row${mine ? " is-with" : ""}` },
      h("span", { class: "pcmp__label" }, label),
      h(
        "span",
        { class: `pcmp__track${p.outcome === "mood" ? " pcmp__track--bar" : ""}` },
        p.outcome === "mood" ? h("span", { class: "pcmp__fill", style: `width:${at(side.value)}` }) : h("span", { class: "pcmp__dot", style: `left:${at(side.value)}` })
      ),
      h("span", { class: "pcmp__value" }, side.text)
    );
  const title = p.outcome === "mood" ? (p.diff > 0 ? "Good or Great days" : "Low or Rough days") : null;
  return h(
    "div",
    { class: `pcmp${compact ? " pcmp--compact" : ""}` },
    title && !compact ? h("span", { class: "pcmp__title" }, title) : null,
    row(labels.with, a, true),
    row(labels.without, b, false)
  );
}

/** The days it held, as dots in rows of ten (at most 20; more days are shown in proportion). */
function tally(p: Pattern): HTMLElement {
  const n = p.n_with;
  const slots = Math.min(n, 20);
  const filled = n <= 20 ? p.beat : Math.round((p.beat / n) * 20);
  return h(
    "div",
    { class: "ptally" },
    h("span", { class: "ptally__dots", "aria-hidden": "true" }, ...Array.from({ length: slots }, (_, i) => h("span", { class: `ptally__dot${i < filled ? " is-on" : ""}` }))),
    h("span", { class: "ptally__text", "aria-hidden": "true" }, `${p.beat} of ${n}`)
  );
}

function sureMeter(p: Pattern): HTMLElement {
  return h(
    "span",
    { class: "psure", title: SURE_WORDS[p.sure] },
    h("span", { class: "psure__bars", "aria-hidden": "true" }, ...[1, 2, 3].map((k) => h("span", { class: `psure__bar${k <= p.sure ? " is-on" : ""}` }))),
    h("span", { class: "psure__word" }, SURE_WORDS[p.sure])
  );
}

/** One pattern as a card: "full" for the reviews, "compact" for a day, a Health card or an answer. */
export function patternCard(p: Pattern, opts: { compact?: boolean; label?: string } = {}): HTMLElement {
  const fig = patternFigure(p);
  const labels = patternLabels(p);
  const compact = !!opts.compact;
  const head = h(
    "div",
    { class: "pcard__head" },
    h("span", { class: "pcard__icon", "aria-hidden": "true" }, OUTCOME_ICON[p.outcome]()),
    // Compact cards name the factor ("Weekends"): the figure beside it already says the outcome.
    h("span", { class: "pcard__kind" }, opts.label ?? (compact ? labels.factor : OUTCOME_NAME[p.outcome])),
    h("span", { class: "pcard__factor" }, h("span", { class: "pcard__factor-icon", "aria-hidden": "true" }, factorIcon(p)), labels.factor)
  );
  const hero = h("p", { class: "pcard__hero", "aria-hidden": "true" }, h("span", { class: "pcard__figure" }, fig.figure), h("span", { class: "pcard__unit" }, fig.unit));
  return h(
    "article",
    { class: `pcard pcard--${p.outcome}${compact ? " pcard--compact" : ""}`, "aria-label": p.line },
    head,
    hero,
    h("p", { class: "pcard__line" }, p.line),
    compare(p, compact),
    h("div", { class: "pcard__foot" }, tally(p), sureMeter(p)),
    h("p", { class: "visually-hidden" }, `${p.evidence}. ${SURE_WORDS[p.sure]}.`)
  );
}

/**
 * The block for a week or month in review: up to three cards (side by side
 * on a wide screen, a row to swipe on a phone), those that fit a day in the
 * period first. Null when there are none.
 */
export function patternsBlock(patterns: Pattern[], period: { from: string; to: string; window: number }): HTMLElement | null {
  if (!patterns.length) return null;
  const inPeriod = (p: Pattern) => p.dates.some((d) => d >= period.from && d <= period.to);
  const top = [...patterns].sort((a, b) => Number(inPeriod(b)) - Number(inPeriod(a)) || b.score - a.score).slice(0, 3);
  return h(
    "section",
    { class: "day-sec patterns", "aria-labelledby": "patterns-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "patterns-title" }, "Patterns"), h("span", { class: "day-sec__sub" }, `From your last ${period.window} days`)),
    h("ul", { class: "patterns__row", role: "list" }, ...top.map((p) => h("li", { class: "patterns__item" }, patternCard(p)))),
    h("p", { class: "patterns__note" }, "Things that tend to go together in your days. They don't show what causes what.")
  );
}

/**
 * A compact card, filled in once the patterns arrive: for a day page (the
 * pattern the day fits) or a Health card (the pattern about its figure).
 * Stays hidden when there's nothing to say.
 */
export function patternSlot(patterns: Promise<Pattern[]>, pick: (all: Pattern[]) => Pattern | null | undefined, opts: { label?: string; className?: string } = {}): HTMLElement {
  const el = h("div", { class: `pattern-slot${opts.className ? ` ${opts.className}` : ""}`, hidden: true });
  void patterns.then((all) => {
    const p = pick(all);
    if (!p) return;
    el.replaceChildren(patternCard(p, { compact: true, label: opts.label }));
    el.hidden = false;
  });
  return el;
}
