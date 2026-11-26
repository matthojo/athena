// Guard for key rotation: a new sealed store must be listed in lib/encryption.ts,
// or nothing counts it and nothing re-seals it, and it is lost when the old key is removed.
// A source check: every table written by a file that seals with the data key is in ENCRYPTED or
// SEALED_BYTES, or is named below with the reason it isn't. The same for `settings` rows and blob stores.
// It can't see a new sealed column on a table that's already listed: the rotation test's last check
// (lib/encryption-rotation.db.test.ts) looks for those in the database.
// Run: npx tsx --test lib/encryption-coverage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ENCRYPTED, SEALED_BYTES, SEALED_SETTINGS } from "./encryption";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tables these files write that hold nothing sealed under the data key, or a sealed store left out on purpose. */
const NOT_LISTED: Record<string, string> = {
  // Sealed, and deliberately not counted or re-sealed.
  location_cache: "a cache: entries under another key are dropped by the pass (resealPlaces) and looked up again",
  link_previews: "a cache: rows under another key are dropped by the pass (dropStalePreviews) and read again",
  // Nothing sealed.
  settings: "checked apart, below: SETTINGS_WRITERS",
  art_sources: "a hash of the source address and an art id",
  collections: "names, instructions and schedules, stored readable",
  day_files: "ids only",
  edges: "ids and relation names",
  goal_progress: "plain numbers (0041)",
  interaction_people: "ids only",
  location_todo: "dates only",
  mail_skips: "counts per day",
  meal_plan: "dates, ids and servings",
  metrics: "stored readable; a prompt rule keeps health and money figures out of them",
  note_files: "ids only",
  nudge_mutes: "rule names and times",
  push_subscriptions: "the browser's push endpoint and keys, readable; no data-key text",
  recipe_cooked: "ids and dates",
  reminder_log: "blind-indexed keys, moved to the current key when next claimed (claimIndexedReminder)",
  saved_rate: "rate-limit counters",
  team_triggers: "schedules and event filters, stored readable like ask_routines' days and time (0067)",
  flow_trigger_fires: "a flow's id, a fire's kind and time (0081): a moved trigger's last slot (lib/team-flows.ts)",
  thread_files: "ids only",
};

/** Plain columns on tables that are listed for rotation: readable on purpose, with the reason. */
const PLAIN_COLUMNS: Record<string, string> = {
  "team_assistants.models": "model names from the gateway's list, { think?, image? } (0076)",
  "team_runs.model": "the model name a run used (0076)",
  "team_runs.tried": "the model name that failed before a run fell back (0076)",
  "flows.schedule": "a trigger's days, times, counts and event facets, never its match words (0080, lib/flows.ts plainSchedule)",
  "flow_runs.event_ids": "the team_events ids that started a run (0080)",
};

/**
 * Files that both seal with the data key and write `settings`: the SEALED_SETTINGS key each seals, or
 * "plain" when what it keeps in settings is readable (switches, preferences, progress).
 */
const SETTINGS_WRITERS: Record<string, string> = {
  "lib/appliance-store.ts": "appliances",
  "lib/car-store.ts": "car",
  "lib/checkins.ts": "plain",
  "lib/team-flows.ts": "plain",
  "lib/playlist-store.ts": "music_playlists",
  "lib/music-genre-store.ts": "music_genres",
  "lib/push.ts": "vapid",
  "lib/days.ts": "plain",
  "lib/db.ts": "plain",
  "lib/encryption.ts": "plain",
  "lib/health.ts": "plain",
  "lib/money.ts": "plain",
  "lib/proactive/store.ts": "plain",
  "lib/recipes.ts": "plain",
  "lib/skills-store.ts": "plain",
  "lib/team.ts": "plain",
};

