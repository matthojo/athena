// A note's Markdown as a Word document and as a Markdown file (lib/document-make.ts).
// Run: npx tsx --test lib/document-make.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { docxParts, documentName, markdownToDocx, noteDocument, noteMarkdown } from "./document-make";

/** The paragraphs of a document.xml as [style, text], tables left out. */
const paras = (xml: string) =>
  [...xml.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) => [/<w:pStyle w:val="(\w+)"/.exec(m[1])?.[1] ?? "", [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("")]);

/** Read a stored zip back: every entry's name and text, checking sizes against the central directory. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "end of central directory");
  const out = new Map<string, string>();
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 8, true), 0, "stored");
    out.set(name, new TextDecoder().decode(bytes.subarray(local + 30 + nameLen, local + 30 + nameLen + size)));
    at += 46 + nameLen;
  }
  return out;
}

test("headings, paragraphs and marks", () => {
  const { document } = docxParts("# Plan\n\n### Detail\n\nSome **bold**, *italic*, ~~old~~ and `code`.\nSame paragraph.\n\nNext & <last>");
  assert.deepEqual(paras(document), [
    ["Heading1", "Plan"],
    ["Heading3", "Detail"],
    ["", "Some bold, italic, old and code. Same paragraph."],
    ["", "Next &amp; &lt;last&gt;"],
  ]);
  assert.match(document, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">bold</);
  assert.match(document, /<w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">italic</);
  assert.match(document, /<w:rPr><w:strike\/><\/w:rPr><w:t xml:space="preserve">old</);
  assert.match(document, /<w:rStyle w:val="InlineCode"\/><\/w:rPr><w:t xml:space="preserve">code</);
});

test("web links are links; a mention keeps its name and loses the link", () => {
  const { document, rels } = docxParts("See [the **brief**](https://example.com/a?b=1&c=2), ask [@Priya Shah](athena://person/5a3e0000-0000-4000-8000-00000000d0c1) or [mail](mailto:p@example.com). [x](javascript:alert(1))");
  assert.match(document, /<w:hyperlink r:id="rLink1" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">the </);
  assert.match(rels, /Id="rLink1"[^>]*Target="https:\/\/example.com\/a\?b=1&amp;c=2" TargetMode="External"/);
  assert.match(rels, /Id="rLink2"[^>]*Target="mailto:p@example.com"/);
  assert.equal((rels.match(/hyperlink"/g) ?? []).length, 2);
  assert.match(paras(document)[0][1], /ask Priya Shah or mail/);
  assert.doesNotMatch(document + rels, /athena:|javascript:/);
});

test("lists: bullets, numbers that start where they say, nesting, tasks", () => {
  const { document, numbering } = docxParts("- one\n- two\n  1. inner\n\n3. three\n4. four\n\n- [ ] to do\n- [x] done **well**");
  const num = (text: string) => new RegExp(`<w:ilvl w:val="(\\d)"/><w:numId w:val="(\\d)"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${text}<`).exec(document)?.slice(1, 3).join(":");
  assert.equal(num("one"), "0:1");
  assert.equal(num("two"), "0:1");
  assert.equal(num("inner"), "1:2");
  assert.equal(num("three"), "0:3");
  assert.equal(num("four"), "0:3");
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/><\/w:num>/);
  assert.match(numbering, /<w:num w:numId="3"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/);
  const tasks = paras(document).slice(-2);
  assert.deepEqual(tasks, [
    ["ListParagraph", "☐ to do"],
    ["ListParagraph", "☑ done well"],
  ]);
  assert.doesNotMatch(document.slice(document.indexOf("☐")), /numPr/);
});

test("tables, code and quotes", () => {
  const { document } = docxParts("| Item | Cost |\n|:--|--:|\n| Flights | £240 |\n\n```ts\nif (a < b) {\n\treturn;\n}\n```\n\n> Said **once**\n\n---");
  assert.equal((document.match(/<w:tr>/g) ?? []).length, 2);
  assert.match(document, /<w:trPr><w:tblHeader\/><\/w:trPr>/);
  assert.match(document, /<w:jc w:val="right"\/><\/w:pPr><w:r><w:t xml:space="preserve">£240</);
  const p = paras(document);
  assert.deepEqual(p.filter(([s]) => s === "CodeBlock").map(([, t]) => t), ["if (a &lt; b) {", "    return;", "}"]);
  assert.deepEqual(p.find(([s]) => s === "Quote"), ["Quote", "Said once"]);
  assert.match(document, /<w:pBdr><w:bottom /);
});

test("raw HTML and control characters come out as text, never markup", () => {
  const { document } = docxParts("<script>alert(1)</script>\n\nA\u0001B <b>c</b>");
  assert.doesNotMatch(document, /<script|<b>|\u0001/);
  assert.match(document, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("the .docx is a zip Word reads: the parts it needs, the same bytes each time", () => {
  const md = "# Title\n\nBody with [a link](https://example.com).\n\n- a\n- b";
  const bytes = markdownToDocx(md);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const files = unzip(bytes);
  assert.deepEqual([...files.keys()], ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"]);
  assert.equal(files.get("word/document.xml"), docxParts(md).document);
  for (const style of ["Heading1", "Heading6", "ListParagraph", "Quote", "CodeBlock", "TableText", "InlineCode", "Hyperlink"]) assert.match(files.get("word/styles.xml")!, new RegExp(`w:styleId="${style}"`));
  assert.deepEqual(markdownToDocx(md), bytes);
  // An empty note is still a document.
  assert.match(unzip(markdownToDocx("")).get("word/document.xml")!, /<w:body><w:p\/><w:sectPr>/);
});

test("the Markdown file is the note as written, under its title", () => {
  assert.equal(noteMarkdown({ title: "Trip plan", body: "Flights **booked**.\r\n\r\n- [ ] Hotel\n\n" }), "# Trip plan\n\nFlights **booked**.\n\n- [ ] Hotel\n");
  assert.equal(noteMarkdown({ title: "Trip plan", body: "# Trip plan\n\nAlready titled" }), "# Trip plan\n\nAlready titled\n");
  assert.equal(noteMarkdown({ title: "", body: "Just a thought" }), "Just a thought\n");
  assert.equal(noteMarkdown({ title: "Only a title", body: "" }), "# Only a title\n");
  assert.equal(noteMarkdown({ title: " ", body: " " }), "");
  const made = noteDocument({ title: "Trip plan", body: "Go [@Priya](athena://person/5a3e0000-0000-4000-8000-00000000d0c1)" }, "md");
  assert.equal(made.name, "Trip plan.md");
  assert.equal(new TextDecoder().decode(made.bytes), "# Trip plan\n\nGo [@Priya](athena://person/5a3e0000-0000-4000-8000-00000000d0c1)\n");
});

test("file names are safe everywhere", () => {
  assert.equal(documentName("Q3: plan / budget?", "docx"), "Q3 plan budget.docx");
  assert.equal(documentName("  ..hidden.  ", "md"), "hidden.md");
  assert.equal(documentName("", "docx"), "Untitled note.docx");
  assert.equal(documentName("x".repeat(300), "md").length, 123);
  assert.equal(documentName("Café ☕ notes", "docx"), "Café ☕ notes.docx");
});
