/**
 * Themes on the page (theme-paint.ts, theme.ts, appearance-boot.ts): the
 * built-in themes, applying and removing a theme, the first-paint script, the
 * page glow, chart palettes, and a person's own font and size winning over
 * any theme.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { BOOT_MARKER, BOOT_SCRIPT } from "./appearance-boot";
import { APPEARANCE_KEY } from "./appearance";
import { ATHENA, BLOCKS, compileTheme, glow, paintCss, personalCss, readPersonal, safeValue, SYSTEM_FONT, type Paint } from "./theme-paint";
import { BUILT_IN, PAINT_KEY, PERSONAL_KEY, REPAINTING, adoptThemeState, applyPaint, applyPersonal, chooseTheme, deleteOwnTheme, isTrying, saveOwnTheme, setPersonal, stopTrying, themeState, tryTheme } from "./theme";
import { ATHENA_THEME_NAMES, readSharedTheme } from "../../../lib/theme-share";
import { SAMPLE_ADDED_THEME } from "../db/sample-themes";
import { COLOUR_KEYS, COLOUR_TOKEN, canonicalColour, closePairs, readTheme, type Theme } from "../../../lib/theme";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
import athenaChart from "../themes/athena-chart.json";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const INDEX = read("../../index.html");
const TOKENS = read("../styles/tokens.css");
const page = () => parseHTML(INDEX.replace(BOOT_MARKER, "")).document;

const theme = (more: Record<string, unknown> = {}): Theme => readTheme({ format: "athena-theme", version: 1, name: "Test", ...more }).theme!;

function boot(stored: Record<string, string>, systemDark = false) {
  const document = page();
  const localStorage = { getItem: (key: string) => stored[key] ?? null };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  new Function("document", "window", "localStorage", BOOT_SCRIPT)(document, window, localStorage);
  return document;
}

const themeColours = (doc: Document) => [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute("data-light"), m.getAttribute("data-dark"), m.getAttribute("content")]);

test("Athena's own theme data matches tokens.css", () => {
  for (const scheme of ["light", "dark"] as const) {
    const block = scheme === "light" ? TOKENS.slice(TOKENS.indexOf(":root {")) : TOKENS.slice(TOKENS.indexOf(':root:where([data-scheme="dark"]) {'));
    for (const key of COLOUR_KEYS.filter((k) => k !== "focus")) {
      const value = new RegExp(`${COLOUR_TOKEN[key]}:\\s*([^;]+);`).exec(block)![1].trim();
      assert.equal(ATHENA.colours[scheme]?.[key], value, `${scheme} ${key}`);
    }
    // The chart pigments the editor starts from are tokens.css's own.
    athenaChart[scheme].forEach((c, i) => assert.ok(block.includes(`--chart-${i + 1}: color-mix(in oklab, ${c} 80%`), `${scheme} chart ${i + 1}`));
  }
});

test("the built-in themes read cleanly and have real character", () => {
  assert.ok(BUILT_IN.length >= 4 && BUILT_IN.length <= 5);
  for (const file of ["clay", "harbour", "contrast", "mist"]) {
    const { theme, problems } = readTheme(read(`../themes/${file}.json`));
    assert.deepEqual(problems, [], file);
    assert.ok(theme?.colours.light && theme.colours.dark, `${file} gives light and dark`);
    assert.ok(theme.summary, `${file} says what it is`);
  }
  // A chart palette in a built-in theme passes the one check a palette has.
  for (const { theme } of BUILT_IN) for (const s of ["light", "dark"] as const) if (theme.chart?.[s]) assert.deepEqual(closePairs(theme.chart[s]!), []);
});

test("Athena's own theme puts nothing on the page", () => {
  assert.equal(paintCss(compileTheme(null)), "");
  const athena = compileTheme(ATHENA);
  // Its colours are tokens.css's own, and the glow keeps Athena's blue and mint.
  for (const block of Object.values(athena.blocks)) for (const k of Object.keys(block!)) assert.doesNotMatch(k, /aurora/);
});

test("a theme's colours are scoped to their scheme, and beat tokens.css by specificity", () => {
  const paint = compileTheme(theme({ colours: { light: { page: "#fafafa", accent: "#aa3300" } }, shape: { radius: 0.5 } }));
  const css = paintCss(paint);
  assert.match(css, /^html:root\{--theme-radius:0\.5;\}/);
  assert.match(css, new RegExp(`html:root\\[data-scheme="light"\\]\\{--theme-page:${esc(canonicalColour("#fafafa")!)};--theme-accent:${esc(canonicalColour("#aa3300")!)};`));
  assert.doesNotMatch(css, /data-scheme="dark"\]\{/, "a theme that gives only light leaves dark to Athena");
  assert.deepEqual(paint.meta, { light: "#fafafa" });
  // (0,2,1) and (0,1,1) beat tokens.css's :root and :root:where(…), both (0,1,0).
  assert.equal(BLOCKS.light, 'html:root[data-scheme="light"]');
  assert.equal(BLOCKS.root, "html:root");
});

test("the page glow: Athena's accent keeps blue and mint, any other accent tints both hazes", () => {
  const same = compileTheme(theme({ colours: { light: { accent: ATHENA.colours.light!.accent, page: "#ffffff" }, dark: { accent: ATHENA.colours.dark!.accent } } }));
  assert.doesNotMatch(paintCss(same), /aurora|accent-tint/);
  const green = compileTheme(theme({ colours: { light: { accent: "oklch(0.6 0.15 150)" } } }));
  const light = green.blocks.light!;
  // The first haze (and the rest of the accent's family) drops Athena's fixed blue pigment and is the accent alone.
  assert.equal(light["--accent-tint"], "0%");
  const tokens = TOKENS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const t of ["--aurora-a", "--aurora-a-morning", "--aurora-a-evening", "--orb-hi", "--orb-mid", "--orb-low"])
    assert.match(tokens, new RegExp(`\\n  ${t}: color-mix\\(in oklab, (?:color-mix\\(in oklab, )?oklch\\([\\d. ]+\\) var\\(--accent-tint, 15%\\), color-mix\\(in oklab, var\\(--theme-accent\\)`), t);
  assert.doesNotMatch(tokens, /oklch\([\d. ]+\) 15%, color-mix\(in oklab, var\(--theme-accent\)/, "every fixed pigment in an accent shade goes through --accent-tint");
  // The second haze, Athena's mint, becomes the accent's hue: no fixed mint.
  assert.equal(light["--aurora-b"], "color-mix(in oklab, color-mix(in oklab, oklch(0.89 0.105 150) 80%, var(--theme-page)) 55%, transparent)");
  assert.equal(green.blocks.dark, undefined, "dark keeps Athena's glow, with Athena's dark accent");
  assert.match(glow("#ff8800", "dark")["--aurora-b"], /16%, transparent\)$/);
});

test("a chart palette replaces Athena's series; a palette with two alike is refused", () => {
  const palette = ["#c0392b", "#27ae60", "#2980b9", "#8e44ad", "#f39c12"];
  const paint = compileTheme(theme({ chart: { dark: palette } }));
  assert.deepEqual(Object.entries(paint.blocks.dark!).map(([k, v]) => `${k}=${v}`), palette.map((c, i) => `--chart-${i + 1}=${canonicalColour(c)}`));
  assert.equal(paint.blocks.light, undefined);
  const alike = readTheme({ format: "athena-theme", version: 1, name: "x", chart: { light: ["#c0392b", "#c1392b", "#2980b9", "#8e44ad", "#f39c12"] } });
  assert.equal(alike.theme?.chart, undefined);
  assert.deepEqual(alike.problems, [{ path: "chart.light", why: "chart-close" }]);
});

test("a theme's colours keep their hue when the app mixes them with transparent", () => {
  // community.css, ask-threads.css and others: color-mix(in oklch, var(--canvas) 92%, transparent). Chrome gives an
  // sRGB colour mixed that way no hue and draws it red, so a theme's colours reach the page as oklch(), never hex.
  const paint = compileTheme(BUILT_IN.find((t) => t.id === "harbour")!.theme);
  for (const block of Object.values(paint.blocks)) for (const [k, v] of Object.entries(block!)) if (/^--(theme|chart)-/.test(k) && !/radius|density|scale/.test(k)) assert.match(v, /^oklch\(/, k);
  assert.match(read("../styles/community.css"), /color-mix\(in oklch, var\(--canvas\) 92%, transparent\)/);
});

test("only safe values reach the stylesheet", () => {
  for (const ok of ["#ffffff", "oklch(0.5 0.1 264)", "color-mix(in oklab, oklch(0.9 0.2 10) 15%, var(--theme-accent)) 60%", "1.15"]) assert.ok(safeValue(ok), ok);
  for (const bad of ["url(x)", "#fff;}body{display:none", "var(--x, url(y))", "var(--kb)", "expression(alert(1))", 'oklch(0.5 0.1 1) "', "image-set(x 1x)", "calc(1px)", "a\\62 c", "x".repeat(401)])
    assert.ok(!safeValue(bad), bad);
  const hostile = { v: 1, blocks: { light: { "--theme-page": "url(https://example.com/x)", "--theme-text": "#000000", color: "red", "--theme-accent;color:red": "#fff" }, "body{": { "--theme-page": "#fff" } }, meta: {} } as unknown as Paint;
  assert.equal(paintCss(hostile), 'html:root[data-scheme="light"]{--theme-text:#000000;}');
});

test("the first-paint script draws the stored theme exactly as the app does, before any stylesheet", () => {
  const paint = compileTheme(BUILT_IN.find((t) => t.id === "clay")!.theme);
  for (const dark of [false, true]) {
    const doc = boot({ [PAINT_KEY]: JSON.stringify(paint) }, dark);
    assert.equal(doc.getElementById("athena-theme")?.textContent, paintCss(paint));
    const scheme = dark ? "dark" : "light";
    assert.deepEqual(themeColours(doc)[0], [paint.meta.light, paint.meta.dark, paint.meta[scheme]], "theme-color is the theme's page, in step with the scheme");
    // The app's own applyPaint agrees.
    const applied = page();
    applyPaint(applied, paint);
    assert.equal(applied.getElementById("athena-theme")?.textContent, doc.getElementById("athena-theme")?.textContent);
    assert.deepEqual(themeColours(applied).map((m) => m.slice(0, 2)), themeColours(doc).map((m) => m.slice(0, 2)));
  }
  // The script sits before the first stylesheet, so the style it adds is there first; specificity, not order, does the rest.
  assert.ok(INDEX.indexOf(BOOT_MARKER) < INDEX.indexOf('rel="stylesheet"'));
});

test("the first-paint script refuses a tampered copy, and survives a broken one", () => {
  const tampered = JSON.stringify({ v: 1, blocks: { light: { "--theme-page": "url(https://example.com/beacon)", "--theme-text": "#111111" }, evil: { "--theme-page": "#fff" } }, meta: { light: "red;x" } });
  const doc = boot({ [PAINT_KEY]: tampered });
  assert.equal(doc.getElementById("athena-theme")?.textContent, 'html:root[data-scheme="light"]{--theme-text:#111111;}');
  assert.equal(themeColours(doc)[0][0], "#f4f6f8");
  for (const broken of ["{", "null", "[]", '{"v":2,"blocks":{"light":{"--theme-text":"#000000"}}}', JSON.stringify({ v: 1, blocks: "x" })]) {
    const d = boot({ [PAINT_KEY]: broken, [APPEARANCE_KEY]: "dark" });
    assert.equal(d.getElementById("athena-theme"), null, broken);
    assert.equal(d.documentElement.getAttribute("data-scheme"), "dark", "the scheme is still set");
  }
  // Nothing stored: as before themes, no style and Athena's theme-color.
  const plain = boot({});
  assert.equal(plain.getElementById("athena-theme"), null);
  assert.deepEqual(themeColours(plain)[0], ["#f4f6f8", "#0c0e13", "#f4f6f8"]);
});

test("applying and removing a theme", () => {
  const doc = page();
  const paint = compileTheme(BUILT_IN.find((t) => t.id === "harbour")!.theme);
  applyPaint(doc, paint);
  assert.ok(doc.getElementById("athena-theme")!.textContent!.includes(`--theme-accent:${canonicalColour("#0b7285")}`));
  assert.equal(themeColours(doc)[0][1], paint.meta.dark);
  applyPaint(doc, compileTheme(null));
  assert.equal(doc.getElementById("athena-theme")!.textContent, "");
  assert.deepEqual(themeColours(doc).map((m) => m.slice(0, 2)), [["#f4f6f8", "#0c0e13"], ["#f4f6f8", "#0c0e13"]], "back to Athena's own");
  assert.equal(doc.querySelectorAll("#athena-theme").length, 1, "one style element, reused");
});

test("a person's own font and size win over any theme", () => {
  // tokens.css reads the person's layer first, then the theme's.
  for (const f of ["ui", "display"]) assert.match(TOKENS, new RegExp(`--font-${f}: var\\(--user-font-${f}, var\\(--theme-font-${f}\\)\\);`));
  assert.match(TOKENS, /--text-body: calc\(1rem \* var\(--user-text-scale, var\(--theme-text-scale\)\)\);/);
  // The wordmark is neither.
  assert.doesNotMatch(/--font-wordmark: ([^;]+);/.exec(TOKENS)![1], /user|theme/);
  const css = personalCss({ font: "Atkinson Hyperlegible", size: 1.25 });
  assert.equal(css, 'html:root{--user-font-ui:"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;--user-font-display:"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;--user-text-scale:1.25;}');
  assert.match(personalCss({ font: SYSTEM_FONT }), /^html:root\{--user-font-ui:system-ui,/);
  // A theme never sets --user-*: even a theme with the largest text leaves the person's size in charge.
  assert.doesNotMatch(paintCss(compileTheme(theme({ text: { scale: 9 } }))), /--user-/);
  // Stored values are checked.
  assert.deepEqual(readPersonal({ font: 'Evil"; } body { x', size: 40 }), { size: 1.5 });
  assert.deepEqual(readPersonal({ font: " Arial", size: 1 }), {});
  assert.deepEqual(readPersonal("x"), {});
  // The first-paint script writes the same, and refuses the same.
  for (const p of [{ font: "Lexend", size: 1.125 }, { font: SYSTEM_FONT }, { size: 0.875 }, { font: "x}y", size: "big" }]) {
    const doc = boot({ [PERSONAL_KEY]: JSON.stringify(p) });
    const applied = page();
    applyPersonal(applied, readPersonal(p));
    assert.equal(doc.getElementById("athena-personal")?.textContent ?? "", applied.getElementById("athena-personal")!.textContent, JSON.stringify(p));
  }
});

test("a new theme lands at once: no slow transition holds the old glow on screen", () => {
  // The glow drifts over six seconds between times of day; a theme change must not wait for it.
  const base = read("../styles/base.css");
  assert.match(base, /\.aurora span \{[^}]*transition: background-color calc\(var\(--dur-drift\) \/ 5\)/);
  assert.match(base, /:root\[data-repainting\] \*,\n:root\[data-repainting\] \*::before,\n:root\[data-repainting\] \*::after \{\n {2}transition: none !important;/);
  // Every way the theme changes turns transitions off while it lands, and back on two frames later.
  const doc = page();
  const frames: (() => void)[] = [];
  Object.assign(doc.defaultView ?? {}, { requestAnimationFrame: (fn: () => void) => frames.push(fn) });
  const stored = new Map<string, string>([["athena.mode", "sample"]]);
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, localStorage: g.localStorage, addEventListener: g.addEventListener };
  g.document = doc;
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) };
  try {
    const check = (what: string, change: () => void) => {
      change();
      assert.equal(doc.documentElement.hasAttribute(REPAINTING), true, `${what}: transitions are off while it lands`);
      while (frames.length) frames.shift()!();
      assert.equal(doc.documentElement.hasAttribute(REPAINTING), false, `${what}: and back on after`);
    };
    check("choosing a built-in theme", () => chooseTheme("builtin:clay"));
    assert.match(doc.getElementById("athena-theme")!.textContent!, /--accent-tint:0%/);
    let id = "";
    check("saving one of your own", () => (id = saveOwnTheme(BUILT_IN.find((t) => t.id === "mist")!.theme)));
    let undo = () => undefined as void;
    check("deleting it", () => (undo = deleteOwnTheme(id)));
    assert.equal(doc.getElementById("athena-theme")!.textContent, "", "back to Athena's own");
    check("Undo", () => undo());
    assert.match(doc.getElementById("athena-theme")!.textContent!, /--accent-tint:0%/);
    check("switching back to Athena", () => chooseTheme("athena"));
    assert.equal(doc.getElementById("athena-theme")!.textContent, "");
    check("your text size", () => setPersonal({ size: 1.25 }));
  } finally {
    Object.assign(g, before);
  }
});

test("the editor names its text size as the theme's, and says your own Text size overrides it", () => {
  const src = read("../components/appearance-settings.ts");
  assert.match(src, /\n  scale: "Theme text size",\n  scaleHint: "Your own Text size setting, further down this page, overrides it on this device.",/);
  assert.match(src, /\n  sizeLegend: "Text size",/, "your own setting keeps the name the hint points to");
  // The hint describes the slider for screen readers.
  assert.match(src, /"aria-describedby": hint \? hintId : undefined/);
  assert.match(src, /slider\("scale", C\.scale, C\.scaleEnds, LIMITS\.scale, 0\.05, C\.scaleHint\)/);
});

test("an added theme never takes the name of Athena's own or a built-in one", () => {
  assert.deepEqual([...ATHENA_THEME_NAMES].sort(), [ATHENA.name, ...BUILT_IN.map((b) => b.theme.name)].sort());
});

test("themes someone else shared: tried on and put back, marked changed once edited, and gone back to Athena's when removed", () => {
  const doc = page();
  Object.assign(doc.defaultView ?? {}, { requestAnimationFrame: (fn: () => void) => fn() });
  const stored = new Map<string, string>([["athena.mode", "sample"]]);
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, localStorage: g.localStorage };
  g.document = doc;
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) };
  try {
    adoptThemeState({ choice: "athena", themes: [SAMPLE_ADDED_THEME] });
    const added = themeState().themes.find((t) => t.id === SAMPLE_ADDED_THEME.id)!;
    assert.equal(added.origin?.version, "1.0");
    // Trying one draws it on the page and keeps nothing: not the choice, not the first-paint copy.
    const paintBefore = stored.get(PAINT_KEY) ?? null;
    tryTheme(readSharedTheme(SAMPLE_ADDED_THEME.theme).theme);
    assert.equal(isTrying(), true);
    assert.match(doc.getElementById("athena-theme")!.textContent!, /--theme-accent/);
    assert.equal(themeState().choice, "athena");
    assert.equal(stored.get(PAINT_KEY) ?? null, paintBefore);
    stopTrying();
    assert.equal(isTrying(), false);
    assert.equal(doc.getElementById("athena-theme")!.textContent, "", "Athena's own again");
    // Saved unchanged from the editor: still following its listing. Changed: theirs from then on.
    saveOwnTheme(added.theme, added.id);
    assert.equal(themeState().themes.find((t) => t.id === added.id)?.origin?.changed, false);
    saveOwnTheme({ ...added.theme, shape: { radius: 0.5, density: 1 } }, added.id);
    const now = themeState().themes.find((t) => t.id === added.id)!;
    assert.equal(now.origin?.changed, true);
    assert.equal(now.origin?.catalogue_id, SAMPLE_ADDED_THEME.origin.catalogue_id);
    assert.equal(themeState().choice, `own:${added.id}`);
    // Removing the theme in use goes back to Athena's own, with Undo.
    const undo = deleteOwnTheme(added.id);
    assert.equal(themeState().choice, "athena");
    undo();
    assert.equal(themeState().choice, `own:${added.id}`);
    assert.equal(themeState().themes.find((t) => t.id === added.id)?.origin?.changed, true, "Undo keeps where it came from");
  } finally {
    Object.assign(g, before);
  }
});
