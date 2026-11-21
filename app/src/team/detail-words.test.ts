import { test } from "node:test";
import assert from "node:assert/strict";
import type { TeamTrigger } from "../../../lib/team-types";
import { characterWords, firstStart, liveWords, looksWords, nextStart, pronouns, runLabel, startLine } from "./detail-words";

// Sunday 15 November 2026, 14:00 local time.
const NOW = new Date(2026, 10, 15, 14, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();

const trig = (t: Partial<TeamTrigger>): TeamTrigger => ({ id: "t1", assistant_id: "a", kind: "schedule", days: [], time: null, event: null, paused: false, last_slot: null, last_fired_at: null, created_at: at(1, 9), ...t });

test("pronouns follow the personality", () => {
  assert.deepEqual(pronouns({ pronoun: "she" }), { they: "she", them: "her", their: "her", plural: false });
  assert.equal(pronouns({ pronoun: "he" }).their, "his");
  assert.equal(pronouns({ pronoun: "they" }).plural, true);
});

test("starting sounds like the assistant", () => {
  assert.equal(startLine({ tone: "warm" }), "On it!");
  assert.equal(startLine({ tone: "crisp" }), "Starting now.");
  assert.equal(startLine({ tone: "wry" }), "Right. On it.");
});

test("a run says what set it off", () => {
  assert.equal(runLabel({ label: "New gift idea: “Lego”", trigger_id: null, event_id: null }), "New gift idea: “Lego”");
  const fri = trig({ id: "f", days: [5], time: "17:00" });
  assert.match(runLabel({ label: null, trigger_id: "f", event_id: null }, [fri]), /^Every Friday at (17:00|5:00 pm)$/);
  const gift = trig({ id: "g", kind: "event", event: { source: "saved", savedAction: "gift-idea" } });
  assert.equal(runLabel({ trigger_id: "g", event_id: "9" }, [gift]), "You save a gift idea");
  assert.equal(runLabel({ trigger_id: null, event_id: "9" }), "Something arrived");
  assert.equal(runLabel({ trigger_id: null, event_id: null }), "Run now");
});

test("a schedule's label is worded from its trigger, in this device's clock", () => {
  const fri = trig({ id: "f", days: [5], time: "17:00" });
  const server = { label: "Every Friday at 17:00", trigger_id: "f", event_id: null };
  assert.equal(runLabel(server, [fri], true), "Every Friday at 5:00 pm");
  assert.equal(runLabel(server, [fri], false), "Every Friday at 17:00");
  // No trigger to match (deleted since), or a label that isn't a schedule: the server's words stand.
  assert.equal(runLabel({ ...server, trigger_id: "gone" }, [fri], true), "Every Friday at 17:00");
  assert.equal(runLabel({ label: "3 new issues", trigger_id: "f", event_id: null }, [fri], true), "3 new issues");
});

test("a working run says what it's doing", () => {
  assert.equal(liveWords({ status: "running", step: "Checking prices" }), "Checking prices");
  assert.equal(liveWords({ status: "queued", step: null }), "About to start");
  assert.equal(liveWords({ status: "running" }), "Getting it done");
  assert.equal(liveWords({ status: "queued", step: null, retried: true }), "Trying again shortly");
});

test("the next scheduled start", () => {
  assert.equal(nextStart([trig({ days: [1], time: "10:00" })], NOW, false), "tomorrow at 10:00");
  assert.equal(nextStart([trig({ days: [0], time: "17:00" })], NOW, false), "today at 17:00");
  assert.equal(nextStart([trig({ days: [0], time: "09:00" })], NOW, false), "on Sunday at 9:00");
  assert.equal(nextStart([trig({ days: [5], time: "09:00" }), trig({ days: [3], time: "08:00" })], NOW, false), "on Wednesday at 8:00");
  assert.equal(nextStart([trig({ days: [0], time: "10:00", paused: true })], NOW, false), null);
  assert.equal(nextStart([trig({ kind: "event", event: { source: "note" } })], NOW, false), null);
});

test("an empty page says when it first starts", () => {
  assert.equal(firstStart("Acorn", [trig({ days: [1], time: "10:00" })], NOW, false), "Acorn starts tomorrow at 10:00.");
  assert.equal(firstStart("Penny", [trig({ kind: "event", event: { source: "saved", savedAction: "gift-idea" } })], NOW, false), "Penny starts when you save a gift idea.");
  assert.equal(firstStart("Acorn", [], NOW, false), "Acorn works when you ask.");
});

test("its looks and character as sentences", () => {
  assert.equal(
    looksWords({ v: 1, seed: "m", species: "cat", fur: "snow", accent: "pink", eyes: "sparkle", mouth: "small-smile", outfit: "hoodie", outfitColor: "berry", accessories: ["glasses", "heart-necklace"] }),
    "A white cat in a berry hoodie, with glasses and a heart necklace"
  );
  assert.equal(looksWords({ v: 1, seed: "a", species: "bunny", fur: "lilac", accent: "pink", eyes: "round", mouth: "small-smile", outfit: "overalls", outfitColor: "leaf", accessories: [] }), "A lilac bunny in leaf overalls");
  assert.equal(characterWords({ tone: "warm", traits: ["Thorough", "frugal"] }), "Warm, thorough and frugal");
});
