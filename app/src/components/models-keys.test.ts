// The picker's listbox keyboard (models-keys.ts): arrows, Home and End, pages, and type-ahead.
// Run: npx tsx --test app/src/components/models-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listKey, TYPEAHEAD_MS, type ListKeyState } from "./models-keys";

const labels = ["Claude Sonnet 5.5", "Claude Opus 5.5", "Claude Haiku 5.5", "Gemini 3.5 Pro", "Gemini 3.5 Flash", "GPT-5.5", "GPT-5.5 mini", "Llama 4 Maverick", "deepseek-v4-pro", "qwen3.5-max", "mistral-large-3"];
const at = (index: number, typed = "", time = 0): ListKeyState => ({ index, typed, at: time });

test("Down and Up move one and stop at the ends", () => {
  assert.equal(listKey("ArrowDown", at(0), labels, 0)!.index, 1);
  assert.equal(listKey("ArrowUp", at(3), labels, 0)!.index, 2);
  assert.equal(listKey("ArrowDown", at(labels.length - 1), labels, 0)!.index, labels.length - 1);
  assert.equal(listKey("ArrowUp", at(0), labels, 0)!.index, 0);
});

test("from nothing active, Down lands on the first and Up on the last", () => {
  assert.equal(listKey("ArrowDown", at(-1), labels, 0)!.index, 0);
  assert.equal(listKey("ArrowUp", at(-1), labels, 0)!.index, labels.length - 1);
});

test("Home and End go to the ends; pages move eight and stop at the ends", () => {
  assert.equal(listKey("Home", at(6), labels, 0)!.index, 0);
  assert.equal(listKey("End", at(2), labels, 0)!.index, labels.length - 1);
  assert.equal(listKey("PageDown", at(1), labels, 0)!.index, 9);
  assert.equal(listKey("PageDown", at(5), labels, 0)!.index, labels.length - 1);
  assert.equal(listKey("PageUp", at(3), labels, 0)!.index, 0);
});

test("typing jumps to the next option starting with it, ignoring case", () => {
  assert.equal(listKey("g", at(0), labels, 1000)!.index, 3);
  assert.equal(listKey("D", at(0), labels, 1000)!.index, 8);
  assert.equal(listKey("m", at(0), labels, 1000)!.index, 10);
});

test("typing more letters narrows the match, while it's quick", () => {
  const g = listKey("g", at(0), labels, 1000)!;
  const gp = listKey("p", g, labels, 1100)!;
  assert.equal(gp.typed, "gp");
  assert.equal(gp.index, 5);
  // A pause forgets what was typed: "p" alone finds nothing from here, so it stays.
  const later = listKey("p", g, labels, 1000 + TYPEAHEAD_MS + 1)!;
  assert.equal(later.typed, "p");
  assert.equal(later.index, g.index);
});

test("the same letter again cycles through the options starting with it, and wraps", () => {
  let s = listKey("c", at(-1), labels, 0)!;
  assert.equal(s.index, 0);
  s = listKey("c", s, labels, 100)!;
  assert.equal(s.index, 1);
  s = listKey("c", s, labels, 200)!;
  assert.equal(s.index, 2);
  s = listKey("c", s, labels, 300)!;
  assert.equal(s.index, 0);
});

test("a typed name that matches nothing leaves the active option where it was", () => {
  const s = listKey("z", at(4), labels, 0)!;
  assert.equal(s.index, 4);
});

test("Space with nothing typed is left for choosing; keys it doesn't know are left alone", () => {
  assert.equal(listKey(" ", at(2), labels, 0), null);
  assert.equal(listKey("Tab", at(2), labels, 0), null);
  assert.equal(listKey("Enter", at(2), labels, 0), null);
  assert.equal(listKey("ArrowDown", at(0), [], 0), null);
});

test("Space while typing is part of the name", () => {
  const g = listKey("g", at(0), labels, 0)!;
  const ge = "emini".split("").reduce((s, c, i) => listKey(c, s, labels, 10 * (i + 1))!, g);
  const sp = listKey(" ", ge, labels, 100)!;
  assert.equal(sp.typed, "gemini ");
  assert.equal(listKey("3", sp, labels, 110)!.index, 3);
});
