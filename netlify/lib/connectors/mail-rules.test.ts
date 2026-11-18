// Run: npx tsx --test netlify/lib/connectors/mail-rules.test.ts
// The owner's mail rules (lib/mail-rules.ts) in Gmail's and Outlook's tools: the query each search sends, the check
// on what comes back, refused reads, and a model trying to get round them. Providers are stand-ins answering by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FILTERED_NOTE, REFUSED_NOTE, readRules, senderSkipped, withGmailRules, gmailGroup, type MailRules } from "../../../lib/mail-rules";
import { GMAIL_TOOLS, gmailPreview } from "./google-gmail";
import { OUTLOOK_MAIL_TOOLS, firstPageUrl, outlookPreview, parseGmailQuery, withOutlookRules } from "./microsoft-mail";
import { guardedMcpGmail, mailGuard, type MailGuard } from "./mail-guard";
import { ToolInputError, type GoogleContext } from "./google-api";
import type { GraphContext } from "./microsoft-graph";

const rules = (r: Partial<MailRules>): MailRules => readRules({ inbox_only: false, ...r });
const NAME_COM: MailRules = rules({ inbox_only: true, skip_senders: ["name.com", "@Namecheap.com"], skip_subjects: ["Your receipt"], skip_labels: [{ id: "Label_7", name: "Newsletters" }] });
const guard = (r: MailRules | null, unreadable = false): MailGuard => mailGuard({ mail_rules: r, mail_rules_unreadable: unreadable });

// ---------- the rules themselves ----------

test("rules: senders and domains are read as the owner types them, junk dropped", () => {
  const r = readRules({ skip_senders: ["name.com", "@Namecheap.com", "Billing <Billing@Shop.co.uk>", "*.example.org", "not a sender", "", 4], skip_subjects: ['"Order"', "x", "Order"], inbox_only: "yes" });
  assert.deepEqual(r.skip_senders, ["name.com", "namecheap.com", "billing@shop.co.uk", "example.org"]);
  assert.deepEqual(r.skip_subjects, ["Order"]);
  assert.equal(r.inbox_only, false);
});

test("rules: a domain covers its subdomains, never a lookalike", () => {
  const r = rules({ skip_senders: ["name.com", "boss@work.com"] });
  assert.ok(senderSkipped("Name.com <orders@name.com>", r));
  assert.ok(senderSkipped("alerts@mail.name.com", r));
  assert.ok(!senderSkipped("me@myname.com", r));
  assert.ok(!senderSkipped("x@name.com.evil.io", r));
  assert.ok(senderSkipped("Boss <BOSS@work.com>", r));
  assert.ok(!senderSkipped("colleague@work.com", r));
});

// ---------- Gmail: the query ----------

test("Gmail query: the rules go after the model's query, as their own terms", () => {
  assert.equal(
    withGmailRules("after:2026/11/05 -in:sent", NAME_COM),
    '(after:2026/11/05 -in:sent) {in:inbox in:sent} -from:name.com -from:namecheap.com -subject:"Your receipt" -label:"Newsletters"',
  );
  assert.equal(withGmailRules("", rules({ inbox_only: true })), "{in:inbox in:sent}");
  assert.equal(withGmailRules("from:priya", null), "from:priya");
  assert.equal(withGmailRules("x", rules({ only_labels: [{ id: "INBOX", name: "Inbox" }, { id: "CATEGORY_UPDATES", name: "Updates" }] })), "(x) {in:inbox category:updates}");
});

test("Gmail query: a stray bracket can't close the group early and OR past the rules", () => {
  // Unbalanced: the brackets go, so OR stays inside the model's own group.
  assert.equal(gmailGroup(") OR (from:name.com"), "(OR from:name.com)");
  assert.equal(gmailGroup("} OR {from:name.com"), "(OR from:name.com)");
  assert.equal(gmailGroup('subject:"a (b"'), '(subject:"a (b")');
  assert.ok(withGmailRules("from:name.com OR in:anywhere", NAME_COM).endsWith('-from:name.com -from:namecheap.com -subject:"Your receipt" -label:"Newsletters"'));
});

// ---------- Gmail: a stand-in mailbox ----------

