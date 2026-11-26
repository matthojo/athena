/**
 * The Add screen's theme (lib/theme-share.ts): a small Athena screen drawn from the theme's own tokens, once for each
 * mode it has colours for (both when it has both), side by side on a wide screen and one above the other on a phone.
 * Each holds what a theme changes: the page, a heading and a quiet line, a card with a to-do and a chip, a chart in
 * its five colours, and the Ask bar with a button in its accent. Shape and text size follow it too.
 *
 * The colours come only from what readTheme() kept, set as --pv-* custom properties (appearance-settings.ts
 * previewVars), so nothing the file said reaches the page any other way. A mode it leaves out isn't drawn: a line
 * under the previews says Athena keeps its own there.
 */
import { h } from "../lib/dom";
import { previewVars } from "../components/appearance-settings";
import athenaChart from "../themes/athena-chart.json";
import { CHART_SERIES, type Scheme } from "../../../lib/theme";
import { themeSchemes, type SharedTheme } from "../../../lib/theme-share";
import { SCHEME_WORDS, themeModesWords } from "./words";

const COPY = {
  day: "Tuesday 24 November",
  greeting: "Good evening",
  line: "Two things left today, and dinner at seven.",
  task: "Book the train home",
  chip: "Errands",
  note: "Lunch with Sam moved to one",
  chart: "Sleep this week",
  ask: "Ask Athena…",
  button: "Ask",
  days: ["M", "T", "W", "T", "F"],
} as const;

/** The bars' heights, out of five: a week that reads as a chart at a glance. */
const BARS = [3, 5, 4, 2, 4];

function screen(theme: SharedTheme["theme"], scheme: Scheme): HTMLElement {
  const vars = previewVars(theme, scheme);
  // A mode it has no chart colours for shows Athena's own for that mode, not the page's current ones.
  const own = theme.chart?.[scheme];
  for (let i = 0; i < CHART_SERIES; i++) vars[`--pv-chart-${i + 1}`] = own?.[i] ?? athenaChart[scheme][i];
  const el = h(
    "div",
    { class: "add-theme__screen" },
    h(
      "div",
      { class: "add-theme__head" },
      h("p", { class: "add-theme__eyebrow" }, COPY.day),
      h("p", { class: "add-theme__title" }, COPY.greeting),
      h("p", { class: "add-theme__muted" }, COPY.line)
    ),
    h(
      "div",
      { class: "add-theme__card" },
      h("span", { class: "add-theme__tick" }),
      h("span", { class: "add-theme__task" }, COPY.task),
      h("span", { class: "add-theme__chip" }, COPY.chip),
      h("span", { class: "add-theme__note" }, COPY.note)
    ),
    h(
      "div",
      { class: "add-theme__card add-theme__card--chart" },
      h("span", { class: "add-theme__label" }, COPY.chart),
      h(
        "span",
        { class: "add-theme__chart" },
        ...BARS.map((v, i) => h("span", { class: "add-theme__col" }, h("span", { class: `add-theme__bar add-theme__bar--${i + 1}`, style: `--v: ${v}` }), h("span", { class: "add-theme__day" }, COPY.days[i])))
      )
    ),
    h("div", { class: "add-theme__ask" }, h("span", { class: "add-theme__field" }, COPY.ask), h("span", { class: "add-theme__button" }, COPY.button))
  );
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return el;
}

export function themePreview(shared: SharedTheme): HTMLElement {
  const schemes = themeSchemes(shared.theme);
  // A theme with no colours of its own still changes shape and text size: drawn once, in Athena's light colours.
  const shown: Scheme[] = schemes.length ? schemes : ["light"];
  const note = themeModesWords(schemes);
  return h(
    "div",
    { class: `add-theme add-theme--${shown.length === 2 ? "both" : "one"}` },
    h(
      "div",
      { class: "add-theme__screens" },
      ...shown.map((s) => h("figure", { class: `add-theme__fig add-theme__fig--${s}`, role: "img", "aria-label": `${shared.name}, ${SCHEME_WORDS[s].toLowerCase()} mode` }, h("figcaption", { class: "add-theme__caption", "aria-hidden": "true" }, SCHEME_WORDS[s]), screen(shared.theme, s)))
    ),
    note ? h("p", { class: "form__hint add-theme__modes" }, note) : null
  );
}

/** The hero's tile: a theme's page with a card and its accent, in the mode it has (the app's mode when it has both). */
export function themeHeroTile(shared: SharedTheme, appScheme: Scheme): HTMLElement {
  const schemes = themeSchemes(shared.theme);
  const s: Scheme = schemes.includes(appScheme) ? appScheme : (schemes[0] ?? appScheme);
  const vars = previewVars(shared.theme, s);
  const el = h("span", { class: "add-hero__tile add-hero__tile--theme", "aria-hidden": "true" }, h("span", { class: "add-hero__swatch-card" }, h("span", { class: "add-hero__swatch-line" }), h("span", { class: "add-hero__swatch-accent" })));
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return el;
}
