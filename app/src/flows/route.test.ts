// Run: npx tsx --test app/src/flows/route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routeHash } from "../lib/routes";

test("Flows' addresses round-trip", () => {
  for (const [hash, noteId] of [["#/flows", null], ["#/flows/new", "new"], ["#/flows/abc", "abc"], ["#/flows/runs/r1", "runs/r1"]] as const) {
    const r = parseRoute(hash);
    assert.deepEqual(r, { view: "flows", source: null, noteId });
    assert.equal(routeHash(r), hash);
  }
});
