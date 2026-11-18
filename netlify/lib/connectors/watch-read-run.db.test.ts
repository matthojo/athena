// Whole Life log runs into Watch & read: the real executeRun over three accounts read through their real adapters
// with recorded replies (fixtures/feeds-recorded.ts): a Letterboxd diary feed, Trakt's API, and Goodreads' shelf
// widgets. A stand-in Claude calls every read tool, then saves each title with athena_watch_read the way the run's
// rule says. Postgres with every migration (0029 included).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/watch-read-run.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type Msg = { role: string; content: string | Block[] };
type Media = { kind?: string; title?: string; show?: string; year?: number; day?: string; link?: string; rating?: string; progress?: string };
type Book = { title: string; author?: string; rating?: string; link?: string; noticed_on?: string };

/** The read calls the stand-in makes first: tool-name suffix, its arguments, and how its answer becomes Watch & read calls. */
const READS: Array<{ id: string; tool: string; args: Record<string, unknown>; save: (out: Record<string, unknown>) => Array<Record<string, unknown>> }> = [
  {
    id: "diary",
    tool: "list_diary",
    args: {},
    save: (o) => (o.films as Array<{ title: string; year?: number; watched_on: string; rating?: string; link?: string }>).map((f) => ({ kind: "film", title: f.title, year: f.year, status: "done", rating: f.rating, at: f.watched_on, url: f.link, source: "letterboxd" })),
  },
  {
    id: "history",
    tool: "list_history",
    args: {},
    save: (o) =>
      (o.watched as Media[]).map((m) =>
        m.kind === "episode"
          ? { kind: "tv", title: m.show, status: "reading", at: m.day, url: m.link, source: "trakt" }
          : { kind: "film", title: m.title, year: m.year, status: "done", at: m.day, url: m.link, source: "trakt" },
      ),
  },
  {
    id: "ratings",
    tool: "list_ratings",
    args: {},
    // An episode's rating isn't the show's: only films and shows get stars.
    save: (o) => (o.ratings as Media[]).filter((m) => m.kind === "film" || m.kind === "show").map((m) => ({ kind: m.kind === "show" ? "tv" : "film", title: m.title, year: m.year, status: "done", rating: m.rating, at: m.day, url: m.link, source: "trakt" })),
  },
  {
    id: "watchlist",
    tool: "list_watchlist",
    args: {},
    save: (o) => (o.watchlist as Media[]).map((m) => ({ kind: m.kind === "film" ? "film" : "tv", title: m.title, year: m.year, status: "queued", at: m.day, url: m.link, source: "trakt" })),
  },
  {
    id: "progress",
    tool: "list_in_progress",
    args: { type: "movies" },
    save: (o) => (o.in_progress as Media[]).map((m) => ({ kind: "film", title: m.title, year: m.year, status: "reading", at: m.day, url: m.link, source: "trakt" })),
  },
  {
    id: "read",
    tool: "list_books",
    args: { shelf: "read" },
    save: (o) => (o.books as Book[]).map((b) => ({ kind: "book", title: b.title, maker: b.author, status: "done", rating: b.rating, at: b.noticed_on, url: b.link, source: "goodreads" })),
  },
  {
    id: "reading",
    tool: "list_books",
    args: { shelf: "currently-reading" },
    save: (o) => (o.books as Book[]).map((b) => ({ kind: "book", title: b.title, maker: b.author, status: "reading", at: b.noticed_on, url: b.link, source: "goodreads" })),
  },
];

