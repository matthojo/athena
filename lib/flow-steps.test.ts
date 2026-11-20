// Flows' pure half (lib/flow-steps.ts): values between steps, a tool's input from its fields, Checks and their
// lines, when a Wait carries on, and finding the way through the tree. Made-up data only.
// Run: npx tsx --test lib/flow-steps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, depthOf, fillText, listAt, MissingValue, moneyWords, numberOf, parseMoney, toolInput, toolValues, valueLabels, waitUntil, type FlowValues } from "./flow-steps";
import type { FlowStep } from "./flow-types";

const values: FlowValues = {
  trigger: { company: { id: "org-1", title: "Northwind Broadband", kind: "organisation" }, price: { amount: 38, currency: "GBP" }, renews: "2026-12-04" },
  paid: { last: { amount: 32, currency: "GBP" }, count: 12 },
};
const labels = new Map([
  ["trigger.company", "the company"],
  ["trigger.price", "the price"],
  ["paid.last", "last year's price"],
]);

test("money reads and writes as people say it", () => {
  assert.deepEqual(parseMoney("£38.00"), { amount: 38, currency: "GBP" });
  assert.deepEqual(parseMoney("1,200.50 EUR"), { amount: 1200.5, currency: "EUR" });
  assert.equal(parseMoney("38"), null);
  assert.equal(moneyWords({ amount: 32, currency: "GBP" }), "£32.00");
  assert.equal(numberOf("£38.00"), 38);
  assert.equal(numberOf("12"), 12);
  assert.equal(numberOf("twelve"), null);
});

test("text fills its chips: a record by its title, money and dates in words", () => {
  assert.equal(fillText(["Decide on ", { from: "trigger", key: "company" }, " renewal: ", { from: "trigger", key: "price" }], values), "Decide on Northwind Broadband renewal: £38.00");
  assert.equal(fillText(["Renews ", { from: "trigger", key: "renews" }], values), "Renews Fri 4 Dec");
  assert.throws(() => fillText([{ from: "paid", key: "nothing" }], values), MissingValue);
});

test("a tool's input: a single record chip gives its id to an id field, text is read the schema's way", () => {
  const tool = { input_schema: { type: "object" as const, properties: { title: { type: "string" }, person_id: { type: "string" }, due_on: { type: "string" }, limit: { type: "integer" }, tags: { type: "array" }, step: { type: "string" } } } };
  const v: FlowValues = { ...values, who: { person: { id: "p-1", title: "Sam Example" } } };
  const input = toolInput(
    { title: ["Ring ", { from: "who", key: "person" }], person_id: [{ from: "who", key: "person" }], due_on: [{ from: "trigger", key: "renews" }], limit: ["5"], tags: ["home, bills"], step: ["ignored"], nope: ["x"] },
    tool,
    v,
  );
  assert.deepEqual(input, { title: "Ring Sam Example", person_id: "p-1", due_on: "2026-12-04", limit: 5, tags: ["home", "bills"] });
});

test("a Check says what it found, in words", () => {
  const up = decide({ left: { from: "trigger", key: "price" }, op: "up_by_pct", right: 10, against: { from: "paid", key: "last" } }, values, labels);
  assert.deepEqual(up, { yes: true, line: "Yes: £38.00 is 19% more than £32.00" });
  const notEnough = decide({ left: { from: "trigger", key: "price" }, op: "up_by_pct", right: 25, against: { from: "paid", key: "last" } }, values, labels);
  assert.equal(notEnough.yes, false);
  assert.equal(notEnough.line, "No: £38.00 is 19% more than £32.00");
  assert.deepEqual(decide({ left: { from: "paid", key: "count" }, op: "more_than", right: 10 }, values, labels), { yes: true, line: "Yes: 12 is more than 10" });
  assert.equal(decide({ left: { from: "trigger", key: "company" }, op: "contains", right: "northwind" }, values, labels).yes, true);
  assert.deepEqual(decide({ left: { from: "paid", key: "missing" }, op: "exists" }, values, labels), { yes: false, line: "No: there's no missing" });
  assert.equal(decide({ left: { from: "paid", key: "missing" }, op: "is", right: "x" }, values, labels).yes, false);
});

