// Shared assistants in plain words (team/share-words.ts).
// Run: npx tsx --test app/src/team/share-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountName, creditWords, findingKindWords, findingsLede, fromWords, needWords, removedWords, whereWords } from "./share-words";

test("removedWords", () => {
  assert.deepEqual(removedWords([{ kind: "athena-link", count: 2 }, { kind: "site-link", count: 1 }, { kind: "record-id", count: 3 }]), ["2 links to your notes and records", "1 link to your Athena's address", "3 record ids"]);
  assert.deepEqual(removedWords([]), []);
});

test("findings: what and where", () => {
  assert.equal(findingKindWords("person"), "One of your people");
  assert.equal(whereWords(["instructions"]), "In the instructions");
  assert.equal(whereWords(["instructions", "skill", "file:shops.md"]), "In the instructions, the skill and shops.md");
  assert.match(findingsLede([]), /^Nothing is flagged\./);
  assert.equal(findingsLede([{ id: "a", kind: "person", term: "Priya", where: ["job"] }]), "This looks like one of your own details. Edit it out below, or mark it fine to share.");
});

test("accounts and needs", () => {
  assert.equal(accountName("linear"), "Linear");
  assert.equal(accountName("outlook-mail"), "Outlook mail");
  assert.equal(needWords({ id: "linear", connected: true }), "Linear is connected");
  assert.equal(needWords({ id: "gmail", connected: false }), "Needs Gmail, which isn't connected. What it does with Gmail starts once you connect it.");
});

test("where it came from, and who made it", () => {
  assert.equal(fromWords({ source: { kind: "link", url: "https://github.com/sample-author/athena-assistants/tree/main/penny", at: "" } }), "From github.com/sample-author/athena-assistants");
  assert.equal(fromWords({ source: { kind: "upload", file: "penny.zip", at: "" } }), "From penny.zip");
  assert.equal(creditWords({ author: "sample-author", version: "1.2.0" }), "By @sample-author · version 1.2.0");
  assert.equal(creditWords({ version: "2" }), "Version 2");
  assert.equal(creditWords({}), "");
});
