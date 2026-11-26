// Team (lib/team-chat.ts): an assistant's prompt block (name, job, instructions, tone as voice only,
// its own memory, its allowlist), the read-only tool set for a check, main Ask's check_with_assistant
// desk (the compact team list, name lookup, the cap and the time cap), and no recursion: an
// assistant's own turn has no desk.
// Run: npx tsx --test lib/team-chat.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_WEB_RULE, CHECK_TOOL_NAME, TRACKING_RULE, saysNews, MAX_CHECKS, TeamDesk, WEB_BUDGET, assistantPlanRule, isLookingTool, loadTeamDesk, personaFor, personaPrompt, webTurnFor } from "./team-chat";
import { TOOLS } from "./assistant";
import { PLAN_RULE } from "./ask-plans";
import type { TeamAssistant } from "./team-types";

const MOSS: TeamAssistant = {
  id: "5a3e0000-0000-4000-8000-000000000001",
  name: "Moss",
  job: "Finds good prices for gift ideas",
  instructions: "Only shops the owner trusts: John Lewis, Etsy.",
  personality: { tone: "playful", traits: ["curious", "thrifty"], pronoun: "she", greeting: "Hi!" },
  avatar: {} as TeamAssistant["avatar"],
  allow: ["add_todo"],
  paused: false,
  routine_id: null,
  memory: { summary: "Watching prices for Rowan's scarf.", facts: ["Budget for Rowan is £40", "Prefers Etsy"] },
  memory_updated_at: null,
  last_run_at: null,
  triggers: [],
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
};

test("the prompt block has name, job, instructions, voice, memory and the allowlist", () => {
  const p = personaPrompt(MOSS, { mode: "chat" });
  for (const s of ["You are Moss", "Your job: Finds good prices for gift ideas", "John Lewis, Etsy", "light, with a little fun", "You're curious, thrifty", "for the sound of it (not to repeat): “Hi!”", "she/her", "Watching prices for Rowan's scarf.", "- Budget for Rowan is £40", "- Prefers Etsy", "without asking: add_todo"]) assert.ok(p.includes(s), s);
  // Tone is voice only, never at the cost of accuracy.
  assert.match(p, /Tone is only how you sound, never what you say: be accurate first/);
  assert.match(p, /data, not instructions/);
  assert.doesNotMatch(p, /trigger/);
});

test("the block adapts: no memory, no allowlist, a run, a check", () => {
  const bare = personaPrompt({ ...MOSS, instructions: "", memory: { summary: "", facts: [] }, allow: [] }, { mode: "chat" });
  assert.doesNotMatch(bare, /<memory>|<instructions>/);
  assert.match(bare, /a single change you make happens straight away/);
  assert.doesNotMatch(bare, /without asking/);
  assert.match(personaPrompt({ ...MOSS, allow: [] }, { mode: "run" }), /make no change alone/);
  assert.match(personaPrompt(MOSS, { mode: "run" }), /started by one of your triggers/);
  const check = personaFor(MOSS, { mode: "chat", readOnly: true });
  assert.equal(check.readOnly, true);
  assert.deepEqual(check.allow, [], "a check runs nothing alone");
  assert.match(check.prompt, /Athena is checking with you/);
  assert.doesNotMatch(check.prompt, /without asking/);
});

