import assert from "node:assert/strict";
import { test } from "node:test";
import { headlineEvent, headlineEventWords } from "./headline-event";

const ev = (title: string, starts_at: string | null, extra: Partial<{ kind: string; days_until: number }> = {}) => ({
  event: { title, kind: extra.kind ?? "appointment" },
  days_until: extra.days_until ?? 0,
  time: starts_at ? starts_at.slice(11, 16) : null,
  starts_at,
});

test("the headline leads with the next thing today, not the first", () => {
  const day = [ev("Hospital appointment", "2026-11-12T09:00:00Z"), ev("Design review", "2026-11-12T15:00:00Z"), ev("Bins out", null), ev("Sam's birthday", null, { kind: "birthday" }), ev("Dentist", "2026-11-13T09:00:00Z", { days_until: 1 })];
  const at = (t: string) => headlineEventWords(headlineEvent(day, new Date(`2026-11-12T${t}:00Z`)));
  assert.equal(at("07:30"), "Hospital appointment at 09:00 is");
  assert.equal(at("09:20"), "Hospital appointment at 09:00 is"); // you may be in it
  assert.equal(at("09:31"), "Design review at 15:00 is");
  assert.equal(at("14:10"), "Design review at 15:00 is");
  assert.equal(at("15:45"), "Bins out is"); // no timed one left: the all-day date
  // Nothing left to come, and no all-day date: the sentence moves on.
  assert.equal(headlineEvent([day[0], day[3], day[4]], new Date("2026-11-12T14:00:00Z")), null);
  assert.equal(headlineEventWords(null), null);
});
