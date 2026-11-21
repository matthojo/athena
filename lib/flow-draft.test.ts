// Flows drafting (lib/flow-draft.ts, lib/flow-draft-check.ts, lib/flow-draft-tools.ts): the model's proposal checked
// strictly against lib/flow-types.ts and FLOW_LIMITS, the tools a flow may use, and the fallback when the model can't help.
// No model and no database: the model is a fake.
// Run: npx tsx --test lib/flow-draft.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./assistant";
import { READ_TOOLS } from "./ask-tools";
import { stepActs } from "./steps";
import { FLOW_LIMITS, type FlowStep } from "./flow-types";
import { ALWAYS_ASK, draftTools, FLOW_TOOLS, goFor, guessTriggerGives, NEVER_TOOLS, RUNS_ALONE } from "./flow-draft-tools";
import { checkDraft, cleanName, cleanTime, fitTrigger, type CheckContext } from "./flow-draft-check";
import { draftFlow, fallbackDraft, toolLines } from "./flow-draft";
import { sampleFlow } from "./flow-draft-sample";

const tools = draftTools([...READ_TOOLS, ...TOOLS], stepActs);
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ tools, triggerGives: guessTriggerGives, money: false, ...over });
const tool = (name: string) => tools.find((t) => t.name === name)!;

test("a flow may use only the allowlisted tools, never one that sends, edits an account, deletes or belongs to Ask's own turn", () => {
  const names = new Set(tools.map((t) => t.name));
  for (const t of ["add_reminder", "add_todo", "add_to_list", "save_note", "find_notes", "money", "weather", "draft_message", "draft_email"]) assert.ok(names.has(t), t);
  for (const t of NEVER_TOOLS) assert.ok(!names.has(t), t);
  for (const t of names) assert.ok(FLOW_TOOLS.has(t), t);
  for (const t of FLOW_TOOLS) assert.ok(names.has(t), `${t} is one of Ask's tools`);
  for (const t of ["search_athena", "read_note", "save_booking", "track"]) assert.ok(!names.has(t), `${t} isn't on the allowlist`);
  assert.equal(names.size, tools.length, "each tool once");
  assert.equal(tool("find_notes").changes, false);
  assert.equal(tool("add_reminder").changes, true);
  assert.equal(tool("money").money, true);
  assert.ok(!tool("add_reminder").fields.includes("step"), "Ask's plan line isn't a field");
  assert.deepEqual(tool("add_reminder").required, ["text", "date"]);
  assert.match(toolLines([tool("add_reminder")]), /^- add_reminder \(changes\): Set a reminder: .* Fields: text\*, date\*, time/);
});

test("changes wait for Go, except a reminder, a to-do or a list line the owner didn't ask to check; drafts always wait", () => {
  for (const name of RUNS_ALONE) assert.equal(goFor(tool(name), undefined), "auto", name);
  assert.equal(goFor(tool("add_reminder"), "ask"), "ask", "the owner said to check first");
  assert.equal(goFor(tool("save_note"), "auto"), "ask", "the model can't let any other change run alone");
  for (const name of ALWAYS_ASK) {
    assert.equal(tool(name).changes, true, name);
    assert.equal(goFor(tool(name), undefined), "ask", name);
    assert.equal(goFor(tool(name), "auto"), "ask", `${name}: a draft always waits for Go`);
  }
  assert.equal(goFor(tool("find_notes"), "ask"), "auto", "a look changes nothing");
});

