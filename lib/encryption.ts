/**
 * Encrypting what's already stored (docs: security/encryption). A SQL migration can't
 * do it: it never sees the key. So netlify/functions/encrypt-data.ts calls
 * sealExisting() every five minutes in production, and each run seals a
 * time-boxed batch of whatever isn't yet sealed under the current key:
 * plaintext from before the key was set, and — after a rotation — values
 * still under an old key. Once everything is done a run is a few quick
 * queries that find nothing.
 *
 * Safe to run any number of times, alongside the app: a row is only
 * rewritten if its encrypted columns are still exactly what the run read
 * (compare-and-set), so an edit made meanwhile always wins, and updated_at
 * is never touched (encrypting isn't an edit). Values that won't decrypt
 * (sealed under a key this deploy doesn't have, or altered) are left as
 * they are and counted, never overwritten.
 *
 * ENCRYPTED below is the one list of what's encrypted; the status counts
 * and the tests read it too. SEALED_BYTES lists the blob stores beside it,
 * and SEALED_SETTINGS the sealed values inside `settings` rows. After a
 * rotation the status reads "on" only when nothing in any of them is left
 * under another key, which is when the old key can be removed.
 *
 * A new sealed column, settings value or blob store goes in one of the
 * three, or lib/encryption-coverage.test.ts fails.
 */
import { currentKeyId, dataKeyConfigured, dataKeyProblem, DataBoxError, isSealed, openStrict, sealText } from "./data-box";
import { getEncryptionSetting, matchKey, qRaw, sealer, type Sealer } from "./db";
import { identityIndex, type IdentityKind } from "./memory";
import { normaliseReference } from "./trip-text";
import { resealFiles } from "./files";
import { resealPlaces } from "./places-visits";
import { resealArt } from "./art";
import { resealSavedImages } from "./saved";
import { dropStalePreviews } from "./link-previews";
import { savedUrlKey } from "./saved-rules";
import { recipeUrlKey } from "./recipe-rules";

type Row = Record<string, unknown>;

export interface EncryptedTable {
  table: string;
  /** Primary key columns and their SQL types. */
  key: Array<[column: string, type: string]>;
  text: string[];
  /** SQL: the rows this covers, when not the whole table. */
  where?: string;
  /** text[] columns: each element sealed on its own. */
  arrays?: string[];
  /** jsonb columns holding one sealed JSON string. */
  json?: string[];
  /** Blind indexes recomputed from the decrypted values whenever a row is sealed. */
  indexes?: { columns: string[]; read?: string[]; compute: (plain: Record<string, string>, row: Row, s: Sealer) => Record<string, string | null> };
}

const ID: Array<[string, string]> = [["id", "uuid"]];

