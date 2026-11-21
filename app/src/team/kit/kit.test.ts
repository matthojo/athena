import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccessoryId, AvatarSpec, Species } from "./types";
import { ACCESSORIES, fitSlots, toggleAccessory } from "./accessories";
import { ACCENT, FUR, INK, OUTFIT, OUTFITS_FOR_FUR, avatarTint, darkFill } from "./palette";
import { LOOKS, NAMES, ROLLED_ACCESSORIES, avatarFromSeed, nameFromSeed, personalityFromSeed, shuffleSpec } from "./procedural";
import { ACCESSORY_IDS, EYES_IDS, MOUTH_IDS, OUTFIT_IDS, SMALL_PX, SPECIES_IDS, avatarInner, avatarMarkup, normalizeSpec, smallStrokeFor, strokeFor } from "./svg";

const seeds = Array.from({ length: 500 }, (_, i) => `seed-${i}`);

const assertClean = (svg: string, what: string) => {
  assert.doesNotMatch(svg, /NaN|undefined|null|Infinity|\{t\}|\[object/, what);
  assert.equal((svg.match(/<g\b/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length, `${what}: balanced groups`);
};

test("the same seed always gives the same character, name and personality", () => {
  for (const s of seeds.slice(0, 50)) {
    assert.deepEqual(avatarFromSeed(s), avatarFromSeed(s));
    assert.equal(nameFromSeed(s), nameFromSeed(s));
    assert.deepEqual(personalityFromSeed(s), personalityFromSeed(s));
    assert.equal(avatarMarkup(avatarFromSeed(s)), avatarMarkup(avatarFromSeed(s)));
  }
  assert.deepEqual(avatarFromSeed("moss"), {
    ...avatarFromSeed("moss"),
    seed: "moss",
    v: 1,
  });
});

test("seeds spread across the kit", () => {
  const specs = seeds.map(avatarFromSeed);
  for (const sp of SPECIES_IDS) assert.ok(specs.some((s) => s.species === sp), `some ${sp}`);
  for (const e of EYES_IDS) assert.ok(specs.some((s) => s.eyes === e), `some ${e} eyes`);
  for (const m of ["small-smile", "cat-w", "buck-teeth", "fang-grin", "smirk", "button-nose", "triangle-nose", "heart-nose"] as const)
    assert.ok(specs.some((s) => s.mouth === m), `some ${m}`);
  for (const o of OUTFIT_IDS) assert.ok(specs.some((s) => s.outfit === o), `some ${o}`);
  for (const a of ROLLED_ACCESSORIES) assert.ok(specs.some((s) => s.accessories.includes(a)), `some ${a}`);
  const bare = specs.filter((s) => s.accessories.length === 0).length / specs.length;
  assert.ok(bare > 0.42 && bare < 0.58, `about half wear nothing (got ${bare})`);
  assert.ok(new Set(seeds.map((s) => nameFromSeed(s))).size > 60, "names vary");
});

test("a generated character wears one accessory at most, never a party hat, crown or eye patch", () => {
  const loud = ["party-hat", "crown", "eye-patch"];
  assert.deepEqual([...ROLLED_ACCESSORIES].sort(), ACCESSORY_IDS.filter((a) => !loud.includes(a)).sort());
  const start = avatarFromSeed("start");
  for (const s of seeds) {
    for (const spec of [avatarFromSeed(s), shuffleSpec(start, new Set(), s)]) {
      assert.ok(spec.accessories.length <= 1, `${s}: ${spec.accessories.join(", ")}`);
      for (const a of spec.accessories) assert.ok(!loud.includes(a), `${s} rolled ${a}`);
    }
  }
  // They stay in the wardrobe: a saved look with two accessories, or a crown, draws as saved.
  const saved = { ...start, accessories: ["crown", "glasses"] as AccessoryId[] };
  const svg = avatarMarkup(saved);
  assert.match(svg, /kit-acc-crown/);
  assert.match(svg, /kit-acc-glasses/);
  const kept = shuffleSpec(saved, new Set(["accessories"]), "next");
  assert.deepEqual(kept.accessories, ["crown", "glasses"], "a locked pair survives Shuffle");
});

test("resting faces are calm: the big laugh, tongue and surprise are never rolled", () => {
  for (const s of seeds) {
    const { mouth } = avatarFromSeed(s);
    assert.ok(!["big-laugh", "tongue-out", "surprised-o", "wavy-frown"].includes(mouth), `${s}: ${mouth}`);
  }
  // The grin belongs to the happy mood: a calm mouth carries a hidden grin, a saved big laugh does not.
  const calm = avatarMarkup({ ...avatarFromSeed("x"), mouth: "small-smile" });
  assert.match(calm, /kit-mouth-calm/);
  assert.match(calm, /class="kit-grin" visibility="hidden"/);
  assert.doesNotMatch(avatarMarkup({ ...avatarFromSeed("x"), mouth: "big-laugh" }), /kit-grin/);
});

test("under 40px the small head drops fine detail and draws a heavier line", () => {
  assert.equal(SMALL_PX, 40);
  const busy: AvatarSpec = { v: 1, seed: "x", species: "cat", fur: "snow", accent: "pink", eyes: "sparkle", mouth: "tongue-out", outfit: "hoodie", outfitColor: "berry", accessories: ["bow", "glasses", "heart-necklace"] };
  const full = avatarInner(busy, 120);
  const small = avatarInner(busy, (28 * 120) / 94, { simple: true });
  assertClean(small, "small head");
  // Whiskers (the cat's 'over' group), the bow and necklace, and the eye highlights all go.
  assert.match(full, /M31,68 C22,64/);
  assert.doesNotMatch(small, /M31,68 C22,64/);
  assert.match(full, /kit-acc-bow/);
  assert.doesNotMatch(small, /kit-acc-bow|kit-acc-heart-necklace/);
  assert.match(small, /kit-acc-glasses/, "glasses are big enough to keep");
  assert.ok((full.match(/fill="#fff"/g) ?? []).length > 0 && !small.includes('fill="#fff"'), "no highlights");
  assert.doesNotMatch(small, /kit-laptop/);
  // Monster spots go too.
  const monster = { ...busy, species: "monster" as Species, accessories: [] };
  assert.ok((avatarInner(monster, 36, { simple: true }).match(/<circle/g) ?? []).length < (avatarInner(monster, 120).match(/<circle/g) ?? []).length);
  // The line: the small head's outline, on screen, is heavier than the full kit's at the same size.
  for (const px of [20, 24, 28, 36]) {
    const canvas = (px * 120) / 94;
    const onScreen = (units: number) => (units * px) / 94;
    assert.ok(onScreen(smallStrokeFor(canvas)) > onScreen(strokeFor(canvas)) * 1.15, `${px}px: heavier line`);
    assert.ok(onScreen(smallStrokeFor(canvas)) >= 1 && onScreen(smallStrokeFor(canvas)) <= 1.6, `${px}px: ${onScreen(smallStrokeFor(canvas)).toFixed(2)}px`);
  }
  for (const s of seeds.slice(0, 100)) assertClean(avatarMarkup(avatarFromSeed(s), { size: 24, simple: true }), `${s} small`);
});

test("seeded characters use curated looks and only known palette keys", () => {
  for (const s of seeds) {
    const a = avatarFromSeed(s);
    assert.ok(LOOKS[a.species].some(([f, ac]) => f === a.fur && ac === a.accent), `${s}: look is curated`);
    assert.ok(OUTFITS_FOR_FUR[a.fur].includes(a.outfitColor), `${s}: outfit colour suits the fur`);
    assert.ok(a.outfitColor in OUTFIT && a.fur in FUR && a.accent in ACCENT);
  }
  for (const fur of Object.keys(FUR)) assert.ok(OUTFITS_FOR_FUR[fur]?.length, `${fur} has outfit colours`);
});

test("never more than one accessory per slot", () => {
  for (const s of seeds) {
    const slots = avatarFromSeed(s).accessories.map((a) => ACCESSORIES[a].slot);
    assert.equal(new Set(slots).size, slots.length, s);
  }
  assert.deepEqual(fitSlots(["beanie", "crown", "glasses", "scarf", "heart-necklace", "nope"]), ["crown", "glasses", "heart-necklace"]);
  let worn: AccessoryId[] = [];
  worn = toggleAccessory(worn, "beanie");
  worn = toggleAccessory(worn, "glasses");
  worn = toggleAccessory(worn, "party-hat");
  assert.deepEqual(worn, ["party-hat", "glasses"], "a second hat swaps the first out");
  worn = toggleAccessory(worn, "glasses");
  assert.deepEqual(worn, ["party-hat"], "tapping a worn one takes it off");
  assert.deepEqual(normalizeSpec({ accessories: ["bow", "flowers", "eye-patch"] as AccessoryId[] }).accessories, ["flowers", "eye-patch"]);
});

test("every species renders every part and accessory without NaN", () => {
  for (const species of SPECIES_IDS) {
    const [fur, accent] = LOOKS[species][0];
    const base: AvatarSpec = { v: 1, seed: "x", species, fur, accent, eyes: "round", mouth: "small-smile", outfit: "tee", outfitColor: "cobalt", accessories: [] };
    for (const a of ACCESSORY_IDS) assertClean(avatarMarkup({ ...base, accessories: [a] }), `${species} + ${a}`);
    for (const e of EYES_IDS) assertClean(avatarMarkup({ ...base, eyes: e }), `${species} ${e} eyes`);
    for (const m of MOUTH_IDS) assertClean(avatarMarkup({ ...base, mouth: m }), `${species} ${m}`);
    for (const o of OUTFIT_IDS) assertClean(avatarMarkup({ ...base, outfit: o }), `${species} ${o}`);
    for (const size of [16, 24, 48, 160, 400, 0, NaN]) assertClean(avatarMarkup(base, { size }), `${species} at ${size}px`);
    assertClean(avatarMarkup({ ...base, accessories: ["crown", "glasses", "scarf"] }), `${species} fully dressed`);
  }
  for (const s of seeds) assertClean(avatarMarkup(avatarFromSeed(s)), s);
});

test("bad or partial specs still draw", () => {
  assertClean(avatarMarkup({}), "empty");
  assertClean(avatarMarkup({ species: "dragon" as Species, fur: "<script>", outfitColor: "#123456" }), "junk");
  assert.doesNotMatch(avatarMarkup({ fur: '"><script>' }), /<script>/);
  assert.match(avatarMarkup({ outfitColor: "#123456" }), /#123456/, "raw hex colours pass through");
});

test("shuffle keeps locked parts and re-rolls the rest", () => {
  const start = avatarFromSeed("start");
  const all = new Set(["species", "fur", "eyes", "mouth", "outfit", "outfitColor", "accessories"] as const);
  const kept = shuffleSpec(start, all, "next");
  assert.deepEqual({ ...kept, seed: start.seed }, start);
  const none = seeds.slice(0, 40).map((s) => shuffleSpec(start, new Set(), s));
  assert.ok(none.some((s) => s.species !== start.species));
  for (let i = 0; i < 40; i++) {
    const s = shuffleSpec(start, new Set(["species"]), `n${i}`);
    assert.equal(s.species, start.species);
    assert.ok(LOOKS[s.species].some(([f, a]) => f === s.fur && a === s.accent), "fur stays harmonious for a locked species");
  }
});

test("names are short, friendly and unique", () => {
  assert.ok(NAMES.length >= 75);
  assert.equal(new Set(NAMES).size, NAMES.length);
  for (const n of NAMES) assert.match(n, /^[A-Z][a-z]{1,8}$/);
  assert.ok(!NAMES.includes("Athena" as never) && !NAMES.includes("Ask" as never));
  // Not an AI model's name either: Meta's Muse is offered in Settings → AI models, so an assistant called Muse would read as the model.
  assert.ok(!NAMES.includes("Muse" as never));
});

test("personality: a tone, two different traits, a pronoun and a greeting", () => {
  const tones = new Set<string>(), pronouns = new Set<string>();
  for (const s of seeds) {
    const p = personalityFromSeed(s);
    tones.add(p.tone);
    pronouns.add(p.pronoun);
    assert.equal(p.traits.length, 2);
    assert.notEqual(p.traits[0], p.traits[1]);
    assert.ok(p.greeting.length > 0 && p.greeting.length < 60);
  }
  assert.equal(tones.size, 5);
  assert.deepEqual([...pronouns].sort(), ["he", "she", "they"]);
});

/** WCAG relative luminance contrast. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const v = hex.slice(1).match(/../g)!.map((x) => {
      const c = parseInt(x, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** OKLCH chroma of a hex colour (via OKLab). */
function chroma(hex: string): number {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(A, B);
}

test("the palette keys never change; only the values do", () => {
  assert.deepEqual(Object.keys(FUR), ["charcoal", "cocoa", "honey", "ginger", "snow", "cream", "mint", "lilac", "sky", "blush", "slate", "butter"]);
  assert.deepEqual(Object.keys(ACCENT), ["rose", "pink", "peach", "coral", "butter", "lilac", "mint", "sky"]);
  assert.deepEqual(Object.keys(OUTFIT), ["cobalt", "periwinkle", "teal", "leaf", "mustard", "orange", "tomato", "berry", "pink", "plum", "oat"]);
  for (const t of [...Object.values(FUR).flatMap((f) => [f.fill, f.light, f.shade]), ...Object.values(ACCENT).flatMap((a) => [a.fill, a.cheek]), ...Object.values(OUTFIT).map((o) => o.fill)])
    assert.match(t, /^#[0-9a-f]{6}$/, "plain hex, readable by the rest of the app");
});

test("restraint: cobalt is the one strong colour; coats are soft", () => {
  for (const [k, t] of Object.entries(FUR)) assert.ok(chroma(t.fill) <= 0.11, `${k} coat chroma ${chroma(t.fill).toFixed(3)}`);
  for (const [k, t] of Object.entries(ACCENT)) assert.ok(chroma(t.fill) <= 0.11, `${k} accent chroma ${chroma(t.fill).toFixed(3)}`);
  for (const [k, t] of Object.entries(OUTFIT)) if (k !== "cobalt") assert.ok(chroma(t.fill) <= 0.12, `${k} outfit chroma ${chroma(t.fill).toFixed(3)}`);
  assert.ok(chroma(OUTFIT.cobalt.fill) > 0.15, "cobalt stays strong");
  for (const k of ["charcoal", "snow", "slate"]) assert.ok(chroma(FUR[k].fill) < 0.03, `${k} is a neutral`);
});

test("coats and outfits stand off the dark surface; the ink outline carries them on light", () => {
  const dark = "#14171d";
  for (const [k, t] of Object.entries(FUR)) assert.ok(contrast(darkFill(t.fill), dark) >= 2.4, `${k} fur on dark: ${contrast(darkFill(t.fill), dark).toFixed(2)}`);
  for (const [k, t] of Object.entries(OUTFIT)) assert.ok(contrast(darkFill(t.fill), dark) >= 2.4, `${k} outfit on dark: ${contrast(darkFill(t.fill), dark).toFixed(2)}`);
  for (const [k, t] of Object.entries(FUR)) assert.ok(contrast(t.fill, INK) >= 1.9, `${k} fur against the outline`);
  assert.ok(contrast(darkFill(FUR.snow.fill), dark) < contrast(FUR.snow.fill, dark), "a white coat glares less in dark mode");
  assert.equal(darkFill(INK), INK, "the outline is never re-tinted");
});

test("coats can be told apart at a glance", () => {
  const lab = (hex: string) => {
    const [r, g, b] = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
    return [r, g, b];
  };
  const keys = Object.keys(FUR);
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [lab(FUR[keys[i]].fill), lab(FUR[keys[j]].fill)];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(d > 24, `${keys[i]} vs ${keys[j]}: ${d.toFixed(1)}`);
    }
});

test("dark mode: every coloured fill carries its dark value; markup alone stays light", () => {
  const svg = avatarMarkup({ ...avatarFromSeed("moss"), accessories: ["headphones"] });
  const tags = svg.match(/<[a-z]+\b[^>]*\sfill="#[0-9a-f]{3,6}"[^>]*>/gi) ?? [];
  for (const t of tags) {
    const fill = /\sfill="(#[0-9a-f]+)"/i.exec(t)![1].toLowerCase();
    if (fill === INK || fill === "#fff" || fill === "#ffffff") continue;
    assert.match(t, new RegExp(`--kd:${darkFill(fill)}`), t);
  }
  assert.match(svg, /--ks:/, "coloured strokes (the headband) too");
  assert.equal((svg.match(/style="/g) ?? []).length, (svg.match(/<[a-z]+\b[^>]*style="/g) ?? []).length, "one style attribute per tag");
  const css = readFileSync(new URL("./avatar.css", import.meta.url), "utf8");
  assert.match(css, /prefers-color-scheme: dark[\s\S]*\[style\*="--kd"\][\s\S]*fill: var\(--kd\)/);
  assert.match(avatarTint("snow"), /color-mix\(in oklch, #[0-9a-f]{6} 20%, var\(--surface/);
});

test("the avatar stylesheet uses motion tokens and honours reduced motion", () => {
  const css = readFileSync(new URL("./avatar.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css.replace(/@media \(prefers-reduced-motion[\s\S]*$/, ""), /\d+m?s\b|cubic-bezier/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
});

test("nameFromSeed skips names already on the team", () => {
  const first = nameFromSeed("moss");
  const second = nameFromSeed("moss", [first]);
  assert.notEqual(first, second);
  assert.equal(second, nameFromSeed("moss", [first.toUpperCase()]));
  assert.equal(nameFromSeed("moss", []), first);
});

test("a monster's antenna stalks carry the coat's dark shade, used only in dark mode", () => {
  for (const fur of Object.keys(FUR)) {
    const svg = avatarMarkup({ species: "monster", fur });
    const stalks = svg.match(/<path[^>]*class="kit-stalk"[^>]*>/g) ?? [];
    assert.equal(stalks.length, 2, fur);
    for (const s of stalks) {
      assert.match(s, /--kstalk:#[0-9a-f]{6}/, fur);
    }
  }
  const css = readFileSync(new URL("./avatar.css", import.meta.url), "utf8");
  const dark = css.slice(css.lastIndexOf("@media (prefers-color-scheme: dark)"));
  assert.match(dark, /\.kit-stalk\s*\{\s*stroke: var\(--kstalk\)/);
});

test("the tile: radius and rise follow the size; the clip opens above and, to the neck, a little past the sides", () => {
  const css = readFileSync(new URL("./avatar.css", import.meta.url), "utf8");
  assert.match(css, /\.kit-tile \{[^}]*--kit-r: calc\(4px \+ var\(--kit-s\) \* 0\.18\)/);
  assert.match(css, /\.kit-tile-rise \{[^}]*margin-top:/);
  const rule = /\.kit-tile-rise > \.kit-avatar \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /--kit-side: calc\(\(1 - var\(--kit-fit, 0\)\) \* var\(--kit-s\) \* 0\.1\)/);
  assert.match(rule, /--kit-neck: calc\(var\(--kit-s\) \* 58 \/ 94/);
  // Five points per corner, plus two at each side's neck: one polygon, so the crops can ease between each other.
  const points = /clip-path: polygon\(([\s\S]*?)\);/.exec(rule)?.[1].split(/,\s*\n/) ?? [];
  assert.equal(points.length, 24);
});
