// Items someone else shared (lib/shared-limits.ts, lib/shared-scope.ts): which tools an import may grant, the
// accounts an imported item may open, and how its words reach the model. Made-up data only. Nothing needs a database.
// Run: npx tsx --test lib/shared-limits.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_TOOLS } from "./flow-catalog";
import { TOOLS } from "./assistant";
import { TRACKER_TOOLS } from "./ask-tools";
import { assistantImported, cleanAccountIds, orderAccounts, SHARED_TOOLS, sharedToolAllowed, skillImported, splitWouldLike, toolWords } from "./shared-limits";
import { AccountOff, AccountScope, scopedPorts, scopedSources, type AccountPorts } from "./shared-scope";
import { grantedTools, readShared } from "./team-share";
import { personaFor, personaPrompt, sharedWords } from "./team-chat";
import { INJECTION_WARNING } from "./jev";
import { SkillTools, SHARED_SKILL_RULE } from "./skills-ask";
import { plainNewWebLinks } from "./links";
import type { SchedulingPort } from "./scheduling";
import type { OpenSources, SourceAccount } from "./answer";
import type { Skill } from "./skills-store";
import type { TeamAssistant } from "./team-types";

const A1 = "aaaaaaaa-1111-4111-8111-000000000001";
const A2 = "aaaaaaaa-1111-4111-8111-000000000002";
const A3 = "aaaaaaaa-1111-4111-8111-000000000003";

// ---------- 1. tools ----------

test("an import may grant only the flows' changes that keep an Undo, and track", () => {
  const add = Object.entries(FLOW_TOOLS).filter(([, p]) => p.group === "add").map(([n]) => n);
  assert.deepEqual(Object.keys(SHARED_TOOLS).sort(), [...add, "track"].sort());
  const names = new Set([...TOOLS.map((t) => t.name), ...TRACKER_TOOLS.map((t) => t.name)]);
  for (const t of Object.keys(SHARED_TOOLS)) {
    assert.ok(names.has(t), `${t} is one of Ask's tools`);
    assert.ok(SHARED_TOOLS[t].label && SHARED_TOOLS[t].detail, `${t} has a plain label`);
  }
  for (const never of ["archive_or_restore", "send_note", "update_people", "add_field", "create_event", "draft_email", "answer_invite", "save_booking", "make_kind"]) assert.equal(sharedToolAllowed(never), false, never);
});

test("what a shared asks to do alone: offered, or always asks first", () => {
  const w = readShared({ format: 1, job: "Keeps lists tidy", would_like: ["add_to_list", "archive_or_restore", "track", "send_note", "add_to_list"] });
  assert.deepEqual(splitWouldLike(w.would_like), { offered: ["add_to_list", "track"], asksFirst: ["archive_or_restore", "send_note"] });
  assert.equal(toolWords("archive_or_restore"), "Archive or restore");
});

test("grantedTools never grants a tool outside the list, even ticked and asked for", () => {
  const w = readShared({ format: 1, job: "Keeps lists tidy", would_like: ["add_to_list", "archive_or_restore", "update_people"] });
  assert.deepEqual(grantedTools(w, ["add_to_list", "archive_or_restore", "update_people"]), ["add_to_list"]);
});

// ---------- 2. accounts ----------

test("imported is recorded: an origin, or a skill from a file or a link", () => {
  assert.equal(assistantImported("shared"), true);
  assert.equal(assistantImported(null), false);
  assert.equal(assistantImported(null, { kind: "link" }), true);
  assert.equal(assistantImported(null, { kind: "team" }), false);
  assert.equal(skillImported({ kind: "upload" }), true);
  for (const kind of ["written", "chat", "starter", "team"]) assert.equal(skillImported({ kind }), false, kind);
});

test("ticked accounts are ids, each once, and only ones that are there", () => {
  assert.deepEqual(cleanAccountIds([A1, A1.toUpperCase(), "gmail", 7, A2], new Set([A1])), [A1]);
  assert.deepEqual(cleanAccountIds("nope"), []);
});

test("the accounts it needs come first, in its order", () => {
  const rows = [
    { id: A1, provider: "gmail", name: "Gmail" },
    { id: A2, provider: "linear", name: "Linear" },
    { id: A3, provider: "granola", name: "Granola" },
  ];
  assert.deepEqual(orderAccounts(rows, ["linear"]).map((r) => r.provider), ["linear", "gmail", "granola"]);
});

const account = (id: string | undefined, name: string): SourceAccount => ({ key: name.toLowerCase(), name, kind: "email", tools: [], ...(id ? { connector: { id, provider: name.toLowerCase() } } : {}), call: async () => ({ text: "", isError: false, links: [], items: {} }) });

