// The Obsidian export's links: Athena links as wikilinks, web links as plain Markdown with their titles.
// Run: npx tsx --test scripts/export-obsidian.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportLinks } from "./export-obsidian";

const P = "11111111-2222-4333-8444-555555555555";
const GONE = "99999999-2222-4333-8444-555555555555";
const names = new Map([[`person:${P}`, "Priya Shah"], [`place:${P}`, "Dishoom King's Cross"]]);

test("Athena links become wikilinks in every mode; gone ones their label", () => {
  const body = `With [@Priya Shah](athena://person/${P}) at [@Dishoom](athena://place/${P} "card"), not [@Old](athena://person/${GONE} "card").`;
  assert.equal(exportLinks(body, names), "With [[Priya Shah]] at [[Dishoom King's Cross|Dishoom]], not @Old.");
});

test("web links stay plain Markdown, keeping their label and their mode in the title", () => {
  const body = [
    `[A slow walk](https://example.com/walk "card")`,
    `[The video](https://youtu.be/dQw4w9WgXcQ 'embed')`,
    `Read [the docs](https://example.com/docs) and [@Wiki](https://en.wikipedia.org/wiki/Foo_(bar) "mention").`,
    `![a picture](https://example.com/p.png "card")`,
  ].join("\n");
  assert.equal(
    exportLinks(body, names),
    [
      `[A slow walk](https://example.com/walk "card")`,
      `[The video](https://youtu.be/dQw4w9WgXcQ "embed")`,
      `Read [the docs](https://example.com/docs) and [@Wiki](https://en.wikipedia.org/wiki/Foo_(bar) "mention").`,
      `![a picture](https://example.com/p.png "card")`,
    ].join("\n"),
  );
});

test("a web link with no words of its own takes its page's title, else its site", () => {
  const titles = new Map([["https://example.com/walk", "A slow walk along Regent's Canal"]]);
  const title = (url: string) => titles.get(url) ?? null;
  assert.equal(exportLinks(`[](https://example.com/walk "card")`, names, title), `[A slow walk along Regent's Canal](https://example.com/walk "card")`);
  assert.equal(exportLinks(`[https://example.com/walk](https://example.com/walk)`, names, title), `[A slow walk along Regent's Canal](https://example.com/walk)`);
  assert.equal(exportLinks(`[](https://www.example.org/x "embed")`, names, title), `[example.org](https://www.example.org/x "embed")`);
  assert.equal(exportLinks(`[[brackets]] stay`, names), `[[brackets]] stay`, "an existing wikilink isn't touched");
});
