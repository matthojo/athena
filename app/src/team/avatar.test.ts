// The avatar contract: every seed function is deterministic and stays in range; the kit's own tests cover drawing.
// Run: npx tsx --test app/src/team/avatar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCENT_KEYS, ACCESSORY_IDS, FUR_KEYS, MOUTH_IDS, OUTFIT_COLOR_KEYS, SPECIES } from "../../../lib/team-types";
import { avatarFromSeed, nameFromSeed, personalityFromSeed } from "../../../lib/team-seed";

const SEEDS = Array.from({ length: 200 }, (_, i) => `seed-${i}`);

test("the same seed gives the same character, name and personality", () => {
  for (const s of ["penny", "dot", "wren", "", "🦊"]) {
    assert.deepEqual(avatarFromSeed(s), avatarFromSeed(s));
    assert.deepEqual(personalityFromSeed(s), personalityFromSeed(s));
    assert.equal(nameFromSeed(s), nameFromSeed(s));
  }
  assert.equal(avatarFromSeed("penny").seed, "penny");
});

test("different seeds give a spread of characters", () => {
  assert.ok(new Set(SEEDS.map((s) => avatarFromSeed(s).species)).size === SPECIES.length, "every species turns up");
  assert.ok(new Set(SEEDS.map((s) => nameFromSeed(s))).size > 10);
  assert.ok(new Set(SEEDS.map((s) => personalityFromSeed(s).tone)).size >= 4);
});

test("every generated part is a real one, and at most one accessory per slot", () => {
  for (const s of SEEDS) {
    const a = avatarFromSeed(s);
    assert.equal(a.v, 1);
    assert.ok((FUR_KEYS as readonly string[]).includes(a.fur));
    assert.ok((ACCENT_KEYS as readonly string[]).includes(a.accent));
    assert.ok((OUTFIT_COLOR_KEYS as readonly string[]).includes(a.outfitColor));
    assert.ok(MOUTH_IDS.includes(a.mouth));
    const slots = a.accessories.map((x) => ACCESSORY_IDS[x]);
    assert.equal(new Set(slots).size, slots.length);
    const p = personalityFromSeed(s);
    assert.ok(p.greeting.length > 0 && p.traits.length === 2 && p.traits[0] !== p.traits[1]);
  }
});


test("the server's seed functions give one accessory at most, and never the loud ones", () => {
  for (const s of SEEDS) {
    const a = avatarFromSeed(s);
    assert.ok(a.accessories.length <= 1, `${s}: ${a.accessories.join(", ")}`);
    for (const x of a.accessories) assert.ok(!["party-hat", "crown", "eye-patch"].includes(x), `${s} rolled ${x}`);
    assert.notEqual(a.mouth, "big-laugh", `${s}: a resting face is calm`);
  }
});
