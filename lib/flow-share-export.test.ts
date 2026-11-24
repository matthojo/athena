// Shared flows (lib/flow-share.ts): making one from a flow, adding one, and the round trip. Record ids become
// questions, links to the site go, the owner's own details are flagged, steps that lean on the owner's own types,
// fields or lists are named; an import makes its own ids, waits for Go everywhere, starts off and keeps unfilled
// blanks. Everything here is made up. Nothing needs a database.
// Run: npx tsx --test lib/flow-share-export.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allSharedSteps, BLOCKED_WHY, blankQuestion, exportFlow, flowSlug, importSharedFlow, needsAssistant, readSharedFlow, serialiseSharedFlow, stepFieldJson, stillUnfilled, type FlowExportContext } from "./flow-share";
import { checkSteps } from "./flows";
import { reachOfFlow } from "./reach";
import { ShareFormatError, type KnownTerm } from "./team-share";
import type { Flow, FlowStep } from "./flow-types";

const PERSON = "3f0c6a52-1b7e-4c55-9a51-2d1f0e8b7c6a";
const NOTE = "8d2e4f10-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";

const known: KnownTerm[] = [
  { term: "Priya Example", kind: "person" },
  { term: "Priya", kind: "person", loose: true },
  { term: "Northwind Tower", kind: "place" },
];
const ctx = (more: Partial<FlowExportContext> = {}): FlowExportContext => ({ ownHosts: ["athena.example.com"], known, ...more });

type Exportable = Pick<Flow, "name" | "trigger" | "steps" | "money">;

/** A renewal flow, as an owner might have built it here, with their own record ids in it. */
const renewal = (): Exportable => ({
  name: "Broadband renewal check",
  money: true,
  trigger: { kind: "event", event: { source: "collected", connector: "gmail", kind: "renewal" } },
  steps: [
    { id: "sab12c", title: null, kind: "tool", tool: "money", input: { merchant: ["Northwind Broadband"] }, go: "auto", gives: [{ key: "total", label: "the total", kind: "money" }] },
    {
      id: "sx9",
      title: "Did it go up?",
      kind: "check",
      condition: { left: { from: "sab12c", key: "total" }, op: "more_than", right: 30 },
      yes: [
        { id: "sq1", title: null, kind: "tool", tool: "add_todo", input: { title: ["Call about the renewal"], person_id: [PERSON] }, go: "auto", gives: [{ key: "todo", label: "the to-do", kind: "todo" }] },
        { id: "sq2", title: null, kind: "tool", tool: "draft_email", input: { about: ["Ask for last year's price"], person_id: [PERSON] }, go: "ask", gives: [] },
      ],
      no: [{ id: "sq3", title: null, kind: "notify", text: ["Renewal looks fine at ", { from: "sab12c", key: "total" }, ". Notes: https://athena.example.com/#/notes/" + NOTE] }],
    },
  ],
});

test("export: ids renumbered, record ids become one question per record, links to the site go", () => {
  const x = exportFlow(renewal(), ctx());
  const steps = allSharedSteps(x.shared.steps);
  assert.deepEqual(steps.map((s) => s.id), ["s1", "s2", "s3", "s4", "s5"]);
  const check = x.shared.steps[1];
  assert.equal(check.kind, "check");
  if (check.kind === "check") assert.deepEqual(check.condition.left, { from: "s1", key: "total" });
  // The same person in two steps is one question.
  assert.deepEqual(x.shared.asks, [{ key: "person", question: blankQuestion("person"), choices: [], fills: "person" }]);
  assert.deepEqual(x.blanks, [{ key: "person", fills: "person", steps: ["s3", "s4"] }]);
  const todo = steps[2];
  assert.ok(todo.kind === "tool" && JSON.stringify(todo.input.person_id) === JSON.stringify([{ blank: "person" }]));
  const notify = steps[4];
  assert.ok(notify.kind === "notify");
  assert.ok(!JSON.stringify(notify.text).includes("athena.example.com"));
  assert.ok(!JSON.stringify(x.shared).includes(PERSON) && !JSON.stringify(x.shared).includes(NOTE));
  assert.deepEqual(x.removed, [{ kind: "site-link", count: 1 }]);
  assert.deepEqual(x.blocked, []);
  assert.equal(x.slug, "broadband-renewal-check");
  assert.deepEqual(x.shared.needs, ["gmail"]);
  assert.equal(x.shared.money, true);
  // Nothing of the flow's own: no id, runs or assistant.
  for (const k of ["id", "assistant_id", "runs", "paused", "origin"]) assert.ok(!(k in x.shared), k);
  // It reads back as a shared flow, and its reach is worked out from it.
  assert.deepEqual(readSharedFlow(JSON.parse(serialiseSharedFlow(x.shared))), x.shared);
  assert.deepEqual(reachOfFlow(x.shared), { tier: 2, model: true, web: false, lookups: [], needs: ["gmail"] });
});

