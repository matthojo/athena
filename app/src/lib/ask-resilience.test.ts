// Run: npx tsx --test app/src/lib/ask-resilience.test.ts
// Ask keeps trying before it falls back, writes the answer in a keyword search's place, remembers the whole
// conversation, and draws lists and bold. A small DOM (linkedom) for what's drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "Node", "HTMLElement", "Element", "Text"]) g[k] ??= (window as unknown as Record<string, unknown>)[k];

const { BUSY_WAITS_MS, BUSY_STEP_ID, DROPPED_WAIT_MS, RETRY_AFTER_CAP_MS, busyStepText, retryAfterSeconds, retryKind, withRetry } = await import("./ask-retry");
const { FALLBACK_NOTE, WRITE_LABEL, fallbackCause, isFallback, takeOfflineFallbacks, writeButton } = await import("./ask-fallback");
const { answerHistory, answerRefs, assistantRefs } = await import("./ask-history");
const { boldSpans, draftRich, lastLine, plainText, richBlocks, richNodes, withoutCitations } = await import("./ask-rich");
const { generalNote, isGeneral, isGeneralNote, isWebSource, MAX_REFS, MAX_TURNS, siteName, sourceRef, sourcesOf } = await import("./ask-contract");
const { h } = await import("./dom");
type RetryWait = import("./ask-retry").RetryWait;
type AnswerReply = import("../../../lib/answer-text").AnswerReply;

const status = (n: number) => Object.assign(new Error(`HTTP ${n}`), { status: n });
const broken = () => Object.assign(new Error("The reply stopped part-way"), { name: "StreamBroken" });
const noWait = async () => undefined;

// ---------- retry, then fallback ----------

test("busy (429): two more tries with a visible step each, then the keyword search says why", async () => {
  const waits: RetryWait[] = [];
  let tries = 0;
  const failed = await withRetry(
    async () => {
      tries++;
      throw status(429);
    },
    { wait: noWait, onWait: (w) => waits.push(w) }
  ).catch((e: unknown) => e);
  assert.equal(tries, 3);
  assert.deepEqual(waits.map((w) => [w.kind, w.attempt, w.ms]), [["busy", 1, BUSY_WAITS_MS[0]], ["busy", 2, BUSY_WAITS_MS[1]]]);
  assert.deepEqual(waits.map(busyStepText), ["Athena's AI is busy. Trying again shortly", "Still busy. Trying once more"]);
  assert.equal(BUSY_STEP_ID, "ask-busy");
  // Then the fallback: a keyword search, and the reason.
  assert.equal(fallbackCause(failed, true), "busy");
  assert.equal(FALLBACK_NOTE.busy, "Athena's AI is still busy, so this is a keyword search.");
});

test("busy once, then the answer: nothing falls back", async () => {
  let tries = 0;
  const seen: string[] = [];
  const reply = await withRetry(
    async (tryNo) => {
      tries++;
      if (tryNo === 0) throw status(429);
      return "Elena wants two prices [1].";
    },
    { wait: noWait, onWait: (w) => seen.push(`wait ${w.attempt}`), onRetry: (w) => seen.push(`retry ${w.attempt}`) }
  );
  assert.equal(reply, "Elena wants two prices [1].");
  assert.equal(tries, 2);
  assert.deepEqual(seen, ["wait 1", "retry 1"]);
});

test("a broken stream, a 502 or 504, or a network error is asked again once", async () => {
  for (const make of [broken, () => status(502), () => status(504), () => new TypeError("Failed to fetch")]) {
    assert.equal(retryKind(make()), "dropped");
    let tries = 0;
    const lasts: unknown[] = [];
    const failed = await withRetry(
      async (_n, last) => {
        tries++;
        lasts.push(last);
        throw make();
      },
      { wait: async (ms) => assert.equal(ms, DROPPED_WAIT_MS) }
    ).catch((e: unknown) => e);
    assert.equal(tries, 2);
    // The second try is told what the first failed with (a broken stream is then asked the plain way).
    assert.equal(lasts[0], null);
    assert.equal(retryKind(lasts[1]), "dropped");
    assert.equal(fallbackCause(failed, true), "failed");
  }
  // Once is once: a drop, then the answer.
  let n = 0;
  assert.equal(await withRetry(async () => (n++ ? "ok" : Promise.reject(broken())), { wait: noWait }), "ok");
});

