// Items someone else shared, on the real path: Postgres with every migration (0086 included), the store, the API's
// skill routes, Ask's one loop with the model stubbed at fetch, and fake connected accounts.
//  1. Importing an assistant grants only changes that keep an Undo (and track); the rest always ask first.
//  2. An imported assistant's turns, and an imported skill in use, open only the accounts ticked for them.
//  3. The one-time notice lists imported skills that lost their accounts, until it's read.
//  4. An imported skill starts off, whatever was sent.
//  5. A model's edit to the owner's note links plainly, through every tool that writes into one.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/shared-items.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties skills, assistants, connectors and plans first. Made-up data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { OpenSources, SourceAccount } from "./answer";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";
const NOW = new Date("2026-11-10T10:00:00Z");

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}
interface Req {
  system: string | Array<{ text: string }>;
  tools: Array<{ name: string }>;
  messages: Array<{ role: string; content: string | Block[] }>;
}

const realFetch = globalThis.fetch;
let script: (req: Req) => Block[] = () => [];
const seen: Req[] = [];
const systemOf = (req: Req) => (typeof req.system === "string" ? req.system : req.system.map((s) => s.text).join(""));
const toolResults = (req: Req) => req.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result")));
/** The first request of Ask's loop (an assistant with no skill yet may have its skill written first, by another call). */
const turn = () => seen.find((r) => r.tools?.some((t) => t.name === "answer"))!;
const answer = (text: string): Block => ({ type: "tool_use", id: "ans", name: "answer", input: { text, found: false, from_today: false, sources: [], next: [] } });

