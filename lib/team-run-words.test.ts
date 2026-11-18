// What a Team run says about itself (lib/team-run.ts, "the voice"): only what happened, in the assistant's own
// tone and pronoun. The summary, the card, the step and the failure line.
// Run: npx tsx --test lib/team-run-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { didPhrase, failCard, failCode, failLine, honestText, memoryStep, runLabel, runWords, sentences, startStep, stepWriter, teamNudge, waitsLine, type Voice } from "./team-run";
import { RateLimited } from "./ai";
import { avatarFromSeed } from "./team-seed";
import { TONES, type TeamTrigger, type Tone } from "./team-types";

const todo = { kind: "commitment", action: "created" } as const;
const muse: Voice = { name: "Muse", personality: { tone: "warm", pronoun: "she" } };
const dot: Voice = { name: "Dot", personality: { tone: "crisp", pronoun: "they" } };
const fig: Voice = { name: "Fig", personality: { tone: "wry", pronoun: "he" } };
const as = (tone: Tone): Voice => ({ name: "Ada", personality: { tone, pronoun: "she" } });

test("sentences: split at sentence ends, citation markers stay with theirs", () => {
  assert.deepEqual(sentences("Found it [1]. It's £34. Want it?"), ["Found it [1].", "It's £34.", "Want it?"]);
  assert.deepEqual(sentences("£8 under. “Quoted” next."), ["£8 under.", "“Quoted” next."]);
});

test("honestText: a change the record doesn't hold is taken out; the rest stays", () => {
  // Fig said the queued to-do was added. Nothing was: it waits for Go.
  assert.equal(honestText("Added a to-do to chase Priya about the Q3 review. Your week: 6 to-dos done, the Q3 review still slipping.", []), "Your week: 6 to-dos done, the Q3 review still slipping.");
  // "when you saved it" is the owner's doing, not a claim.
  const muse = "Found the Lego Technic Ferrari Daytona for £34 at Smyths, £8 under the price when you saved it. You bought from them last Christmas, so I'd get it there.";
  assert.equal(honestText(muse, []), muse);
  // Backed by the record, kept; more than the record holds, taken out.
  assert.equal(honestText("Added 2 to-dos from the new issues.", [todo, todo]), "Added 2 to-dos from the new issues.");
  assert.equal(honestText("Added 3 to-dos. The rest were done already.", [todo, todo]), "The rest were done already.");
  assert.equal(honestText("2 to-dos added.", [todo, todo]), "2 to-dos added.");
  assert.equal(honestText("2 to-dos added.", []), "");
  assert.equal(honestText("I've saved the recipe.", []), "");
  assert.equal(honestText("It was updated.", [todo]), "", "updated, but only something added");
  assert.equal(honestText("I ticked off the dentist.", [{ kind: "commitment", action: "completed" }]), "I ticked off the dentist.");
  // The world changing isn't the run changing anything.
  for (const s of ["Saved you £8 against Amazon.", "The price was updated this morning.", "Prices changed overnight.", "3 prices changed since Friday.", "Your week: 6 to-dos done."]) assert.equal(honestText(s, []), s, s);
  assert.equal(honestText("Both were added.", []), "");
  // Not claims: what waits for Go, a negation, something it might do, a question.
  for (const s of ["A to-do to chase Priya waits for your Go.", "Nothing changed.", "I didn't add anything.", "I'd add it to your list.", "Want me to add it?", "Shall I add a to-do?"]) assert.equal(honestText(s, []), s, s);
});

test("runWords: the three runs of the review, after", () => {
  // Muse (warm): a find, nothing changed. Her reply is the card.
  const m = runWords(muse, { text: "Found the Lego Technic Ferrari Daytona for £34 at Smyths, £8 under the price when you saved it [1]. You bought from them last Christmas, so I'd get it there.", changes: [], planned: 0 });
  assert.equal(m.summary, "Found the Lego Technic Ferrari Daytona for £34 at Smyths, £8 under the price when you saved it. You bought from them last Christmas, so I'd get it there.");
  assert.equal(m.quiet, false);
  assert.match(m.text, /\[1\]/, "the conversation keeps its citation");
  // Dot (crisp): 3 issues, 2 to-dos. Said once, not "3 new issues: 2 to-dos added. Added 2 to-dos…".
  const d = runWords(dot, { text: "Added 2 to-dos from the new issues. The third, the onboarding copy, is already on your list.", changes: [todo, todo], planned: 0, lead: "3 new issues" });
  assert.equal(d.summary, "Added 2 to-dos from the new issues. The third, the onboarding copy, is already on your list.");
  // Fig (wry): the false claim goes, and what waits is said in his voice.
  const f = runWords(fig, { text: "Added a to-do to chase Priya about the Q3 review. Your week: 6 to-dos done, the Q3 review still slipping.", changes: [], planned: 1 });
  assert.equal(f.summary, "Your week: 6 to-dos done, the Q3 review still slipping. One change is ready. It won't happen until you tap Go.");
  // The conversation keeps the honest reply; its plan card, right under it, says what waits.
  assert.equal(f.text, "Your week: 6 to-dos done, the Q3 review still slipping.");
  assert.equal(f.quiet, false);
});

