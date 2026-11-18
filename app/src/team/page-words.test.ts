import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay, causeWords, clock, dayWords, deskFor, nextSlot, nextWords, nowWords, resultWords, teamLede, waitsForGo, type Desk } from "./page-words";
import type { TeamRun, TeamTrigger } from "../../../lib/team-types";

// Sunday 15 November 2026, 14:30 local.
const NOW = new Date(2026, 10, 15, 14, 30);
const iso = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();

function run(p: Partial<TeamRun> & Pick<TeamRun, "id">): TeamRun {
  return { assistant_id: "a", trigger_id: null, event_id: null, status: "done", thread_id: null, summary: null, error: null, started_at: iso(15, 9), finished_at: iso(15, 9, 1), ...p };
}

function trig(p: Partial<TeamTrigger>): TeamTrigger {
  return { id: "t1", assistant_id: "a", kind: "schedule", days: [], time: "09:00", event: null, paused: false, last_slot: null, last_fired_at: null, created_at: iso(1, 9), ...p };
}

const who = (p: { paused?: boolean; triggers?: TeamTrigger[] } = {}) => ({ id: "a", paused: p.paused ?? false, triggers: p.triggers ?? [] });

test("a desk is working, then waiting to start, from its live runs", () => {
  const live = run({ id: "1", status: "running", finished_at: null, step: "Checking prices" });
  assert.equal(deskFor(who(), [live, run({ id: "0" })], NOW).state, "working");
  assert.equal(deskFor(who(), [run({ id: "2", status: "queued", finished_at: null })], NOW).state, "queued");
  // Working beats paused: Run now still runs a paused assistant.
  assert.equal(deskFor(who({ paused: true }), [live], NOW).state, "working");
});

test("a desk's last run decides failed, waiting and idle", () => {
  assert.equal(deskFor(who(), [run({ id: "1", status: "failed", error: "Linear didn't answer" })], NOW).state, "failed");
  // A run skipped because it was paused isn't a failure worth showing.
  assert.equal(deskFor(who(), [run({ id: "1", status: "failed", error: "Paused before it ran." }), run({ id: "0" })], NOW).state, "idle");
  const plan = run({ id: "2", summary: "Added a to-do. One change waits for you to tap Go." });
  assert.equal(deskFor(who(), [plan], NOW).state, "waiting");
  assert.equal(deskFor(who(), [plan], NOW, () => 0).state, "idle");
  // The server's count wins over the words, whatever the summary says, and has no day limit.
  assert.equal(deskFor(who(), [{ ...plan, waiting: 0 }], NOW).state, "idle");
  assert.equal(deskFor(who(), [run({ id: "3", summary: "Added a to-do.", waiting: 2 })], NOW).waits, 2);
  assert.equal(deskFor(who(), [{ ...plan, waiting: 1, finished_at: iso(13, 9) }], NOW).waits, 1);
  // A paused assistant's open plan still waits for you.
  const d = deskFor(who({ paused: true }), [plan], NOW);
  assert.equal(d.state, "paused");
  assert.equal(d.asks, true);
  // A day-old plan isn't assumed open when its conversation isn't known.
  assert.equal(deskFor(who(), [{ ...plan, finished_at: iso(13, 9) }], NOW).asks, false);
});

test("today's runs are the finished ones from today", () => {
  const d = deskFor(who(), [run({ id: "1" }), run({ id: "2", started_at: iso(14, 18), finished_at: iso(14, 18, 2) }), run({ id: "3", assistant_id: "b" })], NOW);
  assert.deepEqual(d.today.map((r) => r.id), ["1"]);
  assert.equal(d.last?.id, "1");
});

test("what it's doing degrades well without a step or a label", () => {
  assert.equal(nowWords({ status: "running", step: "Checking prices…" }), "Checking prices");
  assert.equal(nowWords({ status: "running", step: null }), "Getting it done");
  assert.equal(nowWords({ status: "queued" }), "About to start");
  assert.equal(nowWords({ status: "queued", retried: true }), "Trying again shortly");
  const a = { triggers: [trig({ id: "t1", days: [5], time: "17:00" })] };
  assert.equal(causeWords({ label: "Run now", trigger_id: null, event_id: null }, a), "Run now");
  assert.match(causeWords({ trigger_id: "t1", event_id: null }, a) ?? "", /^Every Friday at /);
  assert.equal(causeWords({ trigger_id: null, event_id: null }, a), null);
});

test("results read as sentences", () => {
  assert.equal(resultWords({ status: "done", summary: null, error: null }), "Done.");
  assert.equal(resultWords({ status: "failed", summary: null, error: "Linear didn't answer." }), "Didn't finish: Linear didn't answer.");
  assert.equal(resultWords({ status: "failed", summary: null, error: null }), "Didn't finish.");
  assert.equal(waitsForGo({ status: "done", summary: "Setting that date waits for your Go." }), true);
  assert.equal(waitsForGo({ status: "done", summary: "Added two to-dos." }), false);
});