test("a Wait carries on after some days at a time, or before a date, never past the limit", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  const tz = "Europe/London";
  assert.equal(waitUntil({ id: "w", title: null, kind: "wait", days: 2, at: "09:00" }, values, now, tz)!.toISOString(), "2026-11-22T09:00:00.000Z");
  assert.equal(waitUntil({ id: "w", title: null, kind: "wait", days: 0, at: "09:00" }, values, now, tz)!.toISOString(), "2026-11-21T09:00:00.000Z");
  assert.equal(waitUntil({ id: "w", title: null, kind: "wait", days: 1, at: null }, values, now, tz)!.toISOString(), "2026-11-21T10:00:00.000Z");
  assert.equal(waitUntil({ id: "w", title: null, kind: "wait", days: 7, before: { from: "trigger", key: "renews" }, at: null }, values, now, tz)!.toISOString(), "2026-11-27T09:00:00.000Z");
  assert.equal(waitUntil({ id: "w", title: null, kind: "wait", days: 7, before: { from: "trigger", key: "nothing" }, at: null }, values, now, tz), null);
  const far = waitUntil({ id: "w", title: null, kind: "wait", days: 999, at: null }, values, now, tz)!;
  assert.ok(far.getTime() <= now.getTime() + 60 * 86_400_000);
});

const tree: FlowStep[] = [
  { id: "a", title: null, kind: "notify", text: ["Hi"] },
  {
    id: "c",
    title: null,
    kind: "check",
    condition: { left: { from: "trigger", key: "x" }, op: "exists" },
    yes: [{ id: "q", title: null, kind: "ask", question: ["Which?"], choices: [{ label: "One", steps: [{ id: "n1", title: null, kind: "notify", text: ["1"] }] }, { label: "Two", steps: [] }] }],
    no: [],
  },
];

test("the way through the tree: lists by path, and how deep it goes", () => {
  assert.equal(listAt(tree, [])?.length, 2);
  assert.equal(listAt(tree, [[1, "yes"]])?.[0].id, "q");
  assert.equal(listAt(tree, [[1, "yes"], [0, 0]])?.[0].id, "n1");
  assert.equal(listAt(tree, [[0, "yes"]]), null);
  assert.equal(depthOf(tree), 3);
  assert.equal(valueLabels([{ key: "x", label: "the thing", kind: "text" }], tree).get("trigger.x"), "the thing");
});

test("a tool's result gives its values: counts, totals, the first record, or what it made", () => {
  const found = JSON.stringify([{ id: "p-1", name: "Sam Example" }, { id: "p-2", name: "Alex Example" }]);
  assert.deepEqual(toolValues([{ key: "person", label: "the person", kind: "person" }, { key: "count", label: "how many", kind: "number" }], found, [], "Found 2 people"), {
    person: { id: "p-1", title: "Sam Example", kind: "person" },
    count: 2,
  });
  const money = JSON.stringify({ total: "£384.00", count: 12, payments: [{ merchant: "Northwind Broadband", amount: "£32.00" }] });
  assert.deepEqual(toolValues([{ key: "total", label: "the total", kind: "money" }, { key: "latest", label: "the latest", kind: "money" }], money, [], ""), { total: { amount: 384, currency: "GBP" }, latest: { amount: 32, currency: "GBP" } });
  assert.deepEqual(toolValues([{ key: "todo", label: "the to-do", kind: "todo" }], "{}", [{ id: "t-1", title: "Decide on the renewal" }], "Added a to-do"), { todo: { id: "t-1", title: "Decide on the renewal", kind: "todo" } });
});
