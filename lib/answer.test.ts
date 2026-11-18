// Ask's answers like a personal assistant (lib/answer.ts): general answers, kept text, web sources, the web switch,
// the text's shape, the server's limits and what earlier replies cited. The model is scripted and there's no database:
// Athena's own search, profile and day fail quietly without one, as they're built to.
// Run: npx tsx --test lib/answer.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Anthropic, RateLimited } from "./ai";
import { answerQuestion, historySourcesBlock, limits, parseAnswerHistory, refusedWebSearch, type AnswerDeps, type SourceAccount } from "./answer";
import type { Step } from "./steps";
import { forgetRefused } from "./ask-tool-pick";

const NOW = new Date("2026-11-12T10:00:00Z");
const TZ = "Europe/London";
const NOTE = "note:11111111-1111-4111-8111-111111111111";

type Block = Record<string, unknown>;
type Params = Anthropic.MessageCreateParamsNonStreaming;
const NO_ASK = { question: "", options: [], more: [] };
const answer = (input: Record<string, unknown>): Block => ({ type: "tool_use", id: "done", name: "answer", input: { found: true, general: false, from_today: false, sources: [], next: [], ask: NO_ASK, ...input } });
const webSearch = (id: string, query: string, pages: Array<{ url: string; title: string }>): Block[] => [
  { type: "server_tool_use", id, name: "web_search", input: { query } },
  { type: "web_search_tool_result", tool_use_id: id, content: pages.map((p) => ({ type: "web_search_result", ...p, encrypted_content: "x", page_age: null })) },
];

