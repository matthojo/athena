import { test } from "node:test";
import assert from "node:assert/strict";
import { matchThings, nameScore, type JumpThing } from "./jump-things";

const things: JumpThing[] = [
  { kind: "person", id: "p1", title: "Priya Shah" },
  { kind: "person", id: "p2", title: "Dr. Elena Osei" },
  { kind: "todo", id: "t1", title: "Intro Priya to the design agency" },
  { kind: "todo", id: "t2", title: "Book the car's MOT" },
  { kind: "place", id: "pl1", title: "Dishoom King's Cross" },
  { kind: "note", id: "n1", title: "Call with Priya: mentorship structure" },
  { kind: "note", id: "n2", title: "Supriyadi's recipe" },
];

test("nameScore ranks a name that starts with what was typed above a word, above a mention", () => {
  assert.equal(nameScore("Priya Shah", "pri"), 3);
  assert.equal(nameScore("Call with Priya", "pri"), 2);
  assert.equal(nameScore("Supriyadi's recipe", "pri"), 1);
  assert.equal(nameScore("Tom Hale", "pri"), 0);
});

test("every word typed has to be in the name, in any order, accents aside", () => {
  assert.ok(nameScore("Dr. Elena Osei", "osei elena") > 0);
  assert.equal(nameScore("Dr. Elena Osei", "elena shah"), 0);
  assert.ok(nameScore("Zoë Café", "zoe cafe") > 0);
});

test("a name finds the person first, then what else carries it, grouped by kind", () => {
  const groups = matchThings(things, "priya");
  assert.deepEqual(groups.map((g) => g.label), ["People", "To do", "Notes"]);
  assert.equal(groups[0].items[0].id, "p1");
  // Within notes, the word match comes before the one that only contains it.
  assert.deepEqual(groups[2].items.map((t) => t.id), ["n1", "n2"]);
});

test("one letter finds nothing, and the list stays short", () => {
  assert.deepEqual(matchThings(things, "p"), []);
  const many: JumpThing[] = Array.from({ length: 30 }, (_, i) => ({ kind: i % 2 ? "note" : "person", id: `x${i}`, title: `Sam ${i}` }) as JumpThing);
  const groups = matchThings(many, "sam", 4, 6);
  assert.deepEqual(groups.map((g) => g.items.length), [4, 2]);
});
