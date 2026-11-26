// Key rotation: seal under the old key, rotate, run the backfill, and check that
// the status only reads "on" once nothing is left under the old key, in every sealed store, and that
// everything then opens under the new key alone. Rows that won't open sit at the front of each store,
// more of them than one batch, and must not hold up the rows behind.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/encryption-rotation.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Leaves the database sealed under the key it started with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENCRYPTED, SEALED_SETTINGS } from "./encryption";

const url = process.env.ATHENA_TEST_DB_URL;
const OLD = process.env.ATHENA_DATA_KEY ?? "22".repeat(32);
const NEW = "5a".repeat(32);
const LOST = "6b".repeat(32); // a key this deploy never has
if (url) process.env.NETLIFY_DB_URL = url;
const skip = !url && "set ATHENA_TEST_DB_URL";

function useKeys(current: string, previous?: string): void {
  process.env.ATHENA_DATA_KEY = current;
  if (previous) process.env.ATHENA_DATA_KEY_PREVIOUS = previous;
  else delete process.env.ATHENA_DATA_KEY_PREVIOUS;
}

const DAY = "2019-03-0"; // days nothing else uses
const SOURCE = "rotation_test";
const uuid = (n: number, block = "0000") => `00000000-0000-4000-8000-${block}${String(n).padStart(8, "0")}`;
const ROW = uuid(77, "ffff"); // one row in each of Ask's tables, and the note whose link choices are kept
const artId = (n: number) => `0000000000000000rot${String(n).padStart(3, "0")}`;

