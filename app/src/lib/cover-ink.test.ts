// Run: npx tsx --test app/src/lib/cover-ink.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, coverTitleSvg, INK, inkFor, madeFill, MIN_TITLE_CONTRAST, parseColour, TITLE_MIN_PX, toHex, wrapTitle } from "./cover-ink";

test("reads hex and oklch, and turns them back into hex", () => {
  assert.equal(toHex(parseColour("#d9a441")!), "#d9a441");
  assert.equal(toHex(parseColour("#fff")!), "#ffffff");
  // tokens.css notes --ink as #15181e.
  const ink = toHex(parseColour(INK.light.ink)!);
  assert.ok(Math.abs(parseInt(ink.slice(1, 3), 16) - 0x15) <= 2, ink);
  assert.ok(parseColour("oklch(62% 0.1 200 / 0.5)"));
  assert.equal(parseColour("red"), null);
  assert.equal(parseColour("url(x)"), null);
});

test("contrast is WCAG's: black on white is 21", () => {
  assert.equal(Math.round(contrast(parseColour("#000")!, parseColour("#fff")!)), 21);
  assert.equal(contrast(parseColour("#777")!, parseColour("#777")!), 1);
});

test("dark covers get light titles and light covers dark ones", () => {
  assert.equal(inkFor("#3d3a32").tone, "light"); // Salt and Iron's field
  assert.equal(inkFor("#e8e1d3").tone, "dark"); // On Making Things Slowly
  assert.equal(inkFor("#d9a441").tone, "dark"); // the gold that hid the title
  assert.equal(inkFor("nonsense").tone === "dark" || inkFor("nonsense").tone === "light", true);
});

test("every fill clears 3:1 in both themes", () => {
  const fills = ["#000000", "#ffffff", "#777777", "#808080", "#d9a441", "#1e4f6b", "#f3c677", "#e86f4f", "#ff7fb0", "#7ec4cf", "#5ec8e0"];
  for (let g = 0; g < 256; g += 5) fills.push(`#${g.toString(16).padStart(2, "0").repeat(3)}`);
  for (let i = 0; i < 40; i++) fills.push(madeFill(`item ${i}`));
  for (const fill of fills) assert.ok(inkFor(fill).ratio >= MIN_TITLE_CONTRAST, `${fill}: ${inkFor(fill).ratio.toFixed(2)}`);
});

test("a made cover's fill is the same for the same title", () => {
  assert.equal(madeFill("Shape Up"), madeFill("Shape Up"));
  assert.match(madeFill("Shape Up"), /^oklch\(/);
});

test("titles wrap by words into a few lines, or give up", () => {
  assert.deepEqual(wrapTitle("The Cartographer's Daughter", 16, 3), ["The", "Cartographer's", "Daughter"]);
  assert.deepEqual(wrapTitle("Salt and Iron", 16, 3), ["Salt and Iron"]);
  assert.equal(wrapTitle("Supercalifragilistic", 8, 3), null);
  assert.equal(wrapTitle("a b c d", 1, 3), null);
});

test("a generated cover's title hides below about 64 px and uses a token colour", () => {
  const poster = coverTitleSvg({ W: 240, H: 360, title: "Salt and Iron", by: "2017", fill: "#3d3a32" });
  assert.match(poster, new RegExp(`max-width:${TITLE_MIN_PX}px`));
  assert.match(poster, new RegExp(toHex(parseColour(INK.light.onInk)!)));
  assert.ok(!poster.includes("#d9a441"), "never the accent tone");
  // A square album cropped to 3:4 shows three quarters of its width, so it hides until that part is 64 px.
  const album = coverTitleSvg({ W: 120, H: 120, title: "Tidal Hours", by: "Mara Vell", fill: "#1e4f6b" });
  assert.match(album, /max-width:86px/);
  assert.match(album, /text-anchor="middle"/);
  assert.equal(coverTitleSvg({ W: 120, H: 120, title: "  ", fill: "#000" }), "");
  assert.ok(!coverTitleSvg({ W: 240, H: 360, title: "<b>&", fill: "#000" }).includes("<b>"));
});
