// Drafting end to end with only the providers stubbed: real routes create the Outlook account, the real
// mailPort reads the thread and the owner's sent mail through callTool and Microsoft Graph's adapter, the real
// drafter writes it with a stand-in Claude, and saveDraft puts it in Outlook Drafts. Then a WhatsApp from
// the owner's history, and Ask's draft_message for Slack. Nothing may ever be sent.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/drafts-run.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";
import * as G from "./fixtures/microsoft-graph";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown };
type Sent = { system: string; tools: string[]; prompt: string; all: string };

/** Microsoft Graph, standing in: the mailbox, conversation conv-A (fixtures), sent mail, and the draft endpoints. */
function graph(posts: Array<{ url: string; body: unknown }>): F.Route {
  return (u, init) => {
    if (u.host !== "graph.microsoft.com") return undefined;
    const p = u.pathname.replace(/^\/v1\.0/, "");
    if ((init.method ?? "GET") === "POST") {
      posts.push({ url: u.toString(), body: JSON.parse(String(init.body)) });
      if (/^\/me\/messages\/[^/]+\/createReply$/.test(p) || p === "/me/messages") {
        return { status: 201, body: { id: "draft-9", conversationId: "conv-A", webLink: "https://outlook.office365.com/owa/?ItemID=draft-9" } };
      }
      return { status: 400, body: { error: { code: "BadRequest", message: "not stubbed" } } };
    }
    if (p === "/me") return { body: G.ME };
    const folder = /^\/me\/mailFolders\/(\w+)$/.exec(p);
    if (folder && G.FOLDERS[folder[1]]) return { body: G.FOLDERS[folder[1]] };
    if (p === "/me/mailFolders") return { body: G.FOLDER_LIST };
    if (p === "/me/messages/msg-3/attachments") return { body: G.ATTACHMENTS_MSG_3 };
    if (/\/messages$/.test(p)) {
      // A conversation by id, or a search (sent mail to Priya): both come back as conv-A.
      if (u.searchParams.get("$filter")?.startsWith("conversationId")) return { body: G.CONVERSATION_A };
      return { body: G.RECENT_PAGE_1 };
    }
    return undefined;
  };
}

/** Claude, standing in. The drafter gets the words it's given, in order; Ask calls draft_message once, then answers. */
function claude(sent: Sent[], words: string[], ask?: { person_id: string; channel: string }) {
  let n = 0;
  return (u: URL, init: RequestInit): F.Reply | undefined => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { system: string | Array<{ text: string }>; tools: Array<{ name: string }>; messages: Array<{ role: string; content: string | Block[] }> };
    const system = typeof body.system === "string" ? body.system : body.system.map((b) => b.text).join("\n");
    const first = body.messages[0].content;
    const tools = body.tools.map((t) => t.name);
    sent.push({ system, tools, prompt: typeof first === "string" ? first : first.map((b) => b.text ?? "").join(""), all: JSON.stringify(body.messages) });
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const writer = tools.find((t) => t === "write_email" || t === "write_message");
    if (writer) {
      const text = words.shift() ?? "Hi there";
      return reply([{ type: "tool_use", id: `w${n}`, name: writer, input: writer === "write_email" ? { subject: "Q1 budget", body: text } : { body: text } }], "tool_use");
    }
    const last = body.messages[body.messages.length - 1];
    const answered = Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
    if (ask && !answered) return reply([{ type: "tool_use", id: "d1", name: "draft_message", input: { person_id: ask.person_id, about: "the launch slides", channel: ask.channel } }], "tool_use");
    return reply([{ type: "text", text: "It's ready to send from here." }], "end_turn");
  };
}

