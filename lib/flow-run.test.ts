// A flow's run (lib/flow-run.ts) with fake effects: no database, no model. Looks and changes, a change waiting
// for Go and carrying on after it, Ask me's branches, Wait, Tell me's card, Think with and without an assistant,
// an assignment, a try that changes nothing, a missing value, money only when allowed, and when a failed run is
// tried once more. Made-up data only.
// Run: npx tsx --test lib/flow-run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Change } from "./assistant";
import { settle, summaryOf, thinkPrompt, thinkValues, triesAgain, walk, type FlowEffects, type RunContext } from "./flow-run";
import { emptyState } from "./flows";
import type { Flow, FlowStep } from "./flow-types";

const NOW = new Date("2026-11-20T08:12:00Z");

function fakes(over: Partial<FlowEffects> = {}) {
  const calls: Array<[string, unknown]> = [];
  const change = (title: string): Change => ({ kind: "commitment", id: "todo-1", action: "created", title, detail: "To-do", label: `${title}: To-do`, open: null, undo: null } as unknown as Change);
  const fx: FlowEffects = {
    now: () => NOW,
    tz: "Europe/London",
    askMoney: async () => true,
    runTool: async (name, input) => {
      calls.push(["tool", { name, input }]);
      if (name === "money") return { result: JSON.stringify({ total: "£384.00", count: 12, payments: [{ merchant: "Northwind Broadband", amount: "£32.00" }] }), changes: [] };
      if (name === "add_todo") return { result: JSON.stringify({ done: "x", id: "todo-1" }), changes: [change(String((input as { title?: string }).title))] };
      if (name === "find_people") return { result: JSON.stringify([{ id: "p-1", name: "Sam Example" }]), changes: [] };
      return { result: "{}", changes: [] };
    },
    log: async (changes) => changes.map((c) => ({ ...c, activity_id: "act-1" })),
    savePlan: async (step) => {
      calls.push(["plan", step]);
      return "plan-1";
    },
    goPlan: async (id) => {
      calls.push(["go", id]);
      return { changes: [change("Decide on the renewal")] };
    },
    dropPlan: async (id) => void calls.push(["drop", id]),
    planRan: async () => null,
    assistant: async () => null,
    think: async (id, prompt, opts) => {
      calls.push(["think", { id, prompt, opts }]);
      return { text: "Lumen Fibre charges £29 for the same speed.", values: { deal: "Lumen Fibre at £29.00 a month", why: "same speed, £9 less" }, changes: [], plan: null };
    },
    draftAssignment: async (brief) => {
      calls.push(["assignment", brief]);
      return { id: "asg-1", lineup: "Researcher → Writer" };
    },
    assignment: async () => ({ status: "done", title: "Broadband deals", note_id: "note-9" }),
    noteMade: async (_run, ids) => void calls.push(["made", ids]),
    ...over,
  };
  return { fx, calls };
}

