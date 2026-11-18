// Run: npx tsx --test netlify/lib/connectors/ask-import.test.ts
// Ask and what came before Athena: the answer prompt says what Athena holds, the accounts offer every allowed
// read tool and never send or reply, cited items come back to be saved, and saving is capped per answer.
// No database (Athena's own search fails quietly without one); ask-import.db.test.ts saves for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion } from "../../../lib/answer";
import { answerSourcesWith } from "./answer-sources";
import { callTool } from "./mcp-client";
import { importAnswerItems, itemIdFrom, MAX_IMPORTS_PER_ANSWER, receiptItems } from "./ask-import";
import { answerModel, gmailAccount, LINK, NOW, scripted, THREAD, TZ, use } from "./ask-import.fixtures";

const port = (a: ReturnType<typeof gmailAccount>) => answerSourcesWith({ list: async () => [a.c], open: async () => a.open });

test("“When did I fly to Lisbon in January?” searches Gmail by date and returns the booking email to save", async () => {
  const calls: string[] = [];
  const gmail = gmailAccount(calls);
  const { client, sent } = answerModel();
  const reply = await answerQuestion("When did I fly to Lisbon in January?", { sources: port(gmail), client }, { now: NOW, tz: TZ });

  const { system, tools } = sent[0];
  assert.match(system, /Gmail \(email; in Athena since 2026-09-14\)/, "says when Athena started collecting from it");
  assert.match(system, /anything older is only in the account itself/);
  assert.match(system, /Email holds bookings \(flights, trains, hotels, tickets, with their changes and cancellations\), orders and deliveries/);
  assert.match(system, /with date filters, in parallel/);
  assert.deepEqual(tools.filter((t) => t.startsWith("gmail")), ["gmail__get_thread", "gmail__search_threads"], "every allowed read tool, and no send or reply");
  assert.deepEqual(calls, ['search_threads {"query":"flight after:2026/01/01 before:2026/02/01"}']);
  assert.equal(reply.found, true);
  assert.deepEqual(reply.sources.map((s) => [s.kind, s.url, s.account]), [["email", LINK, "Gmail"]]);
  assert.deepEqual(reply.imports, [{ connector_id: gmail.c.id, provider: "gmail", url: LINK, kind: "email", title: "Your booking is confirmed: London to Lisbon", date: "2025-12-02" }]);
});