export const ENCRYPTED: EncryptedTable[] = [
  { table: "notes", key: ID, text: ["title", "body"], arrays: ["tags"] },
  // A note's earlier versions (0061): copied from the note as stored, re-sealed with it.
  { table: "note_versions", key: ID, text: ["title", "body"] },
  { table: "note_chunks", key: ID, text: ["content"] },
  {
    table: "people",
    key: ID,
    text: ["name", "notes", "relationship", "email", "phone"],
    indexes: {
      columns: ["name_bidx", "email_bidx", "phone_bidx"],
      compute: (p, _row, s) => ({
        name_bidx: s.index("name", matchKey.name(p.name)),
        email_bidx: s.index("email", matchKey.email(p.email)),
        phone_bidx: s.index("phone", matchKey.phone(p.phone)),
      }),
    },
  },
  { table: "projects", key: ID, text: ["description"] },
  { table: "places", key: ID, text: ["address", "url", "notes"] },
  { table: "organisations", key: ID, text: ["website", "notes"] },
  { table: "events", key: ID, text: ["title", "notes"] },
  { table: "reminders", key: ID, text: ["text"] },
  // A to-do's steps and links (0084): each list one sealed JSON value.
  { table: "commitments", key: ID, text: ["title", "notes", "source_quote"], json: ["steps", "links"] },
  // What arrived for a Team or flow trigger (lib/team-events.ts): titles, tags, hosts and account names. Kept for seven days.
  { table: "team_events", key: [["id", "bigint"]], text: [], json: ["facets"] },
  { table: "interactions", key: ID, text: ["summary"] },
  { table: "facts", key: ID, text: ["value", "source_quote"] },
  {
    table: "identities",
    key: ID,
    text: ["value"],
    indexes: {
      columns: ["value_bidx"],
      read: ["kind"],
      compute: (p, row, s) => ({ value_bidx: identityIndex(s, row.kind as IdentityKind, p.value) }),
    },
  },
  // The email a find came from (0086): sender, subject and account, one sealed JSON value.
  { table: "suggestions", key: ID, text: ["summary", "source_quote"], json: ["payload", "email"] },
  { table: "assets", key: ID, text: ["name", "provider", "notes"] },
  { table: "reading_items", key: ID, text: ["title", "url", "author", "notes"], json: ["sync", "meta"] },
  { table: "goals", key: ID, text: ["title", "target", "notes"] },
  { table: "habits", key: ID, text: ["name", "unit"] },
  // Saved (0038): the link is matched by blind index; image bytes are re-sealed apart (resealSavedImages).
  {
    table: "saved_items",
    key: ID,
    text: ["url", "title", "site", "author", "excerpt", "readable", "quote", "note", "source_url", "facts", "filed_to"],
    arrays: ["tags"],
    indexes: { columns: ["url_bidx"], compute: (p, _row, s) => ({ url_bidx: p.url ? s.index("other", `saved-url\u0000${savedUrlKey(p.url)}`) : null }) },
  },
  // Tracking (0073): a tracker's name, link, label, affixes, states and target; a check's value, where and the page it was read on.
  { table: "trackers", key: ID, text: ["name", "url", "label", "prefix", "suffix", "target_value"], arrays: ["states"] },
  { table: "tracker_points", key: ID, text: ["value", "source", "url"] },
  {
    table: "collected_items",
    key: [
      ["source", "text"],
      ["kind", "text"],
      ["external_id", "text"],
    ],
    text: ["title"],
  },
  { table: "collection_runs", key: ID, text: ["summary"] },
  // Your work, counted (0067): each issue or PR is one sealed value (lib/work.ts).
  {
    table: "work_items",
    key: [
      ["source", "text"],
      ["item_key", "text"],
    ],
    text: ["sealed"],
  },
  // Gmail and Outlook mail rules (0043): senders can be people's addresses.
  { table: "connectors", key: ID, text: ["mail_rules", "write_parent_title"] },
  // Trips and purchases (0015). References, order and tracking numbers are matched by blind index.
  { table: "trips", key: ID, text: ["title", "notes"] },
  {
    table: "trip_bookings",
    key: ID,
    text: ["title", "provider", "reference", "segment", "start_tz", "start_place", "start_city", "end_tz", "end_place", "end_city", "seat", "details", "email_link", "cancel_email_link"],
    indexes: {
      columns: ["reference_bidx"],
      compute: (p, _row, s) => ({ reference_bidx: s.index("booking", normaliseReference(p.reference)) }),
    },
  },
  {
    table: "purchases",
    key: ID,
    text: ["retailer", "order_number", "carrier", "tracking_number", "tracking_url", "email_link"],
    arrays: ["items"],
    indexes: {
      columns: ["order_bidx", "tracking_bidx"],
      compute: (p, _row, s) => ({
        order_bidx: s.index("order", normaliseReference(p.order_number)),
        tracking_bidx: s.index("tracking", normaliseReference(p.tracking_number)),
      }),
    },
  },
  { table: "purchase_updates", key: ID, text: ["detail", "email_link"] },
  // Custom fields (0016): the owner's field names, units and options, and every value.
  { table: "custom_fields", key: ID, text: ["label", "unit"], json: ["options"] },
  {
    table: "custom_values",
    key: [
      ["field_id", "uuid"],
      ["entity_id", "uuid"],
    ],
    text: ["value"],
  },
  // Ask's chats (0017): the owner's name for each, and the whole conversation as one sealed JSON string.
  { table: "ask_threads", key: ID, text: ["title"], json: ["messages"] },
  // The owner's own kinds of record (0018): their names, and each record's title and body.
  { table: "custom_kinds", key: ID, text: ["name", "one"] },
  { table: "custom_records", key: ID, text: ["title", "body"] },
  // Files (0019): the name, Claude's summary and a PDF's or text file's words. The bytes are sealed in the blob store (lib/files.ts).
  { table: "files", key: ID, text: ["name", "summary", "extracted_text"] },
  // Days (0032): the day's line, mood and journal (private), and each entry's text and the source's own id, matched by blind index.
  { table: "days", key: [["date", "date"]], text: ["line", "private"] },
  {
    table: "day_entries",
    key: ID,
    text: ["external_id", "title", "subtitle", "url", "grp", "note", "hours"],
    indexes: {
      columns: ["ext_key"],
      read: ["source"],
      compute: (p, row, s) => ({ ext_key: s.index("other", `day\u0000${row.source as string}\u0000${p.external_id}`) ?? p.external_id }),
    },
  },
  // Templates and documents Athena wrote (0047): template names and bodies, an added template's summary (0091), and each doc's title.
  { table: "note_templates", key: ID, text: ["name", "body", "summary"] },
  { table: "document_exports", key: ID, text: ["title"] },
  // Recipes (0053): a recipe's title, address, body and tags; each grocery line's text. The address is matched by blind index.
  {
    table: "recipes",
    key: ID,
    text: ["url", "title", "body"],
    arrays: ["tags"],
    indexes: { columns: ["url_bidx"], compute: (p, _row, s) => ({ url_bidx: p.url ? s.index("other", `recipe-url\u0000${recipeUrlKey(p.url)}`) : null }) },
  },
  { table: "grocery_items", key: ID, text: ["item"] },
  // What the grocery list remembers (0096): what each shop bought, and what each skipped usual is.
  { table: "grocery_bought", key: ID, text: ["item"] },
  { table: "grocery_skips", key: ID, text: ["item"] },
  // Sealed day rows in every domain: health, location, money, home and finance (receipts, Amazon orders).
  { table: "sensitive_blobs", key: ID, text: ["ciphertext"], where: "day IS NOT NULL" },
  // Place coordinates (0031) and what each nudge says (0051).
  { table: "place_geo", key: [["place_id", "uuid"]], text: ["sealed"] },
  { table: "nudges", key: ID, text: ["payload"] },
  // Ask's skills (0058): each skill's SKILL.md, files and source, as one sealed JSON string.
  { table: "ask_skills", key: ID, text: ["payload"] },
  // Ask's plans, routines and activity (0055): each one's words, and a routine's nudge waiting to go out.
  { table: "ask_plans", key: ID, text: ["payload"] },
  { table: "ask_routines", key: ID, text: ["payload", "pending"] },
  { table: "ask_activity", key: ID, text: ["payload"] },
  // Team (0067): each assistant's words and memory, and what each run did.
  { table: "team_assistants", key: ID, text: ["payload", "memory"] },
  { table: "team_runs", key: ID, text: ["summary", "label", "step"] },
  // Assignments (0076): an assignment's title and brief, and each stage's task, handoff, questions and answers (lib/assignments.ts).
  { table: "team_assignments", key: ID, text: ["payload"] },
  { table: "team_stages", key: ID, text: ["words"] },
  // Team chat (0076): each post's words.
  { table: "team_posts", key: [["id", "bigint"]], text: ["body"] },
  // Flows (0080): each flow's words (name, trigger, steps), and each run's label, summary, error and state (lib/flows.ts).
  { table: "flows", key: ID, text: ["payload"] },
  { table: "flow_runs", key: ID, text: ["label", "summary", "error", "state"] },
  // Check-ins (0074): each day's plan and answers, one sealed JSON string (lib/checkins.ts).
  {
    table: "checkins",
    key: [
      ["date", "date"],
      ["kind", "text"],
    ],
    text: ["sealed"],
  },
  // How each link in a note is shown (0059): the list of addresses and modes.
  { table: "note_link_choices", key: [["note_id", "uuid"]], text: ["payload"] },
];

