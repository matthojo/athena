// The shape of an answer's text (lib/answer-text.ts): paragraphs, "- " and "1. " list lines and **bold**, nothing else.
// Run: npx tsx --test lib/answer-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MAX_CHARS, answerProse, answerProseSoFar, citationParts, citedNumbers, renumberCitations, stripCitations } from "./answer-text";

test("a short answer is one paragraph, as before", () => {
  assert.equal(answerProse("Gayle wants  15% off [1].\nShe said so on Tuesday [2]."), "Gayle wants 15% off [1]. She said so on Tuesday [2].");
  assert.equal(answerProse("  "), "");
});

test("paragraphs are split by one blank line; a list is one block, a line per item", () => {
  assert.equal(answerProse("First.\n\n\n\nSecond.\r\n\r\nThird."), "First.\n\nSecond.\n\nThird.");
  assert.equal(answerProse("To bring:\n- Passport [1]\n- Adaptor\nThen go."), "To bring:\n\n- Passport [1]\n- Adaptor\n\nThen go.");
});

test("stars, bullets, nested items and task boxes become \"- \" lines", () => {
  assert.equal(answerProse("* one\n• two\n   - nested\n- [ ] box\n- [x] ticked"), "- one\n- two\n- nested\n- box\n- ticked");
});

test("numbered steps keep their numbers: \"1. \" lines, one block, apart from dashes", () => {
  assert.equal(answerProse("To renew:\n1. Fill in the form [1]\n2) **Pay:** £88.50\n03. Post it\nDone."), "To renew:\n\n1. Fill in the form [1]\n2. **Pay:** £88.50\n3. Post it\n\nDone.");
  // Dashes under a step are their own block, and the steps carry on from the last number.
  assert.equal(answerProse("1. Pack\n   - Passport\n   - Adaptor\n2. Go\n\nA note.\n\n3. Land"), "1. Pack\n\n- Passport\n- Adaptor\n\n2. Go\n\nA note.\n\n3. Land");
  // The model's own numbers stay, whatever they are; a longer number isn't a step.
  assert.equal(answerProse("3. three\n7. seven"), "3. three\n7. seven");
  assert.equal(answerProse("2026. A year, not a step."), "2026. A year, not a step.");
  assert.equal(renumberCitations("1. Fill in the form [2]\n2. Pay [1]", new Map([[2, 1]])), "1. Fill in the form [1]\n2. Pay");
  assert.deepEqual(citationParts("1. Fill it in [1]\n2. Pay"), ["1. Fill it in", 1, "\n2. Pay"]);
  assert.equal(stripCitations("Steps:\n\n1. Fill it in [1]\n2. **Pay**"), "Steps: 1. Fill it in 2. Pay");
});

test("bold survives when it opens and closes on a line; every other mark goes", () => {
  assert.equal(answerProse("**Thursday** is free, *maybe* `Friday` too."), "**Thursday** is free, maybe Friday too.");
  assert.equal(answerProse("- **Flights:** TAP at 07:10 [1]"), "- **Flights:** TAP at 07:10 [1]");
  assert.equal(answerProse("An **unclosed bold\nnext line"), "An unclosed bold next line");
  assert.equal(answerProse("__init__ stays readable"), "init stays readable");
  assert.equal(answerProse("5 * 4 = 20"), "5 4 = 20".replace("5 4", "5 4"), "a lone star isn't kept");
});

test("a heading is a bold line, a rule is a break, a quote is a paragraph", () => {
  assert.equal(answerProse("# Plan:\nDo it.\n\n---\n\n> Quoted words\n### **Next**"), "**Plan**\n\nDo it.\n\nQuoted words\n\n**Next**");
});

test("too long is cut at the end of a line or sentence, with an ellipsis and no open bold", () => {
  const long = Array.from({ length: 400 }, (_, i) => `- Item ${i} with some words`).join("\n");
  const cut = answerProse(long);
  assert.ok(cut.length <= ANSWER_MAX_CHARS);
  assert.match(cut, /with some words…$/);
  const bold = answerProse(`${"word ".repeat(18)}**never closed in time ${"x".repeat(40)}**`, 100);
  assert.ok(!bold.includes("**"));
  assert.ok(bold.endsWith("…") && bold.length <= 100);
});

test("markers keep working across lines: renumbered, dropped, split and said aloud", () => {
  const text = "Two things:\n\n- **Flights** booked [2]\n- Hotel pending [1][3]";
  assert.deepEqual(citedNumbers(text), [2, 1, 3]);
  assert.equal(renumberCitations(text, new Map([[2, 1], [1, 2]])), "Two things:\n\n- **Flights** booked [1]\n- Hotel pending [2]");
  assert.equal(renumberCitations("Line one\n[1] line two", new Map()), "Line one\nline two", "a dropped marker never joins two lines");
  assert.deepEqual(citationParts("A [1]\n\nB"), ["A", 1, "\n\nB"]);
  assert.equal(stripCitations(text), "Two things: Flights booked Hotel pending");
});

test("while it's written, the text arrives in its final shape and nothing is taken back", () => {
  const written = "March is mild, so pack **light layers**.\nBring a jacket.\n\n## Clothes\n\n1. Two jumpers [1]\n2. **Shoes:** trainers with grip\n* A waterproof\n\nLeave room for *sardines*.";
  let shown = "";
  let takenBack = 0;
  for (let i = 1; i <= written.length; i++) {
    const now = answerProseSoFar(written.slice(0, i));
    if (!now.startsWith(shown)) takenBack++;
    assert.ok(!/\*\*[^*\n]*$/.test(now.split("\n").pop()!) || (now.split("\n").pop()!.match(/\*\*/g)!.length % 2 === 0), `no open bold at ${i}: ${JSON.stringify(now.slice(-30))}`);
    assert.doesNotMatch(now, /(^|\n)(#|\d\.?$|\d\. ?$|\* )/, `no raw marker at ${i}`);
    shown = now;
  }
  assert.equal(takenBack, 0);
  assert.equal(shown, answerProse(written));
  assert.equal(answerProseSoFar("Done.\n\n-"), "Done.");
  assert.equal(answerProseSoFar("Done.\n\n- A"), "Done.\n\n- A");
  // A number is held until its step has a word, then shown as it will stay.
  assert.equal(answerProseSoFar("Done.\n\n1"), "Done.");
  assert.equal(answerProseSoFar("Done.\n\n1. "), "Done.");
  assert.equal(answerProseSoFar("Done.\n\n1. A"), "Done.\n\n1. A");
  assert.equal(answerProseSoFar("Done.\n\n1. A\n2) B"), "Done.\n\n1. A\n2. B");
  assert.equal(answerProseSoFar("Take **two"), "Take");
  assert.equal(answerProseSoFar("Take **two** and"), "Take **two** and");
});
