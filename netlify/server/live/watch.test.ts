// The live channel's watermarks: what one poll reads and how two polls compare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_KINDS, SOURCES, changedIdsSql, changedKinds, readChanges, toReading, watermarkSql } from "./watch";

const at = (i: number, value: string | null, n = "1") => ({ i, at: value, n });
const index = (table: string) => SOURCES.findIndex((s) => s.table === table);

test("watermarkSql reads a timestamp and a count per source and never selects content", () => {
  const sql = watermarkSql();
  assert.equal(sql.split(" UNION ALL ").length, SOURCES.length);
  assert.match(sql, /SELECT 0 AS i, max\(updated_at\)::text AS at, count\(\*\)::text AS n FROM notes/);
  assert.match(sql, /FROM settings WHERE key LIKE 'history\\_load\.%'/);
  assert.doesNotMatch(sql, /\b(body|title|payload|value|summary|name)\b/);
  for (const kind of LIVE_KINDS) assert.ok(SOURCES.some((s) => s.kind === kind), kind);
});

test("a kind's mark moves when a row changes or a row goes, and only that kind's", () => {
  const base = toReading([at(index("notes"), "2026-11-11 10:00:00+00", "5"), at(index("people"), "2026-11-11 09:00:00+00", "3")]);
  const same = toReading([at(index("people"), "2026-11-11 09:00:00+00", "3"), at(index("notes"), "2026-11-11 10:00:00+00", "5")]);
  assert.deepEqual(base.kinds, same.kinds);
  assert.deepEqual(changedKinds(base, same), []);

  const edited = toReading([at(index("notes"), "2026-11-11 10:00:05+00", "5"), at(index("people"), "2026-11-11 09:00:00+00", "3")]);
  const moved = changedKinds(base, edited);
  assert.deepEqual(moved.map((c) => c.kind), ["note"]);
  assert.deepEqual(moved[0].moved.map((m) => [m.source.table, m.since]), [["notes", "2026-11-11 10:00:00+00"]]);

  // A delete leaves the newest timestamp alone: the count says so, and there are no ids to fetch.
  const deleted = toReading([at(index("notes"), "2026-11-11 10:00:00+00", "4"), at(index("people"), "2026-11-11 09:00:00+00", "3")]);
  assert.deepEqual(changedKinds(base, deleted), [{ kind: "note", moved: [] }]);
  assert.match(base.kinds.note, /^[0-9a-f]{12}$/);
});

test("readChanges names changed rows by id, by kind, and asks nothing when only a count moved", async () => {
  const prev = toReading([at(index("notes"), "2026-11-11 10:00:00+00"), at(index("collection_runs"), null, "0")]);
  const next = toReading([at(index("notes"), "2026-11-11 10:00:09+00"), at(index("collection_runs"), "2026-11-11 10:00:08+00")]);
  const asked: Array<{ text: string; params: unknown[] }> = [];
  const query = async <T>(text: string, params: unknown[] = []) => {
    asked.push({ text, params });
    return [
      { i: index("notes"), id: "n1" },
      { i: index("notes"), id: "n1" },
      { i: index("collection_runs"), id: "c1" },
    ] as T[];
  };
  assert.deepEqual(await readChanges(query, prev, next), [
    { kind: "note", ids: ["n1"] },
    { kind: "run", ids: ["c1"] },
  ]);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].params, ["2026-11-11 10:00:00+00", "-infinity"]);
  assert.match(asked[0].text, /\(collection_id\)::text AS id FROM collection_runs WHERE greatest\(created_at, started_at, finished_at\) > \$2::timestamptz/);

  const gone = toReading([at(index("notes"), "2026-11-11 10:00:09+00", "0")]);
  const none = async <T>() => assert.fail("no query when nothing has ids") as T[];
  assert.deepEqual(await readChanges(none, toReading([at(index("notes"), "2026-11-11 10:00:09+00")]), gone), [{ kind: "note", ids: [] }]);
});

test("changedIdsSql keeps a source's filter and caps each source", () => {
  const sql = changedIdsSql([{ source: SOURCES[index("settings")], i: index("settings") }], 5);
  assert.match(sql, /WHERE updated_at > \$1::timestamptz AND key LIKE 'history\\_load\.%' ORDER BY updated_at DESC LIMIT 5/);
});

test("Days, habits and recipes are watched by date or id, and a tick moves both the day and the habits", async () => {
  for (const kind of ["day", "habit", "recipe"] as const) assert.ok(LIVE_KINDS.includes(kind), kind);
  const tables = (kind: string) => SOURCES.filter((s) => s.kind === kind).map((s) => s.table);
  assert.deepEqual(tables("day"), ["days", "day_entries"]);
  assert.deepEqual(tables("habit"), ["habits", "day_entries"]);
  assert.deepEqual(tables("recipe"), ["recipes", "grocery_items", "recipe_cooked", "meal_plan", "settings"]);

  const sql = watermarkSql();
  assert.match(sql, /FROM day_entries WHERE kind = 'habit' AND source = 'athena'/);
  assert.match(sql, /max\(created_at\)::text AS at, count\(\*\)::text AS n FROM recipe_cooked/);
  assert.match(sql, /FROM settings WHERE key = 'recipes'/);

  // One habit tick: the unfiltered day_entries source and the habit one both move.
  const all = SOURCES.findIndex((s) => s.kind === "day" && s.table === "day_entries");
  const ticks = SOURCES.findIndex((s) => s.kind === "habit" && s.table === "day_entries");
  const prev = toReading([at(all, "2026-11-11 10:00:00+00", "9"), at(ticks, "2026-11-11 08:00:00+00", "2")]);
  const next = toReading([at(all, "2026-11-11 10:00:07+00", "10"), at(ticks, "2026-11-11 10:00:07+00", "3")]);
  const asked: string[] = [];
  const query = async <T>(text: string) => {
    asked.push(text);
    return [
      { i: all, id: "2026-11-11" },
      { i: ticks, id: "2026-11-11" },
    ] as T[];
  };
  assert.deepEqual(await readChanges(query, prev, next), [
    { kind: "day", ids: ["2026-11-11"] },
    { kind: "habit", ids: ["2026-11-11"] },
  ]);
  assert.match(asked[0], /\(to_char\(date, 'YYYY-MM-DD'\)\)::text AS id FROM day_entries WHERE updated_at > \$1::timestamptz ORDER BY/);
  assert.match(asked[0], /FROM day_entries WHERE updated_at > \$2::timestamptz AND kind = 'habit' AND source = 'athena'/);
  assert.doesNotMatch(asked[0], /\b(body|title|line|private|note|item|name)\b/);
});
