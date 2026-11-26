// Sample check-ins (app/src/db/sample-checkins.ts) with a shared set: a set is added asking or switched off, a
// routine that's off stays off, and a written answer, to a shared question or to one the owner wrote, goes into that
// day's journal, is changed and undone with it, and stays there when the set is removed. The owner's own scale stays
// out, and days already answered aren't back-filled. Made-up words only.
// Run: npx tsx --test app/src/db/sample-checkins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { localToday } from "../lib/time";
import { answerSampleCheckin, sampleAddCheckins, sampleCheckin, sampleCheckinSettings, sampleRemoveSet, saveSampleCheckinSettings } from "./sample-checkins";
import { sampleDayNow } from "./sample-days";
import type { SharedCheckins } from "../../../lib/checkin-share";

const set = (name: string, prompt: string): SharedCheckins => ({
  format: 1,
  name,
  summary: "Two made-up questions.",
  questions: [
    { prompt, kinds: ["evening"], type: "text", placeholder: "A few words.", deeper: false },
    { prompt: `${prompt} (out of five)`, kinds: ["evening"], type: "scale", low: "Low", high: "High" },
  ],
});

test("start: asking by default, or added switched off; either way nothing about the routines changes", async () => {
  const before = await sampleCheckinSettings();
  const on = await sampleAddCheckins(set("Porch light", "What did you notice on the walk home?"), undefined, {});
  const off = await sampleAddCheckins(set("Kettle on", "What was the best cup of tea today?"), undefined, { start: false });
  const view = await sampleCheckinSettings();
  assert.equal(view.sets.find((s) => s.id === on.id)?.paused, false);
  assert.equal(view.sets.find((s) => s.id === off.id)?.paused, true);
  assert.deepEqual([view.morning.enabled, view.evening.enabled], [before.morning.enabled, before.evening.enabled]);
  await sampleRemoveSet(on.id);
  await sampleRemoveSet(off.id);
});

test("start: a routine that's off stays off, whichever way the set starts, and is named", async () => {
  const s = await sampleCheckinSettings();
  await saveSampleCheckinSettings({ morning: s.morning, evening: { ...s.evening, enabled: false }, own: s.own });
  for (const start of [true, false]) {
    const got = await sampleAddCheckins(set(`Night bus ${start}`, `Who sat next to you today ${start}?`), undefined, { start });
    assert.deepEqual(got.off, ["evening"]);
    assert.equal((await sampleCheckinSettings()).evening.enabled, false);
    await sampleRemoveSet(got.id);
  }
  await saveSampleCheckinSettings({ morning: s.morning, evening: { ...s.evening, enabled: true }, own: s.own });
});

