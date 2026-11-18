import assert from "node:assert/strict";
import { test } from "node:test";
import { menuRight } from "./menu-place";

test("a menu hangs from its button's right edge when it fits, from its left edge when it doesn't, and stays on screen", () => {
  // A phone, 390 wide; a 232px menu.
  assert.equal(menuRight({ left: 330, right: 366 }, 232, 390), 24); // button at the right: as before
  assert.equal(menuRight({ left: 16, right: 52 }, 232, 390), 142); // wrapped to the left: starts at the button's left edge (16)
  assert.equal(390 - 142 - 232, 16);
  assert.equal(menuRight({ left: 100, right: 136 }, 232, 390), 58); // mid-row: from its left edge, 100
  assert.equal(menuRight({ left: 380, right: 400 }, 232, 390), 12); // past the edge: kept 12 in
  assert.equal(menuRight({ left: 0, right: 30 }, 232, 390), 146); // hard left: 12 in from the left
  assert.equal(menuRight({ left: 10, right: 40 }, 400, 390), 12); // wider than the screen: pinned
  // Always on screen.
  for (const left of [0, 20, 80, 160, 240, 320, 360]) {
    const r = menuRight({ left, right: left + 36 }, 232, 390);
    assert.ok(r >= 12 && 390 - r - 232 >= 12, `left ${left}`);
  }
});