type GMsg = { id: string; threadId: string; labelIds: string[]; from: string; subject: string };
const MAILBOX: GMsg[] = [
  // A Name.com purchase a filter archived: never reached the inbox.
  { id: "m1", threadId: "t1", labelIds: ["Label_9"], from: "Name.com <orders@name.com>", subject: "Domain purchase: acme.dev" },
  { id: "m2", threadId: "t2", labelIds: ["INBOX", "UNREAD"], from: "Priya <priya@example.com>", subject: "Lunch on Friday?" },
  // In the inbox, but from a skipped sender.
  { id: "m3", threadId: "t3", labelIds: ["INBOX"], from: "billing@namecheap.com", subject: "Renewal" },
  // A thread whose older message was archived and whose reply is in the inbox; one of its messages has a skipped subject.
  { id: "m4", threadId: "t4", labelIds: [], from: "Sam <sam@example.com>", subject: "Plans" },
  { id: "m5", threadId: "t4", labelIds: ["INBOX"], from: "Sam <sam@example.com>", subject: "Re: Plans" },
  { id: "m6", threadId: "t4", labelIds: ["INBOX"], from: "shop@example.net", subject: "Your receipt from Sam's shop" },
];

const payload = (m: GMsg) => ({
  mimeType: "text/plain",
  headers: [
    { name: "From", value: m.from },
    { name: "Subject", value: m.subject },
  ],
  body: { data: Buffer.from(`Body of ${m.id}`).toString("base64url") },
});
const asGmail = (m: GMsg) => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.subject, internalDate: "1762430000000", payload: payload(m) });

/** Gmail, standing in: answers every thread listing with every thread (whatever the query says), and records each query. */
function gmailCtx(g: MailGuard | undefined, seen: { queries: string[]; urls: string[] } = { queries: [], urls: [] }): GoogleContext {
  return {
    email: "owner@example.com",
    mail: g,
    now: () => new Date("2026-11-06T12:00:00Z"),
    saveDraft: async () => {
      throw new Error("no drafts here");
    },
    async get<T>(raw: string): Promise<T> {
      const u = new URL(raw);
      seen.urls.push(raw);
      const p = u.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
      if (p === "/threads") {
        const q = u.searchParams.get("q") ?? "";
        seen.queries.push(q);
        // The skipped count's query, as Gmail answers it: threads with a message any rule takes out.
        if (q.includes("{(-in:inbox -in:sent)")) return { threads: ["t1", "t3", "t4"].map((id) => ({ id })) } as T;
        return { threads: [...new Set(MAILBOX.map((m) => m.threadId))].map((id) => ({ id })) } as T;
      }
      const thread = /^\/threads\/(\w+)$/.exec(p);
      if (thread) return { id: thread[1], messages: MAILBOX.filter((m) => m.threadId === thread[1]).map(asGmail) } as T;
      const message = /^\/messages\/(\w+)$/.exec(p);
      if (message) return asGmail(MAILBOX.find((m) => m.id === message[1])!) as T;
      throw new Error(`No stand-in for ${p}`);
    },
  };
}

const gmail = (name: string) => GMAIL_TOOLS.find((t) => t.name === name)!;

test("Gmail search: every query carries the rules, and what Gmail lets through is checked again", async () => {
  const seen = { queries: [] as string[], urls: [] as string[] };
  const g = guard(NAME_COM);
  const out = (await gmail("search_threads").run(gmailCtx(g, seen), { query: "newer_than:1d" })) as { threads: Array<{ id: string; messages: Array<{ subject: string }> }>; note: string };
  assert.ok(seen.queries[0].startsWith("(newer_than:1d) {in:inbox in:sent} -from:name.com"), seen.queries[0]);
  // The skipped count asks for the opposite, ids only.
  assert.ok(seen.queries.some((q) => q.startsWith("(newer_than:1d) {(-in:inbox -in:sent)")), seen.queries.join("\n"));
  assert.deepEqual(out.threads.map((t) => t.id), ["t2", "t4"]);
  // t4's archived first message stays (the thread reached the inbox); the receipt doesn't.
  assert.deepEqual(out.threads[1].messages.map((m) => m.subject), ["Plans", "Re: Plans"]);
  assert.equal(out.note, FILTERED_NOTE);
  // Counted: the threads the rules took out (t1, t3), and t4, which lost its receipt.
  assert.deepEqual([...g.skipped].sort(), ["t1", "t3", "t4"]);
  // The note says rules exist, never what they say.
  assert.ok(!JSON.stringify(out).includes("name.com") && !JSON.stringify(out).includes("receipt"));
});