/** A model that gives each reply in turn (the last one again after that), and keeps what it was sent. */
function scripted(replies: Array<Block[] | ((p: Params) => Block[]) | { stop: string; content: Block[] } | Error>) {
  const sent: Params[] = [];
  const client = {
    messages: {
      async create(params: Params): Promise<Anthropic.Message> {
        sent.push(JSON.parse(JSON.stringify(params)) as Params);
        const r = replies[Math.min(sent.length - 1, replies.length - 1)];
        if (r instanceof Error) throw r;
        const content = typeof r === "function" ? r(params) : Array.isArray(r) ? r : r.content;
        const stop = Array.isArray(r) || typeof r === "function" ? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") : r.stop;
        return { id: `m${sent.length}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: stop, content } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  const tools = (i: number) => (sent[i].tools ?? []) as unknown as Array<Record<string, unknown>>;
  const toolNames = (i: number) => tools(i).map((t) => String(t.name));
  return { client, sent, tools, toolNames };
}

const noAccounts: AnswerDeps["sources"] = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
const deps = (client: Anthropic, web: boolean, sources = noAccounts): AnswerDeps => ({ client, sources, web: async () => web, mentions: async () => ({ found: [], missing: [] }) });
const opts = { now: NOW, tz: TZ };

afterEach(() => {
  delete process.env.ATHENA_RUNTIME;
  forgetRefused();
});

test("a general question is answered from what the model knows, and the reply says so", async () => {
  const m = scripted([[answer({ text: "A UK passport renewal usually takes about three weeks.", general: true })]]);
  const reply = await answerQuestion("How long does a UK passport renewal take?", deps(m.client, false), opts);
  assert.equal(reply.text, "A UK passport renewal usually takes about three weeks.");
  assert.equal(reply.found, true);
  assert.equal(reply.general, true);
  assert.deepEqual(reply.sources, []);
  assert.equal(m.sent.length, 1, "no lookup was needed");
  const system = String(m.sent[0].system);
  assert.doesNotMatch(system, /never answer from general knowledge/i);
  assert.match(system, /Anything about the owner's own life comes from a tool/);
});

test("an answer whose sources no tool returned keeps its text, without markers, as a general one", async () => {
  const m = scripted([[answer({ text: "Descale it with white vinegar [1], then rinse twice [2].", sources: [{ ref: NOTE, title: "Kettle", date: "" }, { ref: "https://made-up.example/kettle", title: "Kettles", date: "" }] })]]);
  const reply = await answerQuestion("How do I descale a kettle?", deps(m.client, false), opts);
  assert.equal(reply.text, "Descale it with white vinegar, then rinse twice.");
  assert.equal(reply.found, true);
  assert.equal(reply.general, true);
  assert.deepEqual(reply.sources, []);
});

test("a claim about the owner's own life with no source at all is still refused", async () => {
  // Not general by the model's own account, and nothing cited: it has nothing to stand on.
  const m = scripted([[answer({ text: "You spent £900 on shoes.", general: false })]]);
  const reply = await answerQuestion("What did I buy in March?", deps(m.client, false), opts);
  assert.equal(reply.text, "I couldn't find anything about that.");
  assert.equal(reply.found, false);
  assert.equal(reply.general, undefined);
});

test("found nothing stays found nothing: no general label on a miss about the owner's own life", async () => {
  const m = scripted([[answer({ text: "I couldn't find what Gayle said about pricing.", found: false })]]);
  const reply = await answerQuestion("What did Gayle say about pricing?", deps(m.client, false), opts);
  assert.equal(reply.found, false);
  assert.equal(reply.general, undefined);
});

test("a web search is offered while the switch is on, shown as a step, and its page is cited as a web source", async () => {
  const page = { url: "https://www.gov.uk/renew-adult-passport", title: "Renew or replace your adult passport" };
  const m = scripted([
    [...webSearch("ws1", "UK passport renewal time", [page, { url: "https://example.org/other", title: "Other" }]), answer({ text: "Renewals take up to three weeks [1].", general: true, sources: [{ ref: page.url, title: "gov", date: "" }] })],
  ]);
  const steps: Step[] = [];
  const reply = await answerQuestion("How long does a UK passport renewal take right now?", deps(m.client, true), { ...opts, onStep: (s) => steps.push(s) });
  const tool = m.tools(0).at(-1)!;
  assert.deepEqual(tool, { type: "web_search_20250305", name: "web_search", max_uses: 3 });
  assert.match(String(m.sent[0].system), /What goes in a web search: the public subject of the question and nothing else/);
  assert.deepEqual(reply.sources, [{ n: 1, kind: "web", id: null, url: page.url, title: page.title, date: null, account: null }]);
  assert.equal(reply.text, "Renewals take up to three weeks [1].");
  assert.equal(reply.general, true);
  assert.equal(reply.searched, "Searched your notes and the web");
  assert.equal(reply.imports, undefined, "a web page isn't saved to Athena");
  assert.ok(steps.some((s) => s.id === "web:ws1" && s.done && s.text === "Searched the web for UK passport renewal time"));
});

test("a web page the search didn't return can't be cited", async () => {
  const m = scripted([[...webSearch("ws1", "tide times", [{ url: "https://tides.example/today", title: "Tides" }]), answer({ text: "High tide is at 14:02 [1].", general: true, sources: [{ ref: "https://elsewhere.example/tides", title: "Tides", date: "" }] })]]);
  const reply = await answerQuestion("When is high tide in Brighton today?", deps(m.client, true), opts);
  assert.deepEqual(reply.sources, []);
  assert.equal(reply.text, "High tide is at 14:02.");
  assert.equal(reply.general, true);
});

test("with the switch off there is no web search tool, and an answer that needed one links to the switch", async () => {
  const m = scripted([[answer({ text: "I can't check last night's score: web search is off.", found: false, needs_web: true })]]);
  const reply = await answerQuestion("Who won the match last night?", deps(m.client, false), opts);
  assert.ok(!m.toolNames(0).includes("web_search"));
  assert.ok(!JSON.stringify(m.sent[0].tools).includes("web_search_2025"));
  assert.match(String(m.sent[0].system), /the owner has web search switched off/);
  assert.deepEqual(reply.setting, { label: "Let Ask search the web", href: "#/settings/ask" });
  // On, the tool has no needs_web field and no reply links to the switch.
  const on = scripted([[answer({ text: "Paris.", general: true })]]);
  const replyOn = await answerQuestion("What's the capital of France?", deps(on.client, true), opts);
  const answerTool = on.tools(0).find((t) => t.name === "answer")!;
  assert.ok(!("needs_web" in (answerTool.input_schema as { properties: object }).properties));
  assert.equal(replyOn.setting, undefined);
});

test("three web searches at most across an answer: the tool is gone once they're used", async () => {
  const page = (n: number) => [{ url: `https://example.org/${n}`, title: `Page ${n}` }];
  const m = scripted([
    { stop: "pause_turn", content: [...webSearch("a", "one", page(1)), ...webSearch("b", "two", page(2))] },
    { stop: "pause_turn", content: webSearch("c", "three", page(3)) },
    [answer({ text: "Done [1].", general: true, sources: [{ ref: "https://example.org/3", title: "", date: "" }] })],
  ]);
  const reply = await answerQuestion("Compare the three newest phones", deps(m.client, true), opts);
  assert.equal(m.tools(1).at(-1)!.max_uses, 1, "one search left");
  assert.ok(!m.toolNames(2).includes("web_search"));
  assert.equal(m.sent[1].messages.at(-1)!.role, "assistant", "a paused turn carries on without a new user message");
  assert.equal(reply.sources[0].url, "https://example.org/3");
});

test("a query holding an email address stops web search for the rest of the answer", async () => {
  const m = scripted([
    { stop: "pause_turn", content: webSearch("a", "who is gayle@example.com", []) },
    [answer({ text: "I couldn't find that.", found: false })],
  ]);
  await answerQuestion("Look up this person", deps(m.client, true), opts);
  assert.ok(m.toolNames(0).includes("web_search"));
  assert.ok(!m.toolNames(1).includes("web_search"));
});

/** A person Athena knows, as its tools would name them in a run. */
const knows = (title: string): AnswerDeps["mentions"] => (async () => ({ found: [{ kind: "person", id: "22222222-2222-4222-8222-222222222222", title, fields: [], ref: "person:22222222-2222-4222-8222-222222222222" }], missing: [] })) as unknown as AnswerDeps["mentions"];

test("a name the owner typed may be searched on the web, even when Athena knows the person", async () => {
  const page = { url: "https://acme.example/team", title: "Acme: the team" };
  const m = scripted([
    { stop: "pause_turn", content: webSearch("a", "Priya  Shah Acme", [page]) },
    [answer({ text: "She runs design at Acme [1].", general: true, sources: [{ ref: page.url, title: "", date: "" }] })],
  ]);
  const reply = await answerQuestion("Who is priya shah at Acme?", { ...deps(m.client, true), mentions: knows("Priya Shah") }, opts);
  assert.match(String(m.sent[0].system), /a person's name the owner typed in this conversation, in this question or in an earlier message of theirs, may go in a search/);
  assert.match(String(m.sent[0].system), /A name you only read there or in your own earlier replies, and the owner didn't type, never goes in a search/);
  assert.ok(m.toolNames(1).includes("web_search"), "the search tool stays");
  assert.equal(reply.sources[0].url, page.url);
});

test("a name Ask only read, and the owner didn't type, still stops web search for the rest of the answer", async () => {
  const m = scripted([
    { stop: "pause_turn", content: webSearch("a", "Priya Shah Acme", []) },
    [answer({ text: "I couldn't find that.", found: false })],
  ]);
  await answerQuestion("Who am I meeting on Friday?", { ...deps(m.client, true), mentions: knows("Priya Shah") }, opts);
  assert.ok(m.toolNames(0).includes("web_search"));
  assert.ok(!m.toolNames(1).includes("web_search"));
  // Typing one name doesn't open another, and an email address never goes, typed or not.
  const other = scripted([{ stop: "pause_turn", content: webSearch("a", "Priya Shah Sam Okoro", []) }, [answer({ text: "No.", found: false })]]);
  await answerQuestion("Does Sam Okoro know anyone at Acme?", { ...deps(other.client, true), mentions: knows("Priya Shah") }, opts);
  assert.ok(!other.toolNames(1).includes("web_search"));
  const email = scripted([{ stop: "pause_turn", content: webSearch("a", "priya@acme.example", []) }, [answer({ text: "No.", found: false })]]);
  await answerQuestion("Who is priya@acme.example?", deps(email.client, true), opts);
  assert.ok(!email.toolNames(1).includes("web_search"));
});

test("a name the owner typed earlier in the chat may be searched; one from Ask's reply or a tool still may not", async () => {
  const search = (query: string) => scripted([{ stop: "pause_turn", content: webSearch("a", query, []) }, [answer({ text: "I couldn't find that.", found: false })]]);
  const history = parseAnswerHistory([
    { role: "user", text: "Who is Priya Shah at Acme?" },
    { role: "assistant", text: "She runs design at Acme. Sam Okoro hired her." },
    { role: "user", text: "Is Acme hiring?" },
    { role: "assistant", text: "I can't tell." },
  ]);
  // Typed two turns back: searched, though Athena knows her.
  const typed = search("Priya Shah Acme");
  await answerQuestion("What does she do now?", { ...deps(typed.client, true), mentions: knows("Priya Shah") }, { ...opts, history });
  assert.ok(typed.toolNames(1).includes("web_search"), "the search tool stays");
  // Only in Ask's own earlier reply: blocked.
  const replied = search("Sam Okoro Acme");
  await answerQuestion("And who hired her?", { ...deps(replied.client, true), mentions: knows("Sam Okoro") }, { ...opts, history });
  assert.ok(!replied.toolNames(1).includes("web_search"));
  // Only in a tool result: blocked. A name split across two messages isn't one the owner typed.
  const read = search("Lena Marsh Acme");
  await answerQuestion("Who else is on her team?", { ...deps(read.client, true), mentions: knows("Lena Marsh") }, { ...opts, history });
  assert.ok(!read.toolNames(1).includes("web_search"));
  const split = search("Lena Marsh");
  const halves = parseAnswerHistory([{ role: "user", text: "Ask Lena" }, { role: "assistant", text: "Done." }]);
  await answerQuestion("Marsh Lane, where is it?", { ...deps(split.client, true), mentions: knows("Lena Marsh") }, { ...opts, history: halves });
  assert.ok(!split.toolNames(1).includes("web_search"));
});

test("a provider that refuses the web search tool gets the question again without it, and isn't offered it next time", async () => {
  const refusal = Object.assign(new Error("400 tools.14.type: Input tag 'web_search_20250305' is not supported"), { status: 400 });
  assert.equal(refusedWebSearch(refusal, 3), true);
  assert.equal(refusedWebSearch(Object.assign(new Error("tools.3.custom.name: too long"), { status: 400 }), 3), true, "its place in the list");
  assert.equal(refusedWebSearch(Object.assign(new Error("tools.2.custom.input_schema: JSON schema is invalid"), { status: 400 }), 3), false);
  assert.equal(refusedWebSearch(Object.assign(new Error("web_search overloaded"), { status: 529 }), 3), false);
  const m = scripted([refusal, [answer({ text: "Paris.", general: true })]]);
  const reply = await answerQuestion("What's the capital of France?", deps(m.client, true), opts);
  assert.equal(reply.text, "Paris.");
  assert.ok(m.toolNames(0).includes("web_search"));
  assert.ok(!m.toolNames(1).includes("web_search"));
  const again = scripted([[answer({ text: "Rome.", general: true })]]);
  await answerQuestion("And of Italy?", deps(again.client, true), opts);
  assert.ok(!again.toolNames(0).includes("web_search"));
});

test("a longer answer keeps its paragraphs, list lines and bold, and nothing else", async () => {
  const written = "## Packing for Lisbon\n\nIt will be mild, so pack **light layers**.\nBring a jacket for the evenings.\n\n1. Passport\n2. `Adaptor` for the plugs\n* *Sun cream*\n\n| a | b |\n\nSee [the guide](https://example.org/guide).";
  const m = scripted([[answer({ text: written, general: true })]]);
  const reply = await answerQuestion("What should I pack for Lisbon?", deps(m.client, false), opts);
  assert.equal(
    reply.text,
    "**Packing for Lisbon**\n\nIt will be mild, so pack **light layers**. Bring a jacket for the evenings.\n\n1. Passport\n2. Adaptor for the plugs\n\n- Sun cream\n\n| a | b |\n\nSee [the guide](https://example.org/guide).",
  );
  assert.match(String(m.sent[0].system), /or "1\. ", "2\. " when they are steps to follow in order/);
  assert.match(JSON.stringify(m.tools(0).find((t) => t.name === "answer")), /steps in order/);
  const long = scripted([[answer({ text: Array.from({ length: 200 }, (_, i) => `- Item number ${i} on a fairly long list of things`).join("\n"), general: true })]]);
  const cut = await answerQuestion("List everything", deps(long.client, false), opts);
  assert.ok(cut.text.length <= 6000 && cut.text.length > 5000);
  assert.ok(cut.text.endsWith("…"));
});

test("an answer from the owner's data isn't general, even with a general part beside it", async () => {
  const link = "https://mail.example/t/1";
  const gmail: SourceAccount = { key: "gmail", name: "Gmail", kind: "email", tools: [{ name: "search_threads", description: "Search email", input_schema: { type: "object" } }], call: async () => ({ text: `Flight TP1351 booked ${link}`, isError: false, links: [link] }) };
  const sources: AnswerDeps["sources"] = { open: async () => ({ accounts: [gmail], skipped: [], close: async () => undefined }) };
  const m = scripted([
    [{ type: "tool_use", id: "t1", name: "gmail__search_threads", input: { query: "flight" } }],
    [answer({ text: "You fly TP1351 on the 19th [1]. TAP usually opens check-in 36 hours before.", sources: [{ ref: link, title: "Your booking", date: "2026-11-01" }] })],
  ]);
  const reply = await answerQuestion("When do I fly, and when does check-in open?", deps(m.client, false, sources), opts);
  assert.equal(reply.found, true);
  assert.equal(reply.general, undefined);
  assert.equal(reply.sources[0].kind, "email");
  assert.equal(reply.searched, "Searched your notes and Gmail");
});

test("on the server an answer gets about a minute, ten turns, 24 lookups and medium effort; a function keeps its own", async () => {
  assert.deepEqual(limits(), { turns: 6, lookups: 14, wrapUpMs: 18_000, budgetMs: 45_000, effort: "low" });
  const looking = (): Block[] => [{ type: "tool_use", id: `t${Math.random()}`, name: "search_athena", input: { query: "Gayle" } }];
  const fn = scripted([looking]);
  await answerQuestion("Who is Gayle?", deps(fn.client, false), opts);
  assert.equal(fn.sent.length, 6);
  assert.deepEqual(fn.sent[0].output_config, { effort: "low" });
  assert.doesNotMatch(JSON.stringify(fn.sent[3].messages), /That's enough searching/);
  assert.match(JSON.stringify(fn.sent[5].messages), /That's enough searching/);

  process.env.ATHENA_RUNTIME = "server";
  assert.deepEqual(limits(), { turns: 10, lookups: 24, wrapUpMs: 60_000, budgetMs: 120_000, effort: "medium" });
  const server = scripted([looking]);
  await answerQuestion("Who is Gayle?", deps(server.client, false), opts);
  assert.equal(server.sent.length, 10);
  assert.deepEqual(server.sent[0].output_config, { effort: "medium" });
  assert.doesNotMatch(JSON.stringify(server.sent[7].messages), /That's enough searching/);
  assert.match(JSON.stringify(server.sent[9].messages), /That's enough searching/);
  // 24 lookups: three a turn for nine turns would be 27, so the last ones aren't run.
  const many = scripted([() => [1, 2, 3].map((i) => ({ type: "tool_use", id: `t${i}${Math.random()}`, name: "search_athena", input: { query: "Gayle" } }))]);
  await answerQuestion("Who is Gayle?", deps(many.client, false), opts);
  const all = JSON.stringify(many.sent.at(-1)!.messages);
  assert.equal(all.split("that's enough lookups for one question").length - 1 + all.split("Not run: it's time to answer").length - 1 > 0, true);
});

test("a routine's answer gets the server's limits inside its background function", async () => {
  assert.deepEqual(limits(true), { turns: 10, lookups: 24, wrapUpMs: 60_000, budgetMs: 120_000, effort: "medium" });
  const m = scripted([() => [{ type: "tool_use", id: `t${Math.random()}`, name: "search_athena", input: { query: "Gayle" } }]]);
  await answerQuestion("What's on this week?", deps(m.client, false), { ...opts, long: true });
  assert.equal(m.sent.length, 10);
  assert.deepEqual(m.sent[0].output_config, { effort: "medium" });
  assert.doesNotMatch(JSON.stringify(m.sent[7].messages), /That's enough searching/);
  // The routine runner asks for them (netlify/lib/routine-deps.ts builds the real client, so it's read, not run).
  assert.match(readFileSync(new URL("../netlify/lib/routine-deps.ts", import.meta.url), "utf8"), /runAsk\(question, \{ sources: answerSources,[^}]*\}, \{ now, tz, long: true, plan: "propose", log: false,/);
});

test("a rate limit carries the gateway's wait in seconds when it gave one, and nothing when it didn't", async () => {
  const limited = (headers: Record<string, string>) => scripted([new Anthropic.RateLimitError(429, {}, "rate limited", new Headers(headers))]);
  const known = await answerQuestion("Anything?", deps(limited({ "retry-after": "90" }).client, false), opts).catch((e: unknown) => e);
  assert.ok(known instanceof RateLimited);
  assert.equal(known.retryAfter, 90);
  const unknown = await answerQuestion("Anything?", deps(limited({}).client, false), opts).catch((e: unknown) => e);
  assert.ok(unknown instanceof RateLimited);
  assert.equal(unknown.retryAfter, undefined);
});

test("history: the last twelve turns, with what each reply cited (eight at most, refs and https links only)", () => {
  const turns = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }));
  assert.equal(parseAnswerHistory(turns).length, 12);
  assert.equal(parseAnswerHistory(turns)[0].text, "turn 2");
  const refs = [NOTE.toUpperCase(), NOTE, "day:2026-11-01", "https://mail.example/t/1.", "http://insecure.example", "javascript:alert(1)", "note:not-an-id", "https://a.example/x y", 7, ...Array.from({ length: 10 }, (_, i) => `https://e.example/${i}`)];
  const [q, a] = parseAnswerHistory([
    { role: "user", text: "When do I fly?", refs: [NOTE] },
    { role: "assistant", text: "On the 19th [1].", refs },
  ]);
  assert.equal(q.refs, undefined, "only a reply cites");
  assert.deepEqual(a.refs, [NOTE, "day:2026-11-01", "https://mail.example/t/1", ...Array.from({ length: 5 }, (_, i) => `https://e.example/${i}`)]);
  // A whole reply, as long as one can be: a follow-up ("turn this into a recipe") needs all of it.
  assert.equal(parseAnswerHistory([{ role: "assistant", text: "x".repeat(9000) }])[0].text.length, 6000);
  assert.deepEqual(parseAnswerHistory([{ role: "user", text: "hi" }]), [{ role: "user", text: "hi" }], "the old shape still reads");
  assert.equal(historySourcesBlock([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]), "");
});

test("the model is told what earlier replies cited, but a citation still needs a tool result from this run", async () => {
  const history = parseAnswerHistory([
    { role: "user", text: "When do I fly to Lisbon?" },
    { role: "assistant", text: "On 19 November at 07:10 [1].", refs: [NOTE, "https://mail.example/t/1"] },
  ]);
  const m = scripted([[answer({ text: "From Heathrow Terminal 2 [1].", sources: [{ ref: NOTE, title: "Lisbon trip", date: "" }] })]]);
  const reply = await answerQuestion("Which terminal?", deps(m.client, false), { ...opts, history });
  const last = m.sent[0].messages.at(-1)!;
  assert.match(String(last.content), /<earlier_sources>\n- Your reply to "When do I fly to Lisbon\?" cited: note:11111111-1111-4111-8111-111111111111, https:\/\/mail\.example\/t\/1\n<\/earlier_sources>/);
  assert.equal(m.sent[0].messages.length, 3);
  assert.deepEqual(reply.sources, [], "named in history, never returned by a tool this time");
  assert.equal(reply.text, "From Heathrow Terminal 2.");
});

test("streamed: the words arrive in the finished shape with nothing taken back, and a web search shows the moment it starts", async () => {
  const page = { url: "https://example.org/lisbon", title: "Lisbon in March" };
  const text = "## Packing\n\nPack **light layers** [1].\n\n1. A jacket\n2) `Trainers`\n* A hat";
  const input = { text, found: true, general: true, from_today: false, sources: [{ ref: page.url, title: "", date: "" }], next: [], ask: NO_ASK };
  const json = JSON.stringify(input);
  const content = [...webSearch("ws1", "Lisbon weather March", [page]), { type: "tool_use", id: "done", name: "answer", input }];
  const events: unknown[] = [
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "ws1", name: "web_search", input: {} } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "done", name: "answer", input: {} } },
    ...Array.from({ length: Math.ceil(json.length / 3) }, (_, i) => ({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: json.slice(i * 3, i * 3 + 3) } })),
  ];
  const client = {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        finalMessage: async () => ({ id: "m", type: "message", role: "assistant", model: "test", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content }),
        abort: () => undefined,
      }),
    },
  } as unknown as Anthropic;
  const steps: Step[] = [];
  let shown = "";
  let resets = 0;
  const reply = await answerQuestion("What should I pack for Lisbon in March?", deps(client, true), {
    ...opts,
    onStep: (s) => steps.push(s),
    onText: (e) => {
      if ("reset" in e) {
        resets++;
        shown = "";
      } else shown += e.delta;
    },
  });
  assert.equal(reply.text, "**Packing**\n\nPack **light layers** [1].\n\n1. A jacket\n2. Trainers\n\n- A hat");
  assert.equal(shown, reply.text, "what was watched is what stays");
  assert.equal(resets, 0);
  const web = steps.filter((s) => s.id === "web:ws1");
  assert.deepEqual(web.map((s) => [s.text, s.done]), [["Searching the web", false], ["Searched the web for Lisbon weather March", true]]);
});

// ---------- looking things up online: region, pages (docs/team-notes/web-runs.md) ----------

const LEEDS = { country: "GB", countryName: "United Kingdom", currency: "GBP", language: "en-GB", city: "Leeds", unread: [] };
const fetched = (id: string, url: string, title: string, text: string): Block[] => [
  { type: "server_tool_use", id, name: "web_fetch", input: { url } },
  { type: "web_fetch_tool_result", tool_use_id: id, content: { type: "web_fetch_result", url, retrieved_at: null, content: { type: "document", title, source: { type: "text", media_type: "text/plain", data: text } } } },
];
const WEB_TURN = { searches: 5, pages: 5, rule: "- What may go in a web search: (the assistant's rule)." };

test("main Ask's searches are placed where the owner lives, with its own rule unchanged and no page reader", async () => {
  const m = scripted([[answer({ text: "About £5.", general: true })]]);
  await answerQuestion("How much is a flat white in Leeds?", { ...deps(m.client, true), region: async () => LEEDS }, opts);
  const search = m.tools(0).find((t) => t.name === "web_search")!;
  assert.deepEqual(search.user_location, { type: "approximate", country: "GB", city: "Leeds", timezone: "Europe/London" });
  assert.equal(search.max_uses, 3);
  assert.equal(m.toolNames(0).includes("web_fetch"), false, "chat reads snippets only");
  const system = String(m.sent[0].system);
  assert.match(system, /the public subject of the question and nothing else/, "Ask's rule as it was");
  assert.match(system, /Searches are placed where the owner lives: Leeds, United Kingdom · GBP · English\./);
  // Without a Region: unplaced, and the prompt says so.
  const n = scripted([[answer({ text: "About £5.", general: true })]]);
  await answerQuestion("How much is a flat white?", { ...deps(n.client, true), region: async () => null }, opts);
  assert.equal(n.tools(0).find((t) => t.name === "web_search")!.user_location, undefined);
  assert.match(String(n.sent[0].system), /Searches aren't placed anywhere/);
});

test("a web turn: its own budget and rule, a page read is citable and shown, and a refused page reader leaves search", async () => {
  const page = "https://shop.example/kettle";
  const steps: Step[] = [];
  const m = scripted([[...webSearch("ws1", "Smeg kettle price", [{ url: page, title: "Smeg kettle" }]), ...fetched("wf1", page, "Smeg Kettle KLF03", "£129.00"), answer({ text: "£129 at Shop [1].", sources: [{ ref: page, title: "", date: "" }] })]]);
  const reply = await answerQuestion("Run now", { ...deps(m.client, true), region: async () => LEEDS }, { ...opts, webTurn: WEB_TURN, onStep: (s) => steps.push(s) });
  assert.equal(m.tools(0).find((t) => t.name === "web_search")!.max_uses, 5);
  assert.equal(m.tools(0).find((t) => t.name === "web_fetch")!.max_uses, 5);
  const system = String(m.sent[0].system);
  assert.ok(system.includes(WEB_TURN.rule));
  assert.doesNotMatch(system, /the public subject of the question and nothing else/);
  assert.deepEqual(reply.sources.map((s) => [s.kind, s.url, s.title]), [["web", page, "Smeg Kettle KLF03"]]);
  assert.ok(steps.some((s) => s.text === "Read “Smeg Kettle KLF03” on shop.example"));

  // The provider won't take web_fetch: asked again without it, and search stays.
  forgetRefused();
  let calls = 0;
  const r = scripted([
    (p) => {
      calls++;
      if ((p.tools ?? []).some((t) => (t as { name?: string }).name === "web_fetch")) throw Object.assign(new Error("tools.40: web_fetch is not supported"), { status: 400 });
      return [answer({ text: "Searched only.", general: true })];
    },
  ]);
  const without = await answerQuestion("Run now", { ...deps(r.client, true), region: async () => null }, { ...opts, webTurn: WEB_TURN });
  assert.equal(without.text, "Searched only.");
  assert.equal(calls, 2);
  assert.ok(r.toolNames(1).includes("web_search"));
  assert.equal(r.toolNames(1).includes("web_fetch"), false);
  forgetRefused();
});

test("a page whose link holds a private detail ends the web for the turn", async () => {
  const bad = "https://tracker.example/?u=owner%40mail.example";
  const m = scripted([[...fetched("wf1", bad, "", "ok")], [answer({ text: "Done.", general: true })]]);
  await answerQuestion("Run now", deps(m.client, true), { ...opts, webTurn: WEB_TURN });
  assert.equal(m.toolNames(1).includes("web_fetch"), false);
  assert.equal(m.toolNames(1).includes("web_search"), false);
});

test("the web off: a web turn gets no page reader and no search", async () => {
  const m = scripted([[answer({ text: "I can't check that.", found: false })]]);
  await answerQuestion("Run now", deps(m.client, false), { ...opts, webTurn: WEB_TURN });
  assert.equal(m.toolNames(0).includes("web_fetch"), false);
  assert.equal(m.toolNames(0).includes("web_search"), false);
});
