// Run: npx tsx --test app/src/db/ask-threads.test.ts
// The receipt under an answer is kept with the conversation and read back on reopening, so Undo still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterThreads, keepAssistant, keepReceipt, receiptFromKept, threadAssistant, threadLines } from "./ask-threads";

const receipt = {
  saved: [
    { kind: "trip", title: "Lisbon, 14–18 Jan", href: "#/trips/t1", from: "Gmail", undo: [{ op: "archive", kind: "booking", id: "b1" }, { op: "archive", kind: "trip", id: "t1" }] },
    { kind: "day", title: "Past Lives", href: "#/days/2026-01-16", from: "Trakt", undo: [{ op: "archive_day_import", run_id: "33333333-0000-4000-8000-000000000003" }] },
  ],
  review: 1,
  already: 2,
  failed: ["A receipt from Uber"],
  over_cap: 0,
};

test("A receipt and what was undone survive the conversation being saved and reopened", () => {
  const kept = keepReceipt(receipt, new Set([1]));
  const back = receiptFromKept(JSON.parse(JSON.stringify(kept)));
  assert.deepEqual(back, { ...receipt, undone: [1] });
  // The Undo ops come back whole, so Undo still sends them.
  assert.deepEqual(back?.saved[1].undo, [{ op: "archive_day_import", run_id: "33333333-0000-4000-8000-000000000003" }]);
});

test("An answer saved before receipts has none", () => {
  assert.equal(receiptFromKept(undefined), null);
  assert.equal(receiptFromKept(null), null);
});

test("Something that isn't a receipt isn't shown", () => {
  assert.equal(receiptFromKept({ saved: "nope" }), null);
  assert.equal(receiptFromKept({ saved: [{ title: "No link" }] }), null);
  // Undone indexes past the end are ignored.
  assert.deepEqual(receiptFromKept({ ...receipt, undone: [0, 7, -1, 0] })?.undone, [0]);
});

test("\"In past conversations\" snippets have no bold stars, list dashes or step numbers", () => {
  const thread = {
    messages: [
      { role: "me", text: "What are the next steps?" },
      { role: "answer", question: "What are the next steps?", text: "Three steps [1]:\n\n1. **Split the roadmap** [1].\n2. Run it past Elena [2].\n\n- A dash line\n- 5 - 3 is 2." },
      { role: "assistant", reply: { text: "**Done.** I added:\n- Book the MOT\n10. Tenth" } },
    ],
  } as unknown as Parameters<typeof threadLines>[0];
  assert.deepEqual(threadLines(thread), [
    "What are the next steps?",
    "Three steps: Split the roadmap. Run it past Elena. A dash line 5 - 3 is 2.",
    "Done. I added: Book the MOT Tenth",
  ]);
});

test("Ask's main list leaves out an assistant's conversations; filtering by that assistant shows only its own", () => {
  const threads = [{ id: "a" }, { id: "b", assistant_id: null }, { id: "c", assistant_id: "penny" }, { id: "d", assistant_id: "dot" }];
  assert.deepEqual(filterThreads(threads, null).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(filterThreads(threads, "penny").map((t) => t.id), ["c"]);
  assert.deepEqual(filterThreads(threads, "all").map((t) => t.id), ["a", "b", "c", "d"]);
  assert.equal(threadAssistant({ assistant_id: "" }), null);
});

test("A copy from a server that doesn't keep assistant_id yet still knows who the conversation is with", () => {
  const remote: { id: string; title: string; messages: never[]; created_at: string; updated_at: string; assistant_id?: string | null } = { id: "c", title: "", messages: [], created_at: "2026-11-12T09:00:00Z", updated_at: "2026-11-12T09:05:00Z" };
  assert.equal(keepAssistant(remote, { assistant_id: "penny" }).assistant_id, "penny");
  // The server's own answer wins once it sends one, null included.
  assert.equal(keepAssistant({ ...remote, assistant_id: null }, { assistant_id: "penny" }).assistant_id, null);
  assert.equal(keepAssistant(remote, undefined), remote);
});
