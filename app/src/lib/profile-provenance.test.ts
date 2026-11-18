import { test } from "node:test";
import assert from "node:assert/strict";
import { provenanceLine } from "./profile-provenance";

test("the weekly learner reads as your activity; other sources keep their names", () => {
  assert.equal(provenanceLine({ source: "profile-learner", confidence: 0.7 }), "Learned from your activity");
  assert.equal(provenanceLine({ source: "gmail", confidence: 0.8 }), "Learned from Gmail");
  assert.equal(provenanceLine({ source: "life-log", confidence: 0.8 }), "Learned from Life log");
  assert.equal(provenanceLine({ source: "manual", confidence: null }), "You told Athena");
  assert.equal(provenanceLine({ source: "profile-learner", confidence: null }), "You told Athena");
});
