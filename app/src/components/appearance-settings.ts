/**
 * Settings → Appearance (ARCHITECTURE.md, "Appearance and the theme surface"
 * and "Themes"):
 *
 * - Mode: System, Light or Dark, for this device (lib/appearance.ts).
 * - Theme: Athena's own, the built-in themes and the person's own, each a
 *   small preview drawn from its tokens, and "Make your own": colour pickers
 *   for the public colours, sliders for corners, spacing and text size, an
 *   optional chart palette, and a live preview (lib/theme.ts). The same on
 *   every device.
 * - Your font and Text size: this device's own, above any theme.
 *
 * Every choice is a native radio button or input, so arrow keys work and a
 * screen reader hears each group's name. All of it works in sample mode.
 */

import "../styles/appearance.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { appearance, onSchemeChange, scheme as currentScheme, setAppearance, type Appearance } from "../lib/appearance";
import { ATHENA, BUILT_IN, chooseTheme, deleteOwnTheme, onPersonalChange, onThemeChange, personal, saveOwnTheme, setPersonal, themeFor, themeState } from "../lib/theme";
import { SIZE_LIMITS, SYSTEM_FONT } from "../lib/theme-paint";
import { canListFonts, commonFontsHere, fontPermission, listDeviceFonts } from "../lib/fonts";
import athenaChart from "../themes/athena-chart.json";
import { CHART_SERIES, COLOUR_KEYS, LIMITS, NAME_MAX, SCHEMES, closePairs, parseColour, readTheme, toHex, type ColourKey, type Scheme, type Theme, type ThemeChoice } from "../../../lib/theme";

export const APPEARANCE_COPY = {
  heading: "Appearance",
  detail: "Mode, theme, font and text size",
  lede: "How Athena looks.",
  legend: "Mode",
  system: "System",
  systemSub: "Follows this device's setting, and changes when it does",
  light: "Light",
  dark: "Dark",
  hint: "Your other devices keep their own setting.",

  themeLegend: "Theme",
  themeHint: "Your theme is the same on all your devices.",
  yours: "Yours",
  make: "Make your own",
  edit: "Edit",
  delete: "Delete",
  deleted: (name: string) => `Deleted “${name}”`,
  undo: "Undo",

  editorNew: "New theme",
  editorEdit: "Edit theme",
  name: "Name",
  namePlaceholder: "My theme",
  nameMissing: "Give your theme a name.",
  schemesLegend: "Colours for",
  schemesHint: "Leave a mode out and Athena's own colours fill it in.",
  editing: "Edit the colours for",
  colour: {
    page: "Page",
    surface: "Cards",
    sunken: "Fills",
    border: "Lines",
    text: "Text",
    textMuted: "Secondary text",
    accent: "Accent",
    onAccent: "Text on accent",
    focus: "Focus ring",
  } satisfies Record<ColourKey, string>,
  shapeLegend: "Shape and size",
  radius: "Corners",
  radiusEnds: ["Square", "Round"],
  density: "Spacing",
  densityEnds: ["Tight", "Roomy"],
  scale: "Theme text size",
  scaleHint: "Your own Text size setting, further down this page, overrides it on this device.",
  scaleEnds: ["Smaller", "Larger"],
  chartToggle: "Use my own chart colours",
  chartHint: "Charts use five colours, and each has to look different from the others.",
  chartClose: (a: number, b: number) => `Colours ${a} and ${b} are too alike to tell apart on a chart. Change one of them.`,
  chartSeries: (n: number) => `Chart colour ${n}`,
  preview: "Preview",
  previewTitle: "Tuesday",
  previewLine: "Lunch with Sam at one",
  previewTask: "Book the train home",
  previewChip: "Errands",
  previewButton: "Add",
  previewField: "Ask Athena…",
  save: "Save theme",
  cancel: "Cancel",
  saved: (name: string) => `Saved “${name}” and switched to it`,

  fontLegend: "Your font",
  fontHint: "Only this device uses your font, whatever the theme.",
  fontAthena: "Athena's own",
  fontAthenaSub: "Geist",
  fontSystem: "System font",
  fontSystemSub: "This device's interface font",
  fontFilter: "Find a font",
  fontNone: "No font by that name.",
  fontAsk: "Show every font on this device",
  fontSeeCommon: "Athena can only check for common fonts by name, so a font you installed yourself may be missing here.",
  fontSeeCanAsk: "Athena has checked for common fonts by name. To see every font on this device, let your browser share the full list.",
  fontSeeAll: "Showing every font your browser shared with Athena.",
  fontSeeDenied: "Your browser didn't share the full list, so these are the common fonts only.",

  sizeLegend: "Text size",
  sizeHint: "Only this device uses your text size, whatever the theme.",
  sizeReset: "Reset",
  sizeValue: (pct: number) => `${pct}%`,
};