test("no retry for a refusal, a time-out, Stop, or with no connection", async () => {
  for (const error of [status(400), status(401), status(503), Object.assign(new Error("x"), { name: "TimeoutError" }), Object.assign(new Error("x"), { name: "AbortError" })]) {
    assert.equal(retryKind(error), null);
    let tries = 0;
    await withRetry(async () => (tries++, Promise.reject(error)), { wait: noWait }).catch(() => undefined);
    assert.equal(tries, 1);
  }
  // Offline: a network error isn't tried again; the fallback says offline, and waits for the connection.
  let tries = 0;
  const failed = await withRetry(async () => (tries++, Promise.reject(new TypeError("Failed to fetch"))), { wait: noWait, online: () => false }).catch((e: unknown) => e);
  assert.equal(tries, 1);
  assert.equal(fallbackCause(failed, false), "offline");
  assert.match(FALLBACK_NOTE.offline, /^You're offline, so this is a keyword search\./);
  // Stop during the wait ends it there.
  const stop = new AbortController();
  tries = 0;
  await withRetry(async () => (tries++, Promise.reject(status(429))), { signal: stop.signal, wait: async () => stop.abort() }).catch(() => undefined);
  assert.equal(tries, 1);
  // The connection goes during the wait: no further try.
  let up = true;
  tries = 0;
  await withRetry(async () => (tries++, Promise.reject(status(429))), { online: () => up, wait: async () => void (up = false) }).catch(() => undefined);
  assert.equal(tries, 1);
});

test("why it fell back: one sentence per cause", () => {
  assert.equal(fallbackCause(status(503), true), "setup");
  assert.equal(fallbackCause(status(401), true), "signin");
  assert.equal(fallbackCause(new Error("boom"), true), "failed");
  assert.equal(fallbackCause(status(429), false), "offline");
  for (const note of Object.values(FALLBACK_NOTE)) assert.match(note, /keyword search/);
});

// ---------- "Write the answer" ----------

test("a keyword search shown in place of an answer gets the button; one tap writes once", () => {
  const search = { role: "answer", fallback: { terms: ["pricing"] }, reply: null };
  assert.equal(isFallback(search), true);
  assert.equal(isFallback({ role: "answer", fallback: null, reply: { text: "Yes." } }), false);
  assert.equal(isFallback({ role: "answer", fallback: null, reply: null }), false);
  assert.equal(isFallback({ role: "athena", fallback: {} }), false);

  let wrote = 0;
  const b = writeButton(() => wrote++, h("span", { class: "icon" }));
  assert.equal(b.tagName, "BUTTON");
  assert.equal(b.getAttribute("type"), "button");
  assert.equal(b.textContent, WRITE_LABEL);
  assert.equal(WRITE_LABEL, "Write the answer");
  b.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click"));
  b.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("click"));
  assert.equal(wrote, 1);
  assert.equal(b.disabled, true);
});

// ---------- the reconnect re-run ----------

test("back online with the chat open: an offline fallback is written again, once", () => {
  const offline = { role: "answer", fallback: {}, reply: null, offline: true };
  const busy = { role: "answer", fallback: {}, reply: null, offline: false };
  const answered = { role: "answer", fallback: null, reply: {}, offline: true };
  const thread = [offline, busy, answered];
  const now = { open: true, online: true, busy: false };
  // Not while the chat is closed, still offline, or a reply is being written: its mark waits.
  assert.deepEqual(takeOfflineFallbacks(thread, { ...now, open: false }), []);
  assert.deepEqual(takeOfflineFallbacks(thread, { ...now, online: false }), []);
  assert.deepEqual(takeOfflineFallbacks(thread, { ...now, busy: true }), []);
  assert.equal(offline.offline, true);
  // The connection returns: only the one that fell back for want of it.
  assert.deepEqual(takeOfflineFallbacks(thread, now), [offline]);
  // Once: a second reconnect finds nothing, whatever became of the first run.
  assert.deepEqual(takeOfflineFallbacks(thread, now), []);
});