/** Claude, standing in: every read at once, then one athena_watch_read per title, then done. Records what it was told. */
function standIn(seen: { system: string[]; tools: string[]; saves: number }) {
  let n = 0;
  return (u: URL, init: RequestInit): F.Reply | undefined => {
    if (u.host !== "claude.test") return undefined;
    const body = JSON.parse(String(init.body)) as { system: string | Array<{ text: string }>; tools: Array<{ name: string }>; messages: Msg[] };
    seen.system.push(typeof body.system === "string" ? body.system : body.system.map((s) => s.text).join("\n"));
    seen.tools = body.tools.map((t) => t.name);
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    if (!results.length) {
      const calls = READS.flatMap((r) => {
        const name = body.tools.find((t) => t.name.endsWith(r.tool))?.name;
        return name ? [{ type: "tool_use", id: `t_${r.id}`, name, input: r.args }] : [];
      });
      return reply(calls, "tool_use");
    }
    const saves: Block[] = [];
    for (const r of results) {
      const read = READS.find((x) => `t_${x.id}` === r.tool_use_id);
      if (!read) continue;
      const text = typeof r.content === "string" ? r.content : (r.content as Block[]).map((b) => b.text ?? "").join("");
      const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
      for (const input of read.save(out)) saves.push({ type: "tool_use", id: `t_save_${saves.length}`, name: "athena_watch_read", input: JSON.parse(JSON.stringify(input)) });
    }
    seen.saves += saves.length;
    return saves.length ? reply(saves, "tool_use") : reply([{ type: "text", text: "Saved to Watch & read." }], "end_turn");
  };
}

const trakt = (path: string | RegExp, body: unknown): F.Route => (u) =>
  u.host === "api.trakt.tv" && (typeof path === "string" ? u.pathname === path : path.test(u.pathname)) ? { body } : undefined;
const goodreads: F.Route = (u) => {
  if (u.host !== "www.goodreads.com") return undefined;
  if (u.pathname === "/review/grid_widget/12345") return { body: u.searchParams.get("shelf") === "currently-reading" ? F.GOODREADS_GRID_READING : u.searchParams.get("shelf") === "read" ? F.GOODREADS_GRID_READ : "  var widget_code = '<div class=\\\"gr_grid_container\\\"><\\/div>'" };
  if (u.pathname === "/review/custom_widget/12345") return { body: F.GOODREADS_DETAIL };
  return undefined;
};

