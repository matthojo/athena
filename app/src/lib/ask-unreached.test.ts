// A follow-up whose reply couldn't be had (after a brownie answer, "Turn this into a recipe" once came back as a
// keyword search for "recipe" and "turn"). What the chat shows in its place, what's sent when it's
// asked again, and when it asks again by itself.
// Run: npx tsx --test app/src/lib/ask-unreached.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_RETRY_MS, FALLBACK_NOTE, UNREACHED_NOTE, UNREACHED_RETRYING, afterFailure, isFallback, takeOfflineFallbacks } from "./ask-fallback";
import { answerHistory } from "./ask-history";
import { BUSY_WAITS_MS, withRetry } from "./ask-retry";

const refused = Object.assign(new Error("Forbidden"), { status: 403 });
const busy = Object.assign(new Error("Too many requests"), { status: 429 });
const down = Object.assign(new Error("Bad gateway"), { status: 500 });
const dropped = new TypeError("Failed to fetch");

const BROWNIES = "**Fudgy brownies** take about 45 minutes.\n\n- 200 g dark chocolate\n- 3 eggs\n\n1. Melt the chocolate.\n2. Bake for 25 minutes.";
const chat = [
  { role: "me", text: "How do I make brownies?" },
  { role: "answer", reply: { text: BROWNIES, sources: [], general: true } },
];

test("the unreachable follow-up: no keyword search, the message kept, one retry by itself, then Try again", async () => {
  // "Turn this into a recipe" goes with the conversation before it.
  const history = answerHistory(chat);
  assert.equal(history.length, 2);
  assert.equal(history[1].text, BROWNIES, "the reply before it, whole");

  // Every try fails (the app's own retries included): a refusal isn't asked again by withRetry, a busy gateway is, twice.
  let tries = 0;
  await assert.rejects(withRetry(async () => { tries++; throw refused; }, { online: () => true, wait: async () => undefined }));
  assert.equal(tries, 1);
  tries = 0;
  await assert.rejects(withRetry(async () => { tries++; throw busy; }, { online: () => true, wait: async () => undefined }));
  assert.equal(tries, 1 + BUSY_WAITS_MS.length);

  // In the reply's place: a line saying Athena's AI couldn't be reached. Never a search of "recipe" and "turn".
  for (const error of [refused, down, dropped]) {
    const first = afterFailure(error, { online: true, earlierTurns: history.length, alreadyTried: false });
    assert.equal(first.show, "unreached");
    assert.deepEqual(first, { show: "unreached", cause: "failed", note: UNREACHED_RETRYING, retryInMs: AUTO_RETRY_MS }, "it asks again by itself, once");
    const second = afterFailure(error, { online: true, earlierTurns: history.length, alreadyTried: true });
    assert.deepEqual(second, { show: "unreached", cause: "failed", note: UNREACHED_NOTE.failed, retryInMs: null }, "then it's Try again's to do");
  }
  assert.match(UNREACHED_NOTE.failed, /^Athena's AI couldn't be reached/);
  assert.match(UNREACHED_NOTE.failed, /Your message is kept\.$/);
  assert.doesNotMatch(Object.values(UNREACHED_NOTE).join(" ") + UNREACHED_RETRYING, /keyword/i);

  // Asked again (by itself or by Try again), it carries the same conversation: the failed turn left nothing behind to confuse it.
  const after = [...chat, { role: "me", text: "Turn this into a recipe" }, { role: "answer", reply: null, fallback: { terms: [], notes: [], others: [] }, unreached: "failed" }];
  assert.deepEqual(answerHistory(after.slice(0, 2)), history);
  assert.deepEqual(answerHistory(after), history, "the unanswered follow-up isn't sent as history: it's the message being asked");
});

test("busy says busy, and retries once more by itself", () => {
  const first = afterFailure(busy, { online: true, earlierTurns: 2, alreadyTried: false });
  assert.deepEqual([first.show, first.show === "unreached" && first.cause, first.show === "unreached" && first.retryInMs], ["unreached", "busy", AUTO_RETRY_MS]);
  const second = afterFailure(busy, { online: true, earlierTurns: 2, alreadyTried: true });
  assert.equal(second.note, UNREACHED_NOTE.busy);
});

test("offline, a missing setup and a sign-in aren't retried on a timer", () => {
  const offline = afterFailure(dropped, { online: false, earlierTurns: 2, alreadyTried: false });
  assert.deepEqual(offline, { show: "unreached", cause: "offline", note: UNREACHED_NOTE.offline, retryInMs: null });
  for (const status of [503, 401]) {
    const r = afterFailure(Object.assign(new Error("x"), { status }), { online: true, earlierTurns: 2, alreadyTried: false });
    assert.equal(r.show === "unreached" && r.retryInMs, null, String(status));
  }
  // Offline is asked again when the connection returns, once, like a keyword search shown for want of one.
  const m = { role: "answer", fallback: { terms: [] }, reply: null, offline: true, unreached: "offline" as const };
  assert.equal(isFallback(m), true);
  assert.deepEqual(takeOfflineFallbacks([m], { open: true, online: true, busy: false }), [m]);
  assert.deepEqual(takeOfflineFallbacks([m], { open: true, online: true, busy: false }), [], "once");
});

test("a first message in a new chat keeps the keyword search", () => {
  for (const [error, cause] of [[refused, "failed"], [busy, "busy"], [down, "failed"]] as const) {
    assert.deepEqual(afterFailure(error, { online: true, earlierTurns: 0, alreadyTried: false }), { show: "keywords", note: FALLBACK_NOTE[cause] });
  }
  assert.deepEqual(afterFailure(dropped, { online: false, earlierTurns: 0, alreadyTried: false }), { show: "keywords", note: FALLBACK_NOTE.offline });
});
