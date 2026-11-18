// Real path for Your activity beyond plays and watches (activity-recent.ts): Readwise, Bluesky, Mastodon, Lichess,
// Raindrop.io and Strava connected through the real /api routes and read by their real adapters, stubbed at fetch.
// Two hourly runs (no Claude), then the evening Life log run with a stand-in Claude (it gets none of their listings and
// may only write the day's line), then Load history again, then Ask reading a covered account. Postgres with every
// migration.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/activity.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties Days, metrics, health days and the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";
import * as R from "./fixtures/reading-social-recorded";
import * as L from "./fixtures/life-b-recorded";
import { LICHESS_GAMES_NDJSON, LICHESS_USER } from "./fixtures/chess-recorded";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

type Obj = Record<string, unknown>;
type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
const at = (host: string, path: string, body: unknown | ((u: URL) => unknown), status = 200): F.Route => (u) => (u.host === host && u.pathname === path ? { status, body: typeof body === "function" ? (body as (u: URL) => unknown)(u) : body } : undefined);

/** Strava: one run on 6 Nov, read back by the day asked for. */
const RUN = { id: 1001, name: "Morning Run", type: "Run", sport_type: "Run", distance: 8123.4, moving_time: 2580, elapsed_time: 2702, total_elevation_gain: 64.2, start_date: "2026-11-06T07:12:00Z", start_date_local: "2026-11-06T07:12:00Z" };
const stravaActivities = (u: URL) => {
  const after = Number(u.searchParams.get("after") ?? 0) * 1000;
  const before = Number(u.searchParams.get("before") ?? Infinity) * 1000;
  return u.searchParams.get("page") === "1" || !u.searchParams.get("page") ? [RUN].filter((a) => Date.parse(a.start_date) >= after && Date.parse(a.start_date) < before) : [];
};
/** Lichess's games, newest first, cut by since and until as the API does. */
const lichessGames = (u: URL) => {
  const since = Number(u.searchParams.get("since") ?? 0);
  const until = Number(u.searchParams.get("until") ?? Infinity);
  return LICHESS_GAMES_NDJSON.split("\n").filter((l) => l.trim() && (JSON.parse(l) as { createdAt: number }).createdAt >= since && (JSON.parse(l) as { createdAt: number }).createdAt <= until).join("\n");
};

/** The evening run's Claude: it notes what it was given, tries to save a covered source's entry and metric again, and writes the line. */
function standIn(seen: { tools: string[]; system: string; context: string; results: string[] }): F.Route {
  let n = 0;
  return (u, init) => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { system: string | Array<{ text: string }>; tools: Array<{ name: string }>; messages: Array<{ content: string | Block[] }> };
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    if (body.messages.length === 1) {
      seen.tools = body.tools.map((t) => t.name);
      seen.system = typeof body.system === "string" ? body.system : body.system.map((s) => s.text).join("\n");
      seen.context = typeof body.messages[0].content === "string" ? body.messages[0].content : "";
      return reply(
        [
          { type: "tool_use", id: "t_entries", name: "athena_day_entry", input: { date: "2026-11-06", entries: [{ kind: "posted", source: "bluesky", external_id: "run:post", title: "A post again" }] } },
          { type: "tool_use", id: "t_metric", name: "athena_metric", input: { name: "posts_made_day", value: 99, day: "2026-11-06" } },
          { type: "tool_use", id: "t_line", name: "athena_day_line", input: { date: "2026-11-06", line: "Highlights from The Wager, a game of chess and a run" } },
        ],
        "tool_use",
      );
    }
    for (const b of Array.isArray(last.content) ? last.content : []) if (b.type === "tool_result") seen.results.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    return reply([{ type: "text", text: "Wrote the day's line." }], "end_turn");
  };
}

