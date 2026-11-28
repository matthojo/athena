import { test } from "node:test";
import assert from "node:assert/strict";
import { calloutHead, calloutsAsQuotes, readCallout, toneOf } from "./callouts";
import { docxParts } from "./document-make";
import { outsideMarkdown } from "./documents";
import { markdownToText } from "../app/src/lib/markdown-text";

test("a callout's head gives its type, fold and title", () => {
  assert.deepEqual(calloutHead("> [!warning]+ Boiler"), { type: "warning", fold: "+", title: "Boiler" });
  assert.deepEqual(calloutHead(">[!tip]"), { type: "tip", fold: null, title: "" });
  assert.equal(calloutHead("> [not a callout]"), null);
  assert.equal(calloutHead("[!tip] no quote mark"), null);
});

test("a callout runs until the quote ends", () => {
  const found = readCallout("> [!tip] Title\n> one\n>\n> two\nAfter");
  assert.ok(found);
  assert.equal(found.inner, "one\n\ntwo");
  assert.equal(found.raw, "> [!tip] Title\n> one\n>\n> two\n");
});

test("tones: known types, others plain", () => {
  assert.equal(toneOf("TIP"), "tip");
  assert.equal(toneOf("danger"), "warning");
  assert.equal(toneOf("question"), "key");
  assert.equal(toneOf("abstract"), "note");
});

test("outside Athena a callout is a quote with its title in bold", () => {
  assert.equal(calloutsAsQuotes("> [!tip] Before you go\n> Pack light."), "> **Before you go**\n>\n> Pack light.");
  assert.equal(calloutsAsQuotes("> [!note]-\n> Socks"), "> Socks");
  assert.equal(calloutsAsQuotes("> plain quote"), "> plain quote");
  assert.equal(outsideMarkdown("> [!note]- Packing\n> [@Passport](athena://saved/5a3e0000-0000-4000-8000-000000000101)"), "> **Packing**\n>\n> Passport");
});

test("Word gets a quote, never the [!tip] marker", () => {
  const { document } = docxParts("> [!tip] Before you go\n> Pack light.");
  assert.ok(!document.includes("[!tip]"));
  assert.ok(document.includes("Before you go"));
  assert.ok(document.includes("Pack light."));
});

test("snippets read a callout's title, and a table's cells", () => {
  assert.equal(markdownToText("> [!tip] Before you go\n> Pack light."), "Before you go\nPack light.");
  assert.equal(markdownToText("| Day | Plan |\n| --- | --- |\n| Friday | Arrive |"), "Day · Plan\nFriday · Arrive");
});
