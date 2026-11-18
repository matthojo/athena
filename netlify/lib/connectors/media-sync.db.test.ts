// Real path for the hourly check (media-sync.ts): Last.fm and Plex connected through the real /api routes, read by
// their real adapters (stubbed at fetch), two hourly checks, then the evening Life log run with a stand-in Claude
// that tries to save the same things again, then "Load history again". Postgres with every migration.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/media-sync.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties Days, Watch & read and the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";
import * as M from "./fixtures/media-servers";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const scrobble = (uts: number, album: string, artist: string) => ({
  name: `Track ${uts}`,
  artist: { name: artist, url: `https://www.last.fm/music/${encodeURIComponent(artist)}` },
  album: { "#text": album },
  url: `https://www.last.fm/music/x/_/${uts}`,
  date: { uts: String(uts) },
});
/** 6 Nov (GMT): Mordechai every 40 minutes from noon (12 plays to 19:20), Blackstar at 20:00–20:30 (4), two more Mordechai at 21:00 and 21:10. 5 Nov: one Hunky Dory. */
const SCROBBLES = [
  ...Array.from({ length: 12 }, (_, i) => scrobble(at("2026-11-06T12:00:00Z") + i * 2400, "Mordechai", "Khruangbin")),
  ...Array.from({ length: 4 }, (_, i) => scrobble(at("2026-11-06T20:00:00Z") + i * 600, "Blackstar", "David Bowie")),
  scrobble(at("2026-11-06T21:00:00Z"), "Mordechai", "Khruangbin"),
  scrobble(at("2026-11-06T21:10:00Z"), "Mordechai", "Khruangbin"),
  scrobble(at("2026-11-05T18:00:00Z"), "Hunky Dory", "David Bowie"),
  // Scrobbled late from a phone that was offline: it appears after the second check, timed hours before it.
  { ...scrobble(at("2026-11-06T13:15:00Z"), "Mordechai", "Khruangbin"), late: true },
  // Scrobbled three days late: only the evening run's week-long look-back reaches it.
  { ...scrobble(at("2026-11-03T20:00:00Z"), "Low", "David Bowie"), late: true },
].sort((a, b) => Number(b.date.uts) - Number(a.date.uts));

/** What the services have so far: the clock of the test's world. */
const world = { until: Infinity, limited: false, late: false };

const lastfm: F.Route = (u) => {
  if (u.host !== "ws.audioscrobbler.com") return undefined;
  const m = u.searchParams.get("method");
  if (m === "user.getinfo") return { body: { user: { name: "jordanscrobbles", playcount: "48211" } } };
  if (m !== "user.getrecenttracks") return { status: 404, body: {} };
  if (world.limited) return { status: 429, body: { error: 29, message: "Rate limit exceeded" } };
  const from = Number(u.searchParams.get("from") ?? 0);
  const to = Number(u.searchParams.get("to") ?? Infinity);
  const kept = SCROBBLES.filter((s) => Number(s.date.uts) >= from && Number(s.date.uts) <= to && Number(s.date.uts) <= world.until && (!("late" in s) || world.late));
  const limit = Number(u.searchParams.get("limit") ?? 50);
  const page = Number(u.searchParams.get("page") ?? 1);
  const pages = Math.max(1, Math.ceil(kept.length / limit));
  return { body: { recenttracks: { track: kept.slice((page - 1) * limit, page * limit), "@attr": { page: String(page), totalPages: String(pages), total: String(kept.length) } } } };
};

const plex: F.Route = (u, init) => {
  if (u.host === "clients.plex.tv") return { body: M.PLEX_RESOURCES };
  if (u.host !== new URL(M.PLEX_PUBLIC_URI).host) return undefined;
  if ((init.method ?? "GET") !== "GET") return { status: 405, body: {} };
  if (u.pathname === "/identity") return { body: { MediaContainer: { machineIdentifier: M.PLEX_MACHINE } } };
  if (u.pathname !== "/status/sessions/history/all") return undefined;
  if (Number.isFinite(world.until)) u.searchParams.set("viewedAt<", String(world.until));
  return { body: M.plexHistoryReply(u) };
};

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };

