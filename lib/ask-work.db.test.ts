// Ask's `work` tool (lib/ask-tools.ts) on a real database: the owner's own issues and PRs as the work sync stores
// them (lib/work.ts, sealed), Work activity's notes, the counts against the span before, a project, the refs it
// cites, and that storage refuses anything about anyone else.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/ask-work.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties work_items and Work activity's notes first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
}
const TZ = "Europe/London";

test("Ask's work tool: counts, projects, cycle time and notes, own work only, cited as the Work page", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw, createNote } = await import("./db");
  const { saveWorkItems, readWorkItems } = await import("./work");
  const { ReadTools, READ_TOOL_NAMES } = await import("./ask-tools");
  await qRaw(`DELETE FROM work_items`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'work-activity%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const w = await saveWorkItems([
    { source: "linear", id: "i1", identifier: "ENG-1", title: "Card form validates postcodes", project: "Checkout", started: "2026-11-02T09:00:00Z", completed: "2026-11-04T09:00:00Z", estimate: 3 },
    { source: "linear", id: "i2", identifier: "ENG-2", title: "Retry webhooks", project: "Billing", started: "2026-11-05T09:00:00Z", completed: "2026-11-06T09:00:00Z" },
    { source: "linear", id: "i3", identifier: "ENG-3", title: "Archive old carts", project: "Checkout", started: "2026-10-01T09:00:00Z", completed: "2026-10-03T09:00:00Z" },
    { source: "linear", id: "i4", identifier: "ENG-4", title: "Saved cards", project: "Checkout", started: "2026-11-10T09:00:00Z", state: "In Progress" },
    { source: "github", id: "acme/app#7", repo: "acme/app", number: 7, title: "Postcode check", role: "opened", opened: "2026-11-03T09:00:00Z", merged: "2026-11-03T13:00:00Z", reviews: 1 },
    // Fields about other people never reach storage, whatever a caller passes.
    { source: "github", id: "acme/api#9", repo: "acme/api", number: 9, title: "Their change", role: "reviewed", reviewed_at: "2026-11-04T10:00:00Z", author: "priya-teammate", assignee: "Priya" } as never,
  ]);
  assert.equal(w.created, 5, "the PR with an author field is refused outright");
  assert.ok(!JSON.stringify((await readWorkItems()).items).includes("priya"));
  // Saving again changes nothing.
  assert.deepEqual(await saveWorkItems([{ source: "linear", id: "i1", identifier: "ENG-1", title: "Card form validates postcodes", project: "Checkout", started: "2026-11-02T09:00:00Z", completed: "2026-11-04T09:00:00Z", estimate: 3 }]), { created: 0, updated: 0, unchanged: 1 });

  await createNote({ title: "Blocked on the payments sandbox", body: "Waiting for access.", source: "work-activity", tags: ["blocked", "Checkout"] });
  await createNote({ title: "Shipped postcode checks", body: "Live for everyone.", source: "work-activity", tags: ["shipped"] });

  const cited = new Map<string, string>();
  const t = new ReadTools({ tz: TZ, now: new Date("2026-11-12T10:00:00Z"), cite: (kind, id, title) => (cited.set(`${kind}:${id}`, title), `${kind}:${id}`) });
  assert.ok(READ_TOOL_NAMES.has("work"));
  const out = JSON.parse(await t.run("work", {}));
  assert.equal(out.ref, "work:month");
  assert.equal(cited.get("work:month"), "Work · This month");
  assert.deepEqual({ i: out.issues_closed, p: out.prs_merged }, { i: 2, p: 1 });
  assert.deepEqual(out.before, { label: "October", issues_closed: 1, prs_merged: 0 });
  assert.deepEqual(out.projects, [{ name: "Checkout", issues_closed: 1, points: 3 }, { name: "Billing", issues_closed: 1, points: 0 }], "a tie broken by points");
  assert.equal(out.cycle_days.median, 1.5);
  assert.equal(out.open_to_merge_hours.median, 4);
  assert.deepEqual(out.code, { opened: 1, merged: 1, merged_for_others: 0, reviewed: 0, open_now: 0, repos: [{ repo: "acme/app", merged: 1 }] });
  assert.deepEqual(out.assigned_open.map((i: { identifier: string }) => i.identifier), ["ENG-4"]);
  assert.equal(out.notes[0].kind, "stuck", "open blockers first");
  assert.equal(out.notes[0].open, true);
  assert.match(out.notes[0].ref, /^note:[0-9a-f-]{36}$/);

  const project = JSON.parse(await t.run("work", { project: "Checkout" }));
  assert.equal(project.issues_closed, 2);
  assert.equal(project.issues[0].identifier, "ENG-4", "open first");
  assert.match(await t.run("work", { project: "Nope" }), /None of the owner's issues are in a project called "Nope"/);
  await assert.rejects(t.run("work", { period: "last week" }));
});
