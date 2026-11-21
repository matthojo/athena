// An assistant's own skill (lib/team-skill.ts, lib/team-skill-make.ts): question and answer fitting,
// the skill Athena writes (always a valid SKILL.md), the fingerprints behind the update offer, and the
// model calls falling back cleanly. The model is a fake client; nothing here needs a database.
// Run: npx tsx --test lib/team-skill.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillMd, serialiseSkillMd, nameProblem, descriptionProblem, SKILL_LIMITS } from "./skills";
import { assistantSkillName, firstPerson, fitAnswers, fitQuestions, fitTeamSkill, hashText, skillBasis, skillEdited, skillGist, skillStale, templateSkill } from "./team-skill";
import { askQuestions, writeSkill } from "./team-skill-make";
import { personaPrompt } from "./team-chat";

const PENNY = { name: "Penny", job: "Finds good prices for gift ideas", instructions: "Look for the best price from a shop the owner trusts." };
const ANSWERS = [
  { question: "Which shops do you trust?", answer: "Waterstones and Smyths" },
  { question: "What's your budget per gift?", answer: "Under £50" },
  { question: "When should Penny tell you?", answer: "Only big drops" },
];

// ---------- questions ----------

const GOOD = [
  { question: "Which shops do you trust?", choices: ["Any shop", "Ones I've bought from", "Independent shops"], allowOther: true },
  { question: "What's your budget per gift?", choices: ["Under £25", "Under £50", "No limit"], allowOther: true },
  { question: "When should Penny tell you?", choices: ["Any drop", "Only big drops"], allowOther: false },
];

test("questions: good ones come through with ids, in order", () => {
  const q = fitQuestions(GOOD);
  assert.deepEqual(q.map((x) => x.id), ["q1", "q2", "q3"]);
  assert.equal(q[2].allowOther, false);
  assert.deepEqual(q[0].choices, ["Any shop", "Ones I've bought from", "Independent shops"]);
});

test("questions: bad ones are dropped, and fewer than two good ones is none", () => {
  const junk = [
    { question: "Hm?", choices: ["a", "b"] }, // too short
    { question: "x".repeat(200), choices: ["a", "b"] }, // too long
    { question: "Which shops do you trust?", choices: ["Only one"] }, // one choice
    { question: "Pick a <b>shop</b>", choices: ["a", "b"] }, // markup
    "not a question",
    null,
  ];
  assert.deepEqual(fitQuestions(junk), []);
  assert.deepEqual(fitQuestions([GOOD[0], ...junk]), [], "one good question isn't enough");
  assert.deepEqual(fitQuestions("nope"), []);
  assert.deepEqual(fitQuestions(undefined), []);
});

test("questions: at most four, at most five choices, no repeats, allowOther defaults on", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ question: `Question number ${i + 1}?`, choices: ["a", "b", "c", "d", "e", "f", "a"] }));
  const q = fitQuestions([...many.slice(0, 2), { ...many[0], question: "QUESTION NUMBER 1?" }, ...many.slice(2)]);
  assert.equal(q.length, 4);
  assert.deepEqual(q.map((x) => x.question), ["Question number 1?", "Question number 2?", "Question number 3?", "Question number 4?"]);
  assert.deepEqual(q[0].choices, ["a", "b", "c", "d", "e"]);
  assert.ok(q.every((x) => x.allowOther));
});

test("answers: trimmed, cut, empty ones dropped, at most four", () => {
  const a = fitAnswers([{ question: "  Which shops?  ", answer: " Waterstones " }, { question: "Budget?", answer: "" }, { question: "", answer: "x" }, ...Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, answer: "y".repeat(400) }))]);
  assert.equal(a.length, 4);
  assert.deepEqual(a[0], { question: "Which shops?", answer: "Waterstones" });
  assert.equal(a[1].answer.length, 300);
  assert.deepEqual(fitAnswers("nope"), []);
});

// ---------- the skill ----------