test("Gmail search: the model searching for skipped mail by name gets nothing", async () => {
  for (const query of ["from:name.com", "from:orders@name.com in:anywhere", ") OR (from:name.com", "label:Newsletters", "-in:inbox", "subject:receipt"]) {
    const seen = { queries: [] as string[], urls: [] as string[] };
    const out = (await gmail("search_threads").run(gmailCtx(guard(NAME_COM), seen), { query, includeTrash: true, view: "THREAD_VIEW_IDS_ONLY" })) as { threads?: Array<{ id: string }> };
    const ids = (out.threads ?? []).map((t) => t.id);
    assert.ok(!ids.includes("t1") && !ids.includes("t3"), `${query} → ${ids}`);
    assert.ok(seen.queries[0].includes("-from:name.com"), seen.queries[0]);
  }
});

test("Gmail reads: a thread or message the rules keep out is refused with a short note", async () => {
  const ctx = gmailCtx(guard(NAME_COM));
  await assert.rejects(gmail("get_thread").run(ctx, { threadId: "t1" }), (e: Error) => e instanceof ToolInputError && e.message === REFUSED_NOTE);
  await assert.rejects(gmail("get_thread").run(ctx, { threadId: "t3", messageFormat: "MINIMAL" }), (e: Error) => e.message === REFUSED_NOTE);
  await assert.rejects(gmail("get_message").run(ctx, { messageId: "m1" }), (e: Error) => e.message === REFUSED_NOTE);
  await assert.rejects(gmail("get_message").run(ctx, { messageId: "m6" }), (e: Error) => e.message === REFUSED_NOTE);
  // Allowed: an archived message whose thread reached the inbox, and the thread without its receipt.
  const m4 = (await gmail("get_message").run(ctx, { messageId: "m4" })) as { plaintextBody: string };
  assert.equal(m4.plaintextBody, "Body of m4");
  const t4 = (await gmail("get_thread").run(ctx, { threadId: "t4" })) as { messages: Array<{ id: string }> };
  assert.deepEqual(t4.messages.map((m) => m.id), ["m4", "m5"]);
});

test("Gmail without rules is unchanged; rules that can't be opened refuse every mail tool", async () => {
  const seen = { queries: [] as string[], urls: [] as string[] };
  const out = (await gmail("search_threads").run(gmailCtx(guard(null), seen), { query: "from:name.com" })) as { threads: unknown[]; note?: string };
  assert.deepEqual(seen.queries, ["from:name.com"]);
  assert.equal(out.threads.length, 4);
  assert.equal(out.note, undefined);
  for (const [name, args] of [["search_threads", {}], ["get_thread", { threadId: "t2" }], ["get_message", { messageId: "m2" }]] as const) {
    await assert.rejects(gmail(name).run(gmailCtx(guard(null, true)), args), (e: Error) => e instanceof ToolInputError && /can't be read/.test(e.message));
  }
});

test("Gmail preview: counts from ids only, and the busiest sender suggested with an exact count", async () => {
  const urls: string[] = [];
  const arrived = Array.from({ length: 340 }, (_, i) => `x${i}`);
  const ctx: GoogleContext = {
    email: "owner@example.com",
    now: () => new Date(),
    saveDraft: async () => ({}) as never,
    async get<T>(raw: string): Promise<T> {
      urls.push(raw);
      const u = new URL(raw);
      const q = u.searchParams.get("q") ?? "";
      if (u.pathname.endsWith("/messages")) {
        const ids = q.includes("from:name.com") ? (q.includes("-in:inbox") ? arrived.slice(0, 280) : arrived.slice(0, 280)) : q.includes("{in:inbox") ? arrived.slice(0, 28) : arrived;
        return { messages: ids.map((id) => ({ id })) } as T;
      }
      const id = u.pathname.split("/").pop()!;
      const n = Number(id.slice(1));
      return { labelIds: n < 280 ? [] : ["INBOX"], payload: { headers: [{ name: "From", value: n < 280 ? "Name.com <noreply@name.com>" : `p${n}@example.com` }] } } as T;
    },
  };
  // Before any rule: nothing skipped, and Name.com suggested, none of it in the inbox.
  const first = await gmailPreview(ctx, rules({}));
  assert.deepEqual({ total: first.total, skipped: first.skipped, capped: first.capped }, { total: 340, skipped: 0, capped: false });
  assert.deepEqual(first.suggestions, [{ sender: "name.com", count: 280, outside_inbox: 280 }]);
  // With the inbox rule: 312 skipped, and no suggestion for mail it already skips.
  const p = await gmailPreview(ctx, rules({ inbox_only: true }));
  assert.deepEqual({ total: p.total, skipped: p.skipped }, { total: 340, skipped: 312 });
  assert.deepEqual(p.suggestions, []);
  // Count-only: lists of ids, and From headers for a sample. Never a body.
  assert.ok(urls.every((u) => !/format=full/.test(u) && (/\/messages\?/.test(u) || /format=metadata/.test(u))), urls.find((u) => /format=full/.test(u)) ?? "");
  assert.ok(urls.filter((u) => /format=metadata/.test(u)).every((u) => /metadataHeaders=From/.test(u) && !/Subject/.test(u)));
});

// ---------- Outlook ----------

test("Outlook query: rules become KQL NOT terms in a search, and the inbox rule searches the Inbox", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const words = withOutlookRules(parseGmailQuery("from:name.com budget", now), NAME_COM);
  assert.equal(words.folder, "inbox");
  const search = new URL(firstPageUrl("/me/messages", words)).searchParams.get("$search") ?? "";
  assert.ok(search.includes("from:name.com budget NOT from:name.com NOT from:namecheap.com NOT subject:\\\"Your receipt\\\""), search);
  // A listing can't say "not from": the folder narrows it, and each message is checked (below).
  const listing = withOutlookRules(parseGmailQuery("after:2026/11/05", now), NAME_COM);
  assert.deepEqual(listing.kql, []);
  assert.equal(listing.folder, "inbox");
  // The model naming a folder keeps it; the check on each message still applies.
  assert.equal(withOutlookRules(parseGmailQuery("in:archive", now), NAME_COM).folder, "archive");
});

