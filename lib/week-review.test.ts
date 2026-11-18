// The week in review's "moved on" rule for goals (lib/week-review.ts), without a database.
// Run: npx tsx --test lib/week-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalMovement } from "./week-review";

test("a goal moved on when its last value beats the one before the period", () => {
  assert.deepEqual(goalMovement({ before: 40, first_in: 45, last: 52 }), { was: 40, now: 52 });
});

test("no change, or going backwards, isn't moving on", () => {
  assert.equal(goalMovement({ before: 40, first_in: null, last: 40 }), null);
  assert.equal(goalMovement({ before: 60, first_in: 50, last: 50 }), null);
});

test("a goal added (or seeded) during the period starts from its first value", () => {
  assert.equal(goalMovement({ before: null, first_in: 20, last: 20 }), null);
  assert.deepEqual(goalMovement({ before: null, first_in: 0, last: 30 }), { was: 0, now: 30 });
});

test("a goal logged only after the period says nothing about it", () => {
  assert.equal(goalMovement({ before: null, first_in: null, last: null }), null);
});