// ---------- history across mixed turns, with refs ----------

test("history covers written answers and assistant replies alike, across a keyword search", () => {
  const NOTE = "5a3e0000-0000-4000-8000-000000000001";
  const PRIYA = "5a3e0000-0000-4000-8000-000000000101";
  const thread = [
    { role: "me", text: "What did Elena say about pricing?" },
    {
      role: "answer",
      reply: {
        text: "Elena wants to test two prices [2].\n\n- **Starter** stays [1].\n- **Team** goes up [2][3].",
        sources: [
          { n: 1, kind: "note", id: NOTE, url: null },
          { n: 2, kind: "meeting", id: null, url: "https://notes.granola.ai/d/abc" },
          { n: 3, kind: "web", id: null, url: "https://example.com/pricing" },
        ],
      },
    },
    { role: "me", text: "Remind me to reply to her on Friday" },
    { role: "assistant", reply: { text: `Done. I've added it and linked [@Priya](athena://person/${PRIYA}).`, changes: [{ kind: "commitment", id: "c1" }] } },
    // A keyword search (offline): your question stays, the search isn't a turn.
    { role: "me", text: "And what about Marcus?" },
    { role: "answer", reply: null, fallback: { terms: ["marcus"] } },
    { role: "athena" },
    { role: "me", text: "Anything from last week?" },
    { role: "answer", reply: { text: "Nothing from last week.", sources: [] } },
  ];
  const turns = answerHistory(thread);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  // The written answer: its words without the numbers, its lines kept, and what it cited in the order cited.
  assert.equal(turns[1].text, "Elena wants to test two prices.\n\n- **Starter** stays.\n- **Team** goes up.");
  assert.deepEqual(turns[1].refs, ["https://notes.granola.ai/d/abc", `note:${NOTE}`, "https://example.com/pricing"]);
  // The assistant's reply: what it linked, then what it changed (a to-do by the name a ref uses).
  assert.deepEqual(turns[3].refs, [`person:${PRIYA}`, "todo:c1"]);
  // It doesn't stop at the keyword search: both questions around it are there, as one turn.
  assert.equal(turns[4].text, "And what about Marcus?\n\nAnything from last week?");
  assert.deepEqual(turns[5], { role: "assistant", text: "Nothing from last week.", refs: [] });
});

test("history: the latest 12 turns, starting with yours; refs capped at 8; nothing sent for a new chat", () => {
  const long = Array.from({ length: 10 }, (_, i) => [{ role: "me", text: `Question ${i}` }, i % 2 ? { role: "assistant", reply: { text: `Reply ${i}` } } : { role: "answer", reply: { text: `Answer ${i}`, sources: [] } }]).flat();
  const turns = answerHistory(long);
  assert.equal(turns.length, MAX_TURNS);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[0].text, "Question 4");
  assert.equal(turns.at(-1)?.text, "Reply 9");
  const many = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, kind: "note", id: `n${i + 1}` }));
  assert.equal(answerRefs({ text: "All of it [12][1].", sources: many }).length, MAX_REFS);
  assert.deepEqual(answerRefs({ text: "All of it [12][1].", sources: many }).slice(0, 3), ["note:n12", "note:n1", "note:n2"]);
  assert.deepEqual(assistantRefs({ text: "Nothing linked." }), []);
  assert.deepEqual(answerHistory([]), []);
  // A question with no reply yet isn't history: it's the one being asked.
  assert.deepEqual(answerHistory([{ role: "me", text: "Hello?" }]), []);
  // A reply with no words of its own isn't a turn.
  assert.deepEqual(answerHistory([{ role: "me", text: "Add milk" }, { role: "answer", reply: { text: "" } }]), []);
  // One history: a reply that answered and changed something carries what it cited, then what it changed.
  assert.deepEqual(
    answerHistory([
      { role: "me", text: "What did Gayle say about pricing, and add a to-do to follow up" },
      { role: "answer", reply: { text: "Up 8% in January [1]. I've added a to-do.", sources: [{ n: 1, kind: "note", id: "n1", url: null }], changes: [{ kind: "commitment", id: "c1" }] } },
    ]).at(-1),
    { role: "assistant", text: "Up 8% in January. I've added a to-do.", refs: ["note:n1", "todo:c1"] },
  );
});

