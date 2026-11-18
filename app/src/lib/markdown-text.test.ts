// The plain-text projection (Home's briefing line, list snippets): links in every mode read as their words.
// Run: npx tsx --test app/src/lib/markdown-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToText } from "./markdown-text";

const ID = "11111111-2222-4333-8444-555555555555";

test("links in every mode read as their label, never as Markdown or a mode word", () => {
  const body = [
    `Lunch with [@Priya Shah](athena://person/${ID}) at [@Dishoom](athena://place/${ID} "card").`,
    `[A slow walk](https://example.com/walk "card")`,
    `[The video](https://youtu.be/x 'embed'), [docs](https://example.com/docs), [Wiki](https://en.wikipedia.org/wiki/Foo_(bar) "mention")`,
    `[](https://example.com/empty "card")`,
  ].join("\n");
  assert.equal(markdownToText(body), "Lunch with @Priya Shah at Dishoom.\nA slow walk\nThe video, docs, Wiki\nexample.com");
});