/** The evening run's Claude: it saves the same album and film under its own ids, as a run would, and writes the line. */
function standIn(seen: { tools: string[]; context: string; results: string[]; system?: string }) {
  let n = 0;
  return (u: URL, init: RequestInit): F.Reply | undefined => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { tools: Array<{ name: string }>; messages: Array<{ content: string | Block[] }> };
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    if (typeof body.messages[0].content === "string") seen.context = body.messages[0].content;
    const sys = (body as { system?: string | Array<{ text: string }> }).system;
    if (body.messages.length === 1 && sys) seen.system = typeof sys === "string" ? sys : sys.map((b) => b.text).join("\n");
    if (body.messages.length === 1) {
      seen.tools = body.tools.map((t) => t.name);
      return reply(
        [
          {
            type: "tool_use",
            id: "t_entries",
            name: "athena_day_entry",
            input: {
              date: "2026-11-06",
              entries: [
                { kind: "listened", source: "lastfm", external_id: "run:mordechai", title: "Mordechai", subtitle: "Khruangbin", count: 14 },
                { kind: "watched", source: "plex", external_id: "run:paddington", title: "Paddington in Peru", subtitle: "2024" },
                { kind: "listened", source: "spotify", external_id: "run:other", title: "Something else", subtitle: "Someone" },
              ],
            },
          },
          { type: "tool_use", id: "t_line", name: "athena_day_line", input: { date: "2026-11-06", line: "A Khruangbin day and Paddington in Peru" } },
        ],
        "tool_use",
      );
    }
    for (const b of Array.isArray(last.content) ? last.content : []) if (b.type === "tool_result") seen.results.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    return reply([{ type: "text", text: "Logged the day." }], "end_turn");
  };
}

