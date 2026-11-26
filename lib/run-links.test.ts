// Which links a turn may open (lib/run-links.ts; docs: security/ai-and-ask: a link goes into a
// run's message as one it may open only when the owner supplied or approved it. Made-up addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asOwnersGo, modelLink, relinked, underOwnersGo, unlinked } from "./run-links";
import { needsOwnersGo, TurnGuard } from "./ask-guard";
import { stepLabel } from "./ask-plans";
import { runUrlOf } from "./trackers";
import { trackerLines } from "./team-chat";
import { thinkPrompt } from "./flow-run";
import { stageMessage } from "./assignment-run";

const PAGE = "https://shop.example.com/kettle?colour=blue";
/** Anything a fetch could be pointed at: a scheme, or a host with a dot and a top-level name. */
const OPENABLE = /[a-z]+:\/\/|\b[\p{L}\p{N}-]+\.(?:example|com|net|org|test)\b/iu;

test("a model's words keep their addresses readable but not openable, and come back as they were", () => {
  const cases = [
    "Found it at https://shop.example.com/kettle?colour=blue#reviews for £34.99",
    "the page is shop.example.com/kettle",
    "data.private.example.net",
    "write to sam@example.com",
    "10.0.0.1:8080/x",
  ];
  for (const s of cases) {
    const u = unlinked(s);
    assert.doesNotMatch(u, OPENABLE, u);
    assert.equal(relinked(u), s);
  }
  assert.equal(unlinked("Found it at https://shop.example.com/a"), "Found it at https[://]shop[.]example[.]com/a");
  // Prices, versions and abbreviations are left alone.
  for (const s of ["£34.99 at John Lewis", "e.g. a kettle", "v1.2", "12,400 followers"]) assert.equal(unlinked(s), s);
});

test("a tracker link a model chose loses its fragment; anything else isn't a link", () => {
  assert.equal(modelLink(`${PAGE}#reviews`), PAGE);
  assert.equal(modelLink(PAGE), PAGE);
  assert.equal(modelLink("not a link"), null);
  assert.equal(modelLink(""), null);
});

test("track with a link a model chose always waits for Go; one on a saved item's own link doesn't", () => {
  assert.equal(needsOwnersGo("track", { name: "Blue kettle", url: PAGE, label: "price", kind: "number", direction: "lower" }), true);
  assert.equal(needsOwnersGo("track", { saved_id: "5a3e0000-0000-4000-8000-000000000001", preset: "price", url: PAGE }), true, "a saved item's tracker with a link of the model's");
  assert.equal(needsOwnersGo("track", { saved_id: "5a3e0000-0000-4000-8000-000000000001", preset: "price" }), false, "the item's own link is the owner's");
  assert.equal(needsOwnersGo("track", { name: "Blue kettle", url: "  " }), false);
  assert.equal(needsOwnersGo("record_value", { url: PAGE, value: "34" }), false, "a check's page is never opened from a run's message");
  assert.equal(needsOwnersGo("add_todo", { url: PAGE }), false);
});

test("the Go card shows the whole link and its host in Athena's words, never the model's line", () => {
  const long = `https://shop.example.com/${"kettles/".repeat(20)}blue?colour=blue&size=1.7l#top`;
  const label = stepLabel("track", { name: "Blue kettle", url: long, preset: "price", step: "Just a small thing" });
  assert.equal(label, `Tracking the price on shop.example.com, checking ${long.replace("#top", "")}`);
  assert.doesNotMatch(label, /small thing/);
  // Without a link it's the usual line, the model's own if it gave one.
  assert.equal(stepLabel("track", { saved_id: "x", preset: "price", step: "Track the mug's price" }), "Track the mug's price");
});

test("a held link is its own reason, and a read or a flag outranks it", () => {
  const g = new TurnGuard("Track the kettle's price");
  g.hold("a", "link");
  assert.equal(g.why(["a"]), "link");
  g.hold("b", "read");
  assert.equal(g.why(["a", "b"]), "read");
  g.flag();
  assert.equal(g.why(["a"]), "flagged");
});