test("Life log run: Letterboxd, Trakt and Goodreads titles land in Watch & read, one item each, with stars", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    const seen = { system: [] as string[], tools: [] as string[], saves: 0 };
    F.stub(
      (u) => (u.host === "letterboxd.com" ? { body: F.LETTERBOXD_RSS } : undefined),
      trakt("/users/settings", F.TRAKT_SETTINGS),
      trakt(/^\/users\/yourname\/history\//, [...F.TRAKT_HISTORY_PAGE_1, ...F.TRAKT_HISTORY_PAGE_2]),
      trakt("/users/yourname/ratings/", F.TRAKT_RATINGS),
      trakt("/users/yourname/watchlist/movie,show/added", F.TRAKT_WATCHLIST),
      trakt(/^\/sync\/playback/, F.TRAKT_PLAYBACK),
      goodreads,
      standIn(seen),
    );

    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun, WATCH_READ_RULE } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    const { listValues } = await import("../../../lib/custom-fields");
    for (const t of ["custom_values", "reading_items", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM custom_fields WHERE kind = 'reading'`);
    await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
    await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    };
    const connect = async (body: Record<string, unknown>, before?: (id: string) => Promise<void>) => {
      const made = await api("POST", "/connectors", { account_label: "personal", ...body });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      if (before) await before(made.json.id);
      // Connecting checks the account and lists what Athena may read, as Settings does.
      const checked = await api("POST", `/connectors/${made.json.id}/check`);
      assert.equal(checked.status, 200, JSON.stringify(checked.json));
      return made.json.id as string;
    };

    const lb = await connect({ provider: "letterboxd", name: "Letterboxd", url: "https://letterboxd.com/yourname/" });
    // Trakt: the owner's own app, signed in (the sign-in itself is trakt-direct.test.ts's).
    const tr = await connect({ provider: "trakt", name: "Trakt", client_id: "trakt-app", client_secret: "trakt-secret" }, (id) =>
      C.updateConnectorSecrets(id, (s) => void (s.tokens = { access_token: "at", refresh_token: "rt", expires_in: 86400, obtained_at: Date.now() } as never)),
    );
    const gr = await connect({ provider: "goodreads", name: "Goodreads", url: "https://www.goodreads.com/user/show/12345-yourname" });
    // Since connecting, two books are new on Goodreads: one read (rated 4 on the shelf), one being read.
    await C.updateConnectorSecrets(gr, (s) => void ((s as { goodreadsSeen?: unknown }).goodreadsSeen = { read: { "9034889193": "", "9034813988": "" }, "currently-reading": {}, "to-read": {} }));

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [lb, tr, gr], schedule: "daily", run_at: "23:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));

    const runOnce = async () => {
      const run = await C.queueRun(life.json.id, "manual");
      await executeRun(run.id, new Date("2026-11-06T23:30:00Z"));
      return (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    };
    const done = await runOnce();
    assert.equal(done.status, "succeeded", `${done.error ?? ""} ${JSON.stringify(done.stats)}`);

    // The run was told, and offered the tool.
    assert.ok(seen.system[0]?.includes(WATCH_READ_RULE), "the Life log run carries the Watch & read rule");
    assert.ok(seen.tools.includes("athena_watch_read"));

    const snapshot = async () => {
      const items = await q<{ id: string; title: string; kind: string; status: string; author: string; url: string }>(`SELECT id, title, kind, status, author, url FROM reading_items ORDER BY kind, title`);
      const values = await listValues("reading");
      return items.map((i) => ({ title: i.title, kind: i.kind, status: i.status, author: i.author, url: i.url, stars: values.find((v) => v.entity_id === i.id)?.value ?? null }));
    };
    const items = await snapshot();
    const row = (title: string) => {
      const r = items.find((i) => i.title === title);
      assert.ok(r, `${title} in ${JSON.stringify(items.map((i) => i.title))}`);
      return [r.kind, r.status, r.stars];
    };

    // Letterboxd: half stars stay half; unrated stays empty.
    assert.deepEqual(row("Past Lives"), ["film", "done", 4]);
    assert.deepEqual(row("Heat"), ["film", "done", null]);
    // Letterboxd and Trakt both logged Paddington in Peru: one item, Letterboxd's 4½ kept.
    assert.equal(items.filter((i) => i.title === "Paddington in Peru").length, 1);
    assert.deepEqual(row("Paddington in Peru"), ["film", "done", 4.5]);
    // Trakt: 6/10 is three stars; episodes make one show, watching; the watchlist is up next; a paused film is in progress.
    assert.deepEqual(row("Old Film"), ["film", "done", 3]);
    assert.equal(items.filter((i) => i.title === "Severance").length, 1);
    assert.deepEqual(row("Severance"), ["tv", "reading", null]);
    assert.equal(items.find((i) => i.title === "Severance")!.url, "https://trakt.tv/shows/severance");
    assert.deepEqual(row("Slow Horses"), ["tv", "queued", null]);
    assert.deepEqual(row("Dune"), ["film", "reading", null]);
    // Goodreads shelf: the new read book with its 4 stars and author; the one being read.
    assert.deepEqual(row("Tell Me Everything (Amgash, #5)"), ["book", "done", 4]);
    assert.equal(items.find((i) => i.title === "Tell Me Everything (Amgash, #5)")!.author, "Elizabeth Strout");
    assert.deepEqual(row("The Wager"), ["book", "reading", null]);
    // Books already on the read shelf come in too, as read; Orbital has no rating there, so no stars.
    assert.deepEqual(row("Orbital"), ["book", "done", null]);
    assert.deepEqual(row("Piranesi"), ["book", "done", null]);
    assert.equal(items.length, 11, JSON.stringify(items.map((i) => i.title)));

    // The same run again: every title is found, nothing new, nothing changed.
    const savesBefore = seen.saves;
    const again = await runOnce();
    assert.equal(again.status, "succeeded", `${again.error ?? ""}`);
    assert.ok(seen.saves > savesBefore, "the second run saved the same titles again");
    assert.equal((again.stats as { watch_read_created?: number }).watch_read_created ?? 0, 0);
    assert.deepEqual(await snapshot(), items);
  } finally {
    F.restoreFetch();
  }
});