const NAMES: Record<Appearance, string> = { system: APPEARANCE_COPY.system, light: APPEARANCE_COPY.light, dark: APPEARANCE_COPY.dark };

// ---------- Previews, drawn from a theme's tokens ----------

/** A theme's colours for a scheme, with Athena's filling any it leaves out. */
export function schemeColours(theme: Theme | null, scheme: Scheme): Record<ColourKey, string> {
  const base = ATHENA.colours[scheme]!;
  const own = theme?.colours[scheme] ?? {};
  const merged = { ...base, ...own } as Record<ColourKey, string>;
  merged.focus = own.focus ?? merged.accent;
  return merged;
}

/** The custom properties a preview reads (--pv-*), for a theme in a scheme. Values come from the reader, so they're safe. */
export function previewVars(theme: Theme | null, scheme: Scheme): Record<string, string> {
  const c = schemeColours(theme, scheme);
  const vars: Record<string, string> = {
    "--pv-page": c.page,
    "--pv-surface": c.surface,
    "--pv-sunken": c.sunken,
    "--pv-border": c.border,
    "--pv-text": c.text,
    "--pv-muted": c.textMuted,
    "--pv-accent": c.accent,
    "--pv-on-accent": c.onAccent,
  };
  const chart = theme?.chart?.[scheme];
  for (let i = 0; i < CHART_SERIES; i++) vars[`--pv-chart-${i + 1}`] = chart?.[i] ?? `var(--chart-${i + 1})`;
  // Shape and size relative to what the page has now, since the preview sits inside it.
  const now = themeFor(themeState().choice);
  const own = personal();
  vars["--pv-radius"] = String((theme?.shape.radius ?? 1) / Math.max(0.01, now?.shape.radius ?? 1));
  vars["--pv-density"] = String((theme?.shape.density ?? 1) / (now?.shape.density ?? 1));
  vars["--pv-scale"] = own.size ? "1" : String((theme?.text.scale ?? 1) / (now?.text.scale ?? 1));
  return vars;
}

function setVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/** A tile's small picture of a theme: page, card, text, accent, a chip and a tiny chart. */
function tileArt(theme: Theme | null): HTMLElement {
  const art = h(
    "span",
    { class: "theme-art", "aria-hidden": "true" },
    h(
      "span",
      { class: "theme-art__card" },
      h("span", { class: "theme-art__line theme-art__line--strong" }),
      h("span", { class: "theme-art__line" }),
      h("span", { class: "theme-art__row" }, h("span", { class: "theme-art__chip" }), h("span", { class: "theme-art__button" }))
    ),
    h("span", { class: "theme-art__chart" }, ...[1, 2, 3].map((n) => h("span", { class: `theme-art__bar theme-art__bar--${n}` })))
  );
  setVars(art, previewVars(theme, currentScheme()));
  return art;
}

/** The editor's larger preview, with words in it, drawn the same way. */
function bigPreview(): { el: HTMLElement; paint: (theme: Theme | null, scheme: Scheme) => void } {
  const C = APPEARANCE_COPY;
  const el = h(
    "div",
    { class: "theme-preview", role: "img", "aria-label": C.preview },
    h("p", { class: "theme-preview__title" }, C.previewTitle),
    h("p", { class: "theme-preview__muted" }, C.previewLine),
    h(
      "div",
      { class: "theme-preview__card" },
      h("span", { class: "theme-preview__tick" }),
      h("span", { class: "theme-preview__task" }, C.previewTask),
      h("span", { class: "theme-preview__chip" }, C.previewChip)
    ),
    h("div", { class: "theme-preview__ask" }, h("span", { class: "theme-preview__field" }, C.previewField), h("span", { class: "theme-preview__button" }, C.previewButton)),
    h("div", { class: "theme-preview__chart" }, ...[3, 5, 4, 2, 4].map((v, i) => h("span", { class: `theme-preview__bar theme-preview__bar--${i + 1}`, style: `--v: ${v}` })))
  );
  return { el, paint: (theme, scheme) => setVars(el, previewVars(theme, scheme)) };
}