const flowOf = (steps: FlowStep[], over: Partial<Flow> = {}): Flow => ({
  id: "flow-1",
  name: "Renewal guard",
  trigger: { kind: "event", event: { source: "collected", kind: "renewal" } },
  trigger_gives: [
    { key: "item", label: "the email", kind: "email" },
    { key: "title", label: "its title", kind: "text" },
  ],
  steps,
  assistant_id: null,
  handed_at: null,
  money: true,
  paused: false,
  origin: "owner",
  last_run_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

const ctxOf = (flow: Flow, over: Partial<RunContext> = {}): RunContext => ({ flow, runId: "run-1", dry: false, assistant: null, label: "An email from Northwind Broadband", money: true, events: [], byHand: false, teamRunId: null, ...over });

const paid: FlowStep = { id: "paid", title: "Find what I paid last year", kind: "tool", tool: "money", input: { merchant: ["Northwind Broadband"] }, go: "auto", gives: [{ key: "latest", label: "last year's price", kind: "money" }] };
const upCheck = (yes: FlowStep[], no: FlowStep[]): FlowStep => ({ id: "up", title: "Did it go up?", kind: "check", condition: { left: { from: "paid", key: "latest" }, op: "more_than", right: 30 }, yes, no });
const todo = (go: "auto" | "ask"): Extract<FlowStep, { kind: "tool" }> => ({ id: "todo", title: null, kind: "tool", tool: "add_todo", input: { title: ["Decide on the renewal: ", { from: "paid", key: "latest" }], kind: ["todo"] }, go, gives: [{ key: "todo", label: "the to-do", kind: "todo" }] });
const remind: FlowStep = { id: "remind", title: "Remind me", kind: "notify", text: ["Nothing to do this time"] };

test("a look, a Check, then a change that waits for Go; Go runs it and the run carries on", async () => {
  const { fx, calls } = fakes();
  const flow = flowOf([paid, upCheck([todo("ask")], [remind]), { id: "tell", title: null, kind: "notify", text: ["Sorted: ", { from: "todo", key: "todo" }] }]);
  const state = emptyState({ trigger: { title: "Your plan renews on 4 December" } });
  const out = await walk(state, ctxOf(flow), fx);
  assert.deepEqual(out, { status: "waiting", waits_for: "go", plan_id: "plan-1" });
  assert.equal(state.lines.find((l) => l.step_id === "paid")?.line, "Found 12 payments to Northwind Broadband: £384.00 in all");
  assert.equal(state.lines.find((l) => l.step_id === "up")?.line, "Yes: £32.00 is more than 30");
  assert.equal(state.lines.find((l) => l.step_id === "remind")?.status, "skipped");
  assert.equal(state.lines.find((l) => l.step_id === "remind")?.line, "Not run: it's on the “Otherwise” path");
  const waiting = state.lines.find((l) => l.step_id === "todo")!;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(waiting.pending, { text: "Add a to-do: Decide on the renewal: £32.00", plan_id: "plan-1" });
  assert.ok(calls.some(([k]) => k === "plan"));
  assert.ok(!calls.some(([k, v]) => k === "tool" && (v as { name: string }).name === "add_todo"), "nothing is changed before Go");

  await settle(state, flow, { kind: "go", step_id: "todo" }, fx, { runId: "run-1", assistant: false });
  assert.equal(state.lines.find((l) => l.step_id === "todo")?.status, "done");
  assert.deepEqual(state.values.todo.todo, { id: "todo-1", title: "Decide on the renewal", kind: "todo" });
  const end = await walk(state, ctxOf(flow), fx);
  assert.deepEqual(end, { status: "done" });
  assert.equal(state.lines.find((l) => l.step_id === "tell")?.line, "Told you: Sorted: Decide on the renewal");
  assert.equal(state.notices.length, 1);
  assert.equal(state.notices[0].key, "flow:run-1:tell");
  assert.equal(state.notices[0].title, "Renewal guard");
  assert.equal(summaryOf(state, end, { dry: false }), "1 to-do added.");
});

test("Skip drops the waiting change and carries on; a second answer for the same step is refused", async () => {
  const { fx, calls } = fakes();
  const flow = flowOf([{ ...todo("ask"), input: { title: ["Ring the bank"], kind: ["todo"] } }, remind]);
  const state = emptyState({});
  assert.equal((await walk(state, ctxOf(flow), fx)).status, "waiting");
  await settle(state, flow, { kind: "skip", step_id: "todo" }, fx, { runId: "run-1", assistant: false });
  assert.ok(calls.some(([k, v]) => k === "drop" && v === "plan-1"));
  assert.equal(state.lines[0].line, "Skipped: you tapped Skip");
  await assert.rejects(() => settle(state, flow, { kind: "go", step_id: "todo" }, fx, { runId: "run-1", assistant: false }), /isn't waiting/);
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "done" });
});

test("a change set to run alone runs, is logged, and its record is kept as made by the run", async () => {
  const { fx, calls } = fakes();
  const state = emptyState({});
  const out = await walk(state, ctxOf(flowOf([paid, todo("auto")])), fx);
  assert.deepEqual(out, { status: "done" });
  assert.deepEqual(calls.find(([k]) => k === "made")?.[1], ["todo-1"]);
  assert.deepEqual(state.changes, [{ kind: "commitment", action: "created" }]);
});

test("What Ask did is told which flow and run a change came from", async () => {
  const logged: unknown[] = [];
  const { fx } = fakes({ log: async (changes, ctx) => (logged.push(ctx), changes) });
  await walk(emptyState({}), ctxOf(flowOf([paid, todo("auto")])), fx);
  assert.deepEqual(logged, [{ assistant: false, flowId: "flow-1", runId: "run-1" }]);
});

test("a draft always waits for Go, even saved as auto; Go writes it through the plan, told which flow and run", async () => {
  const went: unknown[] = [];
  const draft: Change = { kind: "draft", id: "d-1", action: "created", title: "Thanks for today", detail: "Email to Sam · ready to check", label: "Thanks for today", open: null, undo: null } as unknown as Change;
  const { fx, calls } = fakes({ goPlan: async (id, ctx) => (went.push([id, ctx]), { changes: [draft] }) });
  const step: FlowStep = { id: "draft", title: null, kind: "tool", tool: "draft_email", input: { person_id: ["p-1"], about: ["Thank them for today"] }, go: "auto", gives: [{ key: "draft", label: "the draft", kind: "text" }] };
  const flow = flowOf([step]);
  const state = emptyState({});
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "waiting", waits_for: "go", plan_id: "plan-1" });
  assert.ok(!calls.some(([k]) => k === "tool"), "nothing is written before Go");
  await settle(state, flow, { kind: "go", step_id: "draft" }, fx, { runId: "run-1", assistant: false });
  assert.deepEqual(went, [["plan-1", { assistant: false, flowId: "flow-1", runId: "run-1" }]]);
  assert.equal(state.lines[0].status, "done");
  assert.equal((state.values.draft.draft as { title: string }).title, "Thanks for today");
});

