// What Athena knows (app/src/lib/knows.ts): grouped by where each thing came from.
// Run: npx tsx --test app/src/lib/knows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupKnows } from "./knows";
import type { Fact, Suggestion } from "../types";

const fact = (id: string, key: string, value: string, extra: Partial<Fact> = {}): Fact => ({
  id,
  subject_kind: "me",
  subject_id: null,
  key,
  value,
  source: "manual",
  source_ref: null,
  source_quote: null,
  confidence: null,
  observed_at: "2026-11-01T10:00:00Z",
  superseded_at: null,
  archived_at: null,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  ...extra,
});

const waiting: Suggestion = {
  id: "s1",
  op: "fact",
  summary: "About you · Sleep routine",
  payload: { subject_kind: "me", key: "Sleep routine", value: "Bed by 11.30" },
  source: "profile-learner",
  source_ref: null,
  source_quote: "Asleep by 23:45 on 11 of 14 nights",
  confidence: 0.7,
  status: "pending",
  result_id: null,
  resolved_at: null,
  created_at: "2026-11-08T10:00:00Z",
};

test("grouped by where it came from, newest first, with where and when", () => {
  const groups = groupKnows({
    me: [
      fact("a", "Diet", "Vegetarian", { source: "assistant", observed_at: "2026-11-07T10:00:00Z" }),
      fact("b", "home town", "London"),
      fact("c", "Exercise routine", "Runs on Saturday", { source: "profile-learner", confidence: 0.8, source_quote: "7 of 8 Saturdays" }),
      // Superseded and forgotten values aren't shown.
      fact("d", "Role", "Designer", { superseded_at: "2026-10-01T00:00:00Z" }),
      fact("e", "Tone", "Direct", { archived_at: "2026-10-01T00:00:00Z" }),
    ],
    people: [{ ...fact("p", "Kids", "Ada (4)", { subject_kind: "person", subject_id: "m", source: "assistant", confidence: 1, observed_at: "2026-11-08T09:00:00Z" }), person: { id: "m", name: "Marcus Webb" } }],
    suggestions: [waiting, { ...waiting, id: "s2", payload: { subject_kind: "person", subject_id: "m", key: "x", value: "y" } }],
  });
  assert.deepEqual(groups.map((g) => [g.id, g.items.map((i) => i.key)]), [
    ["ask", ["fact:p", "fact:a"]],
    ["profile", ["fact:b"]],
    ["learned", ["fact:c"]],
    ["review", ["suggestion:s1"]],
  ]);
  const [ask, profile, learned, review] = groups;
  assert.deepEqual(ask.items[0].about, { kind: "person", id: "m", name: "Marcus Webb" });
  assert.equal(ask.items[1].from, "You told Ask");
  assert.equal(profile.items[0].label, "Home town", "the catalogue's own spelling");
  assert.equal(profile.items[0].from, "You told Athena");
  assert.equal(learned.items[0].from, "Learned from your activity");
  assert.equal(learned.items[0].why, "7 of 8 Saturdays");
  assert.equal(review.items[0].value, "Bed by 11.30");
  assert.equal(review.items[0].from, "Noticed in your activity");
});

test("nothing known: no groups", () => {
  assert.deepEqual(groupKnows({ me: [], people: [], suggestions: [] }), []);
});
