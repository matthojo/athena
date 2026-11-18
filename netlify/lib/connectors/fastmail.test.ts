// Fastmail over JMAP: the token only ever goes to api.fastmail.com, only read methods are sent, Gmail's search
// becomes a JMAP filter, and the tools give Gmail-shaped threads with the owner's rules applied.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connector } from "../../../lib/connectors";
import { NO_RULES } from "../../../lib/mail-rules";
import { openFastmail } from "./fastmail-direct";
import { LifeApiError } from "./lifelog-b-http";
import { fastmailAdapter } from "./fastmail-direct";

const NOW = new Date("2026-11-12T12:00:00Z");
const BOXES = [
  { id: "mb-in", name: "Inbox", role: "inbox" },
  { id: "mb-sent", name: "Sent", role: "sent" },
  { id: "mb-drafts", name: "Drafts", role: "drafts" },
  { id: "mb-trash", name: "Trash", role: "trash" },
  { id: "mb-junk", name: "Spam", role: "junk" },
  { id: "mb-receipts", name: "Receipts", role: null },
];
const EMAILS = [
  { id: "M1", threadId: "T1", mailboxIds: { "mb-in": true }, keywords: {}, from: [{ name: "Priya Shah", email: "priya@example.com" }], to: [{ email: "me@fastmail.com" }], subject: "Pricing memo", receivedAt: "2026-11-11T09:00:00Z", preview: "Here's the memo",
    textBody: [{ partId: "1", type: "text/plain" }], bodyValues: { "1": { value: "Here's the memo.\n\nOn Tue, 10 Nov 2026 at 09:00, Me <me@fastmail.com> wrote:\n> Can you send the memo?" } }, attachments: [{ name: "memo.pdf", disposition: "attachment" }, { name: "logo.png", disposition: "inline" }] },
  { id: "M2", threadId: "T1", mailboxIds: { "mb-sent": true }, keywords: { $seen: true }, from: [{ email: "me@fastmail.com" }], to: [{ name: "Priya Shah", email: "priya@example.com" }], subject: "Re: Pricing memo", receivedAt: "2026-11-11T10:00:00Z", preview: "Thanks",
    textBody: [{ partId: "1", type: "text/html" }], bodyValues: { "1": { value: "<p>Thanks, <b>reading</b> it now.</p>" } } },
  { id: "M3", threadId: "T2", mailboxIds: { "mb-receipts": true }, keywords: { $seen: true, $flagged: true }, from: [{ name: "Shop", email: "orders@shop.example" }], to: [{ email: "me@fastmail.com" }], subject: "Your receipt", receivedAt: "2026-11-10T08:00:00Z", preview: "Order 123" },
  { id: "M4", threadId: "T1", mailboxIds: { "mb-drafts": true }, keywords: { $draft: true }, from: [{ email: "me@fastmail.com" }], subject: "Re: Pricing memo", receivedAt: "2026-11-11T11:00:00Z", preview: "draft" },
];

type Call = [string, Record<string, any>, string];

