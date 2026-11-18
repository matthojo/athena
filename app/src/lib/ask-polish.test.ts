// Run: npx tsx --test app/src/lib/ask-polish.test.ts
// Ask, quicker to steer: a streamed reply put together, edit and regenerate, pins, and the keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyText, assemble, draftParts, draftText, type StreamEvent } from "./ask-stream";
import { addVersion, beforeEdit, lastMine, loadSlot, MAX_VERSIONS, pickVersion, saveSlot, versionLabel, type Slot } from "./ask-versions";
import { pinnedAnswers, setPinned } from "./ask-pins";
import { askKeyAction, isJumpKey, type AskKeyState } from "./ask-keys";

// ---------- stream assembly ----------

test("a streamed answer: steps, then words, then the reply with its sources", () => {
  const events: StreamEvent[] = [
    { type: "step", id: "first", text: "Searching your notes", done: false },
    { type: "step", id: "first", text: "Found 2 matches in your notes", done: true },
    { type: "text", delta: "Elena wants £40" },
    { type: "text", delta: " a seat [" },
    { type: "text", delta: "1] until March." },
    { type: "done", reply: { text: "Elena wants £40 a seat [1] until March.", sources: [{ n: 1, kind: "note", id: "n1" }] } },
    // Anything after the reply is ignored.
    { type: "text", delta: " stray" },
  ];
  const got = assemble<{ text: string; sources: Array<{ n: number }> }>(events);
  assert.deepEqual(got.steps, [{ id: "first", text: "Found 2 matches in your notes", done: true }]);
  assert.equal(got.draft, "Elena wants £40 a seat [1] until March.");
  // The citations arrive after the text: only the reply has them.
  assert.equal(got.reply?.sources[0].n, 1);
});

test("while it's written, a marker shows as a placeholder, and half a marker or link waits", () => {
  assert.deepEqual(draftParts("Elena wants £40 a seat [1] until"), ["Elena wants £40 a seat", 1, " until"]);
  assert.deepEqual(draftParts("Elena wants £40 a seat ["), ["Elena wants £40 a seat"]);
  assert.deepEqual(draftParts("Elena wants £40 a seat [1"), ["Elena wants £40 a seat"]);
  assert.equal(draftText("Ask [@Priya](athena://pers"), "Ask");
  assert.equal(draftText("Ask [@Priya](athena://person/1) now"), "Ask [@Priya](athena://person/1) now");
  // As the finished answer reads: one paragraph, no Markdown.
  assert.equal(draftText("**Yes.**\n\nShe said so."), "Yes. She said so.");
});

test("words taken back start the draft again", () => {
  let d = applyText("", { delta: "Let me check." });
  d = applyText(d, { reset: true });
  assert.equal(d, "");
  assert.equal(applyText(d, { delta: "Done." }), "Done.");
});

// ---------- edit and regenerate ----------

type M = { role: "me" | "answer"; text: string };
const me = (text: string): M => ({ role: "me", text });
const ans = (text: string): M => ({ role: "answer", text });

test("edit: your last message and the reply under it give way to the new one", () => {
  const thread = [me("What did Elena say?"), ans("About pricing [1]."), me("And Priya?"), ans("Nothing yet.")];
  assert.equal(lastMine(thread), 2);
  assert.deepEqual(beforeEdit(thread), thread.slice(0, 2));
  assert.equal(lastMine([ans("hi")]), -1);
  assert.deepEqual(beforeEdit([ans("hi")]), [ans("hi")]);
});

test("regenerate: the new reply shows as 2 of 2, the first stays reachable", () => {
  const first = ans("v1");
  const second = ans("v2");
  let slot: Slot<M> = addVersion(null, first, second);
  assert.equal(versionLabel(slot), "2 of 2");
  assert.equal(slot.all[slot.index], second);
  slot = pickVersion(slot, 0);
  assert.equal(versionLabel(slot), "1 of 2");
  assert.equal(slot.all[slot.index], first);
  // Again from the first: a third version, shown.
  slot = addVersion(slot, first, ans("v3"));
  assert.equal(versionLabel(slot), "3 of 3");
  assert.equal(pickVersion(slot, 99).index, 2);
  assert.equal(pickVersion(slot, -4).index, 0);
  assert.equal(versionLabel(null), null);
  assert.equal(versionLabel({ all: [first], index: 0 }), null);
});

test("regenerate keeps at most a handful of versions, dropping the oldest", () => {
  let slot: Slot<M> | null = null;
  let cur = ans("v0");
  for (let i = 1; i <= MAX_VERSIONS + 2; i++) {
    const next = ans(`v${i}`);
    slot = addVersion(slot, cur, next);
    cur = next;
  }
  assert.equal(slot!.all.length, MAX_VERSIONS);
  assert.equal(slot!.all[0].text, "v3");
  assert.equal(versionLabel(slot), `${MAX_VERSIONS} of ${MAX_VERSIONS}`);
});

test("versions are saved with the reply and come back showing the same one", () => {
  const slot = pickVersion(addVersion(null, ans("v1"), ans("v2")), 0);
  const saved = saveSlot(slot, (m) => ({ ...m, saved: true }));
  assert.equal(saved.version, 0);
  assert.equal(saved.versions?.length, 2);
  const back = loadSlot(saved, (s) => ({ role: s.role, text: s.text }) as M)!;
  assert.equal(versionLabel(back), "1 of 2");
  assert.equal(back.all[back.index].text, "v1");
  // One version isn't a slot; one that can't be saved drops out.
  assert.deepEqual(saveSlot({ all: [ans("v1")], index: 0 }, (m) => m), {});
  assert.deepEqual(saveSlot(slot, (m) => (m.text === "v1" ? null : m)), {});
  assert.equal(loadSlot({}, (s) => s), null);
});