test("Your activity: two hourly runs, the evening run, Load history again and Ask: each thing once, never Claude for the data", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { mastodonNet } = await import("./mastodon-direct");
  const lookup = mastodonNet.lookup;
  mastodonNet.lookup = async () => [{ address: "151.101.1.1", family: 4 }];
  F.installFetch();
  try {
    const seen = { tools: [] as string[], system: "", context: "", results: [] as string[] };
    F.stub(
      at("readwise.io", "/api/v2/auth/", {}, 204),
      at("readwise.io", "/api/v2/export/", { count: 2, nextPageCursor: null, results: [R.ESSAY, R.WAGER] }),
      at("public.api.bsky.app", "/xrpc/app.bsky.actor.getProfile", R.BSKY_PROFILE),
      at("public.api.bsky.app", "/xrpc/app.bsky.feed.getAuthorFeed", (u: URL) => (u.searchParams.get("cursor") ? { feed: [] } : R.BSKY_PAGE_1)),
      at("mastodon.social", "/api/v1/accounts/verify_credentials", R.MASTO_ME),
      at("mastodon.social", "/api/v1/accounts/13179/statuses", (u: URL) => (u.searchParams.get("max_id") ? [] : R.MASTO_PAGE_1)),
      at("lichess.org", `/api/user/${LICHESS_USER.username}`, LICHESS_USER),
      at("lichess.org", `/api/games/user/${LICHESS_USER.username}`, lichessGames),
      at("api.raindrop.io", "/rest/v1/user", L.RAINDROP_USER),
      at("api.raindrop.io", "/rest/v1/collections", L.RAINDROP_COLLECTIONS),
      at("api.raindrop.io", "/rest/v1/collections/childrens", L.RAINDROP_CHILDREN),
      at("api.raindrop.io", "/rest/v1/raindrops/0", (u: URL) => (u.searchParams.get("page") === "1" ? L.RAINDROP_PAGE_1 : u.searchParams.get("page") === "0" || !u.searchParams.get("page") ? L.RAINDROP_PAGE_0 : { result: true, items: [] })),
      at("www.strava.com", "/api/v3/athlete", { id: 99, username: "jordan" }),
      at("www.strava.com", "/api/v3/athlete/activities", stravaActivities),
      at("www.strava.com", `/api/v3/activities/${RUN.id}`, { ...RUN, calories: 610 }),
      standIn(seen),
    );
    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const B = await import("./backfill");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    const { lifeRetryWaits } = await import("./feeds-shared");
    const { openStrict } = await import("../../../lib/data-box");
    lifeRetryWaits.ms = [1, 1];
    B.backfillTrigger.send = async () => undefined;
    for (const t of ["custom_values", "day_entries", "days", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM settings WHERE key LIKE 'media\\_sync.%' OR key LIKE 'history\\_load.%'`);
    await qRaw(`DELETE FROM metrics WHERE metric LIKE '%\\_day\\_personal'`);
    await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
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
    const connect = async (body: Obj, tokens = false) => {
      const made = await api("POST", "/connectors", { account_label: "personal", ...body });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      if (tokens) await C.updateConnectorSecrets(made.json.id, (s) => void (s.tokens = { access_token: "at", refresh_token: "rt", expires_in: 86400, obtained_at: Date.now() } as never));
      const checked = await api("POST", `/connectors/${made.json.id}/check`);
      assert.equal(checked.json.status, "connected", JSON.stringify(checked.json));
      return made.json.id as string;
    };
    const rw = await connect({ provider: "readwise", name: "Readwise", token: "rw_token_0123456789" });
    const bs = await connect({ provider: "bluesky", name: "Bluesky", url: "@jordan.bsky.social" });
    const md = await connect({ provider: "mastodon", name: "Mastodon", url: "jordan@mastodon.social", token: "masto_token_abc" });
    const li = await connect({ provider: "lichess", name: "Lichess", url: LICHESS_USER.username });
    const rd = await connect({ provider: "raindrop", name: "Raindrop.io", token: "rd_token_0123456789" });
    const st = await connect({ provider: "strava", name: "Strava", client_id: "12345", client_secret: "strava-secret" }, true);
    const ids = [rw, bs, md, li, rd, st];
    // The history loads Raindrop started on connect: forgotten, so the hourly check is what fills these days.
    await qRaw(`DELETE FROM settings WHERE key LIKE 'history\\_load.%'`);
    await qRaw(`DELETE FROM day_entries`);

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: ids, schedule: "daily", run_at: "21:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));
    const ya = await api("POST", "/collections", { recipe: "plays-watches", name: "Your activity", label: "personal", connector_ids: ids, schedule: "hourly", every_hours: 1 });
    assert.equal(ya.status, 201, JSON.stringify(ya.json));

    const open = (s: string | null) => {
      if (s === null) return "";
      try {
        return openStrict(s);
      } catch {
        return s;
      }
    };
    const rows = async () =>
      (await q<{ source: string; date: string; kind: string; title: string; count: number; external_id: string; note: string | null; run_id: string | null }>(`SELECT source, to_char(date, 'YYYY-MM-DD') AS date, kind, title, count, external_id, note, run_id FROM day_entries WHERE source <> 'places'`)).sort((a, b) =>
        `${a.source}${a.date}${a.title}`.localeCompare(`${b.source}${b.date}${b.title}`),
      );
    const shown = async () => (await rows()).map((r) => `${r.source} ${r.date} ${r.kind} ${open(r.title)}${r.count > 1 ? ` ×${r.count}` : ""}`);
    const claude = () => F.calls.filter((c) => c.url.host === "claude.test").length;
    const scheduled = async (iso: string) => {
      await qRaw(`UPDATE collections SET next_run_at = $2 WHERE id = $1`, [ya.json.id, new Date(Date.parse(iso) - 60_000).toISOString()]);
      const claimed = await C.claimDueCollections(new Date(iso), { recipes: ["plays-watches"] });
      assert.deepEqual(claimed.map((r) => r.collection_id), [ya.json.id]);
      const before = claude();
      await executeRun(claimed[0].id, new Date(iso));
      assert.equal(claude(), before, "Your activity never calls Claude");
      return (await C.listRuns(ya.json.id)).find((r) => r.id === claimed[0].id)!;
    };

    // ---- first hourly run, 7 Nov 10:00: from the start of 6 Nov ----
    const r1 = await scheduled("2026-11-07T10:00:00Z");
    assert.equal(r1.status, "succeeded", r1.error);
    const first = await shown();
    // Readwise: 2 on 6 Nov and one made on 5 Nov that reached Readwise on the 6th, plus the essay; Bluesky and Mastodon 2 each; 50 bookmarks from the 6th and 7th; Strava's run.
    assert.equal(r1.summary, "4 highlights, 1 chess game, 4 posts, 50 bookmarks, 1 workout");
    assert.equal(r1.stats.input_tokens, undefined, "no tokens: no Claude");
    assert.ok(first.some((s) => s === "lichess 2026-11-06 chess Chess on Lichess"), "one chess entry for the day");
    assert.ok(first.some((s) => s.startsWith("readwise 2026-11-06 highlight")));
    assert.ok(first.some((s) => s.startsWith("raindrop 2026-11-07 saved How to make sourdough")));
    // Nothing from anyone else: no opponent, no highlight's words, no handle.
    const raw = JSON.stringify((await rows()).map((r) => ({ ...r, title: open(r.title), note: open(r.note), external_id: open(r.external_id) })));
    assert.doesNotMatch(raw, /grandchecker|Mutiny is a matter of perspective/);
    // The run's line names each kind, and its stats keep counts only.
    assert.equal(typeof r1.stats.highlights_new, "number");
    // Health: sealed, never an entry.
    const health = await q<{ source: string; day: string }>(`SELECT source, to_char(day, 'YYYY-MM-DD') AS day FROM sensitive_blobs WHERE domain = 'health'`);
    assert.deepEqual(health, [{ source: "strava", day: "2026-11-06" }]);
    assert.ok(!(await rows()).some((r) => r.source === "strava" || r.kind === "workout"));
    // The Life log's daily counts, worked out from Days under its own name.
    const metrics = await q<{ metric: string; value: number; day: string; src: string; by: string }>(`SELECT metric, value, metadata->>'day' AS day, metadata->>'source' AS src, metadata->>'by' AS by FROM metrics WHERE metric LIKE '%\\_day\\_personal' ORDER BY metric, day`);
    assert.ok(metrics.some((m) => m.metric === "chess_games_day_personal" && m.day === "2026-11-06" && m.src === life.json.source && m.by === "your-activity"));
    assert.ok(metrics.some((m) => m.metric === "highlights_made_day_personal" && m.day === "2026-11-06"));
    assert.ok(metrics.some((m) => m.metric === "posts_made_day_personal" && m.day === "2026-11-06"));
    assert.ok(!metrics.some((m) => /sleep|workout|steps/.test(m.metric)), "no health metric");
    assert.ok(!metrics.some((m) => m.metric === "chess_games_day_personal" && m.day === "2026-11-05"), "Lichess wasn't read for 5 Nov (only Readwise was): no chess count for it");

    // ---- second hourly run, 11:00: the same things, nothing new ----
    const r2 = await scheduled("2026-11-07T11:00:00Z");
    assert.equal(r2.summary, "Nothing new");
    assert.deepEqual(await shown(), first);
    const [state] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [`media_sync.${bs}`]);
    assert.doesNotMatch(JSON.stringify(state.value), /bsky\.app|Mutiny|Replied|Quoted/, "the kept state is hashes and numbers");

    // ---- the evening Life log run, 21:30: no listings, no health tool, only the line ----
    const run = await C.queueRun(life.json.id, "manual");
    await executeRun(run.id, new Date("2026-11-07T21:30:00Z"));
    const done = (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    assert.equal(done.status, "succeeded", `${done.error ?? ""} ${JSON.stringify(done.stats)}`);
    const sourceTools = seen.tools.filter((t) => t.includes("__"));
    assert.deepEqual(sourceTools, [], `no listings for covered accounts: ${sourceTools.join()}`);
    assert.ok(!seen.tools.includes("athena_health_day"), "Strava's days are saved already");
    assert.ok(!seen.system.includes("   - Readwise:") && !seen.system.includes("   - Chess (Lichess, Chess.com):") && seen.system.includes("   - Health (Strava,"));
    assert.match(seen.system, /Your activity already saved everything from bluesky, lichess, mastodon, raindrop, readwise, strava/);
    assert.match(seen.context, /Read by Your activity, already in Days/);
    assert.match(seen.context, /2026-11-06 chess \(lichess\): Chess on Lichess/);
    assert.match(seen.results.join("\n"), /"already_in_days":1/, "the repeated post is left out");
    assert.match(seen.results.join("\n"), /Athena counts posts_made_day itself/);
    assert.deepEqual(await shown(), first, "the evening run wrote no entries");
    assert.ok((await rows()).every((r) => r.run_id !== run.id));
    const [line] = await q<{ line: string }>(`SELECT line FROM days WHERE date = '2026-11-06'`);
    assert.equal(line?.line, "Highlights from The Wager, a game of chess and a run");
    const [posts] = await q<{ value: number }>(`SELECT value FROM metrics WHERE metric = 'posts_made_day_personal' AND metadata->>'day' = '2026-11-06'`);
    assert.notEqual(posts.value, 99, "Claude's count isn't kept");

    // A Life log without the other accounts still writes its lines from everything Your activity saved.
    const chessOnly = await api("POST", "/collections", { recipe: "life-log", name: "Chess", label: "chess", connector_ids: [li], schedule: "daily", run_at: "21:30" });
    const run2 = await C.queueRun(chessOnly.json.id, "manual");
    await executeRun(run2.id, new Date("2026-11-07T21:30:00Z"));
    assert.equal((await C.listRuns(chessOnly.json.id)).find((r) => r.id === run2.id)!.status, "succeeded");
    assert.match(seen.context, /Read by Your activity, already in Days: .*readwise/);
    assert.match(seen.context, /2026-11-06 highlight \(readwise\): The Wager/);
    await qRaw(`DELETE FROM collections WHERE id = $1`, [chessOnly.json.id]);

    // ---- Load history again (Raindrop): the same ids, nothing new ----
    await B.startBackfill(rd, "https://athena.test", { again: true });
    const p = await B.runBackfill(rd, { budgetMs: 60_000 });
    assert.equal(p?.state, "done", JSON.stringify(p));
    const after = await shown();
    const fresh = after.filter((s) => !first.includes(s));
    assert.ok(fresh.every((s) => s.startsWith("raindrop 2026-11-05")), `only days before the hourly check: ${fresh.join()}`);
    const ext = (await rows()).map((r) => `${r.source} ${open(r.external_id)}`);
    assert.equal(new Set(ext).size, ext.length, "no duplicate ids");
    // A third hourly run after the load adds nothing either.
    assert.equal((await scheduled("2026-11-07T22:00:00Z")).summary, "Nothing new");

    // ---- Ask still reads a covered account live, and finds what the hourly check saved in Days ----
    const { answerSources } = await import("./answer-sources");
    const sources = await answerSources.open({ timeoutMs: 20_000 });
    try {
      const readwise = sources.accounts.find((a) => a.connector?.provider === "readwise")!;
      assert.ok(readwise.tools.some((t) => t.name === "list_highlights"), "Readwise's live read stays in Ask");
      const live = await readwise.call("list_highlights", { date: "2026-11-06", text: false }, 20_000);
      assert.match(JSON.stringify(live), /The Wager/);
    } finally {
      await sources.close();
    }
    const { ReadTools } = await import("../../../lib/ask-tools");
    const ask = new ReadTools({ tz: "Europe/London", now: new Date("2026-11-07T22:00:00Z"), cite: (kind, id) => `${kind}:${id}` });
    const day = await ask.run("days", { date: "2026-11-06" });
    assert.match(day, /Chess on Lichess/);
    assert.match(day, /The Wager/);
    assert.match(await ask.run("health", { from: "2026-11-06", to: "2026-11-06" }), /run/i, "Strava's run in Ask's health read");

    // Only GETs went to the services.
    assert.ok(F.calls.filter((c) => c.url.host !== "claude.test").every((c) => (c.init.method ?? "GET") === "GET"));
  } finally {
    F.restoreFetch();
    mastodonNet.lookup = lookup;
  }
});