test("days and times", () => {
  assert.equal(clock(iso(15, 8, 5), false), "8:05");
  assert.equal(clock(iso(15, 17, 0), true), "5:00 pm");
  assert.equal(dayWords(iso(15, 8), NOW), "Today");
  assert.equal(dayWords(iso(14, 8), NOW), "Yesterday");
  assert.equal(dayWords(iso(13, 17), NOW), "Friday");
  assert.equal(dayWords(iso(3, 17), NOW), "3 Nov");
});

test("what it waits for: the event, the next slot, or you", () => {
  const ev = trig({ kind: "event", days: [], time: null, event: { source: "saved", savedAction: "gift-idea" } });
  assert.equal(nextWords(who({ triggers: [ev] }), NOW), "Runs when you save a gift idea");
  const fri = trig({ days: [5], time: "17:00" });
  assert.equal(nextSlot({ triggers: [fri] }, NOW)?.getDate(), 20);
  assert.equal(nextWords(who({ triggers: [fri] }), NOW, false), "Next run Friday at 17:00");
  assert.equal(nextWords(who({ triggers: [trig({ days: [], time: "18:00" })] }), NOW, false), "Next run today at 18:00");
  assert.equal(nextWords(who({ triggers: [trig({ days: [], time: "08:00" })] }), NOW, false), "Next run tomorrow at 8:00");
  assert.equal(nextWords(who(), NOW), "Runs when you ask");
  assert.match(nextWords(who({ paused: true, triggers: [ev] }), NOW), /^Paused/);
});

test("the page's one sentence", () => {
  const team = [
    { id: "m", name: "Muse", paused: false },
    { id: "d", name: "Dot", paused: false },
    { id: "w", name: "Wren", paused: false },
  ];
  const desk = (state: Desk["state"], today = 0, asks = false): Desk => ({ state, live: null, last: null, today: Array.from({ length: today }, (_, i) => run({ id: String(i) })), asks, waits: asks ? 1 : 0, dismissed: false });
  const lede = (m: Desk, d: Desk, w: Desk) => teamLede(team, new Map([["m", m], ["d", d], ["w", w]]));
  assert.equal(lede(desk("working"), desk("waiting", 0, true), desk("idle")), "Muse is working. Dot needs your Go.");
  assert.equal(lede(desk("working"), desk("queued"), desk("failed")), "Muse and Dot are working. Wren couldn't finish a run.");
  assert.equal(lede(desk("idle", 2), desk("idle", 1), desk("idle")), "All quiet. Your team has run 3 times today.");
  assert.equal(lede(desk("idle", 1), desk("idle"), desk("idle")), "All quiet. Your team has run once today.");
  assert.equal(lede(desk("idle"), desk("idle"), desk("idle")), "All quiet so far today.");
  assert.equal(teamLede(team.map((a) => ({ ...a, paused: true })), new Map(team.map((a) => [a.id, desk("paused")]))), "Everyone is paused.");
});

test("runs group by day, live ones under Today", () => {
  const groups = byDay([run({ id: "l", status: "running", started_at: iso(14, 23, 59), finished_at: null }), run({ id: "1" }), run({ id: "2", started_at: iso(14, 9), finished_at: iso(14, 9, 1) })], NOW);
  assert.deepEqual(groups.map(([k, rs]) => [k, rs.map((r) => r.id)]), [["Today", ["l", "1"]], ["Yesterday", ["2"]]]);
  // The assistant's page uses the same headings (owner, 16 Nov 2026): a weekday this week, a date before.
  const older = byDay([run({ id: "3", started_at: iso(12, 9), finished_at: iso(12, 9, 1) }), run({ id: "4", started_at: iso(3, 9), finished_at: iso(3, 9, 1) })], NOW);
  assert.deepEqual(older.map(([k]) => k), [dayWords(iso(12, 9), NOW), "3 Nov"]);
  assert.match(older[0][0], /^[A-Z][a-z]+day$/);
});

test("a dismissed failure leaves Waiting for you but stays the last run", () => {
  const failed = run({ id: "1", status: "failed", error: "Linear didn't answer" });
  const d = deskFor(who(), [failed], NOW, undefined, (r) => r.id === "1");
  assert.equal(d.state, "idle");
  assert.equal(d.dismissed, true);
  assert.equal(d.last?.id, "1");
  // A newer failure is a new run, so it shows again.
  const again = run({ id: "2", status: "failed", started_at: iso(15, 12), finished_at: iso(15, 12, 1) });
  assert.equal(deskFor(who(), [again, failed], NOW, undefined, (r) => r.id === "1").state, "failed");
  // The lede drops it too.
  const team = [{ id: "a", name: "Dot", paused: false }];
  assert.equal(teamLede(team, new Map([["a", d]])), "All quiet. Your team has run once today.");
});
