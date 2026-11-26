// Team, each assistant's own mind, on real Postgres: forgetting memory (all, or one fact) through the
// route; an assistant's conversations kept with assistant_id and out of main Ask's past-chat memory;
// a check from main Ask that only looks and can't check with another assistant (no recursion); and
// a run whose allowlist runs alone while the rest waits for Go, kept as a conversation, with memory
// refreshed, and whose allowlist still runs alone once the run has read other people's words (lib/ask-guard.ts);
// and a chat that acts like main Ask (one change runs now, two or more are a plan). Every turn is Ask's
// one loop (lib/answer.ts runAsk). The model is a fake client.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/team-mind.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the team tables and ask_threads first.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

const MOSS = { name: "Moss", job: "Finds good prices for gift ideas", instructions: "Only shops the owner trusts.", allow: ["add_todo"] };

beforeEach(async () => {
  if (!url) return;
  // Jev reads what a run reads (the day's titles too) and finds nothing aimed at an AI. A test that needs otherwise says so.
  (await import("./jev")).useJevClient({
    systemOne: async (req: { questions: Record<string, unknown> }) => ({ answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: 0.02 }])) }),
  } as never);
  // The day's block is kept for a minute with what Jev made of it: each test starts without one.
  (await import("./ask-context")).clearAskContextCache();
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`DELETE FROM ask_threads`);
});

type Params = { system?: unknown; tools?: Array<{ name: string }>; tool_choice?: { name?: string }; messages: Array<{ role: string; content: unknown }> };
type Block = { type: string; [k: string]: unknown };

