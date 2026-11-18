// The owner's profile, pure parts: grouping, the prompt block, briefing help and setup progress.
// Run: npx tsx --test lib/profile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fact } from "./memory";
import { buildBriefing } from "./briefing";
import {
  applySetupChange,
  EMPTY_SETUP,
  groupProfile,
  parseProfileEdits,
  parseSetupChange,
  PROFILE_BLOCK_MAX,
  PROFILE_FIELDS,
  PROFILE_STEP_IDS,
  readAskWeb,
  readBriefingHelp,
  readSetup,
  renderProfileBlock,
} from "./profile";

let n = 0;
function fact(key: string, value: string, extra: Partial<Fact> = {}): Fact {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
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
  };
}

test("catalogue: four steps, every field in one of them, keys unique", () => {
  // You and your people first; work comes third (docs/notes/affection-2026-11.md, moment 3).
  assert.deepEqual(PROFILE_STEP_IDS, ["about", "routines", "work", "help"]);
  // Examples are neutral, never the owner's own details.
  assert.deepEqual(PROFILE_FIELDS.filter((f) => f.step === "about").map((f) => f.key), ["Name", "Home town", "Region", "Lives with", "Important people"]);
  assert.ok(!PROFILE_FIELDS.some((f) => /Jordan|Bristol|Netlify/.test(f.hint ?? "")));
  const keys = PROFILE_FIELDS.map((f) => f.key.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  for (const f of PROFILE_FIELDS) assert.ok(PROFILE_STEP_IDS.includes(f.step), f.key);
  for (const f of PROFILE_FIELDS.filter((f) => f.input === "choice")) assert.ok(f.options?.length, f.key);
});

test("groupProfile: catalogue keys by section, case-insensitive; anything else under Other", () => {
  const sections = groupProfile([fact("home town", "Bristol"), fact("Coffee order", "Oat flat white"), fact("Briefing length", "Short", { confidence: 0.9 })]);
  assert.deepEqual(sections.map((s) => s.id), ["about", "routines", "work", "help", "other"]);
  const home = sections[0].fields.find((f) => f.key === "Home town")!;
  assert.equal(home.fact?.value, "Bristol");
  assert.equal(home.owner_typed, true);
  const length = sections[3].fields.find((f) => f.key === "Briefing length")!;
  assert.equal(length.owner_typed, false);
  assert.equal(sections[2].fields.find((f) => f.key === "Role")!.fact, null);
  assert.deepEqual(sections[4].fields.map((f) => [f.key, f.fact?.value]), [["Coffee order", "Oat flat white"]]);
});

test("prompt block: empty when there's nothing to say", () => {
  assert.equal(renderProfileBlock([]), "");
  // Only history, archived or someone else's facts: still nothing.
  assert.equal(
    renderProfileBlock([
      fact("Name", "Old", { superseded_at: "2026-11-02T00:00:00Z" }),
      fact("Role", "Gone", { archived_at: "2026-11-02T00:00:00Z" }),
      fact("Role", "Friend", { subject_kind: "person", subject_id: "11111111-1111-4111-8111-111111111111" }),
    ]),
    "",
  );
});

test("prompt block: current values only, links as names, sections in order", () => {
  const block = renderProfileBlock([
    fact("Name", "Jordan"),
    fact("Name", "Jordan Reeve", { superseded_at: "2026-11-02T00:00:00Z" }),
    fact("Lives with", "[@Rowan Hill](athena://person/11111111-1111-4111-8111-111111111111), [@Rex](athena://person/22222222-2222-4222-8222-222222222222)"),
    fact("Never nudge about", "Weight"),
    fact("Coffee order", "Oat flat white"),
  ]);
  assert.match(block, /- Name: Jordan\n/);
  assert.doesNotMatch(block, /Jordan Reeve/);
  assert.match(block, /- Lives with: Rowan Hill, Rex/);
  assert.doesNotMatch(block, /athena:\/\//);
  assert.ok(block.indexOf("You and your people:") < block.indexOf("How to help:"));
  assert.ok(block.indexOf("How to help:") < block.indexOf("Other:"));
  assert.doesNotMatch(block, /Routines and taste:/);
});

test("prompt block: stays under the cap however much there is", () => {
  const long = "x".repeat(900);
  const facts = [...PROFILE_FIELDS.map((f) => fact(f.key, long)), ...Array.from({ length: 30 }, (_, i) => fact(`Extra ${i}`, long))];
  const block = renderProfileBlock(facts);
  assert.ok(block.length > 0);
  assert.ok(block.length <= PROFILE_BLOCK_MAX, `${block.length}`);
  // Each value is trimmed, so several still fit; the catalogue goes first.
  assert.match(block, /- Name: x+…/);
  assert.doesNotMatch(block, /Extra 29/);
});

test("briefing help: length and never-nudge topics from the profile", () => {
  assert.deepEqual(readBriefingHelp([]), { length: "standard", neverNudge: [] });
  const help = readBriefingHelp([fact("briefing length", "Short"), fact("Never nudge about", "Weight, money; Dad")]);
  assert.deepEqual(help, { length: "short", neverNudge: ["weight", "money", "dad"] });
  assert.equal(readBriefingHelp([fact("Briefing length", "As long as you like")]).length, "standard");
});

test("briefing: never nudges about the owner's topics, and short leaves out catch-ups", () => {
  const now = new Date("2026-11-09T08:00:00Z");
  const base = {
    now,
    tz: "Europe/London",
    events: [],
    people: [],
    recentNotes: [],
    catchUps: [
      { id: "11111111-1111-4111-8111-111111111111", name: "Dad", last_contacted_at: null },
      { id: "22222222-2222-4222-8222-222222222222", name: "Priya", last_contacted_at: null },
    ],
    waiting: [
      { id: "a", title: "Money back for the tickets", kind: "waiting_on", due_on: null, person: null, updated_at: "2026-11-01T00:00:00Z" },
      { id: "b", title: "Intro deck", kind: "waiting_on", due_on: null, person: null, updated_at: "2026-11-01T00:00:00Z" },
    ],
  };
  const plain = buildBriefing(base).body;
  assert.match(plain, /Money back/);
  assert.match(plain, /@Dad/);
  const kept = buildBriefing({ ...base, help: { length: "standard", neverNudge: ["money", "dad"] } }).body;
  assert.doesNotMatch(kept, /Money back/);
  assert.doesNotMatch(kept, /@Dad/);
  assert.match(kept, /Intro deck/);
  assert.match(kept, /@Priya/);
  const short = buildBriefing({ ...base, help: { length: "short", neverNudge: [] } }).body;
  assert.doesNotMatch(short, /## Catch up/);
  assert.match(short, /## Waiting on/);
});

test("PUT body: checked, keys matched to the catalogue's spelling", () => {
  assert.deepEqual(parseProfileEdits({ values: [{ key: " home  town ", value: " Bristol " }, { key: "Role", value: "" }] }), [
    { key: "Home town", value: "Bristol" },
    { key: "Role", value: "" },
  ]);
  assert.throws(() => parseProfileEdits({}), /values/);
  assert.throws(() => parseProfileEdits({ values: [{ key: "Role" }] }), /key and a value/);
  assert.throws(() => parseProfileEdits({ values: [{ key: "Role", value: "a" }, { key: "role", value: "b" }] }), /twice/);
});

test("setup progress: resume, skip, finish, run again", () => {
  assert.deepEqual(readSetup(null), EMPTY_SETUP);
  assert.deepEqual(readSetup({ step: "nope", skipped: ["about", "x", "about"], completed_at: "bad" }), { ...EMPTY_SETUP, skipped: ["about"] });
  const now = new Date("2026-11-08T12:00:00Z");
  let p = applySetupChange(EMPTY_SETUP, parseSetupChange({ step: "routines", skip: "about" }), now);
  assert.deepEqual(p, { version: 1, step: "routines", completed_at: null, skipped: ["about"], started_at: null });
  p = applySetupChange(p, parseSetupChange({ complete: true }), now);
  assert.equal(p.completed_at, "2026-11-08T12:00:00.000Z");
  p = applySetupChange(p, parseSetupChange({ restart: true, step: "about" }), now);
  assert.deepEqual(p, { version: 1, step: "about", completed_at: null, skipped: [], started_at: null });
  assert.throws(() => parseSetupChange({}), /Nothing to change/);
  assert.throws(() => parseSetupChange({ step: "people" }), /step/);
});

test("setup progress: the first week starts once, and running setup again keeps it", () => {
  const first = new Date("2026-11-09T08:10:00Z");
  let p = applySetupChange(EMPTY_SETUP, parseSetupChange({ start: true }), first);
  assert.equal(p.started_at, "2026-11-09T08:10:00.000Z");
  p = applySetupChange(p, parseSetupChange({ start: true }), new Date("2026-11-10T08:00:00Z"));
  assert.equal(p.started_at, "2026-11-09T08:10:00.000Z");
  p = applySetupChange(p, parseSetupChange({ restart: true, step: "about" }), new Date("2026-11-12T08:00:00Z"));
  assert.equal(p.started_at, "2026-11-09T08:10:00.000Z");
  assert.equal(readSetup({ started_at: "bad" }).started_at, null);
  assert.equal(readSetup({ started_at: "2026-11-09T08:10:00.000Z" }).started_at, "2026-11-09T08:10:00.000Z");
  assert.throws(() => parseSetupChange({ start: "yes" }), /start/);
});

test("Let Ask search the web is on until the owner turns it off", () => {
  assert.equal(readAskWeb(undefined), true);
  assert.equal(readAskWeb(null), true);
  assert.equal(readAskWeb({}), true);
  assert.equal(readAskWeb({ on: true }), true);
  assert.equal(readAskWeb({ on: false }), false);
  assert.equal(readAskWeb({ on: "false" }), true, "only a real false turns it off");
});