test("a draft with no account stops the run at that step, saying why", async () => {
  const { fx } = fakes({ goPlan: async () => ({ changes: [], error: "No email account is connected, so there's nowhere to write this draft." }) });
  const flow = flowOf([{ id: "draft", title: null, kind: "tool", tool: "draft_message", input: { person_id: ["p-1"], about: ["Chase the quote"] }, go: "ask", gives: [] }, remind]);
  const state = emptyState({});
  await walk(state, ctxOf(flow), fx);
  const { end } = await settle(state, flow, { kind: "go", step_id: "draft" }, fx, { runId: "run-1", assistant: false });
  assert.equal(end?.status, "failed");
  assert.match(end!.error, /^Stopped at “Draft a message”: No email account is connected/);
  assert.equal(state.lines[0].status, "failed");
});

test("Ask me waits for the answer, then goes down the chosen branch", async () => {
  const { fx } = fakes();
  const ask: FlowStep = { id: "ask", title: null, kind: "ask", question: ["Renew ", { from: "trigger", key: "title" }, "?"], choices: [{ label: "Yes", steps: [todo("auto")] }, { label: "No", steps: [remind] }] };
  const flow = flowOf([ask]);
  const state = emptyState({ trigger: { title: "Northwind" } });
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "waiting", waits_for: "answer" });
  assert.deepEqual(state.lines[0].question, { text: "Renew Northwind?", choices: ["Yes", "No"] });
  await assert.rejects(() => settle(state, flow, { kind: "answer", step_id: "ask", choice: 5 }, fx, { runId: "run-1", assistant: false }), /choice/);
  await settle(state, flow, { kind: "answer", step_id: "ask", choice: 1 }, fx, { runId: "run-1", assistant: false });
  assert.equal(state.lines[0].line, "You chose “No”");
  assert.equal(state.lines.find((l) => l.step_id === "todo")?.line, "Not run: you chose “No”");
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "done" });
  assert.equal(state.lines.find((l) => l.step_id === "remind")?.status, "done");
});

