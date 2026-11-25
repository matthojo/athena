// Shared note templates (lib/template-share.ts): the format and its reader, the body made plain so nothing in it
// fetches, making one from a template the owner wrote (scrubbed and checked), a free name for one being added, and
// the template kind's place in Community (its file, a lone file renamed on the way, its reach). Made-up data only.
// Run: npx tsx --test lib/template-share.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportTemplate, freeTemplateName, plainTemplateBody, readSharedTemplate, serialiseSharedTemplate, TEMPLATE_FILE, TEMPLATE_SHARE_LIMITS, templateSlug } from "./template-share";
import { ShareFormatError, type KnownTerm } from "./team-share";
import { reachOf } from "./reach";
import { itemFiles, buildPreview, NewerFormatError, checkFormat } from "./community-add";

const FILE = {
  format: 1,
  name: "Gratitude page",
  summary: "Three things you're grateful for, and one small moment to keep.",
  version: "1.1",
  author: "kind-margins",
  body: "# Gratitude, {{date}}\n\nThree things I'm grateful for:\n1. \n2. \n3. \n\n## A small moment I want to remember\n",
};
const isShareError = (re: RegExp) => (e: unknown) => e instanceof ShareFormatError && re.test(e.message);
const utf8 = new TextEncoder();

test("a template file reads as its name, summary, header and body, and nothing else", () => {
  const t = readSharedTemplate({ ...FILE, id: "11111111-1111-4111-8111-111111111111", starter: "meeting", notes: ["a note made from it"], fields: ["date"] });
  assert.deepEqual(Object.keys(t).sort(), ["author", "body", "format", "name", "summary", "version"]);
  assert.equal(t.name, "Gratitude page");
  assert.equal(t.body, FILE.body.trimEnd());
  // A header that doesn't fit is left out, never refused.
  const loose = readSharedTemplate({ ...FILE, author: "not a github name!", version: "v 1 . 0", based_on: "https://somewhere.example.com/x" });
  assert.equal(loose.author, undefined);
  assert.equal(loose.version, undefined);
  assert.equal(loose.based_on, undefined);
});

test("every word is checked against the template limits", () => {
  assert.throws(() => readSharedTemplate({ ...FILE, name: "" }), isShareError(/name: missing/));
  assert.throws(() => readSharedTemplate({ ...FILE, name: "x".repeat(TEMPLATE_SHARE_LIMITS.name + 1) }), isShareError(/name: over 80/));
  assert.throws(() => readSharedTemplate({ ...FILE, summary: "x".repeat(TEMPLATE_SHARE_LIMITS.summary + 1) }), isShareError(/summary: over 400/));
  assert.throws(() => readSharedTemplate({ ...FILE, body: "x".repeat(TEMPLATE_SHARE_LIMITS.body + 1) }), isShareError(/body: over 20000/));
  assert.throws(() => readSharedTemplate({ ...FILE, body: "  \n\n " }), isShareError(/body: missing/));
  assert.throws(() => readSharedTemplate({ ...FILE, body: ["# A list"] }), isShareError(/body: should be text/));
  assert.throws(() => readSharedTemplate("just words"), isShareError(/should hold an object/));
  assert.throws(() => readSharedTemplate({ ...FILE, format: 2 }), isShareError(/newer Athena/));
  assert.throws(() => readSharedTemplate({ ...FILE, format: "1" }), isShareError(/needs "format": 1/));
  // The name and summary are one line each; the body keeps its lines, without control characters.
  const t = readSharedTemplate({ ...FILE, name: "Gratitude\n page", body: "# Hi\r\n\r\nLine\u0007 two\ttabbed" });
  assert.equal(t.name, "Gratitude page");
  assert.equal(t.body, "# Hi\n\nLine two\ttabbed");
});

test("the body is made plain: nothing in it can make Athena fetch anything by itself", () => {
  const body = [
    "Watch [a walk](https://video.example.com/walk \"embed\") and [the shop](https://shop.example.com \"card\").",
    "![A sunset](https://images.example.com/sunset.jpg)",
    "<img src=\"https://images.example.com/pixel.gif\"><iframe src=\"https://video.example.com/x\"></iframe>",
    "<!-- a comment with <img src=\"https://images.example.com/y.gif\"> -->Ask [Priya](athena://person/11111111-1111-4111-8111-111111111111 \"card\") how it went.",
    "  - a nested line, kept at its depth, about [Sam](athena://person/22222222-2222-4222-8222-222222222222)",
    "A plain [link](https://example.com) stays, and so does <https://example.com/autolink> and <3.",
  ].join("\n");
  const plain = plainTemplateBody(body);
  assert.equal(
    plain,
    [
      "Watch [a walk](https://video.example.com/walk) and [the shop](https://shop.example.com).",
      "[A sunset](https://images.example.com/sunset.jpg)",
      "",
      "Ask Priya how it went.",
      "  - a nested line, kept at its depth, about Sam",
      "A plain [link](https://example.com) stays, and so does <https://example.com/autolink> and <3.",
    ].join("\n"),
  );
  // Reading a file does the same.
  assert.equal(readSharedTemplate({ ...FILE, body }).body, plain);
  // A body with nothing to make plain is left exactly as it was.
  assert.equal(plainTemplateBody(FILE.body), FILE.body);
});