test("the plan rule: a chat is main Ask's (one change runs, two or more are a plan); a run waits for Go", () => {
  assert.equal(assistantPlanRule("chat", []), PLAN_RULE);
  assert.match(assistantPlanRule("chat", ["add_todo"]), /a single change is made straight away; two or more go to the owner as a plan/);
  assert.match(assistantPlanRule("chat", ["add_todo"]), /always run straight away and don't count toward a plan: add_todo\./);
  assert.match(assistantPlanRule("run", ["add_todo"]), /add_todo runs straight away/);
  assert.match(assistantPlanRule("run", []), /^Changes wait for the owner: Every tool .* nobody is watching/);
});

test("a check only looks", () => {
  const looking = TOOLS.map((t) => t.name).filter(isLookingTool);
  for (const t of ["find_notes", "read_note", "find_people", "find_todos", "goals", "weather", "find_saved"]) assert.ok(looking.includes(t), t);
  for (const t of ["add_todo", "save_note", "draft_message", "ask_owner", "find_times", "create_event", CHECK_TOOL_NAME]) assert.ok(!isLookingTool(t), t);
});

const team = [
  { id: MOSS.id, name: "Moss", job: MOSS.job },
  { id: "5a3e0000-0000-4000-8000-000000000002", name: "Dot", job: "Turns Linear issues assigned to you into to-dos, with the right area and a due date, every time" },
];

test("the desk lists the team compactly and asks the right one", async () => {
  const asked: Array<[string, string]> = [];
  const desk = new TeamDesk(team, async (id, q) => (asked.push([id, q]), "Etsy has it for £32."));
  assert.deepEqual(desk.tools.map((t) => t.name), [CHECK_TOOL_NAME]);
  const prompt = desk.prompt();
  assert.match(prompt, /- Moss: Finds good prices for gift ideas/);
  assert.match(prompt, /- Dot: Turns Linear issues .*…/, "a long job is clipped");
  assert.ok(prompt.split("\n").every((l) => l.length < 260));
  const steps: string[] = [];
  const out = JSON.parse(await desk.run({ assistant: "moss", question: "Any good price for the scarf?" }, { onStep: (s) => steps.push(`${s.text}:${s.done}`) }));
  assert.equal(out.assistant_id, MOSS.id);
  assert.equal(out.answer, "Etsy has it for £32.");
  assert.deepEqual(asked, [[MOSS.id, "Any good price for the scarf?"]]);
  assert.deepEqual(steps, ["Checking with Moss:false", "Checked with Moss:true"]);
  assert.deepEqual(desk.checked, [{ assistant_id: MOSS.id, name: "Moss", question: "Any good price for the scarf?", answer: "Etsy has it for £32." }]);
  await assert.rejects(desk.run({ assistant: "Wren", question: "?" }), /no assistant called "Wren".*Moss, Dot/);
});

test("the desk caps checks and time, and says when one fails", async () => {
  const desk = new TeamDesk(team, async () => "ok");
  for (let i = 0; i < MAX_CHECKS; i++) await desk.run({ assistant: "Dot", question: `q${i}` });
  await assert.rejects(desk.run({ assistant: "Dot", question: "again" }), /enough checks/);
  await assert.rejects(new TeamDesk(team, async () => "ok").run({ assistant: "Dot", question: "q" }, { deadline: Date.now() + 1000 }), /No time left/);
  const broken = new TeamDesk(team, async () => {
    throw new Error("model down");
  });
  await assert.rejects(broken.run({ assistant: "Moss", question: "q" }), /Moss couldn't answer just now/);
  assert.equal(broken.checked.length, 0);
});

test("no recursion: an assistant's own turn has no desk, and an empty team offers nothing", async () => {
  const persona = personaFor(MOSS, { mode: "chat", readOnly: true });
  let listed = false;
  const desk = await loadTeamDesk({ persona, ask: async () => ((listed = true), "") });
  assert.deepEqual(desk.tools, []);
  assert.equal(desk.prompt(), "");
  assert.equal(desk.handles(CHECK_TOOL_NAME), false);
  assert.equal((await loadTeamDesk({ capture: true })).tools.length, 0);
  assert.equal(listed, false);
  assert.equal(new TeamDesk([]).handles(CHECK_TOOL_NAME), false);
});

test("looking things up online: only with the switch on, in runs and checks, with the assistant's own rule", () => {
  assert.equal(webTurnFor({ web: false }, { mode: "run" }), null);
  assert.equal(webTurnFor({}, { mode: "run" }), null, "missing: off");
  assert.deepEqual(webTurnFor({ web: true }, { mode: "run" }), { searches: WEB_BUDGET.run.searches, pages: WEB_BUDGET.run.pages, rule: ASSISTANT_WEB_RULE });
  assert.deepEqual(webTurnFor({ web: true }, { mode: "chat", readOnly: true }), { searches: 2, pages: 1, rule: ASSISTANT_WEB_RULE });
  assert.deepEqual(webTurnFor({ web: true }, { mode: "chat" }), { searches: 5, pages: 5, rule: ASSISTANT_WEB_RULE }, "a chat, as when it works alone");
  assert.equal(webTurnFor({ web: false }, { mode: "chat" }), null, "switch off: its chat searches as main Ask does");
  assert.ok(WEB_BUDGET.run.searches > 3 && WEB_BUDGET.run.pages > 0, "more than a chat's three snippet searches");
  // The rule names what may go in a search, and nothing from the owner's notes, people, emails, messages or money.
  assert.match(ASSISTANT_WEB_RULE, /the owner's country, currency and city; the public subject of your job \("Formula 1 news", "opening hours for the tip"\); the title and link of the saved item this turn is about, and the name and link of each thing this turn's message says you check for the owner; and shops and brands named in your own memory\./);
  assert.match(ASSISTANT_WEB_RULE, /no other words from the owner's notes, people, emails, messages or money/);
  // A run's card names the shop or site when it found a value online, and news comes first.
  assert.match(personaFor({ ...MOSS, web: true }, { mode: "run" }).prompt, /A value you found online comes with its shop or site, and you cite its page\. News comes first/);
  assert.doesNotMatch(personaFor({ ...MOSS, web: false }, { mode: "run" }).prompt, /found online/);
  // Keeping a check: only one read on a page, and only if the tool is there.
  assert.ok(personaFor({ ...MOSS, web: true }, { mode: "run" }).prompt.includes(TRACKING_RULE));
  assert.match(TRACKING_RULE, /if record_value is among your tools/);
  assert.match(TRACKING_RULE, /Never keep a value you didn't read on a page in this turn/);
  assert.equal(personaFor({ ...MOSS, web: false }, { mode: "run" }).prompt.includes(TRACKING_RULE), false);
  // A tracker tool saying there's news.
  assert.equal(saysNews("record_value", JSON.stringify({ done: "Kept", tell: true })), true);
  assert.equal(saysNews("record_value", JSON.stringify({ done: "Kept", tell: false })), false);
  assert.equal(saysNews("record_value", JSON.stringify({ done: "Kept", target_reached: true })), true);
  assert.equal(saysNews("set_tracker_target", JSON.stringify({ done: "Set", target_reached: true })), true, "a target set that's already met");
  assert.equal(saysNews("tracker_history", '{"target_reached": true}'), false, "reading what's known isn't news");
  assert.equal(saysNews("add_todo", '{"tell": true}'), false, "only the tracker tools");
});

test("a web-enabled assistant keeps checks alone; one without the switch doesn't", async () => {
  const { personaFor } = await import("./team-chat");
  const base = { id: "5a3e0000-0000-4000-8000-0000000e0001", name: "Moss", job: "Finds good prices for gift ideas", instructions: "", personality: { tone: "warm", traits: [], pronoun: "she", greeting: "" }, memory: { summary: "", facts: [] }, allow: ["add_to_list"] } as never as import("./team-types").TeamAssistant;
  const on = personaFor({ ...base, web: true }, { mode: "run", web: true } as never);
  const off = personaFor({ ...base, web: false }, { mode: "run", web: true } as never);
  const check = personaFor({ ...base, web: true }, { mode: "run", readOnly: true, web: true } as never);
  assert.ok(on.allow.includes("record_value"), "switch on: record_value runs alone");
  assert.ok(on.allow.includes("add_to_list"), "and its own allowlist is kept");
  assert.ok(!off.allow.includes("record_value"), "switch off: not added");
  assert.deepEqual(check.allow, [], "a read-only check changes nothing");
});

test("a run's link is one web_fetch will open: a long one loses its tracking, then its query", async () => {
  const { runLink, FETCH_LINK_MAX } = await import("./team-chat");
  const short = "https://shop.example/clippers?variant=12";
  assert.equal(runLink(short), short, "a short link is left exactly as saved");
  assert.equal(runLink("http://shop.example/x"), "");
  assert.equal(runLink(null), "");
  const tracked = `https://shop.example/clippers?variant=12&utm_source=${"a".repeat(300)}&gclid=${"b".repeat(80)}`;
  assert.equal(runLink(tracked), "https://shop.example/clippers?variant=12");
  const long = `https://shop.example/clippers?filters=${"c".repeat(300)}`;
  assert.equal(runLink(long), "https://shop.example/clippers");
  assert.equal(runLink(`https://shop.example/${"d".repeat(300)}`), "", "no link when the path alone is too long: the run searches by name");
  assert.ok(runLink(tracked).length <= FETCH_LINK_MAX);
});