test("rotation: every sealed store is counted, re-sealed and opens under the new key alone", { skip }, async () => {
  const box = await import("./data-box");
  const { qRaw, resetEncryptionCache } = await import("./db");
  const { sealExisting, encryptionStatus } = await import("./encryption");
  const { useFileStore, readFile } = await import("./files");
  const { useArtStore, readArt } = await import("./art");
  const { useSavedStore, readSavedImage } = await import("./saved");
  const { usePreviewStore } = await import("./link-previews");
  const { loadCarState } = await import("./car-store");

  const blobs = new Map<string, ArrayBuffer>();
  const store = () => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, v), get: async (k: string) => blobs.get(k) ?? null, delete: async (k: string) => void blobs.delete(k) }) as never;
  useFileStore(store);
  useArtStore(store);
  useSavedStore(store);
  usePreviewStore(store);
  const bytes = (sealed: Buffer) => new Uint8Array(sealed).buffer as ArrayBuffer;

  const passes = async () => {
    for (let i = 0; i < 20; i++) {
      const run = await sealExisting({ budgetMs: 20_000 });
      assert.ok(run);
      if (run.finished && run.sealed === 0) return run;
    }
    throw new Error("the backfill didn't settle");
  };
  const cleanup = async () => {
    await qRaw(`DELETE FROM sensitive_blobs WHERE source = $1`, [SOURCE]);
    await qRaw(`DELETE FROM days WHERE date BETWEEN '2019-03-01' AND '2019-03-09'`);
    await qRaw(`DELETE FROM places WHERE name = 'Rotation test place'`);
    await qRaw(`DELETE FROM nudges WHERE rule = 'rotation_test'`);
    await qRaw(`DELETE FROM files WHERE type = 'text/plain' AND size = 4242`);
    await qRaw(`DELETE FROM art WHERE id LIKE '0000000000000000rot%'`);
    await qRaw(`DELETE FROM saved_items WHERE source_url = 'rotation-test'`);
    await qRaw(`DELETE FROM location_cache WHERE key LIKE 'rotation-test:%'`);
    for (const t of ["ask_plans", "ask_routines", "ask_activity", "ask_skills", "team_assistants", "notes"]) await qRaw(`DELETE FROM ${t} WHERE id = $1`, [ROW]);
    await qRaw(`DELETE FROM link_previews WHERE url_bidx LIKE 'rotation-test:%'`);
  };
  await cleanup();
  // The car and the notification key are one settings row each: what's there is put back at the end.
  const settingsBefore = await qRaw<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key IN ('car', 'vapid')`);

  try {
    // What's already there that this pair of keys can't open (nothing, on a clean database).
    useKeys(NEW, OLD);
    resetEncryptionCache();
    await passes();
    const baseline = (await encryptionStatus()).remaining;
    const newKid = box.currentKeyId()!;

    // ---- under a key that's since been lost: more than one batch, at the front of each store ----
    useKeys(LOST);
    const lostText = box.sealText("lost");
    const lostBytes = box.sealBytes(Buffer.from("lost"));
    await qRaw(
      `INSERT INTO sensitive_blobs (id, domain, label, ciphertext, day, source)
       SELECT ('00000000-0000-4000-8000-0000' || lpad(n::text, 8, '0'))::uuid, 'finance', 'Rotation test', $1, DATE '2010-01-01' + n, $2 FROM generate_series(1, 201) AS n`,
      [lostText, SOURCE],
    );
    await qRaw(
      `INSERT INTO files (id, name, type, size, key_id)
       SELECT ('00000000-0000-4000-8000-0000' || lpad(n::text, 8, '0'))::uuid, '', 'text/plain', 4242, $1 FROM generate_series(1, 41) AS n`,
      [lostBytes.kid],
    );
    for (let n = 1; n <= 41; n++) blobs.set(uuid(n), bytes(lostBytes.sealed));
    await qRaw(`INSERT INTO art (id, w, h, bytes, kid) SELECT '0000000000000000rot' || lpad(n::text, 3, '0'), 1, 1, 1, $1 FROM generate_series(1, 51) AS n`, [lostBytes.kid]);
    for (let n = 1; n <= 51; n++) for (const size of ["lg", "sm"]) blobs.set(`${artId(n)}/${size}`, bytes(lostBytes.sealed));
    const lost = 201 + 41 + 51;
    // A preview from a lost key is dropped like any other: it isn't counted.
    const [lostPreview] = await qRaw<{ id: string }>(`INSERT INTO link_previews (url_bidx, status, title) VALUES ('rotation-test:lost', 'ok', $1) RETURNING id`, [lostText]);

    // ---- under the old key: one of everything sealed ----
    useKeys(OLD);
    const oldKid = box.currentKeyId()!;
    const domains = ["finance", "health", "location", "money", "home"];
    for (const [i, domain] of domains.entries()) {
      await qRaw(`INSERT INTO sensitive_blobs (id, domain, label, ciphertext, day, source) VALUES ($1, $2, 'Rotation test', $3, $4::date, $5)`, [
        uuid(i + 1, "ffff"),
        domain,
        box.sealText(JSON.stringify({ domain, total: 12.5 })),
        `${DAY}${i + 1}`,
        SOURCE,
      ]);
    }
    await qRaw(`INSERT INTO days (date, line, private) VALUES ($1::date, $2, $3)`, [`${DAY}1`, box.sealText("A quiet day"), box.sealText(JSON.stringify({ mood: 4 }))]);
    const [place] = await qRaw<{ id: string }>(`INSERT INTO places (name) VALUES ('Rotation test place') RETURNING id`);
    await qRaw(`INSERT INTO place_geo (place_id, sealed) VALUES ($1, $2)`, [place.id, box.sealText(JSON.stringify({ lat: 51.5, lon: -0.1 }))]);
    await qRaw(`INSERT INTO nudges (rule, key, payload, local_day, expires_at) VALUES ('rotation_test', 'rotation-test:1', $1, $2::date, now() + interval '1 day')`, [box.sealText(JSON.stringify({ title: "Leave by nine" })), `${DAY}1`]);
    await qRaw(`INSERT INTO location_cache (key, sealed) VALUES ('rotation-test:1', $1)`, [box.sealText("{}")]);
    const fileId = uuid(1, "ffff");
    await qRaw(`INSERT INTO files (id, name, type, size, key_id) VALUES ($1, $2, 'text/plain', 4242, $3)`, [fileId, box.sealText("rotation.txt"), oldKid]);
    blobs.set(fileId, bytes(box.sealBytes(Buffer.from("file bytes")).sealed));
    const art = artId(999);
    await qRaw(`INSERT INTO art (id, w, h, bytes, kid) VALUES ($1, 1, 1, 1, $2)`, [art, oldKid]);
    blobs.set(`${art}/lg`, bytes(box.sealBytes(Buffer.from("art lg")).sealed));
    blobs.set(`${art}/sm`, bytes(box.sealBytes(Buffer.from("art sm")).sealed));
    const [saved] = await qRaw<{ id: string }>(`INSERT INTO saved_items (kind, source_url, has_image, image_kid) VALUES ('image', 'rotation-test', true, $1) RETURNING id`, [oldKid]);
    blobs.set(`${saved.id}/lg`, bytes(box.sealBytes(Buffer.from("saved lg")).sealed));
    blobs.set(`${saved.id}/sm`, bytes(box.sealBytes(Buffer.from("saved sm")).sealed));
    // Ask's plans, routines (a waiting nudge too), activity and skills; a note's link choices; the car and the notification key.
    const plan = { steps: [{ tool: "note", text: "Book the dentist" }] };
    await qRaw(`INSERT INTO ask_plans (id, payload) VALUES ($1, $2)`, [ROW, box.sealText(JSON.stringify(plan))]);
    await qRaw(`INSERT INTO ask_routines (id, payload, days, at_time, pending) VALUES ($1, $2, '{1}', '09:00', $3)`, [
      ROW,
      box.sealText(JSON.stringify({ title: "Monday", prompt: "What's on this week?" })),
      box.sealText(JSON.stringify({ title: "Your week" })),
    ]);
    await qRaw(`INSERT INTO ask_activity (id, source, payload) VALUES ($1, 'ask', $2)`, [ROW, box.sealText(JSON.stringify({ did: "Added a reminder" }))]);
    await qRaw(`INSERT INTO ask_skills (id, payload) VALUES ($1, $2)`, [ROW, box.sealText(JSON.stringify({ name: "rotation" }))]);
    // A Team assistant's words and memory, and one of its runs (0067).
    await qRaw(`INSERT INTO team_assistants (id, payload, memory) VALUES ($1, $2, $3)`, [ROW, box.sealText(JSON.stringify({ name: "Moss" })), box.sealText(JSON.stringify({ summary: "Likes gifts", facts: [] }))]);
    await qRaw(`INSERT INTO team_runs (id, assistant_id, summary) VALUES ($1, $1, $2)`, [ROW, box.sealText(JSON.stringify({ did: "Found a price" }))]);
    // One of its posts in Team chat (0076); it goes with the assistant.
    await qRaw(`INSERT INTO team_posts (assistant_id, kind, body) VALUES ($1, 'update', $2)`, [ROW, box.sealText(JSON.stringify({ text: "Found a price" }))]);
    await qRaw(`INSERT INTO notes (id, title) VALUES ($1, $2)`, [ROW, box.sealText("Rotation test note")]);
    const choices = [{ url: "https://example.com/", mode: "card" }];
    await qRaw(`INSERT INTO note_link_choices (note_id, payload) VALUES ($1, $2)`, [ROW, box.sealText(JSON.stringify(choices))]);
    const car = { vehicles: [{ id: "rotation", reg: "AB12CDE" }] };
    const upsert = `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await qRaw(upsert, ["car", JSON.stringify({ sealed: box.sealText(JSON.stringify(car)) })]);
    await qRaw(upsert, ["vapid", JSON.stringify({ public: "rotation-public", private: box.sealText("rotation-private"), created_at: "2019-03-01T00:00:00.000Z" })]);
    // A link preview and its picture: a cache, dropped by the pass and not counted.
    const [preview] = await qRaw<{ id: string }>(
      `INSERT INTO link_previews (url_bidx, status, title, has_image, image_kid) VALUES ('rotation-test:old', 'ok', $1, true, $2) RETURNING id`,
      [box.sealText("A page"), oldKid],
    );
    blobs.set(`${preview.id}/image`, bytes(box.sealBytes(Buffer.from("preview")).sealed));
    // sensitive_blobs (5), days, place_geo, nudges, the file's name and its bytes, art, the saved image,
    // then ask_plans, ask_routines, ask_activity, ask_skills, the note, its link choices, the car, the notification key,
    // the Team assistant and its run, and its post in Team chat.
    const old = 5 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 8 + 2 + 1;

    // ---- rotate: before the pass, the status counts all of it and doesn't read "on" ----
    useKeys(NEW, OLD);
    resetEncryptionCache();
    let status = await encryptionStatus();
    assert.equal(status.state, "encrypting");
    assert.equal(status.remaining, baseline + lost + old + 1, "everything under another key, the saved row's own text included");
    for (const name of ["sensitive_blobs", "days", "place_geo", "nudges", "file_bytes", "art", "saved_images"]) assert.ok(status.by_table[name].remaining > 0, `${name} is counted`);
    for (const name of ["ask_plans", "ask_routines", "ask_activity", "ask_skills", "team_assistants", "team_runs", "team_posts", "note_link_choices", "settings.car", "settings.vapid"]) assert.ok(status.by_table[name].remaining > 0, `${name} is counted`);

    // ---- the pass: what opens is re-sealed past the rows that don't, which are counted ----
    await sealExisting({ budgetMs: 20_000 });
    const settled = await passes();
    assert.ok(settled.unreadable >= lost, "the lost rows are reported every run");
    status = await encryptionStatus();
    assert.equal(status.state, "encrypting", "never \"on\" while something is under a key that isn't the current one");
    assert.equal(status.remaining, baseline + lost);
    assert.ok(status.by_table.sensitive_blobs.remaining >= 201 && status.by_table.file_bytes.remaining >= 41 && status.by_table.art.remaining >= 51);
    assert.deepEqual(await qRaw(`SELECT 1 FROM location_cache WHERE key = 'rotation-test:1'`), [], "the cache entry is dropped");
    assert.deepEqual(await qRaw(`SELECT 1 FROM link_previews WHERE id = ANY($1::uuid[])`, [[preview.id, lostPreview.id]]), [], "previews under another key are dropped");
    assert.equal(blobs.has(`${preview.id}/image`), false, "and their pictures");

    // ---- with the lost rows gone the status reads "on" ----
    await qRaw(`DELETE FROM sensitive_blobs WHERE source = $1 AND id < '00000000-0000-4000-8000-ffff00000000'`, [SOURCE]);
    await qRaw(`DELETE FROM files WHERE size = 4242 AND id < '00000000-0000-4000-8000-ffff00000000'`);
    await qRaw(`DELETE FROM art WHERE id LIKE '0000000000000000rot%' AND id <> $1`, [art]);
    status = await encryptionStatus();
    assert.equal(status.remaining, baseline);
    if (baseline === 0) assert.equal(status.state, "on");

    // ---- the old key is removed: everything opens under the new key alone ----
    useKeys(NEW);
    const prefix = `enc:v1:${newKid}:`;
    const rows = await qRaw<{ domain: string; ciphertext: string }>(`SELECT domain, ciphertext FROM sensitive_blobs WHERE source = $1 ORDER BY day`, [SOURCE]);
    assert.deepEqual(rows.map((r) => r.domain), domains);
    for (const r of rows) {
      assert.ok(r.ciphertext.startsWith(prefix));
      assert.deepEqual(JSON.parse(box.openStrict(r.ciphertext)), { domain: r.domain, total: 12.5 });
    }
    const [day] = await qRaw<{ line: string; private: string }>(`SELECT line, private FROM days WHERE date = $1::date`, [`${DAY}1`]);
    assert.equal(box.openStrict(day.line), "A quiet day");
    assert.deepEqual(JSON.parse(box.openStrict(day.private)), { mood: 4 });
    const [geo] = await qRaw<{ sealed: string }>(`SELECT sealed FROM place_geo WHERE place_id = $1`, [place.id]);
    assert.deepEqual(JSON.parse(box.openStrict(geo.sealed)), { lat: 51.5, lon: -0.1 });
    const [nudge] = await qRaw<{ payload: string }>(`SELECT payload FROM nudges WHERE key = 'rotation-test:1'`);
    assert.deepEqual(JSON.parse(box.openStrict(nudge.payload)), { title: "Leave by nine" });
    const sealedText = async (table: string, column = "payload", id = "id") => {
      const [row] = await qRaw<{ v: string }>(`SELECT ${column} AS v FROM ${table} WHERE ${id} = $1`, [ROW]);
      assert.ok(row.v.startsWith(prefix), `${table}.${column} is under the new key`);
      return JSON.parse(box.openStrict(row.v)) as unknown;
    };
    assert.deepEqual(await sealedText("ask_plans"), plan);
    assert.deepEqual(await sealedText("ask_routines"), { title: "Monday", prompt: "What's on this week?" });
    assert.deepEqual(await sealedText("ask_routines", "pending"), { title: "Your week" });
    assert.deepEqual(await sealedText("ask_activity"), { did: "Added a reminder" });
    assert.deepEqual(await sealedText("ask_skills"), { name: "rotation" });
    assert.deepEqual(await sealedText("team_assistants"), { name: "Moss" });
    assert.deepEqual(await sealedText("team_assistants", "memory"), { summary: "Likes gifts", facts: [] });
    assert.deepEqual(await sealedText("team_runs", "summary"), { did: "Found a price" });
    assert.deepEqual(await sealedText("team_posts", "body", "assistant_id"), { text: "Found a price" });
    assert.deepEqual(await sealedText("note_link_choices", "payload", "note_id"), choices);
    assert.deepEqual(await loadCarState(), car);
    const [vapid] = await qRaw<{ value: { public: string; private: string; created_at: string } }>(`SELECT value FROM settings WHERE key = 'vapid'`);
    assert.ok(vapid.value.private.startsWith(prefix));
    assert.equal(box.openStrict(vapid.value.private), "rotation-private");
    assert.deepEqual([vapid.value.public, vapid.value.created_at], ["rotation-public", "2019-03-01T00:00:00.000Z"], "the rest of the row is untouched");
    const file = await readFile(fileId);
    assert.equal(file?.meta.name, "rotation.txt");
    assert.equal(file?.bytes.toString(), "file bytes");
    assert.equal((await readArt(art, "lg"))?.toString(), "art lg");
    assert.equal((await readArt(art, "sm"))?.toString(), "art sm");
    assert.equal((await readSavedImage(saved.id, "lg"))?.toString(), "saved lg");
    assert.equal((await readSavedImage(saved.id, "sm"))?.toString(), "saved sm");
    const kids = await qRaw<{ a: string; b: string; c: string }>(
      `SELECT (SELECT key_id FROM files WHERE id = $1) AS a, (SELECT kid FROM art WHERE id = $2) AS b, (SELECT image_kid FROM saved_items WHERE id = $3) AS c`,
      [fileId, art, saved.id],
    );
    assert.deepEqual(kids, [{ a: newKid, b: newKid, c: newKid }]);
  } finally {
    await cleanup();
    await qRaw(`DELETE FROM settings WHERE key IN ('car', 'vapid')`);
    for (const r of settingsBefore) await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [r.key, JSON.stringify(r.value)]);
    // Back under the key the other suites use.
    useKeys(OLD, NEW);
    resetEncryptionCache();
    await passes().catch(() => undefined);
    useKeys(OLD);
    resetEncryptionCache();
  }
});