test("Send and reply stay refused: not offered to the answer, not run if asked for, refused by the client", async () => {
  const calls: string[] = [];
  const gmail = gmailAccount(calls);
  const { client, sent } = scripted([
    (tools) => [{ type: "tool_use", id: "r", name: "gmail__reply", input: { threadId: THREAD, body: "Thanks" } }, use(tools, "search_threads", { query: "TAP" }, "s")],
    (tools) => [use(tools, "answer", { text: "Nothing about that.", found: false, sources: [] })],
  ]);
  const reply = await answerQuestion("Reply to TAP and say thanks?", { sources: port(gmail), client }, { now: NOW, tz: TZ });
  // None of the account's own tools that send or reply is offered. (Athena's own send_note and draft tools only prepare a card the owner taps.)
  assert.ok(!sent[0].tools.some((t) => t.startsWith("gmail__") && /send|reply/.test(t)), sent[0].tools.join(", "));
  assert.match(sent[1].messages, /There's no tool called gmail__reply/);
  assert.deepEqual(calls, ['search_threads {"query":"TAP"}'], "only the search ran");
  assert.equal(reply.imports, undefined, "nothing found, nothing to save");
  await assert.rejects(callTool(gmail.open, "send_message", { to: "x@example.com" }), /never sends on your behalf/);
  await assert.rejects(callTool(gmail.open, "reply", {}), /never sends on your behalf/);
  assert.equal(calls.length, 1);
});

test(`At most ${MAX_IMPORTS_PER_ANSWER} items are saved from one answer; the rest are counted and left for a collection`, async () => {
  const saved: string[] = [];
  const candidates = Array.from({ length: 7 }, (_, i) => ({
    connector_id: "6f1c0000-0000-4000-8000-00000000a001",
    provider: "gmail",
    url: `https://mail.google.com/mail/#all/thread${i}`,
    kind: "email" as const,
    title: `Email ${i}`,
    date: "2025-12-01",
  }));
  // One Athena already has, and one cited twice.
  candidates.push({ ...candidates[0] });
  const receipt = await importAnswerItems(candidates, {
    has: async (ids) => ids.includes("thread3"),
    accountName: async () => "Gmail",
    providerOf: async () => "gmail",
    collect: async (item) => {
      saved.push(item.externalId!);
      return { source: "email-digest", writes: [{ kind: "note", id: `00000000-0000-4000-8000-00000000000${saved.length}`, title: item.title }], review: 0, updated: 0 };
    },
  });
  assert.deepEqual(saved, ["thread0", "thread1", "thread2", "thread4", "thread5"]);
  assert.equal(receipt.saved.length, MAX_IMPORTS_PER_ANSWER);
  assert.equal(receipt.already, 1);
  assert.equal(receipt.over_cap, 1);
});

test("A failed item is named and the rest still save", async () => {
  const receipt = await importAnswerItems(
    [
      { connector_id: "6f1c0000-0000-4000-8000-00000000a001", provider: "gmail", url: "https://mail.google.com/mail/#all/a", kind: "email", title: "Good", date: null },
      { connector_id: "6f1c0000-0000-4000-8000-00000000a001", provider: "gmail", url: "https://mail.google.com/mail/#all/b", kind: "email", title: "Bad", date: null },
    ],
    {
      has: async () => false,
      accountName: async () => "Gmail",
      providerOf: async () => "gmail",
      collect: async (item) => {
        if (item.title === "Bad") throw new Error("signed out");
        return { source: "email-digest", writes: [{ kind: "note", id: "00000000-0000-4000-8000-000000000001", title: "Good" }], review: 1, updated: 0 };
      },
    },
  );
  assert.deepEqual(receipt.failed, ["Bad"]);
  assert.deepEqual(receipt.saved.map((s) => [s.kind, s.title, s.href, s.from]), [["note", "Good", "#/notes/00000000-0000-4000-8000-000000000001", "Gmail"]]);
  assert.equal(receipt.review, 1);
});

test("Item ids from links, as collections file them", () => {
  assert.equal(itemIdFrom("gmail", LINK), THREAD);
  assert.equal(itemIdFrom("gmail", "https://mail.google.com/mail/u/0/#inbox/abc123"), "abc123");
  const eid = Buffer.from("evt123abc owner@example.com").toString("base64").replace(/=+$/, "");
  assert.equal(itemIdFrom("google-calendar", `https://www.google.com/calendar/event?eid=${eid}`), "evt123abc");
  assert.equal(itemIdFrom("granola", "https://notes.granola.ai/d/0f7f1c2e-1111-4222-8333-944455556666"), "0f7f1c2e-1111-4222-8333-944455556666");
  assert.equal(itemIdFrom("linear", "https://linear.app/acme/issue/ENG-42/fix-it"), "ENG-42");
  assert.equal(itemIdFrom("trakt", "https://trakt.tv/movies/past-lives-2023"), null);
});

test("A trip's bookings are one receipt line; its Undo archives them, then the trip when this started it", () => {
  const trip = { id: "11111111-0000-4000-8000-000000000001", name: "Lisbon, 14–18 Jan", created: true };
  const lines = receiptItems(
    {
      source: "email-digest",
      writes: [
        { kind: "booking", id: "b1", title: "TP 1351", trip },
        { kind: "booking", id: "b2", title: "TP 1350", trip },
        { kind: "commitment", id: "c1", title: "Check in online" },
      ],
      review: 0,
      updated: 0,
    },
    "Gmail",
  );
  assert.deepEqual(lines, [
    { kind: "trip", title: "Lisbon, 14–18 Jan", href: `#/trips/${trip.id}`, from: "Gmail", undo: [{ op: "archive", kind: "booking", id: "b1" }, { op: "archive", kind: "booking", id: "b2" }, { op: "archive", kind: "trip", id: trip.id }] },
    { kind: "todo", title: "Check in online", href: "#/loops", from: "Gmail", undo: [{ op: "archive", kind: "commitment", id: "c1" }] },
  ]);
});

test("A day entry from a Life log item gets an Undo that hides that import's entries", () => {
  const importId = "22222222-0000-4000-8000-000000000002";
  const lines = receiptItems({ source: "life-log-trakt", writes: [{ kind: "day", id: "2025-01-16", title: "Past Lives" }], review: 0, updated: 0 }, "Trakt", importId);
  assert.deepEqual(lines, [{ kind: "day", title: "Past Lives", href: "#/days/2025-01-16", from: "Trakt", undo: [{ op: "archive_day_import", run_id: importId }] }]);
});

test("Linear and GitHub are read live only: nothing cited from them is saved, whatever the app says the account is", async () => {
  const saved: string[] = [];
  const collect = async (item: { externalId: string | null; title: string }) => {
    saved.push(item.title);
    return { source: "work-activity", writes: [{ kind: "note" as const, id: "00000000-0000-4000-8000-000000000001", title: item.title }], review: 0, updated: 0 };
  };
  const ws = "6f1c0000-0000-4000-8000-00000000b001";
  const receipt = await importAnswerItems(
    [
      { connector_id: ws, provider: "linear", url: "https://linear.app/acme/issue/ENG-42/priyas-refactor", kind: "page", title: "Priya's refactor", date: null },
      // The app says Gmail; the stored account is GitHub.
      { connector_id: ws, provider: "gmail", url: "https://github.com/acme/app/pull/40", kind: "page", title: "Priya's PR", date: null },
    ],
    { has: async () => false, accountName: async () => "Work", providerOf: async () => "github", collect: collect as never },
  );
  assert.deepEqual(saved, []);
  assert.deepEqual(receipt.saved, []);
  // An account that can't be looked up saves nothing either.
  const unknown = await importAnswerItems([{ connector_id: ws, provider: "gmail", url: "https://mail.google.com/mail/#all/x", kind: "email", title: "x", date: null }], { has: async () => false, providerOf: async () => { throw new Error("no db"); }, collect: collect as never });
  assert.deepEqual(unknown.saved, []);
});
