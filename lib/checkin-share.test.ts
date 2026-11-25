// Shared check-in questions (lib/checkin-share.ts): the reader, making one from the owner's questions, joining one to
// a set-up (skipping words already here, never switching a routine on), removing a set, switched-off sets, the reach
// and the round trip. Made-up questions and people only. Nothing needs a database.
// Run: npx tsx --test lib/checkin-share.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askable,
  CHECKIN_SHARE_LIMITS,
  checkinSlug,
  exportCheckins,
  joinSharedCheckins,
  readSharedCheckins,
  removeSetFrom,
  samePrompt,
  serialiseSharedCheckins,
  type SharedCheckins,
} from "./checkin-share";
import { reachOf, reachOfCheckins } from "./reach";
import { detectKind } from "./share-kinds";
import { planFor } from "./checkin-plan";
import { DEFAULT_CHECKIN_SETTINGS, MAX_OWN_QUESTIONS, PRESET_QUESTIONS, type CheckinQuestion, type CheckinSettings } from "./checkin-types";
import { ShareFormatError, type KnownTerm } from "./team-share";

const SET_ID = "5b1d2c3e-4f50-4a61-8b72-9c83d4e5f601";

const FILE = {
  format: 1,
  name: "Small joys",
  summary: "Three gentle questions for the end of the day.",
  version: "1.0",
  author: "quiet-desk",
  questions: [
    { prompt: "What made you smile today?", kinds: ["evening"], type: "text", placeholder: "Something small counts.", deeper: true },
    { prompt: "How kind were you to yourself?", kinds: ["morning", "evening"], type: "scale", lead: "Today I was", levels: ["hard on myself", "a bit harsh", "fair", "kind", "very kind"], low: "Harsh", high: "Kind" },
    { prompt: "Who did you feel close to?", kinds: ["evening"], type: "choices", options: ["Family", "A friend", "A neighbour"], more: ["Nobody today"] },
  ],
};

const settings = (over: Partial<CheckinSettings> = {}): CheckinSettings => ({ ...structuredClone(DEFAULT_CHECKIN_SETTINGS), ...over });
let n = 0;
const newId = () => `own_test${++n}`;

// ---------- reading one ----------

test("read: the file as written, with the header every shared file may carry", () => {
  const s = readSharedCheckins(FILE);
  assert.equal(s.name, "Small joys");
  assert.equal(s.author, "quiet-desk");
  assert.equal(s.version, "1.0");
  assert.equal(s.questions.length, 3);
  assert.deepEqual(s.questions[0], FILE.questions[0]);
  assert.deepEqual(s.questions[1].kinds, ["morning", "evening"]);
});

test("read: unknown keys, the owner's own fields and another type's fields are dropped", () => {
  const s = readSharedCheckins({
    ...FILE,
    colour: "green",
    questions: [{ ...FILE.questions[0], id: "own_abc", mirror: "health_stress", pinned: true, answers: ["secret"], options: ["not for text"], per_day: 3 }],
  });
  assert.equal("colour" in s, false);
  assert.deepEqual(Object.keys(s.questions[0]).sort(), ["deeper", "kinds", "placeholder", "prompt", "type"]);
});

test("read: an unknown kind of answer is refused, naming the question and what Athena knows", () => {
  assert.throws(
    () => readSharedCheckins({ ...FILE, questions: [FILE.questions[0], { prompt: "Rate the sunset", kinds: ["evening"], type: "stars" }] }),
    (e: unknown) => e instanceof ShareFormatError && /Question 2, “Rate the sunset”, is answered with “stars”/.test(e.message) && /a scale, choices, life areas and a written answer/.test(e.message),
  );
});

