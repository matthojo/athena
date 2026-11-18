// Run: npx tsx --test app/src/lib/team-report.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isQuiet, runWaits, jobsToday, saysNothing, jobsWords, liveRuns, ownWords, planWaits, reviewWords, splitReport, teamWorkingSentence, waitsWords, workingWords } from "./team-report";

test("A run's summary loses the runner's Go line, which becomes a count", () => {
  assert.deepEqual(splitReport("3 new issues: 2 to-dos added. One change waits for you to tap Go."), { said: "3 new issues: 2 to-dos added.", waits: 1 });
  assert.deepEqual(splitReport("Done. 4 changes wait for you to tap Go."), { said: "Done.", waits: 4 });
  assert.deepEqual(splitReport("Found the Lego Ferrari for £34."), { said: "Found the Lego Ferrari for £34.", waits: 0 });
  // The nudge's body is clipped at 180 characters: a cut-off Go line still counts.
  assert.deepEqual(splitReport("3 new issues. Two were already on your list. One change waits for…"), { said: "3 new issues. Two were already on your list.", waits: 1 });
  assert.deepEqual(splitReport("Done. 2 changes wait for you to…"), { said: "Done.", waits: 2 });
  // Only the runner's own last sentence: a reply that mentions Go keeps its words.
  assert.equal(splitReport("Tap Go when you're ready.").waits, 0);
});

test("The conversation says whether a plan still waits", () => {
  const plan = (ran?: object) => ({ role: "assistant", reply: { plan: { steps: [{}, {}], ...(ran ? { ran } : {}) } } });
  assert.equal(planWaits([{ role: "me" }, plan()]), 2);
  assert.equal(planWaits([{ role: "me" }, plan({ at: "x", results: [] })]), 0);
  assert.equal(planWaits([{ role: "me" }, { role: "assistant", reply: { text: "Hi" } }]), null);
  assert.equal(planWaits([]), null);
  // A Team run's written answer keeps its plan on the message itself (the real server's shape).
  assert.equal(planWaits([{ role: "me" }, { role: "answer", text: "…", plan: { steps: [{}] } }]), 1);
  assert.equal(planWaits([{ role: "me" }, { role: "answer", text: "…", plan: { steps: [{}], ran: { at: "x", results: [] } } }]), 0);
});

test("Waits and Review read naturally for one and many", () => {
  assert.equal(waitsWords(1), "1 change waits for you");
  assert.equal(waitsWords(3), "3 changes wait for you");
  assert.equal(reviewWords(1), "Review 1 change");
  assert.equal(reviewWords(2), "Review 2 changes");
});

test("Working words start with the name", () => {
  assert.equal(workingWords("Muse", { status: "running", step: "Checking prices…" }), "Muse is checking prices");
  assert.equal(workingWords("Wren", { status: "running", step: null }), "Wren is getting it done");
  assert.equal(workingWords("Dot", { status: "queued" }), "Dot is about to start");
  // A second try waits for the next pass: it says so, the same on every screen.
  assert.equal(workingWords("Dot", { status: "queued", retried: true }), "Dot will try again shortly");
  assert.equal(workingWords("Dot", { status: "running", step: "3 of 5 done" }), "Dot: 3 of 5 done");
});

test("Jobs today count finished runs since midnight, for that assistant only", () => {
  const now = new Date(2026, 10, 15, 18, 0);
  const at = (h: number, d = 15) => new Date(2026, 10, d, h, 0).toISOString();
  const runs = [
    { assistant_id: "a", status: "done" as const, started_at: at(9), finished_at: at(9) },
    { assistant_id: "a", status: "failed" as const, started_at: at(12), finished_at: at(12) },
    { assistant_id: "a", status: "running" as const, started_at: at(17), finished_at: null },
    { assistant_id: "a", status: "done" as const, started_at: at(20, 14), finished_at: at(20, 14) },
    { assistant_id: "b", status: "done" as const, started_at: at(10), finished_at: at(10) },
  ];
  assert.equal(jobsToday(runs, "a", now), 2);
  assert.equal(jobsWords(2), "2 runs today");
  assert.equal(jobsWords(1), null);
});

test("Live runs: each assistant's newest, newest first", () => {
  const r = (assistant_id: string, status: "queued" | "running" | "done", min: number) => ({ assistant_id, status, started_at: new Date(Date.UTC(2026, 10, 15, 12, min)).toISOString() });
  const live = liveRuns([r("a", "running", 1), r("a", "queued", 5), r("b", "done", 9), r("c", "running", 3)]);
  assert.deepEqual(live.map((x) => `${x.assistant_id}:${x.status}`), ["a:queued", "c:running"]);
});

