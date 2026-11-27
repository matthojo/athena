// What the grocery list learns from past shops: usuals, when they're due, skips, and the walk round the shop.
// Run: npx tsx --test lib/grocery-usuals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueUsuals, isDue, learnedOrder, learnUsuals, skipUntil, walkOrder, type BoughtEntry } from "./grocery-usuals";
import { groupByAisle } from "./grocery";

const on = (item: string, ...days: string[]): BoughtEntry[] => days.map((day) => ({ item, quantity: null, unit: null, aisle: "other", day }));

test("a usual needs three shops, and its gap is the typical one", () => {
  const bought = [...on("Milk", "2026-11-01", "2026-11-05", "2026-11-09", "2026-11-14"), ...on("Saffron", "2026-11-01", "2026-11-10")];
  const usuals = learnUsuals(bought, "2026-11-18");
  assert.equal(usuals.length, 1);
  assert.equal(usuals[0].item, "Milk");
  assert.equal(usuals[0].every, 4);
  assert.equal(usuals[0].since, 4);
  assert.equal(usuals[0].times, 4);
});

test("the same thing in other words is one usual, named as it was last written", () => {
  const bought = [...on("eggs", "2026-11-01"), ...on("Eggs", "2026-11-08"), ...on("egg", "2026-11-15")];
  const [u] = learnUsuals(bought, "2026-11-22");
  assert.equal(u.key, "egg");
  assert.equal(u.item, "egg");
  assert.equal(u.every, 7);
});

test("two lines for one thing on the same shop count once", () => {
  const bought = [...on("Bananas", "2026-11-01", "2026-11-01", "2026-11-08", "2026-11-15")];
  const [u] = learnUsuals(bought, "2026-11-20");
  assert.equal(u.times, 3);
  assert.equal(u.every, 7);
});

test("only recent gaps count: a habit that changed is followed", () => {
  const old = ["2026-01-01", "2026-01-31", "2026-03-02"];
  const recent = ["2026-10-01", "2026-10-05", "2026-10-09", "2026-10-13", "2026-10-17", "2026-10-21", "2026-10-25"];
  const [u] = learnUsuals(on("Oat milk", ...old, ...recent), "2026-10-28");
  assert.equal(u.every, 4);
});

test("too often or too rarely isn't a usual", () => {
  assert.deepEqual(learnUsuals(on("Croissant", "2026-11-01", "2026-11-02", "2026-11-03"), "2026-11-04"), []);
  assert.deepEqual(learnUsuals(on("Turkey", "2026-01-01", "2026-04-01", "2026-07-01"), "2026-08-01"), []);
});

test("the usual amount is the one bought most often lately", () => {
  const bought: BoughtEntry[] = [
    { item: "milk", quantity: 2, unit: "pint", aisle: "dairy-eggs", day: "2026-11-01" },
    { item: "milk", quantity: 4, unit: "pint", aisle: "dairy-eggs", day: "2026-11-05" },
    { item: "milk", quantity: 2, unit: "pint", aisle: "dairy-eggs", day: "2026-11-09" },
  ];
  const [u] = learnUsuals(bought, "2026-11-12");
  assert.equal(u.quantity, 2);
  assert.equal(u.unit, "pint");
  assert.equal(u.aisle, "dairy-eggs");
});

test("due a little early, not once it's plainly been dropped", () => {
  assert.equal(isDue({ every: 7, since: 5 }), false);
  assert.equal(isDue({ every: 7, since: 6 }), true);
  assert.equal(isDue({ every: 7, since: 7 }), true);
  assert.equal(isDue({ every: 7, since: 21 }), true);
  assert.equal(isDue({ every: 7, since: 22 }), false);
  assert.equal(isDue({ every: 2, since: 1 }), true);
});