test("read: limits come from the check-in limits, and anything else that doesn't fit is refused in words", () => {
  const refuses = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => readSharedCheckins({ ...FILE, ...patch }), (e: unknown) => e instanceof ShareFormatError && re.test(e.message));
  const q = (over: Record<string, unknown>) => ({ questions: [{ ...FILE.questions[0], ...over }] });
  refuses({ format: 2 }, /newer Athena/);
  refuses({ format: undefined }, /"format": 1/);
  refuses({ name: "" }, /name: missing/);
  refuses({ name: "x".repeat(CHECKIN_SHARE_LIMITS.name + 1) }, /name: over/);
  refuses({ questions: [] }, /at least one question/);
  refuses({ questions: Array.from({ length: MAX_OWN_QUESTIONS + 1 }, (_, i) => ({ ...FILE.questions[0], prompt: `Question ${i}?` })) }, /40 at most/);
  refuses(q({ prompt: "x".repeat(201) }), /prompt: over 200/);
  refuses(q({ kinds: ["afternoon"] }), /kinds/);
  refuses(q({ kinds: [] }), /kinds/);
  refuses(q({ deeper: "yes" }), /deeper: true or false/);
  refuses({ questions: [FILE.questions[1], { ...FILE.questions[1], levels: ["a", "b"] }] }, /five/);
  refuses({ questions: [{ ...FILE.questions[2], options: [] }] }, /at least 1/);
  refuses({ questions: [{ ...FILE.questions[2], more: ["Family"] }] }, /not already in options/);
  refuses({ questions: [FILE.questions[0], { ...FILE.questions[0], prompt: "what made you SMILE today" }] }, /in it twice/);
  assert.throws(() => readSharedCheckins([FILE]), /should hold an object/);
});

test("read: words are one line, control characters out", () => {
  const s = readSharedCheckins({ ...FILE, name: "  Small\n joys\u0007 ", questions: [{ ...FILE.questions[0], prompt: "What made\tyou smile?" }] });
  assert.equal(s.name, "Small joys");
  assert.equal(s.questions[0].prompt, "What made you smile?");
});

test("samePrompt: case, spacing and the punctuation at the end don't make a question new", () => {
  assert.equal(samePrompt("What went well today?"), samePrompt("  what went  well today "));
  assert.notEqual(samePrompt("What went well today?"), samePrompt("What went well this week?"));
});

// ---------- the kind, and its reach ----------

test("checkin.json names the kind", () => {
  assert.equal(detectKind(["small-joys/checkin.json"]), "checkin");
  assert.equal(detectKind(["small-joys/checkin.json", "small-joys/flow.json"]), null);
});

test("reach: always tier 1, even when a question offers Go deeper (the owner taps it each time)", () => {
  const plain = readSharedCheckins({ ...FILE, questions: FILE.questions.map((q) => ({ ...q, deeper: false })) });
  const tier1 = { tier: 1, model: false, web: false, lookups: [], needs: [] };
  assert.deepEqual(reachOfCheckins(plain), tier1);
  assert.deepEqual(reachOfCheckins(readSharedCheckins(FILE)), tier1);
  assert.equal(reachOf({ files: [{ path: "checkin.json", text: JSON.stringify(plain) }] }).tier, 1);
  assert.equal(reachOf({ kind: "checkin", files: [{ path: "checkin.json", text: JSON.stringify(FILE) }] }).tier, 1);
});

// ---------- making one ----------

const known: KnownTerm[] = [
  { term: "Robin Example", kind: "person" },
  { term: "Robin", kind: "person", loose: true },
  { term: "Elm Street Allotment", kind: "place" },
];

const own = (over: Partial<CheckinQuestion>): CheckinQuestion => ({ id: "own_a", type: "text", prompt: "What did you notice outside?", kinds: ["evening"], placeholder: "", deeper: false, mirror: "day_journal", preset: false, ...over });

test("export: only words and how each is answered go, links into the site come out, the owner's details are flagged", () => {
  const qs = [
    own({ id: "own_a", prompt: "Did you call Robin today?", placeholder: "Notes: https://athena.example.com/#/people/123" }),
    own({ id: "own_b", type: "scale", prompt: "How was the walk to Elm Street Allotment?", lead: "The walk was", levels: ["hard", "slow", "fine", "good", "lovely"], low: "Hard", high: "Lovely", placeholder: undefined, deeper: undefined, mirror: "day_mood" }),
  ];
  const x = exportCheckins(qs, { ownHosts: ["athena.example.com"], known, edits: { name: "Evening wind-down", summary: "Two questions to end the day.", author: "@quiet-desk", version: "1.0" } });
  assert.equal(x.slug, "evening-wind-down");
  assert.equal(x.shared.author, "quiet-desk");
  assert.deepEqual(x.removed, [{ kind: "site-link", count: 1 }]);
  assert.ok(!JSON.stringify(x.shared).includes("athena.example.com"));
  for (const k of ["id", "mirror", "preset", "set", "pinned"]) assert.ok(!JSON.stringify(x.shared.questions).includes(`"${k}"`), k);
  const where = Object.fromEntries(x.findings.map((f) => [f.term, f.where]));
  assert.deepEqual(where, { Robin: ["question:1"], "Elm Street Allotment": ["question:2"] });
  // Marked fine, they stay settled.
  const again = exportCheckins(qs, { ownHosts: ["athena.example.com"], known, edits: { name: "Evening wind-down" }, fine: x.findings.map((f) => f.id) });
  assert.deepEqual(again.findings, []);
});

