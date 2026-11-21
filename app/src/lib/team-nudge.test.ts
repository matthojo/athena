// Run: npx tsx --test app/src/lib/team-nudge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamNudgeFrom, teamNudgeName } from "./team-nudge";

const avatar = { v: 1, seed: "penny", species: "cat", fur: "snow", accent: "pink", eyes: "sparkle", mouth: "small-smile", outfit: "hoodie", outfitColor: "berry", accessories: [] };

test("A team nudge with an avatar spec says who it's from", () => {
  assert.deepEqual(teamNudgeFrom({ rule: "team", assistant: { id: "a1", name: "Penny", avatar } }), { id: "a1", name: "Penny", avatar });
  assert.deepEqual(teamNudgeFrom({ rule: "team", payload: { assistant_id: "a1", name: "Penny", avatar } }), { id: "a1", name: "Penny", avatar });
  assert.equal(teamNudgeFrom({ rule: "team", avatar, name: "Penny" })?.name, "Penny");
});

test("Anything else draws no avatar", () => {
  assert.equal(teamNudgeFrom({ rule: "leave_by", assistant: { name: "Penny", avatar } }), null);
  assert.equal(teamNudgeFrom({ rule: "team", payload: { name: "Penny", avatar: "cat" } }), null);
  assert.equal(teamNudgeName({ rule: "team", payload: { name: "Penny" } }), "Penny");
});
