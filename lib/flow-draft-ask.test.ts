// Ask's propose_flow (lib/flow-draft-ask.ts) and the words its card and the model read (lib/flow-draft-words.ts):
// the flow is drawn, saved paused through the FlowCreator port, and carried as a card; only main Ask may.
// No model and no database: the model and the engine are fakes.
// Run: npx tsx --test lib/flow-draft-ask.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { actTools, Session } from "./assistant";
import { asStage, newDesk } from "./assignment-tools";
import { asTrackerChecker } from "./trackers-store";
import type { Flow, FlowInput, FlowStep } from "./flow-types";
import { FLOW_TOOL_NAME, flowCard, runFlowTool, useFlowCreator, withFlowTool, type FlowToolContext } from "./flow-draft-ask";
import { daysWords, flowLines, FLOW_WORDS, minutesWords, plainWords, stepParts, triggerWords, valueLabels } from "./flow-draft-words";
import { guessTriggerGives } from "./flow-draft-tools";
import { sampleFlow } from "./flow-draft-sample";

const PARCEL = {
  name: "Delivery day",
  trigger: { kind: "event", event: { source: "collected", kind: "delivery" } },
  steps: [{ id: "s1", kind: "tool", tool: "add_reminder", input: { text: "Parcel from {{trigger.company}}", date: "{{trigger.expected}}", time: "08:00" } }],
};

const model = (input: unknown) => ({ messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "flow_draft", input }] }) } }) as never;

/** The engine's stand-in: keeps what it's given, fills what the server fills. */
function fakeEngine() {
  const made: FlowInput[] = [];
  return {
    made,
    create: async (input: FlowInput): Promise<Flow> => {
      made.push(input);
      const now = "2026-11-20T09:00:00.000Z";
      return { id: "f1a2b3c4-0000-4000-8000-000000000001", name: input.name!, trigger: input.trigger!, trigger_gives: guessTriggerGives(input.trigger!), steps: input.steps!, assistant_id: null, handed_at: null, money: !!input.money, paused: input.paused ?? true, origin: input.origin ?? "owner", last_run_at: null, created_at: now, updated_at: now };
    },
  };
}

test("propose_flow is main Ask's: offered there, and never in an assistant's turn or a stage", async () => {
  const has = (tools: Array<{ name: string }>) => tools.some((t) => t.name === FLOW_TOOL_NAME);
  assert.ok(has(withFlowTool([])));
  assert.ok(has(actTools({ files: false })), "Ask's own tools include it");
  await asTrackerChecker("00000000-0000-4000-8000-000000000001", async () => assert.ok(!has(withFlowTool([]))));
  await asStage(newDesk({ position: 1, earlier: [], canSendBack: false, canAsk: true }), async () => assert.ok(!has(withFlowTool([]))));
  await asTrackerChecker("00000000-0000-4000-8000-000000000001", () => assert.rejects(runFlowTool(FLOW_TOOL_NAME, { sentence: "whenever" }, { money: false }), /Only Athena/));
  assert.equal(await runFlowTool("add_todo", {}, { money: false }), null, "another tool carries on as usual");
});

