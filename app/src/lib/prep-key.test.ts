import assert from "node:assert/strict";
import { test } from "node:test";
import { prepKey } from "./prep-key";

test("the meeting cards repaint only when a meeting, its time, title or people changed", () => {
  const a = { event_id: "e1", title: "Growth Team Sync", starts_at: "2026-11-13T16:00:00Z", people: [{ id: "p1" }] };
  assert.equal(prepKey([a]), prepKey([{ ...a, starts_at: new Date("2026-11-13T16:00:00.000Z") }]));
  assert.notEqual(prepKey([a]), prepKey([{ ...a, starts_at: "2026-11-13T17:00:00Z" }]));
  assert.notEqual(prepKey([a]), prepKey([{ ...a, people: [...a.people, { id: "p2" }] }]));
  assert.notEqual(prepKey([a]), prepKey([]));
});
