// Run: npx tsx --test lib/team-events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFacets, facetsOf } from "./team-events";

test("facetsOf reads facets as q() returns them: opened JSON text, or an object from before encryption", () => {
  const facets = cleanFacets({ kind: "email", title: "Your order has shipped", tags: ["#orders"], email: true });
  assert.deepEqual(facetsOf(JSON.stringify(facets)), facets);
  assert.deepEqual(facetsOf(facets), facets);
});

test("facetsOf makes anything else no facets, never an error", () => {
  assert.deepEqual(facetsOf(null), {});
  assert.deepEqual(facetsOf(undefined), {});
  // A value that wouldn't open stays sealed text, or becomes the placeholder: not JSON.
  assert.deepEqual(facetsOf("enc:v1:abcd:not-json"), {});
  assert.deepEqual(facetsOf("Encrypted — open on athena.example.com"), {});
  assert.deepEqual(facetsOf("[1,2]"), {});
  assert.deepEqual(facetsOf(42), {});
});