/**
 * Sealed bytes in the blob stores, each with the key id it's under in a
 * column. The status counts these too, so it can't read "on" while a file,
 * a saved image or a piece of art is still under an old key.
 */
export const SEALED_BYTES: Array<{ name: string; table: string; where: string; kid: string }> = [
  { name: "file_bytes", table: "files", where: "true", kid: "key_id" },
  { name: "saved_images", table: "saved_items", where: "has_image", kid: "image_kid" },
  { name: "art", table: "art", where: "true", kid: "kid" },
];

/**
 * Sealed values inside a `settings` row's JSON: the car (lib/car-store.ts),
 * the notification key's private half (lib/push.ts) and the grocery list's
 * usuals summary (lib/grocery-memory.ts). `field` is the top-level key
 * holding the sealed text.
 */
export const SEALED_SETTINGS: Array<{ name: string; key: string; field: string }> = [
  { name: "settings.car", key: "car", field: "sealed" },
  { name: "settings.vapid", key: "vapid", field: "private" },
  { name: "settings.music_playlists", key: "music_playlists", field: "sealed" },
  { name: "settings.music_genres", key: "music_genres", field: "sealed" },
  { name: "settings.appliances", key: "appliances", field: "sealed" },
  { name: "settings.grocery_usuals", key: "grocery_usuals", field: "sealed" },
];

