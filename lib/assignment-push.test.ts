// The push when an assignment stops for the owner (lib/assignment-push.ts): one per stop, none in quiet hours,
// none when suggestions are taken, and it opens Team chat at the post.
// Run: npx tsx --test lib/assignment-push.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { STOP_COPY, stopNudge, stopsToPush } from "./assignment-push";
import type { PostKind, PostWaits, TeamPost } from "./assignment-types";
import type { GateState } from "./proactive/gate";
import { DEFAULT_PROACTIVE } from "./proactive/gate";
import { avatarFromSeed } from "./team-seed";

const NOW = "2026-11-17T14:00:00Z"; // London is on GMT.
const who = { id: "11111111-1111-4111-8111-111111111111", name: "Wren", avatar: avatarFromSeed("wren"), job: "", role: null, guest: true };
const post = (id: number, kind: PostKind, waits_for: PostWaits | null, over: Partial<TeamPost> = {}) =>
  ({ id, kind, who, assignment_id: "22222222-2222-4222-8222-222222222222", assignment_title: "Pricing page", waits_for, settled_at: null, created_at: "2026-11-17T13:59:00Z", ...over }) as TeamPost;
const state = (over: Partial<GateState> = {}): GateState => ({
  now: new Date(NOW),
  tz: "Europe/London",
  prefs: DEFAULT_PROACTIVE,
  working: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  quiet: null,
  mutes: new Map(),
  madeToday: 0,
  seen: new Set(),
  ...over,
});

test("each kind of stop is one push from that assistant, opening Team chat at its post", () => {
  const stops = [post(1, "question", "answer"), post(2, "approval", "approval"), post(3, "plan", "go"), post(4, "failed", "dismiss"), post(5, "done", null)];
  // Five in a day is past the usual cap of 4, which these share with every nudge (checked below).
  const { pass, held } = stopsToPush(stops, state({ prefs: { ...DEFAULT_PROACTIVE, cap: 8 } }));
  assert.equal(held.length, 0);
  assert.deepEqual(pass.map((n) => [n.rule, n.title, n.url, n.key]), stops.map((p) => ["team", "From Wren", `/#/team/chat/${p.id}`, `team:post:${p.id}`]));
  assert.deepEqual(pass.map((n) => n.body), [
    "I need your answer on “Pricing page” before I go on.",
    "My stage of “Pricing page” is done. Have a look, then tap Approve.",
    "I have a change for “Pricing page” that waits for your approval.",
    "I didn't finish my stage of “Pricing page”. Tap Go to try it again.",
    "“Pricing page” is finished. The document is ready.",
  ]);
  assert.deepEqual(Object.keys(STOP_COPY), ["question", "approval", "plan", "failed", "done"]);
});

test("one per stop: the same wait seen again sends nothing more", () => {
  const q = post(7, "question", "answer");
  // Twice in one pass (Team chat hands back the post that already waits), and again on a later pass.
  assert.equal(stopsToPush([q, q], state()).pass.length, 1);
  const later = stopsToPush([q], state({ seen: new Set(["team:post:7"]) }));
  assert.deepEqual([later.pass.length, later.held.map((h) => h.reason)], [0, ["seen"]]);
});

test("none in quiet hours, and none when the owner has Team's notifications off or muted", () => {
  const q = [post(8, "approval", "approval")];
  assert.deepEqual(stopsToPush(q, state({ quiet: { from: "13:00", to: "15:00" } })).held.map((h) => h.reason), ["quiet"]);
  assert.deepEqual(stopsToPush(q, state({ now: new Date("2026-11-17T03:00:00Z"), quiet: null })).held.map((h) => h.reason), ["quiet"], "the night, with no quiet hours set");
  assert.deepEqual(stopsToPush(q, state({ prefs: { ...DEFAULT_PROACTIVE, rules: { ...DEFAULT_PROACTIVE.rules, team: false } } })).held.map((h) => h.reason), ["off"]);
  assert.deepEqual(stopsToPush(q, state({ mutes: new Map([["team", "2026-12-01T00:00:00Z"]]) })).held.map((h) => h.reason), ["muted"]);
  assert.deepEqual(stopsToPush(q, state({ madeToday: DEFAULT_PROACTIVE.cap })).held.map((h) => h.reason), ["cap"]);
});

test("none when suggestions are taken, for a wait already settled, or for a post outside an assignment", () => {
  // Suggestions taken: the stage posts an update ("I went with my own suggestion") and no question.
  assert.equal(stopNudge(post(9, "update", null)), null);
  assert.equal(stopNudge(post(10, "handoff", null)), null);
  assert.equal(stopNudge(post(11, "question", "answer", { settled_at: NOW })), null);
  assert.equal(stopNudge(post(12, "failed", "dismiss", { assignment_id: null })), null, "an ordinary run's failure has its own card");
  assert.equal(stopsToPush([post(9, "update", null), post(11, "question", "answer", { settled_at: NOW })], state()).pass.length, 0);
});