test("One sentence for whoever is working", () => {
  assert.equal(teamWorkingSentence([]), null);
  assert.equal(teamWorkingSentence(["Muse"]), "Muse is working");
  assert.equal(teamWorkingSentence(["Muse", "Dot"]), "Muse and Dot are working");
  assert.equal(teamWorkingSentence(["Muse", "Dot", "Wren"]), "Muse, Dot and 1 other are working");
});

test("Its own words come from its last reply, in whole sentences", () => {
  const reply = (text: string) => ({ role: "assistant", reply: { text } });
  assert.equal(ownWords([{ role: "me", text: "3 new issues" }, reply("Added two to-dos [1]. One waits.")]), "Added two to-dos. One waits.");
  assert.equal(ownWords([reply("One. Two is longer. Three is longest of all.")], 22), "One. Two is longer.");
  assert.equal(ownWords([reply("a ".repeat(200))], 20)?.endsWith("…"), true);
  assert.equal(ownWords([{ role: "me", text: "hi" }]), null);
});

test("A run that found nothing to do stays off Home", () => {
  const run = (o: object) => ({ status: "done" as const, summary: "Found it.", ...o });
  assert.equal(isQuiet(run({ quiet: true })), true);
  // The server's word wins over the summary's.
  assert.equal(isQuiet(run({ quiet: false, summary: "Nothing new." })), false);
  // Older servers: only the words say it.
  assert.equal(isQuiet(run({ summary: "Nothing to do this time." })), true);
  assert.equal(isQuiet(run({ summary: "All quiet. Nothing needed doing." })), true);
  assert.equal(isQuiet(run({ summary: "No new issues today." })), true);
  assert.equal(isQuiet(run({ summary: "3 new issues." })), false);
  // A run still going, or one that failed, is never quiet.
  assert.equal(isQuiet({ status: "failed", summary: "Nothing to do.", quiet: true }), false);
  assert.equal(saysNothing("Nothing needed me this time."), true);
  assert.equal(saysNothing("Noted the price."), false);
  assert.equal(saysNothing(null), false);
});

test("Quiet runs aren't jobs", () => {
  const now = new Date("2026-11-15T15:00:00");
  const at = "2026-11-15T10:00:00";
  const r = (summary: string, quiet?: boolean) => ({ assistant_id: "a", status: "done" as const, started_at: at, finished_at: at, summary, ...(quiet === undefined ? {} : { quiet }) });
  assert.equal(jobsToday([r("Found it."), r("Nothing to do this time."), r("Done.", true)], "a", now), 1);
});

test("One count of what waits: the server's, the conversation's, the lower; else the words for a day", () => {
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  const done = { status: "done" as const, started_at: "2026-11-15T10:00:00Z", finished_at: "2026-11-15T10:01:00Z" };
  const open = [{ role: "me" }, { role: "answer", text: "…", plan: { steps: [{}, {}] } }];
  const gone = [{ role: "me" }, { role: "answer", text: "…", plan: { steps: [{}, {}], ran: { at: "x", results: [] } } }];
  // The server's count, on its own.
  assert.equal(runWaits({ ...done, waiting: 2 }, null, NOW), 2);
  assert.equal(runWaits({ ...done, waiting: 0, summary: "One change waits for you to tap Go." }, null, NOW), 0);
  // A Go on this device lowers it before the server has said so.
  assert.equal(runWaits({ ...done, waiting: 2 }, gone, NOW), 0);
  // A Go elsewhere: the server knows first, the conversation here hasn't caught up.
  assert.equal(runWaits({ ...done, waiting: 0 }, open, NOW), 0);
  // An older server: the conversation, else the summary's words for a day.
  assert.equal(runWaits(done, open, NOW), 2);
  assert.equal(runWaits({ ...done, summary: "Added a to-do. 3 changes wait for you to tap Go." }, null, NOW), 3);
  assert.equal(runWaits({ ...done, summary: "Setting that date waits for your Go." }, null, NOW), 1);
  assert.equal(runWaits({ ...done, summary: "One change waits for you to tap Go." }, null, NOW + 2 * 86_400_000), 0);
  // A conversation without a plan doesn't count either way.
  assert.equal(runWaits({ ...done, summary: "One change waits for you to tap Go." }, [{ role: "me" }], NOW), 1);
  // Only a finished run leaves anything.
  assert.equal(runWaits({ ...done, status: "running", waiting: 1 }, null, NOW), 0);
});
