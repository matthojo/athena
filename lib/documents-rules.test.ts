// Run: npx tsx --test lib/documents-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOC_MIME,
  DRIVE_FILES_URL,
  FOLDER_MIME,
  docsLink,
  googleDocsRequestProblem,
  inlineSpans,
  markdownToDocsRequests,
  notionCreated,
  notionId,
  notionLink,
  notionWriteProblem,
} from "./documents-rules";

test("Markdown becomes one insert plus heading, list and text styles", () => {
  const reqs = markdownToDocsRequests("# Design review\n\nWith **Priya** and [the brief](https://example.com/b)\n\n- one\n- two\n\n1. first\n- [ ] call Tom\n\n---\nSee [@Priya](athena://person/11111111-1111-4111-8111-111111111111)");
  const insert = reqs[0] as { insertText: { location: { index: number }; text: string } };
  assert.equal(insert.insertText.location.index, 1);
  assert.equal(insert.insertText.text, "Design review\nWith Priya and the brief\none\ntwo\nfirst\ncall Tom\nSee Priya\n");
  const json = JSON.stringify(reqs);
  assert.match(json, /"namedStyleType":"HEADING_1"/);
  assert.match(json, /"bold":true/);
  assert.match(json, /"link":\{"url":"https:\/\/example.com\/b"\}/);
  assert.doesNotMatch(json, /athena:\/\//);
  const bullets = reqs.filter((r) => "createParagraphBullets" in r) as Array<{ createParagraphBullets: { range: { startIndex: number; endIndex: number }; bulletPreset: string } }>;
  assert.deepEqual(
    bullets.map((b) => b.createParagraphBullets.bulletPreset),
    ["BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN", "BULLET_CHECKBOX"],
  );
  // "one\ntwo\n" is one list: from after the heading and paragraph to the end of "two".
  const text = insert.insertText.text;
  const from = 1 + text.indexOf("one");
  assert.deepEqual(bullets[0].createParagraphBullets.range, { startIndex: from, endIndex: from + "one\ntwo\n".length });
  // Bold covers exactly "Priya".
  const bold = reqs.find((r) => "updateTextStyle" in r && JSON.stringify(r).includes("bold")) as { updateTextStyle: { range: { startIndex: number; endIndex: number } } };
  assert.equal(text.slice(bold.updateTextStyle.range.startIndex - 1, bold.updateTextStyle.range.endIndex - 1), "Priya");
});

test("indexes count UTF-16 code units, as Google does", () => {
  const reqs = markdownToDocsRequests("😀 **b**");
  const style = reqs.find((r) => "updateTextStyle" in r) as { updateTextStyle: { range: { startIndex: number } } };
  assert.equal(style.updateTextStyle.range.startIndex, 1 + "😀 ".length);
  assert.deepEqual(markdownToDocsRequests("\n\n"), []);
});

test("inline spans: italic underscores don't split snake_case", () => {
  assert.deepEqual(inlineSpans("a snake_case_name"), [{ text: "a snake_case_name" }]);
  assert.deepEqual(inlineSpans("_yes_"), [{ text: "yes", italic: true }]);
});

const FOLDER = "folderAAAAAAAAAA";
const DOC = "docBBBBBBBBBBBBBB";
const owned = new Set([FOLDER, DOC]);

test("Google: only Athena's folder, docs inside it, and edits to its own docs", () => {
  const ok = (r: Parameters<typeof googleDocsRequestProblem>[0]) => googleDocsRequestProblem(r, owned);
  assert.equal(ok({ method: "GET", url: `${DRIVE_FILES_URL}?q=${encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='Athena' and trashed=false`)}` }), null);
  assert.equal(ok({ method: "POST", url: `${DRIVE_FILES_URL}?fields=id`, body: { name: "Athena", mimeType: FOLDER_MIME } }), null);
  assert.equal(ok({ method: "POST", url: `${DRIVE_FILES_URL}?fields=id,webViewLink`, body: { name: "Design review", mimeType: DOC_MIME, parents: [FOLDER] } }), null);
  assert.equal(ok({ method: "POST", url: `https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`, body: { requests: [{ insertText: { location: { index: 1 }, text: "x" } }] } }), null);
  assert.equal(ok({ method: "GET", url: `https://docs.googleapis.com/v1/documents/${DOC}` }), null);
  assert.equal(ok({ method: "PATCH", url: `${DRIVE_FILES_URL}/${DOC}`, body: { trashed: true } }), null);
  assert.equal(ok({ method: "PATCH", url: `${DRIVE_FILES_URL}/${DOC}`, body: { name: "Design review v2" } }), null);
  assert.equal(ok({ method: "GET", url: `https://docs.googleapis.com/v1/documents/${DOC}?fields=body.content(endIndex)` }), null);
});

test("Google: anything else is refused", () => {
  const no = (r: Parameters<typeof googleDocsRequestProblem>[0]) => assert.notEqual(googleDocsRequestProblem(r, owned), null, JSON.stringify(r));
  const other = "someoneElsesDoc123";
  no({ method: "GET", url: DRIVE_FILES_URL });
  no({ method: "GET", url: `${DRIVE_FILES_URL}?q=name%3D'Taxes'` });
  no({ method: "GET", url: `https://docs.googleapis.com/v1/documents/${other}` });
  no({ method: "POST", url: `https://docs.googleapis.com/v1/documents/${other}:batchUpdate`, body: { requests: [{ insertText: {} }] } });
  no({ method: "POST", url: `https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`, body: { requests: [{ replaceAllText: {} }] } });
  no({ method: "POST", url: `https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`, body: { requests: [{ insertText: {}, deleteContentRange: {} }] } });
  no({ method: "PATCH", url: `${DRIVE_FILES_URL}/${other}`, body: { trashed: true } });
  no({ method: "PATCH", url: `${DRIVE_FILES_URL}/${DOC}`, body: { trashed: true, name: "x" } });
  no({ method: "PATCH", url: `${DRIVE_FILES_URL}/${DOC}`, body: { parents: ["x"] } });
  no({ method: "PATCH", url: `${DRIVE_FILES_URL}/${other}`, body: { name: "x" } });
  no({ method: "PATCH", url: `${DRIVE_FILES_URL}/${DOC}?addParents=x`, body: { trashed: true } });
  no({ method: "POST", url: `${DRIVE_FILES_URL}`, body: { name: "x", mimeType: DOC_MIME, parents: ["rootFolder1234"] } });
  no({ method: "POST", url: `${DRIVE_FILES_URL}`, body: { name: "Other", mimeType: FOLDER_MIME } });
  no({ method: "POST", url: `${DRIVE_FILES_URL}`, body: { name: "x", mimeType: "application/pdf", parents: [FOLDER] } });
  no({ method: "POST", url: `${DRIVE_FILES_URL}/${DOC}/copy`, body: {} });
  no({ method: "GET", url: `http://www.googleapis.com/drive/v3/files?q=x` });
  no({ method: "GET", url: `https://evil.example/drive/v3/files` });
});

test("Google: a link is only shown when it's the doc's own", () => {
  assert.equal(docsLink(`https://docs.google.com/document/d/${DOC}/edit?usp=drivesdk`, DOC), `https://docs.google.com/document/d/${DOC}/edit?usp=drivesdk`);
  assert.equal(docsLink("https://evil.example/x", DOC), `https://docs.google.com/document/d/${DOC}/edit`);
  assert.equal(docsLink(`https://docs.google.com/document/d/${other()}/edit`, DOC), `https://docs.google.com/document/d/${DOC}/edit`);
});
const other = () => "otherCCCCCCCCCCC";

const PARENT = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";
const MINE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THEIRS = "ffffffffffff4fffbfffffffffffffff";
const rules = { parentId: PARENT, own: new Set([MINE]) };

test("Notion: create only under the chosen parent, one page, title and Markdown", () => {
  const create = (args: unknown) => notionWriteProblem("notion-create-pages", args, rules);
  assert.equal(create({ parent: { page_id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9" }, pages: [{ properties: { title: "Design review" }, content: "# Hi" }] }), null);
  assert.notEqual(create({ parent: { page_id: THEIRS }, pages: [{ properties: { title: "x" } }] }), null);
  assert.notEqual(create({ parent: { database_id: PARENT }, pages: [{ properties: { title: "x" } }] }), null);
  assert.notEqual(create({ parent: { page_id: PARENT }, pages: [{}, {}] }), null);
  assert.notEqual(create({ parent: { page_id: PARENT }, pages: [{ properties: { title: "x", Status: "Done" } }] }), null);
  assert.notEqual(notionWriteProblem("notion-create-pages", { parent: { page_id: PARENT }, pages: [{}] }, { parentId: null, own: new Set() }), null);
});

test("Notion: updates only to pages Athena made; never move, delete or anything else", () => {
  const update = (data: unknown) => notionWriteProblem("notion-update-page", { data }, rules);
  assert.equal(update({ page_id: MINE.replace(/-/g, ""), command: "insert_content_after", new_str: "More" }), null);
  assert.equal(update({ page_id: MINE, command: "update_properties", properties: { title: "Undone in Athena" } }), null);
  assert.equal(update({ page_id: MINE, command: "replace_content", new_str: "" }), null);
  assert.notEqual(update({ page_id: THEIRS, command: "insert_content_after", new_str: "More" }), null);
  assert.notEqual(update({ page_id: THEIRS, command: "replace_content", new_str: "" }), null);
  assert.notEqual(update({ page_id: MINE, command: "replace_content_range", new_str: "x" }), null);
  assert.notEqual(update({ page_id: MINE, command: "update_properties", properties: { archived: true } }), null);
  for (const name of ["notion-duplicate-page", "notion-delete-page", "notion-create-database", "notion-update-page-properties", "Notion-Create-Pages", "notion-create-pages "]) {
    assert.notEqual(notionWriteProblem(name, {}, rules), null, name);
  }
});

test("Notion: ids and links", () => {
  assert.equal(notionId("https://www.notion.so/Design-review-1a2b3c4d5e6f40718293a4b5c6d7e8f9"), PARENT);
  assert.equal(notionId("nope"), null);
  assert.deepEqual(notionCreated(`Created 1 page: {"id":"x","url":"https://www.notion.so/Design-review-${PARENT}"}`), { id: PARENT, url: `https://www.notion.so/Design-review-${PARENT}` });
  assert.equal(notionLink("https://evil.example/" + PARENT, PARENT), `https://www.notion.so/${PARENT}`);
});

const REMOVED = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

test("Notion: Undo moves only a page Athena made, only under its own Removed by Athena page", () => {
  const own = new Set([MINE, REMOVED]);
  const move = (args: unknown, removedId: string | null = REMOVED) => notionWriteProblem("notion-move-pages", args, { parentId: PARENT, own, removedId });
  assert.equal(move({ page_or_database_ids: [MINE], new_parent: { page_id: REMOVED } }), null);
  assert.equal(move({ page_or_database_ids: [MINE.replace(/-/g, "")], new_parent: { type: "page_id", page_id: REMOVED } }), null);
  assert.notEqual(move({ page_or_database_ids: [THEIRS], new_parent: { page_id: REMOVED } }), null, "not the owner's own pages");
  assert.notEqual(move({ page_or_database_ids: [MINE], new_parent: { page_id: PARENT } }), null, "nowhere but Removed by Athena");
  assert.notEqual(move({ page_or_database_ids: [MINE, REMOVED], new_parent: { page_id: REMOVED } }), null, "one page at a time");
  assert.notEqual(move({ page_or_database_ids: [MINE], new_parent: { page_id: REMOVED } }, null), null, "no Removed page yet");
  assert.notEqual(move({ page_or_database_ids: [MINE], new_parent: { page_id: THEIRS } }, THEIRS), null, "a Removed page Athena didn't make");
  assert.notEqual(move({ page_or_database_ids: [MINE], new_parent: { database_id: REMOVED } }), null);
  assert.notEqual(move({ page_or_database_ids: [REMOVED], new_parent: { page_id: REMOVED } }), null);
});