test("a scope opens only what it allows, and two limits leave what both allow", async () => {
  const asked: Array<ReadonlySet<string> | undefined> = [];
  const port = {
    open: async (o: { timeoutMs: number; only?: ReadonlySet<string> }): Promise<OpenSources> => {
      asked.push(o.only);
      return { accounts: [account(A1, "Gmail"), account(A2, "Linear"), account(undefined, "Mystery")], skipped: [], close: async () => undefined };
    },
  };
  // No limit: the port as it was.
  const free = new AccountScope();
  assert.equal((await scopedSources(port, free).open({ timeoutMs: 10 })).accounts.length, 3);
  assert.equal(asked[0], undefined);

  const scope = new AccountScope({ ids: [A1, A2], by: "Moss" });
  const opened = await scopedSources(port, scope).open({ timeoutMs: 10 });
  assert.deepEqual([...asked[1]!], [A1, A2]);
  assert.deepEqual(opened.accounts.map((a) => a.name), ["Gmail", "Linear"]);

  scope.limit([A2], "Gift prices");
  assert.equal(scope.has(A1), false);
  assert.equal(scope.has(A2), true);
  assert.equal(scope.has(undefined), false);
  assert.match(scope.refusal("Gmail"), /Gmail is off for Moss and Gift prices/);

  // Nothing ticked: nothing is opened at all.
  const none = new AccountScope({ ids: [], by: "Dot" });
  const before = asked.length;
  assert.deepEqual((await scopedSources(port, none).open({ timeoutMs: 10 })).accounts, []);
  assert.equal(asked.length, before, "the port wasn't asked");
});

test("the Session's ports refuse an account outside the limit, when it's called", async () => {
  const reached: string[] = [];
  const ports: AccountPorts = {
    gmail: {
      readThread: async (id: string) => (reached.push(`read:${id}`), { subject: "Hi", text: "Hello", replyTo: null }) as never,
      createDraft: async (id: string) => (reached.push(`draft:${id}`), { id: "d", url: null }),
      sentSamples: async (id: string) => (reached.push(`voice:${id}`), ["Thanks"]),
    },
    slack: { findMember: async () => (reached.push("slack"), null), ownMessages: async () => (reached.push("slack-voice"), ["Hi"]) },
    scheduling: {
      events: async (id: string) => (reached.push(`events:${id}`), []),
      freeBusy: async () => [],
      move: async () => ({}) as never,
      calendars: async () => [],
      create: async () => ({}) as never,
      removeCreated: async () => undefined,
    },
  };
  const scope = new AccountScope();
  const p = scopedPorts(ports, scope, async () => [A3]);
  await p.gmail!.readThread(A1, "t");
  scope.limit([A2], "Gift prices");
  await assert.rejects(p.gmail!.readThread(A1, "t"), AccountOff);
  await assert.rejects(p.gmail!.createDraft(A1, { to: [], subject: "", body: "" }), AccountOff);
  assert.deepEqual(await p.gmail!.sentSamples!(A1, null), []);
  await assert.rejects(p.slack!.findMember({ name: "Sam Rivers", email: null }), AccountOff);
  assert.deepEqual(await p.slack!.ownMessages(), []);
  assert.deepEqual(await p.scheduling!.events(A1, new Date(), new Date()), []);
  await p.gmail!.readThread(A2, "t");
  assert.deepEqual(reached, [`read:${A1}`, `read:${A2}`]);
});

// ---------- 6. someone else's words ----------

const DOT: TeamAssistant = {
  id: "5a3e0000-0000-4000-8000-000000000009",
  name: "Dot",
  job: "Turns issues into to-dos",
  instructions: "Add a to-do for each issue.",
  personality: { tone: "crisp", traits: [], pronoun: "they", greeting: "" },
  avatar: {} as TeamAssistant["avatar"],
  allow: [],
  paused: false,
  routine_id: null,
  memory: { summary: "", facts: [] },
  memory_updated_at: null,
  last_run_at: null,
  triggers: [],
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
};