/** Every file that seals bytes: the SEALED_BYTES store it fills, or why its bytes aren't counted. */
const BYTE_WRITERS: Record<string, string> = {
  "lib/files.ts": "file_bytes",
  "lib/saved.ts": "saved_images",
  "lib/art.ts": "art",
  "lib/link-previews.ts": "excluded: pictures of a cache row, dropped with it (dropStalePreviews)",
  "lib/static-map.ts": "excluded: a cache of drawn maps; one that won't open is drawn again",
  "netlify/lib/days-art/routes.ts": "excluded: the Settings test's sample images; made again by the next test",
  "netlify/server/assistant/store.ts": "excluded: Ask's run records, deleted after two days; one that won't open is a run that can't be checked, so an instruction under its id isn't started",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules") sources(path, out);
    } else if (/\.m?ts$/.test(e.name) && !/\.test\.m?ts$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

// lib/data-box.ts is the sealing itself; lib/secret-box.ts seals connector credentials and API keys under
// CONNECTOR_ENCRYPTION_KEY, which this rotation doesn't cover (docs: security/connectors).
const files = [...sources("lib"), ...sources("netlify")]
  .filter((f) => f !== "lib/data-box.ts")
  .map((f) => ({ file: f, text: readFileSync(join(root, f), "utf8") }))
  .filter(({ text }) => /\b(sealText|sealBytes|sealer|Sealer)\b/.test(text));
const written = (text: string) => new Set([...text.matchAll(/\b(?:INSERT INTO|UPDATE)\s+([a-z_]+)\b/g)].map((m) => m[1]));

test("the scan finds the files that seal", () => {
  assert.ok(files.length > 20, `${files.length} files; run from a checkout (${relative(process.cwd(), root) || "."})`);
  for (const f of ["lib/db.ts", "lib/ask-plans.ts", "lib/note-link-choices.ts", "lib/files.ts"]) assert.ok(files.some((x) => x.file === f), f);
});

test("every table written by a file that seals is listed for rotation, or excused by name", () => {
  const listed = new Set([...ENCRYPTED.map((t) => t.table), ...SEALED_BYTES.map((b) => b.table)]);
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const { file, text } of files) {
    for (const table of written(text)) {
      seen.add(table);
      if (!listed.has(table) && !(table in NOT_LISTED)) missing.push(`${table} (${file})`);
    }
  }
  assert.deepEqual(missing, [], "add each to ENCRYPTED or SEALED_BYTES in lib/encryption.ts (and to the rotation test), or to NOT_LISTED here with the reason");
  const stale = Object.keys(NOT_LISTED).filter((t) => !seen.has(t) || listed.has(t));
  assert.deepEqual(stale, [], "NOT_LISTED names tables that are now listed, or that no sealing file writes");
});

test("a plain column excused here is on a listed table and isn't counted as sealed", () => {
  const sealed = new Set(ENCRYPTED.flatMap((t) => [...t.text, ...(t.arrays ?? []), ...(t.json ?? [])].map((c) => `${t.table}.${c}`)));
  const schema = readFileSync(join(root, "db/schema.sql"), "utf8");
  for (const col of Object.keys(PLAIN_COLUMNS)) {
    const [table, column] = col.split(".");
    assert.ok(ENCRYPTED.some((t) => t.table === table), `${table} is listed for rotation`);
    assert.ok(!sealed.has(col), `${col} is plain`);
    assert.match(schema, new RegExp(`\\b${column}\\s+JSONB`), `${col} is in db/schema.sql`);
  }
});

test("every sealed value kept in a settings row is in SEALED_SETTINGS", () => {
  const keys = new Set(SEALED_SETTINGS.map((e) => e.key));
  const writers = files.filter(({ text }) => written(text).has("settings")).map((f) => f.file);
  assert.deepEqual(writers.filter((f) => !(f in SETTINGS_WRITERS)), [], "say in SETTINGS_WRITERS what each keeps in settings: a SEALED_SETTINGS key, or plain");
  assert.deepEqual(Object.keys(SETTINGS_WRITERS).filter((f) => !writers.includes(f)), [], "SETTINGS_WRITERS names files that no longer write settings");
  const sealed = Object.values(SETTINGS_WRITERS).filter((v) => v !== "plain");
  assert.deepEqual(sealed.filter((k) => !keys.has(k)), [], "not in SEALED_SETTINGS");
  assert.deepEqual([...keys].filter((k) => !sealed.includes(k)), [], "SEALED_SETTINGS has a key no file here seals");
});

test("every store of sealed bytes is in SEALED_BYTES, or excused by name", () => {
  const names = new Set(SEALED_BYTES.map((b) => b.name));
  const writers = files.filter(({ text }) => /\bsealBytes\(/.test(text)).map((f) => f.file);
  assert.deepEqual(writers.filter((f) => !(f in BYTE_WRITERS)), [], "add the store to SEALED_BYTES (with a key id column and a re-seal pass), or excuse it in BYTE_WRITERS");
  assert.deepEqual(Object.keys(BYTE_WRITERS).filter((f) => !writers.includes(f)), [], "BYTE_WRITERS names files that no longer seal bytes");
  const counted = Object.values(BYTE_WRITERS).filter((v) => !v.startsWith("excluded:"));
  assert.deepEqual(counted.filter((n) => !names.has(n)), [], "not in SEALED_BYTES");
  assert.deepEqual([...names].filter((n) => !counted.includes(n)), [], "SEALED_BYTES has a store no file here fills");
});