test("export: a name and at least one question are needed", () => {
  assert.throws(() => exportCheckins([own({})], { ownHosts: [], known: [], edits: {} }), /name/);
  assert.throws(() => exportCheckins([], { ownHosts: [], known: [], edits: { name: "Empty" } }), /at least one/);
  assert.equal(checkinSlug("Évening — wind down!"), "evening-wind-down");
});

test("round trip: exported, written, read back and joined, each question is asked as it was written", () => {
  const mine = [own({ id: "own_a", prompt: "What did you notice outside?", placeholder: "A sound, a colour, the weather.", deeper: true }), own({ id: "own_b", type: "areas", prompt: "Where did your time go?", kinds: ["morning", "evening"], options: ["Work", "Rest"], more: ["Garden"], placeholder: undefined, deeper: undefined, mirror: null })];
  const x = exportCheckins(mine, { ownHosts: [], known: [], edits: { name: "Noticing" } });
  const back = readSharedCheckins(JSON.parse(serialiseSharedCheckins(x.shared)));
  assert.deepEqual(back, x.shared);
  const j = joinSharedCheckins(settings(), back, { setId: SET_ID, newId });
  const added = j.settings.own.filter((q) => q.set === SET_ID);
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(
    plain(added.map(({ id: _i, set: _s, mirror: _m, preset: _p, ...rest }) => rest)),
    plain(mine.map(({ id: _i, mirror: _m, preset: _p, ...rest }) => rest)),
  );
});

// ---------- adding one ----------

test("join: questions join the owner's own and the end of their routines, unpinned; nothing there moves", () => {
  const before = settings({ own: [own({ id: "own_mine" })] });
  before.evening.questions.push({ id: "own_mine", pinned: true });
  const j = joinSharedCheckins(before, readSharedCheckins(FILE), { setId: SET_ID, newId });
  assert.equal(j.added.length, 3);
  assert.deepEqual(j.skipped, []);
  // What was there is still first, in the same order, with the same pins.
  assert.deepEqual(j.settings.evening.questions.slice(0, before.evening.questions.length), before.evening.questions);
  assert.deepEqual(j.settings.morning.questions.slice(0, before.morning.questions.length), before.morning.questions);
  assert.deepEqual(j.settings.own[0], before.own[0]);
  // Then the new ones, in the set's order, unpinned, in each routine they're asked in.
  const [smile, kind, close] = j.added;
  assert.deepEqual(j.settings.evening.questions.slice(-3), [smile, kind, close].map((id) => ({ id, pinned: false })));
  assert.deepEqual(j.settings.morning.questions.slice(-1), [{ id: kind, pinned: false }]);
  // Each is one of the owner's own now, from the set, its answers copied nowhere.
  for (const q of j.settings.own.slice(1)) {
    assert.equal(q.set, SET_ID);
    assert.equal(q.preset, false);
    assert.equal(q.mirror, null);
  }
  assert.equal(j.settings.evening.per_day, before.evening.per_day);
  // The input wasn't changed.
  assert.equal(before.own.length, 1);
});

test("join: a question whose words are already here (Athena's or the owner's) is skipped, and says so", () => {
  const mine = own({ id: "own_mine", prompt: "Who did you feel close to" });
  const shared = readSharedCheckins({ ...FILE, questions: [...FILE.questions, { prompt: "What are you grateful for?", kinds: ["morning"], type: "text" }] });
  const j = joinSharedCheckins(settings({ own: [mine] }), shared, { setId: SET_ID, newId });
  assert.deepEqual(j.skipped, ["Who did you feel close to?", "What are you grateful for?"]);
  assert.equal(j.added.length, 2);
  assert.ok(PRESET_QUESTIONS.some((q) => q.prompt === "What are you grateful for?"));
});