// ---------- lists and bold, with citations ----------

const draw = (text: string, open = false) => {
  const cited: number[] = [];
  const nodes = richNodes(text, {
    cite: (n) => (n > 5 ? null : (cited.push(n), h("button", { class: "cite", type: "button" }, String(n)))),
    text: (t) => [document.createTextNode(t)],
    open,
  });
  const root = h("div", {}, ...nodes);
  return { nodes, root, cited };
};

test("paragraphs split by a blank line, a list per run of \"- \" lines", () => {
  assert.deepEqual(richBlocks("Two things:\n\n- One\n- Two\n  carries on\n\nAnd a\nlast line."), [
    { kind: "p", text: "Two things:" },
    { kind: "ul", items: ["One", "Two carries on"] },
    { kind: "p", text: "And a last line." },
  ]);
  // No blank line needed before a list; a bare paragraph is one block, as before.
  assert.deepEqual(richBlocks("Intro:\n- a\n- b"), [{ kind: "p", text: "Intro:" }, { kind: "ul", items: ["a", "b"] }]);
  assert.deepEqual(richBlocks("Just one paragraph [1]."), [{ kind: "p", text: "Just one paragraph [1]." }]);
  // A dash inside a sentence is not a list.
  assert.deepEqual(richBlocks("It's 5 - 3, not a list."), [{ kind: "p", text: "It's 5 - 3, not a list." }]);
});

test("a list answer is drawn with its bold and its citations inside the items", () => {
  const { root, nodes, cited } = draw("Three things [1]:\n\n- **Book the MOT** was due yesterday [2].\n- Reply to **Elena** [3][4], then rest.\n\nThat's all.");
  assert.deepEqual(nodes.map((n) => n.tagName), ["P", "UL", "P"]);
  assert.deepEqual(cited, [1, 2, 3, 4]);
  const items = [...root.querySelectorAll("ul.rich__list > li")];
  assert.equal(items.length, 2);
  // Bold is a <strong>, never asterisks.
  assert.equal(items[0].querySelector("strong")?.textContent, "Book the MOT");
  assert.equal(root.textContent?.includes("*"), false);
  // The number is glued to the word before it and the full stop after it, inside the item.
  const group = items[0].querySelector(".cite-group");
  assert.equal(group?.textContent, "yesterday2.");
  assert.equal(group?.querySelector("button.cite")?.textContent, "2");
  // A citation straight after a bold word sticks to that word, still bold.
  const second = items[1].querySelector(".cite-group");
  assert.equal(second?.querySelector("strong")?.textContent, "Elena");
  assert.deepEqual([...second!.querySelectorAll(".cite")].map((c) => c.textContent), ["3", "4"]);
  assert.equal(second?.textContent, "Elena34,");
  assert.equal(items[1].textContent, "Reply to Elena34, then rest.");
  // A citation with no source behind it leaves no gap or bracket.
  assert.equal(draw("Nothing here [9].").root.textContent, "Nothing here.");
});

test("bold: closed runs, a stray marker dropped, an open run bold to the end while it's written", () => {
  assert.deepEqual(boldSpans("a **b** c"), [{ text: "a ", bold: false }, { text: "b", bold: true }, { text: " c", bold: false }]);
  assert.deepEqual(boldSpans("a **b c"), [{ text: "a b c", bold: false }]);
  assert.deepEqual(boldSpans("a **b c", true), [{ text: "a ", bold: false }, { text: "b c", bold: true }]);
  assert.equal(draw("**Yes.** She said so.").root.querySelector("strong")?.textContent, "Yes.");
});

