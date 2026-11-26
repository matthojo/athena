// Real path: templates and sending notes out, through the real /api function on Postgres with every
// migration. A meeting with Priya is filled from the calendar, People, catch-ups, to-dos and an Email
// digest note, cited, with blanks left; starters are edited and put back; a note is saved as a template.
// Then the note goes to Google Docs (Google's API faked at fetch, so the request gate in google-docs.ts
// runs for real) and to Notion (a fake MCP client behind the real callNotionWrite), is sent again, and
// is undone. Ask's fill_template and send_note make the same receipts, and Undo reverses them.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/documents.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("templates fill from Athena with sources and blanks; notes go to Docs and Notion and come back with Undo", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw, upsertPerson, upsertEvent, linkEntities, createNote, getNote } = await import("./db");
  const { logInteraction, upsertCommitment } = await import("./memory");
  const { createConnector, setConnectorStatus } = await import("./connectors");
  const { setDocumentPorts } = await import("./documents");
  const { makeDocumentPorts } = await import("../netlify/lib/connectors/documents-port");
  const { runAssistantTool, applyUndo } = await import("./assistant");
  const { callNotionWrite } = await import("../netlify/lib/connectors/mcp-client");

  for (const t of ["document_exports", "note_templates", "edges", "interaction_people", "interactions", "commitments", "events", "notes", "people"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM connectors WHERE provider IN ('google-docs', 'notion')`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(
      new Request(`https://athena.test/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {} as never,
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  // ---- what Athena knows: a meeting tomorrow with Priya, their last catch-up, an open loop, an email ----
  const priya = await upsertPerson({ name: "Priya Shah" } as never);
  const starts = new Date(Date.now() + 20 * 3_600_000);
  starts.setUTCMinutes(0, 0, 0);
  const event = await upsertEvent({ title: "Design review", kind: "appointment", starts_at: starts.toISOString() } as never);
  await linkEntities({ sourceType: "event", sourceId: event.id, targetType: "person", targetId: priya.id, relation: "attendee" });
  await logInteraction({ channel: "meeting", at: new Date(Date.now() - 6 * 86_400_000).toISOString(), summary: "Talked through the pricing page and the March launch", person_ids: [priya.id] } as never);
  const loop = await upsertCommitment({ kind: "i_owe", title: "Send the revised mocks", person_id: priya.id } as never);
  await createNote({ title: "Design review agenda", body: "Priya wrote ahead of the Design review:\n\n- Pricing page copy\n- Mobile nav", source: "email-digest-work" });

  // ---- templates ----
  const listed = await call("GET", "/templates");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.templates.map((t: { name: string }) => t.name),
    ["Meeting notes", "1:1", "Trip plan", "Weekly review", "Letter", "Project brief"],
  );
  assert.deepEqual(listed.body.templates[0].needs, ["meeting"]);

  const prepare = await call("GET", "/templates/prepare");
  assert.deepEqual(
    prepare.body.suggestions.map((s: { event_id: string; people: Array<{ name: string }> }) => [s.event_id, s.people.map((p) => p.name)]),
    [[event.id, ["Priya Shah"]]],
  );

  const filled = await call("POST", "/templates/starter:meeting/fill", { event_id: event.id });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  const body: string = filled.body.body;
  assert.equal(filled.body.title, "Design review");
  assert.match(body, /^\w{3} \d+ \w{3} \d\d:\d\d · Priya Shah\n/, "the heading became the title");
  assert.match(body, /## Agenda\n- Pricing page copy\n- Mobile nav\n/);
  assert.match(body, /## Last time\n\d+ \w+: Talked through the pricing page and the March launch\n/);
  assert.match(body, /## Open loops\n- \[ \] You owe Priya Shah: Send the revised mocks\n/);
  assert.match(body, new RegExp(`- Meeting, date and attendees: \\[Design review\\]\\(athena://event/${event.id} "link"\\)`));
  assert.match(body, new RegExp(`- Open loops: \\[Send the revised mocks\\]\\(athena://todo/${loop.id} "link"\\)`));
  assert.match(body, /- Agenda from email: \[Design review agenda\]\(athena:\/\/note\/[0-9a-f-]+ "link"\), Email digest/);
  assert.deepEqual(filled.body.blanks, []);

  // A 1:1 with nothing saved about them leaves "about them" blank, visibly, and says so.
  const oneOnOne = await call("POST", "/templates/starter:one-on-one/fill", { person_ids: [priya.id] });
  assert.match(oneOnOne.body.body, /## Worth remembering\n\{\{about them\}\}\n/);
  assert.deepEqual(oneOnOne.body.blanks, ["about them"]);
  assert.match(oneOnOne.body.body, /- Left for you: about them/);

  // Edit a starter, then put it back.
  const edited = await call("PATCH", "/templates/starter:letter", { body: "{{today}}\n\nHi {{person}},\n\n" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.starter, "letter");
  assert.equal(edited.body.edited, true);
  const again = await call("PATCH", `/templates/starter:letter`, { name: "Letter" });
  assert.equal(again.body.id, edited.body.id, "a starter is saved once, then that row changes");
  assert.match((await call("GET", "/templates")).body.templates[4].body, /^\{\{today\}\}\n\nHi/);
  await call("POST", `/templates/${edited.body.id}/archive`);
  assert.match((await call("GET", "/templates")).body.templates[4].body, /Dear \{\{person\}\}/);
  // The stored body is sealed (§11).
  const [raw] = await qRaw<{ body: string }>(`SELECT body FROM note_templates WHERE id = $1`, [edited.body.id]);
  assert.match(raw.body, /^enc:v1:/);

  // Save a note as a template.
  const mine = await call("POST", "/templates", { name: "Retro", body: "# Retro {{date}}\n\n## Went well\n" });
  assert.equal(mine.status, 201);
  assert.equal((await call("GET", "/templates")).body.templates.at(-1).name, "Retro");
  assert.equal((await call("POST", "/templates", { name: "  " })).status, 400);

  // ---- the note that goes out ----
  const note = await createNote({ title: filled.body.title, body });

  // ---- Google Docs: Google's API faked at fetch, the gate is the real one ----
  const docs = await createConnector({
    name: "Google Docs",
    provider: "google-docs",
    account_label: "personal",
    url: "https://docs.googleapis.com/v1",
    auth_type: "oauth",
    scope: "https://www.googleapis.com/auth/drive.file",
    secrets: { ownClient: { client_id: "x.apps.googleusercontent.com", client_secret: "s" }, tokens: { access_token: "tok", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } },
  });
  await setConnectorStatus(docs.id, "connected");
  const google: Array<{ method: string; url: string; body: any }> = [];
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const u = String(input);
    const b = init?.body ? JSON.parse(String(init.body)) : undefined;
    google.push({ method: init?.method ?? "GET", url: u, body: b });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files?q=")) return ok({ files: [] });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink")) return ok({ id: "doc1234567890abc", webViewLink: "https://docs.google.com/document/d/doc1234567890abc/edit?usp=drivesdk" });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files?fields=id")) return ok({ id: "folder1234567890" });
    if (u.endsWith(":batchUpdate")) return ok({ replies: [] });
    if (u.includes("/documents/doc1234567890abc?")) return ok({ body: { content: [{ endIndex: 1 }, { endIndex: 240 }] } });
    if (init?.method === "PATCH") return ok({ id: "doc1234567890abc" });
    return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 400 });
  }) as typeof fetch;

  // ---- Notion: a fake MCP client, behind the real callNotionWrite ----
  const notion = await createConnector({ name: "Notion", provider: "notion", account_label: "", url: "https://mcp.notion.com/mcp", auth_type: "oauth", secrets: {} });
  await setConnectorStatus(notion.id, "connected");
  const notionCalls: Array<{ name: string; arguments: any }> = [];
  const PARENT = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";
  const PAGE = "9f8e7d6c5b4a40398271a6b5c4d3e2f1";
  const REMOVED = "5e5e5e5e5e5e45e5a5e5e5e5e5e5e5e5";
  const SECOND_ID = "7a7a7a7a7a7a47a7a7a7a7a7a7a7a7a7";
  let creates = 0;
  const fakeOpen = async () =>
    ({
      connector: { ...notion, provider: "notion", allowed_tools: ["notion-search"] },
      client: {
        async callTool(req: { name: string; arguments: any }) {
          notionCalls.push(req);
          if (req.name === "notion-search") return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: PARENT, title: "Projects", url: `https://www.notion.so/Projects-${PARENT}`, type: "page" }] }) }] };
          if (req.name === "notion-create-pages") {
            const id = creates < 0 ? SECOND_ID : creates++ === 0 ? PAGE : REMOVED;
            return { content: [{ type: "text", text: JSON.stringify({ pages: [{ id, url: `https://www.notion.so/Page-${id}` }] }) }] };
          }
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
      close: async () => undefined,
    }) as never;
  setDocumentPorts(makeDocumentPorts({ fetch: fakeFetch, openNotion: fakeOpen }));

  // Off until a parent is picked: no Notion account to send to.
  assert.deepEqual(
    (await call("GET", "/documents/accounts")).body.accounts.map((a: { provider: string }) => a.provider),
    ["google-docs"],
  );
  assert.equal((await call("GET", `/documents/notion/${notion.id}`)).body.enabled, false);
  const pages = await call("GET", `/documents/notion/${notion.id}/pages?q=proj`);
  assert.deepEqual(pages.body.pages, [{ id: PARENT, title: "Projects", url: `https://www.notion.so/Projects-${PARENT}` }]);
  const on = await call("PUT", `/documents/notion/${notion.id}`, { parent: { id: pages.body.pages[0].url, title: "Projects" } });
  assert.deepEqual(on.body, { enabled: true, parent: { id: PARENT, title: "Projects" } });

  // Send to Google Docs: find the folder (none yet), make it, make the doc in it, fill it.
  const sent = await call("POST", "/documents", { note_id: note.id, to: "google-docs" });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.updated, false);
  assert.equal(sent.body.export.url, "https://docs.google.com/document/d/doc1234567890abc/edit?usp=drivesdk");
  assert.deepEqual(
    google.map((r) => `${r.method} ${r.url.replace(/\?.*$/, "")}`),
    ["GET https://www.googleapis.com/drive/v3/files", "POST https://www.googleapis.com/drive/v3/files", "POST https://www.googleapis.com/drive/v3/files", "POST https://docs.googleapis.com/v1/documents/doc1234567890abc:batchUpdate"],
  );
  assert.deepEqual(google[2].body, { name: "Design review", mimeType: "application/vnd.google-apps.document", parents: ["folder1234567890"] });
  const inserted: string = google[3].body.requests[0].insertText.text;
  assert.match(inserted, /^\w{3} \d+ \w{3} \d\d:\d\d · Priya Shah\n/);
  assert.doesNotMatch(inserted, /athena:\/\//, "Athena's own links go out as plain words");

  // Sending again updates that doc: read its length, clear it, write it, keep its name in step.
  google.length = 0;
  const resent = await call("POST", "/documents", { note_id: note.id, to: "google-docs" });
  assert.equal(resent.body.updated, true);
  assert.equal(resent.body.export.id, sent.body.export.id);
  assert.deepEqual(
    google.map((r) => r.method),
    ["GET", "POST", "PATCH"],
  );
  assert.deepEqual(google[1].body.requests[0], { deleteContentRange: { range: { startIndex: 1, endIndex: 239 } } });
  assert.deepEqual(google[2].body, { name: "Design review" });

  // Send to Notion: one page, straight under the parent picked.
  const page = await call("POST", "/documents", { note_id: note.id, to: "notion" });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  assert.equal(page.body.export.url, `https://www.notion.so/Page-${PAGE}`);
  const create = notionCalls.find((c) => c.name === "notion-create-pages")!;
  assert.deepEqual(create.arguments.parent, { page_id: PARENT });
  assert.equal(create.arguments.pages[0].properties.title, "Design review");

  // The Notion gate refuses a page Athena didn't make (the owner's parent page, here), and any other tool, before the client sees it.
  const before = notionCalls.length;
  const open = await fakeOpen();
  await assert.rejects(callNotionWrite(open, "notion-update-page", { data: { page_id: PARENT, command: "replace_content", new_str: "" } }, { parentId: PARENT, own: new Set([PAGE]) }), /only changes pages it made/);
  await assert.rejects(callNotionWrite(open, "notion-move-pages", { page_or_database_ids: [PARENT] }, { parentId: PARENT, own: new Set([PAGE]) }), /only moves pages it made/);
  await assert.rejects(callNotionWrite(open, "notion-duplicate-page", { page_id: PAGE }, { parentId: PARENT, own: new Set([PAGE]) }), /doesn't call notion-duplicate-page/);
  assert.equal(notionCalls.length, before);

  // Undo: the doc goes to Drive's trash; the page moves under Removed by Athena, made the first time.
  google.length = 0;
  const undone = await call("POST", `/documents/${sent.body.export.id}/undo`);
  assert.equal(undone.status, 200);
  assert.ok(undone.body.undone_at);
  assert.deepEqual(google, [{ method: "PATCH", url: "https://www.googleapis.com/drive/v3/files/doc1234567890abc", body: { trashed: true } }]);
  notionCalls.length = 0;
  await call("POST", `/documents/${page.body.export.id}/undo`);
  assert.deepEqual(
    notionCalls.map((c) => c.name),
    ["notion-create-pages", "notion-move-pages"],
  );
  assert.deepEqual(notionCalls[0].arguments.parent, { page_id: PARENT });
  assert.equal(notionCalls[0].arguments.pages[0].properties.title, "Removed by Athena");
  assert.deepEqual(notionCalls[1].arguments, { page_or_database_ids: [PAGE], new_parent: { page_id: REMOVED } });
  const [removedRow] = await qRaw<{ kind: string }>(`SELECT kind FROM document_exports WHERE external_id = $1`, [REMOVED]);
  assert.equal(removedRow.kind, "folder", "the Removed page is on Athena's list, so later moves can use it");
  // A second send and Undo reuses that page: only a move.
  creates = -1;
  const page2 = await call("POST", "/documents", { note_id: (await createNote({ title: "Second", body: "x" })).id, to: "notion" });
  notionCalls.length = 0;
  const PAGE2 = page2.body.export.external_id;
  await call("POST", `/documents/${page2.body.export.id}/undo`);
  assert.deepEqual(
    notionCalls.map((c) => [c.name, c.arguments.page_or_database_ids?.[0], c.arguments.new_parent?.page_id]),
    [["notion-move-pages", PAGE2, REMOVED]],
  );
  assert.equal((await call("GET", `/documents?note_id=${note.id}`)).body.exports.every((e: { undone_at: string | null }) => e.undone_at), true);
  // Undo of something Athena didn't make is refused.
  assert.equal((await call("POST", `/documents/00000000-0000-4000-8000-000000000000/undo`)).status, 400);

  // ---- Ask: fill_template and send_note, each with a receipt and Undo ----
  const fillRun = await runAssistantTool("fill_template", { template: "meeting notes", event_id: event.id });
  const result = JSON.parse(fillRun.result);
  assert.deepEqual(result.left_blank, []);
  assert.ok(result.filled.includes("attendees"));
  assert.doesNotMatch(fillRun.result, /pricing page/i, "Claude gets names of fields, never the text");
  const [made] = fillRun.changes;
  assert.equal(made.kind, "note");
  assert.match(made.detail, /^Meeting notes · \d+ parts filled$/);
  // send_note only prepares a card: nothing reaches Google until the owner taps Send.
  google.length = 0;
  const sendRun = await runAssistantTool("send_note", { note_id: made.id, to: "google-docs" });
  assert.deepEqual(sendRun.changes, []);
  assert.equal(google.length, 0, "the model's turn sends nothing");
  assert.match(sendRun.result, /Nothing has been sent or saved yet/);
  assert.deepEqual(sendRun.confirm, [{ kind: "send_note", note_id: made.id, title: made.title, to: "google-docs", updates: false }]);
  // The tap: the app's own route.
  const tapped = await call("POST", "/documents", { note_id: made.id, to: "google-docs" });
  assert.equal(tapped.status, 201);
  const exported = tapped.body as { export: { id: string } };
  assert.ok(google.length > 0, "the tap sends it");
  // A receipt made before this change can still be undone.
  google.length = 0;
  await applyUndo({ op: "undo_export", id: exported.export.id });
  assert.deepEqual(google.map((r) => r.body), [{ trashed: true }]);
  await applyUndo(made.undo);
  assert.equal(await getNote(made.id), null, "the filled note is archived");

  setDocumentPorts(null);
});