test("triggers are checked to the contract's shape, or dropped", () => {
  assert.deepEqual(fitTrigger({ kind: "schedule", days: [5, 1, 1, 9], time: "8:30" }), { kind: "schedule", days: [1, 5], time: "08:30" });
  assert.deepEqual(fitTrigger({ kind: "schedule", time: "07:00" }), { kind: "schedule", days: [0, 1, 2, 3, 4, 5, 6], time: "07:00" });
  assert.equal(fitTrigger({ kind: "schedule", days: [1], time: "25:00" }), null);
  assert.deepEqual(fitTrigger({ kind: "event", event: { source: "collected", kind: "Delivery", connector: "Gmail", match: "  order  " } }), { kind: "event", event: { source: "collected", kind: "delivery", connector: "gmail", match: "order" } });
  assert.deepEqual(fitTrigger({ kind: "event", event: { source: "note", tag: "#idea" } }), { kind: "event", event: { source: "note", tag: "idea" } });
  assert.equal(fitTrigger({ kind: "event", event: { source: "inbox" } }), null);
  assert.deepEqual(fitTrigger({ kind: "before_event", minutes: 30, with_people: true }), { kind: "before", what: "event", minutes: 30, withPeople: true });
  assert.equal(fitTrigger({ kind: "before_event", minutes: 0 }), null);
  assert.deepEqual(fitTrigger({ kind: "before_date", days_before: 3, event_kind: "Birthday" }), { kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" });
  assert.equal(fitTrigger({ kind: "before_date", days_before: FLOW_LIMITS.waitDays + 1, at: "09:00" }), null);
  assert.deepEqual(fitTrigger({ kind: "manual" }), { kind: "manual" });
  assert.equal(fitTrigger({ kind: "webhook" }), null);
  assert.equal(cleanTime("9:05"), "09:05");
  assert.equal(cleanTime("9.05"), null);
});

/** "When a renewal email comes in, check what I paid last year and tell me a week before if it's gone up", as a model might answer. */
const RENEWAL = {
  name: "renewal check.",
  trigger: { kind: "event", event: { source: "collected", kind: "renewal" } },
  steps: [
    { id: "a", kind: "tool", tool: "money", input: { merchant: "{{trigger.company}}" }, gives: [{ key: "last_price", label: "last year's price", kind: "money" }] },
    { id: "b", kind: "check", condition: { left: "{{a.last_price}}", op: "more_than", right: "{{trigger.title}}" } },
    { id: "c", parent: "b", branch: "yes", kind: "wait", days: 7, before: "{{trigger.renewal_date}}", at: "9:00" },
    { id: "d", parent: "b", branch: "yes", kind: "notify", text: "{{trigger.company}} renews soon; last year was {{a.last_price}}" },
  ],
};

test("a clean draft comes through as the contract's tree, ids renumbered, values as chips", () => {
  const d = checkDraft(RENEWAL, ctx({ money: true }), "x")!;
  assert.equal(d.name, "Renewal check");
  assert.deepEqual(d.trigger, { kind: "event", event: { source: "collected", kind: "renewal" } });
  assert.equal(d.money, true);
  assert.deepEqual(d.notes, []);
  assert.deepEqual(d.steps, [
    { id: "s1", title: null, kind: "tool", tool: "money", input: { merchant: [{ from: "trigger", key: "company" }] }, go: "auto", gives: [{ key: "last_price", label: "last year's price", kind: "money" }] },
    {
      id: "s2",
      title: null,
      kind: "check",
      condition: { left: { from: "s1", key: "last_price" }, op: "more_than", right: { from: "trigger", key: "title" } },
      yes: [
        { id: "s3", title: null, kind: "wait", days: 7, before: { from: "trigger", key: "renewal_date" }, at: "09:00" },
        { id: "s4", title: null, kind: "notify", text: [{ from: "trigger", key: "company" }, " renews soon; last year was ", { from: "s1", key: "last_price" }] },
      ],
      no: [],
    },
  ] satisfies FlowStep[]);
});

test("with spending off for Ask, a step that reads it is left out with a note, and what used it goes too", () => {
  const d = checkDraft(RENEWAL, ctx({ money: false }), "x")!;
  assert.equal(d.money, false);
  assert.ok(d.notes.some((n) => /spending is off/.test(n)), d.notes.join("|"));
  // The check pointed at the money step's value: it's no longer there, so the check can't stand.
  assert.ok(d.notes.some((n) => /check/.test(n)), d.notes.join("|"));
  assert.ok(!JSON.stringify(d.steps).includes("money"));
});

test("an unknown tool is dropped with a note; a value from a later step or from inside a branch is taken out", () => {
  const d = checkDraft(
    {
      name: "Parcel",
      trigger: { kind: "event", event: { source: "collected", kind: "delivery" } },
      steps: [
        { id: "1", kind: "tool", tool: "send_sms", input: { to: "me" } },
        { id: "2", kind: "notify", text: "Price {{3.price}} for {{trigger.company}}" },
        { id: "3", kind: "tool", tool: "find_notes", input: { query: "{{trigger.company}}" }, gives: [{ key: "price", label: "the price", kind: "money" }] },
        { id: "4", kind: "check", condition: { left: "{{trigger.expected}}", op: "exists" } },
        { id: "5", parent: "4", branch: "no", kind: "tool", tool: "find_todos", input: { query: "parcel" }, gives: [{ key: "todo", label: "the to-do", kind: "todo" }] },
        { id: "6", kind: "notify", text: "Due {{5.todo}}" },
        { id: "7", kind: "tool", tool: "add_reminder", input: { text: "Parcel from {{trigger.company}}", date: "{{trigger.expected}}", time: "08:00", bogus: "x" } },
      ],
    },
    ctx(),
    "x",
  )!;
  assert.ok(d.notes.some((n) => /no step called “send_sms”/.test(n)), d.notes.join("|"));
  assert.ok(d.notes.some((n) => /isn't there yet/.test(n)), d.notes.join("|"));
  const top = d.steps;
  assert.deepEqual(top.map((s) => s.kind), ["notify", "tool", "check", "notify", "tool"]);
  // A value from a later step, and one from inside a branch that may not have run, are taken out; the words stay.
  assert.deepEqual((top[0] as Extract<FlowStep, { kind: "notify" }>).text, ["Price  for ", { from: "trigger", key: "company" }]);
  assert.deepEqual((top[3] as Extract<FlowStep, { kind: "notify" }>).text, ["Due"]);
  assert.equal((top[2] as Extract<FlowStep, { kind: "check" }>).no[0].kind, "tool");
  const reminder = top[4] as Extract<FlowStep, { kind: "tool" }>;
  assert.equal(reminder.go, "auto");
  assert.deepEqual(Object.keys(reminder.input), ["text", "date", "time"], "unknown fields dropped");
  assert.deepEqual(reminder.input.date, [{ from: "trigger", key: "expected" }]);
});

test("a step that only had words from out of reach, and one that can't be read, are left out", () => {
  const d = checkDraft({ name: "x", trigger: { kind: "manual" }, steps: [{ id: "a", kind: "notify", text: "{{b.x}}" }, { id: "b", kind: "dance" }, "junk"] }, ctx(), "x")!;
  assert.deepEqual(d.steps, []);
  assert.ok(d.notes.some((n) => /nothing to say/.test(n)));
  assert.ok(d.notes.some((n) => /couldn't read/.test(n)));
});

test("a thinking step needs an assistant, so a drawn flow leaves it out", () => {
  const d = checkDraft({ name: "x", trigger: { kind: "manual" }, steps: [{ id: "a", kind: "think", task: "Decide" }, { id: "b", kind: "notify", text: "Hi" }] }, ctx(), "x")!;
  assert.deepEqual(d.steps.map((s) => s.kind), ["notify"]);
  assert.ok(d.notes.some((n) => /assistant/.test(n)));
});

test("Ask me: two to four choices, each its own branch; Wait and Start an assignment come through", () => {
  const d = checkDraft(
    {
      name: "Weekend plans",
      trigger: { kind: "schedule", days: [5], time: "17:00" },
      steps: [
        { id: "q", kind: "ask", question: "Plans this weekend?", choices: ["Away", "Home", "Not sure", "Ask later", "Never"] },
        { id: "w", parent: "q", branch: 0, kind: "tool", tool: "add_todo", input: { title: "Pack", kind: "todo" } },
        { id: "x", parent: "q", branch: "1", kind: "assignment", brief: "Plan a quiet weekend" },
        { id: "y", parent: "q", branch: 7, kind: "notify", text: "lost" },
        { id: "z", kind: "wait", days: 99, at: "nope" },
      ],
    },
    ctx(),
    "x",
  )!;
  const ask = d.steps[0] as Extract<FlowStep, { kind: "ask" }>;
  assert.deepEqual(ask.choices.map((c) => c.label), ["Away", "Home", "Not sure", "Ask later"]);
  assert.equal(ask.choices[0].steps[0].kind, "tool");
  assert.equal(ask.choices[1].steps[0].kind, "assignment");
  assert.deepEqual(d.steps[1], { id: "s4", title: null, kind: "wait", days: FLOW_LIMITS.waitDays, at: null });
  assert.ok(d.notes.some((n) => /4 choices at most/.test(n)));
  assert.ok(d.notes.some((n) => /didn't fit anywhere/.test(n)), "the step on a choice that isn't there");
  assert.ok(d.notes.some((n) => /60 days at most/.test(n)));
});

test("limits: steps, nesting and the name", () => {
  const many = Array.from({ length: FLOW_LIMITS.steps + 5 }, (_, i) => ({ id: `n${i}`, kind: "notify", text: `Step ${i}` }));
  const d = checkDraft({ name: "A".repeat(200), trigger: { kind: "manual" }, steps: many }, ctx(), "x")!;
  assert.equal(d.steps.length, FLOW_LIMITS.steps);
  assert.ok(d.name.length <= FLOW_LIMITS.name);
  const nest = [{ id: "c1", kind: "check", condition: { left: "{{trigger.date}}", op: "exists" } }];
  for (let i = 2; i <= FLOW_LIMITS.depth + 1; i++) nest.push({ id: `c${i}`, parent: `c${i - 1}`, branch: "yes", kind: "check", condition: { left: "{{trigger.date}}", op: "exists" } } as never);
  const deep = checkDraft({ name: "Deep", trigger: { kind: "schedule", time: "09:00" }, steps: nest }, ctx(), "x")!;
  let depth = 0;
  for (let s: FlowStep | undefined = deep.steps[0]; s && s.kind === "check"; s = s.yes[0]) depth++;
  assert.equal(depth, FLOW_LIMITS.depth);
  assert.ok(deep.notes.some((n) => /3 deep at most/.test(n)));
});

test("a check up by a percentage needs the number and what it's compared with", () => {
  const steps = [
    { id: "a", kind: "tool", tool: "find_notes", input: { query: "bill" }, gives: [{ key: "old", label: "the old price", kind: "money" }, { key: "new", label: "the new price", kind: "money" }] },
    { id: "b", kind: "check", condition: { left: "{{a.new}}", op: "up_by_pct", right: "10%", against: "{{a.old}}" } },
    { id: "c", kind: "check", condition: { left: "{{a.new}}", op: "up_by_pct", right: 10 } },
  ];
  const d = checkDraft({ name: "Bills", trigger: { kind: "event", event: { source: "collected", kind: "renewal" } }, steps }, ctx(), "x")!;
  assert.deepEqual((d.steps[1] as Extract<FlowStep, { kind: "check" }>).condition, { left: { from: "s1", key: "new" }, op: "up_by_pct", right: 10, against: { from: "s1", key: "old" } });
  assert.equal(d.steps.length, 2, "the one without `against` is left out");
});

test("a trigger that doesn't hold up becomes Run now, with a note; nothing at all is no draft", () => {
  const d = checkDraft({ name: "Plants", trigger: { kind: "schedule", time: "late" }, steps: [] }, ctx(), "x")!;
  assert.deepEqual(d.trigger, { kind: "manual" });
  assert.ok(d.notes.some((n) => /Run now/.test(n)));
  assert.equal(checkDraft(null, ctx(), "x"), null);
  assert.equal(checkDraft({ steps: [] }, ctx(), "x"), null);
  assert.equal(checkDraft({ name: "", trigger: { kind: "manual" }, steps: [{ id: "a", kind: "notify", text: "Hi" }] }, ctx(), "water the plants")!.name, "Water the plants");
  assert.equal(cleanName("**<b>Delivery day</b>**."), "BDelivery day/b");
});

test("the fallback is an empty flow named from the sentence, kept off", () => {
  const f = fallbackDraft("whenever a parcel email comes in, remind me on the day");
  assert.equal(f.fallback, true);
  assert.equal(f.flow.name, "Whenever a parcel email comes in, remind me on the day");
  assert.ok(fallbackDraft("x ".repeat(100)).flow.name.length <= FLOW_LIMITS.name);
  assert.deepEqual(f.flow.trigger, { kind: "manual" });
  assert.deepEqual(f.flow.steps, []);
  assert.equal(f.flow.paused, true);
  assert.equal(f.flow.origin, "draft");
  assert.equal(f.notes.length, 1);
});

const fake = (input: unknown, fail = false) =>
  ({
    messages: {
      create: async (params: { tools: Array<{ name: string; input_schema: { properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } } }> }) => {
        if (fail) throw new Error("boom");
        // The model is only offered tools a flow may use, by name.
        const offered = params.tools[0].input_schema.properties.steps.items.properties.tool.enum;
        assert.ok(offered.includes("add_reminder") && !offered.includes("send_note"));
        return { content: [{ type: "tool_use", id: "t", name: "flow_draft", input }] };
      },
    },
  }) as never;

test("draftFlow: one model call, used when it holds up, the fallback when it fails or answers junk", async () => {
  const good = await draftFlow("When a renewal email comes in, tell me a week before if it's gone up", { client: fake(RENEWAL), money: true, tools });
  assert.equal(good.fallback, undefined);
  assert.equal(good.flow.name, "Renewal check");
  assert.equal(good.flow.paused, true);
  assert.equal(good.flow.origin, "draft");
  assert.equal(good.flow.money, true);
  assert.equal(good.flow.steps.length, 2);
  const asked = await draftFlow("Whenever a parcel's coming", { client: fake(RENEWAL), tools, origin: "ask" });
  assert.equal(asked.flow.origin, "ask");
  assert.equal((await draftFlow("x", { client: fake(null, true), tools })).fallback, true);
  assert.equal((await draftFlow("Water the plants", { client: fake("junk"), tools })).flow.name, "Water the plants");
  assert.equal((await draftFlow("   ", { client: fake(RENEWAL), tools })).fallback, true);
});

test("sample mode's flows hold up as drawn ones do", () => {
  for (const said of ["Whenever a parcel email comes in, remind me on the day it's due", "Every time a renewal comes in, check it", "Each time Priya emails, tell me"]) {
    const { card } = sampleFlow(said);
    const f = card.flow;
    // Turn the sample back into the model's flat shape and check it: it should come through unchanged.
    const flat: unknown[] = [];
    const ref = (p: { from: string; key: string }) => `{{${p.from}.${p.key}}}`;
    const text = (t: Array<string | { from: string; key: string }>) => t.map((p) => (typeof p === "string" ? p : ref(p))).join("");
    const walk = (steps: FlowStep[], parent?: string, branch?: string | number) => {
      for (const s of steps) {
        const at = { id: s.id, ...(parent ? { parent, branch } : {}) };
        if (s.kind === "tool") flat.push({ ...at, kind: "tool", tool: s.tool, input: Object.fromEntries(Object.entries(s.input).map(([k, t]) => [k, text(t)])), gives: s.gives });
        if (s.kind === "notify") flat.push({ ...at, kind: "notify", text: text(s.text) });
        if (s.kind === "wait") flat.push({ ...at, kind: "wait", days: s.days, at: s.at, ...(s.before ? { before: ref(s.before) } : {}) });
        if (s.kind === "check") {
          const c = s.condition;
          flat.push({ ...at, kind: "check", condition: { left: ref(c.left), op: c.op, right: typeof c.right === "object" ? ref(c.right) : c.right } });
          walk(s.yes, s.id, "yes");
          walk(s.no, s.id, "no");
        }
      }
    };
    walk(f.steps);
    const back = checkDraft({ name: f.name, trigger: f.trigger.kind === "event" ? { kind: "event", event: f.trigger.event } : f.trigger, steps: flat }, ctx({ money: true, triggerGives: () => f.trigger_gives }), "x")!;
    assert.deepEqual(back.notes, [], said);
    assert.deepEqual(back.steps, f.steps, said);
  }
});

test("what a trigger gives: the same keys the triggers fill (lib/flow-triggers.ts triggerGives)", () => {
  const keys = (t: Parameters<typeof guessTriggerGives>[0]) => guessTriggerGives(t).map((g) => g.key);
  assert.deepEqual(keys({ kind: "event", event: { source: "collected", kind: "delivery" } }), ["item", "company", "expected", "title", "count"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "collected", kind: "renewal" } }), ["item", "company", "renewal_date", "title", "count"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "collected", kind: "booking" } }), ["item", "booking", "company", "starts_at", "title", "count"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "saved" } }), ["item", "website", "title", "count"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "note", tag: "idea" } }), ["item", "tags", "title", "count"]);
  assert.deepEqual(keys({ kind: "schedule", days: [1], time: "09:00" }), ["date", "time"]);
  assert.deepEqual(keys({ kind: "manual" }), ["date"]);
  assert.deepEqual(keys({ kind: "before", what: "event", minutes: 30 }), ["event", "people", "starts_at", "title"]);
  assert.deepEqual(keys({ kind: "before", what: "date", days: 3, at: "09:00", eventKind: "Birthday" }), ["event", "person", "date", "years", "title"]);
  assert.deepEqual(keys({ kind: "before", what: "date", days: 3, at: "09:00", eventKind: "renewal" }), ["item", "company", "renewal_date", "title"]);
});
