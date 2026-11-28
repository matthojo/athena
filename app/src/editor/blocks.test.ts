/**
 * Note blocks: callouts, toggles, tables, dividers and code read from and
 * write back to Markdown unchanged, and Obsidian's callout types keep their
 * names. Headless editor (no view), same schema as the app (extensions.ts).
 *
 *   npx tsx --test app/src/editor/blocks.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "Node", "HTMLElement", "Element", "Text", "DocumentFragment"]) g[k] ??= (window as unknown as Record<string, unknown>)[k];
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { Editor } = await import("@tiptap/core");
const { baseExtensions } = await import("./extensions");
const { calloutHead, toneOf, calloutHeadText } = await import("../../../lib/callouts");

function open(md: string) {
  return new Editor({ element: null, extensions: baseExtensions(), content: md, contentType: "markdown" });
}

function roundTrip(md: string): string {
  const ed = open(md);
  const out = ed.getMarkdown();
  ed.destroy();
  return out;
}

const norm = (s: string) => s.trim().replace(/\n{3,}/g, "\n\n");

test("a callout keeps its type, title and words", () => {
  const md = ["> [!tip] Before the flight", "> Check in online the night before.", ">", "> - Passport", "> - Charger"].join("\n");
  const out = roundTrip(md);
  assert.equal(norm(out), norm(md));
  const ed = open(md);
  const node = ed.state.doc.firstChild!;
  assert.equal(node.type.name, "callout");
  assert.equal(node.attrs.type, "tip");
  assert.equal(node.firstChild!.type.name, "calloutTitle");
  assert.equal(node.firstChild!.textContent, "Before the flight");
  ed.destroy();
});

test("a callout without a title has no title line", () => {
  const md = "> [!warning]\n> The boiler needs a service before winter.";
  assert.equal(norm(roundTrip(md)), norm(md));
  const ed = open(md);
  assert.equal(ed.state.doc.firstChild!.firstChild!.type.name, "paragraph");
  ed.destroy();
});

test("a toggle keeps its fold and its title", () => {
  for (const fold of ["-", "+"]) {
    const md = `> [!note]${fold} Packing list\n> - [ ] Passport\n> - [x] Adapter`;
    assert.equal(norm(roundTrip(md)), norm(md));
  }
  const ed = open("> [!note]- Packing list\n> Socks");
  assert.equal(ed.state.doc.firstChild!.attrs.fold, "-");
  ed.destroy();
});

test("a toggle written without a title still opens with a title line to type in", () => {
  const ed = open("> [!note]-\n> Socks");
  const node = ed.state.doc.firstChild!;
  assert.equal(node.firstChild!.type.name, "calloutTitle");
  assert.equal(norm(ed.getMarkdown()), "> [!note]-\n> Socks");
  ed.destroy();
});

test("a type Athena doesn't know is kept as written, and drawn plain", () => {
  const md = "> [!recipe] Gran's scones\n> Rub the butter in quickly.";
  assert.equal(norm(roundTrip(md)), norm(md));
  assert.equal(toneOf("recipe"), "note");
  assert.equal(toneOf("Caution"), "warning");
  assert.equal(toneOf("faq"), "key");
});

test("a plain quote stays a quote", () => {
  const md = "> Simplicity is the ultimate sophistication.";
  const ed = open(md);
  assert.equal(ed.state.doc.firstChild!.type.name, "blockquote");
  assert.equal(norm(ed.getMarkdown()), md);
  ed.destroy();
});

test("a callout sits between paragraphs without swallowing them", () => {
  const md = ["Before.", "", "> [!important]", "> Pay the deposit by Friday.", "", "After."].join("\n");
  const out = roundTrip(md);
  assert.equal(norm(out), norm(md));
  const ed = open(md);
  assert.deepEqual(
    ed.state.doc.content.content.map((n) => n.type.name),
    ["paragraph", "callout", "paragraph"]
  );
  ed.destroy();
});

test("links inside a callout keep their mode", () => {
  const md = '> [!tip] Ask [@Priya Shah](athena://person/5a3e0000-0000-4000-8000-000000000101)\n> [A slow walk](https://example.com/walk "mention") is worth it.';
  assert.equal(norm(roundTrip(md)), norm(md));
});

test("tables, dividers and code survive open and save", () => {
  const md = [
    "| Room | Paint |",
    "| --- | --- |",
    "| Hall | Sage |",
    "| Study | Chalk |",
    "",
    "---",
    "",
    "```",
    "npm run build",
    "```",
  ].join("\n");
  const out = roundTrip(md);
  const ed = open(md);
  assert.deepEqual(
    ed.state.doc.content.content.map((n) => n.type.name),
    ["table", "horizontalRule", "codeBlock"]
  );
  ed.destroy();
  assert.match(out, /\| Room\s*\| Paint\s*\|/);
  assert.match(out, /\| Study\s*\| Chalk\s*\|/);
  assert.match(out, /^---$/m);
  assert.match(out, /```\nnpm run build\n```/);
  assert.equal(norm(roundTrip(out)), norm(out), "a second save changes nothing");
});

test("callout heads parse, and read as their title in plain text", () => {
  assert.deepEqual(calloutHead("> [!tip]- Later"), { type: "tip", fold: "-", title: "Later" });
  assert.equal(calloutHead("> just a quote"), null);
  assert.equal(calloutHeadText("> [!tip] Later\n> Words"), "> Later\n> Words");
  assert.equal(calloutHeadText("> [!note]\n> Words"), "> \n> Words");
});
