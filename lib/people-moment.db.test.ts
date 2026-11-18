// Night F5 ("thinking of them"), against Postgres with every migration applied: the person brief route
// adds gift ideas (open lines on their gift lists) and accepted facts (the owner's own, or accepted from
// the Review inbox, never a collection's that skipped it), and listStalePeople reads "last seen" the way
// Home's Your people does: the latest of last_contacted_at, a catch-up logged with them and a calendar
// event with them at a place.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/people-moment.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const isoDate = (t: string) => t.slice(0, 10);

async function call(method: string, path: string) {
  const api = (await import("../netlify/functions/api")).default;
  const res = await api(new Request(`https://athena.test/api/${path}`, { method, headers: { Authorization: "Bearer master-token-for-tests" } }), {} as never);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Rows from earlier runs: names and titles are sealed, so read them back opened. */
async function clearPrefixed(prefix: string) {
  const { q, qRaw } = await import("./db");
  for (const [table, col] of [["notes", "title"], ["events", "title"], ["people", "name"], ["places", "name"]] as const) {
    const rows = await q<{ id: string; v: string }>(`SELECT id, ${col} AS v FROM ${table}`);
    for (const r of rows) if (r.v.startsWith(prefix)) await qRaw(`DELETE FROM ${table} WHERE id = $1`, [r.id]);
  }
}

test("person brief: gift ideas from their gift lists, and only facts the owner wrote or accepted", { skip }, async () => {
  const { createNote, upsertPerson } = await import("./db");
  const { acceptSuggestion, addFact, propose } = await import("./memory");
  await clearPrefixed("PM ");
  const priya = await upsertPerson({ name: "PM Priya Shah" });
  const tom = await upsertPerson({ name: "PM Tom Hale" });
  const link = (p: { id: string; name: string }) => `[@${p.name}](athena://person/${p.id})`;
  await createNote({ title: "PM Priya Shah · Gift ideas", body: `For ${link(priya)}.\n\n- [ ] [Château Musar 2017](https://example.com/musar) · £30\n- [x] Candle\n- [ ] A *good* notebook` });
  await createNote({ title: "PM Priya Shah · Christmas gift ideas", body: `For ${link(priya)}.\n\n- [ ] Château Musar 2017 · £30` });
  // Not a gift list, and someone else's list: neither counts.
  await createNote({ title: "PM Lunch notes", body: `${link(priya)} wants a second read.\n\n- [ ] Send the contract notes` });
  await createNote({ title: "PM Tom Hale · Gift ideas", body: `For ${link(tom)}.\n\n- [ ] Socks` });

  // The owner's own words, one accepted from the inbox, one a collection saved directly, one still waiting.
  await addFact({ subject_kind: "person", subject_id: priya.id, key: "Pronouns", value: "she/her", source: "manual" }, { byOwner: true });
  await addFact({ subject_kind: "person", subject_id: priya.id, key: "Coffee order", value: "Oat flat white", source: "assistant", confidence: 1 }, { byOwner: true });
  await addFact({ subject_kind: "person", subject_id: priya.id, key: "Kids", value: "Maya (7)", source: "calendar-meetings-work", source_ref: `pm-${Date.now()}`, confidence: 0.95 });
  const moving = await propose({ op: "fact", summary: `PM Priya: Moving ${Date.now()}`, payload: { subject_kind: "person", subject_id: priya.id, key: "Moving", value: "To Lisbon, in the spring" }, source: "email-digest-personal", confidence: 0.6 });
  await acceptSuggestion(moving.id);
  await propose({ op: "fact", summary: `PM Priya: Allergy ${Date.now()}`, payload: { subject_kind: "person", subject_id: priya.id, key: "Allergy", value: "Peanuts" }, source: "email-digest-personal", confidence: 0.5 });

  const r = await call("GET", `people/${priya.id}/brief`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.gift_ideas, ["Château Musar 2017 · £30", "A good notebook"], "open lines, deduplicated, links and marks gone, ticked ones left out");
  const accepted = (r.json.accepted_facts as Array<{ key: string; value: string }>).map((f) => f.key).sort();
  assert.deepEqual(accepted, ["Coffee order", "Moving", "Pronouns"], "a collection's own fact and a waiting suggestion stay out");
  // The brief's other parts are unchanged: every current fact is still in `facts`.
  assert.deepEqual((r.json.facts as Array<{ key: string }>).map((f) => f.key).sort(), ["Coffee order", "Kids", "Moving", "Pronouns"]);

  const none = await call("GET", `people/${tom.id}/brief`);
  assert.deepEqual([none.json.gift_ideas, none.json.accepted_facts], [["Socks"], []]);
  assert.equal((await call("GET", "people/5a3e0000-0000-4000-8000-00000000ffff/brief")).status, 404);
  assert.equal((await call("POST", `people/${priya.id}/brief`)).status, 405);
});

test("listStalePeople: last seen is the latest catch-up or event at a place, as Home reads it", { skip }, async () => {
  const { linkEntities, listStalePeople, upsertEvent, upsertPerson, upsertPlace, qRaw } = await import("./db");
  const { logInteraction } = await import("./memory");
  await clearPrefixed("PS ");
  const person = (name: string, extra: Record<string, unknown> = {}) => upsertPerson({ name: `PS ${name}`, keep_in_touch: true, catch_up_days: 14, last_contacted_at: ago(30), ...extra });
  const dishoom = await upsertPlace({ name: "PS Dishoom" });
  const eventWith = async (p: { id: string }, title: string, date: string, place = true) => {
    const ev = await upsertEvent({ title: `PS ${title}`, date, time: "13:00", tz: "Europe/London" });
    await linkEntities({ sourceType: "event", sourceId: ev.id, targetType: "person", targetId: p.id });
    if (place) await linkEntities({ sourceType: "place", sourceId: dishoom.id, targetType: "event", targetId: ev.id });
    return ev;
  };

  // Seen: lunch logged two days ago; a calendar lunch at Dishoom three days ago.
  const lunched = await person("Lunched");
  await logInteraction({ at: ago(2), channel: "in_person", summary: "Lunch at Dishoom", person_ids: [lunched.id] });
  const met = await person("Met");
  await eventWith(met, "Lunch with Met", isoDate(ago(3)));
  // Still overdue: an email doesn't count, nor an event with no place, nor one next week, nor an archived catch-up.
  const emailed = await person("Emailed");
  await logInteraction({ at: ago(1), channel: "email", summary: "Sent the notes", person_ids: [emailed.id] });
  const nowhere = await person("Nowhere");
  await eventWith(nowhere, "Call with Nowhere", isoDate(ago(1)), false);
  const soon = await person("Soon");
  await eventWith(soon, "Lunch with Soon", isoDate(ago(-5)));
  const archived = await person("Archived");
  const gone = await logInteraction({ at: ago(1), channel: "call", summary: "Quick call", person_ids: [archived.id] });
  await qRaw(`UPDATE interactions SET archived_at = now() WHERE id = $1`, [gone.id]);
  // Logging sets last_contacted_at itself; put it back, so only the new rule is under test.
  await qRaw(`UPDATE people SET last_contacted_at = $2 WHERE id = ANY($1::uuid[])`, [[emailed.id, archived.id], ago(30)]);
  // Never contacted, but a call a hundred days ago: overdue, and that call is when you last spoke.
  const called = await person("Called", { last_contacted_at: null, catch_up_days: 60 });
  await logInteraction({ at: ago(100), channel: "call", summary: "Catch-up call", person_ids: [called.id] });
  // Not keep-in-touch: never listed.
  await upsertPerson({ name: "PS Acquaintance", keep_in_touch: false, last_contacted_at: ago(300) });

  const stale = (await listStalePeople()).filter((p) => p.name.startsWith("PS "));
  const names = stale.map((p) => p.name.slice(3));
  assert.deepEqual(new Set(names), new Set(["Called", "Emailed", "Nowhere", "Soon", "Archived"]));
  assert.equal(names[0], "Called", "oldest first");
  const when = (n: string) => Date.parse(stale.find((p) => p.name === `PS ${n}`)!.last_contacted_at!);
  assert.ok(Math.abs(when("Called") - Date.parse(ago(100))) < 60_000, "last contacted is the call, not null");
  assert.ok(Math.abs(when("Emailed") - Date.parse(ago(30))) < 60_000, "an email leaves last contacted as it was");
});