test("while it's written the draft is drawn as the answer will be, with nothing half-made at its end", () => {
  // Half a marker, half a link, one star, or a dash with no words yet all wait.
  assert.equal(draftRich("Elena wants £40 ["), "Elena wants £40");
  assert.equal(draftRich("Elena wants £40 [1"), "Elena wants £40");
  assert.equal(draftRich("Ask [@Priya](athena://pers"), "Ask");
  assert.equal(draftRich("Two things:\n\n- One\n-"), "Two things:\n\n- One");
  assert.equal(draftRich("Two things:\n\n- One\n- "), "Two things:\n\n- One");
  assert.equal(draftRich("It is *"), "It is ");
  assert.equal(draftRich("It is `code` and __this__"), "It is code and this");
  // Its lines are kept: the same blocks as the finished text, so nothing moves when it lands.
  const full = "Two things:\n\n- **One** [1].\n- Two [2].";
  assert.deepEqual(richBlocks(draftRich(full)), richBlocks(full));
  // Part-way through a bold run in a list item: bold already, no asterisks, a placeholder for the number.
  const part = draw(draftRich("Two things:\n\n- **Book the M"), true);
  assert.equal(part.root.querySelector("li strong")?.textContent, "Book the M");
  assert.equal(part.root.textContent?.includes("*"), false);
  const cited = draw(draftRich("Two things:\n\n- **One** [1]. Then"), true);
  assert.equal(cited.root.querySelector("li .cite-group")?.textContent, "One1.");
  // The caret goes at the end of the last line: the last item, or the last paragraph.
  assert.equal(lastLine(cited.nodes).tagName, "LI");
  assert.equal(lastLine(draw("One paragraph").nodes).tagName, "P");
  assert.equal(draw("").nodes.length, 1);
});

test("said aloud, and sent back as history: no numbers; speech has no bold or dashes", () => {
  const text = "Two things [1]:\n\n- **Book the MOT** [2]\n- Reply to Elena [3].\n\nThat's all.";
  assert.equal(plainText(text), "Two things: Book the MOT. Reply to Elena. That's all.");
  assert.equal(withoutCitations(text), "Two things:\n\n- **Book the MOT**\n- Reply to Elena.\n\nThat's all.");
});

// ---------- Retry-After ----------

test("a 429's Retry-After in seconds is the wait, capped at 30 s; without one the guess stands", async () => {
  const busy = (retryAfter?: number) => Object.assign(status(429), { retryAfter });
  const waits: RetryWait[] = [];
  const slept: number[] = [];
  const replies = [busy(7), busy(120)];
  const reply = await withRetry(async () => (replies.length ? Promise.reject(replies.shift()) : "ok"), { wait: async (ms) => void slept.push(ms), onWait: (w) => waits.push(w) });
  assert.equal(reply, "ok");
  assert.deepEqual(slept, [7_000, RETRY_AFTER_CAP_MS]);
  assert.deepEqual(waits.map((w) => w.told), [true, true]);
  // The step says how long, so a long wait doesn't look stuck.
  assert.equal(busyStepText(waits[0]), "Athena's AI is busy. Trying again in 7 seconds");
  assert.equal(busyStepText(waits[1]), "Still busy. Trying again in 30 seconds");
  // A short one reads as before.
  assert.equal(busyStepText({ kind: "busy", attempt: 1, ms: 2_000, told: true }), "Athena's AI is busy. Trying again shortly");

  // No header, or one that isn't seconds: the app's own waits.
  for (const after of [undefined, Number.NaN, -3]) {
    const own: number[] = [];
    await withRetry(async () => Promise.reject(busy(after)), { wait: async (ms) => void own.push(ms) }).catch(() => undefined);
    assert.deepEqual(own, BUSY_WAITS_MS);
  }
  // Zero means now. It's still only two more tries.
  const now: number[] = [];
  let tries = 0;
  await withRetry(async () => (tries++, Promise.reject(busy(0))), { wait: async (ms) => void now.push(ms) }).catch(() => undefined);
  assert.deepEqual(now, [0, 0]);
  assert.equal(tries, 3);
  // A dropped connection never reads it.
  const dropped: number[] = [];
  await withRetry(async () => Promise.reject(Object.assign(status(502), { retryAfter: 20 })), { wait: async (ms) => void dropped.push(ms) }).catch(() => undefined);
  assert.deepEqual(dropped, [DROPPED_WAIT_MS]);
});