test("export: the owner's own details are flagged, and stay settled once marked fine", () => {
  const f = renewal();
  f.name = "Priya's renewal check";
  (f.steps[1] as Extract<FlowStep, { kind: "check" }>).no = [{ id: "n1", title: "Meet at Northwind Tower", kind: "notify", text: ["Ring priya.example@mailbox.test or 020 7946 0991"] }];
  const x = exportFlow(f, ctx());
  const byKind = Object.fromEntries(x.findings.map((g) => [g.kind, g]));
  assert.ok(byKind.person, "a person");
  assert.ok(byKind.place, "a place");
  assert.ok(byKind.email, "an email address");
  assert.ok(byKind.phone, "a phone number");
  assert.ok(byKind.person.where.includes("name"));
  assert.ok(byKind.place.where.includes("step:s5"));
  const again = exportFlow(f, ctx({ fine: x.findings.map((g) => g.id) }));
  assert.deepEqual(again.findings, []);
  // Made-up details aren't the owner's.
  const clean = exportFlow({ ...renewal(), steps: [{ id: "a", title: null, kind: "notify", text: ["Write to sam@example.com or 07700 900123"] }] }, ctx());
  assert.deepEqual(clean.findings, []);
});

test("export: the owner's edits change the file, and the questions are theirs to word", () => {
  const x = exportFlow(renewal(), ctx({ edits: { name: "Renewal haggler", summary: "Checks a renewal price.", version: "1.2.0", author: "sam-example", asks: [{ key: "person", question: "Who handles the bills?", choices: [], fills: "person" }] } }));
  assert.equal(x.shared.name, "Renewal haggler");
  assert.equal(x.shared.summary, "Checks a renewal price.");
  assert.equal(x.shared.version, "1.2.0");
  assert.equal(x.shared.author, "sam-example");
  assert.equal(x.shared.asks[0].question, "Who handles the bills?");
  assert.equal(x.slug, "renewal-haggler");
  // An empty question keeps the one Athena wrote.
  const y = exportFlow(renewal(), ctx({ edits: { asks: [{ key: "person", question: "  ", choices: [], fills: "person" }] } }));
  assert.equal(y.shared.asks[0].question, blankQuestion("person"));
});

test("export: two different records of a kind are two questions", () => {
  const f: Exportable = {
    name: "Catch up",
    money: false,
    trigger: { kind: "manual" },
    steps: [
      { id: "a", title: null, kind: "tool", tool: "add_todo", input: { title: ["Call"], person_id: [PERSON] }, go: "auto", gives: [] },
      { id: "b", title: null, kind: "tool", tool: "add_todo", input: { title: ["Text"], person_id: [OTHER] }, go: "auto", gives: [] },
      { id: "c", title: null, kind: "tool", tool: "save_note", input: { note_id: [NOTE], body: ["Called"] }, go: "ask", gives: [] },
    ],
  };
  const x = exportFlow(f, ctx({ recordWords: (kind) => (kind === "note" ? "Which note keeps the log?" : null) }));
  assert.deepEqual(
    x.shared.asks.map((a) => [a.key, a.question]),
    [
      ["person", "Which person should it use?"],
      ["person_2", "Which other person should it use?"],
      ["note", "Which note keeps the log?"],
    ],
  );
});

test("export: a check against one of the owner's records asks for it", () => {
  const f: Exportable = {
    name: "Is it them?",
    money: false,
    trigger: { kind: "manual" },
    steps: [
      { id: "a", title: null, kind: "tool", tool: "find_people", input: { query: ["Sam"] }, go: "ask", gives: [{ key: "person", label: "the person", kind: "person" }] },
      { id: "b", title: null, kind: "check", condition: { left: { from: "a", key: "person" }, op: "is", right: PERSON }, yes: [], no: [] },
    ],
  };
  const x = exportFlow(f, ctx());
  const check = x.shared.steps[1];
  assert.ok(check.kind === "check");
  assert.deepEqual(check.condition.right, { blank: "person" });
  assert.equal(x.shared.asks[0].fills, "person");
});