test("a template file is written as two-space JSON and reads back the same", () => {
  const t = readSharedTemplate(FILE);
  const text = serialiseSharedTemplate(t);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(readSharedTemplate(JSON.parse(text)), t);
});

const KNOWN: KnownTerm[] = [
  { term: "Priya Shah", kind: "person" },
  { term: "Priya", kind: "person", loose: true },
  { term: "12 Example Street", kind: "address" },
];

test("sharing a template: links into the owner's Athena out, their own details flagged until settled", () => {
  const t = {
    name: "Sunday letter to Priya",
    body: "# Dear {{person}}\n\nSee [the trip](https://athena.example.com/#/trips/1) and [Priya Shah](athena://person/11111111-1111-4111-8111-111111111111).\n\nWrite to 12 Example Street, or priya@realmail.test.\n\n- [ ] Post it",
  };
  const x = exportTemplate(t, { ownHosts: ["athena.example.com"], known: KNOWN, edits: { summary: "A slow letter, once a week.", author: "@kind-margins", version: "1.0" } });
  assert.equal(x.shared.name, "Sunday letter to Priya");
  assert.equal(x.shared.author, "kind-margins");
  assert.equal(x.slug, "sunday-letter-to-priya");
  assert.ok(!x.shared.body.includes("athena://"));
  assert.ok(!x.shared.body.includes("athena.example.com"));
  assert.ok(x.shared.body.includes("- [ ] Post it"));
  assert.deepEqual(
    x.removed.map((r) => r.kind).sort(),
    ["athena-link", "site-link"],
  );
  assert.deepEqual(
    x.findings.map((f) => `${f.kind} ${f.term} in ${f.where.join(", ")}`).sort(),
    ["address 12 Example Street in body", "email priya@realmail.test in body", "person Priya Shah in body", "person Priya in name"],
  );
  // Marked fine, they're settled; the sheet's name wins over the template's own.
  const fine = exportTemplate(t, { ownHosts: ["athena.example.com"], known: KNOWN, edits: { name: "Sunday letter" }, fine: x.findings.map((f) => f.id) });
  assert.deepEqual(fine.findings, []);
  assert.equal(fine.shared.name, "Sunday letter");
  // Made-up contact details are never flagged.
  assert.deepEqual(exportTemplate({ name: "Call", body: "Ring 07700 900123 or write to someone@example.com" }, { ownHosts: [], known: KNOWN }).findings, []);
});

test("sharing an empty template, or one with no name, is refused in words", () => {
  assert.throws(() => exportTemplate({ name: "   ", body: "# Hi" }, { ownHosts: [], known: [] }), isShareError(/Give the template a name/));
  assert.throws(() => exportTemplate({ name: "Empty", body: "\n\n" }, { ownHosts: [], known: [] }), isShareError(/That template is empty/));
});

test("a free name: its own when nobody has it, else a number on the end", () => {
  assert.equal(freeTemplateName("Gratitude page", ["Meeting notes", "Weekly review"]), "Gratitude page");
  assert.equal(freeTemplateName("Weekly review", ["Meeting notes", "weekly  review"]), "Weekly review (2)");
  assert.equal(freeTemplateName("Weekly review", ["Weekly review", "Weekly review (2)"]), "Weekly review (3)");
  const long = "x".repeat(80);
  assert.equal(freeTemplateName(long, [long]).length, 80);
  assert.ok(freeTemplateName(long, [long]).endsWith(" (2)"));
  assert.equal(templateSlug("Year-end reflection"), "year-end-reflection");
  assert.equal(templateSlug("✨"), "template");
});

test("Community: template.json names a template, a renamed lone file is read by what it holds, and it's always tier 1", async () => {
  const text = JSON.stringify(FILE);
  const files = itemFiles([{ path: "gratitude-page/template.json", bytes: utf8.encode(text) }]);
  assert.equal(files.kind, "template");
  assert.deepEqual(files.files.map((f) => f.path), [TEMPLATE_FILE]);
  // Downloaded twice and renamed on the way.
  assert.equal(itemFiles([{ path: "gratitude (1).json", bytes: utf8.encode(text) }]).kind, "template");
  // Fields fill from the owner's own records and nothing fetches: tier 1, whatever the file says.
  assert.deepEqual(reachOf({ files: [{ path: TEMPLATE_FILE, text: JSON.stringify({ ...FILE, reach: { tier: 3 }, body: "{{open loops}} [x](https://e.example.com \"embed\")" }) }] }), { tier: 1, model: false, web: false, lookups: [], needs: [] });
  const p = await buildPreview({ files, from: { files: "gratitude-page" }, source: { kind: "upload", at: "2026-11-25T00:00:00Z" } });
  assert.equal(p.kind, "template");
  assert.equal(p.name, "Gratitude page");
  assert.equal(p.header.author, "kind-margins");
  assert.equal(p.item.kind === "template" && p.item.template.body, FILE.body.trimEnd());
  assert.throws(() => checkFormat("template", [{ path: TEMPLATE_FILE, text: JSON.stringify({ ...FILE, format: 2 }) }]), (e: unknown) => e instanceof NewerFormatError);
});