// ---------- The section ----------

export function appearanceSection(): { el: HTMLElement; destroy: () => void } {
  const C = APPEARANCE_COPY;
  const stops: (() => void)[] = [];

  // Mode
  const modeInputs = new Map<Appearance, HTMLInputElement>();
  const modeChoice = (id: Appearance) => {
    const inputId = `appearance-${id}`;
    // Named by its name alone; System's line under it is its description, not part of its name.
    const input = h("input", { class: "appearance-choice__input", type: "radio", name: "appearance", value: id, id: inputId, "aria-labelledby": `${inputId}-name` }) as HTMLInputElement;
    if (id === "system") input.setAttribute("aria-describedby", `${inputId}-sub`);
    modeInputs.set(id, input);
    input.addEventListener("change", () => input.checked && setAppearance(id));
    return h(
      "label",
      { class: "appearance-choice", for: inputId },
      input,
      h("span", { class: "appearance-choice__words" }, h("span", { class: "appearance-choice__name", id: `${inputId}-name` }, NAMES[id]), id === "system" ? h("span", { class: "appearance-choice__sub", id: `${inputId}-sub` }, C.systemSub) : null)
    );
  };
  const mode = h("fieldset", { class: "appearance-choices" }, h("legend", { class: "appearance-choices__legend" }, C.legend), modeChoice("system"), modeChoice("light"), modeChoice("dark"));
  const paintMode = () => modeInputs.forEach((input, id) => (input.checked = id === appearance()));

  // Theme
  const tiles = h("div", { class: "theme-tiles" });
  const editorSlot = h("div", { class: "theme-editor-slot" });
  const themes = h("fieldset", { class: "appearance-choices" }, h("legend", { class: "appearance-choices__legend" }, C.themeLegend), tiles, h("p", { class: "form__hint" }, C.themeHint));
  let editing: { close: () => void } | null = null;

  const tile = (choice: ThemeChoice, theme: Theme | null, name: string, ownId?: string) => {
    const inputId = `theme-${choice.replace(/[^a-z0-9]/g, "-")}`;
    const input = h("input", { class: "theme-tile__input", type: "radio", name: "theme", value: choice, id: inputId }) as HTMLInputElement;
    input.checked = themeState().choice === choice;
    input.addEventListener("change", () => input.checked && chooseTheme(choice));
    const label = h("label", { class: "theme-tile", for: inputId }, input, tileArt(theme), h("span", { class: "theme-tile__name" }, name, ownId ? h("span", { class: "theme-tile__tag" }, C.yours) : null));
    if (!ownId) return h("div", { class: "theme-tile-wrap" }, label);
    const edit = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `${C.edit} ${name}` }, icons.pen(), C.edit);
    const del = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `${C.delete} ${name}` }, icons.trash(), C.delete);
    edit.addEventListener("click", () => openEditor(ownId));
    del.addEventListener("click", () => {
      editing?.close();
      const undo = deleteOwnTheme(ownId);
      showToast(C.deleted(name), { icon: "trash", action: { label: C.undo, run: undo } });
    });
    return h("div", { class: "theme-tile-wrap" }, label, h("div", { class: "theme-tile__actions" }, edit, del));
  };

  const paintTiles = () => {
    const s = themeState();
    const make = h("button", { class: "theme-tile theme-tile--make", type: "button" }, h("span", { class: "theme-art theme-art--make", "aria-hidden": "true" }, icons.plus()), h("span", { class: "theme-tile__name" }, C.make));
    make.addEventListener("click", () => openEditor());
    tiles.replaceChildren(
      tile("athena", null, ATHENA.name),
      ...BUILT_IN.map((b) => tile(`builtin:${b.id}`, b.theme, b.theme.name)),
      ...s.themes.map((t) => tile(`own:${t.id}`, t.theme, t.theme.name, t.id)),
      h("div", { class: "theme-tile-wrap" }, make)
    );
  };

  const openEditor = (id?: string) => {
    editing?.close();
    const ed = themeEditor(id, () => {
      editorSlot.replaceChildren();
      editing = null;
    });
    editing = ed;
    editorSlot.replaceChildren(ed.el);
    ed.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ed.focus();
  };

  // Your font
  const fontSection = fontPicker();
  stops.push(fontSection.destroy);

  // Text size
  const sizeSection = sizeSlider();
  stops.push(sizeSection.destroy);

  paintMode();
  paintTiles();
  stops.push(onSchemeChange(() => (paintMode(), paintTiles())));
  stops.push(onThemeChange(paintTiles));
  stops.push(onPersonalChange(paintTiles));
  // Another tab can change the mode too.
  addEventListener("storage", paintMode);
  stops.push(() => removeEventListener("storage", paintMode));

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--appearance", "aria-labelledby": "settings-appearance" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-appearance" }, icons.contrast(), C.heading)),
      h("p", { class: "settings__lede" }, C.lede),
      h("div", { class: "settings__body" }, mode, h("p", { class: "form__hint" }, C.hint), themes, editorSlot, fontSection.el, sizeSection.el)
    ),
    destroy: () => {
      for (const stop of stops) stop();
      editing?.close();
    },
  };
}

