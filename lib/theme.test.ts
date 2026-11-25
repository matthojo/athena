/**
 * The theme reader (lib/theme.ts): every theme is untrusted, so these feed it
 * hostile and broken input and check that only known keys, safe colours and
 * clamped numbers come out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_SERIES, LIMITS, NAME_MAX, THEME_MAX_BYTES, canonicalColour, closePairs, parseColour, readOwnThemes, readTheme, readThemeChoice, themeJson, toHex } from "./theme";
import { readThemePrefs } from "./theme-prefs";

const base = (more: Record<string, unknown> = {}) => ({ format: "athena-theme", version: 1, name: "Test", ...more });

test("colours: only the safe syntax, written back Athena's way", () => {
  const ok: [string, string][] = [
    ["#ABC", "#aabbcc"],
    ["#1a2B3c", "#1a2b3c"],
    ["  #ffffff ", "#ffffff"],
    ["rgb(255 0 0)", "#ff0000"],
    ["rgb(255, 128, 0)", "#ff8000"],
    ["rgb(100% 0% 50%)", "#ff0080"],
    ["hsl(120 100% 50%)", "#00ff00"],
    ["hsl(0deg, 0%, 100%)", "#ffffff"],
    ["oklch(0.53 0.2 264)", "oklch(0.53 0.2 264)"],
    ["OKLCH(53% 0.2 264deg)", "oklch(0.53 0.2 264)"],
    ["oklch(0.5 0.1 -90)", "oklch(0.5 0.1 270)"],
  ];
  for (const [input, out] of ok) assert.equal(canonicalColour(input), out, input);
  const bad = [
    "red", "transparent", "currentColor", "#abcd", "#12345678", "#ggg", "url(https://example.com/x.png)", "url(x)", "var(--theme-accent)",
    "calc(1px)", "color-mix(in oklab, red, blue)", "rgb(1 2 3 / 0.5)", "rgba(0,0,0,0)", "oklch(0.5 0.1 264 / 50%)", "rgb(1 2)", "rgb(1 2 3 4)",
    "rgb(10% 20 30)", "hsl(1 2 3)", "oklch(0.5 0.1 264) ; color: red", "#fff;background:url(x)", "#fff}html{", "image-set(\"x\" 1x)", "\\23 fff",
    "oklch(/* */0.5 0.1 264)", "rgb(1e999 0 0)", "", " ", "lab(50 20 30)", "attr(data-x)", "env(safe-area-inset-top)", "#".padEnd(80, "f"),
    42, null, undefined, {}, ["#fff"],
  ];
  for (const input of bad) assert.equal(canonicalColour(input), null, String(input));
});

test("colour maths: hex, oklch and distance", () => {
  assert.equal(toHex(parseColour("oklch(0.972 0.004 264)")!), "#f4f6f8", "Athena's light page");
  assert.equal(toHex(parseColour("oklch(0.165 0.01 264)")!), "#0c0e13", "Athena's dark page");
  assert.equal(toHex(parseColour("oklch(1 0.4 0)")!).length, 7, "out of gamut is clipped");
  assert.deepEqual(closePairs(["#ff0000", "#00ff00", "#0000ff"]), []);
  assert.deepEqual(closePairs(["#ff0000", "#fe0101", "#0000ff"]), [[0, 1]]);
});

test("a theme reads, and comes back out as the same JSON", () => {
  const { theme, problems } = readTheme(
    base({
      author: "Sam Example",
      summary: "A test",
      colours: { light: { page: "#fff", accent: "oklch(0.6 0.15 150)" }, dark: { text: "rgb(240 240 240)" } },
      shape: { radius: 1.5, density: 0.9 },
      text: { scale: 1.1 },
      chart: { light: ["#c0392b", "#27ae60", "#2980b9", "#8e44ad", "#f39c12"] },
    })
  );
  assert.deepEqual(problems, []);
  assert.ok(theme);
  assert.equal(theme.colours.light?.page, "#ffffff");
  assert.equal(theme.colours.dark?.text, "#f0f0f0");
  assert.equal(theme.chart?.light?.length, CHART_SERIES);
  const again = readTheme(themeJson(theme));
  assert.deepEqual(again.theme, theme);
  assert.deepEqual(again.problems, []);
});