/** SQL: this row has something not sealed under the key whose prefix is $1 ('enc:v1:<kid>:%'). */
function needsSealing(t: EncryptedTable): string {
  const any = [
    ...t.text.map((c) => `(${c} <> '' AND ${c} NOT LIKE $1)`),
    ...(t.arrays ?? []).map((c) => `EXISTS (SELECT 1 FROM unnest(${c}) AS x WHERE x <> '' AND x NOT LIKE $1)`),
    ...(t.json ?? []).map((c) => `NOT (jsonb_typeof(${c}) = 'string' AND ${c} #>> '{}' LIKE $1)`),
  ].join(" OR ");
  return t.where ? `(${t.where}) AND (${any})` : any;
}

const BATCH = 200;

export interface SealReport {
  /** Rows rewritten this run. */
  sealed: number;
  /** Values that wouldn't decrypt (a missing old key, or altered), left as they are. */
  unreadable: number;
  /** Rows changed by someone else between read and write: picked up next run. */
  skipped: number;
  by_table: Record<string, number>;
  finished: boolean;
}

/**
 * One row's values sealed under the current key, plus its blind indexes. A
 * value that won't open is kept exactly as it is (and counted) while the
 * rest of the row is re-sealed; the row's blind indexes are then kept too,
 * since they can't be recomputed without it.
 */