// ---------- Make your own ----------

const hexOf = (c: string) => toHex(parseColour(c)!);
const pct = (n: number) => Math.round(n * 100);

/** The editor for a new theme (from the one in use) or one of the person's own. */
function themeEditor(id: string | undefined, done: () => void): { el: HTMLElement; focus: () => void; close: () => void } {
  const C = APPEARANCE_COPY;
  const s = themeState();
  const existing = id ? s.themes.find((t) => t.id === id)?.theme : undefined;
  const start = existing ?? themeFor(s.choice) ?? ATHENA;
  // Every picker starts with a value: what the theme sets, or Athena's own where it leaves one out.
  const colours: Record<Scheme, Record<ColourKey, string>> = { light: {} as Record<ColourKey, string>, dark: {} as Record<ColourKey, string> };
  for (const sc of SCHEMES) for (const k of COLOUR_KEYS) colours[sc][k] = hexOf(schemeColours(start, sc)[k]);
  const include: Record<Scheme, boolean> = existing ? { light: !!existing.colours.light, dark: !!existing.colours.dark } : { light: true, dark: true };
  const focusSet: Record<Scheme, boolean> = { light: !!start.colours.light?.focus, dark: !!start.colours.dark?.focus };
  const chart: Record<Scheme, string[]> = {
    light: (start.chart?.light ?? athenaChart.light).map(hexOf),
    dark: (start.chart?.dark ?? athenaChart.dark).map(hexOf),
  };
  let useChart = !!start.chart && (!!start.chart.light || !!start.chart.dark);
  let editScheme: Scheme = currentScheme();
  const shape = { radius: start.shape.radius, density: start.shape.density, scale: start.text.scale };

  const uid = `te-${Math.random().toString(36).slice(2, 8)}`;
  const nameInput = h("input", { class: "field", id: `${uid}-name`, type: "text", maxlength: NAME_MAX, placeholder: C.namePlaceholder, autocomplete: "off", value: existing?.name ?? "" }) as HTMLInputElement;
  const nameError = h("p", { class: "form__error", id: `${uid}-name-error`, role: "alert" });

  // Which modes it sets.
  const schemeBox = (sc: Scheme) => {
    const box = h("input", { type: "checkbox", class: "theme-editor__check", id: `${uid}-inc-${sc}` }) as HTMLInputElement;
    box.checked = include[sc];
    box.addEventListener("change", () => {
      include[sc] = box.checked;
      // Keep at least one.
      if (!include.light && !include.dark) {
        include[sc === "light" ? "dark" : "light"] = true;
        paintChecks();
      }
      update();
    });
    return { box, el: h("label", { class: "theme-editor__inline", for: `${uid}-inc-${sc}` }, box, sc === "light" ? C.light : C.dark) };
  };
  const incLight = schemeBox("light");
  const incDark = schemeBox("dark");
  const paintChecks = () => {
    incLight.box.checked = include.light;
    incDark.box.checked = include.dark;
  };

  // Which mode's colours the pickers show.
  const showInputs = new Map<Scheme, HTMLInputElement>();
  const showChoice = (sc: Scheme) => {
    const input = h("input", { type: "radio", name: `${uid}-show`, id: `${uid}-show-${sc}`, class: "theme-editor__seg-input" }) as HTMLInputElement;
    input.checked = sc === editScheme;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      editScheme = sc;
      paintPickers();
      update();
    });
    showInputs.set(sc, input);
    return h("label", { class: "theme-editor__seg", for: `${uid}-show-${sc}` }, input, h("span", {}, sc === "light" ? C.light : C.dark));
  };

  // Colour pickers.
  const pickers = new Map<ColourKey, { input: HTMLInputElement; value: HTMLElement }>();
  const pickerGrid = h(
    "div",
    { class: "theme-editor__colours" },
    ...COLOUR_KEYS.map((k) => {
      const input = h("input", { type: "color", class: "theme-editor__swatch", id: `${uid}-c-${k}` }) as HTMLInputElement;
      const value = h("span", { class: "theme-editor__hex", "aria-hidden": "true" });
      pickers.set(k, { input, value });
      input.addEventListener("input", () => {
        colours[editScheme][k] = input.value;
        if (k === "focus") focusSet[editScheme] = input.value !== colours[editScheme].accent;
        if (k === "accent" && !focusSet[editScheme]) colours[editScheme].focus = input.value;
        value.textContent = input.value;
        if (k === "accent") paintPickers();
        update();
      });
      return h("label", { class: "theme-editor__colour", for: `${uid}-c-${k}` }, input, h("span", { class: "theme-editor__colour-name" }, C.colour[k]), value);
    })
  );
  const paintPickers = () => {
    for (const [k, p] of pickers) {
      p.input.value = colours[editScheme][k];
      p.value.textContent = colours[editScheme][k];
    }
    for (const [i, p] of chartPickers.entries()) p.value = chart[editScheme][i];
    showInputs.forEach((input, sc) => (input.checked = sc === editScheme));
  };

  // Sliders.
  const slider = (key: "radius" | "density" | "scale", label: string, ends: string[], lim: { min: number; max: number }, step: number, hint?: string) => {
    const out = h("output", { class: "theme-editor__value", for: `${uid}-${key}` });
    const hintId = `${uid}-${key}-hint`;
    const input = h("input", { class: "range", type: "range", id: `${uid}-${key}`, min: lim.min, max: lim.max, step, value: shape[key], "aria-describedby": hint ? hintId : undefined }) as HTMLInputElement;
    const show = () => {
      out.textContent = `${pct(shape[key])}%`;
      input.setAttribute("aria-valuetext", `${pct(shape[key])}%`);
    };
    input.addEventListener("input", () => {
      shape[key] = Number(input.value);
      show();
      update();
    });
    show();
    return h(
      "div",
      { class: "theme-editor__slider" },
      h("div", { class: "theme-editor__slider-head" }, h("label", { class: "field-label", for: `${uid}-${key}` }, label), out),
      input,
      h("div", { class: "theme-editor__ends", "aria-hidden": "true" }, h("span", {}, ends[0]), h("span", {}, ends[1])),
      hint ? h("p", { class: "form__hint", id: hintId }, hint) : null
    );
  };

  // Chart colours.
  const chartBox = h("input", { type: "checkbox", class: "theme-editor__check", id: `${uid}-chart` }) as HTMLInputElement;
  chartBox.checked = useChart;
  const chartError = h("p", { class: "form__error", role: "alert" });
  const chartPickers = Array.from({ length: CHART_SERIES }, (_, i) => {
    const input = h("input", { type: "color", class: "theme-editor__swatch", "aria-label": C.chartSeries(i + 1) }) as HTMLInputElement;
    input.addEventListener("input", () => {
      chart[editScheme][i] = input.value;
      update();
    });
    return input;
  });
  const chartRow = h("div", { class: "theme-editor__chart" }, ...chartPickers);
  chartBox.addEventListener("change", () => {
    useChart = chartBox.checked;
    update();
  });

  const preview = bigPreview();
  const save = h("button", { class: "btn btn--primary", type: "submit" }, C.save);
  const cancel = h("button", { class: "btn btn--ghost", type: "button" }, C.cancel);

  /** The theme as it stands, through the reader like any other. */
  const draft = (): Theme | null => {
    const raw = {
      format: "athena-theme",
      version: 1,
      name: nameInput.value || C.namePlaceholder,
      colours: Object.fromEntries(
        SCHEMES.filter((sc) => include[sc]).map((sc) => [sc, Object.fromEntries(COLOUR_KEYS.filter((k) => k !== "focus" || focusSet[sc]).map((k) => [k, colours[sc][k]]))])
      ),
      shape: { radius: shape.radius, density: shape.density },
      text: { scale: shape.scale },
      ...(useChart ? { chart: Object.fromEntries(SCHEMES.filter((sc) => include[sc]).map((sc) => [sc, chart[sc]])) } : {}),
    };
    return readTheme(raw).theme;
  };

  const chartProblem = (): string => {
    if (!useChart) return "";
    for (const sc of SCHEMES) {
      if (!include[sc]) continue;
      const [pair] = closePairs(chart[sc]);
      if (pair) return `${sc === editScheme ? "" : `${sc === "light" ? C.light : C.dark}: `}${C.chartClose(pair[0] + 1, pair[1] + 1)}`;
    }
    return "";
  };

  const update = () => {
    chartRow.hidden = !useChart;
    chartError.textContent = chartProblem();
    const d = draft();
    // A mode left out shows as Athena's own would.
    preview.paint(d, editScheme);
  };

  const form = h(
    "form",
    { class: "theme-editor", "aria-labelledby": `${uid}-title`, novalidate: true },
    h("h3", { class: "theme-editor__title", id: `${uid}-title` }, existing ? C.editorEdit : C.editorNew),
    h("div", { class: "theme-editor__field" }, h("label", { class: "field-label", for: `${uid}-name` }, C.name), nameInput, nameError),
    h("fieldset", { class: "theme-editor__group" }, h("legend", { class: "field-label" }, C.schemesLegend), h("div", { class: "theme-editor__inlines" }, incLight.el, incDark.el), h("p", { class: "form__hint" }, C.schemesHint)),
    h(
      "div",
      { class: "theme-editor__split" },
      h(
        "div",
        { class: "theme-editor__controls" },
        h("fieldset", { class: "theme-editor__group" }, h("legend", { class: "field-label" }, C.editing), h("div", { class: "theme-editor__segs" }, showChoice("light"), showChoice("dark"))),
        pickerGrid,
        h(
          "fieldset",
          { class: "theme-editor__group" },
          h("legend", { class: "field-label" }, C.shapeLegend),
          slider("radius", C.radius, C.radiusEnds, LIMITS.radius, 0.05),
          slider("density", C.density, C.densityEnds, LIMITS.density, 0.05),
          slider("scale", C.scale, C.scaleEnds, LIMITS.scale, 0.05, C.scaleHint)
        ),
        h(
          "div",
          { class: "theme-editor__group" },
          h("label", { class: "theme-editor__inline", for: `${uid}-chart` }, chartBox, C.chartToggle),
          h("p", { class: "form__hint" }, C.chartHint),
          chartRow,
          chartError
        )
      ),
      h("div", { class: "theme-editor__preview" }, h("p", { class: "field-label", "aria-hidden": "true" }, C.preview), preview.el)
    ),
    h("div", { class: "theme-editor__actions" }, save, cancel)
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    nameError.textContent = name ? "" : C.nameMissing;
    nameInput.toggleAttribute("aria-invalid", !name);
    if (!name) {
      nameInput.setAttribute("aria-describedby", nameError.id);
      nameInput.focus();
      return;
    }
    if (chartProblem()) return;
    const theme = draft();
    if (!theme) return;
    saveOwnTheme(theme, id);
    showToast(C.saved(theme.name), { icon: "check" });
    done();
  });
  cancel.addEventListener("click", done);
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  });

  paintPickers();
  update();
  return { el: form, focus: () => nameInput.focus(), close: done };
}