test("Retry-After is read as whole seconds only", () => {
  assert.equal(retryAfterSeconds("12"), 12);
  assert.equal(retryAfterSeconds(" 0 "), 0);
  for (const h of [null, undefined, "", "soon", "1.5", "-4", "Wed, 21 Oct 2026 07:28:00 GMT"]) assert.equal(retryAfterSeconds(h), undefined);
});

// ---------- numbered steps ----------

test("\"1. \" lines are a numbered list that keeps the server's numbers", () => {
  assert.deepEqual(richBlocks("Do this:\n\n1. One\n2. Two\n   carries on\n3. Three\n\nDone."), [
    { kind: "p", text: "Do this:" },
    { kind: "ol", items: ["One", "Two carries on", "Three"], nums: [1, 2, 3] },
    { kind: "p", text: "Done." },
  ]);
  // No blank line needed after the intro; the numbers are kept as written, even when they don't start at 1.
  assert.deepEqual(richBlocks("Intro:\n1. a\n2. b"), [{ kind: "p", text: "Intro:" }, { kind: "ol", items: ["a", "b"], nums: [1, 2] }]);
  assert.deepEqual(richBlocks("4. d\n5. e"), [{ kind: "ol", items: ["d", "e"], nums: [4, 5] }]);
  // Steps a blank line apart are one list while the numbers run on.
  assert.deepEqual(richBlocks("1. a\n\n2. b\n\n3. c"), [{ kind: "ol", items: ["a", "b", "c"], nums: [1, 2, 3] }]);
  // Dashes under a step, then the next step: its number is still its own.
  assert.deepEqual(richBlocks("1. a\n   - x\n   - y\n2. b"), [
    { kind: "ol", items: ["a"], nums: [1] },
    { kind: "ul", items: ["x", "y"] },
    { kind: "ol", items: ["b"], nums: [2] },
  ]);
  // A wrapped line that begins with a figure, a year or a decimal is not a step.
  assert.deepEqual(richBlocks("It costs\n40. Then more."), [{ kind: "p", text: "It costs 40. Then more." }]);
  assert.deepEqual(richBlocks("2026. A year."), [{ kind: "p", text: "2026. A year." }]);
  assert.deepEqual(richBlocks("3.5 hours in all."), [{ kind: "p", text: "3.5 hours in all." }]);
});

test("numbered steps are drawn as an ordered list, bold and citations inside the items", () => {
  const { root, nodes, cited } = draw("Three steps:\n\n1. **Split the roadmap** [1].\n2. Run it past Elena [1][2].\n3. Finish by Friday [3].\n\nThat's all.");
  assert.deepEqual(nodes.map((n) => n.tagName), ["P", "OL", "P"]);
  assert.deepEqual(cited, [1, 1, 2, 3]);
  const ol = root.querySelector("ol.rich__list.rich__list--steps")!;
  assert.equal(ol.getAttribute("role"), "list");
  assert.equal(ol.getAttribute("start"), "1");
  const items = [...ol.querySelectorAll(":scope > li")];
  assert.deepEqual(items.map((li) => li.getAttribute("data-n")), ["1", "2", "3"]);
  assert.deepEqual(items.map((li) => li.getAttribute("value")), ["1", "2", "3"]);
  // The number is the list's, never typed into the words.
  assert.equal(items[0].textContent, "Split the roadmap1.");
  assert.equal([...items[0].querySelectorAll("strong")].map((x) => x.textContent).join(""), "Split the roadmap");
  assert.deepEqual([...items[1].querySelectorAll(".cite-group .cite")].map((c) => c.textContent), ["1", "2"]);
  assert.equal(items[1].textContent, "Run it past Elena12.");
  // A list that starts later says so.
  assert.equal(draw("4. d\n5. e").root.querySelector("ol")?.getAttribute("start"), "4");
});