type OMsg = { id: string; conversationId: string; folder: string; from: string; subject: string };
const OUTLOOK: OMsg[] = [
  { id: "o1", conversationId: "c1", folder: "archive-id", from: "orders@name.com", subject: "Domain purchase" },
  { id: "o2", conversationId: "c2", folder: "inbox-id", from: "priya@example.com", subject: "Lunch" },
  { id: "o3", conversationId: "c3", folder: "inbox-id", from: "billing@namecheap.com", subject: "Renewal" },
  { id: "o4", conversationId: "c4", folder: "news-id", from: "news@paper.com", subject: "Morning briefing" },
];
const FOLDER_IDS: Record<string, string> = { inbox: "inbox-id", sentitems: "sent-id", drafts: "drafts-id", deleteditems: "trash-id", junkemail: "junk-id", archive: "archive-id" };

/** Graph, standing in: every listing returns every message (whatever it asked for), so only Athena's own check stands between. */
function graphCtx(g: MailGuard | undefined, urls: string[] = []): GraphContext {
  const asGraph = (m: OMsg) => ({
    id: m.id,
    conversationId: m.conversationId,
    parentFolderId: m.folder,
    subject: m.subject,
    from: { emailAddress: { address: m.from, name: m.from } },
    receivedDateTime: "2026-11-06T09:00:00Z",
    bodyPreview: m.subject,
    body: { contentType: "text", content: `Body of ${m.id}` },
  });
  return {
    email: "owner@example.com",
    mail: g,
    now: () => new Date("2026-11-06T12:00:00Z"),
    async get<T>(raw: string): Promise<T> {
      urls.push(raw);
      const u = new URL(raw);
      const p = u.pathname.replace(/^\/v1\.0/, "");
      const folder = /^\/me\/mailFolders\/(\w+)$/.exec(p);
      if (folder && FOLDER_IDS[folder[1]]) return { id: FOLDER_IDS[folder[1]] } as T;
      if (p === "/me/mailFolders") return { value: [{ id: "inbox-id", displayName: "Inbox" }, { id: "news-id", displayName: "News" }] } as T;
      const one = /^\/me\/messages\/(\w+)$/.exec(p);
      if (one) return asGraph(OUTLOOK.find((m) => m.id === one[1])!) as T;
      if (/messages$/.test(p)) {
        const conv = /conversationId eq '(\w+)'/.exec(u.searchParams.get("$filter") ?? "");
        return { value: OUTLOOK.filter((m) => !conv || m.conversationId === conv[1]).map(asGraph) } as T;
      }
      throw new Error(`No stand-in for ${p}`);
    },
  };
}
const outlook = (name: string) => OUTLOOK_MAIL_TOOLS.find((t) => t.name === name)!;

