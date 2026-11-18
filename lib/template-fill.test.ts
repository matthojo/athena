// Run: npx tsx --test lib/template-fill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMeetingNotes } from "./template-fill";

test("a meeting linked only from the morning briefing still needs notes; a real note means it has them", () => {
  const person = { kind: "person", subtitle: "" };
  const briefing = { kind: "note", subtitle: "daily" };
  assert.equal(hasMeetingNotes([person, briefing]), false);
  assert.equal(hasMeetingNotes([person]), false);
  assert.equal(hasMeetingNotes([person, briefing, { kind: "note", subtitle: "note" }]), true);
});
