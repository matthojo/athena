import { test } from "node:test";
import assert from "node:assert/strict";
import { learnedAboutOwner } from "./owner-rule";

test("the owner's own words save; anything learned about them goes to review", () => {
  // Typed in the app or said in Ask.
  assert.equal(learnedAboutOwner({ subject_kind: "me" }), false);
  assert.equal(learnedAboutOwner({ subject_kind: "me", source: "manual", confidence: null }), false);
  assert.equal(learnedAboutOwner({ subject_kind: "me", source: "assistant" }), false);
  // From a source, or with any confidence.
  assert.equal(learnedAboutOwner({ subject_kind: "me", source: "life-log", confidence: 0.8 }), true);
  assert.equal(learnedAboutOwner({ subject_kind: "me", source: "email-digest" }), true);
  assert.equal(learnedAboutOwner({ subject_kind: "me", confidence: 0.4 }), true);
  // Accepting a suggestion is the owner's say.
  assert.equal(learnedAboutOwner({ subject_kind: "me", source: "life-log", confidence: 0.8 }, { byOwner: true }), false);
  // Facts about other people aren't covered.
  assert.equal(learnedAboutOwner({ subject_kind: "person", source: "email-digest", confidence: 0.9 }), false);
});