test("Outlook search: the Inbox only, every message checked, skipped mail counted, and nothing gets round it", async () => {
  const urls: string[] = [];
  const g = guard(rules({ inbox_only: true, skip_senders: ["namecheap.com"] }));
  const out = (await outlook("search_threads").run(graphCtx(g, urls), { query: "after:2026/11/05" })) as { threads: Array<{ id: string }>; note: string };
  assert.ok(urls.some((u) => new URL(u).pathname.endsWith("/me/mailFolders/inbox/messages")), urls.join("\n"));
  assert.deepEqual(out.threads.map((t) => t.id), ["c2"]);
  assert.equal(out.note, FILTERED_NOTE);
  assert.deepEqual([...g.skipped].sort(), ["c1", "c3", "c4"]);
  for (const query of ["from:name.com", "in:archive", "label:News", "in:anywhere name.com", "from:namecheap.com OR from:name.com"]) {
    const r = (await outlook("search_threads").run(graphCtx(guard(rules({ inbox_only: true, skip_senders: ["namecheap.com"] }))), { query, includeTrash: true })) as { threads?: Array<{ id: string }> };
    assert.deepEqual((r.threads ?? []).map((t) => t.id).filter((id) => id !== "c2"), [], query);
  }
});

test("Outlook reads: refused outside the rules, and skipped folders and senders stay out", async () => {
  const r = rules({ inbox_only: true, skip_labels: [{ id: "news-id", name: "News" }] });
  const ctx = graphCtx(guard(r));
  await assert.rejects(outlook("get_thread").run(ctx, { threadId: "c1" }), (e: Error) => e.message === REFUSED_NOTE);
  await assert.rejects(outlook("get_message").run(ctx, { messageId: "o1" }), (e: Error) => e.message === REFUSED_NOTE);
  await assert.rejects(outlook("get_message").run(ctx, { messageId: "o4" }), (e: Error) => e.message === REFUSED_NOTE);
  const ok = (await outlook("get_message").run(ctx, { messageId: "o2" })) as { plaintextBody: string };
  assert.equal(ok.plaintextBody, "Body of o2");
  // Only these folders: the allowlist alone.
  const only = graphCtx(guard(rules({ only_labels: [{ id: "news-id", name: "News" }] })));
  const out = (await outlook("search_threads").run(only, {})) as { threads: Array<{ id: string }> };
  assert.deepEqual(out.threads.map((t) => t.id), ["c4"]);
});

test("Outlook preview: what arrived, checked here from sender, subject and folder (no bodies)", async () => {
  const urls: string[] = [];
  const p = await outlookPreview(graphCtx(undefined, urls), rules({ inbox_only: true }));
  assert.deepEqual({ total: p.total, skipped: p.skipped }, { total: 4, skipped: 2 });
  const listing = urls.find((u) => /receivedDateTime/.test(decodeURIComponent(u)))!;
  assert.ok(!/body/i.test(new URL(listing).searchParams.get("$select") ?? ""), listing);
});

// ---------- Gmail on Google's MCP server ----------

test("Gmail on Google's MCP server: the query is rewritten and the reply checked; unreadable replies refused", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const reply = (text: string) => async (a: Record<string, unknown>) => (sent.push(a), { text, isError: false });
  const threads = {
    threads: [
      { id: "t1", messages: [{ sender: "orders@name.com", subject: "Domain purchase", labelIds: [] }] },
      { id: "t2", messages: [{ sender: "priya@example.com", subject: "Lunch", labelIds: ["INBOX"] }] },
    ],
  };
  const r = await guardedMcpGmail(NAME_COM, "search_threads", { query: "from:name.com" }, reply(JSON.stringify(threads)));
  assert.ok(String(sent[0].query).includes("-from:name.com"));
  assert.deepEqual(JSON.parse(r.text).threads.map((t: { id: string }) => t.id), ["t2"]);
  assert.equal((await guardedMcpGmail(NAME_COM, "get_thread", { threadId: "t1" }, reply(JSON.stringify(threads.threads[0])))).text, REFUSED_NOTE);
  assert.equal((await guardedMcpGmail(NAME_COM, "get_message", { messageId: "x" }, reply("not json"))).isError, true);
});