/** A fake model: `script` answers each call; every call's params are kept. */
function fakeClient(script: (p: Params, n: number) => Block[]) {
  const calls: Params[] = [];
  const client = {
    messages: {
      create: async (p: Params) => {
        // The loop keeps adding to its messages after the call: keep them as they were sent.
        calls.push(structuredClone(p));
        const content = script(p, calls.length);
        return { id: `m${calls.length}`, type: "message", role: "assistant", model: "fake", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { client: client as never, calls };
}
const text = (t: string): Block => ({ type: "text", text: t });
const use = (name: string, input: unknown, id = `tu_${name}_${randomUUID().slice(0, 6)}`): Block => ({ type: "tool_use", id, name, input });
/** The loop's answer tool, as a real model finishes a turn: said this way, the reply doesn't depend on what else is in the database. */
const answer = (t: string): Block => use("answer", { text: t, found: true, general: false, from_today: false, sources: [], next: [], ask: { question: "", options: [], more: [] } });
const lastResults = (p: Params) => (p.messages.at(-1)!.content as Array<{ type: string; content?: string; is_error?: boolean }>).filter((b) => b.type === "tool_result");

test("forgetting memory: one fact, all of it, and bad input", { skip }, async () => {
  const { createAssistant, setMemory, getAssistant } = await import("./team");
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const { AthenaInputError } = await import("./db");
  // As api.ts answers: an input error is its status.
  const call = async (method: string, path: string) => {
    const u = new URL(`https://x/api${path}`);
    try {
      const res = await handleTeamRoutes(new Request(u, { method }), u, u.pathname.split("/").filter(Boolean).slice(1), async () => null, (d, s = 200) => Response.json(d, { status: s }));
      return { status: res!.status, body: await res!.json() };
    } catch (error) {
      if (error instanceof AthenaInputError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  };
  const a = await createAssistant(MOSS);
  await setMemory(a.id, { summary: "Watching the scarf.", facts: ["Budget £40", "Prefers Etsy", "Rowan likes green"] });
  const one = await call("DELETE", `/team/${a.id}/memory?fact=1`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.memory, { summary: "Watching the scarf.", facts: ["Budget £40", "Rowan likes green"] });
  assert.equal((await call("DELETE", `/team/${a.id}/memory?fact=9`)).status, 404);
  assert.equal((await call("DELETE", `/team/${a.id}/memory?fact=x`)).status, 400);
  assert.equal((await call("GET", `/team/${a.id}/memory`)).status, 405);
  const all = await call("DELETE", `/team/${a.id}/memory`);
  assert.deepEqual(all.body.memory, { summary: "", facts: [] });
  assert.deepEqual((await getAssistant(a.id))!.memory, { summary: "", facts: [] });
});

test("an assistant's conversations keep assistant_id and stay out of main Ask's memory", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { saveAskThread, listAskThreads, pastThreads, tagThreadAssistant } = await import("./ask-threads");
  const a = await createAssistant(MOSS);
  const at = new Date().toISOString();
  const msgs = (q: string) => [{ role: "me", text: q, at }];
  const mine = randomUUID();
  const hers = randomUUID();
  const later = randomUUID();
  await saveAskThread(mine, { title: "Rowan's scarf", messages: msgs("What scarf should I get Rowan for her birthday?"), updated_at: at });
  await saveAskThread(hers, { title: "Rowan's scarf price", messages: msgs("Find a good price on Rowan's birthday scarf"), updated_at: at, assistant_id: a.id });
  await saveAskThread(later, { title: "Scarf again", messages: msgs("Rowan birthday scarf colours"), updated_at: at });
  await tagThreadAssistant(later, a.id);
  // A save from an app that doesn't know keeps it.
  await saveAskThread(hers, { title: "Rowan's scarf price", messages: msgs("Find a good price on Rowan's birthday scarf"), updated_at: new Date(Date.now() + 1000).toISOString() });
  const listed = await listAskThreads();
  const by = new Map(listed.threads.map((t) => [t.id, t.assistant_id ?? null]));
  assert.equal(by.get(mine), null);
  assert.equal(by.get(hers), a.id);
  assert.equal(by.get(later), a.id);
  const past = await pastThreads("What did I decide about Rowan's birthday scarf?");
  assert.deepEqual(past.map((p) => p.id), [mine], "main Ask remembers only its own");
});

test("main Ask lists the team and checks with one, which only looks and can't check with another", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAsk } = await import("./answer");
  const moss = await createAssistant(MOSS);
  await createAssistant({ name: "Dot", job: "Turns Linear issues into to-dos", paused: true });
  let mossCalls = 0;
  const { client, calls } = fakeClient((p, n) => {
    const system = String(p.system);
    if (system.includes("You are Moss")) {
      mossCalls++;
      // Moss, checked with: tries to change something and to check with another assistant. Neither is offered or run.
      if (mossCalls === 1) return [use("add_todo", { title: "Buy the scarf", kind: "todo" }), use("check_with_assistant", { assistant: "Dot", question: "?" }), use("find_notes", { query: "scarf" })];
      return [answer("Etsy has the green scarf for £32.")];
    }
    if (n === 1) return [use("check_with_assistant", { assistant: "Moss", question: "Any good price for Rowan's scarf?" })];
    return [answer("Moss found it on Etsy for £32.")];
  });
  const reply = await runAsk("Is there a good price on Rowan's scarf yet?", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client, web: async () => false }, { log: false });

  const main = calls.filter((p) => !String(p.system).includes("You are Moss"));
  const hers = calls.filter((p) => String(p.system).includes("You are Moss"));
  assert.ok(main[0].tools!.some((t) => t.name === "check_with_assistant"), "main Ask is offered the desk");
  assert.match(String(main[0].system), /- Moss: Finds good prices for gift ideas/);
  assert.doesNotMatch(String(main[0].system), /- Dot:/, "a paused assistant isn't listed");
  assert.doesNotMatch(String(main[0].system), /<memory>/, "no assistant's memory in Ask's prompt");

  assert.equal(hers.length, 2);
  const herTools = hers[0].tools!.map((t) => t.name);
  assert.ok(!herTools.includes("check_with_assistant"), "an assistant has no desk");
  assert.ok(!herTools.includes("add_todo") && !herTools.includes("ask_owner"), "a check only looks");
  assert.ok(herTools.includes("find_notes"));
  const [todo, check, look] = lastResults(hers[1]);
  assert.equal(todo.is_error, true);
  assert.equal(check.is_error, true);
  assert.notEqual(look.is_error, true);

  assert.equal(reply.text, "Moss found it on Etsy for £32.");
  assert.deepEqual(reply.changes ?? [], []);
  assert.ok(reply.sources.some((s) => (s.kind as string) === "assistant" && s.id === moss.id), "what Moss said is a source");
  assert.deepEqual(reply.checked, [{ assistant_id: moss.id, name: "Moss", question: "Any good price for Rowan's scarf?", answer: "Etsy has the green scarf for £32." }]);
  const { qRaw } = await import("./db");
  assert.equal((await qRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ask_threads`))[0].n, "0", "a check keeps no conversation");
});

test("a run: the allowlist runs alone, the rest waits for Go, the run is kept and memory refreshed", { skip }, async () => {
  const { createAssistant, getAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { listAskThreads } = await import("./ask-threads");
  const moss = await createAssistant(MOSS);
  const { client, calls } = fakeClient((p, n) => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: "Found the scarf on Etsy.", facts: ["Budget £40", "Budget £40"] })];
    if (n === 1) return [use("add_todo", { title: "Buy Rowan's scarf from Etsy", kind: "todo", step: "Add a to-do to buy the scarf" }), use("save_note", { title: "Scarf prices", body: "Etsy £32", step: "Save the prices" })];
    return [text("Added a to-do; the note waits for Go.")];
  });
  // A run on its schedule, with nothing of other people's read: what's allowed runs alone.
  const r = await runAssistantTurn(moss.id, "It's your scheduled time. Do your job now.", { mode: "run", client });

  assert.match(String(calls[0].system), /You are Moss/);
  assert.match(String(calls[0].system), /add_todo runs straight away/);
  assert.deepEqual((r.reply.changes ?? []).map((c) => c.kind), ["commitment"], "add_todo is allowed: it ran");
  assert.equal(r.reply.plan?.steps.length, 1, "save_note waits for Go");
  assert.equal(r.reply.plan?.why, undefined);
  assert.equal(r.reply.assistant_id, moss.id);
  const kept = (await listAskThreads()).threads.find((t) => t.id === r.thread_id)!;
  assert.equal(kept.assistant_id, moss.id);
  assert.equal(kept.messages.length, 2);
  assert.equal((kept.messages[0] as { run_line?: boolean }).run_line, true, "the run's first line is marked: it isn't the owner's words");
  assert.deepEqual((await getAssistant(moss.id))!.memory, { summary: "Found the scarf on Etsy.", facts: ["Budget £40"] });
  const said = kept.messages[1] as { role: string; changes?: unknown[]; plan?: { steps: unknown[] } };
  assert.equal(said.role, "answer", "kept as one reply, with what it did and what waits");
  assert.equal(said.changes?.length, 1);
  assert.equal(said.plan?.steps.length, 1);
});

test("a run started by something that arrived: other people's words, and an allowed change still runs alone; the rest waits for Go", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { useJevClient } = await import("./jev");
  const moss = await createAssistant(MOSS);
  const { client, calls } = fakeClient((p, n) => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: "", facts: [] })];
    if (n === 1) return [use("add_todo", { title: "Buy Rowan's scarf from Etsy", kind: "todo", step: "Add a to-do to buy the scarf" }), use("save_note", { title: "Scarf price", body: "Etsy £32", step: "Save the price" })];
    return [text("Added a to-do; the note waits for Go.")];
  });
  // Jev checked what arrived and found nothing aimed at an AI.
  useJevClient({ systemOne: async () => ({ answers: { instructs: { noul: 0.02 } } }) } as never);
  try {
    const r = await runAssistantTurn(moss.id, "Check the price of the scarf", { mode: "run", event: { kind: "saved", ref_kind: "saved", facets: { title: "Green scarf", savedAction: "gift-idea" } }, client });
    assert.match(JSON.stringify(calls[0].messages[0].content), /Green scarf/);
    // The allowlist is the owner's standing request.
    assert.deepEqual((r.reply.changes ?? []).map((c) => c.kind), ["commitment"], "add_todo is allowed: it ran");
    assert.equal(r.reply.plan?.steps.length, 1, "save_note isn't: it waits");
    assert.equal(r.reply.plan?.why, "read");
  } finally {
    useJevClient(undefined);
  }
});

test("a run started by other people's words Jev couldn't check: even the allowed change waits for Go", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { useJevClient } = await import("./jev");
  const moss = await createAssistant(MOSS);
  const { client, calls } = fakeClient((p, n) => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: "", facts: [] })];
    if (n === 1) return [use("add_todo", { title: "Buy Rowan's scarf from Etsy", kind: "todo", step: "Add a to-do to buy the scarf" }), use("save_note", { title: "Scarf price", body: "Etsy £32", step: "Save the price" })];
    return [text("Both wait for your Go.")];
  });
  // Jev isn't there to ask: what arrived goes to the model as it is, unchecked.
  useJevClient(null);
  try {
    const r = await runAssistantTurn(moss.id, "Check the price of the scarf", { mode: "run", event: { kind: "saved", ref_kind: "saved", facets: { title: "Green scarf", savedAction: "gift-idea" } }, client });
    assert.ok(calls[0].tools!.some((t) => t.name === "add_todo"), "nothing is known to be wrong: the write tools stay");
    assert.deepEqual(r.reply.changes ?? [], [], "nothing ran alone");
    assert.deepEqual(r.reply.plan?.steps.map((s) => s.tool), ["add_todo", "save_note"], "both wait for Go");
    assert.equal(r.reply.plan?.why, "unchecked");
  } finally {
    useJevClient(undefined);
  }
});

test("the day's block: a run takes in what Jev made of it, a chat doesn't; past chats: a chat does", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { runAsk } = await import("./answer");
  const { useJevClient } = await import("./jev");
  const { clearAskContextCache } = await import("./ask-context");
  const { saveAskThread } = await import("./ask-threads");
  const moss = await createAssistant(MOSS);
  // Jev flags the day's block (it always starts "Now:") and past chats; nothing else.
  let flag = /^Now: /;
  useJevClient({
    systemOne: async (req: { state: { content?: unknown }; questions: Record<string, unknown> }) => {
      const hit = flag.test(String(req.state.content ?? ""));
      return { answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: hit ? 0.95 : 0.02 }])) };
    },
  } as never);
  const script = (p: Params, n: number): Block[] => (p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : n === 1 ? [text("Nothing to do.")] : [text("Done.")]);
  try {
    clearAskContextCache();
    const run = fakeClient(script);
    await runAssistantTurn(moss.id, "It's your scheduled time. Do your job now.", { mode: "run", client: run.client });
    assert.match(String(run.calls[0].system), /<today>/);
    assert.ok(!run.calls[0].tools!.some((t) => t.name === "add_todo"), "a run: the flagged day takes its changes away");

    clearAskContextCache();
    const chat = fakeClient(script);
    await runAssistantTurn(moss.id, "Anything I should know?", { mode: "chat", client: chat.client });
    assert.ok(chat.calls[0].tools!.some((t) => t.name === "add_todo"), "a chat: as before");
    // The chat's memory would be refreshed once it goes quiet: settle it now.
    await (await import("./team-memory")).flushMemory();

    // Main Ask, with a past chat about the same thing that Jev flags.
    flag = /<earlier_chats>/;
    const at = new Date().toISOString();
    await saveAskThread(randomUUID(), { title: "Rowan's scarf", messages: [{ role: "me", text: "What scarf should I get Rowan for her birthday?", at }], updated_at: at });
    const ask = fakeClient(script);
    const reply = await runAsk("What did I decide about Rowan's birthday scarf?", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client: ask.client, web: async () => false }, { log: false });
    assert.match(String(ask.calls[0].system), /<earlier_chats>/);
    assert.ok(!ask.calls[0].tools!.some((t) => t.name === "add_todo"), "a flagged past chat takes the changes away for this turn");
    assert.equal(reply.flagged, true);
  } finally {
    useJevClient(undefined);
  }
});

test("an imported assistant's run: its own words count as read, Jev's skill check reads them, and a flag takes every change away", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { useJevClient, INJECTION_WARNING } = await import("./jev");
  const { qRaw } = await import("./db");
  const moss = await createAssistant(MOSS);
  await qRaw(`UPDATE team_assistants SET origin = 'shared' WHERE id = $1::uuid`, [moss.id]);
  const script = (p: Params, n: number): Block[] => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: "", facts: [] })];
    if (n === 1) return [use("add_todo", { title: "Buy Rowan's scarf from Etsy", kind: "todo", step: "Add a to-do to buy the scarf" }), use("save_note", { title: "Scarf price", body: "Etsy £32", step: "Save the price" })];
    return [text("Done.")];
  };
  const asked: string[] = [];
  // Jev reads the shared words with its skill question, and finds nothing past the job.
  let skillRisk = 0.02;
  useJevClient({
    systemOne: async (req: { questions: Record<string, unknown> }) => {
      const q = JSON.stringify(req.questions);
      asked.push(q);
      return { answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: /This is a skill/.test(q) ? skillRisk : 0.02 }])) };
    },
  } as never);
  try {
    const clean = fakeClient(script);
    const r = await runAssistantTurn(moss.id, "It's your scheduled time. Do your job now.", { mode: "run", client: clean.client });
    assert.ok(asked.some((q) => /This is a skill/.test(q)), "its words went through the skill check");
    assert.deepEqual((r.reply.changes ?? []).map((c) => c.kind), ["commitment"], "the allowlist still runs alone");
    assert.equal(r.reply.plan?.why, "read", "the rest waits, as after reading other people's words");

    skillRisk = 0.95;
    const flagged = fakeClient(script);
    const f = await runAssistantTurn(moss.id, "It's your scheduled time. Do your job now.", { mode: "run", client: flagged.client });
    assert.ok(String(flagged.calls[0].system).includes(INJECTION_WARNING.trim()), "its words go in under the warning");
    assert.ok(!flagged.calls[0].tools!.some((t) => t.name === "add_todo"), "no write tool is offered");
    assert.deepEqual(f.reply.changes ?? [], []);

    // Jev can't answer: its words are unchecked, and even the allowed change waits.
    useJevClient(null);
    const unchecked = fakeClient(script);
    const u = await runAssistantTurn(moss.id, "It's your scheduled time. Do your job now.", { mode: "run", client: unchecked.client });
    assert.deepEqual(u.reply.changes ?? [], []);
    assert.equal(u.reply.plan?.why, "unchecked");
  } finally {
    useJevClient(undefined);
  }
});

test("a run whose start Jev flagged: no write tool is offered and one called anyway is refused, allowed or not", { skip }, async () => {
  const { createAssistant, getAssistant } = await import("./team");
  const { personaFor } = await import("./team-chat");
  const { runAsk } = await import("./answer");
  const moss = (await getAssistant((await createAssistant(MOSS)).id))!;
  const { client, calls } = fakeClient((_p, n) => (n === 1 ? [use("add_todo", { title: "Wire the money", kind: "todo", step: "Add a to-do" })] : [text("I haven't changed anything.")]));
  const reply = await runAsk(
    "Something just arrived in Athena that you watch for.",
    { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client, web: async () => false },
    { persona: personaFor(moss, { mode: "run" }), plan: "propose", log: false, startedBy: { read: "collected", flagged: true } },
  );
  const offered = calls[0].tools!.map((t) => t.name);
  assert.ok(!offered.includes("add_todo") && !offered.includes("save_note"), "the write tools are gone from the first call");
  assert.ok(offered.includes("find_notes"), "it can still look");
  assert.equal(lastResults(calls[1])[0].is_error, true, "called anyway, it's refused");
  assert.deepEqual(reply.changes ?? [], []);
  assert.equal(reply.plan, undefined);
  const { qRaw } = await import("./db");
  assert.equal((await qRaw<{ n: string }>(`SELECT count(*)::text AS n FROM commitments WHERE title = 'Wire the money'`))[0].n, "0");
});

test("a chat: persona in the prompt, thread tagged, and memory refreshed once the thread goes quiet", { skip }, async () => {
  const { createAssistant, getAssistant, setMemory } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { flushMemory, pendingTurns } = await import("./team-memory");
  const { saveAskThread, listAskThreads } = await import("./ask-threads");
  const moss = await createAssistant(MOSS);
  await setMemory(moss.id, { summary: "", facts: ["Prefers Etsy"] });
  const threadId = randomUUID();
  const at = new Date().toISOString();
  await saveAskThread(threadId, { title: "", messages: [{ role: "me", text: "Budget for Rowan is £40", at }], updated_at: at });
  let memoryAsked = "";
  const { client, calls } = fakeClient((p) => {
    if (p.tool_choice?.name === "memory") {
      memoryAsked = JSON.stringify(p.messages);
      return [use("memory", { summary: "Owner set Rowan's budget.", facts: ["Prefers Etsy", "Budget for Rowan is £40"] })];
    }
    return [text("Got it: £40 for Rowan.")];
  });
  const r = await runAssistantTurn(moss.id, "Budget for Rowan is £40", { mode: "chat", threadId, client });
  assert.equal(r.text, "Got it: £40 for Rowan.");
  assert.match(String(calls[0].system), /You are Moss/);
  assert.match(String(calls[0].system), /- Prefers Etsy/, "its own memory is in its prompt");
  assert.equal((await listAskThreads()).threads.find((t) => t.id === threadId)!.assistant_id, moss.id, "the chat is tagged");
  // Debounced: nothing is refreshed until the thread goes quiet (flushed here instead of waiting 20s).
  assert.equal(pendingTurns(), 1);
  assert.deepEqual((await getAssistant(moss.id))!.memory.facts, ["Prefers Etsy"]);
  await flushMemory();
  assert.match(memoryAsked, /Budget for Rowan is £40/);
  assert.match(memoryAsked, /Got it: £40 for Rowan/);
  assert.deepEqual((await getAssistant(moss.id))!.memory, { summary: "You set Rowan's budget.", facts: ["Prefers Etsy", "Budget for Rowan is £40"] }); // said to you, never "Owner" (lib/team-memory.ts toYou)
});

test("a chat acts like main Ask: one change runs now and is logged, two or more are a plan", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { flushMemory } = await import("./team-memory");
  const memory = (p: Params) => p.tool_choice?.name === "memory" ? [use("memory", { summary: "", facts: [] })] : null;
  const moss = await createAssistant({ ...MOSS, allow: [] });

  // One change, not on the allowlist: made straight away, with Undo, in What Ask did.
  const one = fakeClient((p, n) => memory(p) ?? (n === 1 ? [use("save_note", { title: "Scarf prices", body: "Etsy £32", step: "Save the prices" })] : [text("Saved the prices.")]));
  const r1 = await runAssistantTurn(moss.id, "Note the scarf prices", { mode: "chat", client: one.client });
  assert.match(String(one.calls[0].system), /a single change is made straight away/);
  assert.equal(r1.reply.plan, undefined, "one change is no plan");
  assert.deepEqual((r1.reply.changes ?? []).map((c) => c.kind), ["note"]);
  assert.ok(r1.reply.changes![0].undo, "with Undo");
  const { qRaw } = await import("./db");
  assert.ok(Number((await qRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ask_activity WHERE created_at > now() - interval '1 minute'`))[0].n) >= 1, "logged in What Ask did");

  // Two changes: a plan for Go, nothing made yet.
  const two = fakeClient((p, n) => memory(p) ?? (n === 1 ? [use("save_note", { title: "Scarf prices", body: "Etsy £32", step: "Save the prices" }), use("add_todo", { title: "Buy the scarf", kind: "todo", step: "Add a to-do" })] : [text("Two changes, waiting for Go.")]));
  const r2 = await runAssistantTurn(moss.id, "Note the prices and remind me to buy it", { mode: "chat", client: two.client });
  assert.equal(r2.reply.plan?.steps.length, 2);
  assert.deepEqual(r2.reply.changes ?? [], []);
  await flushMemory();
});