test("Wait pauses until its time; the reminders job's settle carries it on", async () => {
  const { fx } = fakes();
  const flow = flowOf([{ id: "w", title: null, kind: "wait", days: 2, at: "09:00" }, remind]);
  const state = emptyState({});
  const out = await walk(state, ctxOf(flow), fx);
  assert.deepEqual(out, { status: "waiting", waits_for: "time", resumes_at: "2026-11-22T09:00:00.000Z" });
  assert.equal(state.lines[0].line, "Carries on Sun 22 Nov, 09:00");
  await settle(state, flow, { kind: "time" }, { ...fx, now: () => new Date("2026-11-22T09:01:00Z") }, { runId: "run-1", assistant: false });
  assert.equal(state.lines[0].status, "done");
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "done" });
});

test("a try changes nothing: changes say what they would do, a question ends it", async () => {
  const { fx, calls } = fakes();
  const ask: FlowStep = { id: "ask", title: null, kind: "ask", question: ["Go ahead?"], choices: [{ label: "Yes", steps: [] }, { label: "No", steps: [] }] };
  const flow = flowOf([paid, todo("auto"), { id: "w", title: null, kind: "wait", days: 1, at: null }, { id: "tell", title: null, kind: "notify", text: ["Hi"] }, ask, remind]);
  const state = emptyState({});
  const out = await walk(state, ctxOf(flow, { dry: true }), fx);
  assert.deepEqual(out, { status: "done" });
  assert.equal(state.lines.find((l) => l.step_id === "todo")?.line, "Would add a to-do: Decide on the renewal: £32.00");
  assert.equal(state.lines.find((l) => l.step_id === "w")?.status, "skipped");
  assert.equal(state.lines.find((l) => l.step_id === "tell")?.line, "Would tell you: Hi");
  assert.match(state.lines.find((l) => l.step_id === "ask")!.line, /^Would ask you/);
  assert.equal(state.lines.find((l) => l.step_id === "remind"), undefined, "the walk ends at the question");
  assert.equal(state.notices.length, 0);
  assert.ok(!calls.some(([k]) => k === "plan" || k === "made"));
  assert.ok(calls.some(([k, v]) => k === "tool" && (v as { name: string }).name === "money"), "looks still run");
  assert.match(summaryOf(state, out, { dry: true }), /^Test run on past data: nothing changed\. One step would have changed something\.$/);
});

test("a step needing a value nobody gave stops the run there, saying which", async () => {
  const { fx } = fakes({ runTool: async () => ({ result: "No payments between then and now.", changes: [] }) });
  const state = emptyState({});
  const out = await walk(state, ctxOf(flowOf([paid, todo("auto")])), fx);
  assert.equal(out.status, "stopped");
  assert.equal(state.lines.find((l) => l.step_id === "todo")?.line, "Stopped here: nothing was found for last year's price");
});

test("money steps run only while the flow and Ask may read spending", async () => {
  const { fx, calls } = fakes();
  const state = emptyState({});
  await walk(state, ctxOf(flowOf([paid]), { money: false }), fx);
  assert.equal(state.lines[0].status, "skipped");
  assert.ok(!calls.some(([k]) => k === "tool"));
});

test("a tool's own refusal fails the step and stops the run", async () => {
  const { fx } = fakes({ runTool: async () => ({ result: JSON.stringify({ error: "No area called “Garden”." }), changes: [] }) });
  const state = emptyState({});
  const out = await walk(state, ctxOf(flowOf([{ id: "f", title: null, kind: "tool", tool: "find_todos", input: { area: ["Garden"] }, go: "auto", gives: [] }])), fx);
  assert.equal(out.status, "failed");
  assert.equal(state.lines[0].line, "No area called “Garden”.");
});