test("join: a routine that's off stays off, and is named", () => {
  const off = settings();
  assert.equal(off.evening.enabled, false);
  off.morning.enabled = true;
  const j = joinSharedCheckins(off, readSharedCheckins(FILE), { setId: SET_ID, newId });
  assert.equal(j.settings.morning.enabled, true);
  assert.equal(j.settings.evening.enabled, false);
  assert.deepEqual(j.off, ["evening"]);
  // Only routines the new questions joined count.
  const morningOnly = readSharedCheckins({ ...FILE, questions: [{ prompt: "What's one slow thing you'll do today?", kinds: ["morning"], type: "text" }] });
  assert.deepEqual(joinSharedCheckins(off, morningOnly, { setId: SET_ID, newId }).off, []);
});

test("join: near the limit of the owner's own questions, as many as fit are added in order and the rest named", () => {
  const nearly = settings({ own: Array.from({ length: MAX_OWN_QUESTIONS - 1 }, (_, i) => own({ id: `own_${i}`, prompt: `Mine ${i}?` })) });
  const j = joinSharedCheckins(nearly, readSharedCheckins(FILE), { setId: SET_ID, newId });
  assert.equal(j.added.length, 1);
  assert.equal(j.settings.own.length, MAX_OWN_QUESTIONS);
  assert.equal(j.settings.own.at(-1)?.prompt, FILE.questions[0].prompt);
  assert.deepEqual(j.full, [FILE.questions[1].prompt, FILE.questions[2].prompt]);
  // Full already: nothing joins, everything is named.
  const at = joinSharedCheckins(j.settings, readSharedCheckins({ ...FILE, questions: [{ prompt: "One more?", kinds: ["evening"], type: "text" }] }), { setId: SET_ID, newId });
  assert.deepEqual([at.added, at.full], [[], ["One more?"]]);
  // With room, nothing is left out.
  assert.deepEqual(joinSharedCheckins(settings(), readSharedCheckins(FILE), { setId: SET_ID, newId }).full, []);
});

// ---------- removing, switching off ----------

test("remove: a set's questions come out of the owner's own and both routines; nothing else changes", () => {
  const before = settings({ own: [own({ id: "own_mine" })] });
  before.evening.questions.push({ id: "own_mine", pinned: true });
  const j = joinSharedCheckins(before, readSharedCheckins(FILE), { setId: SET_ID, newId });
  const other = joinSharedCheckins(j.settings, readSharedCheckins({ ...FILE, name: "Other", questions: [{ prompt: "What can wait until tomorrow?", kinds: ["evening"], type: "text" }] }), { setId: "11111111-2222-4333-8444-555555555555", newId });
  const after = removeSetFrom(other.settings, SET_ID);
  assert.deepEqual(after.own.map((q) => q.id), ["own_mine", other.added[0]]);
  assert.deepEqual(after.evening.questions, [...before.evening.questions, { id: other.added[0], pinned: false }]);
  assert.deepEqual(after.morning.questions, before.morning.questions);
});

test("switched off: a paused set's questions aren't planned; switched back on, they are", () => {
  const s = settings();
  s.evening.enabled = true;
  s.evening.per_day = 10;
  const j = joinSharedCheckins(s, readSharedCheckins(FILE), { setId: SET_ID, newId });
  const library = [...PRESET_QUESTIONS, ...j.settings.own];
  const planned = (paused: Set<string>) => planFor(j.settings.evening, askable(library, paused), {}, "evening").map((q) => q.id);
  assert.ok(j.added.every((id) => planned(new Set()).includes(id)));
  assert.ok(j.added.every((id) => !planned(new Set([SET_ID])).includes(id)));
  // The owner's own and Athena's are still asked.
  assert.ok(planned(new Set([SET_ID])).includes("mood"));
});

test("the file's questions type-check as shared questions", () => {
  const s: SharedCheckins = readSharedCheckins(FILE);
  assert.equal(s.format, 1);
});
