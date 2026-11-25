/**
 * Shared themes (lib/theme-share.ts): theme.json read through readTheme() and nothing else, hostile input included;
 * the file written as the other kinds write theirs; a theme made into a file with the scrub and the personal-data
 * check; and the rules for adding one among the person's own.
 * Run: npx tsx --test lib/theme-share.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addThemeTo, exportTheme, freeThemeName, readSharedTheme, serialiseSharedTheme, themeFromListing, themeSchemes, themesFollowing, themeSlug, themeSwatches, THEMES_FULL } from "./theme-share";
import { NAME_MAX, OWN_THEMES_MAX, readOwnThemes, readTheme, SUMMARY_MAX, type Theme } from "./theme";
import { reachOf } from "./reach";
import { ShareFormatError } from "./team-share";

const EMBER = {
  format: 1,
  name: "Ember",
  summary: "Warm charcoal and a glowing orange accent.",
  version: "1.0",
  author: "night-owl-studio",
  colours: { dark: { page: "#1b1714", surface: "#241f1b", text: "#f3e9df", accent: "#ff7a3d" } },
  shape: { radius: 1.2, density: 1 },
  text: { scale: 1 },
};

test("a theme.json reads through readTheme(), with its header kept as every shared file's is", () => {
  const s = readSharedTheme(EMBER);
  assert.equal(s.name, "Ember");
  assert.equal(s.version, "1.0");
  assert.equal(s.author, "night-owl-studio");
  assert.equal(s.theme.author, "night-owl-studio");
  assert.deepEqual(s.problems, []);
  assert.deepEqual(readTheme(EMBER).theme?.colours, s.theme.colours, "the same reader, the same result");
  assert.deepEqual(themeSchemes(s.theme), ["dark"]);
  // Written back, it reads the same.
  const again = readSharedTheme(JSON.parse(serialiseSharedTheme(s)));
  assert.deepEqual({ ...again, problems: [] }, { ...s, problems: [] });
  assert.ok(serialiseSharedTheme(s).endsWith("}\n"));
});

test("a hostile theme.json: nothing but colours and numbers gets through, and everything dropped or changed is listed", () => {
  const hostile = {
    format: 1,
    name: "  Totally normal\u0000‮ theme <script>alert(1)</script>",
    summary: "x".repeat(SUMMARY_MAX + 50),
    version: "1.0; rm -rf /",
    author: "<img src=x onerror=alert(1)>",
    based_on: "https://evil.example.com/steal",
    __proto__: { polluted: true },
    constructor: { prototype: { polluted: true } },
    css: "html{background:url(https://tracker.example.com/pixel.png)}",
    font: { family: "Comic Sans MS", src: "url(https://fonts.example.com/x.woff2)" },
    import: "@import url(https://evil.example.com/a.css)",
    script: "fetch('https://evil.example.com')",
    reach: { tier: 1, web: true },
    colours: {
      light: {
        page: "url(https://tracker.example.com/pixel.png)",
        surface: "var(--secret)",
        text: "#000;}body{display:none",
        accent: "expression(alert(1))",
        textMuted: "image-set(\"https://evil.example.com/x.png\" 1x)",
        border: "#e3d7c6",
        onAccent: "rgb(255 255 255)",
        background: "#fff",
      },
      dark: { page: "attr(data-x)", accent: "oklch(0.7 0.2 40)" },
      print: { page: "#fff" },
    },
    shape: { radius: 1e9, density: -100, "--x": 1 },
    text: { scale: 99, family: "Papyrus" },
    chart: { light: ["#f00", "#f00", "#f00", "#f00", "#f00"], dark: ["url(x)", "#0f0", "#00f", "#ff0", "#0ff"] },
  };
  const s = readSharedTheme(JSON.parse(JSON.stringify(hostile)));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // What reaches the page's stylesheet: colours and numbers, nothing else.
  const styled = JSON.stringify({ colours: s.theme.colours, shape: s.theme.shape, text: s.theme.text, chart: s.theme.chart });
  for (const bad of ["url(", "var(", "expression", "image-set", "attr(", "script", "Comic", "Papyrus", "@import", ";", "evil", "tracker"]) assert.equal(styled.includes(bad), false, bad);
  assert.deepEqual(Object.keys(s.theme).sort(), ["colours", "format", "name", "shape", "summary", "text"]);
  // The name is the author's words, kept as plain text (shown as text, never as HTML), one line, within the limit.
  assert.equal(s.theme.name.length <= NAME_MAX, true);
  assert.equal(/[\u0000-\u001f‮]/.test(s.theme.name), false);
  assert.equal(s.summary.length <= SUMMARY_MAX, true);
  assert.deepEqual(Object.keys(s.theme.colours), ["light", "dark"]);
  assert.deepEqual(Object.keys(s.theme.colours.light!).sort(), ["border", "onAccent"]);
  assert.deepEqual(Object.keys(s.theme.colours.dark!), ["accent"]);
  assert.equal(s.theme.shape.radius, 2);
  assert.equal(s.theme.shape.density, 0.8);
  assert.equal(s.theme.text.scale, 1.25);
  assert.equal(s.theme.chart, undefined, "light's colours are all alike; dark has one that isn't a colour");
  assert.equal(s.version, undefined);
  assert.equal(s.author, undefined);
  assert.equal(s.theme.author, undefined);
  assert.equal(s.based_on, undefined, "a based_on is kept only when it's a github.com link or a Community listing");
  const why = (path: string) => s.problems.find((p) => p.path === path)?.why;
  for (const k of ["css", "font", "import", "script", "reach", "constructor", "colours.print", "colours.light.background", "shape.--x", "text.family"]) assert.equal(why(k), "unknown", k);
  for (const k of ["colours.light.page", "colours.light.surface", "colours.light.text", "colours.light.accent", "colours.light.textMuted", "colours.dark.page", "chart.dark.0"]) assert.equal(why(k), "not-a-colour", k);
  assert.equal(why("shape.radius"), "clamped");
  assert.equal(why("text.scale"), "clamped");
  assert.equal(why("chart.light"), "chart-close");
  assert.equal(why("version"), "not-text");
  assert.equal(why("author"), "not-a-handle");
  assert.equal(why("based_on"), "unknown");
  // Its reach is worked out from the file, whatever it claims.
  assert.deepEqual(reachOf({ files: [{ path: "theme.json", text: JSON.stringify(hostile) }] }), { tier: 1, model: false, web: false, lookups: [], needs: [] });
});

test("what isn't a theme is refused in words", () => {
  const refused = (raw: unknown, re: RegExp) => assert.throws(() => readSharedTheme(raw), (e: Error) => e instanceof ShareFormatError && re.test(e.message));
  refused([], /should hold an object/);
  refused("{}", /should hold an object/);
  refused({ format: 1, name: "No colours" }, /needs "format": 1/);
  refused({ ...EMBER, format: 7 }, /newer Athena/);
  refused({ ...EMBER, name: "   " }, /name: missing/);
  refused({ format: 1, name: "x", body: "# A template" }, /needs "format": 1/);
  assert.throws(() => reachOf({ files: [{ path: "theme.json", text: "{not json" }] }), /isn't valid JSON/);
});

test("free names, slugs and swatches", () => {
  assert.equal(freeThemeName("Ember", ["Athena", "Clay"]), "Ember");
  assert.equal(freeThemeName("clay ", ["Athena", "Clay"]), "clay (2)");
  assert.equal(freeThemeName("Clay", ["Clay", "Clay (2)"]), "Clay (3)");
  assert.equal(freeThemeName("x".repeat(NAME_MAX), ["x".repeat(NAME_MAX)]).length, NAME_MAX);
  assert.equal(themeSlug("Café au lait!"), "cafe-au-lait");
  assert.equal(themeSlug("???"), "theme");
  const sw = themeSwatches(readSharedTheme(EMBER).theme);
  assert.deepEqual(Object.keys(sw), ["dark"]);
  assert.equal(sw.dark?.length, 4);
});

test("exportTheme: links into the site and athena:// links come out, the person's terms are flagged, the colours go as read", () => {
  const theme = readTheme({ format: 1, name: "Sam's kitchen", summary: "The colours of https://athena.example.com/days/2026-11-20 and Harbour Street", colours: { light: { accent: "#b0502a" } } }).theme as Theme;
  const x = exportTheme(theme, { ownHosts: ["athena.example.com"], known: [{ term: "Sam", kind: "person", loose: true }, { term: "Harbour Street", kind: "place" }], edits: { author: "@sample-author", version: "1.0" } });
  assert.equal(x.shared.summary.includes("athena.example.com"), false);
  assert.ok(x.removed.length > 0);
  assert.deepEqual(x.findings.map((f) => f.term).sort(), ["Harbour Street", "Sam"]);
  assert.equal(x.shared.author, "sample-author");
  assert.equal(x.shared.version, "1.0");
  assert.equal(x.slug, "sam-s-kitchen");
  assert.deepEqual(x.shared.theme.colours, theme.colours);
  // Marked fine: nothing flagged, and the file is what would download.
  const ok = exportTheme(theme, { ownHosts: [], known: [{ term: "Sam", kind: "person", loose: true }, { term: "Harbour Street", kind: "place" }], fine: x.findings.map((f) => f.id), edits: { name: "Kitchen", summary: "Warm", author: "not a handle!" } });
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.shared.name, "Kitchen");
  assert.equal(ok.shared.author, undefined, "an author that isn't a GitHub username is left out");
  assert.throws(() => exportTheme(theme, { ownHosts: [], known: [], edits: { name: "  " } }), /name/);
  // Never a font or text size of the person's own: the file only ever has what a theme has.
  assert.deepEqual(Object.keys(JSON.parse(serialiseSharedTheme(ok.shared))), ["format", "name", "summary", "colours", "shape", "text"]);
});

test("adding: a free name, the origin recorded, the choice left alone, and the limit at 40", () => {
  const shared = readSharedTheme(EMBER);
  const listing = { id: "0123456789abcdef", hash: `sha256-${"c".repeat(64)}`, version: "1.0" };
  const got = addThemeTo({ choice: "builtin:clay", themes: [] }, shared, listing, { builtIn: ["Ember"], id: () => "abcdef01" });
  assert.equal(got.added.name, "Ember (2)");
  assert.equal(got.list.choice, "builtin:clay");
  assert.deepEqual(got.list.themes[0].origin, { catalogue_id: listing.id, hash: listing.hash, version: "1.0", author: "night-owl-studio", changed: false });
  // As stored and read back, the origin survives the reader; a forged one is cut to what fits.
  const stored = readOwnThemes(JSON.parse(JSON.stringify([...got.list.themes, { id: "abcdef02", theme: EMBER, origin: { catalogue_id: "../../x", hash: "nope", version: 3, author: "<b>", changed: "yes", extra: 1 } }])));
  assert.deepEqual(stored[0].origin, got.list.themes[0].origin);
  assert.deepEqual(stored[1].origin, { catalogue_id: null, hash: null, version: null, author: null, changed: false });
  assert.deepEqual(themeFromListing(got.list, listing.id), { id: "abcdef01", version: "1.0", hash: listing.hash, changed: false });
  assert.deepEqual(themesFollowing(got.list).map((r) => r.kind), ["theme"]);
  assert.throws(() => addThemeTo(got.list, shared, { id: "bad id!", hash: "x" }), /listing/);
  const full = { choice: "athena" as const, themes: Array.from({ length: OWN_THEMES_MAX }, (_, i) => ({ id: `full${String(i).padStart(4, "0")}`, theme: { ...shared.theme, name: `T${i}` } })) };
  assert.throws(() => addThemeTo(full, shared), (e: Error) => e.message === THEMES_FULL);
});
