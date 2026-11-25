// Shared note templates in plain words (components/template-share-words.ts) and the templates a day's journal can
// start from (components/journal-start.ts journalTemplates). Made-up data only.
// Run: npx tsx --test app/src/components/template-share-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedByWords, sharedChangeWords, templateFindingsLede, templateReachWords, templateWhereWords } from "./template-share-words";

test("the share sheet: always stays in Athena, and says where each finding is", () => {
  assert.equal(templateReachWords().title, "Stays in Athena");
  assert.equal(templateReachWords().icon, "shield");
  assert.equal(templateWhereWords(["body"]), "In the words");
  assert.equal(templateWhereWords(["name", "body", "body"]), "In the name and the words");
  assert.equal(templateWhereWords(["name", "summary", "body"]), "In the name, the summary and the words");
  assert.match(templateFindingsLede(0), /^Nothing is flagged/);
  assert.match(templateFindingsLede(2), /^These look like some of your own details/);
});

test("an added template says who shared it, and what changing it means", () => {
  assert.equal(sharedByWords({ author: "kind-margins", version: "1.0", catalogue_id: "g7h2j6k1m5n9p4q8" }), "Shared by @kind-margins · version 1.0");
  assert.equal(sharedByWords({ author: null, version: null, catalogue_id: "g7h2j6k1m5n9p4q8" }), "Shared through Community");
  assert.equal(sharedByWords({ author: null, version: "2", catalogue_id: null }), "Shared from a file · version 2");
  assert.match(sharedChangeWords(false), /never overwrites your changes/);
  assert.match(sharedChangeWords(true), /it's yours now/);
});

test("a journal starts from the owner's own templates and the ones they added, never Athena's starters", async () => {
  const { journalTemplates } = await import("./template-share-words");
  const t = (id: string, starter: string | null, shared: boolean) => ({ id, starter, name: id, blurb: "", body: "", fields: [], needs: [], edited: !starter, updated_at: null, shared: shared ? { author: null, version: null, summary: "", catalogue_id: null, changed: false } : null });
  assert.deepEqual(
    journalTemplates([t("starter:weekly-review", "weekly-review", false), t("mine", null, false), t("added", null, true)]).map((x) => x.id),
    ["mine", "added"],
  );
});
