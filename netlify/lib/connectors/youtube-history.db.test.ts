// Real path for the YouTube Takeout import: the real /api route, the real Life log save (AthenaWriter) and Postgres with every migration applied.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/youtube-history.db.test.ts
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

test("YouTube Takeout: one Day entry per video, idempotent, alongside Life log runs", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { handleConnectorRoutes } = await import("./routes");
  const { AthenaWriter } = await import("./runner");
  const C = await import("../../../lib/connectors");
  const { qRaw, q, archiveEntity } = await import("../../../lib/db");
  const T = await import("../../../lib/youtube-takeout");

  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);
  await qRaw(`DELETE FROM metrics WHERE metric LIKE 'videos_watched_day%'`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const api = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    try {
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 400, json: { error: (error as Error).message } };
    }
  };

  const yt = (await api("POST", "/connectors", { provider: "youtube", name: "YouTube", account_label: "personal", client_id: "1-yt.apps.googleusercontent.com", client_secret: "GOCSPX-yt" })).json;
  const gmail = (await api("POST", "/connectors", { provider: "gmail", name: "Gmail", account_label: "personal", client_id: "1-g.apps.googleusercontent.com", client_secret: "GOCSPX-g" })).json;

  // Only YouTube accounts have it.
  assert.equal((await api("GET", `/connectors/${gmail.id}/watch-history`)).status, 404);

  // No Life log yet: the days go where a personal one would put them.
  let target = await api("GET", `/connectors/${yt.id}/watch-history`);
  assert.equal(target.status, 200);
  assert.deepEqual(target.json, { tz: "Europe/London", collection: null, metric: "videos_watched_day_personal", source: "life-log-personal", last_import: null });

  const life = (await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [yt.id], schedule: "daily", run_at: "23:30" })).json;
  target = await api("GET", `/connectors/${yt.id}/watch-history`);
  assert.deepEqual(target.json.collection, { id: life.id, name: "Life log" });

  // Bad input is refused before anything is written.
  assert.equal((await api("POST", `/connectors/${yt.id}/watch-history`, { days: [{ day: "2026-02-30", videos: [{ id: "aaaaaaaaaa1" }] }] })).status, 400);
  assert.equal((await api("POST", `/connectors/${yt.id}/watch-history`, { days: [{ day: "2026-07-03", videos: [{ id: "nope" }] }] })).status, 400);
  assert.equal((await api("POST", `/connectors/${yt.id}/watch-history`, { days: [] })).status, 400);

  // The fixture, parsed and grouped the way the app does it.
  const parsed = T.parseWatchHistory(readFileSync(new URL("../../../lib/fixtures/takeout-watch-history.json", import.meta.url), "utf8"));
  const days = T.groupByDay(parsed.watches, "Europe/London");
  assert.deepEqual(days.map((d) => d.day), ["2026-01-15", "2026-07-03", "2026-07-04"]);

  // A Life log run already wrote 3 July before the import.
  const writer = (now: Date) =>
    new AthenaWriter(life, "00000000-0000-0000-0000-000000000000", { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0, skipped_dismissed: 0 } as never, now, "Europe/London");
  const severance = { kind: "watched", source: "trakt", external_id: "h-1", title: "Severance", subtitle: "S2E3 · Who Is Alive?" };
  await writer(new Date("2026-07-04T09:00:00Z")).run("athena_day_entry", { date: "2026-07-03", entries: [severance] });
  await writer(new Date("2026-07-04T09:00:00Z")).run("athena_day_line", { date: "2026-07-03", line: "Severance" });

  const first = await api("POST", `/connectors/${yt.id}/watch-history`, { days, metrics: true });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json, { days_created: 2, days_updated: 1, days_unchanged: 0, days_skipped: 0, added: 4, added_tracks: 1 });

  const { getDay } = await import("../../../lib/days");
  const dayOf = async (date: string) => (await getDay(date, { tz: "Europe/London", health: false, places: false }))!;
  const show = (e: { kind: string; source: string; title: string; subtitle?: string; url?: string; count?: number }) => [e.kind, e.source, e.title, e.subtitle ?? null, e.url ?? null, e.count ?? 1];
  const jul3 = await dayOf("2026-07-03");
  assert.equal(jul3.line, "Severance", "the run's line stands");
  assert.deepEqual(show(jul3.entries[0]), ["watched", "trakt", "Severance", "S2E3 · Who Is Alive?", null, 1]);
  assert.ok(jul3.entries.some((e) => show(e).join("|") === ["watched", "youtube", "Making a walnut desk", "Fixture Workshop", "https://www.youtube.com/watch?v=aaaaaaaaaa1", 1].join("|")), JSON.stringify(jul3.entries));
  assert.ok(jul3.entries.some((e) => e.kind === "listened" && e.source === "youtube_music" && e.title === "Low Tide"));
  assert.ok(!JSON.stringify(jul3).includes("Spring sale"), "no ads");

  const jan15 = await dayOf("2026-01-15");
  assert.deepEqual(jan15.entries.map((e) => [e.title, e.url]), [["A video that's no longer on YouTube", "https://www.youtube.com/watch?v=eeeeeeeeee5"]]);
  assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE source LIKE 'life-log%'`))[0].n, 0, "no day notes");

  // Sealed at rest.
  for (const r of await qRaw<{ title: string; url: string | null }>(`SELECT title, url FROM day_entries`)) assert.ok(r.title.startsWith("enc:") && (!r.url || r.url.startsWith("enc:")));

  // Counts: watched videos per day, YouTube Music left out.
  const metrics = await q<{ metric: string; value: number; day: string }>(
    `SELECT metric, value::int AS value, metadata->>'day' AS day FROM metrics WHERE metric LIKE 'videos_watched_day%' ORDER BY 3`,
  );
  assert.deepEqual(metrics, [
    { metric: "videos_watched_day_personal", value: 1, day: "2026-01-15" },
    { metric: "videos_watched_day_personal", value: 2, day: "2026-07-03" },
    { metric: "videos_watched_day_personal", value: 1, day: "2026-07-04" },
  ]);

  // The same file again adds nothing, and no metric is doubled.
  const again = await api("POST", `/connectors/${yt.id}/watch-history`, { days, metrics: true });
  assert.deepEqual(again.json, { days_created: 0, days_updated: 0, days_unchanged: 3, days_skipped: 0, added: 0, added_tracks: 0 });
  assert.equal((await qRaw(`SELECT 1 FROM metrics WHERE metric LIKE 'videos_watched_day%'`)).length, 3);

  // A later Life log run over 3 July changes only its own entries: the import's stay.
  await writer(new Date("2026-07-05T09:00:00Z")).run("athena_day_entry", {
    date: "2026-07-03",
    entries: [severance, { kind: "listened", source: "lastfm", external_id: "bs-1", title: "Blackstar", subtitle: "David Bowie", note: "the whole album", count: 7 }],
  });
  const rewritten = await dayOf("2026-07-03");
  assert.ok(rewritten.entries.some((e) => e.title === "Blackstar"));
  assert.ok(rewritten.entries.some((e) => e.title === "Making a walnut desk") && rewritten.entries.some((e) => e.title === "Low Tide"), "imported entries survive the Life log");

  // An entry you hide stays hidden through the next import.
  const { hideEntry } = await import("../../../lib/days");
  await hideEntry(jan15.entries[0].id);
  const later = days.map((d) => (d.day === "2026-01-15" ? { ...d, videos: [{ ...d.videos[0], count: 2 }] } : d));
  const third = await api("POST", `/connectors/${yt.id}/watch-history`, { days: later, metrics: false });
  assert.deepEqual(third.json, { days_created: 0, days_updated: 0, days_unchanged: 2, days_skipped: 1, added: 0, added_tracks: 0 });

  // A newer export with one more play updates that entry's count.
  const jul4 = days.find((d) => d.day === "2026-07-04")!;
  const fourth = await api("POST", `/connectors/${yt.id}/watch-history`, { days: [{ ...jul4, videos: [{ ...jul4.videos[0], count: 2 }] }] });
  assert.deepEqual(fourth.json, { days_created: 0, days_updated: 1, days_unchanged: 0, days_skipped: 0, added: 0, added_tracks: 0 });
  assert.equal((await dayOf("2026-07-04")).entries[0].count, 2);
});
