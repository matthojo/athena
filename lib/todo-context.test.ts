// To-do contexts: Athena's rules for choosing one, names, filters and grouping.
// Run: npx tsx --test lib/todo-context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STARTER_CONTEXTS,
  accountOf,
  chooseContext,
  cleanContextName,
  contextByName,
  filterByContext,
  groupByContext,
  hintKey,
  type TodoContext,
} from "./todo-context";

const at = "2026-11-01T00:00:00.000Z";
const CONTEXTS: TodoContext[] = STARTER_CONTEXTS.map((s, i) => ({
  id: `${s.kind}-${s.key}`,
  kind: s.kind,
  key: s.key,
  name: s.name,
  icon: s.icon,
  colour: s.colour,
  position: i,
  archived_at: null,
  created_at: at,
  updated_at: at,
}));
const own = (kind: "area" | "where", name: string, extra: Partial<TodoContext> = {}): TodoContext => ({
  id: `${kind}-own-${name.toLowerCase()}`,
  kind,
  key: null,
  name,
  icon: "tag",
  colour: "grey",
  position: 50,
  archived_at: null,
  created_at: at,
  updated_at: at,
  ...extra,
});
const name = (id: string | null) => (id ? CONTEXTS.concat(own("area", "Garden"), own("where", "Gym")).find((c) => c.id === id)?.name ?? id : null);
const choose = (s: Parameters<typeof chooseContext>[0], contexts = CONTEXTS) => {
  const c = chooseContext(s, contexts);
  return { area: name(c.area_id), where: name(c.where_id), why: c.why };
};

test("the owner's examples", () => {
  assert.deepEqual(choose({ title: "Call the dentist", source: "assistant" }), { area: "Health", where: "Phone", why: { area: "words", where: "words" } });
  assert.deepEqual(choose({ title: "Buy milk", source: "assistant" }), { area: null, where: "Errands", why: { where: "words" } });
  // A work Slack, Linear or work email item is Work, whatever the words say.
  assert.equal(choose({ title: "Reply to Sam about the offsite", source: "work-activity" }).area, "Work");
  assert.equal(choose({ title: "Fix the flaky test", source: "linear" }).area, "Work");
  assert.equal(choose({ title: "Send the invoice", source: "email-digest-work" }).area, "Work");
  assert.equal(choose({ title: "Book the dentist", source: "email-digest", label: "Work" }).area, "Work");
});

test("ambiguous things stay blank", () => {
  assert.deepEqual(choose({ title: "Sort out the thing we talked about", source: "calendar-meetings" }), { area: null, where: null, why: {} });
  // Two areas match (Money and Home): neither.
  assert.equal(choose({ title: "Pay the plumber", source: "assistant" }).area, null);
  // "Call" doesn't start it: no Phone.
  assert.equal(choose({ title: "Prepare for the call with Marcus", source: "assistant" }).where, null);
  // An unlabelled source says nothing about the account.
  assert.equal(choose({ title: "Look into it", source: "email-digest" }).area, null);
  assert.equal(choose({ title: "Look into it", source: "manual" }).area, null);
});

test("a personal account means Personal, unless the words name another area", () => {
  assert.deepEqual(choose({ title: "Reply to Jo about Saturday", source: "email-digest-personal" }), { area: "Personal", where: null, why: { area: "account" } });
  assert.equal(choose({ title: "Renew the home insurance", source: "email-digest-personal" }).area, "Money");
  assert.equal(choose({ title: "Ring the GP", source: "email-digest-personal" }).area, "Health");
  // Words that point two ways leave even a personal account's area blank.
  assert.equal(choose({ title: "Pay the plumber", source: "email-digest-personal" }).area, null);
});

test("the model's suggestion: only when sure, only a live name, never against the words", () => {
  assert.equal(choose({ title: "Sort the thing", source: "email-digest", suggestion: { area: "Family", sure: true } }).area, "Family");
  assert.deepEqual(choose({ title: "Sort the thing", source: "email-digest", suggestion: { area: "Family", where: "Phone", sure: false } }), { area: null, where: null, why: {} });
  assert.equal(choose({ title: "Sort the thing", source: "email-digest", suggestion: { area: "Hobbies", sure: true } }).area, null);
  // The words say Health; the model can't make it Money.
  assert.equal(choose({ title: "Book the dentist", source: "x", suggestion: { area: "Money", sure: true } }).area, "Health");
  // It can break a tie between the words' candidates.
  assert.deepEqual(choose({ title: "Pay the plumber", source: "x", suggestion: { area: "home", sure: true } }).area, "Home");
  // The source still wins over the model.
  assert.equal(choose({ title: "Sort the thing", source: "work-activity", suggestion: { area: "Family", sure: true } }).area, "Work");
  // Aliases: "on my phone", "out and about".
  assert.equal(choose({ title: "Sort the thing", source: "x", suggestion: { where: "on my phone", sure: true } }).where, "Phone");
});

test("the owner's last correction wins, while that context is live", () => {
  const hint = { area_id: "area-family", where_id: "where-computer" };
  assert.deepEqual(choose({ title: "Ring the GP", source: "work-activity", hint }), { area: "Family", where: "Computer", why: { area: "correction", where: "correction" } });
  const archived = CONTEXTS.map((c) => (c.id === "area-family" ? { ...c, archived_at: at } : c));
  assert.equal(choose({ title: "Ring the GP", source: "work-activity", hint }, archived).area, "Work");
});

