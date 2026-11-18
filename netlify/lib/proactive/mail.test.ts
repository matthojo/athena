// Awaiting reply's sent mail: a search_threads result read into threads, and who answered last.
// Run: npx tsx --test netlify/lib/proactive/mail.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sentThreads } from "./mail";

test("sent threads: the latest message decides whether anyone answered", () => {
  const text = JSON.stringify({
    threads: [
      { id: "a", messages: [{ sender: "Me <me@example.com>", toRecipients: ["Tom Reed <tom@example.com>"], subject: "Q3 budget", snippet: "Could you confirm?", date: "2026-11-03T10:00:00Z", labelIds: ["SENT"] }] },
      { id: "b", messages: [{ sender: "Tom Reed <tom@example.com>", toRecipients: ["me@example.com"], subject: "Re: plans", snippet: "Yes, works", date: "2026-11-04T10:00:00Z", labelIds: ["INBOX"] }] },
      { id: "c", messages: [{ toRecipients: ["not an address"], date: "2026-11-04T10:00:00Z", labelIds: ["SENT"] }] },
    ],
  });
  const out = sentThreads(text, { id: "gm", created_at: "2026-11-01T00:00:00Z" });
  assert.deepEqual(out.map((t) => [t.id, t.unanswered, t.to.email, t.backfilled]), [["a", true, "tom@example.com", false], ["b", false, "me@example.com", false]]);
  assert.equal(sentThreads(text, { id: "gm", created_at: "2026-11-05T00:00:00Z" })[0].backfilled, true, "sent before the mailbox was connected");
  assert.deepEqual(sentThreads("not json", { id: "gm" }), []);
});
