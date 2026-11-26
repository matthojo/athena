// Run: npx tsx --test netlify/lib/saved/routes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { savedReply } from "./routes";

const ORIGIN = "https://athena.example.com";
const item = { id: "7d1f1c1e-4a7b-4a0e-9a59-0d2b0d3c9a11", title: "Why sleep is when you learn", note: "for the sleep talk" };

test("a save answers with the new item; a capture key's repeat gets only which item it was", () => {
  assert.deepEqual(savedReply(ORIGIN, item, true, true), { id: item.id, url: `${ORIGIN}/#/saved/${item.id}`, created: true, item });
  assert.deepEqual(savedReply(ORIGIN, item, false, true), { id: item.id, url: `${ORIGIN}/#/saved/${item.id}`, created: false }, "nothing of what was already there");
  assert.deepEqual(savedReply(ORIGIN, item, false, false), { id: item.id, url: `${ORIGIN}/#/saved/${item.id}`, created: false, item }, "the app and a full key: as before");
});
