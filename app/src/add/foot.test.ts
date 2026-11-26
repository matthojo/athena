// The Add screen's action bar (add/add.css, view.ts): Cancel, "Add and use" for a theme, and Add must fit a 360px
// phone for any name up to the name limit. Add takes a row of its own when it has too little room beside the others,
// and its label ends in an ellipsis rather than running off the screen; the full words stay its accessible name.
// Run: npx tsx --test app/src/add/foot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./add.css", import.meta.url), "utf8");
const rule = (sel: string) => new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

test("the action bar wraps, and Add can shrink and truncate its label", () => {
  assert.match(rule(".add-foot__row"), /flex-wrap: wrap;/);
  const add = rule(".add-foot__add");
  assert.match(add, /min-width: 0;/, "a button doesn't shrink below its text without this");
  assert.match(add, /flex: 1 1 \d+(\.\d+)?rem;/, "a basis, so Add moves to its own row before it gets too narrow");
  const label = rule(".add-foot__label");
  assert.match(label, /overflow: hidden;/);
  assert.match(label, /text-overflow: ellipsis;/);
  const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
  assert.equal((view.match(/class: "add-foot__label"/g) ?? []).length, 2, "both ways the button is drawn put its words in the label span");
});