test("runWords: a run with nothing to do is quiet, in its own words when it said any", () => {
  const q = runWords(dot, { text: "Nothing new: the onboarding copy issue is already a to-do.", found: false, changes: [], planned: 0 });
  assert.equal(q.quiet, true);
  assert.equal(q.summary, "Nothing new: the onboarding copy issue is already a to-do.");
  assert.equal(runWords(dot, { text: "", changes: [], planned: 0 }).summary, "Nothing to do.");
  assert.equal(runWords(fig, { text: "", changes: [], planned: 0 }).summary, "Nothing needed me this time.");
  // Something found isn't quiet; something waiting never is.
  assert.equal(runWords(muse, { text: "It's down to £30.", found: true, changes: [], planned: 0 }).quiet, false);
  assert.equal(runWords(muse, { text: "Nothing else to add.", found: false, changes: [], planned: 1 }).quiet, false);
  // Ask's own "nothing found" is Athena's sentence: the assistant says it its way.
  assert.equal(runWords(fig, { text: "I couldn't find anything about that.", found: false, changes: [], planned: 0 }).summary, "Nothing needed me this time.");
  assert.equal(runWords(muse, { text: "Here's what I'd change. Nothing happens until you tap Go.", changes: [], planned: 2 }).summary, "2 changes are ready for you. Tap Go when you're happy.");
  // Only false claims, nothing done: quiet, never the claim.
  const lied = runWords(muse, { text: "Added it to your list.", changes: [], planned: 0 });
  assert.equal(lied.quiet, true);
  assert.equal(lied.summary, "Nothing needed doing this time.");
});

test("runWords: with no reply, a line from the record in each tone", () => {
  const two = [todo, todo];
  const lines = Object.fromEntries(TONES.map((t) => [t, runWords(as(t), { text: "", changes: two, planned: 0, lead: "3 new issues" }).summary]));
  assert.deepEqual(lines, {
    warm: "I've added 2 to-dos from the 3 new issues.",
    crisp: "3 new issues: 2 to-dos added.",
    playful: "Added 2 to-dos from the 3 new issues, all set.",
    calm: "I added 2 to-dos from the 3 new issues. Nothing else needs you.",
    wry: "Added 2 to-dos from the 3 new issues. Handled.",
  });
  assert.equal(runWords(as("calm"), { text: "", changes: two, planned: 1 }).summary, "I added 2 to-dos. One change is ready when you are: tap Go.");
  assert.equal(didPhrase([todo, { kind: "commitment", action: "completed" }, { kind: "note", action: "updated" }]), "added a to-do, ticked off a to-do and updated a note");
});

test("waitsLine: what waits for Go, in each tone, always naming Go", () => {
  for (const t of TONES) for (const n of [1, 3]) assert.match(waitsLine(as(t), n), /\bGo\b/, `${t} ${n}`);
  assert.equal(waitsLine(muse, 1), "One change is ready for you. Tap Go when you're happy.");
  assert.equal(waitsLine(dot, 3), "3 changes wait for Go.");
  assert.equal(waitsLine(fig, 3), "3 changes are ready. None happen until you tap Go.");
});

test("startStep and memoryStep: what a run is doing first and last", () => {
  const issues = [1, 2, 3].map((i) => ({ kind: "collected" as const, facets: { kind: "issue", title: `Bug ${i}` } }));
  assert.equal(startStep(muse, issues), "Reading your 3 new issues");
  assert.equal(startStep(dot, issues), "Reading 3 new issues");
  assert.equal(startStep(muse, [{ kind: "saved", facets: { savedAction: "gift_idea", title: "Lego Technic Ferrari Daytona with a very long name indeed" } }]), "Looking at “Lego Technic Ferrari Daytona with a…”");
  assert.equal(startStep(fig, []), "Getting to it");
  assert.equal(startStep(dot, []), "Starting");
  assert.equal(memoryStep(muse), "Making a note for next time");
  assert.equal(memoryStep(dot), "Saving notes for next time");
});

test("runLabel: what set a run off", () => {
  assert.equal(runLabel({ kind: "schedule", days: [5], time: "16:00" } as TeamTrigger, []), "Every Friday at 16:00");
  assert.equal(runLabel(null, [{ kind: "collected", facets: { kind: "issue", title: "Fix sync" } }]), "New issue: “Fix sync”");
});

test("stepWriter: each new line once, in order; flush waits for the last", async () => {
  const wrote: string[] = [];
  const w = stepWriter("r1", async (_id, step) => {
    await new Promise((r) => setTimeout(r, 5));
    wrote.push(step!);
  });
  for (const t of ["Reading 3 new issues", "Reading 3 new issues", "Looking at your to-dos", " Adding a to-do ", "", "Adding a to-do"]) w.push(t);
  await w.flush();
  assert.deepEqual(wrote, ["Reading 3 new issues", "Looking at your to-dos", "Adding a to-do"]);
  // A failed write doesn't stop the run or the next one.
  const w2 = stepWriter("r2", async (_id, step) => {
    if (step === "bad") throw new Error("db down");
    wrote.push(step!);
  });
  w2.push("bad");
  w2.push("good");
  await w2.flush();
  assert.equal(wrote.at(-1), "good");
});