test("one assistant's run never sees another's: Dot's run gets nothing of Moss's reply, summary, conversation or memory", { skip }, async () => {
  const { createAssistant, getAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { enqueueTeamRun, runTeamRun, getTeamRun } = await import("./team-run");
  const { listAskThreads } = await import("./ask-threads");
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE ask_plans, ask_activity CASCADE`);
  // Moss's output carries a marker in every place a run leaves something: its reply, its plan, its memory.
  // (Not "Lego Ferrari" alone: Ask's own tool descriptions use that as an example.)
  const MARK = "Daytona model, ref ZQX-7741, at £34 from Smyths";
  const LEAK = /ZQX-7741|Daytona|Smyths/;
  const moss = await createAssistant({ ...MOSS, allow: [] });
  const dot = await createAssistant({ name: "Dot", job: "Turns Linear issues assigned to me into to-dos", allow: [] });
  const mossModel = fakeClient((p, n) => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: `Found the ${MARK}.`, facts: [`${MARK}`] })];
    if (n === 1) return [use("save_note", { title: MARK, body: MARK, step: `Save the ${MARK}` })];
    return [text(`Found the ${MARK}. Saving it waits for your approval.`)];
  });
  const dotModel = fakeClient((p, n) => {
    if (p.tool_choice?.name === "memory") return [use("memory", { summary: "Watching Linear.", facts: ["Issues go to the work list"] })];
    // A look and something to say, so the run isn't quiet and its memory is refreshed (a quiet run skips that call).
    if (n === 1) return [use("find_todos", { query: "linear" })];
    return [text("3 new issues to look at; none needs a to-do yet.")];
  });
  const go = async (id: string, client: never) => {
    const queued = await enqueueTeamRun(id);
    await runTeamRun(queued.id, { turn: (aid, prompt, opts) => runAssistantTurn(aid, prompt, { ...opts, client }) });
    return (await getTeamRun(queued.id))!;
  };
  const mossRun = await go(moss.id, mossModel.client);
  assert.match(mossRun.summary ?? "", LEAK, "the marker is in Moss's own run");
  assert.match(JSON.stringify((await getAssistant(moss.id))!.memory), LEAK);

  const dotRun = await go(dot.id, dotModel.client);
  assert.equal(dotRun.status, "done");
  assert.equal(dotRun.quiet, false, JSON.stringify(dotRun));
  assert.ok(dotModel.calls.length >= 2, "Dot's turn and its memory refresh both called the model");
  for (const [i, call] of dotModel.calls.entries()) assert.doesNotMatch(JSON.stringify(call), LEAK, `Dot's model call ${i + 1} holds none of Moss's run`);
  assert.doesNotMatch(dotRun.summary ?? "", LEAK);
  assert.doesNotMatch(JSON.stringify((await getAssistant(dot.id))!.memory), LEAK);
  const dotThread = (await listAskThreads()).threads.find((t) => t.id === dotRun.thread_id)!;
  assert.equal(dotThread.assistant_id, dot.id);
  assert.notEqual(dotRun.thread_id, mossRun.thread_id, "each run keeps its own conversation");
  assert.doesNotMatch(JSON.stringify(dotThread.messages), LEAK);
});

// Runs left behind would look unsent to the next reminders pass (lib/nudges.db.test.ts runs runReminders): clear them.
after(async () => {
  if (!process.env.ATHENA_TEST_DB_URL) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE team_runs, team_events CASCADE`);
});