function resealRow(t: EncryptedTable, row: Row, s: Sealer, prefix: string): { next: Row; unreadable: number } {
  const under = (v: string) => v === "" || v.startsWith(prefix.slice(0, -1));
  let unreadable = 0;
  const reseal = <T>(v: string, seal: (plain: string) => T, keep: T): T => {
    try {
      return seal(openStrict(v));
    } catch (error) {
      if (!(error instanceof DataBoxError)) throw error;
      unreadable++;
      return keep;
    }
  };
  const next: Row = {};
  const plain: Record<string, string> = {};
  for (const c of t.text) {
    const v = row[c] as string | null;
    if (v === null) {
      next[c] = null;
      continue;
    }
    next[c] = reseal(
      v,
      (p) => {
        plain[c] = p;
        return under(v) ? v : s.text(p);
      },
      v,
    );
  }
  for (const c of t.arrays ?? []) next[c] = (row[c] as string[]).map((v) => (under(v) ? v : reseal(v, s.text, v)));
  for (const c of t.json ?? []) {
    const v = row[c];
    if (typeof v !== "string" || !isSealed(v)) next[c] = JSON.parse(s.json(v));
    else next[c] = under(v) ? v : reseal(v, (p) => JSON.parse(s.json(JSON.parse(p))), v);
  }
  if (t.indexes) {
    const readable = t.text.every((c) => row[c] === null || c in plain);
    Object.assign(next, readable ? t.indexes.compute(plain, row, s) : {}, { keep_indexes: !readable });
  }
  return { next, unreadable };
}

async function sealTable(t: EncryptedTable, s: Sealer, prefix: string, deadline: number, report: SealReport): Promise<boolean> {
  const keys = t.key.map(([c]) => c);
  const encrypted = [...t.text, ...(t.arrays ?? []), ...(t.json ?? [])];
  const columns = [...keys, ...encrypted, ...(t.indexes?.read ?? [])];
  let after: unknown[] | null = null;
  while (Date.now() < deadline) {
    const cursor = after ? `AND (${keys.join(", ")}) > (${keys.map((_, i) => `$${i + 3}`).join(", ")})` : "";
    const rows: Row[] = await qRaw<Row>(
      `SELECT ${columns.join(", ")} FROM ${t.table} WHERE (${needsSealing(t)}) ${cursor} ORDER BY ${keys.join(", ")} LIMIT $2`,
      [prefix, BATCH, ...(after ?? [])],
    );
    if (rows.length === 0) return true;
    after = keys.map((k) => rows[rows.length - 1][k]);

    const updates: Row[] = [];
    for (const row of rows) {
      const { next, unreadable } = resealRow(t, row, s, prefix);
      report.unreadable += unreadable;
      if (encrypted.every((c) => JSON.stringify(next[c]) === JSON.stringify(row[c]))) continue; // nothing it could change
      const record: Row = {};
      for (const k of keys) record[k] = row[k];
      for (const c of encrypted) record[`old_${c}`] = row[c];
      Object.assign(record, next);
      updates.push(record);
    }
    if (updates.length) {
      const types = new Map<string, string>([
        ...t.key,
        ...t.text.map((c): [string, string] => [c, "text"]),
        ...(t.arrays ?? []).map((c): [string, string] => [c, "text[]"]),
        ...(t.json ?? []).map((c): [string, string] => [c, "jsonb"]),
        ...(t.indexes?.columns ?? []).map((c): [string, string] => [c, "text"]),
        ["keep_indexes", "boolean"],
      ]);
      const indexes = t.indexes?.columns ?? [];
      const written = [...encrypted, ...indexes];
      const defs = [...keys, ...written, ...encrypted.map((c) => `old_${c}`), ...(indexes.length ? ["keep_indexes"] : [])].map(
        (c) => `${c} ${types.get(c.replace(/^old_/, ""))}`,
      );
      const set = [
        ...encrypted.map((c) => `${c} = v.${c}`),
        ...indexes.map((c) => `${c} = CASE WHEN v.keep_indexes THEN t.${c} ELSE v.${c} END`),
      ];
      const done = await qRaw(
        `UPDATE ${t.table} AS t SET ${set.join(", ")}
         FROM jsonb_to_recordset($1::jsonb) AS v(${defs.join(", ")})
         WHERE ${keys.map((k) => `t.${k} = v.${k}`).join(" AND ")}
           AND ${encrypted.map((c) => `t.${c} IS NOT DISTINCT FROM v.old_${c}`).join(" AND ")}
         RETURNING 1`,
        [JSON.stringify(updates)],
      );
      report.sealed += done.length;
      report.skipped += updates.length - done.length;
      report.by_table[t.table] = (report.by_table[t.table] ?? 0) + done.length;
    }
  }
  return false;
}

