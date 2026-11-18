// A whole Life log run from Plex and Jellyfin into Watch & read: the real routes connect both accounts (the key is
// checked), the real executeRun opens them through their adapters (replies in fixtures/media-servers.ts), and a
// stand-in Claude calls watch_history on each, then athena_watch_read per film and per show, as the Life log asks.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/media-servers-watch-read.db.test.ts
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

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type Item = { kind: string; title?: string; show?: string; year?: number; date: string; id?: string; show_id?: string; link?: string; show_link?: string };

/** One Watch & read call per film and per show, as the Life log's wording asks (docs/notes/media-chess-tripit.md). */
function saves(source: "plex" | "jellyfin", items: Item[]): Array<Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const i of items) {
    if (i.kind === "film") out.set(`f:${i.id}`, { kind: "film", title: i.title, year: i.year, status: "done", at: i.date, url: i.link, external_id: i.id, source });
    else if (!out.has(`s:${i.show_id}`)) out.set(`s:${i.show_id}`, { kind: "tv", title: i.show, status: "reading", at: i.date, url: i.show_link, external_id: i.show_id, source });
  }
  return [...out.values()];
}

function standIn(seen: { tools: string[] }) {
  let n = 0;
  return (u: URL, init: RequestInit): F.Reply | undefined => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { tools: Array<{ name: string }>; messages: Array<{ content: string | Block[] }> };
    seen.tools = body.tools.map((t) => t.name);
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    if (!results.length) {
      const reads = body.tools.filter((t) => t.name.endsWith("__watch_history"));
      return reply(reads.map((t) => ({ type: "tool_use", id: `t_${t.name}`, name: t.name, input: { date: "2026-11-06" } })), "tool_use");
    }
    const calls: Block[] = [];
    for (const r of results) {
      if (!r.tool_use_id?.endsWith("__watch_history")) continue;
      const text = typeof r.content === "string" ? r.content : (r.content as Block[]).map((b) => b.text ?? "").join("");
      const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { items: Item[] };
      const source = r.tool_use_id.includes("plex") ? "plex" : "jellyfin";
      for (const input of saves(source, out.items)) calls.push({ type: "tool_use", id: `t_save_${calls.length}`, name: "athena_watch_read", input: JSON.parse(JSON.stringify(input)) });
    }
    return calls.length ? reply(calls, "tool_use") : reply([{ type: "text", text: "Saved to Watch & read." }], "end_turn");
  };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string> | undefined)?.[name];

test("Life log run: Plex and Jellyfin films and shows land in Watch & read, one item each", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { mediaServerNet } = await import("./plex-direct");
  const realCheck = mediaServerNet.assertPublic;
  mediaServerNet.assertPublic = async () => undefined;
  F.installFetch();
  try {
    const seen = { tools: [] as string[] };
    F.stub(
      (u, init) => (u.host === "clients.plex.tv" ? { body: M.PLEX_RESOURCES } : init.method && init.method !== "GET" && u.host !== "claude.test" ? { status: 405, body: {} } : undefined),
      (u) => {
        if (u.host !== new URL(M.PLEX_PUBLIC_URI).host) return undefined;
        if (u.pathname === "/identity") return { body: { MediaContainer: { machineIdentifier: M.PLEX_MACHINE } } };
        if (u.pathname === "/status/sessions/history/all") return { body: M.plexHistoryReply(u) };
        return undefined;
      },
      (u, init) => {
        if (u.origin !== M.JELLYFIN_BASE) return undefined;
        if (header(init, "X-Emby-Token") !== "0123456789abcdef0123456789abcdef") return { status: 401, body: {} };
        if (u.pathname === "/System/Info") return { body: M.JELLYFIN_INFO };
        if (u.pathname === "/Users") return { body: M.JELLYFIN_USERS };
        if (u.pathname === "/Items") return { body: M.jellyfinItemsReply(u) };
        return undefined;
      },
      standIn(seen),
    );

    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    for (const t of ["custom_values", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
    await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
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
      assert.equal(checked.status, 200, JSON.stringify(checked.json));
      assert.equal(checked.json.status, "connected");
      return made.json.id as string;
    };

    // Plex: just the token, pasted as the View XML address. Jellyfin: a bare host name and the key.
    const px = await connect({ provider: "plex", name: "Plex", auth_type: "token", token: `${M.PLEX_PUBLIC_URI}/library/metadata/7001?X-Plex-Token=abcDEF123ghiJKL456mn` });
    const jf = await connect({ provider: "jellyfin", name: "Jellyfin", auth_type: "token", url: "jellyfin.example.com", token: "0123456789abcdef0123456789abcdef" });
    assert.equal((await C.getConnector(jf))!.url.replace(/\/$/, ""), M.JELLYFIN_BASE);
    // A wrong Jellyfin key is refused by the check.
    const bad = await api("POST", "/connectors", { provider: "jellyfin", name: "Jellyfin", auth_type: "token", url: M.JELLYFIN_BASE, token: "ffffffffffffffffffffffffffffffff" });
    const badCheck = await api("POST", `/connectors/${bad.json.id}/check`);
    assert.equal((await C.getConnector(bad.json.id))!.status, "needs_auth", JSON.stringify(badCheck.json));
    await api("DELETE", `/connectors/${bad.json.id}`);

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [px, jf], schedule: "daily", run_at: "23:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));
    const runOnce = async () => {
      const run = await C.queueRun(life.json.id, "manual");
      await executeRun(run.id, new Date("2026-11-06T23:30:00Z"));
      return (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    };
    const done = await runOnce();
    assert.equal(done.status, "succeeded", `${done.error ?? ""} ${JSON.stringify(done.stats)}`);
    assert.ok(seen.tools.includes("athena_watch_read"));
    assert.ok(seen.tools.some((t) => t.startsWith("plex") && t.endsWith("__watch_history")), seen.tools.join());
    assert.ok(seen.tools.some((t) => t.startsWith("jellyfin") && t.endsWith("__watch_history")), seen.tools.join());

    const items = await q<{ title: string; kind: string; status: string; url: string }>(`SELECT title, kind, status, url FROM reading_items`);
    assert.deepEqual(
      // Titles are sealed at rest, so sort here rather than in SQL.
      items.map((i) => [i.kind, i.title, i.status]).sort((x, y) => `${x[0]} ${x[1]}`.localeCompare(`${y[0]} ${y[1]}`)),
      [
        ["film", "Paddington in Peru", "done"],
        ["film", "Past Lives", "done"],
        ["tv", "Shōgun", "reading"],
        ["tv", "Slow Horses", "reading"],
      ],
    );
    assert.equal(items.find((i) => i.title === "Slow Horses")!.url, `https://app.plex.tv/desktop/#!/server/${M.PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F499`);
    // Two episodes of each show made one item. Running again changes nothing.
    const again = await runOnce();
    assert.equal(again.status, "succeeded");
    assert.equal((await q(`SELECT id FROM reading_items`)).length, 4);
    // Only GETs went to Plex and Jellyfin.
    assert.ok(F.calls.filter((c) => c.url.host !== "claude.test").every((c) => (c.init.method ?? "GET") === "GET"));
  } finally {
    F.restoreFetch();
    mediaServerNet.assertPublic = realCheck;
  }
});
