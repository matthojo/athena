// To do's quick-add line (lib/todo-quick.ts). No database.
// Run: npx tsx --test lib/todo-quick.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickTodo } from "./todo-quick";

// A Sunday.
const TODAY = "2026-11-22";
const q = (s: string) => parseQuickTodo(s, TODAY);

test("plain words stay as they are", () => {
  assert.deepEqual(q("Book the car's MOT"), { title: "Book the car's MOT", found: {} });
  assert.deepEqual(q("  Call   Mum  "), { title: "Call Mum", found: {} });
});

test("a date at the end: today, tomorrow, weekdays, next week", () => {
  assert.deepEqual(q("Book the MOT tomorrow"), { title: "Book the MOT", due_on: "2026-11-23", found: { due: "tomorrow" } });
  assert.equal(q("Pick up prescription today").due_on, TODAY);
  assert.equal(q("Pay the window cleaner tonight").due_on, TODAY);
  assert.equal(q("Send the deck Fri").due_on, "2026-11-27");
  assert.equal(q("Send the deck friday").due_on, "2026-11-27");
  assert.equal(q("Send the deck next Friday").due_on, "2026-12-04");
  assert.equal(q("Plan the sprint next week").due_on, "2026-11-23");
  assert.equal(q("Clean the bikes this weekend").due_on, "2026-11-28");
  assert.equal(q("Renew the passport in 3 weeks").due_on, "2026-12-13");
  assert.equal(q("Chase the plumber in 2 days").due_on, "2026-11-24");
});

test("a weekday that is today means next week's", () => {
  assert.equal(q("Bins out sunday").due_on, "2026-11-29");
});

test("day and month, either order, this year or next", () => {
  assert.equal(q("Book flights 12 Dec").due_on, "2026-12-12");
  assert.equal(q("Book flights December 12th").due_on, "2026-12-12");
  assert.equal(q("Renew the insurance 3 March").due_on, "2027-03-03");
  assert.equal(q("Renew the insurance 31 Apr").due_on, undefined);
});

test("on / by / due before the date go with it", () => {
  assert.deepEqual(q("Send Priya the deck by Friday"), { title: "Send Priya the deck", due_on: "2026-11-27", found: { due: "by Friday" } });
  assert.equal(q("Dentist on 3 Dec").title, "Dentist");
  assert.equal(q("Tax return due tomorrow").title, "Tax return");
});

test("a priority anywhere, as its own word", () => {
  assert.deepEqual(q("!high Fix the leak"), { title: "Fix the leak", priority: 3, found: { priority: "!high" } });
  assert.equal(q("Fix the leak !1").priority, 3);
  assert.equal(q("Fix the leak !med").priority, 2);
  assert.equal(q("Fix the leak !3").priority, 1);
  assert.deepEqual(q("Book the MOT !high tomorrow"), { title: "Book the MOT", due_on: "2026-11-23", priority: 3, found: { priority: "!high", due: "tomorrow" } });
});

test("nothing is read out of the middle of a title, and never all of it", () => {
  assert.deepEqual(q("Watch Tomorrow Never Dies"), { title: "Watch Tomorrow Never Dies", found: {} });
  assert.deepEqual(q("Friday drinks with Tom"), { title: "Friday drinks with Tom", found: {} });
  assert.deepEqual(q("Tomorrow"), { title: "Tomorrow", found: {} });
  assert.deepEqual(q("!high"), { title: "!high", found: {} });
  assert.equal(q("Read May Sarton").due_on, undefined);
  assert.equal(q("Wow!1").priority, undefined);
});