test("hostile and broken input: unknown keys dropped, numbers clamped, nothing extra through", () => {
  const { theme, problems } = readTheme(
    base({
      name: "  Evil\u0000‮ theme\n ",
      __proto__: { polluted: true },
      constructor: "x",
      css: "body{display:none}",
      font: "Comic Sans MS",
      colours: {
        light: { page: "url(https://example.com/track.png)", accent: "#123456", "--theme-page": "#fff", background: "#000", __proto__: "#fff" },
        dark: "nope",
        sepia: { page: "#fff" },
      },
      shape: { radius: 99, density: -5, extra: 1 },
      text: { scale: "1.2", family: "x" },
      chart: { light: ["#f00", "#0f0"], dark: ["#f00", "#f01", "#00f", "#ff0", "#0ff"], print: [] },
    })
  );
  assert.ok(theme);
  assert.equal(theme.name, "Evil theme");
  assert.deepEqual(theme.colours, { light: { accent: "#123456" } });
  assert.equal(theme.shape.radius, LIMITS.radius.max);
  assert.equal(theme.shape.density, LIMITS.density.min);
  assert.equal(theme.text.scale, 1, "a string isn't a number");
  assert.equal(theme.chart, undefined, "too few in light, two alike in dark");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const keys = Object.keys(theme).sort();
  assert.deepEqual(keys, ["colours", "format", "name", "shape", "text", "version"]);
  const why = (path: string) => problems.find((p) => p.path === path)?.why;
  assert.equal(why("css"), "unknown");
  assert.equal(why("font"), "unknown", "a theme never names a typeface");
  assert.equal(why("colours.light.page"), "not-a-colour");
  assert.equal(why("colours.light.background"), "unknown");
  assert.equal(why("colours.sepia"), "unknown");
  assert.equal(why("shape.radius"), "clamped");
  assert.equal(why("text.scale"), "not-a-number");
  assert.equal(why("chart.light"), "chart-size");
  assert.equal(why("chart.dark"), "chart-close");
  assert.equal(JSON.stringify(theme).includes("url("), false);
});

test("what isn't a theme comes back as null, with the reason", () => {
  assert.equal(readTheme("{not json").error, "not-json");
  assert.equal(readTheme("x".repeat(THEME_MAX_BYTES + 1)).error, "too-big");
  assert.equal(readTheme({ name: "x" }).error, "not-a-theme");
  assert.equal(readTheme([base()]).error, "not-a-theme");
  assert.equal(readTheme(base({ version: 2 })).error, "newer-version");
  assert.equal(readTheme(base({ version: 1.5 })).error, "not-a-theme");
  assert.equal(readTheme(base({ name: " ​ " })).error, "no-name");
  assert.equal(readTheme(base({ name: 7 })).error, "no-name");
  assert.equal(readTheme(base({ name: "x".repeat(200) })).theme?.name.length, NAME_MAX);
  assert.ok(readTheme(JSON.stringify(base())).theme, "JSON text reads too");
  for (const n of [NaN, Infinity, -Infinity]) assert.equal(readTheme(base({ shape: { radius: n } })).theme?.shape.radius, 1);
});

test("the owner's own themes and the choice, as stored", () => {
  const good = { id: "abc123def", theme: base({ name: "Mine" }) };
  const list = readOwnThemes([good, { id: "abc123def", theme: base({ name: "Twin" }) }, { id: "../x", theme: base() }, { id: "zzzzzz", theme: { name: "no format" } }, "junk", null]);
  assert.deepEqual(list.map((t) => t.theme.name), ["Mine"]);
  assert.deepEqual(readOwnThemes("nope"), []);
  assert.equal(readThemeChoice("builtin:clay"), "builtin:clay");
  assert.equal(readThemeChoice("own:abc123def"), "own:abc123def");
  for (const bad of ["builtin:", "own:x", "own:../../", "Athena", 3, null, "builtin:<script>"]) assert.equal(readThemeChoice(bad), "athena", String(bad));
  assert.deepEqual(readThemePrefs({ choice: "own:missing1", themes: [good] }).choice, "athena", "a choice naming a theme that's gone is Athena's own");
  assert.deepEqual(readThemePrefs({ choice: "own:abc123def", themes: [good] }).choice, "own:abc123def");
  assert.deepEqual(readThemePrefs("x"), { choice: "athena", themes: [] });
});