test("numbered steps while they're written: the same blocks at every point, a bare number waits", () => {
  const full = "Three steps:\n\n1. **Split** it [1].\n2. Run it past Elena [2].\n10. Finish.";
  // A new line's number with no words yet isn't drawn: not as a word, not as an empty step.
  for (const end of ["\n2", "\n2.", "\n2. ", "\n10", "\n10."]) assert.equal(draftRich(`Steps:\n\n1. One${end}`), "Steps:\n\n1. One");
  for (const start of ["1", "1.", "1. "]) assert.equal(draftRich(start), "");
  assert.equal(draftRich("1. O"), "1. O");
  // Stream it a character at a time: every block drawn so far is a block of the finished answer, in its place.
  const whole = richBlocks(full);
  for (let i = 1; i <= full.length; i++) {
    const sofar = richBlocks(draftRich(full.slice(0, i)));
    sofar.forEach((b, at) => {
      assert.equal(b.kind, whole[at].kind, `block ${at} at ${i}`);
      if (b.kind === "ol") assert.deepEqual(b.nums, (whole[at] as typeof b).nums.slice(0, b.nums.length), `numbers at ${i}`);
    });
  }
  assert.deepEqual(richBlocks(draftRich(full)), whole);
  // Part-way through a step: an <ol> already, bold, a placeholder for the number, the caret's line is the step.
  const part = draw(draftRich("Three steps:\n\n1. **Split** it [1].\n2. Run it p"), true);
  assert.deepEqual(part.nodes.map((n) => n.tagName), ["P", "OL"]);
  assert.equal(part.root.querySelectorAll("ol > li").length, 2);
  assert.equal(lastLine(part.nodes).getAttribute("data-n"), "2");
});

test("numbered steps said aloud, pinned and sent back: like dash lines", () => {
  const text = "Three steps [1]:\n\n1. **Split the roadmap** [1]\n2. Run it past Elena [2].\n\nThat's all.";
  // Speech and a pin's preview: no numbers, each step a sentence.
  assert.equal(plainText(text), "Three steps: Split the roadmap. Run it past Elena. That's all.");
  // History keeps the lines and their numbers, without the citations.
  assert.equal(withoutCitations(text), "Three steps:\n\n1. **Split the roadmap**\n2. Run it past Elena.\n\nThat's all.");
});

// ---------- general and web answers ----------

test("a general answer says so in place of \"Searched…\"; a web source shows its site's name", () => {
  const base: AnswerReply = { text: "About three weeks [1].", sources: [], related: [], searched: "Searched your notes", skipped: [], found: false, flagged: false };
  assert.equal(isGeneral(base), false);
  assert.equal(isGeneral({ ...base, general: true } as AnswerReply), true);
  assert.equal(isGeneral({ ...base, general: "yes" } as unknown as AnswerReply), false);
  assert.equal(generalNote(base), "General knowledge, with nothing of yours behind it");
  const web = { n: 1, kind: "web", id: null, url: "https://www.gov.uk/renew-adult-passport", title: "Renew or replace your adult passport" };
  assert.equal(generalNote({ ...base, sources: [web] } as unknown as AnswerReply), "From the web, with nothing of yours behind it");
  // Kept with the conversation as that line, and read back from it.
  assert.equal(isGeneralNote(generalNote(base)), true);
  assert.equal(isGeneralNote("Searched your notes"), false);
  assert.equal(isWebSource(web), true);
  assert.equal(isWebSource({ kind: "page", url: "https://example.com" }), false);
  assert.equal(siteName(web.url), "gov.uk");
  assert.equal(siteName("https://news.bbc.co.uk/a/b?c=d"), "news.bbc.co.uk");
  // Only a web link has a site: nothing else is ever made a link.
  assert.equal(siteName("javascript:alert(1)"), "");
  assert.equal(siteName("not a link"), "");
  const bad = { n: 2, kind: "web", id: null, url: "javascript:alert(1)", title: "Click me" };
  assert.equal(isWebSource(bad), false);
  assert.deepEqual(sourcesOf({ ...base, sources: [web, bad] } as unknown as AnswerReply).map((s) => s.n), [1]);
  assert.equal(sourceRef(web), web.url);
  assert.equal(sourceRef({ kind: "note", id: "n1", url: null }), "note:n1");
  assert.equal(sourceRef({ kind: "note", id: null, url: null }), null);
});