/**
 * The SEALED_SETTINGS values not under the current key, sealed again. One
 * row each, so no cursor: a value that won't open is counted and left, and
 * the write only lands if the value is still the one read.
 */
async function resealSettings(prefix: string): Promise<{ resealed: number; failed: number }> {
  const report = { resealed: 0, failed: 0 };
  for (const e of SEALED_SETTINGS) {
    const [row] = await qRaw<{ v: string }>(`SELECT value->>$2 AS v FROM settings WHERE key = $1 AND value->>$2 <> '' AND value->>$2 NOT LIKE $3`, [e.key, e.field, prefix]);
    if (!row) continue;
    let sealed: string;
    try {
      sealed = sealText(openStrict(row.v));
    } catch (error) {
      if (!(error instanceof DataBoxError)) throw error;
      report.failed++;
      continue;
    }
    const done = await qRaw(
      `UPDATE settings SET value = jsonb_set(value, ARRAY[$2::text], to_jsonb($4::text)) WHERE key = $1 AND value->>$2 = $3 RETURNING 1`,
      [e.key, e.field, row.v, sealed],
    );
    report.resealed += done.length;
  }
  return report;
}

/**
 * One backfill run: seal, within `budgetMs`, whatever isn't sealed under
 * the current key. Does nothing without a key. The outcome is kept in
 * settings.encryption.last_run for the status line.
 */
export async function sealExisting(opts: { budgetMs?: number } = {}): Promise<SealReport | null> {
  const kid = currentKeyId();
  if (!kid) return null;
  const s = await sealer(); // also marks the database as encrypted
  const prefix = `enc:v1:${kid}:%`;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const report: SealReport = { sealed: 0, unreadable: 0, skipped: 0, by_table: {}, finished: true };
  for (const t of ENCRYPTED) {
    if (!(await sealTable(t, s, prefix, deadline, report))) {
      report.finished = false;
      break;
    }
  }
  // File bytes sealed under an old key (after a rotation) are re-sealed too.
  if (report.finished) {
    const files = await resealFiles(Math.max(0, deadline - Date.now())).catch(() => ({ resealed: 0, failed: 0 }));
    report.sealed += files.resealed;
    report.unreadable += files.failed;
    if (files.resealed) report.by_table.file_bytes = files.resealed;
    // The location cache (lib/places-visits.ts): dropped, and looked up again when needed.
    const places = await resealPlaces(Math.max(0, deadline - Date.now())).catch(() => ({ resealed: 0, failed: 0 }));
    report.sealed += places.resealed;
    report.unreadable += places.failed;
    if (places.resealed) report.by_table.location_cache = places.resealed;
    // Art (lib/art.ts) likewise.
    const art = await resealArt(Math.max(0, deadline - Date.now())).catch(() => ({ resealed: 0, failed: 0 }));
    report.sealed += art.resealed;
    report.unreadable += art.failed;
    if (art.resealed) report.by_table.art = art.resealed;
    // Saved images (lib/saved.ts) likewise.
    const kid = currentKeyId();
    const saved = kid ? await resealSavedImages(kid, Math.max(0, deadline - Date.now())).catch(() => ({ resealed: 0, failed: 0 })) : { resealed: 0, failed: 0 };
    report.sealed += saved.resealed;
    report.unreadable += saved.failed;
    if (saved.resealed) report.by_table.saved_images = saved.resealed;
    // Sealed values inside settings rows (SEALED_SETTINGS).
    const settings = await resealSettings(prefix).catch(() => ({ resealed: 0, failed: 0 }));
    report.sealed += settings.resealed;
    report.unreadable += settings.failed;
    if (settings.resealed) report.by_table.settings = settings.resealed;
    // Link previews (lib/link-previews.ts): a cache, dropped and read again when needed.
    const previews = kid ? await dropStalePreviews(kid, Math.max(0, deadline - Date.now())).catch(() => 0) : 0;
    report.sealed += previews;
    if (previews) report.by_table.link_previews = previews;
  }
  await qRaw(
    `UPDATE settings SET value = value || jsonb_build_object('last_run', $1::jsonb), updated_at = now() WHERE key = 'encryption'`,
    [JSON.stringify({ at: new Date().toISOString(), sealed: report.sealed, unreadable: report.unreadable, finished: report.finished })],
  );
  return report;
}