before(() => {
  if (!url) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
      const req = JSON.parse(String(init.body ?? (input instanceof Request ? await input.text() : "{}"))) as Req;
      seen.push(req);
      const content = script(req);
      const usesTool = content.some((b) => b.type === "tool_use");
      const m = { id: `msg_${seen.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      return new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json", "request-id": "req_test" } });
    }
    throw new Error(`Unexpected fetch in a test: ${u.href}`);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const { handleSkillRoutes } = await import("../netlify/lib/skills-routes");
  const req = new Request(`https://athena.test/api/${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  const res = await handleSkillRoutes(req, ["api", ...path.split("/")], async () => (body ?? null) as Record<string, unknown> | null, (d, s = 200) => new Response(JSON.stringify(d), { status: s }));
  assert.ok(res, `${method} ${path} handled`);
  return { status: res.status, data: JSON.parse(await res.text()) };
}

/** Two connected accounts, as rows, and a sources port over them that records what it was asked to open and call. */
async function accounts() {
  const { qRaw } = await import("./db");
  const [mail] = await qRaw<{ id: string }>(`INSERT INTO connectors (name, provider, account_label, url, status, allowed_tools) VALUES ('Gmail', 'gmail', 'sam@example.com', 'https://gmail.example.com', 'connected', '{search_threads}') RETURNING id`);
  const [issues] = await qRaw<{ id: string }>(`INSERT INTO connectors (name, provider, account_label, url, status, allowed_tools) VALUES ('Linear', 'linear', 'work', 'https://linear.example.com', 'connected', '{list_issues}') RETURNING id`);
  const asked: Array<ReadonlySet<string> | undefined> = [];
  const called: string[] = [];
  const account = (id: string, key: string, name: string, tool: string): SourceAccount => ({
    key,
    name,
    kind: "email",
    tools: [{ name: tool, description: `${name}'s ${tool}`, input_schema: { type: "object", properties: {} } }],
    connector: { id, provider: key },
    call: async (t) => (called.push(`${key}:${t}`), { text: "[]", isError: false, links: [], items: {} }),
  });
  // Like the real port, it opens only what `only` names; everything when there's no limit.
  const sources = {
    open: async (o: { timeoutMs: number; only?: ReadonlySet<string> }): Promise<OpenSources> => {
      asked.push(o.only);
      const all = [account(mail.id, "gmail", "Gmail", "search_threads"), account(issues.id, "linear", "Linear", "list_issues")];
      return { accounts: all.filter((a) => !o.only || o.only.has(a.connector!.id)), skipped: [], close: async () => undefined };
    },
  };
  return { mail: mail.id, issues: issues.id, asked, called, sources };
}

async function reset() {
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ask_skills, ask_activity, ask_plans, flows, team_assistants, connectors CASCADE`);
  await qRaw(`DELETE FROM settings WHERE key IN ('skills.starters', 'skills.accounts_notice', 'team.origin_marked')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('skills.starters', 'true'::jsonb)`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  seen.length = 0;
}

const SHARED = {
  format: 1,
  name: "Dot",
  job: "Turns Linear issues into to-dos",
  instructions: "Add a to-do for each new issue.",
  needs: ["linear"],
  would_like: ["add_todo", "archive_or_restore", "update_people", "track"],
};

// First: the notice is claimed once a process, on the first read of skills.
test("the one-time notice names imported skills that lost their accounts, until it's read", { skip }, async () => {
  await reset();
  const { qRaw } = await import("./db");
  const { sealText } = await import("./data-box");
  await accounts();
  // Two skills from before 0086: one from a link, one the owner wrote.
  const payload = (name: string, kind: string) => sealText(JSON.stringify({ name, description: "x", body: "y", extra: "", files: [], skipped: [], source: { kind, at: "2026-11-01T00:00:00Z" } }));
  await qRaw(`INSERT INTO ask_skills (payload, enabled) VALUES ($1, true), ($2, true)`, [payload("deal-notes", "link"), payload("my-notes", "written")]);
  const notice = await api("GET", "skills/notice");
  assert.deepEqual((notice.data.skills as Array<{ name: string; title: string }>).map((s) => [s.name, s.title]), [["deal-notes", "Deal notes"]]);
  // One imported now has its ticks on the import sheet: it isn't named.
  await api("POST", "skills", { skill_md: "---\nname: later-one\ndescription: x\n---\n\ny\n", source: { kind: "upload" } });
  assert.equal((await api("GET", "skills/notice")).data.skills && ((await api("GET", "skills/notice")).data.skills as unknown[]).length, 1);
  assert.equal((await api("DELETE", "skills/notice")).status, 200);
  assert.deepEqual((await api("GET", "skills/notice")).data.skills, []);
});

test("importing an assistant: only changes with an Undo and track can be granted, and nothing else is ticked", { skip }, async () => {
  await reset();
  const { mail, issues } = await accounts();
  const { previewImport, importAssistant } = await import("./team-share-store");
  const preview = await previewImport({ assistant_json: JSON.stringify(SHARED) });
  assert.deepEqual(preview.shared.would_like, ["add_todo", "track"]);
  assert.deepEqual(preview.asks_first, ["archive_or_restore", "update_people"]);
  // Every account the turn could open, the one it needs first.
  assert.deepEqual(preview.accounts.map((a) => a.id), [issues, mail]);

  // The app sends everything back, ticked; only what an import may grant is kept. A made-up account id is dropped.
  const { assistant } = await importAssistant({ shared: SHARED, skill: { body: "Read each issue, then add a to-do with its title and link.", files: [] }, source: { kind: "upload" }, answers: [], allow: SHARED.would_like, web: false, accounts: [issues, "99999999-9999-4999-8999-999999999999"] });
  assert.deepEqual(assistant.allow.sort(), ["add_todo", "track"]);
  assert.equal(assistant.imported, true);
  assert.deepEqual(assistant.accounts, [issues]);
  assert.equal(assistant.paused, true);

  // Made here: not imported, and its turns aren't limited.
  const { createAssistant, updateAssistant } = await import("./team");
  const own = await createAssistant({ job: "Keeps my reading list" });
  assert.equal(own.imported, false);
  // The owner ticks another account on its page.
  assert.deepEqual((await updateAssistant(assistant.id, { accounts: [issues, mail] })).accounts, [issues, mail]);
});

test("an imported assistant keeps the accounts its file needs, sealed with its words, through later changes", { skip }, async () => {
  await reset();
  const { issues } = await accounts();
  const { importAssistant } = await import("./team-share-store");
  const { getAssistant, updateAssistant, createAssistant } = await import("./team");
  const { qRaw } = await import("./db");
  const { assistant } = await importAssistant({ shared: SHARED, skill: { body: "Read each issue, then add a to-do with its title and link.", files: [] }, source: { kind: "upload" }, answers: [], allow: [], web: false, accounts: [] });
  assert.deepEqual(assistant.needs, ["linear"]);
  assert.deepEqual((await getAssistant(assistant.id))!.needs, ["linear"]);
  // Kept through the owner's changes on its page.
  assert.deepEqual((await updateAssistant(assistant.id, { job: "Turns issues into to-dos", accounts: [issues] })).needs, ["linear"]);
  // Not readable at rest: it's in the sealed payload, with its name and job.
  const [row] = await qRaw<{ payload: string }>(`SELECT payload FROM team_assistants WHERE id = $1::uuid`, [assistant.id]);
  assert.doesNotMatch(row.payload, /linear/);
  // One made here has none, whatever it's sent.
  const own = await createAssistant({ job: "Keeps my reading list" }, { needs: ["linear"] });
  assert.equal(own.needs, undefined);
});

test("an imported assistant's chat opens only its ticked accounts; one made here opens them all", { skip }, async () => {
  await reset();
  const acc = await accounts();
  const { importAssistant } = await import("./team-share-store");
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  // With a skill of its own, so nothing is written for it in the background.
  const { assistant: dot } = await importAssistant({ shared: SHARED, skill: { body: "Read each issue, then add a to-do with its title and link.", files: [] }, source: { kind: "upload" }, answers: [], allow: [], web: false, accounts: [acc.issues] });
  script = (req) => {
    if (!toolResults(req).length) return [{ type: "tool_use", id: "g1", name: "gmail__search_threads", input: {} }, { type: "tool_use", id: "l1", name: "linear__list_issues", input: {} }];
    return [answer("Two new issues.")];
  };
  await runAssistantTurn(dot.id, "Anything new?", { mode: "chat", sources: acc.sources, now: NOW });
  assert.deepEqual([...acc.asked[0]!], [acc.issues], "only Linear was opened");
  assert.ok(!turn().tools.some((t) => t.name.startsWith("gmail__")), "Gmail isn't offered");
  assert.deepEqual(acc.called, ["linear:list_issues"]);
  // Its words are someone else's.
  assert.match(systemOf(turn()), /Someone else wrote this assistant/);
  assert.match(systemOf(turn()), /<shared_instructions>/);
  assert.match(systemOf(turn()), /<shared_skill name="[^"]+">\nRead each issue/);

  // Nothing ticked: nothing opens.
  const { updateAssistant } = await import("./team");
  await updateAssistant(dot.id, { accounts: [] });
  seen.length = 0;
  await runAssistantTurn(dot.id, "Anything new?", { mode: "chat", sources: acc.sources, now: NOW });
  assert.equal(acc.asked.length, 1, "the port wasn't asked at all");
  assert.ok(!turn().tools.some((t) => t.name.includes("__")));

  const own = await createAssistant({ job: "Keeps my reading list", instructions: "Look at my email." });
  seen.length = 0;
  script = () => [answer("Done.")];
  await runAssistantTurn(own.id, "Anything new?", { mode: "chat", sources: acc.sources, now: NOW });
  assert.equal(acc.asked[acc.asked.length - 1], undefined, "no limit for the owner's own");
  assert.match(systemOf(turn()), /The owner's instructions for you/);
});

test("an imported skill in use: its unticked accounts are refused and stop being offered; picked, they never open", { skip }, async () => {
  await reset();
  const acc = await accounts();
  const { runAsk } = await import("./answer");
  const md = "---\nname: deal-notes\ndescription: Use when the owner asks about a deal.\n---\n\nSearch email and issues for the deal.\n";
  const saved = await api("POST", "skills", { skill_md: md, source: { kind: "link", url: "https://github.com/sample/skills/tree/main/deal-notes" }, enabled: true });
  assert.equal(saved.data.enabled, false, "an imported skill starts off, whatever was sent");
  assert.equal(saved.data.imported, true);
  const id = saved.data.id as string;
  await api("PUT", `skills/${id}`, { enabled: true, accounts: [acc.issues, "99999999-9999-4999-8999-999999999999"] });
  assert.deepEqual((await api("GET", `skills/${id}`)).data.accounts, [acc.issues]);
  const deps = { sources: acc.sources, web: async () => false, mentions: async () => ({ found: [], missing: [] }) };

  // In use part-way through a turn: Gmail is refused from then on, and isn't offered again.
  script = (req) => {
    const n = toolResults(req).length;
    if (n === 0) return [{ type: "tool_use", id: "s1", name: "use_skill", input: { name: "deal-notes" } }];
    if (n === 1) return [{ type: "tool_use", id: "g1", name: "gmail__search_threads", input: {} }, { type: "tool_use", id: "l1", name: "linear__list_issues", input: {} }];
    return [answer("Nothing on the deal.")];
  };
  await runAsk("What did they say about the deal?", deps, { tz: TZ, now: NOW });
  assert.equal(acc.asked[0], undefined, "nothing limited the turn before the skill");
  const refused = toolResults(seen[2]).find((b) => b.tool_use_id === "g1")!;
  assert.equal(refused.is_error, true);
  assert.match(String(refused.content), /Gmail is off for Deal notes/);
  assert.deepEqual(acc.called, ["linear:list_issues"]);
  assert.ok(!seen[2].tools.some((t) => t.name.startsWith("gmail__")), "Gmail's tools are gone once the skill is in use");
  assert.ok(seen[2].tools.some((t) => t.name.startsWith("linear__")));

  // Picked with "/": only Linear opens at all.
  seen.length = 0;
  script = () => [answer("Nothing.")];
  await runAsk("deal", deps, { tz: TZ, now: NOW, skill: id });
  assert.deepEqual([...acc.asked[acc.asked.length - 1]!], [acc.issues]);
  assert.match(JSON.stringify(seen[0].messages), /shared_skill name=\\"deal-notes\\"/);

  // The owner's own skill limits nothing.
  const own = await api("POST", "skills", { skill_md: md.replace("deal-notes", "my-deals"), source: { kind: "written" }, enabled: true });
  assert.equal(own.data.enabled, true);
  assert.equal(own.data.imported, false);
  await runAsk("deal", deps, { tz: TZ, now: NOW, skill: own.data.id as string });
  assert.equal(acc.asked[acc.asked.length - 1], undefined);
});

test("a model's edit to a note the owner wrote links plainly; links the owner chose keep their mode", { skip }, async () => {
  await reset();
  const { createNote, getNote } = await import("./db");
  const { Session } = await import("./assistant");
  const note = await createNote({ title: "Gift ideas", body: 'A [scarf](https://shop.example.com/scarf "card")', type: "note", source: "app", tags: [] });
  const s = new Session(NOW, TZ, { client: {} as never, capture: false });
  await s.run("save_note", { note_id: note.id, body: 'A [scarf](https://shop.example.com/scarf "card") and [a hat](https://shop.example.com/hat "embed")' });
  assert.equal((await getNote(note.id))!.body, 'A [scarf](https://shop.example.com/scarf "card") and [a hat](https://shop.example.com/hat)');
});

test("a line a model adds to the owner's list links plainly; a list Athena wrote is left as written", { skip }, async () => {
  await reset();
  const { createNote, getNote } = await import("./db");
  const { Session } = await import("./assistant");
  const list = await createNote({ title: "Packing", body: '- [ ] [Tent](https://shop.example.com/tent "card")', type: "note", source: "app", tags: [] });
  const s = new Session(NOW, TZ, { client: {} as never, capture: false });
  await s.run("add_to_list", { note_id: list.id, item: '[Stove](https://shop.example.com/stove "embed")' });
  const body = (await getNote(list.id))!.body;
  assert.match(body, /\[Tent\]\(https:\/\/shop\.example\.com\/tent "card"\)/, "the owner's own choice stays");
  assert.match(body, /\[Stove\]\(https:\/\/shop\.example\.com\/stove\)/, "the model's line links plainly");
  assert.doesNotMatch(body, /"embed"/);
  // A list Athena wrote (not the owner's) is left as the model wrote it.
  const athenas = await createNote({ title: "Ideas", body: "", type: "note", source: "assistant", tags: [] });
  await s.run("add_to_list", { note_id: athenas.id, item: '[Lamp](https://shop.example.com/lamp "card")' });
  assert.match((await getNote(athenas.id))!.body, /"card"/);
});

test("an imported assistant's run: the calendar it wasn't given isn't read; the owner's own assistant reads it", { skip }, async () => {
  await reset();
  const { qRaw } = await import("./db");
  const [cal] = await qRaw<{ id: string }>(`INSERT INTO connectors (name, provider, account_label, url, status) VALUES ('Google Calendar', 'google-calendar', 'sam@example.com', 'https://calendar.example.com', 'connected') RETURNING id`);
  const read: string[] = [];
  const scheduling = {
    events: async (id: string) => (read.push(id), []),
    freeBusy: async () => [],
    move: async () => ({}) as never,
    calendars: async () => [],
    create: async () => ({}) as never,
    removeCreated: async () => undefined,
  };
  const { importAssistant } = await import("./team-share-store");
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { assistant: dot } = await importAssistant({ shared: SHARED, skill: { body: "Read each issue, then add a to-do with its title and link.", files: [] }, source: { kind: "upload" }, answers: [], allow: [], web: false });
  script = (req) => (toolResults(req).length ? [answer("Thursday at 10 is free.")] : [{ type: "tool_use", id: "f1", name: "find_times", input: { minutes: 30 } }]);
  await runAssistantTurn(dot.id, "Find half an hour", { mode: "run", scheduling, now: NOW });
  assert.deepEqual(read, [], "the calendar wasn't read");

  const own = await createAssistant({ job: "Keeps my week tidy", instructions: "Find time for focus." });
  await runAssistantTurn(own.id, "Find half an hour", { mode: "run", scheduling, now: NOW });
  assert.deepEqual(read, [cal.id]);
});