test("export: steps that lean on the owner's own types, fields or lists are named, with why", () => {
  const f: Exportable = {
    name: "Wine log",
    money: false,
    trigger: { kind: "manual" },
    steps: [
      { id: "a", title: null, kind: "tool", tool: "save_record", input: { kind: ["Wine"], title: ["A bottle"] }, go: "ask", gives: [] },
      { id: "b", title: null, kind: "tool", tool: "set_field", input: { kind: ["person"], field: ["Shoe size"], value: ["9"] }, go: "ask", gives: [] },
      { id: "c", title: null, kind: "tool", tool: "add_to_list", input: { item: ["Corkscrew"], list_title: ["Christmas gift ideas"] }, go: "auto", gives: [] },
      { id: "d", title: null, kind: "tool", tool: "link_records", input: { from_kind: ["project"], from_id: [OTHER], to_kind: ["note"], to_id: [NOTE] }, go: "ask", gives: [] },
      { id: "e", title: null, kind: "tool", tool: "add_to_list", input: { item: ["Corkscrew"], list_title: [{ from: "trigger", key: "date" }] }, go: "auto", gives: [] },
    ],
  };
  const x = exportFlow(f, ctx());
  assert.deepEqual(x.blocked, [
    { step_id: "s1", why: BLOCKED_WHY.types },
    { step_id: "s2", why: BLOCKED_WHY.field },
    { step_id: "s3", why: BLOCKED_WHY.list },
    { step_id: "s4", why: BLOCKED_WHY.project },
  ]);
  // The note it links to is still a question; nothing of the project's id is in the file.
  assert.deepEqual(x.shared.asks.map((a) => a.fills), ["note"]);
  assert.ok(!JSON.stringify(x.shared).includes(OTHER));
});

test("export: past the question limit, the step is named instead", () => {
  const ids = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
  const steps: FlowStep[] = ids.map((id, i) => ({ id: `p${i}`, title: null, kind: "tool", tool: "add_todo", input: { title: ["Call"], person_id: [id] }, go: "auto", gives: [] }));
  const x = exportFlow({ name: "Many", money: false, trigger: { kind: "manual" }, steps }, ctx());
  assert.equal(x.shared.asks.length, 8);
  assert.deepEqual(x.blocked, [{ step_id: "s9", why: BLOCKED_WHY.many }]);
});

test("flowSlug: plain letters and dashes, and a fallback", () => {
  assert.equal(flowSlug("Café — weekly review!"), "cafe-weekly-review");
  assert.equal(flowSlug("!!!"), "flow");
});

// ---------- adding one ----------

const shared = () => readSharedFlow(JSON.parse(serialiseSharedFlow(exportFlow(renewal(), ctx()).shared)));

test("import: new ids, blanks filled, every tool step waits for Go, off, origin shared, money off", () => {
  const f = importSharedFlow(shared(), { person: OTHER });
  assert.equal(f.paused, true);
  assert.equal(f.origin, "shared");
  assert.equal(f.money, false);
  assert.deepEqual(f.unfilled, []);
  const all: FlowStep[] = [];
  const walk = (xs: FlowStep[]) => xs.forEach((s) => (all.push(s), s.kind === "check" ? (walk(s.yes), walk(s.no)) : s.kind === "ask" ? s.choices.forEach((c) => walk(c.steps)) : null));
  walk(f.steps);
  assert.equal(new Set(all.map((s) => s.id)).size, 5);
  for (const s of all) assert.match(s.id, /^s[0-9a-z]{6}$/);
  assert.ok(all.every((s) => !["s1", "s2", "s3", "s4", "s5"].includes(s.id)));
  for (const s of all) if (s.kind === "tool") assert.equal(s.go, "ask", s.tool);
  const todo = all.find((s) => s.kind === "tool" && s.tool === "add_todo");
  assert.ok(todo?.kind === "tool");
  assert.deepEqual(todo.input.person_id, [OTHER]);
  // Values point at the new ids.
  const check = f.steps[1];
  assert.ok(check.kind === "check");
  assert.equal(check.condition.left.from, f.steps[0].id);
  // It passes the same checks as a flow made here.
  assert.doesNotThrow(() => checkSteps(f.steps, f.trigger));
});

test("import: what a file asks is never a grant", () => {
  const file = shared();
  const asked = readSharedFlow({
    ...JSON.parse(serialiseSharedFlow(file)),
    money: true,
    web: true,
    steps: [
      { id: "s1", title: null, kind: "tool", tool: "add_reminder", input: { text: ["Haggle"] }, go: "auto", gives: [] },
      { id: "s2", title: null, kind: "think", task: ["Find a cheaper deal"], web: true, gives: [{ key: "answer", label: "the answer", kind: "text" }] },
    ],
    asks: [],
  });
  assert.equal(asked.money, true);
  assert.equal(asked.web, true);
  const f = importSharedFlow(asked, {});
  assert.equal(f.money, false);
  assert.equal(f.paused, true);
  const [reminder, think] = f.steps;
  assert.ok(reminder.kind === "tool" && reminder.go === "ask");
  assert.ok(think.kind === "think" && think.web === false);
  assert.equal(needsAssistant(f.steps), true);
});

