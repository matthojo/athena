// Run: npx tsx --test app/src/lib/page-title.test.ts
// The tab's title says which page it is, and which note or person is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTitle, setPageName, setPageSection } from "./page-title";

test("Home is plain Athena, whatever its label", () => {
  assert.equal(pageTitle("home", "Home"), "Athena");
  assert.equal(pageTitle("home", null), "Athena");
});

test("a section leads with the nav's label", () => {
  assert.equal(pageTitle("loops", "To do"), "To do · Athena");
  assert.equal(pageTitle("days", "Days"), "Days · Athena");
  assert.equal(pageTitle("review", "Inbox"), "Inbox · Athena");
  assert.equal(pageTitle("settings", "Settings"), "Settings · Athena");
});

test("a view with no label falls back to Athena", () => {
  assert.equal(pageTitle("kind:gone", null), "Athena");
  assert.equal(pageTitle("kind:gone", "  "), "Athena");
});

test("an open note or record leads instead of its section", () => {
  assert.equal(pageTitle("people", "People", "Priya Shah"), "Priya Shah · Athena");
  assert.equal(pageTitle("notes", "Notes", "Planning the garden"), "Planning the garden · Athena");
  // A sheet over Home names what's in it.
  assert.equal(pageTitle("home", "Home", "Planning the garden"), "Planning the garden · Athena");
  assert.equal(pageTitle("people", "People", "   "), "People · Athena");
  assert.equal(pageTitle("people", "People", null), "People · Athena");
});

test("names are kept to one short line", () => {
  assert.equal(pageTitle("notes", "Notes", "Two\n  lines"), "Two lines · Athena");
  const long = pageTitle("notes", "Notes", "x".repeat(200));
  assert.equal(long, `${"x".repeat(79)}… · Athena`);
});

test("setPageName and setPageSection write document.title, and a late release can't wipe a newer name", () => {
  const doc = { title: "Athena" };
  (globalThis as { document?: unknown }).document = doc;
  try {
    setPageSection("people", "People");
    assert.equal(doc.title, "People · Athena");
    const first = setPageName("Priya Shah");
    assert.equal(doc.title, "Priya Shah · Athena");
    const second = setPageName("Sam Okafor");
    first();
    assert.equal(doc.title, "Sam Okafor · Athena");
    second();
    assert.equal(doc.title, "People · Athena");
    setPageName("Priya Shah");
    setPageName(null);
    assert.equal(doc.title, "People · Athena");
    setPageSection("home", "Home");
    assert.equal(doc.title, "Athena");
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});