// The source check (lib/encryption-coverage.test.ts) can't see a new sealed column on a table that's
// already listed. This looks at what's stored: any column holding sealed text must be one the status counts.
test("no column holds sealed text that the status doesn't count", { skip }, async () => {
  const { qRaw } = await import("./db");
  const counted = new Set(ENCRYPTED.flatMap((t) => [...t.text, ...(t.arrays ?? []), ...(t.json ?? [])].map((c) => `${t.table}.${c}`)));
  // Caches, dropped after a rotation and not counted (the reasons are in lib/encryption-coverage.test.ts).
  const caches = new Set(["location_cache", "link_previews"]);
  const columns = await qRaw<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'ARRAY', 'character varying') AND table_name <> 'settings' ORDER BY 1, 2`,
  );
  const uncounted: string[] = [];
  for (const { t, c } of columns) {
    if (counted.has(`${t}.${c}`) || caches.has(t)) continue;
    const found = await qRaw(`SELECT 1 FROM "${t}" WHERE "${c}"::text LIKE '%enc:v1:%' LIMIT 1`);
    if (found.length) uncounted.push(`${t}.${c}`);
  }
  assert.deepEqual(uncounted, [], "sealed text in a column that isn't in ENCRYPTED (lib/encryption.ts)");
  const fields = new Map(SEALED_SETTINGS.map((e) => [e.key, e.field]));
  const rows = await qRaw<{ key: string; fields: string[] }>(
    `SELECT key, ARRAY(SELECT k FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}' END) AS e(k, v) WHERE v::text LIKE '%enc:v1:%') AS fields
     FROM settings WHERE value::text LIKE '%enc:v1:%'`,
  );
  const stray = rows.filter((r) => r.fields.length !== 1 || fields.get(r.key) !== r.fields[0]).map((r) => r.key);
  assert.deepEqual(stray, [], "sealed text in a settings row that isn't in SEALED_SETTINGS");
});