test("Think: skipped in a plain flow; with an assistant it gives values, and its plan waits for Go", async () => {
  const think: FlowStep = { id: "deal", title: null, kind: "think", task: ["Find a better deal than ", { from: "trigger", key: "title" }], web: true, gives: [{ key: "deal", label: "the better deal", kind: "text" }, { key: "why", label: "why", kind: "text" }] };
  const plain = fakes();
  const s1 = emptyState({ trigger: { title: "Northwind" } });
  await walk(s1, ctxOf(flowOf([think])), plain.fx);
  assert.equal(s1.lines[0].line, "Skipped: no assistant runs this flow");

  const muse = { id: "a-1", name: "Muse", avatar: {} as never, personality: { tone: "warm" as const, pronoun: "she" as const } };
  const withA = fakes();
  const s2 = emptyState({ trigger: { title: "Northwind" } });
  assert.deepEqual(await walk(s2, ctxOf(flowOf([think], { assistant_id: "a-1" }), { assistant: muse }), withA.fx), { status: "done" });
  assert.equal(s2.lines[0].line, "Lumen Fibre charges £29 for the same speed.");
  assert.deepEqual(s2.values.deal, { deal: "Lumen Fibre at £29.00 a month", why: "same speed, £9 less" });
  assert.match(String((withA.calls.find(([k]) => k === "think")![1] as { prompt: string }).prompt), /Find a better deal than Northwind/);

  const planned = fakes({ think: async () => ({ text: "One change is ready for you.", changes: [], plan: { id: "plan-7", steps: ["Add a to-do: switch to Lumen Fibre"] } }) });
  const s3 = emptyState({ trigger: { title: "Northwind" } });
  const out = await walk(s3, ctxOf(flowOf([think], { assistant_id: "a-1" }), { assistant: muse }), planned.fx);
  assert.deepEqual(out, { status: "waiting", waits_for: "go", plan_id: "plan-7" });
  assert.equal(s3.lines[0].pending?.text, "Add a to-do: switch to Lumen Fibre");
  assert.equal(summaryOf(s3, out, { dry: false, voice: { name: "Muse", personality: muse.personality } }), "One change is ready for you. Tap Go when you're happy.");
});

test("Start an assignment: its lineup waits for Go; when it's done, its work is the step's value", async () => {
  const { fx } = fakes();
  const flow = flowOf([{ id: "asg", title: null, kind: "assignment", brief: ["Compare broadband deals for ", { from: "trigger", key: "title" }] }, { id: "tell", title: null, kind: "notify", text: ["Read ", { from: "asg", key: "note" }] }]);
  const state = emptyState({ trigger: { title: "Northwind" } });
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "waiting", waits_for: "assignment", assignment_id: "asg-1" });
  assert.equal(state.lines[0].line, "Its lineup waits for your Go in Team chat: Researcher → Writer");
  await settle(state, flow, { kind: "assignment", status: "done", title: "Broadband deals", note_id: "note-9" }, fx, { runId: "run-1", assistant: false });
  assert.deepEqual(await walk(state, ctxOf(flow), fx), { status: "done" });
  assert.equal(state.lines[1].line, "Told you: Read Broadband deals");
  const stopped = emptyState({ trigger: { title: "Northwind" } });
  await walk(stopped, ctxOf(flow), fx);
  const { end } = await settle(stopped, flow, { kind: "assignment", status: "stopped", title: "", note_id: null }, fx, { runId: "run-1", assistant: false });
  assert.equal(end?.status, "stopped");
});

