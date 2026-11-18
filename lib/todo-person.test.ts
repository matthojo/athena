// Who a to-do is about (lib/todo-person.ts): the matcher, and source checks that the capture path can't reach it.
// No database. The route, the gate and dismissals against Postgres are in netlify/lib/todo-people.db.test.ts.
// Run: npx tsx --test lib/todo-person.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MAX_PERSON_SUGGESTIONS, peopleNamedIn, wantsPersonSuggestion, type NamedPerson } from "./todo-person";
import { CAPTURE_TOOLS } from "./assistant";

const PRIYA: NamedPerson = { id: "p1", name: "Priya Shah", aliases: ["P Shah"], last_contacted_at: "2026-11-01T10:00:00.000Z" };
const PRIYA_N: NamedPerson = { id: "p2", name: "Priya Nair", last_contacted_at: "2026-10-01T10:00:00.000Z" };
const MARCUS: NamedPerson = { id: "p3", name: "Marcus Webb" };
const MUM: NamedPerson = { id: "p4", name: "Margaret Jones", aliases: ["Mum"] };
const ELENA: NamedPerson = { id: "p5", name: "Dr Elena Rossi" };
const WILL: NamedPerson = { id: "p6", name: "Will Okafor" };
const MARK: NamedPerson = { id: "p7", name: "Mark" };
const ZOE: NamedPerson = { id: "p8", name: "Zoë O'Brien" };
const AL: NamedPerson = { id: "p9", name: "Al Green" };
const EVERYONE = [PRIYA, MARCUS, MUM, ELENA, WILL, MARK, ZOE, AL];
const names = (text: string, people = EVERYONE) => peopleNamedIn(text, people).map((p) => p.name);

test("one match: a first name, a whole name, a nickname, any case, with 's", () => {
  assert.deepEqual(names("Call Priya about Saturday"), ["Priya Shah"]);
  assert.deepEqual(names("call priya"), ["Priya Shah"], "typed in lower case");
  assert.deepEqual(names("Send Marcus Webb the deck"), ["Marcus Webb"]);
  assert.deepEqual(names("Book Marcus's leaving do"), ["Marcus Webb"]);
  assert.deepEqual(names("Ring mum back"), ["Margaret Jones"], "a one-word nickname");
  assert.deepEqual(names("Chase P Shah for the invoice"), ["Priya Shah"], "a two-word nickname");
  assert.deepEqual(names("Reply to Elena"), ["Dr Elena Rossi"], "a title isn't the first name");
  assert.deepEqual(names("Lunch with Zoe"), ["Zoë O'Brien"], "accents don't matter");
  assert.deepEqual(peopleNamedIn("Call Priya", EVERYONE), [{ id: "p1", name: "Priya Shah" }], "ids and names only");
});

test("no match shows nothing", () => {
  assert.deepEqual(names("Buy milk"), []);
  assert.deepEqual(names(""), []);
  assert.deepEqual(names("Call Priya", []), []);
  assert.deepEqual(names("Check the marcuswebb.example invoice"), [], "whole words only");
  assert.deepEqual(names("Renew the Webb telescope subscription"), [], "a surname alone isn't offered");
  assert.deepEqual(names("Priyanka's birthday card"), [], "not part of a longer word");
});

test("several matches are offered as choices, never guessed", () => {
  const two = [PRIYA, PRIYA_N, MARCUS];
  assert.deepEqual(names("Call Priya", two), ["Priya Shah", "Priya Nair"], "most recently in touch first");
  assert.deepEqual(names("Call Priya Nair", two), ["Priya Nair"], "a whole name settles it");
  assert.deepEqual(names("Ask Priya Shah to ring Marcus", two), ["Priya Shah", "Marcus Webb"], "two people named: in the order named");
  const many = ["A", "B", "C", "D", "E"].map((s, i) => ({ id: `s${i}`, name: `Sam ${s}` }));
  assert.equal(peopleNamedIn("Text Sam", many).length, MAX_PERSON_SUGGESTIONS);
  assert.equal(MAX_PERSON_SUGGESTIONS, 3);
  assert.deepEqual(names("Call Priya and then Priya again", [PRIYA]), ["Priya Shah"], "once each");
});