test("import: an unanswered blank keeps its step, listed until the field is set", () => {
  const f = importSharedFlow(shared(), {});
  const all = allOf(f.steps);
  const todo = all.find((s) => s.kind === "tool" && s.tool === "add_todo")!;
  const draft = all.find((s) => s.kind === "tool" && s.tool === "draft_email")!;
  assert.ok(todo.kind === "tool" && !("person_id" in todo.input));
  assert.deepEqual(
    f.unfilled.map((u) => [u.step_id, u.field, u.question]),
    [
      [todo.id, "input.person_id", blankQuestion("person")],
      [draft.id, "input.person_id", blankQuestion("person")],
    ],
  );
  assert.equal(stillUnfilled(f.steps, f.unfilled).length, 2);
  // The owner sets the person on the to-do: that one clears, the draft's stays.
  const set = structuredClone(f.steps);
  const t = allOf(set).find((s) => s.id === todo.id)!;
  if (t.kind === "tool") t.input.person_id = [OTHER];
  assert.deepEqual(stillUnfilled(set, f.unfilled).map((u) => u.step_id), [draft.id]);
  // A step taken out takes its blank with it.
  assert.deepEqual(stillUnfilled([set[0]], f.unfilled), []);
  assert.equal(stepFieldJson(t, "input.person_id"), JSON.stringify([OTHER]));
});

test("import: a blank in words is filled inline; a record blank needs a record", () => {
  const file = readSharedFlow({
    format: 1,
    name: "Weekly nudge",
    trigger: { kind: "schedule", days: [1], time: "09:00" },
    steps: [
      { id: "s1", title: null, kind: "notify", text: ["Time for ", { blank: "habit" }, "."] },
      { id: "s2", title: null, kind: "tool", tool: "add_todo", input: { title: ["Check in"], person_id: [{ blank: "who" }] }, go: "auto", gives: [] },
    ],
    asks: [
      { key: "habit", question: "What should it remind you about?", choices: ["a walk", "a stretch"] },
      { key: "who", question: "Who should you check in with?", fills: "person" },
    ],
  });
  const f = importSharedFlow(file, { habit: "  a   walk ", who: PERSON });
  const [notify] = f.steps;
  assert.ok(notify.kind === "notify");
  assert.deepEqual(notify.text, ["Time for ", "a walk", "."]);
  assert.throws(() => importSharedFlow(file, { who: "Sam Example" }), (e: unknown) => e instanceof ShareFormatError && /picked from the list/.test(e.message));
  // Unanswered words: the step keeps the rest of its text, and is listed.
  const g = importSharedFlow(file, { who: PERSON });
  const [n] = g.steps;
  assert.ok(n.kind === "notify");
  assert.deepEqual(n.text, ["Time for ", "."]);
  assert.deepEqual(g.unfilled.map((u) => u.field), ["text"]);
});

test("round trip: export, read, import gives the flow back, with the owner's answer in place of their record", () => {
  const before = renewal();
  const after = importSharedFlow(shared(), { person: PERSON });
  const strip = (steps: FlowStep[]): unknown => JSON.parse(JSON.stringify(steps, (k, v) => (k === "id" || k === "from" ? undefined : k === "go" ? "?" : v)));
  assert.deepEqual(strip(after.steps), strip(withoutSiteLink(before.steps)));
  assert.equal(after.name, before.name);
  assert.deepEqual(after.trigger, before.trigger);
});

function allOf(steps: FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  const walk = (xs: FlowStep[]) => {
    for (const s of xs) {
      out.push(s);
      if (s.kind === "check") (walk(s.yes), walk(s.no));
      else if (s.kind === "ask") for (const c of s.choices) walk(c.steps);
    }
  };
  walk(steps);
  return out;
}

/** The renewal's steps as the file carries them back: the link into the site is gone from its notify text. */
function withoutSiteLink(steps: FlowStep[]): FlowStep[] {
  const copy = structuredClone(steps);
  for (const s of allOf(copy)) if (s.kind === "notify") s.text = s.text.map((p) => (typeof p === "string" && p.includes("https:") ? p.replace(/ ?https:\/\/athena\.example\.com\S*/, "") : p));
  return copy;
}