test("due usuals leave out what's on the list and what was skipped, most due first", () => {
  const bought = [
    ...on("Milk", "2026-11-01", "2026-11-05", "2026-11-09"),
    ...on("Bread", "2026-11-01", "2026-11-04", "2026-11-07"),
    ...on("Eggs", "2026-10-26", "2026-11-02", "2026-11-09"),
    ...on("Coffee beans", "2026-10-20", "2026-11-01", "2026-11-13"),
  ];
  const today = "2026-11-14";
  assert.deepEqual(
    dueUsuals(bought, { today, onList: [], skipped: [] }).map((u) => u.item),
    ["Bread", "Milk"],
  );
  assert.deepEqual(dueUsuals(bought, { today, onList: ["2 loaves of bread"], skipped: [] }).map((u) => u.item), ["Bread", "Milk"], "a different wording is a different thing");
  assert.deepEqual(dueUsuals(bought, { today, onList: ["bread"], skipped: [] }).map((u) => u.item), ["Milk"]);
  assert.deepEqual(dueUsuals(bought, { today, onList: [], skipped: [{ item: "milk", until: "2026-11-18" }] }).map((u) => u.item), ["Bread"]);
  assert.deepEqual(dueUsuals(bought, { today, onList: [], skipped: [{ item: "milk", until: today }] }).map((u) => u.item), ["Bread", "Milk"], "a skip runs out on its day");
  assert.equal(dueUsuals(bought, { today, onList: [], skipped: [], max: 1 }).length, 1);
});

test("a skip lasts one more gap, at least two days", () => {
  assert.equal(skipUntil({ every: 7 }, "2026-11-14"), "2026-11-21");
  assert.equal(skipUntil({ every: 1 }, "2026-11-30"), "2026-12-02");
});

test("the walk: aisles in the order their first line was ticked", () => {
  const t0 = Date.parse("2026-11-14T10:00:00Z");
  const m = 60_000;
  const ticks = [
    { aisle: "dairy-eggs", at: t0 + 9 * m },
    { aisle: "bakery", at: t0 },
    { aisle: "produce", at: t0 + 2 * m },
    { aisle: "bakery", at: t0 + 3 * m },
    { aisle: "nonsense", at: t0 + 10 * m },
  ];
  assert.deepEqual(walkOrder(ticks), ["bakery", "produce", "dairy-eggs", "other"]);
});

test("ticking everything at once, or in two aisles, teaches nothing", () => {
  const t0 = Date.parse("2026-11-14T10:00:00Z");
  assert.deepEqual(walkOrder([{ aisle: "bakery", at: t0 }, { aisle: "produce", at: t0 + 1000 }, { aisle: "frozen", at: t0 + 2000 }]), []);
  assert.deepEqual(walkOrder([{ aisle: "bakery", at: t0 }, { aisle: "produce", at: t0 + 600_000 }]), []);
});

test("the learned order follows the latest walks, then the aisles never walked in their usual order", () => {
  assert.equal(learnedOrder([["bakery", "produce", "dairy-eggs"]]), null, "one walk isn't enough");
  const order = learnedOrder([
    ["bakery", "produce", "dairy-eggs", "frozen"],
    ["bakery", "dairy-eggs", "produce", "frozen"],
    ["bakery", "produce", "dairy-eggs"],
  ])!;
  assert.equal(order.length, 12);
  assert.deepEqual(order.slice(0, 4), ["bakery", "produce", "dairy-eggs", "frozen"], "the walked route comes first, unbroken");
  assert.deepEqual(order.slice(4), ["meat-fish", "chilled", "tins-jars", "dry", "baking", "spices", "drinks", "other"]);
  const latest = [["produce", "drinks", "frozen"], ["produce", "drinks", "frozen"]];
  const before = Array.from({ length: 6 }, () => ["frozen", "drinks", "produce"]);
  assert.deepEqual(learnedOrder([...latest, ...before], 2)!.slice(0, 3), ["produce", "drinks", "frozen"], "only the latest walks count");
});

test("the list groups in the learned order, then any aisle it doesn't name", () => {
  const lines = [
    { item: "Milk", aisle: "dairy-eggs" },
    { item: "Bread", aisle: "bakery" },
    { item: "Lemons", aisle: "produce" },
  ];
  assert.deepEqual(groupByAisle(lines).map((g) => g.aisle), ["produce", "dairy-eggs", "bakery"]);
  assert.deepEqual(groupByAisle(lines, ["bakery", "dairy-eggs"]).map((g) => g.aisle), ["bakery", "dairy-eggs", "produce"]);
});