test("names that are everyday words, or very short, count only when written as a name", () => {
  assert.deepEqual(names("Mark the invoices as paid"), [], "first word");
  assert.deepEqual(names("will call the bank"), []);
  assert.deepEqual(names("Decide what we will do in May"), []);
  assert.deepEqual(names("Email Will about the roof"), ["Will Okafor"]);
  assert.deepEqual(names("Send Mark the keys"), ["Mark"]);
  assert.deepEqual(names("Email Will Okafor"), ["Will Okafor"], "a whole name counts anywhere");
  assert.deepEqual(names("Buy al dente pasta"), []);
  assert.deepEqual(names("Lunch with Al"), ["Al Green"]);
});

test("which to-dos get a suggestion", () => {
  const c = { kind: "todo", status: "open", person_id: null, archived_at: null };
  assert.equal(wantsPersonSuggestion(c), true);
  assert.equal(wantsPersonSuggestion({ ...c, kind: "waiting_on" }), true);
  assert.equal(wantsPersonSuggestion({ ...c, person_id: "p1" }), false, "already linked");
  assert.equal(wantsPersonSuggestion({ ...c, status: "done" }), false);
  assert.equal(wantsPersonSuggestion({ ...c, kind: "decision" }), false);
  assert.equal(wantsPersonSuggestion({ ...c, archived_at: "2026-11-01" }), false);
});

// ---------- the capture path can't reach it ----------

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const NEW_CODE = /todo-person|todo-people|peopleNamedIn|todoPersonSuggestions|dismissTodoPerson/;

test("a capture reads nothing: the capture route and Ask's assistant never touch the suggestion code", () => {
  // Ask's assistant (and so every capture) doesn't import or call it; neither does anything else a model can call.
  for (const file of readdirSync(new URL(".", import.meta.url)).filter((f) => /^(assistant|ask-|answer|collection|mcp)/.test(f) && f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    assert.doesNotMatch(read(`./${file}`), NEW_CODE, `lib/${file}`);
  }
  assert.doesNotMatch(read("../netlify/functions/mcp.ts"), NEW_CODE, "no MCP tool");
  assert.deepEqual([...CAPTURE_TOOLS].sort(), ["add_reminder", "add_to_list", "add_to_watch_read", "add_todo", "save_note"], "the capture allow-list is unchanged");

  const api = read("../netlify/functions/api.ts");
  // The capture handler and what it calls: from its doc comment to the next section.
  const from = api.indexOf("async function captureText(");
  const to = api.indexOf("async function handleApiKeys(", from) > 0 ? api.indexOf("async function handleApiKeys(", from) : api.indexOf("// ---------- entry point", from);
  assert.ok(from > 0 && to > from, "found the capture handler");
  const capture = api.slice(from, to);
  assert.match(capture, /async function handleCapture\(/);
  assert.doesNotMatch(capture, NEW_CODE, "handleCapture doesn't call it");
  assert.doesNotMatch(capture, /resolvePerson|findPeople|listPeople/, "and still looks nobody up");

  // The only mount is after the full gate; every capture-key route returns before it.
  const gate = api.indexOf("Everything else: the master token or a full key");
  const mounts = [...api.matchAll(/handleTodoPeopleRoutes\(/g)].map((m) => m.index!);
  assert.equal(mounts.length, 1);
  assert.ok(gate > 0 && mounts[0] > gate, "mounted below the full gate");
  for (const m of api.matchAll(/authorized\(req, "capture"\)/g)) assert.ok(m.index! < gate, "capture-key routes sit above the gate");

  // The routes and the reader are the only server code that uses the matcher.
  assert.match(read("../netlify/lib/todo-people-routes.ts"), /from "..\/..\/lib\/todo-people"/);
  assert.doesNotMatch(read("./todo-person.ts"), /from "\.\/(db|memory)"/, "the rules do no I/O");
});
