// Run anyway in the app (db/run-anyway.ts): the token goes with the next send of the same message, once.
// Run: npx tsx --test app/src/db/run-anyway.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { armRunAnyway, runAnywayFlag, runAnywayUntil } from "./run-anyway";

test("the token goes once, with the message it was armed for", () => {
  armRunAnyway("t1", "What's on today? ");
  assert.deepEqual(runAnywayFlag("What's on today?"), { run_anyway: "t1" });
  assert.deepEqual(runAnywayFlag("What's on today?"), {}, "not sent twice");
  armRunAnyway("t2", "What's on today?");
  assert.deepEqual(runAnywayFlag("Something else"), {}, "another message goes without it");
  assert.deepEqual(runAnywayFlag("What's on today?"), {}, "and it's gone");
});

test("a token's time is read from its first part", () => {
  const at = Date.UTC(2026, 10, 17, 12);
  assert.equal(runAnywayUntil(`${at.toString(36)}.n.m`), at);
  assert.equal(runAnywayUntil("zz-not"), 0);
});