test("the plain skill is a valid SKILL.md that names the job, the instructions and every answer", () => {
  const s = templateSkill(PENNY, ANSWERS);
  assert.equal(nameProblem(s.name), null);
  assert.equal(descriptionProblem(s.description), null);
  const round = parseSkillMd(serialiseSkillMd(s));
  assert.equal(round.name, s.name);
  assert.equal(round.description, s.description);
  assert.match(round.body, /# How Penny works/);
  assert.match(round.body, /finds good prices for gift ideas/);
  assert.match(round.body, /shop the owner trusts/);
  for (const a of ANSWERS) assert.ok(round.body.includes(a.answer), a.answer);
  assert.equal(s.summary, "Penny finds good prices for gift ideas, keeping to what you told it at setup.");
  const bare = templateSkill({ ...PENNY, instructions: "" }, []);
  assert.doesNotMatch(bare.body, /instructions|told you/);
  assert.equal(bare.summary, "Penny finds good prices for gift ideas.");
});

test("skill names keep Claude's rules, however odd the assistant's name and job", () => {
  assert.equal(assistantSkillName("Penny", "Finds good prices for gift ideas"), "penny-finds-good-prices-for-gift-ideas");
  for (const [n, j] of [["Claude", "Anthropic news"], ["Zoë", "Ünïcode jöb"], ["!!!", "???"], ["Dot", "x".repeat(200)], ["A very long assistant name here", "and an even longer job that goes on and on for a while"]]) {
    const name = assistantSkillName(n, j);
    assert.equal(nameProblem(name), null, `${n} / ${j} → ${name}`);
    assert.ok(name.length <= 48 || name.endsWith("-skill"), name);
  }
});

test("the model's skill is fitted: Athena's name and description, a body cut to size, junk refused", () => {
  const f = fitTeamSkill({ body: "# How Penny works\n\n1. Check Waterstones first.\n2. Keep it under £50.", summary: "Checks <b>Waterstones</b> first." }, PENNY)!;
  assert.equal(f.name, "penny-finds-good-prices-for-gift-ideas");
  assert.match(f.description, /^Penny's own skill/);
  assert.equal(f.summary, "Checks Waterstones first.");
  assert.equal(fitTeamSkill({ body: "short" }, PENNY), null);
  assert.equal(fitTeamSkill(null, PENNY), null);
  assert.equal(fitTeamSkill({ body: "x".repeat(SKILL_LIMITS.body + 500) }, PENNY)!.body.length, SKILL_LIMITS.body);
  assert.equal(fitTeamSkill({ body: "1. A step that is long enough to count as a body." }, PENNY)!.summary, "Penny finds good prices for gift ideas.", "no summary: one from the job");
});

test("fingerprints: stale when the job or instructions change, edited when the body does", () => {
  const meta = { basis: skillBasis(PENNY), made: hashText("1. Check Waterstones.") };
  assert.equal(skillStale(meta, PENNY), false);
  assert.equal(skillStale(meta, { ...PENNY, job: `  ${PENNY.job}  ` }), false, "spacing doesn't count");
  assert.equal(skillStale(meta, { ...PENNY, instructions: "Any shop is fine." }), true);
  assert.equal(skillStale(null, PENNY), false);
  assert.equal(skillEdited(meta, "1. Check Waterstones.\n"), false);
  assert.equal(skillEdited(meta, "1. Check Smyths."), true);
  assert.notEqual(hashText("a"), hashText("b"));
  assert.match(hashText(""), /^[0-9a-f]{8}$/);
});

test("the gist: the first few steps, as plain lines", () => {
  assert.deepEqual(skillGist("# Penny\n\nIntro line.\n\n1. Check **Waterstones** first.\n2) Keep it under `£50`.\n- See [the list](https://x)\n* Fourth\n5. Fifth"), ["Check Waterstones first.", "Keep it under £50.", "See the list", "Fourth"]);
  assert.deepEqual(skillGist("No steps at all."), []);
});

// ---------- applied in the prompt ----------

test("the assistant's prompt carries its own skill, clipped, and says the owner's instructions win", () => {
  const a = { ...PENNY, personality: { tone: "warm" as const, traits: [], pronoun: "she" as const, greeting: "Hi" }, memory: { summary: "", facts: [] }, allow: [] };
  const without = personaPrompt(a, { mode: "chat" });
  assert.doesNotMatch(without, /<skill/);
  const withSkill = personaPrompt({ ...a, skill: { name: "penny-gift-prices", body: "1. Check Waterstones first." } }, { mode: "run" });
  assert.match(withSkill, /<skill name="penny-gift-prices">\n1\. Check Waterstones first\.\n<\/skill>/);
  assert.match(withSkill, /the instructions win/);
  const long = personaPrompt({ ...a, skill: { name: "big", body: "y".repeat(SKILL_LIMITS.resultChars + 100) } }, { mode: "chat" });
  assert.match(long, /\[cut short\]/);
  assert.ok(!long.includes("y".repeat(SKILL_LIMITS.resultChars + 1)));
});

// ---------- the model calls ----------

type Block = { type: string; [k: string]: unknown };
function fakeClient(reply: (p: { tool_choice?: { name?: string }; messages: unknown[] }) => Block[] | Error) {
  const calls: Array<{ model: string; tool_choice?: { name?: string }; messages: unknown[]; system?: unknown }> = [];
  return {
    calls,
    client: {
      messages: {
        create: async (p: { model: string; tool_choice?: { name?: string }; messages: unknown[] }) => {
          calls.push(p);
          const r = reply(p);
          if (r instanceof Error) throw r;
          return { id: "m", type: "message", role: "assistant", model: "fake", content: r, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as never,
  };
}

test("askQuestions: one cheap call, questions fitted; junk or an error is none, with fallback", async () => {
  const ok = fakeClient(() => [{ type: "tool_use", id: "t", name: "team_questions", input: { questions: GOOD } }]);
  const r = await askQuestions("When I save a gift idea, find a good price", { job: "Finds good prices", instructions: "Trusted shops" }, { client: ok.client });
  assert.equal(r.questions.length, 3);
  assert.equal(r.fallback, undefined);
  assert.equal(ok.calls[0].tool_choice?.name, "team_questions");
  assert.match(ok.calls[0].model, /haiku/, "the cheap model");
  assert.match(JSON.stringify(ok.calls[0].messages), /<draft>/);
  // Setup questions come from the assistant itself: "Which shops should I check first?".
  assert.match(String(ok.calls[0].system), /first person/);
  assert.match(String(ok.calls[0].system), /Which shops should I check first\?/);

  const junk = fakeClient(() => [{ type: "tool_use", id: "t", name: "team_questions", input: { questions: [GOOD[0]] } }]);
  assert.deepEqual(await askQuestions("Sum up my week", null, { client: junk.client }), { questions: [], fallback: true });
  const broken = fakeClient(() => new Error("overloaded"));
  assert.deepEqual(await askQuestions("Sum up my week", null, { client: broken.client }), { questions: [], fallback: true });
});

test("askQuestions without a model key gives none at once", async () => {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map((k) => [k, process.env[k]] as const);
  for (const [k] of keys) delete process.env[k];
  try {
    assert.deepEqual(await askQuestions("Sum up my week"), { questions: [], fallback: true });
  } finally {
    for (const [k, v] of keys) if (v !== undefined) process.env[k] = v;
  }
});

test("writeSkill: the model's skill when it holds up, the plain one when it doesn't", async () => {
  const ok = fakeClient(() => [{ type: "tool_use", id: "t", name: "assistant_skill", input: { body: "# How Penny works\n\n1. Check Waterstones and Smyths first.\n2. Keep each gift under £50.\n3. Say so only when a price drops by £5 or more.", summary: "Checks Waterstones and Smyths first and keeps each gift under £50." } }]);
  const s = await writeSkill(PENNY, ANSWERS, { client: ok.client });
  assert.equal(s.summary, "Checks Waterstones and Smyths first and keeps each gift under £50.");
  assert.match(s.body, /£5 or more/);
  assert.match(JSON.stringify(ok.calls[0].messages), /Waterstones and Smyths/, "the answers go to the model");
  const thin = fakeClient(() => [{ type: "tool_use", id: "t", name: "assistant_skill", input: { body: "ok" } }]);
  assert.deepEqual(await writeSkill(PENNY, ANSWERS, { client: thin.client }), templateSkill(PENNY, ANSWERS));
  const broken = fakeClient(() => new Error("down"));
  assert.deepEqual(await writeSkill(PENNY, [], { client: broken.client }), templateSkill(PENNY, []));
});

test("POST /api/team/questions: empty or long text is a 400; no model means no questions", async () => {
  const { handleTeamRoutes } = await import("../netlify/lib/team-routes");
  const call = async (body: unknown) => {
    const u = new URL("https://x/api/team/questions");
    const res = await handleTeamRoutes(new Request(u, { method: "POST" }), u, ["team", "questions"], async () => body as Record<string, unknown>, (d, s = 200) => Response.json(d, { status: s }));
    return { status: res!.status, body: await res!.json() };
  };
  assert.equal((await call({ text: "  " })).status, 400);
  assert.equal((await call({ text: "x".repeat(1001) })).status, 400);
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map((k) => [k, process.env[k]] as const);
  for (const [k] of keys) delete process.env[k];
  try {
    assert.deepEqual(await call({ text: "Sum up my week", draft: { job: "Sums up the week" } }), { status: 200, body: { questions: [], fallback: true } });
  } finally {
    for (const [k, v] of keys) if (v !== undefined) process.env[k] = v;
  }
});

test("setup questions are in the assistant's own voice", () => {
  assert.equal(firstPerson("Which shops should the assistant check first?"), "Which shops should I check first?");
  assert.equal(firstPerson("Does the assistant need a budget?"), "Do I need a budget?");
  assert.equal(firstPerson("How often should your assistant tell you?"), "How often should I tell you?");
  assert.equal(firstPerson("Which shops do you trust?"), "Which shops do you trust?");
  // The owner's own "I": left as written rather than turned into "tell me".
  assert.equal(firstPerson("What should I tell the assistant to skip?"), "What should I tell the assistant to skip?");
  const [q] = fitQuestions([{ question: "Which shops should the assistant check first?", choices: ["Any", "Local"] }, GOOD[1]]);
  assert.equal(q.question, "Which shops should I check first?");
});
