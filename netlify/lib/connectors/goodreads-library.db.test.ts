// Real path for the Goodreads library import and exact run links: the real /api routes, the real Life log save (AthenaWriter) and Postgres with every migration applied (0026 included).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/goodreads-library.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const setup = async () => {
  const { handleConnectorRoutes } = await import("./routes");
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'import.%'`);
  await qRaw(`DELETE FROM metrics WHERE metric LIKE 'books_finished_day%' OR metric LIKE 'videos_watched_day%'`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM reading_items`);
  await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  return async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    try {
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 400, json: { error: (error as Error).message } };
    }
  };
};

test("Goodreads library: books on their finish day, kept by Life log runs, idempotent, last import on the server", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = await setup();
  const { AthenaWriter } = await import("./runner");
  const C = await import("../../../lib/connectors");
  const { q } = await import("../../../lib/db");
  const G = await import("../../../lib/goodreads-csv");

  const gr = (await api("POST", "/connectors", { provider: "goodreads", name: "Goodreads", account_label: "personal", url: "https://www.goodreads.com/user/show/12345-jordan" })).json;
  assert.ok(gr.id, JSON.stringify(gr));
  const yt = (await api("POST", "/connectors", { provider: "youtube", name: "YouTube", account_label: "personal", client_id: "1-yt.apps.googleusercontent.com", client_secret: "GOCSPX-yt" })).json;

  // Only Goodreads accounts have it.
  assert.equal((await api("GET", `/connectors/${yt.id}/library`)).status, 404);
  assert.equal((await api("GET", `/connectors/${gr.id}/watch-history`)).status, 404);

  const life = (await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [gr.id], schedule: "daily", run_at: "23:30" })).json;
  let target = await api("GET", `/connectors/${gr.id}/library`);
  assert.deepEqual(target.json, { tz: "Europe/London", collection: { id: life.id, name: "Life log" }, metric: "books_finished_day_personal", source: life.source, last_import: null });

  // Bad input is refused before anything is written.
  assert.equal((await api("POST", `/connectors/${gr.id}/library`, { days: [{ day: "2026-07-03", books: [{ id: "x1", title: "A" }] }] })).status, 400);
  assert.equal((await api("POST", `/connectors/${gr.id}/library`, { days: [{ day: "2026-07-03", books: [{ id: "1", title: "" }] }] })).status, 400);
  assert.equal((await api("POST", `/connectors/${gr.id}/library`, { days: [] })).status, 400);

  // The fixture, parsed and grouped the way the app does it.
  const parsed = G.parseLibrary(readFileSync(new URL("../../../lib/fixtures/goodreads-library.csv", import.meta.url), "utf8"));
  const days = G.groupBooksByDay(parsed.books);
  assert.deepEqual(days.map((d) => d.day), ["2015-03-02", "2023-01-15", "2026-07-03", "2026-07-04", "2026-10-01"]);

  // A Life log run already wrote 3 July, with its own Read entries from the shelf widget.
  const writer = (now: Date) => new AthenaWriter(life, "00000000-0000-0000-0000-000000000000", { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0, skipped_dismissed: 0 } as never, now, "Europe/London");
  const runDay = {
    date: "2026-07-03",
    entries: [
      { kind: "watched", source: "trakt", external_id: "h-1", title: "Severance", subtitle: "S2E3 · Who Is Alive?" },
      { kind: "read", source: "goodreads", external_id: "review-1", title: "Dune (Dune #1)", subtitle: "Frank Herbert", url: "https://www.goodreads.com/review/show/1", note: "finished" },
      { kind: "read", source: "goodreads", external_id: "review-9", title: "Piranesi", url: "https://www.goodreads.com/review/show/9", note: "started" },
    ],
  };
  await writer(new Date("2026-07-04T09:00:00Z")).run("athena_day_entry", runDay);

  const file = { items: parsed.books.length, days: days.length, to_read: parsed.books.filter((b) => b.want).length };
  const first = await api("POST", `/connectors/${gr.id}/library`, { days, metrics: true, file });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json, { days_created: 4, days_updated: 1, days_unchanged: 0, days_skipped: 0, added: 6, added_to_read: 1, watch_read: { created: 6, updated: 0 } });

  const { getDay } = await import("../../../lib/days");
  const shown = async (date: string) =>
    (await getDay(date, { tz: "Europe/London", health: false, places: false }))!.entries.map((e) => [e.kind, e.title, e.subtitle ?? null, e.rating ?? null, e.note ?? null]);
  // The run's Dune and the export's are one entry, which takes the export's stars.
  assert.deepEqual(await shown("2026-07-03"), [
    ["watched", "Severance", "S2E3 · Who Is Alive?", null, null],
    ["read", "Dune (Dune #1)", "Frank Herbert", 5, "finished"],
    ["read", "Piranesi", null, null, "started"],
    ["read", "Atomic Habits", "James Clear", 4, "finished"],
  ]);
  assert.deepEqual(await shown("2023-01-15"), [["read", "The Way of Kings (The Stormlight Archive #1)", "Brandon Sanderson", null, "finished"]]);
  // Sealed at rest.
  for (const r of await (await import("../../../lib/db")).qRaw<{ title: string }>(`SELECT title FROM day_entries`)) assert.ok(r.title.startsWith("enc:"));
  assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE source LIKE 'life-log%'`))[0].n, 0, "no day notes");

  const metrics = await q<{ value: number; day: string }>(`SELECT value, metadata->>'day' AS day FROM metrics WHERE metric = 'books_finished_day_personal' ORDER BY 2`);
  assert.deepEqual(metrics.map((m) => [m.day, Number(m.value)]), [["2015-03-02", 1], ["2023-01-15", 1], ["2026-07-03", 2], ["2026-07-04", 1]], "to-read books aren't finished books");
  // No finish date: on the day you shelved it. To read: saved, on the day you added it.
  assert.deepEqual(await shown("2015-03-02"), [["read", "Harry Potter and the Deathly Hallows", "J.K. Rowling", 3, "finished"]]);
  assert.deepEqual(await shown("2026-10-01"), [["saved", "1984", "George Orwell", null, "want to read"]]);

  // The account remembers (sealed) which books it placed, so the shelf tool won't log them again.
  const sealedSecrets = (await C.getConnectorWithSecrets(gr.id))!.secrets as { goodreadsImported?: Record<string, string> };
  assert.equal(sealedSecrets.goodreadsImported?.["dune"], "2026-07-03");
  assert.equal(Object.keys(sealedSecrets.goodreadsImported ?? {}).length, 5);
  assert.deepEqual((sealedSecrets as { goodreadsWanted?: Record<string, string> }).goodreadsWanted, { "1984": "2026-10-01" });

  // Every device sees when, from the server.
  target = await api("GET", `/connectors/${gr.id}/library`);
  assert.equal(target.json.last_import.items, 6);
  assert.equal(target.json.last_import.days, 5);
  assert.equal(target.json.last_import.to_read, 1, "the account row can say 5 read, 1 to read");
  assert.ok(Date.now() - Date.parse(target.json.last_import.at) < 60_000);

  // The same file again: nothing changes.
  const before = await shown("2026-07-03");
  const again = await api("POST", `/connectors/${gr.id}/library`, { days, metrics: true, file });
  assert.deepEqual(again.json, { days_created: 0, days_updated: 0, days_unchanged: 5, days_skipped: 0, added: 0, added_to_read: 0, watch_read: { created: 0, updated: 0 } });
  // A Life log run over 3 July again: still one Dune, its stars kept.
  await writer(new Date("2026-07-05T09:00:00Z")).run("athena_day_entry", runDay);
  assert.deepEqual(await shown("2026-07-03"), before);
  // A run that posts on 4 July: the book stays beside it.
  await writer(new Date("2026-07-05T09:00:00Z")).run("athena_day_entry", { date: "2026-07-04", entries: [{ kind: "posted", source: "bluesky", external_id: "p-1", title: "A photo" }] });
  assert.deepEqual((await shown("2026-07-04")).map((e) => e[1]), ["The Hitchhiker's Guide to the Galaxy [Illustrated] *Special*", "A photo"]);

  // And YouTube's import into the same day sits beside them.
  const yr = await api("POST", `/connectors/${yt.id}/watch-history`, { days: [{ day: "2026-07-04", videos: [{ id: "aaaaaaaaaa1", title: "Trailer", channel: "Studio", count: 1 }] }], metrics: false, file: { items: 1, days: 1 } });
  assert.equal(yr.status, 200);
  assert.deepEqual((await shown("2026-07-04")).map((e) => e[1]), ["The Hitchhiker's Guide to the Galaxy [Illustrated] *Special*", "A photo", "Trailer"]);
  assert.equal((await api("GET", `/connectors/${yt.id}/watch-history`)).json.last_import.items, 1, "YouTube's last import is on the server too");
});

test("Run links: a run's items are exactly what it saved (run_id), older runs use the window", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = await setup();
  const { AthenaWriter } = await import("./runner");
  const C = await import("../../../lib/connectors");
  const { qRaw, createNote } = await import("../../../lib/db");

  const gr = (await api("POST", "/connectors", { provider: "goodreads", name: "Goodreads", account_label: "personal", url: "https://www.goodreads.com/user/show/12345-jordan" })).json;
  const life = (await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [gr.id], schedule: "daily", run_at: "23:30" })).json;
  const stats = () => ({ notes_created: 0, notes_updated: 0, restored: 0, metrics: 0 }) as never;
  const save = (w: InstanceType<typeof AthenaWriter>, day: string, title: string) =>
    w.run("athena_save_note", { external_id: `day-note-${day}`, type: "note", date: day, tags: [], title, body: `## Watched\n- ${title}` });
  const items = async (runId: string) => (await api("GET", `/collections/${life.id}/runs/${runId}/items`)).json.items.map((i: { title: string }) => i.title);

  // Two runs at once (a manual run and a scheduled one overlapping): each lists only its own.
  const a = await C.queueRun(life.id, "manual");
  await C.startRun(a.id);
  const b = await C.queueRun(life.id, "schedule");
  await C.startRun(b.id);
  await save(new AthenaWriter(life, a.id, stats(), new Date(), "Europe/London"), "2026-11-05", "Thursday 5 November · Film A");
  await save(new AthenaWriter(life, b.id, stats(), new Date(), "Europe/London"), "2026-11-06", "Friday 6 November · Film B");
  // A Goodreads import in the same minutes: not a run's.
  await api("POST", `/connectors/${gr.id}/library`, { days: [{ day: "2026-11-04", books: [{ id: "7", title: "Imported" }] }], metrics: false });
  await C.finishRun(a.id, { status: "succeeded", summary: "", stats: { notes_created: 1 } });
  await C.finishRun(b.id, { status: "succeeded", summary: "", stats: { notes_created: 1 } });
  assert.deepEqual(await items(a.id), ["Thursday 5 November · Film A"]);
  assert.deepEqual(await items(b.id), ["Friday 6 November · Film B"]);

  const [row] = await qRaw<{ run_id: string | null }>(`SELECT run_id FROM day_entries WHERE source = 'goodreads'`);
  assert.equal(row.run_id, null, "imports leave run_id empty");

  // A later run saves 5 November again: it moves to that run.
  const c = await C.queueRun(life.id, "manual");
  await C.startRun(c.id);
  await save(new AthenaWriter(life, c.id, stats(), new Date(), "Europe/London"), "2026-11-05", "Thursday 5 November · Film A again");
  await C.finishRun(c.id, { status: "succeeded", summary: "", stats: { notes_updated: 1 } });
  assert.deepEqual(await items(c.id), ["Thursday 5 November · Film A again"]);
  assert.deepEqual(await items(a.id), [], "nothing of a's is still a's");

  // A run from before 0026 (nothing stamped): the run's window, among unstamped items.
  const legacy = await C.queueRun(life.id, "schedule");
  await qRaw(`UPDATE collection_runs SET created_at = now() - interval '1 year' WHERE id = $1`, [legacy.id]);
  await C.startRun(legacy.id);
  const n = await createNote({ title: "Legacy day", body: "x", source: life.source });
  await C.recordCollected({ source: life.source, kind: "note", externalId: "life-log-2026-11-01", recordId: n.id, title: "Legacy day", itemDate: "2026-11-01" });
  await C.finishRun(legacy.id, { status: "succeeded", summary: "", stats: { notes_created: 1 } });
  assert.deepEqual(await items(legacy.id), ["Legacy day"], "unclaimed items in its window");
});
