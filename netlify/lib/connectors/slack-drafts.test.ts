// Run: npx tsx --test netlify/lib/connectors/slack-drafts.test.ts
// Finding a person's Slack member (by email, then exact name, never a guess), and reading the owner's own messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSlackUser, parseSlackMessages, parseSlackUsers } from "./slack-drafts";

const JSON_USERS = JSON.stringify({
  results: [
    { id: "U04PRIYA01", team_id: "T01TEAM12", real_name: "Priya Shah", profile: { email: "priya@work.example", display_name: "priya" } },
    { id: "U04PRIYA02", team_id: "T01TEAM12", real_name: "Priya Sharma", profile: { email: "psharma@work.example", display_name: "psharma" } },
  ],
});

const TEXT_USERS = `Found 3 users:

- **Tom Hale** (@tom, U05TOMHALE)
  Email: tom@work.example
  Title: Designer

- **Tom Hale** (@tomh, U05TOMHAL2)
  Email: tom.hale@other.example

- Name: Gayle King
  User ID: U06GAYLE01
  Email: gayle@work.example`;

test("users from a JSON reply, nested profiles included", () => {
  const users = parseSlackUsers(JSON_USERS);
  assert.equal(users.length, 2);
  assert.deepEqual(users[0], { id: "U04PRIYA01", team: "T01TEAM12", emails: ["priya@work.example"], names: ["Priya Shah"] });
});

test("users from a plain-text reply", () => {
  const users = parseSlackUsers(TEXT_USERS);
  assert.deepEqual(users.map((u) => u.id), ["U05TOMHALE", "U05TOMHAL2", "U06GAYLE01"]);
  assert.deepEqual(users[0].emails, ["tom@work.example"]);
  assert.ok(users[0].names.includes("Tom Hale"));
  assert.ok(users[2].names.includes("Gayle King"));
});

test("email first: one match is the answer, whatever the names say", () => {
  const users = parseSlackUsers(TEXT_USERS);
  assert.equal((matchSlackUser(users, { name: "Tom Hale", email: "TOM@work.example" }) as { id: string }).id, "U05TOMHALE");
  assert.equal((matchSlackUser(parseSlackUsers(JSON_USERS), { name: "P. Shah", email: "priya@work.example" }) as { id: string }).id, "U04PRIYA01");
});

test("then exact name; two people with that name is ambiguous, and nothing is guessed", () => {
  const users = parseSlackUsers(TEXT_USERS);
  assert.equal(matchSlackUser(users, { name: "Tom Hale", email: null }), "ambiguous");
  assert.equal(matchSlackUser(users, { name: "Tom Hale", email: "tom@home.example" }), "ambiguous");
  assert.equal((matchSlackUser(users, { name: "gayle  king", email: null }) as { id: string }).id, "U06GAYLE01");
  // Close isn't exact.
  assert.equal(matchSlackUser(parseSlackUsers(JSON_USERS), { name: "Priya", email: null }), null);
  assert.equal(matchSlackUser(parseSlackUsers(JSON_USERS), { name: "Priya S", email: null }), null);
  assert.equal(matchSlackUser([], { name: "Anyone", email: "a@b.io" }), null);
});

test("the owner's own messages: JSON text fields, or text and quoted lines", () => {
  assert.deepEqual(parseSlackMessages(JSON.stringify({ messages: [{ text: "shipping it now 🚢", user: "U01OWNER" }, { text: "  " }, { text: "thanks both, looks good" }] })), ["shipping it now 🚢", "thanks both, looks good"]);
  assert.deepEqual(parseSlackMessages("Results:\n- #eng · 2026-11-08\n  Text: on it, will post the numbers by 4\n> nice one, merging"), ["on it, will post the numbers by 4", "nice one, merging"]);
  assert.deepEqual(parseSlackMessages("No results"), []);
});
