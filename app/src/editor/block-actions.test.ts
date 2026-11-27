/**
 * Block actions: moving a block up and down (and its holder at the end of a
 * callout or list), duplicating and deleting it, keep the note's Markdown
 * whole. Headless editor in a small DOM (linkedom), same schema as the app.
 *
 *   npx tsx --test app/src/editor/block-actions.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "Node", "HTMLElement", "Element", "Text", "DocumentFragment", "MutationObserver"]) g[k] ??= (window as unknown as Record<string, unknown>)[k];
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
(window as unknown as { getSelection: () => null }).getSelection ??= () => null;
(document as unknown as { getSelection: () => null }).getSelection ??= () => null;

const { Editor } = await import("@tiptap/core");
const { TextSelection } = await import("@tiptap/pm/state");
const { baseExtensions } = await import("./extensions");
const { moveBlock, duplicateBlock, deleteBlock, canMove } = await import("./block-actions");

function open(md: string) {
  const ed = new Editor({ element: null, extensions: baseExtensions(), content: md, contentType: "markdown" });
  // Commands need a view to dispatch to: a stand-in that applies the transaction.
  const view = {
    dispatch: (tr: unknown) => {
      const next = ed.state.apply(tr as never);
      Object.defineProperty(ed, "state", { value: next, configurable: true });
    },
    focus: () => undefined,
  };
  Object.defineProperty(ed, "view", { value: view, configurable: true });
  return ed;
}

/** Put the caret at the first occurrence of `text`. */
function caretAt(ed: ReturnType<typeof open>, text: string) {
  let at = -1;
  ed.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text);
    return at < 0;
  });
  assert.ok(at >= 0, `found ${text}`);
  Object.defineProperty(ed, "state", { value: ed.state.apply(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at))), configurable: true });
}

const md = (ed: ReturnType<typeof open>) => ed.getMarkdown().trim().replace(/\n{3,}/g, "\n\n");

test("a paragraph moves up and down past its neighbours", () => {
  const ed = open("One\n\nTwo\n\nThree");
  caretAt(ed, "Three");
  assert.ok(moveBlock(ed, -1));
  assert.equal(md(ed), "One\n\nThree\n\nTwo");
  assert.ok(moveBlock(ed, -1));
  assert.equal(md(ed), "Three\n\nOne\n\nTwo");
  assert.equal(canMove(ed, -1), false, "already at the top");
  assert.equal(moveBlock(ed, -1), false);
  assert.ok(moveBlock(ed, 1));
  assert.equal(md(ed), "One\n\nThree\n\nTwo");
});

test("a list's line moves within its list, then the list moves", () => {
  const ed = open("Intro\n\n- Bread\n- Milk");
  caretAt(ed, "Milk");
  assert.ok(moveBlock(ed, -1));
  assert.equal(md(ed), "Intro\n\n- Milk\n- Bread");
  // First in its list: the list moves.
  assert.ok(moveBlock(ed, -1));
  assert.equal(md(ed), "- Milk\n- Bread\n\nIntro");
});

test("the only line in a callout moves the callout", () => {
  const ed = open("Before\n\n> [!tip]\n> Book early");
  caretAt(ed, "Book");
  assert.ok(moveBlock(ed, -1));
  assert.equal(md(ed), "> [!tip]\n> Book early\n\nBefore");
});

test("a line under a callout's title doesn't move above the title", () => {
  const ed = open("> [!note]- Documents\n> Passport\n\nAfter");
  caretAt(ed, "Passport");
  // Up from the line under the title would be the toggle moving, and nothing is above it.
  assert.equal(moveBlock(ed, -1), false);
  assert.equal(md(ed), "> [!note]- Documents\n> Passport\n\nAfter");
  // Down: the whole toggle passes the next paragraph.
  assert.ok(moveBlock(ed, 1));
  assert.equal(md(ed), "After\n\n> [!note]- Documents\n> Passport");
});

test("duplicate puts a copy after it; delete takes it away", () => {
  const ed = open("Keep\n\nCopy me");
  caretAt(ed, "Copy");
  assert.ok(duplicateBlock(ed));
  assert.equal(md(ed), "Keep\n\nCopy me\n\nCopy me");
  assert.ok(deleteBlock(ed));
  assert.equal(md(ed), "Keep\n\nCopy me");
});

test("deleting the only line of a list takes the list too", () => {
  const ed = open("Keep\n\n- Alone");
  caretAt(ed, "Alone");
  assert.ok(deleteBlock(ed));
  assert.equal(md(ed), "Keep");
});