test("without the engine's port, it says flows aren't ready, and nothing is saved", async () => {
  useFlowCreator(null);
  await assert.rejects(runFlowTool(FLOW_TOOL_NAME, { sentence: "Whenever a parcel email comes in, remind me" }, { money: false, client: model(PARCEL) }), /aren't ready/);
});

test("it draws the flow, saves it paused with origin ask, and the reply carries the card", async () => {
  const engine = fakeEngine();
  useFlowCreator(engine);
  try {
    const ctx: FlowToolContext = { money: false, client: model(PARCEL) };
    const out = JSON.parse((await runFlowTool(FLOW_TOOL_NAME, { sentence: "Whenever a parcel email comes in, remind me on the day it's due" }, ctx))!);
    assert.equal(engine.made.length, 1);
    assert.equal(engine.made[0].paused, true);
    assert.equal(engine.made[0].origin, "ask");
    assert.equal(out.on, false);
    assert.equal(out.name, "Delivery day");
    assert.equal(out.flow, "When an email says a parcel is coming\n  Remind me at 08:00 on [the delivery date]: Parcel from [the shop]");
    assert.equal(ctx.flow?.flow_id, "f1a2b3c4-0000-4000-8000-000000000001");
    assert.deepEqual(ctx.flow?.flow.steps[0], { id: "s1", title: null, kind: "tool", tool: "add_reminder", go: "auto", gives: [], input: { text: ["Parcel from ", { from: "trigger", key: "company" }], date: [{ from: "trigger", key: "expected" }], time: ["08:00"] } });
    await assert.rejects(runFlowTool(FLOW_TOOL_NAME, { sentence: "Whenever again" }, ctx), /One flow per reply/);
    await assert.rejects(runFlowTool(FLOW_TOOL_NAME, { sentence: " " }, { money: false, client: model(PARCEL) }));
    // A model that can't help still leaves a flow to fill in, and says so.
    const empty = JSON.parse((await runFlowTool(FLOW_TOOL_NAME, { sentence: "Whenever it rains" }, { money: false, client: model("junk") }))!);
    assert.equal(empty.drawn, false);
    assert.equal(engine.made[1].steps!.length, 0);
  } finally {
    useFlowCreator(null);
  }
});

test("Ask's Session runs it before planning, so it's never queued as a plan step", async () => {
  const engine = fakeEngine();
  useFlowCreator(engine);
  try {
    const s = new Session(new Date("2026-11-20T09:00:00Z"), "Europe/London", { client: model(PARCEL), capture: false });
    assert.ok(s.handles(FLOW_TOOL_NAME));
    s.draft = { offer: () => assert.fail("queued as a plan step"), steps: [] } as never;
    await s.run(FLOW_TOOL_NAME, { sentence: "Whenever a parcel email comes in, remind me" });
    assert.equal(s.flow?.flow.name, "Delivery day");
  } finally {
    useFlowCreator(null);
  }
});

test("Ask spots a flow in “whenever”, “every time” and “each time”", () => {
  for (const said of ["Whenever a parcel email comes in, remind me", "every time I save a recipe, add it to my list", "Each time Priya emails"]) assert.ok(FLOW_WORDS.test(said), said);
  for (const said of ["Every Friday at 4pm, tell me what slipped", "What time is it?", "remind me tomorrow"]) assert.ok(!FLOW_WORDS.test(said), said);
});

test("a trigger in words, plain and British", () => {
  assert.equal(daysWords([1, 2, 3, 4, 5]), "every weekday");
  assert.equal(daysWords([1, 5]), "every Monday and Friday");
  assert.equal(minutesWords(90), "1 hour 30 minutes");
  assert.equal(minutesWords(1440), "1 day");
  assert.equal(triggerWords({ kind: "schedule", days: [0, 1, 2, 3, 4, 5, 6], time: "07:30" }), "Every day at 07:30");
  assert.equal(triggerWords({ kind: "event", event: { source: "collected", kind: "renewal" } }), "When a renewal email comes in");
  assert.equal(triggerWords({ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }), "When you save a gift idea");
  assert.equal(triggerWords({ kind: "event", event: { source: "note", tag: "idea", match: "garden" } }), "When you tag a note #idea about “garden”");
  assert.equal(triggerWords({ kind: "before", what: "event", minutes: 30, withPeople: true }), "30 minutes before an event with someone from your People");
  assert.equal(triggerWords({ kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" }), "3 days before a birthday, at 09:00");
  assert.equal(triggerWords({ kind: "manual" }), "When you tap Run now");
});

test("steps in words, values as chips, branches indented", () => {
  const { card } = sampleFlow("Every time a renewal comes in");
  const f = card.flow;
  const labels = valueLabels(f.trigger_gives, f.steps);
  assert.equal(plainWords(stepParts(f.steps[0], labels)), "Look at payments to [the company]");
  assert.deepEqual(stepParts(f.steps[1], labels), ["If ", { chip: "what you paid last time" }, " is there"]);
  assert.deepEqual(flowLines(f.trigger, f.trigger_gives, f.steps), [
    "When a renewal email comes in",
    "  Look at payments to [the company]",
    "  If [what you paid last time] is there",
    "    Yes:",
    "      Wait until 7 days before [the renewal date] at 09:00",
    "      Tell me: [the company] renews soon. Last time you paid [what you paid last time].",
  ]);
  const own: FlowStep = { id: "s9", title: "Ping me", kind: "notify", text: ["x"] };
  assert.deepEqual(stepParts(own, labels), ["Ping me"], "the owner's own title wins");
  assert.equal(plainWords(stepParts({ id: "a", title: null, kind: "ask", question: ["Book it?"], choices: [] }, labels)), "Ask me: Book it?");
  assert.equal(plainWords(stepParts({ id: "a", title: null, kind: "tool", tool: "save_note", input: { title: ["Trip"] }, go: "ask", gives: [] }, labels)), "Save a note: Trip");
  assert.equal(plainWords(stepParts({ id: "a", title: null, kind: "tool", tool: "draft_email", input: { about: ["The renewal"] }, go: "ask", gives: [] }, labels)), "Draft an email: The renewal");
});

test("the card carries what the contract says it does", () => {
  const f = fakeEngine();
  return f.create({ name: "Delivery day", trigger: { kind: "manual" }, steps: [] }).then((flow) => assert.deepEqual(Object.keys(flowCard(flow).flow).sort(), ["assistant_id", "name", "steps", "trigger", "trigger_gives"]));
});