test("a think step's values come from its answer's fields, or its reply when the first is empty", () => {
  assert.deepEqual(thinkValues({ text: "Two deals.", values: { deal: "Lumen", n: "2", other: "not asked for" } }, [{ key: "deal" }, { key: "n" }]), { deal: "Lumen", n: "2" });
  assert.deepEqual(thinkValues({ text: "Nothing better out there.", values: { deal: " " } }, [{ key: "deal" }]), { deal: "Nothing better out there." });
  // No VALUES: line any more: a reply that still writes one is just words.
  assert.deepEqual(thinkValues({ text: 'Two deals.\nVALUES: {"deal": "Lumen"}' }, []), {});
  const prompt = thinkPrompt({ name: "Renewal guard" }, "Find a deal", [{ key: "deal", label: "the better deal" }], { trigger: { title: "Northwind" } }, new Map([["trigger.title", "its title"]]));
  assert.match(prompt, /- its title: Northwind/);
  assert.match(prompt, /deal \(the better deal\) in the answer's values/);
  assert.doesNotMatch(prompt, /VALUES:/);
});

test("a think step with web off asks for a turn with web off, and its values as fields", async () => {
  const muse = { id: "a-1", name: "Muse", avatar: {} as never, personality: { tone: "warm" as const, pronoun: "she" as const } };
  const { fx, calls } = fakes();
  const think: FlowStep = { id: "deal", title: null, kind: "think", task: ["Look"], web: false, gives: [{ key: "deal", label: "the better deal", kind: "text" }] };
  await walk(emptyState({}), ctxOf(flowOf([think], { assistant_id: "a-1" }), { assistant: muse }), fx);
  const opts = (calls.find(([k]) => k === "think")![1] as { opts: { web: boolean; gives: unknown } }).opts;
  assert.equal(opts.web, false);
  assert.deepEqual(opts.gives, [{ key: "deal", label: "the better deal", kind: "text" }]);
});

test("a run that changed under it stops instead of guessing", async () => {
  const { fx } = fakes();
  const state = emptyState({});
  state.stack = [{ path: [[4, "yes"]], i: 0 }];
  const out = await walk(state, ctxOf(flowOf([remind])), fx);
  assert.equal(out.status, "stopped");
});

test("a failed run of an assistant's flow is tried once more only when nothing ran, and only once", () => {
  const muse = { id: "a-1", name: "Muse", avatar: {} as never, personality: { tone: "calm" as const, pronoun: "she" as const } };
  const ctx = { assistant: muse, dry: false, byHand: false };
  const busy = { status: "failed" as const, error: "Stopped at “Think about it”: Athena's AI was busy (529)" };
  assert.equal(triesAgain(emptyState(), busy, ctx), true, "failed before anything ran");
  assert.equal(triesAgain({ ...emptyState(), retried: true }, busy, ctx), false, "only one retry");
  assert.equal(triesAgain({ ...emptyState(), changes: [{ kind: "commitment", action: "created" }] }, busy, ctx), false, "a change was made");
  assert.equal(triesAgain({ ...emptyState(), touched: true }, busy, ctx), false, "a step may have changed something");
  const card = { key: "flow:r:n", title: "From Muse", body: "Prices are up", until: "" } as never;
  assert.equal(triesAgain({ ...emptyState(), notices: [card] }, busy, ctx), false, "a card is owed");
  const plan = { step_id: "s", status: "skipped" as const, line: "Skipped", at: "", pending: { text: "Add a to-do", plan_id: "p" } };
  assert.equal(triesAgain({ ...emptyState(), lines: [plan] }, busy, ctx), false, "a plan was kept");
  assert.equal(triesAgain(emptyState(), busy, { ...ctx, byHand: true }), false, "Run now is on the page the owner is looking at");
  assert.equal(triesAgain(emptyState(), busy, { ...ctx, assistant: null }), false, "a plain flow tells at once");
  assert.equal(triesAgain(emptyState(), { status: "stopped", error: "Stopped at “Wait”: nothing was found for the date." }, ctx), false, "a missing value stops the same way again");
  assert.equal(triesAgain(emptyState(), { ...busy, code: "cap" }, ctx), false, "its cap ran out");
  assert.equal(triesAgain(emptyState(), { ...busy, code: "budget" }, ctx), false, "the budget ran out");
});