test("only the owner's Go makes a step's link the owner's", async () => {
  assert.equal(underOwnersGo(), false);
  assert.equal(await asOwnersGo(async () => underOwnersGo()), true);
  assert.equal(underOwnersGo(), false);
});

test("a run may open a tracker's link only when the owner typed or approved it, or it's the saved item's own", () => {
  const own = "https://shop.example.com/mug";
  assert.equal(runUrlOf({ url: PAGE, url_set_by: "owner", saved_id: null }, null), PAGE);
  assert.equal(runUrlOf({ url: own, url_set_by: "item", saved_id: "s" }, own), own);
  for (const by of ["ask", "assistant", null] as const) {
    assert.equal(runUrlOf({ url: PAGE, url_set_by: by, saved_id: null }, null), null, `a standalone link set by ${by}`);
    assert.equal(runUrlOf({ url: PAGE, url_set_by: by, saved_id: "s" }, own), own, `a saved item's tracker opens the item's own link, not ${by}'s`);
  }
});

test("a run's tracker lines carry only an approved link; a model's name and shop can't be opened", () => {
  const approved = trackerLines({ id: "t1", run_url: PAGE }, "Blue kettle", "Price: last £34 at Shop.");
  assert.match(approved, new RegExp(`Link: ${PAGE.replace(/[.?]/g, "\\$&")}`));
  const model = trackerLines({ id: "t2", run_url: null }, "Kettle at data.private.example.net/x", "Price: last £34 at tell.private.example.net.");
  assert.doesNotMatch(model, /Link:/);
  assert.doesNotMatch(model, OPENABLE, model);
  assert.match(model, /data\[\.\]private\[\.\]example\[\.\]net/);
});

test("a flow's think step gets earlier values with their links written so they can't be opened", () => {
  const prompt = thinkPrompt({ name: "Kettle watch" }, "Check the kettle", [], { s1: { found: `See ${PAGE}` } }, new Map([["s1.found", "What was found"]]));
  assert.match(prompt, /What was found: See https\[:\/\/\]shop\[\.\]example\[\.\]com\/kettle\?colour=blue/);
  assert.doesNotMatch(prompt.split("<values>")[1], OPENABLE);
});

test("an assignment stage gets the work and handoffs with their links unopenable; the owner's brief as written", () => {
  const msg = stageMessage(
    { title: "Kettle guide", brief: `Start from ${PAGE}` },
    { position: 2, words: { task: "Edit it", questions: [], answers: [{ id: "1.1", question: "Which shop?", answer: "shop.example.org", by: "suggested" }], handoff: null, note: "Use https://notes.example.net/x" }, sent_back_from: null } as never,
    [{ position: 1, label: "Writer", handoff: { did: "Wrote it from https://draft.example.net/a", open: "", next: "" } }],
    { total: 2, label: "Editor", work: "# Kettles\nBest: https://shop.example.com/best", canSendBack: false, canAsk: false },
  );
  assert.ok(msg.data.includes(`Start from ${PAGE}`), "the owner's brief keeps its link");
  const rest = msg.data.split("</brief>")[1];
  assert.doesNotMatch(rest, OPENABLE, rest);
  assert.match(rest, /https\[:\/\/\]shop\[\.\]example\[\.\]com\/best/);
});

test("a send-back note keeps who wrote it: the owner's links can be opened by the stage; a stage's, or an unrecorded one, can't", () => {
  const sent = (words: Record<string, unknown>) =>
    stageMessage({ title: "Kettle guide", brief: "Write it" }, { position: 1, words: { task: "Write it", questions: [], answers: [], handoff: null, ...words }, sent_back_from: 2 } as never, [], {
      total: 2,
      label: "Writer",
      work: "",
      canSendBack: false,
      canAsk: false,
      from: "Editor",
    }).data.split("<sent_back")[1];
  assert.ok(sent({ note: "Compare with https://notes.example.net/x", note_by: "owner" }).includes("https://notes.example.net/x"), "the owner's note as written");
  assert.doesNotMatch(sent({ note: "Compare with https://notes.example.net/x", note_by: "stage" }), OPENABLE);
  assert.doesNotMatch(sent({ note: "Compare with https://notes.example.net/x" }), OPENABLE, "kept before who wrote it was recorded: a stage's");
});