test("renamed starters keep their rules; the owner's own contexts match their names", () => {
  const renamed = CONTEXTS.map((c) => (c.id === "where-phone" ? { ...c, name: "Calls" } : c));
  assert.equal(chooseContext({ title: "Call Mum", source: "x" }, renamed).where_id, "where-phone");
  const withOwn = [...CONTEXTS, own("where", "Gym"), own("area", "Garden")];
  assert.equal(choose({ title: "Book a gym induction", source: "x" }, withOwn).where, "Gym");
  // "garden" is also a Home word: two areas, so blank.
  assert.equal(choose({ title: "Weed the garden", source: "x" }, withOwn).area, null);
  // Archived contexts are never chosen.
  const noPhone = CONTEXTS.map((c) => (c.id === "where-phone" ? { ...c, archived_at: at } : c));
  assert.equal(chooseContext({ title: "Call Mum", source: "x" }, noPhone).where_id, null);
});

test("accounts from sources and labels", () => {
  assert.equal(accountOf("email-digest-work"), "work");
  assert.equal(accountOf("calendar-meetings-personal"), "personal");
  assert.equal(accountOf("work-activity"), "work");
  assert.equal(accountOf("github"), "work");
  assert.equal(accountOf("email-digest"), null);
  assert.equal(accountOf("email-digest", "Personal"), "personal");
  assert.equal(accountOf("email-digest-personal", "Work"), "work", "the collection's label is the better signal");
  assert.equal(accountOf("assistant"), null);
  assert.equal(accountOf(null), null);
});

test("names: exact, plural, aliases; ambiguous or unknown is null", () => {
  assert.equal(contextByName("errand", CONTEXTS, "where")?.name, "Errands");
  assert.equal(contextByName("PHONE", CONTEXTS, "where")?.name, "Phone");
  assert.equal(contextByName("laptop", CONTEXTS, "where")?.name, "Computer");
  assert.equal(contextByName("home", CONTEXTS, "area")?.key, "home");
  assert.equal(contextByName("home", CONTEXTS, "where")?.kind, "where");
  assert.equal(contextByName("Hobbies", CONTEXTS, "area"), null);
  assert.equal(contextByName("", CONTEXTS, "area"), null);
  assert.deepEqual(cleanContextName("  Side   project "), { name: "Side project" });
  assert.ok("error" in cleanContextName(" "));
  assert.ok("error" in cleanContextName("x".repeat(31)));
});

test("hint keys: the person, else the source; none for the owner's own", () => {
  assert.equal(hintKey({ source: "work-activity", person_id: "p1" }), "person:p1");
  assert.equal(hintKey({ source: "work-activity" }), "source:work-activity");
  assert.equal(hintKey({ source: "manual", person_id: "p1" }), null);
  assert.equal(hintKey({ source: "assistant" }), null);
});

test("filters combine; Anywhere shows under every where; removed contexts read as blank", () => {
  const items = [
    { id: "a", area_id: "area-work", where_id: "where-computer" },
    { id: "b", area_id: "area-work", where_id: "where-phone" },
    { id: "c", area_id: "area-health", where_id: "where-phone" },
    { id: "d", area_id: null, where_id: "where-anywhere" },
    { id: "e", area_id: "area-gone", where_id: null },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(filterByContext(items, {}, CONTEXTS)), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(filterByContext(items, { area: "area-work" }, CONTEXTS)), ["a", "b"]);
  assert.deepEqual(ids(filterByContext(items, { where: "where-phone" }, CONTEXTS)), ["b", "c", "d"]);
  assert.deepEqual(ids(filterByContext(items, { area: "area-work", where: "where-phone" }, CONTEXTS)), ["b"]);
  assert.deepEqual(ids(filterByContext(items, { area: "none" }, CONTEXTS)), ["d", "e"], "an unknown id counts as none");
  assert.deepEqual(ids(filterByContext(items, { where: "none" }, CONTEXTS)), ["e"]);
  const archived = CONTEXTS.map((c) => (c.id === "area-health" ? { ...c, archived_at: at } : c));
  assert.deepEqual(ids(filterByContext(items, { area: "none" }, archived)), ["c", "d", "e"]);
});

test("grouping follows the owner's order, with the blank group last", () => {
  const items = [
    { id: "a", area_id: "area-home", where_id: null },
    { id: "b", area_id: null, where_id: null },
    { id: "c", area_id: "area-work", where_id: null },
    { id: "d", area_id: "area-home", where_id: null },
  ];
  const groups = groupByContext(items, "area", CONTEXTS);
  assert.deepEqual(groups.map((g) => [g.context?.name ?? null, g.items.map((i) => i.id)]), [["Work", ["c"]], ["Home", ["a", "d"]], [null, ["b"]]]);
  const reordered = CONTEXTS.map((c) => (c.id === "area-home" ? { ...c, position: -1 } : c));
  assert.equal(groupByContext(items, "area", reordered)[0].context?.name, "Home");
});

test("the starter set matches the migration", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../netlify/database/migrations/0037_todo-contexts/migration.sql", import.meta.url), "utf8");
  for (const s of STARTER_CONTEXTS) assert.ok(sql.includes(`('${s.kind}', '${s.key}', '${s.name}', '${s.icon}', '${s.colour}',`), `${s.kind} ${s.key} seeded`);
});