export type EncryptionState = "off" | "encrypting" | "on" | "locked";

export interface EncryptionStatus {
  /**
   * off: no key and never switched on (stored as before). encrypting: the
   * key is set and existing data is still being sealed. on: everything is
   * sealed under the current key. locked: the data is encrypted but this
   * copy of Athena has no key (a deploy preview): it shows placeholders and
   * won't save text.
   */
  state: EncryptionState;
  key_id: string | null;
  /**
   * Rows with something not yet sealed under the current key (any key,
   * without one), in every sealed store: the ENCRYPTED tables, the sealed
   * bytes of files, saved images and art, and the SEALED_SETTINGS values. A value that won't decrypt stays
   * counted here, so the state never reads "on" over it.
   */
  remaining: number;
  total: number;
  by_table: Record<string, { total: number; remaining: number }>;
  last_run: Record<string, unknown> | null;
  problem: string | null;
}

/** Where encryption stands: GET /api/encryption, the app's status line, and the backfill's log. */
export async function encryptionStatus(): Promise<EncryptionStatus> {
  const kid = currentKeyId();
  const setting = await getEncryptionSetting();
  const prefix = kid ? `enc:v1:${kid}:%` : "enc:v1:%";
  const counts = await Promise.all(
    ENCRYPTED.map((t) =>
      qRaw<{ total: number; remaining: number }>(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${needsSealing(t)}))::int AS remaining FROM ${t.table}`,
        [prefix],
      ),
    ),
  );
  // Bytes are only ever stored sealed, so without a key there's nothing "not yet sealed" to count.
  const bytes = await Promise.all(
    SEALED_BYTES.map((b) =>
      qRaw<{ total: number; remaining: number }>(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE $1::text IS NOT NULL AND ${b.kid} IS DISTINCT FROM $1))::int AS remaining FROM ${b.table} WHERE ${b.where}`,
        [kid],
      ),
    ),
  );
  const settings = await Promise.all(
    SEALED_SETTINGS.map((e) =>
      qRaw<{ total: number; remaining: number }>(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE value->>$2 NOT LIKE $3))::int AS remaining FROM settings WHERE key = $1 AND value->>$2 <> ''`,
        [e.key, e.field, prefix],
      ),
    ),
  );
  const by_table: EncryptionStatus["by_table"] = {};
  ENCRYPTED.forEach((t, i) => (by_table[t.table] = counts[i][0]));
  SEALED_BYTES.forEach((b, i) => (by_table[b.name] = bytes[i][0]));
  SEALED_SETTINGS.forEach((e, i) => (by_table[e.name] = settings[i][0]));
  const remaining = Object.values(by_table).reduce((n, c) => n + c.remaining, 0);
  const total = Object.values(by_table).reduce((n, c) => n + c.total, 0);
  const state: EncryptionState = dataKeyConfigured()
    ? remaining > 0
      ? "encrypting"
      : "on"
    : setting.required || dataKeyProblem()
      ? "locked"
      : "off";
  return { state, key_id: kid, remaining, total, by_table, last_run: setting.last_run ?? null, problem: dataKeyProblem() };
}