test("journal: a shared written answer is copied, changed and undone with the day's journal; removing the set leaves it", async () => {
  const added = await sampleAddCheckins(set("Window seat", "What did you see out of the window today?"), undefined, {});
  const view = await sampleCheckinSettings();
  const [text, scale] = view.own.filter((q) => q.set === added.id);
  assert.deepEqual([text.mirror, scale.mirror], ["day_journal", null]);
  // Pin it, so today's plan (made fresh, in sample mode) asks it.
  await saveSampleCheckinSettings({ ...view, evening: { ...view.evening, questions: view.evening.questions.map((x) => (x.id === text.id || x.id === scale.id ? { ...x, pinned: true } : x)) } });
  // A day in the future that's never been planned: no seeded answers or journal to get in the way.
  const date = (() => {
    const d = new Date(`${localToday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3);
    return d.toISOString().slice(0, 10);
  })();
  const c = await sampleCheckin(date, "evening");
  assert.ok(c.plan.some((q) => q.id === text.id));
  const mine = sampleDayNow(date).journal ?? "";

  await answerSampleCheckin(date, "evening", text.id, { text: "A heron on the canal." });
  await answerSampleCheckin(date, "evening", scale.id, { scale: 4 });
  const j1 = sampleDayNow(date).journal ?? "";
  assert.match(j1, /Evening reflection\nWhat did you see out of the window today\?\nA heron on the canal\./);
  assert.doesNotMatch(j1, /out of five/);
  assert.ok(j1.startsWith(mine));

  // Changed: swapped in place, not added twice.
  await answerSampleCheckin(date, "evening", text.id, { text: "Two herons on the canal." });
  const j2 = sampleDayNow(date).journal ?? "";
  assert.equal(j2.match(/What did you see out of the window today\?/g)?.length, 1);
  assert.match(j2, /Two herons/);

  // Undone: out again, the owner's own words as they were.
  await answerSampleCheckin(date, "evening", text.id, null);
  assert.equal(sampleDayNow(date).journal ?? "", mine);

  // Answered again, then the set removed: the day's journal and plan are untouched.
  await answerSampleCheckin(date, "evening", text.id, { text: "Rain on the glass." });
  const kept = sampleDayNow(date).journal;
  await sampleRemoveSet(added.id);
  assert.equal(sampleDayNow(date).journal, kept);
  assert.ok((await sampleCheckin(date, "evening")).plan.some((q) => q.id === text.id));
  assert.ok(!(await sampleCheckinSettings()).own.some((q) => q.set === added.id));
});

test("journal: the owner's own written answer is copied, changed and undone with the day's journal; their own scale isn't", async () => {
  const view = await sampleCheckinSettings();
  const written = view.own.find((q) => q.id === "own_notice")!;
  const scale = view.own.find((q) => q.id === "own_walk")!;
  assert.deepEqual([written.type, written.mirror, scale.type, scale.mirror], ["text", "day_journal", "scale", null]);
  // A settings save can't point them anywhere else: sample mode applies Athena's rule as the server does.
  const tried = await saveSampleCheckinSettings({ ...view, own: view.own.map((q) => (q.id === scale.id ? { ...q, mirror: "day_mood" as const } : q.id === written.id ? { ...q, mirror: null } : q)) });
  assert.deepEqual([tried.own.find((q) => q.id === written.id)!.mirror, tried.own.find((q) => q.id === scale.id)!.mirror], ["day_journal", null]);
  await saveSampleCheckinSettings({ ...view, evening: { ...view.evening, questions: view.evening.questions.map((x) => (x.id === written.id || x.id === scale.id || x.id === "went_well" ? { ...x, pinned: true } : x)) } });
  const date = (() => {
    const d = new Date(`${localToday()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 5);
    return d.toISOString().slice(0, 10);
  })();
  const c = await sampleCheckin(date, "evening");
  assert.ok(c.plan.some((q) => q.id === written.id) && c.plan.some((q) => q.id === scale.id));
  const mine = sampleDayNow(date).journal ?? "";

  await answerSampleCheckin(date, "evening", "went_well", { text: "Mended the gate." });
  await answerSampleCheckin(date, "evening", written.id, { text: "Fog over the playing fields." });
  await answerSampleCheckin(date, "evening", scale.id, { scale: 2 });
  const j1 = sampleDayNow(date).journal ?? "";
  assert.match(j1, /Evening reflection\nWhat went well today\?\nMended the gate\.\n\nWhat did you notice on the way home\?\nFog over the playing fields\./);
  assert.doesNotMatch(j1, /How much time did you spend outside/);

  await answerSampleCheckin(date, "evening", written.id, { text: "Fog, then sun." });
  const j2 = sampleDayNow(date).journal ?? "";
  assert.equal(j2.match(/What did you notice on the way home\?/g)?.length, 1);
  assert.match(j2, /Fog, then sun\./);

  await answerSampleCheckin(date, "evening", written.id, null);
  const j3 = sampleDayNow(date).journal ?? "";
  assert.doesNotMatch(j3, /on the way home/);
  assert.match(j3, /Mended the gate\./);
  await answerSampleCheckin(date, "evening", "went_well", null);
  assert.equal(sampleDayNow(date).journal ?? "", mine);
  await saveSampleCheckinSettings(view);
});

test("journal: days already answered aren't back-filled with the owner's own written answers", async () => {
  // The seeded weeks have answers to own_notice on some evenings; none of them was copied in.
  const today = localToday();
  let seen = 0;
  for (let n = 1; n <= 21; n++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    const date = d.toISOString().slice(0, 10);
    const c = await sampleCheckin(date, "evening");
    const a = c.answers["own_notice"]?.value;
    if (!a || !("text" in a)) continue;
    seen++;
    assert.doesNotMatch(sampleDayNow(date).journal ?? "", new RegExp(a.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(seen > 0);
});