test("Plays and watches: two scheduled runs, then the evening run, then Load history again: every play and watch once, and never Claude", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { mediaServerNet } = await import("./plex-direct");
  const realCheck = mediaServerNet.assertPublic;
  mediaServerNet.assertPublic = async () => undefined;
  F.installFetch();
  try {
    const seen = { tools: [] as string[], context: "", results: [] as string[], system: "" };
    F.stub(lastfm, plex, standIn(seen));
    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const B = await import("./backfill");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    const { lifeRetryWaits } = await import("./feeds-shared");
    lifeRetryWaits.ms = [1, 1];
    B.backfillTrigger.send = async () => undefined;
    for (const t of ["custom_values", "day_entries", "days", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM settings WHERE key LIKE 'media\\_sync.%' OR key LIKE 'history\\_load.%'`);
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
    const connect = async (body: Record<string, unknown>) => {
      const made = await api("POST", "/connectors", { account_label: "personal", ...body });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const checked = await api("POST", `/connectors/${made.json.id}/check`);
      assert.equal(checked.json.status, "connected", JSON.stringify(checked.json));
      return made.json.id as string;
    };
    world.until = at("2026-11-06T19:45:00Z");
    const lf = await connect({ provider: "lastfm", name: "Last.fm", auth_type: "token", url: "https://www.last.fm/user/jordanscrobbles", token: "k".repeat(32) });
    const px = await connect({ provider: "plex", name: "Plex", auth_type: "token", token: `${M.PLEX_PUBLIC_URI}/library/metadata/7001?X-Plex-Token=abcDEF123ghiJKL456mn` });
    await qRaw(`DELETE FROM settings WHERE key LIKE 'history\\_load.%'`);

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [lf, px], schedule: "daily", run_at: "21:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));
    const pw = await api("POST", "/collections", { recipe: "plays-watches", name: "Plays and watches", label: "personal", connector_ids: [lf, px], schedule: "hourly", every_hours: 1 });
    assert.equal(pw.status, 201, JSON.stringify(pw.json));

    const rows = async () =>
      (await q<{ source: string; date: string; title: string; count: number; run_id: string | null; folded_into: string | null; external_id: string }>(
        `SELECT source, to_char(date, 'YYYY-MM-DD') AS date, title, count, run_id, folded_into, external_id FROM day_entries WHERE source IN ('lastfm', 'plex', 'spotify')`,
      )).sort((a, b) => `${a.source}${a.date}${a.title}`.localeCompare(`${b.source}${b.date}${b.title}`));
    const { openStrict } = await import("../../../lib/data-box");
    const open = (s: string) => {
      try {
        return openStrict(s);
      } catch {
        return s;
      }
    };
    const shown = async () => (await rows()).map((r) => `${r.source} ${r.date} ${open(r.title)}${r.count > 1 ? ` ×${r.count}` : ""}`).sort();
    const claude = () => F.calls.filter((c) => c.url.host === "claude.test").length;
    const lfCalls = () => F.calls.filter((c) => c.url.host === "ws.audioscrobbler.com" && c.url.searchParams.get("method") === "user.getrecenttracks");

    /** The scheduler's tick at `iso`: Plays and watches is due, claimed and run, with no Claude. */
    const scheduled = async (iso: string) => {
      await qRaw(`UPDATE collections SET next_run_at = $2 WHERE id = $1`, [pw.json.id, new Date(Date.parse(iso) - 60_000).toISOString()]);
      const claimed = await C.claimDueCollections(new Date(iso), { recipes: ["plays-watches"] });
      assert.deepEqual(claimed.map((r) => r.collection_id), [pw.json.id]);
      const before = claude();
      await executeRun(claimed[0].id, new Date(iso));
      assert.equal(claude(), before, "Plays and watches never calls Claude");
      return (await C.listRuns(pw.json.id)).find((r) => r.id === claimed[0].id)!;
    };

    // ---- first scheduled run, 19:45 ----
    const r1 = await scheduled("2026-11-06T19:45:00Z");
    assert.equal(r1.status, "succeeded", r1.error);
    assert.equal(r1.summary, "13 plays, 2 watches", "12 Mordechai and a Hunky Dory; Conclave and an episode");
    assert.deepEqual({ plays: r1.stats.plays_new, watches: r1.stats.watches_new, tokens: r1.stats.input_tokens }, { plays: 13, watches: 2, tokens: undefined });
    // From the start of yesterday, the first time.
    assert.equal(lfCalls()[0].url.searchParams.get("from"), String(at("2026-11-05T00:00:00Z")));
    assert.deepEqual(await shown(), ["lastfm 2026-11-05 Hunky Dory", "lastfm 2026-11-06 Mordechai ×12", "plex 2026-11-05 Conclave", "plex 2026-11-06 Slow Horses"]);
    // What the run saved: its days, linked to the run.
    const items = await C.listRunItems(pw.json.id, r1.id);
    assert.deepEqual(items!.map((i) => i.record_id).sort(), ["2026-11-05", "2026-11-06"]);
    // Hours: Mordechai every 40 minutes from noon.
    const [mord] = await q<{ hours: string }>(`SELECT hours FROM day_entries WHERE source = 'lastfm' AND date = '2026-11-06' AND count = 12`);
    assert.deepEqual(JSON.parse(open(mord.hours)).slice(12, 20), [2, 1, 2, 1, 2, 1, 2, 1]);

    // ---- second, 20:45: the counts carry on ----
    world.until = at("2026-11-06T20:45:00Z");
    const before = lfCalls().length;
    const r2 = await scheduled("2026-11-06T20:45:00Z");
    assert.equal(lfCalls()[before].url.searchParams.get("from"), String(at("2026-11-05T00:00:00Z")), "Last.fm: from the start of yesterday, for late scrobbles");
    assert.equal(r2.summary, "4 plays, 1 watch");
    assert.deepEqual(await shown(), ["lastfm 2026-11-05 Hunky Dory", "lastfm 2026-11-06 Blackstar ×4", "lastfm 2026-11-06 Mordechai ×12", "plex 2026-11-05 Conclave", "plex 2026-11-06 Slow Horses", "plex 2026-11-06 Slow Horses"]);
    // The state holds times and hashes, never what was played.
    const [state] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [`media_sync.${lf}`]);
    assert.doesNotMatch(JSON.stringify(state.value), /Mordechai|Khruangbin|Bowie/);

    // ---- the evening run, 23:30: one last check (it finds the late scrobbles), no listings for the model, its repeats left out ----
    world.until = Infinity;
    world.late = true;
    const run = await C.queueRun(life.json.id, "manual");
    await executeRun(run.id, new Date("2026-11-06T23:30:00Z"));
    const done = (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    assert.equal(done.status, "succeeded", `${done.error ?? ""} ${JSON.stringify(done.stats)}`);
    assert.ok(!seen.tools.some((t) => t.endsWith("__list_scrobbles") || t.endsWith("__watch_history")), seen.tools.join());
    assert.ok(seen.tools.includes("athena_day_entry"));
    assert.match(seen.context, /Read by Your activity, already in Days: (lastfm, plex|plex, lastfm)/);
    // The recipe for this run: Last.fm's and Plex's rules gone (they're read whole), the rules on what never to write kept.
    assert.ok(seen.system && !seen.system.includes("   - Music (Spotify, Last.fm):") && !seen.system.includes("   - Plex, Jellyfin:"), "media rules trimmed");
    assert.ok(seen.system!.includes("   - Health (Strava,") && seen.system!.includes("   - Places"));
    assert.match(seen.system!, /Your activity already saved everything from lastfm, plex/);
    assert.match(seen.context, /2026-11-06 listened \(lastfm\): Mordechai · Khruangbin ×15/);
    assert.match(seen.results.join("\n"), /"already_in_days":2/);
    const settled = [
      "lastfm 2026-11-03 Low",
      "lastfm 2026-11-05 Hunky Dory",
      "lastfm 2026-11-06 Blackstar ×4",
      "lastfm 2026-11-06 Mordechai ×15",
      "plex 2026-11-05 Conclave",
      "plex 2026-11-06 Paddington in Peru",
      "plex 2026-11-06 Slow Horses",
      "plex 2026-11-06 Slow Horses",
      // Not read by Plays and watches: the run's own entry, as before.
      "spotify 2026-11-06 Something else",
    ];
    assert.deepEqual(await shown(), settled);
    const lifeRun = run.id;
    assert.ok((await rows()).filter((r) => r.source !== "spotify").every((r) => r.run_id !== lifeRun && r.folded_into === null), "nothing from the Life log run for those sources");
    const [line] = await q<{ line: string }>(`SELECT line FROM days WHERE date = '2026-11-06'`);
    assert.ok(line?.line, "the run still writes the day's line");

    // ---- Load history again: the same ids, nothing new ----
    for (const id of [lf, px]) {
      await B.startBackfill(id, "https://athena.test", { again: true });
      const p = await B.runBackfill(id, { budgetMs: 60_000 });
      assert.equal(p?.state, "done", JSON.stringify(p));
      assert.equal(p?.added, 0, `${id}: ${JSON.stringify(p)}`);
    }
    assert.deepEqual(await shown(), settled);
    assert.equal((await q(`SELECT id FROM reading_items`)).length, 3, "Conclave, Paddington in Peru, Slow Horses");

    // ---- a 429 waits an hour, then carries on ----
    world.limited = true;
    const t0 = Date.parse("2026-11-07T09:00:00Z");
    const r3 = await scheduled("2026-11-07T09:00:00Z");
    assert.equal(r3.status, "succeeded");
    assert.equal(r3.summary, "Nothing new. Last.fm asked Athena to wait · trying again at 10:00");
    assert.equal(r3.stats.waiting, 1);
    const [w] = await q<{ value: { resume_at: string } }>(`SELECT value FROM settings WHERE key = $1`, [`media_sync.${lf}`]);
    assert.equal(w.value.resume_at, new Date(t0 + 3600_000).toISOString());
    world.limited = false;
    const n429 = lfCalls().length;
    await scheduled("2026-11-07T09:30:00Z");
    assert.equal(lfCalls().length, n429, "still waiting: Last.fm isn't asked");
    await scheduled("2026-11-07T10:05:00Z");
    assert.ok(lfCalls().length > n429, "then it carries on");
    assert.deepEqual(await shown(), settled);

    // ---- switched off, or the account taken out: no reads ----
    assert.equal((await api("PATCH", `/collections/${pw.json.id}`, { connector_ids: [px] })).status, 200);
    const n1 = lfCalls().length;
    await scheduled("2026-11-07T11:05:00Z");
    assert.equal(lfCalls().length, n1, "Last.fm taken out: not read");
    assert.equal((await api("PATCH", `/collections/${pw.json.id}`, { enabled: false })).status, 200);
    await qRaw(`UPDATE collections SET next_run_at = $2 WHERE id = $1`, [pw.json.id, "2026-11-07T11:00:00Z"]);
    assert.deepEqual(await C.claimDueCollections(new Date("2026-11-07T12:05:00Z"), { recipes: ["plays-watches"] }), [], "switched off: never claimed");
    // And the evening run reads them itself again, without a second copy of what's there.
    seen.tools = [];
    const run2 = await C.queueRun(life.json.id, "manual");
    await executeRun(run2.id, new Date("2026-11-06T23:30:00Z"));
    assert.ok(seen.tools.some((t) => t.endsWith("__list_scrobbles")), seen.tools.join());
    assert.ok(seen.tools.some((t) => t.endsWith("__watch_history")), seen.tools.join());
    assert.deepEqual(await shown(), settled);
    assert.equal((await api("PATCH", `/collections/${pw.json.id}`, { enabled: true, connector_ids: [lf, px] })).status, 200);

    // A Life log whose accounts are all read by Plays and watches has no listings left for Claude: it still runs and writes the line.
    const plexOnly = await api("POST", "/collections", { recipe: "life-log", name: "Watching", label: "watching", connector_ids: [px], schedule: "daily", run_at: "21:30" });
    const run3 = await C.queueRun(plexOnly.json.id, "manual");
    await executeRun(run3.id, new Date("2026-11-06T23:30:00Z"));
    const done3 = (await C.listRuns(plexOnly.json.id)).find((r) => r.id === run3.id)!;
    assert.equal(done3.status, "succeeded", done3.error);
    assert.deepEqual(await shown(), settled);

    // Only GETs went to Last.fm and Plex.
    assert.ok(F.calls.filter((c) => c.url.host !== "claude.test").every((c) => (c.init.method ?? "GET") === "GET"));
  } finally {
    F.restoreFetch();
    mediaServerNet.assertPublic = realCheck;
  }
});
