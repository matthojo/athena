// The morning hello in a voice (docs/notes/affection-2026-11.md, moment 4): the writer's line saved
// with the note, and the opt-in short briefing after a hard day.
// Run: npx tsx --test lib/briefing-go-easy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefingPayload, briefingSystem, draftProblems, hardDay, readWriterProfile, shortNightUnder, HARD_DAY_KEY } from "./briefing-writer";
import { bodyWithLead, deliverBriefing, type DeliverDeps } from "./briefing-run";
import { buildBriefing } from "./briefing";
import { busyDay, quietDay } from "./briefing-writer.fixtures";

const fact = (key: string, value: string) => ({ subject_kind: "me", key, value, superseded_at: null, archived_at: null });

test("the hard-day choice is off unless the owner said Yes", () => {
  assert.equal(readWriterProfile([]).hardDayShort, false);
  assert.equal(readWriterProfile([fact(HARD_DAY_KEY, "No")]).hardDayShort, false);
  assert.equal(readWriterProfile([fact(HARD_DAY_KEY, "Yes")]).hardDayShort, true);
  assert.equal(readWriterProfile([{ ...fact(HARD_DAY_KEY, "Yes"), archived_at: "2026-11-01" }]).hardDayShort, false);
});

test("a hard day: yesterday Awful or Low, or a night short for this owner", () => {
  assert.equal(hardDay({ mood: 1 }), true);
  assert.equal(hardDay({ mood: 2 }), true);
  assert.equal(hardDay({ mood: 3 }), false);
  assert.equal(hardDay({}), false);
  // Few nights to go on: under six hours is short.
  assert.equal(hardDay({ sleep_minutes: 340 }), true);
  assert.equal(hardDay({ sleep_minutes: 400 }), false);
  // A long sleeper's bottom quarter is higher, capped at 7 hours; a short sleeper's floor is 5.
  const long = Array.from({ length: 20 }, (_, i) => 450 + i * 5);
  assert.equal(shortNightUnder(long), 420);
  assert.equal(hardDay({ sleep_minutes: 410, nights: long }), true);
  const short = Array.from({ length: 20 }, (_, i) => 280 + i * 3);
  assert.equal(shortNightUnder(short), 300);
  assert.equal(shortNightUnder([400, 420]), 360);
});

test("go_easy keeps only today's essentials: no catch-ups, picks, week ahead, chasing or inbox", () => {
  const normal = briefingPayload(busyDay()).payload;
  assert.ok(normal.must_do.week_ahead || normal.room_for_you || normal.review_inbox, "the busy day has extras to drop");
  const easy = briefingPayload({ ...busyDay(), goEasy: true }).payload;
  assert.equal(easy.go_easy, true);
  assert.equal(easy.length, "short");
  assert.equal(easy.must_do.week_ahead, undefined);
  assert.equal(easy.must_do.waiting_quiet, undefined);
  assert.equal(easy.room_for_you, undefined);
  assert.equal(easy.review_inbox, undefined);
  assert.equal(easy.yesterday, undefined);
  const text = JSON.stringify(easy);
  assert.ok(!/last_spoke|days_late|catch_up/.test(text), text);
  // Today's own events stay.
  assert.deepEqual(easy.must_do.today, normal.must_do.today);
  // Without the flag nothing changes: off by default.
  assert.equal(briefingPayload(quietDay()).payload.go_easy, undefined);
});

test("the prompt asks for a light briefing that never says why, and a draft that says why goes back", () => {
  const system = briefingSystem(busyDay());
  assert.match(system, /go_easy/);
  assert.match(system, /Never say why it's light/);
  const links = new Set<string>();
  const ok = { body: "## Must do\n- 08:55 to Bristol", push: "A light one today. Just the 08:55 to Bristol. Everything else can wait." };
  assert.deepEqual(draftProblems(ok, links, [], { goEasy: true }), []);
  const why = { body: ok.body, push: "After yesterday's low mood, just the 08:55 to Bristol." };
  assert.equal(draftProblems(why, links, [], { goEasy: true }).length, 1);
  assert.equal(draftProblems({ body: ok.body, push: "Slept badly? Just the train today." }, links, [], { goEasy: true }).length, 1);
  // The same words are fine on an ordinary morning.
  assert.deepEqual(draftProblems(why, links, []), []);
});

test("the writer's line is saved at the top of the note; the data briefing is stored as it is", async () => {
  assert.equal(bodyWithLead("## Must do\n- Dentist", "Morning, Sam. Dentist at 09:30."), "> Morning, Sam. Dentist at 09:30.\n\n## Must do\n- Dentist");
  assert.equal(bodyWithLead("## Must do", undefined), "## Must do");
  assert.equal(bodyWithLead("## Must do", "  "), "## Must do");
  const bodies: string[] = [];
  const claimed = new Set<string>();
  const deps: DeliverDeps = {
    async claim(k) {
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    async release(k) {
      claimed.delete(k);
    },
    async createNote(n) {
      bodies.push(n.body);
      return { id: "n1" };
    },
    async push() {},
  };
  const data = buildBriefing(busyDay().data);
  await deliverBriefing({ ...data, body: "## Must do\n- Dentist", digest: "Morning, Sam.", lead: "Morning, Sam." }, { push: true }, deps);
  assert.equal(bodies[0], "> Morning, Sam.\n\n## Must do\n- Dentist");
  claimed.clear();
  await deliverBriefing(data, { push: true }, deps);
  assert.equal(bodies[1], data.body);
});

test("the model never sees the hard-day choice in the profile", () => {
  const input = { ...busyDay(), profileBlock: "About the owner:\nHow to help:\n- Tone: Gentle\n- Hard day briefing: Yes" };
  const system = briefingSystem(input);
  assert.match(system, /- Tone: Gentle/);
  assert.ok(!system.includes("Hard day briefing: Yes"));
});