test("Outlook: a reply to the email a to-do came from, in the owner's voice, saved as a draft reply and never sent", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    const posts: Array<{ url: string; body: unknown }> = [];
    const sent: Sent[] = [];
    F.stub(graph(posts), claude(sent, ["Hi Priya,\n\nFriday works — let's lock it in.\n\nThanks,", "Hi Priya,\n\nFriday works. Let's lock it in.\n\nThanks,"]));

    const { handleConnectorRoutes } = await import("./routes");
    const C = await import("../../../lib/connectors");
    const { qRaw, upsertPerson } = await import("../../../lib/db");
    const M = await import("../../../lib/memory");
    const { draftMessage, saveDraft } = await import("../../../lib/drafts");
    const { mailPort } = await import("./gmail-drafts");
    for (const t of ["collected_items", "collections", "connectors", "commitments", "interaction_people", "interactions", "identities", "facts", "people"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM settings WHERE key = 'draft_channels'`);
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    };

    const made = await api("POST", "/connectors", { provider: "outlook-mail", name: "Outlook", account_label: "work", client_id: "app-id", client_secret: "app-secret" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.id as string;
    // The owner turns on "Let Athena save drafts", then signs in.
    const on = await api("PATCH", `/connectors/${id}`, { scope: `${made.json.scope} Mail.ReadWrite` });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    await C.updateConnectorSecrets(id, (s) => void (s.tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now() } as never));
    const checked = await api("POST", `/connectors/${id}/check`);
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    const digest = await api("POST", "/collections", { recipe: "email-digest", name: "Email digest", label: "work", connector_ids: [id], schedule: "daily", run_at: "07:15" });
    assert.equal(digest.status, 201, JSON.stringify(digest.json));
    const source = digest.json.source as string;

    const priya = await upsertPerson({ name: "Priya Shah", email: "priya@contoso.example", relationship: "Finance lead" });
    await M.logInteraction({ channel: "email", summary: "Budget for Q1", person_ids: [priya.id], source, at: "2026-11-05T17:00:00Z" });
    const todo = await M.upsertCommitment({ title: "Confirm the Q1 budget with Priya", kind: "i_owe", person_id: priya.id, source, source_ref: `${source}:conv-A` });

    const draft = await draftMessage({ commitmentId: todo.id }, { mail: mailPort });
    assert.equal(draft.channel, "email");
    // The thread's own subject, as a reply.
    assert.equal(draft.subject, "Re: Budget for Q1");
    // The em dash was sent back once for a rewrite.
    assert.equal(draft.body, "Hi Priya,\n\nFriday works. Let's lock it in.\n\nThanks,");
    assert.deepEqual(draft.to, [{ name: "Priya Shah", email: "priya@contoso.example" }]);
    assert.deepEqual(draft.reply, { connector_id: id, message_id: "msg-3" });
    assert.deepEqual(draft.accounts, [{ id, label: "Work", provider: "outlook-mail" }]);

    const [prompt] = sent;
    assert.match(prompt.system, /You draft emails/);
    assert.deepEqual(prompt.tools, ["write_email"]);
    // The thread it answers, and the owner's own sent words for their voice.
    assert.match(prompt.prompt, /<email_thread subject="Budget for Q1">[\s\S]*lock it in on Friday/);
    assert.match(prompt.prompt, /<owner_voice>[\s\S]*How about £40k\?[\s\S]*<\/owner_voice>/);
    assert.match(prompt.prompt, /It's a reply in that email thread/);
    assert.equal(sent.length, 2);
    assert.match(sent[1].all, /Rewrite it without: em dash/);

    const saved = await saveDraft({ connector_id: id, to: ["priya@contoso.example"], subject: draft.subject, body: draft.body, reply: draft.reply }, { mail: mailPort });
    assert.deepEqual(saved, { connector_id: id, account: "Work", url: "https://outlook.office365.com/owa/?ItemID=draft-9", draft_id: "draft-9", provider: "outlook-mail" });
    // One POST, the draft reply in its exact shape. Nothing else was written, and nothing was sent.
    assert.deepEqual(posts, [{ url: "https://graph.microsoft.com/v1.0/me/messages/msg-3/createReply", body: { comment: draft.body, message: { toRecipients: [{ emailAddress: { address: "priya@contoso.example" } }] } } }]);
    for (const c of F.calls) assert.ok(!/\/(send|sendMail|reply|replyAll|forward)$/i.test(c.url.pathname), c.url.toString());

    // Drafts off again: saving is refused before anything leaves Athena.
    await api("PATCH", `/connectors/${id}`, { scope: made.json.scope });
    await assert.rejects(saveDraft({ connector_id: id, to: [], subject: "x", body: "y" }, { mail: mailPort }), /Turn on drafts/);
    assert.equal(posts.length, 1);
  } finally {
    F.restoreFetch();
  }
});

test("WhatsApp: the channel the owner uses with Mum, short and with no sign-off", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    const posts: Array<{ url: string; body: unknown }> = [];
    const sent: Sent[] = [];
    F.stub(graph(posts), claude(sent, ["Lovely seeing you at the weekend! Could you send me the photos?\n\nThanks,", "Lovely seeing you at the weekend! Could you send me the photos?"]));
    const { qRaw, upsertPerson } = await import("../../../lib/db");
    const M = await import("../../../lib/memory");
    const { draftMessage } = await import("../../../lib/drafts");
    const { saveDraftChannels } = await import("../../../lib/draft-prefs");
    const { mailPort } = await import("./gmail-drafts");
    for (const t of ["commitments", "interaction_people", "interactions", "identities", "people"]) await qRaw(`DELETE FROM ${t}`);
    // The owner uses WhatsApp (Settings → Drafts); Email and Text are on already.
    await saveDraftChannels(["email", "text", "whatsapp"]);
    const mum = await upsertPerson({ name: "Mum", phone: "07700 900123", email: "mum@example.com" });
    await M.logInteraction({ channel: "message", summary: "Weekend plans", person_ids: [mum.id], source: "whatsapp", at: "2026-11-07T10:00:00Z" });
    await M.logInteraction({ channel: "message", summary: "Photos", person_ids: [mum.id], source: "whatsapp", at: "2026-11-08T10:00:00Z" });
    await M.logInteraction({ channel: "email", summary: "Flights", person_ids: [mum.id], at: "2026-10-01T10:00:00Z" });

    const draft = await draftMessage({ personId: mum.id, about: "ask for the photos from the weekend" }, { mail: mailPort });
    assert.equal(draft.channel, "whatsapp");
    assert.deepEqual(draft.available, ["whatsapp", "email", "text"]);
    assert.equal(draft.subject, "");
    assert.equal(draft.phone, "07700 900123");
    assert.equal(draft.body, "Lovely seeing you at the weekend! Could you send me the photos?");
    assert.match(sent[0].system, /You draft WhatsApp messages[\s\S]*under 400 characters/);
    assert.deepEqual(sent[0].tools, ["write_message"]);
    assert.match(sent[0].prompt, /as a WhatsApp message/);
    // Her email address isn't in a WhatsApp prompt, and the sign-off was sent back.
    assert.doesNotMatch(sent[0].prompt, /mum@example\.com/);
    assert.match(sent[1].all, /Rewrite it without: a sign-off/);
    assert.equal(posts.length, 0);

    // Asked for as a text instead: the same words rewritten for Messages.
    const text = await draftMessage({ personId: mum.id, channel: "text", previous: { subject: "", body: draft.body, channel: "whatsapp" } }, { mail: mailPort });
    assert.equal(text.channel, "text");
    assert.match(sent.at(-1)!.prompt, /Your last draft \(as a WhatsApp message\)[\s\S]*Say the same thing as a text message/);

    // WhatsApp switched off: her usual channel falls back to the next one she's reached on, and WhatsApp isn't offered.
    await saveDraftChannels(["email", "text"]);
    const fallback = await draftMessage({ personId: mum.id, about: "the photos" }, { mail: mailPort });
    assert.equal(fallback.channel, "email");
    assert.deepEqual(fallback.available, ["email", "text"]);
    assert.deepEqual(fallback.enabled, ["email", "text"]);
  } finally {
    F.restoreFetch();
  }
});

test("Ask's draft_message: a Slack DM to Gayle, a receipt that opens it, and nothing saved or sent", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    const posts: Array<{ url: string; body: unknown }> = [];
    const sent: Sent[] = [];
    const { qRaw, upsertPerson } = await import("../../../lib/db");
    const M = await import("../../../lib/memory");
    const { runAsk } = await import("../../../lib/answer");
    const { mailPort } = await import("./gmail-drafts");
    for (const t of ["commitments", "interaction_people", "interactions", "identities", "people"]) await qRaw(`DELETE FROM ${t}`);
    const { saveDraftChannels } = await import("../../../lib/draft-prefs");
    await saveDraftChannels(["email", "slack"]);
    // No Slack member saved for Gayle: Athena looks her up (by email first), and reads the owner's own Slack messages.
    const gayle = await upsertPerson({ name: "Gayle King", email: "gayle@work.example" });
    const lookups: Array<{ name: string; email: string | null }> = [];
    const slack = {
      async findMember(p: { name: string; email: string | null }) {
        lookups.push(p);
        return p.email === "gayle@work.example" ? { user: "U04GAYLE01", team: "T01TEAM12" } : ("ambiguous" as const);
      },
      async ownMessages() {
        return ["on it, numbers by 4", "nice one, merging", "on it, numbers by 4"];
      },
    };
    F.stub(graph(posts), claude(sent, ["Hi Gayle, the launch slides are in the shared folder. [link the deck]"], { person_id: gayle.id, channel: "slack" }));

    const reply = await runAsk("Slack Gayle about the launch slides", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, web: async () => false, mentions: async () => ({ found: [], missing: [] }), gmail: mailPort, slack });
    const change = (reply.changes ?? []).find((c) => c.kind === "draft");
    assert.ok(change, JSON.stringify(reply));
    assert.equal(change.detail, "Slack message to Gayle · ready to send");
    // Not an email, so the receipt shows how it starts.
    assert.equal(change.title, "Hi Gayle, the launch slides are in the shared folder. [link…");
    assert.equal(change.undo, null);
    const open = change.open as { kind: "draft"; draft: { channel: string; slack: string | null; body: string; saved: unknown } };
    assert.equal(open.kind, "draft");
    assert.equal(open.draft.channel, "slack");
    // Saved on Gayle as a Slack identity (Athena lowercases identities; the link builder reads it either way).
    assert.equal(open.draft.slack, "T01TEAM12/U04GAYLE01");
    assert.deepEqual(lookups, [{ name: "Gayle King", email: "gayle@work.example" }]);
    assert.deepEqual((await M.listIdentities(gayle.id)).map((i) => [i.kind, i.value]), [["slack", "t01team12/u04gayle01"]]);
    const writer = sent.find((s) => /You draft Slack messages/.test(s.system))!;
    assert.match(writer.prompt, /<owner_voice>\n<slack_message>on it, numbers by 4<\/slack_message>\n<slack_message>nice one, merging<\/slack_message>\n<\/owner_voice>/);
    // The owner's sent email isn't read for a Slack draft when their Slack messages are there.
    assert.doesNotMatch(writer.prompt, /<sent>/);

    // Two people could be Tom: nothing is saved, and the draft goes the next way.
    const tom = await upsertPerson({ name: "Tom Hale", email: "tom@home.example" });
    const { draftMessage } = await import("../../../lib/drafts");
    F.stub(graph(posts), claude(sent, ["Hi Tom, quick one about Friday."]));
    const toTom = await draftMessage({ personId: tom.id, about: "Friday" }, { mail: mailPort, slack });
    assert.equal(toTom.channel, "email");
    assert.equal(toTom.slack, null);
    assert.deepEqual(await M.listIdentities(tom.id), []);
    assert.equal(open.draft.saved, null);
    assert.match(open.draft.body, /launch slides/);
    assert.ok(sent.some((s) => /You draft Slack messages/.test(s.system)));
    assert.equal(posts.length, 0);
  } finally {
    F.restoreFetch();
  }
});