test("an imported assistant's instructions and skill are someone else's words, not the owner's", () => {
  const own = personaPrompt(DOT, { mode: "chat" });
  assert.match(own, /The owner's instructions for you/);
  const shared = personaFor({ ...DOT, imported: true }, { mode: "chat" }, { name: "dot", body: "Read the issue first." }).prompt;
  assert.doesNotMatch(shared, /The owner's instructions for you/);
  assert.match(shared, /Someone else wrote this assistant/);
  assert.match(shared, /<shared_instructions>\nAdd a to-do for each issue\.\n<\/shared_instructions>/);
  assert.match(shared, /<shared_skill name="dot">\nRead the issue first\.\n<\/shared_skill>/);
  assert.doesNotMatch(shared, /<skill name=/);
  assert.match(shared, /<\/assistant>$/);
  // Its own skill from a file is enough to know it was imported.
  assert.match(personaFor(DOT, { mode: "run" }, { name: "dot", body: "x", imported: true }).prompt, /Someone else wrote this assistant/);
});

test("an imported assistant's words, as Jev's skill check reads them, and under its warning once flagged", () => {
  assert.equal(sharedWords(DOT, { name: "dot", body: "Read the issue first." }), "Job: Turns issues into to-dos\n\nInstructions:\nAdd a to-do for each issue.\n\nSkill:\nRead the issue first.");
  assert.equal(sharedWords({ ...DOT, instructions: "  " }, null), "Job: Turns issues into to-dos");
  const warned = personaFor({ ...DOT, imported: true }, { mode: "run", warned: true }).prompt;
  assert.ok(warned.includes(INJECTION_WARNING.trim()), "the warning comes before its words");
  assert.ok(warned.indexOf(INJECTION_WARNING.trim()) < warned.indexOf("<shared_instructions>"));
  assert.ok(!personaFor({ ...DOT, imported: true }, { mode: "run" }).prompt.includes(INJECTION_WARNING.trim()));
  // The owner's own assistant is never framed so.
  assert.ok(!personaFor(DOT, { mode: "run", warned: true }).prompt.includes(INJECTION_WARNING.trim()));
});

const at = "2026-11-10T10:00:00Z";
const skill = (over: Partial<Skill> = {}): Skill => ({ id: "11111111-1111-4111-8111-111111111111", name: "deal-notes", description: "Deals.", body: "Search the deal.", extra: "", files: [], skipped: [], source: { kind: "link", at }, enabled: true, assistant_id: null, starter: null, imported: true, accounts: [], uses: 0, last_used_at: null, created_at: at, updated_at: at, ...over });

test("an imported skill reaches the model as someone else's words; the owner's own as theirs", async () => {
  const tools = new SkillTools([skill(), skill({ id: "22222222-2222-4222-8222-222222222222", name: "own-one", imported: false, source: { kind: "written", at } })]);
  const shared = JSON.parse(await tools.run("use_skill", { name: "deal-notes" }));
  assert.equal(shared.rules, SHARED_SKILL_RULE);
  assert.match(await tools.preloadBlock(skill()), /<shared_skill name="deal-notes">/);
  assert.doesNotMatch(await tools.preloadBlock(skill()), /Follow it/);
  const own = JSON.parse(await tools.run("use_skill", { name: "own-one" }));
  assert.match(own.rules, /owner's instructions/);
});

test("an imported skill's instructions go through Jev's skill check, and its use is reported; the owner's own don't", async () => {
  const checked: string[] = [];
  const used: Array<{ name: string; imported: boolean }> = [];
  const mark = async (t: string) => (checked.push(t), `[checked] ${t}`);
  const tools = new SkillTools(
    [skill(), skill({ id: "22222222-2222-4222-8222-222222222222", name: "own-one", body: "Do it my way.", imported: false, source: { kind: "written", at } })],
    async (t) => t,
    (s) => used.push({ name: s.name, imported: s.imported }),
    mark,
  );
  const shared = JSON.parse(await tools.run("use_skill", { name: "deal-notes" }));
  assert.equal(shared.instructions, "[checked] Search the deal.");
  assert.match(await tools.preloadBlock(skill()), /<shared_skill name="deal-notes">\n\[checked\] Search the deal\.\n<\/shared_skill>/);
  const own = JSON.parse(await tools.run("use_skill", { name: "own-one" }));
  assert.equal(own.instructions, "Do it my way.", "the owner's own words reach the model as written");
  assert.match(await tools.preloadBlock(skill({ id: "22222222-2222-4222-8222-222222222222", name: "own-one", body: "Do it my way.", imported: false })), /<skill name="own-one">\nDo it my way\.\n<\/skill>/);
  assert.deepEqual(checked, ["Search the deal.", "Search the deal."]);
  // lib/answer.ts counts an imported one as other people's words from here (TurnGuard.sawOthers).
  assert.deepEqual(used.filter((u) => u.imported).map((u) => u.name), ["deal-notes", "deal-notes"]);
});

test("a skill coming into use is reported, so an imported one can limit the turn", async () => {
  const scope = new AccountScope();
  const tools = new SkillTools([skill({ accounts: [A2] })], async (t) => t, (s) => (s.imported ? scope.limit(s.accounts, s.name) : undefined));
  assert.equal(scope.active, false);
  await tools.run("use_skill", { name: "deal-notes" });
  assert.equal(scope.has(A1), false);
  assert.equal(scope.has(A2), true);
});

// ---------- 5. a model's edit to the owner's note ----------

test("a model's edit to the owner's note links plainly, keeping only modes the owner chose", () => {
  const before = 'Ideas: [Scarf](https://shop.example.com/scarf "card")';
  const written = 'Ideas: [Scarf](https://shop.example.com/scarf "card")\n[Hat](https://shop.example.com/hat "embed") [Gloves](https://other.example.com/g "mention") [Old](https://shop.example.com/scarf "embed")';
  assert.equal(
    plainNewWebLinks(written, before),
    'Ideas: [Scarf](https://shop.example.com/scarf "card")\n[Hat](https://shop.example.com/hat) [Gloves](https://other.example.com/g) [Old](https://shop.example.com/scarf)',
  );
  assert.equal(plainNewWebLinks("[Ref](athena://note/11111111-1111-4111-8111-111111111111)", ""), "[Ref](athena://note/11111111-1111-4111-8111-111111111111)");
});

// ---------- needed accounts ----------

test("an account the file needs, left unticked, is said plainly; connected or not", async () => {
  const { unmetNeeds, cantWorkWords, andList } = await import("./shared-limits");
  const rows = [
    { id: "5a3e0000-0000-4000-8000-0000000ac001", provider: "linear" },
    { id: "5a3e0000-0000-4000-8000-0000000ac002", provider: "gmail" },
  ];
  const names: Record<string, string> = { linear: "Linear", gmail: "Gmail", slack: "Slack" };
  const nameOf = (p: string) => names[p] ?? p;
  assert.deepEqual(unmetNeeds(["linear", "slack"], rows, []), [
    { provider: "linear", connected: true },
    { provider: "slack", connected: false },
  ]);
  assert.deepEqual(unmetNeeds(["linear"], rows, ["5A3E0000-0000-4000-8000-0000000AC001"]), [], "ticked: met");
  assert.deepEqual(unmetNeeds(["linear"], rows, [rows[1].id]), [{ provider: "linear", connected: true }], "another account ticked isn't it");
  assert.deepEqual(cantWorkWords("Dot", unmetNeeds(["linear"], rows, []), nameOf), { text: "Dot can't work without Linear.", hint: "Tick Linear below to let Dot use it." });
  assert.deepEqual(cantWorkWords("Dot", unmetNeeds(["linear", "slack"], rows, []), nameOf), {
    text: "Dot can't work without Linear and Slack.",
    hint: "Tick Linear below to let Dot use it. Connect Slack in Settings → Sources first.",
  });
  assert.equal(cantWorkWords("Dot", [], nameOf), null);
  assert.equal(andList(["Linear", "Gmail", "Slack"]), "Linear, Gmail and Slack");
});

test("under a Go limit, a look outside it is refused (not empty) and the account is named, so Go can ask", async () => {
  const { AccountScope, limitedForGo, underGoLimit } = await import("./shared-scope");
  const looked: string[] = [];
  const scheduling: SchedulingPort = {
    events: async (id) => (looked.push(id), []),
    freeBusy: async () => [],
    move: async () => ({}) as never,
    calendars: async () => [],
    create: async () => ({}) as never,
    removeCreated: async () => undefined,
  };
  assert.equal(limitedForGo({ scheduling }, async () => []).scheduling, scheduling, "no limit: the port as it is");
  const limit = { scope: new AccountScope({ ids: [A2], by: "Dot" }), refused: null as string | null };
  await underGoLimit(limit, async () => {
    const ports = limitedForGo({ scheduling }, async () => []);
    await assert.rejects(ports.scheduling!.events(A1, new Date(), new Date()), { name: "AccountOff" });
    await ports.scheduling!.events(A2, new Date(), new Date());
  });
  assert.deepEqual(looked, [A2]);
  assert.equal(limit.refused, A1);
});

test("every 'Always asks first' line is one of Athena's own change tools that an import can't grant", async () => {
  const { ASKS_FIRST_TOOLS, SHARED_TOOLS, asksFirstWords } = await import("./shared-limits");
  const { TOOLS } = await import("./assistant");
  const names = new Set(TOOLS.map((t) => t.name));
  for (const [name, o] of Object.entries(ASKS_FIRST_TOOLS)) {
    assert.ok(names.has(name), `${name} is one of Athena's tools`);
    assert.ok(!SHARED_TOOLS[name], `${name} can't be granted`);
    assert.ok(o.label && o.detail && !o.detail.endsWith("."), `${name}: a label and one line, like the ticks`);
  }
  assert.deepEqual(asksFirstWords("archive_or_restore"), { label: "Archive or restore", detail: "Puts things away, or brings them back" });
  assert.deepEqual(asksFirstWords("wire_money"), { label: "Wire money", detail: "Not something Athena can do, so it won't happen" });
});