// ---------- pins ----------

test("pin and unpin: pinned answers lead Ask's history, newest pin first, archived left out", () => {
  const a = { role: "answer", text: "£40 a seat [1].", question: "What did [@Elena](athena://person/11111111-1111-4111-8111-111111111111) say?" } as { role: string; text: string; question: string; pinned_at?: string };
  const b = { role: "assistant", reply: { text: "Added it." } } as { role: string; reply: { text: string }; pinned_at?: string };
  setPinned(a, true, new Date("2026-11-08T10:00:00Z"));
  setPinned(b, true, new Date("2026-11-09T10:00:00Z"));
  const threads = [
    { id: "t1", messages: [{ role: "me", text: "ignored" }, a] },
    { id: "t2", messages: [{ role: "me", text: "Add milk" }, b] },
    { id: "t3", archived_at: "2026-11-09T00:00:00Z", messages: [{ role: "answer", text: "x", question: "y", pinned_at: "2026-11-09T12:00:00Z" }] },
  ];
  assert.deepEqual(pinnedAnswers(threads), [
    { threadId: "t2", index: 1, question: "Add milk", text: "Added it.", pinned_at: "2026-11-09T10:00:00.000Z" },
    { threadId: "t1", index: 1, question: "What did Elena say?", text: "£40 a seat.", pinned_at: "2026-11-08T10:00:00.000Z" },
  ]);
  // Pinning again keeps the first time; unpinning takes it off.
  setPinned(a, true, new Date("2026-12-01T00:00:00Z"));
  assert.equal(a.pinned_at, "2026-11-08T10:00:00.000Z");
  setPinned(a, false);
  assert.equal("pinned_at" in a, false);
  assert.equal(pinnedAnswers(threads).length, 1);
});

// ---------- keys ----------

const state = (over: Partial<AskKeyState> = {}): AskKeyState => ({
  onAsk: true,
  dialogOpen: false,
  inEditor: false,
  inComposer: true,
  composerEmpty: true,
  menuOpen: false,
  editing: false,
  canEdit: true,
  ...over,
});

test("⌘J and Ctrl+J open Ask from anywhere, not over a dialog; ⌘K stays search and jump", () => {
  assert.equal(askKeyAction({ key: "j", metaKey: true }, state({ onAsk: false })), "open");
  assert.equal(askKeyAction({ key: "J", ctrlKey: true }, state({ onAsk: false, inEditor: true })), "open");
  assert.equal(askKeyAction({ key: "j", metaKey: true }, state({ dialogOpen: true })), null);
  assert.equal(askKeyAction({ key: "j", metaKey: true, shiftKey: true }, state()), null);
  assert.equal(askKeyAction({ key: "j", metaKey: true, isComposing: true }, state()), null);
  assert.equal(askKeyAction({ key: "j" }, state()), null);
  assert.equal(askKeyAction({ key: "k", metaKey: true }, state()), null);
  assert.equal(isJumpKey({ key: "k", metaKey: true }), true);
  assert.equal(isJumpKey({ key: "K", ctrlKey: true }), true);
  assert.equal(isJumpKey({ key: "j", metaKey: true }), false);
  assert.equal(isJumpKey({ key: "k", metaKey: true, shiftKey: true }), false);
  assert.equal(isJumpKey({ key: "k" }), false);
});

test("Esc closes Ask, or stops editing first, and leaves menus, dialogs and editors alone", () => {
  assert.equal(askKeyAction({ key: "Escape" }, state()), "close");
  assert.equal(askKeyAction({ key: "Escape" }, state({ editing: true })), "cancel-edit");
  assert.equal(askKeyAction({ key: "Escape" }, state({ menuOpen: true })), null);
  assert.equal(askKeyAction({ key: "Escape" }, state({ dialogOpen: true })), null);
  assert.equal(askKeyAction({ key: "Escape" }, state({ inEditor: true, inComposer: false })), null);
  assert.equal(askKeyAction({ key: "Escape" }, state({ onAsk: false })), null);
  assert.equal(askKeyAction({ key: "Escape", defaultPrevented: true }, state()), null);
});

test("↑ in the empty box edits your last message, and only then", () => {
  assert.equal(askKeyAction({ key: "ArrowUp" }, state()), "edit-last");
  assert.equal(askKeyAction({ key: "ArrowUp" }, state({ composerEmpty: false })), null);
  assert.equal(askKeyAction({ key: "ArrowUp" }, state({ inComposer: false })), null);
  assert.equal(askKeyAction({ key: "ArrowUp" }, state({ canEdit: false })), null);
  assert.equal(askKeyAction({ key: "ArrowUp" }, state({ editing: true })), null);
  assert.equal(askKeyAction({ key: "ArrowUp" }, state({ menuOpen: true })), null);
  assert.equal(askKeyAction({ key: "ArrowUp", shiftKey: true }, state()), null);
  assert.equal(askKeyAction({ key: "ArrowUp", isComposing: true }, state()), null);
});
