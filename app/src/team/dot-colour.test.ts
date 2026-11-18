import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCENT, FUR, OUTFITS_FOR_FUR } from "./kit/palette";
import { DOT_CONTRAST, DOT_GROUNDS, contrast, dotColour } from "./dot-colour";

// Read the palette as it is: the kit may change its values, and the dot must still read.
const worst = (c: string, grounds: readonly string[]) => Math.min(...grounds.map((g) => contrast(c, g)));

test("the working dot reads in both themes for every coat, outfit and accent", () => {
  for (const fur of Object.keys(FUR))
    for (const outfitColor of OUTFITS_FOR_FUR[fur])
      for (const accent of Object.keys(ACCENT)) {
        const c = dotColour({ fur, outfitColor, accent });
        assert.ok(worst(c.light, DOT_GROUNDS.light) >= DOT_CONTRAST, `${fur}/${outfitColor}/${accent} light ${c.light}`);
        assert.ok(worst(c.dark, DOT_GROUNDS.dark) >= DOT_CONTRAST, `${fur}/${outfitColor}/${accent} dark ${c.dark}`);
      }
});

test("a coat that reads is the dot; a near-white coat gives way to its outfit", () => {
  for (const fur of Object.keys(FUR)) {
    const spec = { fur, outfitColor: OUTFITS_FOR_FUR[fur][0], accent: "rose" };
    const c = dotColour(spec);
    for (const theme of ["light", "dark"] as const) {
      // Snow is always near-white. The kit's other pale coats (cream, after the restraint pass) may cross the same line, so follow what the helper chose.
      if (fur === "snow") assert.doesNotMatch(c.from[theme], /^fur/, `${fur} ${theme}: not the coat`);
      if (c.from[theme] === "fur") assert.equal(c[theme], FUR[fur].fill, `${fur} ${theme}: the coat itself`);
    }
  }
  // At least one coat is its own dot in each theme, so the rule above isn't vacuous.
  for (const theme of ["light", "dark"] as const)
    assert.ok(Object.keys(FUR).some((fur) => dotColour({ fur, outfitColor: OUTFITS_FOR_FUR[fur][0], accent: "rose" }).from[theme] === "fur"), `${theme}: some coat is its own dot`);
});

test("contrast is WCAG's", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
  assert.equal(contrast("#777777", "#777777"), 1);
});