// ---------- Your font ----------

function fontPicker(): { el: HTMLElement; destroy: () => void } {
  const C = APPEARANCE_COPY;
  const list = h("div", { class: "font-list", role: "presentation" });
  const filter = h("input", { class: "field font-picker__filter", type: "search", placeholder: C.fontFilter, "aria-label": C.fontFilter, autocomplete: "off" }) as HTMLInputElement;
  const none = h("p", { class: "form__hint", hidden: true }, C.fontNone);
  const see = h("p", { class: "form__hint", "aria-live": "polite" });
  const ask = h("button", { class: "btn btn--soft btn--sm", type: "button" }, C.fontAsk);
  let fonts = commonFontsHere();
  let state: "common" | "can-ask" | "all" | "denied" = canListFonts() ? "can-ask" : "common";

  const option = (value: string, name: string, sub?: string, family?: string) => {
    const id = `font-${value.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
    const input = h("input", { class: "appearance-choice__input", type: "radio", name: "font", value, id }) as HTMLInputElement;
    input.checked = (personal().font ?? "") === value;
    input.addEventListener("change", () => input.checked && setPersonal({ font: value || undefined }));
    const label = h("span", { class: "font-option__name" }, name);
    if (family) label.style.fontFamily = family;
    return h("label", { class: "font-option", for: id, "data-name": name.toLowerCase() }, input, h("span", { class: "appearance-choice__words" }, label, sub ? h("span", { class: "appearance-choice__sub" }, sub) : null));
  };

  const paint = () => {
    const f = filter.value.trim().toLowerCase();
    const options = [option("", C.fontAthena, C.fontAthenaSub, "var(--theme-font-ui)"), option(SYSTEM_FONT, C.fontSystem, C.fontSystemSub, "system-ui, sans-serif"), ...fonts.map((name) => option(name, name, undefined, `"${name}", system-ui`))];
    const shown = options.filter((o) => !f || (o.dataset.name ?? "").includes(f));
    list.replaceChildren(...shown);
    none.hidden = shown.length > 0;
    filter.hidden = fonts.length < 12;
    see.textContent = { common: C.fontSeeCommon, "can-ask": C.fontSeeCanAsk, all: C.fontSeeAll, denied: C.fontSeeDenied }[state];
    ask.hidden = state !== "can-ask";
  };

  // The full list joins the common fonts already found, never replaces them; an empty answer counts as no answer.
  const take = (all: string[] | null): boolean => {
    if (!all?.length) return false;
    fonts = [...new Set([...fonts, ...all])].sort((a, b) => a.localeCompare(b));
    state = "all";
    return true;
  };
  ask.addEventListener("click", async () => {
    if (!take(await listDeviceFonts())) state = "denied";
    paint();
  });
  filter.addEventListener("input", paint);
  // Already allowed in an earlier visit: list them straight away, no prompt.
  if (state === "can-ask")
    void fontPermission().then(async (p) => {
      if (p === "granted" && take(await listDeviceFonts())) paint();
    });
  // A font chosen on this device but not in the common list still shows, so the choice is visible.
  const current = personal().font;
  if (current && current !== SYSTEM_FONT && !fonts.includes(current)) fonts = [...fonts, current].sort((a, b) => a.localeCompare(b));
  paint();
  const stop = onPersonalChange(() => list.querySelectorAll<HTMLInputElement>('input[name="font"]').forEach((i) => (i.checked = (personal().font ?? "") === i.value)));

  return {
    el: h("fieldset", { class: "appearance-choices font-picker" }, h("legend", { class: "appearance-choices__legend" }, C.fontLegend), filter, list, none, h("p", { class: "form__hint" }, C.fontHint), see, ask),
    destroy: stop,
  };
}

// ---------- Text size ----------

function sizeSlider(): { el: HTMLElement; destroy: () => void } {
  const C = APPEARANCE_COPY;
  const id = "appearance-text-size";
  const out = h("output", { class: "theme-editor__value", for: id });
  const input = h("input", { class: "range", type: "range", id, min: SIZE_LIMITS.min, max: SIZE_LIMITS.max, step: SIZE_LIMITS.step }) as HTMLInputElement;
  const reset = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, C.sizeReset);
  const paint = () => {
    const size = personal().size ?? 1;
    input.value = String(size);
    out.textContent = C.sizeValue(pct(size));
    input.setAttribute("aria-valuetext", C.sizeValue(pct(size)));
    reset.hidden = size === 1;
  };
  input.addEventListener("input", () => setPersonal({ size: Number(input.value) }));
  reset.addEventListener("click", () => setPersonal({ size: undefined }));
  paint();
  const stop = onPersonalChange(paint);
  return {
    el: h(
      "div",
      { class: "appearance-choices text-size" },
      h("div", { class: "theme-editor__slider-head" }, h("label", { class: "appearance-choices__legend", for: id }, C.sizeLegend), out),
      input,
      h("div", { class: "text-size__foot" }, h("p", { class: "form__hint" }, C.sizeHint), reset)
    ),
    destroy: stop,
  };
}
