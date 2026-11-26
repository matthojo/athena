// The guided setup's words (app/src/guide/words.ts) follow lib/writing-style.ts, and the steps count up as shown.
// Run: npx tsx --test app/src/guide/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTED, STEP_NAMES, stepOf, WORDS } from "./words";
import { styleProblems } from "../../../lib/writing-style";

/** Every string in the words, functions called with a sample value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") strings(value(2), out), strings(value(1), out), strings(value(0), out);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

test("no em dashes or filler anywhere in the guide", () => {
  const all = [...strings(WORDS), ...Object.values(STEP_NAMES)];
  assert.ok(all.length > 60);
  const bad = all.map((s) => [s, styleProblems(s)] as const).filter(([, p]) => p.length);
  assert.deepEqual(bad, []);
});

test("the steps count from 1 to 5, and the done step has no number", () => {
  assert.deepEqual(COUNTED.map(stepOf), ["Step 1 of 5", "Step 2 of 5", "Step 3 of 5", "Step 4 of 5", "Step 5 of 5"]);
  assert.equal(stepOf("done"), "");
});

test("what happens next says what's coming whether or not a source is connected", () => {
  assert.match(WORDS.done.next(0)[0][1], /Settings, under Sources/);
  assert.match(WORDS.done.next(1)[0][1], /^Your first source sends/);
  assert.match(WORDS.done.next(3)[0][1], /^Your sources send/);
  assert.equal(WORDS.done.summary.sources(1), "One source connected");
  assert.equal(WORDS.done.summary.sources(4), "4 sources connected");
});
