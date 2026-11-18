// Setup's saved draft: old five-step drafts come back as the conversation. Run: npx tsx --test app/src/team/setup-draft.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { emptyDraft, loadSetup, saveSetup } = await import("./setup-draft");

const avatar = { v: 1, seed: "s", species: "cat", fur: "snow", accent: "pink", eyes: "round", mouth: "small-smile", outfit: "tee", outfitColor: "oat", accessories: [] };
const q = (id: string) => ({ id, question: `${id}?`, choices: ["a", "b"], allowOther: true });
const put = (d: Record<string, unknown>) => store.set("athena.team.setup", JSON.stringify({ v: 1, text: "Sum up my week", seed: "s", avatar, savedAt: Date.now(), ...d }));

beforeEach(() => store.clear());

test("a new draft starts at the job with nothing asked", () => {
  const d = emptyDraft("Hello");
  assert.equal(d.step, 0);
  assert.equal(d.asked, 0);
  assert.equal(d.skipped, false);
});

test("an old draft on the questions step comes back mid-talk, nothing asked yet", () => {
  put({ step: 1, questions: [q("q1"), q("q2")], answers: { q1: "a" } });
  const d = loadSetup()!;
  assert.equal(d.step, 1);
  assert.equal(d.asked, 0);
});

test("an old draft past the questions comes back with every question asked", () => {
  put({ step: 3, questions: [q("q1"), q("q2")], answers: {} });
  assert.equal(loadSetup()!.asked, 2);
  put({ step: 4 }); // before setup had questions at all
  const d = loadSetup()!;
  assert.equal(d.step, 1);
  assert.equal(d.asked, 0);
  assert.deepEqual(d.questions, []);
});

test("a new draft keeps its place, clamped to the questions it has", () => {
  saveSetup({ ...emptyDraft("Sum up my week"), step: 1, seed: "s", avatar: avatar as never, questions: [q("q1")], asked: 5, skipped: true });
  const d = loadSetup()!;
  assert.equal(d.asked, 1);
  assert.equal(d.skipped, true);
});

test("a talk with no character to stand on goes back to the job", () => {
  put({ step: 1, seed: null, avatar: null });
  assert.equal(loadSetup()!.step, 0);
});

test("looking things up online: off by default, proposed when the draft said so, kept as you left it", () => {
  const fresh = emptyDraft();
  assert.equal(fresh.web, false);
  assert.equal(fresh.webSuggested, false);
  // A draft saved before the switch existed: off, and not proposed.
  put({ step: 1 });
  assert.deepEqual([loadSetup()!.web, loadSetup()!.webSuggested], [false, false]);
  // Proposed and turned off at hiring: stays off.
  put({ step: 1, webSuggested: true, web: false });
  assert.deepEqual([loadSetup()!.web, loadSetup()!.webSuggested], [false, true]);
  put({ step: 1, webSuggested: true, web: true });
  assert.equal(loadSetup()!.web, true);
  // Never on unless it was proposed: the switch only shows when it was.
  put({ step: 1, webSuggested: false, web: true });
  assert.equal(loadSetup()!.web, false);
});
