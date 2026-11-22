// A to-do's steps, links and priority (lib/todo-details.ts). No database.
// Run: npx tsx --test lib/todo-details.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanLinks,
  cleanLinkUrl,
  cleanPriority,
  cleanSteps,
  linkableText,
  linkSite,
  linkTarget,
  pastedSteps,
  MAX_LINKS,
  MAX_STEPS,
  readList,
  stepProgress,
  stepsText,
  TodoDetailsError,
} from "./todo-details";
import { contentEdgeKeys } from "./links";

const PERSON = "6f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";

test("steps: strings become open steps, blank ones go, text is one trimmed line", () => {
  const steps = cleanSteps(["  Call the surgery ", "", "   ", "Ask about\n the  repeat"]);
  assert.equal(steps.length, 2);
  assert.deepEqual(
    steps.map((s) => [s.text, s.done]),
    [
      ["Call the surgery", false],
      ["Ask about the repeat", false],
    ],
  );
  assert.ok(steps.every((s) => /^[A-Za-z0-9_-]+$/.test(s.id)));
});

test("steps: ids are kept when valid and unique, replaced when not", () => {
  const steps = cleanSteps([
    { id: "a1", text: "One", done: true },
    { id: "a1", text: "Two" },
    { id: "bad id!", text: "Three" },
  ]);
  assert.equal(steps[0].id, "a1");
  assert.equal(steps[0].done, true);
  assert.notEqual(steps[1].id, "a1");
  assert.notEqual(steps[2].id, "bad id!");
  assert.equal(new Set(steps.map((s) => s.id)).size, 3);
});

test("steps: done must be exactly true", () => {
  assert.equal(cleanSteps([{ text: "x", done: "yes" }])[0].done, false);
});

test("steps: long text is cut, too many or not a list is refused", () => {
  assert.equal(cleanSteps(["x".repeat(500)])[0].text.length, 300);
  assert.throws(() => cleanSteps(Array.from({ length: MAX_STEPS + 1 }, (_, i) => `Step ${i}`)), TodoDetailsError);
  assert.throws(() => cleanSteps("Call the surgery"), TodoDetailsError);
  assert.throws(() => cleanSteps([{ done: true }]), TodoDetailsError);
  assert.deepEqual(cleanSteps(null), []);
});

test("link addresses: http(s) and athena:// only; a bare domain gets https", () => {
  assert.equal(cleanLinkUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(cleanLinkUrl("example.com/page"), "https://example.com/page");
  assert.equal(cleanLinkUrl(`athena://person/${PERSON.toUpperCase()}`), `athena://person/${PERSON}`);
  assert.equal(cleanLinkUrl("javascript:alert(1)"), null);
  assert.equal(cleanLinkUrl("ftp://example.com/file"), null);
  assert.equal(cleanLinkUrl("athena://person/not-an-id"), null);
  assert.equal(cleanLinkUrl("just some words"), null);
  assert.equal(cleanLinkUrl(""), null);
});

test("links: untitled web links are called by their site; duplicates kept once", () => {
  const links = cleanLinks(["https://www.example.com/x", { url: "https://www.example.com/x", title: "Again" }, { url: `athena://person/${PERSON}`, title: " Priya  Shah " }]);
  assert.equal(links.length, 2);
  assert.equal(links[0].title, "example.com");
  assert.equal(links[1].title, "Priya Shah");
});

test("links: a bad address or too many is refused", () => {
  assert.throws(() => cleanLinks(["javascript:alert(1)"]), TodoDetailsError);
  assert.throws(() => cleanLinks(Array.from({ length: MAX_LINKS + 1 }, (_, i) => `https://example.com/${i}`)), TodoDetailsError);
  assert.throws(() => cleanLinks({ url: "https://example.com" }), TodoDetailsError);
});

test("priority: 0 to 3, numbers or their strings", () => {
  assert.equal(cleanPriority(3), 3);
  assert.equal(cleanPriority("2"), 2);
  assert.equal(cleanPriority(undefined), undefined);
  assert.throws(() => cleanPriority(4), TodoDetailsError);
  assert.throws(() => cleanPriority("high"), TodoDetailsError);
});

test("readList: a stored JSON string, an array, or something unreadable", () => {
  assert.equal(readList(JSON.stringify([{ id: "a", text: "One", done: false }]), cleanSteps).length, 1);
  assert.equal(readList([{ id: "a", text: "One", done: false }], cleanSteps).length, 1);
  assert.deepEqual(readList("🔒 encrypted", cleanSteps), []);
  assert.deepEqual(readList(null, cleanLinks), []);
  assert.deepEqual(readList({ not: "a list" }, cleanLinks), []);
});

test("progress and plain text", () => {
  const steps = cleanSteps([{ text: "One", done: true }, "Two", "Three"]);
  assert.deepEqual(stepProgress(steps), { done: 1, total: 3 });
  assert.deepEqual(stepProgress(undefined), { done: 0, total: 0 });
  assert.equal(stepsText(steps), "[x] One\n[ ] Two\n[ ] Three");
});

test("links in Athena become content edges from the to-do; web links don't", () => {
  const links = cleanLinks([{ url: `athena://person/${PERSON}`, title: "Priya [work]" }, "https://example.com"]);
  const text = linkableText({ notes: "See the form", links });
  assert.deepEqual(contentEdgeKeys(text, { kind: "commitment", id: "00000000-0000-0000-0000-000000000000" }), [`person:${PERSON}`]);
  assert.deepEqual(linkTarget(links[0]), { kind: "person", id: PERSON });
  assert.equal(linkTarget(links[1]), null);
  assert.equal(linkSite("https://www.nhs.example.com/a"), "nhs.example.com");
});

test("pasted lines become steps, list marks and boxes trimmed", () => {
  assert.deepEqual(pastedSteps("- Bring the slip\n* [ ] Pay at the till\n\n2. Ask about the box\n[x] Done one\r\n  plain line  "), [
    "Bring the slip",
    "Pay at the till",
    "Ask about the box",
    "Done one",
    "plain line",
  ]);
  assert.deepEqual(pastedSteps("one line"), ["one line"]);
});
