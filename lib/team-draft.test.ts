// Team setup's draft (lib/team-draft.ts): the model's proposal made to fit (real tools only, triggers
// that hold up, a job of 60 characters, a name or null, a fresh seed), and the plain fallback from the
// sentence when the model can't help.
// Run: npx tsx --test lib/team-draft.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipJob, draftAssistant, fallbackDraft, fitDraft, guessSchedule, MAX_DRAFT_JOB } from "./team-draft";
import { allowableTools } from "./team-chat";
import { TOOLS } from "./assistant";
import { GIFT_PRICES, JUNK, OVERREACH, WEEKLY_SUMMARY } from "./team-draft.fixtures";

const tools = allowableTools(TOOLS);

test("the allowlist offered is real change tools only", () => {
  const all = new Set(TOOLS.map((t) => t.name));
  assert.ok(tools.length > 10);
  for (const t of tools) assert.ok(all.has(t), t);
  for (const t of ["add_todo", "save_note", "add_to_list"]) assert.ok(tools.includes(t), t);
  // Looking, reading, a tap of the owner's own, or the runner's: never on an allowlist.
  for (const t of ["find_notes", "goals", "weather", "draft_message", "answer_invite", "save_routine", "check_with_assistant"]) assert.ok(!tools.includes(t), t);
});

test("a clean draft comes through, with a fresh seed", () => {
  const d = fitDraft(GIFT_PRICES, tools, "seed1")!;
  assert.equal(d.name, "Muse");
  assert.equal(d.job, "Finds good prices for gift ideas");
  assert.deepEqual(d.allow, ["add_todo"]);
  assert.deepEqual(d.triggers, [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }]);
  assert.equal(d.seed, "seed1");
  const w = fitDraft(WEEKLY_SUMMARY, tools, "seed2")!;
  assert.equal(w.name, null, "no name: the app names it from the seed");
  assert.deepEqual(w.triggers, [{ kind: "schedule", days: [5], time: "17:00" }]);
});

test("an overreaching draft is cut down to what holds up", () => {
  const d = fitDraft(OVERREACH, tools, "s")!;
  assert.ok(d.job.length <= MAX_DRAFT_JOB, d.job);
  assert.ok(!/\s$/.test(d.job) && d.job.startsWith("Watches Linear"));
  assert.ok(d.name && d.name.length <= 40 && !d.name.includes("<"), String(d.name));
  assert.deepEqual(d.allow, ["add_todo"], "unknown, read-only and tap-first tools dropped, no repeats");
  assert.deepEqual(d.triggers, [{ kind: "event", event: { source: "collected", connector: "linear", kind: "issue", match: "assigned" } }]);
});

test("junk is no draft", () => {
  for (const j of JUNK) assert.equal(fitDraft(j, tools), null, JSON.stringify(j));
});

test("clipJob cuts at a word", () => {
  assert.equal(clipJob("Finds good prices."), "Finds good prices");
  const long = clipJob("word ".repeat(40));
  assert.ok(long.length <= 60 && !long.endsWith(" "));
});

test("the fallback reads a schedule from the sentence", () => {
  assert.deepEqual(guessSchedule("Every Friday at 5, sum up my week"), { kind: "schedule", days: [5], time: "17:00" });
  assert.deepEqual(guessSchedule("each weekday at 8:30am check my inbox"), { kind: "schedule", days: [1, 2, 3, 4, 5], time: "08:30" });
  assert.deepEqual(guessSchedule("every day at 18:00"), { kind: "schedule", days: [0, 1, 2, 3, 4, 5, 6], time: "18:00" });
  assert.deepEqual(guessSchedule("every Monday"), { kind: "schedule", days: [1], time: "08:00" });
  assert.equal(guessSchedule("When I save a gift idea, find a good price"), null);
  const d = fallbackDraft("Every Friday at 5, sum up my week", "s");
  assert.deepEqual(d, { name: null, job: "Sum up my week", instructions: "Every Friday at 5, sum up my week", triggers: [{ kind: "schedule", days: [5], time: "17:00" }], allow: [], web: false, seed: "s" });
});

test("a model that fails or answers junk falls back, and one that answers well is used", async () => {
  const fake = (input: unknown, fail = false) =>
    ({ messages: { create: async () => {
      if (fail) throw new Error("boom");
      return { content: [{ type: "tool_use", id: "t", name: "team_draft", input }] };
    } } }) as never;
  const bad = await draftAssistant("When I save a gift idea, find a good price", { client: fake({ job: "" }) });
  assert.equal(bad.fallback, true);
  assert.equal(bad.draft.job, "When I save a gift idea, find a good price");
  assert.ok(bad.draft.seed);
  assert.equal((await draftAssistant("x", { client: fake(null, true) })).fallback, true);
  const good = await draftAssistant("When I save a gift idea, find a good price", { client: fake(GIFT_PRICES) });
  assert.equal(good.fallback, undefined);
  assert.equal(good.draft.name, "Muse");
});

test("web is suggested only when the job clearly needs something online, and only a true counts", () => {
  assert.equal(fitDraft({ ...GIFT_PRICES, web: true }, tools, "s")!.web, true);
  assert.equal(fitDraft({ ...WEEKLY_SUMMARY, web: false }, tools, "s")!.web, false);
  assert.equal(fitDraft(WEEKLY_SUMMARY, tools, "s")!.web, false, "left out: off");
  assert.equal(fitDraft({ ...WEEKLY_SUMMARY, web: "yes" }, tools, "s"), null, "not a flag: no draft from it");
  // The plain draft: the clear cases only.
  for (const s of ["Check the prices of my gift ideas every Friday", "Tell me the F1 news on Mondays", "Find the opening hours of places I save", "Tell me when something I saved is back in stock"]) assert.equal(fallbackDraft(s, "s").web, true, s);
  for (const s of ["Every Friday at 5, sum up my week", "Turn Linear bugs into to-dos", "Remind me about birthdays"]) assert.equal(fallbackDraft(s, "s").web, false, s);
});