test("failures: the cause, in words the owner reads, and what to do", () => {
  assert.equal(failCode(new RateLimited()), "busy");
  assert.equal(failCode(new Error('529 {"type":"error","error":{"type":"api_error","message":"Overloaded"}}')), "busy");
  assert.equal(failCode(new Error("took too long")), "time");
  assert.equal(failCode(new Error("background function answered 404")), "start");
  assert.equal(failCode(new Error("It stopped before it finished.")), "stopped");
  assert.equal(failCode(new Error("pg: relation missing")), "other");
  // The lines it writes read back as the same cause.
  for (const c of ["busy", "time", "start", "stopped", "other", "paused", "gone"] as const) assert.equal(failCode(failLine(c)), c, c);
  assert.equal(failLine("busy"), "Athena's AI was busy. Try Run now in a few minutes.");
  assert.equal(failLine("busy", { events: 3, name: "Dot" }), "Athena's AI was busy. Ask Dot about them in a chat.");
  assert.equal(failLine("stopped"), "The run stopped partway. Anything it changed is in What Ask did. Try Run now.");
  assert.equal(failLine("start", { events: 1, name: "Muse" }), "The run couldn't start. Ask Muse about it in a chat.");
  assert.doesNotMatch(failLine("other"), /[{}"]/, "never raw JSON");
  assert.equal(failCard(fig, "busy"), "Didn't get there this time. Athena's AI was busy. Ask me in a few minutes, or use Run now on my page.");
  assert.equal(failCard(muse, "busy", { events: 1, label: "New gift idea: “Lego”" }), "Sorry, I couldn't finish. Athena's AI was busy. Ask me about it and I'll pick it up.");
  assert.equal(failCard(dot, "stopped", { events: 3, label: "3 new issues" }), "Didn't finish. I stopped partway; anything I changed is in What Ask did. Ask me about the 3 new issues and I'll pick them up.");
  assert.equal(failCard(dot, "start"), "Didn't start. Ask me, or use Run now on my page.");
});

test("the card: its voice, its pronoun, and a Why from the record", () => {
  const avatar = avatarFromSeed("muse");
  const run = { id: "r1", thread_id: "t1", summary: "Found it for £34 at Smyths.", finished_at: "2026-11-12T10:00:00.000Z", started_at: "2026-11-12T09:59:00.000Z", status: "done" as const };
  const gift = { kind: "event" as const, days: [], time: null, event: { source: "saved" as const, savedAction: "gift_idea" } };
  const n = teamNudge({ id: "a1", name: "Muse", avatar, personality: muse.personality }, run, gift, { changed: 0, waiting: 0 });
  assert.equal(n.body, "Found it for £34 at Smyths.");
  assert.deepEqual(n.why, ["Muse runs when you file something as a gift idea.", "Muse didn't change anything."]);
  const d = teamNudge({ id: "a2", name: "Dot", avatar, personality: dot.personality }, run, null, { changed: 2, waiting: 0 });
  assert.deepEqual(d.why, ["You asked Dot to run.", "Dot made 2 changes you let them make alone."]);
  const f = teamNudge({ id: "a3", name: "Fig", avatar, personality: fig.personality }, run, { kind: "schedule", days: [5], time: "16:00", event: null }, { changed: 0, waiting: 1 });
  assert.deepEqual(f.why, ["Fig runs every Friday at 16:00.", "Anything he can't do alone waits for you to tap Go."]);
  // A failed run's card: from the assistant, plainly, with what to do; it says it won't retry.
  const failed = teamNudge({ id: "a3", name: "Fig", avatar, personality: fig.personality }, { ...run, thread_id: null, summary: null, status: "failed", error: failLine("busy") }, null);
  assert.equal(failed.body, "Didn't get there this time. Athena's AI was busy. Ask me in a few minutes, or use Run now on my page.");
  assert.equal(failed.why[1], "Fig won't try again on his own.");
  // After its second try (the first failed before anything ran), the card says so.
  const twice = teamNudge({ id: "a3", name: "Fig", avatar, personality: fig.personality }, { ...run, thread_id: null, summary: null, status: "failed", error: failLine("busy"), retried: true }, null);
  assert.equal(twice.why[1], "Fig tried twice and won't try again on his own.");
  assert.equal(failed.thread_id, undefined);
  // The card's body ends at a sentence when it can.
  const long = teamNudge({ id: "a1", name: "Muse", avatar }, { ...run, summary: `${"Found a good price for the thing you saved. ".repeat(5)}` }, null);
  assert.ok(long.body.length <= 180 && long.body.endsWith("."), long.body);
});
