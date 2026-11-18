// The day plan by energy rides in the morning briefing: its section in the note, a line in the push, never why.
// Run: npx tsx --test lib/proactive/briefing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY_PLAN_PUSH, dayPlanSection } from "./briefing";
import { deliverBriefing, type DeliverDeps } from "../briefing-run";
import type { Briefing } from "../briefing";

const plan = {
  id: "5a3e0000-0000-4000-8000-00000000d003",
  actions: [{ kind: "move" as const, label: "Move to 14:00", event_id: "e1", title: "Deep work", from: "2026-11-09T09:00:00Z", start: "2026-11-09T14:00:00Z", end: "2026-11-09T16:00:00Z" }],
};
const hhmm = (iso: string) => iso.slice(11, 16);

test("the briefing's lighter-plan section lists each move and links to Ask, without saying why", () => {
  const s = dayPlanSection(plan, hhmm);
  assert.match(s, /^## A lighter plan for today/);
  assert.ok(s.includes("- “Deep work” from 09:00 to 14:00"));
  assert.ok(s.includes("(/#/ask/nudge/5a3e0000-0000-4000-8000-00000000d003)"));
  assert.ok(!/sleep|slept|recovery|tired|short night/i.test(s));
  assert.ok(dayPlanSection({ id: "x", actions: [] }, hhmm).includes("Nothing heavy is on this morning"));
});

test("deliverBriefing carries today's day plan in the note and the push", async () => {
  const notes: string[] = [];
  const pushes: string[] = [];
  const deps = (withPlan: boolean): DeliverDeps => ({
    claim: async () => true,
    release: async () => {},
    createNote: async (n) => (notes.push(n.body), { id: "n1" }),
    push: async (m) => void pushes.push(m.body),
    dayPlan: async () => (withPlan ? { section: dayPlanSection(plan, hhmm), push: DAY_PLAN_PUSH } : null),
  });
  const b = { date: "2026-11-09", title: "Today, Monday 9 November", body: "Two meetings.", digest: "Two meetings today.", hasReminders: false } as unknown as Briefing;
  await deliverBriefing(b, { push: true }, deps(true));
  assert.ok(notes[0].startsWith("Two meetings.\n\n## A lighter plan for today"));
  assert.equal(pushes[0], "Two meetings today. A lighter plan for today is on Home.");
  await deliverBriefing(b, { push: true }, deps(false));
  assert.equal(notes[1], "Two meetings.");
  assert.equal(pushes[1], "Two meetings today.");
});