/** A small JMAP server: back-references resolved, Email/query answering with the ids each test sets. */
function fastmail(opts: { query?: string[]; status?: number; session?: Record<string, unknown>; readOnly?: boolean } = {}) {
  const sent: Array<{ url: string; auth: string | null; calls: Call[] }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization");
    if (opts.status) return new Response("{}", { status: opts.status });
    if (init.method === "GET") {
      sent.push({ url, auth, calls: [] });
      return new Response(JSON.stringify(opts.session ?? { apiUrl: "https://api.fastmail.com/jmap/api/", username: "me@fastmail.com", primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } }));
    }
    const body = JSON.parse(String(init.body)) as { methodCalls: Call[] };
    sent.push({ url, auth, calls: body.methodCalls });
    const done = new Map<string, Record<string, any>>();
    const ref = (r: { resultOf: string; path: string }): string[] => {
      const from = done.get(r.resultOf)!;
      if (r.path === "/ids") return from.ids;
      const [, , , key] = r.path.split("/");
      return (from.list as Array<Record<string, any>>).flatMap((x) => x[key]);
    };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      const ids: string[] | null = args["#ids"] ? ref(args["#ids"]) : (args.ids ?? null);
      let result: Record<string, any>;
      if (name === "Mailbox/get") result = { list: BOXES };
      else if (name === "Email/query") result = { ids: (opts.query ?? ["M2", "M3"]).slice(args.position ?? 0, (args.position ?? 0) + args.limit), total: 2 };
      else if (name === "Thread/get") result = { list: [...new Set(ids)].filter((t) => EMAILS.some((e) => e.threadId === t)).map((t) => ({ id: t, emailIds: EMAILS.filter((e) => e.threadId === t).map((e) => e.id) })) };
      else if (name === "Email/get") result = { list: EMAILS.filter((e) => ids!.includes(e.id)).map((e) => (args.properties?.includes("messageId") ? { ...e, messageId: [`<${e.id}@example.com>`], references: null } : e)) };
      else if (name === "Email/set") result = opts.readOnly ? { notCreated: { draft: { type: "forbidden" } } } : { created: { draft: { id: "M9", threadId: "T1" } } };
      else result = { type: "unknownMethod" };
      done.set(id, result);
      return [result.type ? "error" : name, result, id];
    });
    return new Response(JSON.stringify({ methodResponses }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const connector = (rules = NO_RULES) => ({ id: "c1", provider: "fastmail", auth_type: "token", scope: "", mail_rules: rules }) as unknown as Connector;
const open = (f: ReturnType<typeof fastmail>, rules = NO_RULES) => openFastmail(connector(rules), { token: " fmu1-secret " }, { fetch: f.fetchImpl, now: () => NOW });
const run = async (a: Awaited<ReturnType<typeof open>>, name: string, args: Record<string, unknown> = {}) => {
  const r = await a.call(name, args);
  return r.isError ? r.text : JSON.parse(r.text);
};

test("opening: the token goes to api.fastmail.com as a Bearer header, the account id is filled in, and only read methods are ever sent", async () => {
  const f = fastmail();
  const a = await open(f);
  assert.deepEqual(a.tools.map((t) => t.name), ["search_threads", "get_thread", "get_message", "list_labels"]);
  assert.ok(a.tools.every((t) => t.annotations.readOnlyHint));
  await run(a, "search_threads", {});
  await run(a, "get_thread", { threadId: "T1" });
  await run(a, "get_message", { messageId: "M1" });
  for (const s of f.sent) {
    assert.equal(new URL(s.url).hostname, "api.fastmail.com");
    assert.ok(!JSON.stringify(s.calls).includes("submission"));
    assert.equal(s.auth, "Bearer fmu1-secret");
    for (const [name, args] of s.calls) {
      assert.match(name, /^(Mailbox\/get|Email\/query|Email\/get|Thread\/get)$/);
      assert.equal(args.accountId, "acc1");
    }
  }
  assert.ok(fastmailAdapter.handles({ provider: "fastmail", auth_type: "token", oauth: {} } as never));
});

test("a token Fastmail refuses, or one that can't read mail, is the owner's to fix; a session that points elsewhere is never followed", async () => {
  await assert.rejects(open(fastmail({ status: 401 })), (e) => e instanceof LifeApiError && e.owner && /didn't accept/.test(e.message));
  await assert.rejects(open(fastmail({ session: { apiUrl: "https://api.fastmail.com/jmap/api/", primaryAccounts: {} } })), (e) => e instanceof LifeApiError && e.owner && /can't read email/.test(e.message));
  await assert.rejects(openFastmail(connector(), {}, {}), (e) => e instanceof LifeApiError && e.owner);
  const elsewhere = fastmail({ session: { apiUrl: "https://evil.example/jmap/", primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } } });
  await assert.rejects(open(elsewhere), /isn't Fastmail's/);
  assert.equal(elsewhere.sent.length, 1);
  await assert.rejects(open(fastmail({ session: { apiUrl: "https://api.notfastmail.com/jmap/", primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } } })), /isn't Fastmail's/);
  await assert.rejects(open(fastmail({ session: { apiUrl: "http://api.fastmail.com/jmap/", primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } } })), /isn't Fastmail's/);
  // Another Fastmail host is fine: the first version refused it and no account could connect.
  const other = fastmail({ session: { apiUrl: "https://jmap.fastmail.com/api/", username: "me@fastmail.com", primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" } } });
  assert.equal((await open(other)).tools.length, 4);
  assert.equal(new URL(other.sent.at(-1)!.url).hostname, "jmap.fastmail.com");
});

test("Gmail's search becomes a JMAP filter: Drafts, Trash and Spam left out, dates widened, OR joined", async () => {
  const f = fastmail();
  const a = await open(f);
  await run(a, "search_threads", { query: 'from:priya@example.com subject:"pricing memo" after:2026/11/01 -in:sent is:unread invoice OR receipt', pageSize: 5 });
  const [, args] = f.sent.at(-1)!.calls[0];
  assert.equal(args.collapseThreads, true);
  assert.equal(args.limit, 6);
  assert.deepEqual(args.filter, {
    operator: "AND",
    conditions: [
      { from: "priya@example.com" },
      { subject: "pricing memo" },
      { after: "2026-10-31T10:00:00Z" },
      { operator: "NOT", conditions: [{ inMailbox: "mb-sent" }] },
      { notKeyword: "$seen" },
      { operator: "OR", conditions: [{ text: "invoice" }, { text: "receipt" }] },
      { inMailboxOtherThan: ["mb-drafts", "mb-trash", "mb-junk"] },
    ],
  });
  await run(a, "search_threads", { query: "in:trash" });
  assert.deepEqual(f.sent.at(-1)!.calls[0][1].filter, { operator: "AND", conditions: [{ inMailbox: "mb-trash" }, { inMailboxOtherThan: ["mb-drafts"] }] });
  assert.match(await run(a, "search_threads", { query: "in:nowhere" }), /no folder called "nowhere"/);
});

test("search gives Gmail-shaped threads: latest messages, labels by role, a draft left out, and a page token when there's more", async () => {
  const a = await open(fastmail());
  const got = await run(a, "search_threads", { pageSize: 1 });
  assert.equal(got.nextPageToken, "p1");
  assert.equal(got.threads.length, 1);
  const t = got.threads[0];
  assert.equal(t.id, "T1");
  assert.equal(t.messageCount, 2);
  assert.equal(t.viewUrl, "https://app.fastmail.com/mail/Inbox/T1.M2");
  assert.deepEqual(t.messages.map((m: { sender: string }) => m.sender), ["Priya Shah <priya@example.com>", "me@fastmail.com"]);
  assert.deepEqual(t.messages[0].labelIds, ["INBOX", "UNREAD"]);
  assert.deepEqual(t.messages[1].labelIds, ["SENT"]);
  assert.equal(t.messages[0].date, "2026-11-11T09:00:00.000Z");
  const summary = await run(a, "search_threads", { view: "THREAD_VIEW_SUMMARY" });
  assert.deepEqual(summary.threads.map((x: { id: string; messages: unknown[] }) => [x.id, x.messages.length]), [["T1", 1], ["T2", 1]]);
  assert.deepEqual(summary.threads[1].messages[0].labelIds, ["Receipts", "STARRED"]);
  assert.deepEqual(await run(await open(fastmail({ query: [] })), "search_threads", {}), {});
});

test("reading: plain text with quoted replies dropped, an HTML-only email converted, attachments named but not pictures inside the email", async () => {
  const a = await open(fastmail());
  const t = await run(a, "get_thread", { threadId: "T1" });
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].plaintextBody, "Here's the memo.");
  assert.deepEqual(t.messages[0].attachments, ["memo.pdf"]);
  assert.equal(t.messages[1].plaintextBody, "Thanks, reading it now.");
  const m = await run(a, "get_message", { messageId: "M1" });
  assert.equal(m.threadId, "T1");
  assert.equal(m.plaintextBody, "Here's the memo.");
  assert.match(await run(a, "get_message", { messageId: "M4" }), /Not found/);
  assert.match(await run(a, "get_thread", { threadId: "T9" }), /Not found/);
  const labels = await run(a, "list_labels");
  assert.deepEqual(labels.labels.find((l: { name: string }) => l.name === "Receipts"), { id: "mb-receipts", name: "Receipts", type: "user" });
});

test("the owner's rules: in the filter Fastmail runs, checked again on what comes back, and counted", async () => {
  const rules = { ...NO_RULES, inbox_only: true, skip_senders: ["shop.example"] };
  const f = fastmail();
  const a = await open(f, rules);
  const got = await run(a, "search_threads", {});
  const calls = f.sent.at(-1)!.calls;
  assert.deepEqual(calls[0][1].filter.conditions.slice(-2), [
    { operator: "NOT", conditions: [{ from: "shop.example" }] },
    { operator: "OR", conditions: [{ inMailbox: "mb-in" }, { inMailbox: "mb-sent" }] },
  ]);
  // The stand-in server ignores filters, so the receipt comes back: the check here still keeps it out.
  assert.deepEqual(got.threads.map((t: { id: string }) => t.id), ["T1"]);
  assert.match(got.note, /filtered out/);
  assert.equal(a.mail!.skipped(), 1);
  assert.match(await run(a, "get_thread", { threadId: "T2" }), /filtered out by the owner's rules/);
  assert.match(await run(a, "get_message", { messageId: "M3" }), /filtered out by the owner's rules/);
  assert.deepEqual((await a.mail!.labels()).map((l) => l.name), ["Inbox", "Receipts"]);
  const preview = await a.mail!.preview(rules);
  assert.equal(preview.total, 2);
  assert.equal(preview.skipped, 1);
});

test("drafts: off unless switched on; on, one new email in Drafts and nothing else; a reply joins its conversation; a read-only token says what to do", async () => {
  const { isDraftCreate } = await import("./fastmail-mail");
  const drafting = (f: ReturnType<typeof fastmail>) => openFastmail({ ...connector(), scope: "drafts" } as Connector, { token: "t" }, { fetch: f.fetchImpl, now: () => NOW });
  // Off: the tool isn't offered, and isn't run.
  const off = await open(fastmail());
  assert.ok(!off.tools.some((t) => t.name === "create_draft"));
  assert.match(await run(off, "create_draft", { to: ["a@b.com"], body: "Hi" }), /isn't one of this account's tools/);

  const f = fastmail();
  const a = await drafting(f);
  assert.ok(a.tools.some((t) => t.name === "create_draft"));
  const made = await run(a, "create_draft", { body: "Thanks, will do.", replyToMessageId: "M1" });
  assert.deepEqual(made, { id: "M9", threadId: "T1", viewUrl: "https://app.fastmail.com/mail/Drafts/T1.M9" });
  const [name, args] = f.sent.at(-1)!.calls[0];
  assert.equal(name, "Email/set");
  assert.deepEqual(Object.keys(args).sort(), ["accountId", "create"]);
  assert.deepEqual(args.create.draft, {
    mailboxIds: { "mb-drafts": true },
    keywords: { $draft: true, $seen: true },
    from: [{ email: "me@fastmail.com" }],
    to: [{ email: "priya@example.com" }],
    subject: "Re: Pricing memo",
    bodyValues: { body: { value: "Thanks, will do." } },
    textBody: [{ partId: "body", type: "text/plain" }],
    inReplyTo: ["<M1@example.com>"],
    references: ["<M1@example.com>"],
  });
  assert.match(await run(a, "create_draft", { to: ["not an address"], body: "Hi" }), /isn't a plain email address/);
  assert.match(await run(a, "create_draft", { to: ["a@b.com"], body: "Hi", cc: ["c@d.com"] }), /don't take cc/);
  assert.match(await run(await drafting(fastmail({ readOnly: true })), "create_draft", { to: ["a@b.com"], body: "Hi" }), /Make changes ticked/);

  // The only write that passes: a single new draft. Updates, deletes and anything outside Drafts' keyword don't.
  const draft = { mailboxIds: { d: true }, keywords: { $draft: true } };
  assert.ok(isDraftCreate(["Email/set", { accountId: "x", create: { a: draft } }, "1"]));
  assert.ok(!isDraftCreate(["Email/set", { create: { a: draft }, destroy: ["M1"] }, "1"]));
  assert.ok(!isDraftCreate(["Email/set", { create: { a: draft }, update: { M1: { keywords: {} } } }, "1"]));
  assert.ok(!isDraftCreate(["Email/set", { update: { M1: { "mailboxIds/t": true } } }, "1"]));
  assert.ok(!isDraftCreate(["Email/set", { create: { a: { mailboxIds: { d: true }, keywords: {} } } }, "1"]));
  assert.ok(!isDraftCreate(["Email/set", { create: { a: draft, b: draft } }, "1"]));
  assert.ok(!isDraftCreate(["EmailSubmission/set", { create: { a: draft } }, "1"]));
  assert.ok(!isDraftCreate(["Mailbox/set", { create: { a: draft } }, "1"]));
});
