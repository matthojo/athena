// A whole Life log run over Readwise, Bluesky and Mastodon: the real routes connect each account and check it,
// the real executeRun opens them through their adapters (recorded replies, fixtures/reading-social-recorded.ts),
// and a stand-in Claude reads each source for the day and saves the day note the way the notes' "For the Life
// log" wording asks: a line per book, never a highlight; a short Posted line per post with its link. Then a
// second run with nothing new ends at precheck without starting Claude. Postgres with every migration.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/reading-social-run.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/reading-social-recorded";

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
type Obj = Record<string, unknown>;
const DAY = "2026-11-06";

/** The reads: which account's tool (by its name prefix) with what. */
const READS = [
  // Readwise as its tool description says: what reached it since the window opened, then each day that names.
  { id: "rwnew", prefix: "readwise", tool: "list_highlights", args: { by: "added", after: DAY, text: false } },
  { id: "bs", prefix: "bluesky", tool: "my_posts", args: { date: DAY } },
  { id: "md", prefix: "mastodon", tool: "my_posts", args: { date: DAY } },
];

const short = (t: string) => (t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t);

/** Claude, standing in: every read at once, then the day note and its metrics, then done. */
function standIn(seen: { calls: number; system: string; tools: string[]; descriptions: Record<string, string>; results: Record<string, Obj> }): F.Route {
  let n = 0;
  return (u, init) => {
    if (u.host !== "claude.test") return undefined;
    seen.calls++;
    const body = JSON.parse(String(init.body)) as { system: string | Array<{ text: string }>; tools: Array<{ name: string; description?: string }>; messages: Msg[] };
    for (const t of body.tools) seen.descriptions[t.name] = t.description ?? "";
    seen.system = typeof body.system === "string" ? body.system : body.system.map((s) => s.text).join("\n");
    seen.tools = body.tools.map((t) => t.name);
    const reply = (content: Block[], stop: string) => ({ body: { id: `msg_${++n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const last = body.messages[body.messages.length - 1];
    const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    if (!results.length) {
      const calls = READS.map((r) => ({ type: "tool_use", id: `t_${r.id}`, name: body.tools.find((t) => t.name.startsWith(r.prefix) && t.name.endsWith(r.tool))!.name, input: r.args }));
      return reply(calls, "tool_use");
    }
    if (results.some((r) => String(r.tool_use_id).startsWith("t_note"))) return reply([{ type: "text", text: "Wrote the days." }], "end_turn");
    for (const r of results) {
      const text = typeof r.content === "string" ? r.content : (r.content as Block[]).map((b) => b.text ?? "").join("");
      seen.results[String(r.tool_use_id).slice(2)] = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    }
    const rwTool = body.tools.find((t) => t.name.startsWith("readwise") && t.name.endsWith("list_highlights"))!.name;
    const days = seen.results.rwnew.days as string[];
    // Round two: each day Readwise named, read whole.
    if (!days.every((d) => seen.results[`rw_${d}`])) return reply(days.map((d) => ({ type: "tool_use", id: `t_rw_${d}`, name: rwTool, input: { date: d, text: false } })), "tool_use");
    // Round three: each day's entries and line, and its counts.
    const out: Block[] = [];
    for (const d of [...new Set([...days, DAY])].sort()) {
      const books = ((seen.results[`rw_${d}`]?.items ?? []) as Array<{ id?: string | number; title: string; author?: string; source?: string; link?: string; highlights_count: number }>);
      const posts = (key: string, source: string) =>
        d === DAY
          ? (seen.results[key].items as Array<{ kind: string; text?: string; link: string }>).map((p) => ({ kind: "posted", source, external_id: p.link, title: p.kind === "reply" ? `Replied: ${short(p.text ?? "")}` : short(p.text ?? ""), url: p.link }))
          : [];
      const entries = [
        ...books.map((b) => ({ kind: "highlight", source: "readwise", external_id: `${b.link}#${d}`, title: b.title, subtitle: b.author, count: b.highlights_count, note: b.source, url: b.link })),
        ...posts("bs", "bluesky"),
        ...posts("md", "mastodon"),
      ];
      out.push({ type: "tool_use", id: `t_note_${d}`, name: "athena_day_entry", input: { date: d, entries } });
      out.push({ type: "tool_use", id: `t_line_${d}`, name: "athena_day_line", input: { date: d, line: d === DAY ? "Highlights from The Wager and a few posts" : "Highlights from The Wager" } });
      out.push({ type: "tool_use", id: `t_h_${d}`, name: "athena_metric", input: { name: "highlights_made_day", value: (seen.results[`rw_${d}`]?.count as number) ?? 0, day: d } });
      if (d === DAY) out.push({ type: "tool_use", id: "t_p", name: "athena_metric", input: { name: "posts_made_day", value: (seen.results.bs.count as number) + (seen.results.md.count as number), day: d } });
    }
    return reply(out, "tool_use");
  };
}

const READWISE = "readwise.io";
const BSKY = "public.api.bsky.app";
const MASTO = "mastodon.social";

test("Life log run: Readwise, Bluesky and Mastodon reach the Day as entries; a quiet second run ends at precheck", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { mastodonNet } = await import("./mastodon-direct");
  const lookup = mastodonNet.lookup;
  mastodonNet.lookup = async () => [{ address: "151.101.1.1", family: 4 }];
  const seen = { calls: 0, system: "", tools: [] as string[], descriptions: {} as Record<string, string>, results: {} as Record<string, Obj> };
  let quiet = false;
  try {
    F.stub(
      F.at(READWISE, "/api/v2/auth/", {}, 204),
      F.at(READWISE, "/api/v2/export/", () => (quiet ? { count: 0, nextPageCursor: null, results: [] } : { count: 2, nextPageCursor: null, results: [F.ESSAY, F.WAGER] })),
      F.at(BSKY, "/xrpc/app.bsky.actor.getProfile", F.BSKY_PROFILE),
      F.at(BSKY, "/xrpc/app.bsky.feed.getAuthorFeed", (u) => (u.searchParams.get("cursor") ? { feed: [] } : F.BSKY_PAGE_1)),
      F.at(MASTO, "/api/v1/accounts/verify_credentials", F.MASTO_ME),
      F.at(MASTO, "/api/v1/accounts/13179/statuses", (u) => (u.searchParams.get("max_id") ? [] : F.MASTO_PAGE_1)),
      standIn(seen),
    );

    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    for (const t of ["collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
    for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`DELETE FROM metrics WHERE metric LIKE 'posts_made_day%' OR metric LIKE 'highlights_made_day%'`);
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
    const connect = async (body: Obj) => {
      const made = await api("POST", "/connectors", { account_label: "personal", ...body });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const checked = await api("POST", `/connectors/${made.json.id}/check`);
      assert.equal(checked.status, 200, JSON.stringify(checked.json));
      assert.equal(checked.json.status, "connected");
      return checked.json as { id: string; url: string; allowed_tools: string[] };
    };

    // A wrong address is refused before anything is saved.
    const bad = await api("POST", "/connectors", { provider: "mastodon", name: "Mastodon", url: "https://127.0.0.1/@jordan", token: "t" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /can't be a Mastodon server/);

    const rw = await connect({ provider: "readwise", name: "Readwise", token: "rw_token_0123456789" });
    const bs = await connect({ provider: "bluesky", name: "Bluesky", url: "@jordan.bsky.social" });
    const md = await connect({ provider: "mastodon", name: "Mastodon", url: "jordan@mastodon.social", token: "masto_token_abc" });
    assert.equal(bs.url, "https://bsky.app/profile/jordan.bsky.social");
    assert.equal(md.url, "https://mastodon.social/@jordan");
    assert.deepEqual(rw.allowed_tools, ["list_highlights", "search_highlights"]);
    assert.deepEqual(bs.allowed_tools, ["my_posts"]);

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [rw.id, bs.id, md.id], schedule: "daily", run_at: "21:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));
    const runOnce = async (now: Date) => {
      const run = await C.queueRun(life.json.id, "schedule");
      await executeRun(run.id, now);
      return (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    };

    const first = await runOnce(new Date("2026-11-06T21:30:00Z"));
    assert.equal(first.status, "succeeded", `${first.error ?? ""} ${JSON.stringify(first.stats)}`);
    // Claude was offered the three accounts' tools, and the Life log's rules.
    for (const t of ["list_highlights", "search_highlights", "my_posts"]) assert.ok(seen.tools.some((n) => n.endsWith(t)), t);
    assert.ok(seen.tools.filter((n) => n.endsWith("my_posts")).length === 2);
    assert.match(seen.system, /Collection: life log/);
    // The real run carries the Life log wording in the tools Claude reads (recipes.ts is the sibling's).
    const described = (suffix: string) => Object.entries(seen.descriptions).filter(([n]) => n.endsWith(suffix)).map(([, d]) => d);
    assert.match(described("list_highlights")[0], /highlight entries, one per book or article.*Never quote a highlight or note in an entry\. highlights_made_day/);
    for (const d of described("my_posts")) assert.match(d, /For the Life log: one posted entry per post/);

    // The days: entries and a line each, no note.
    const { getDay } = await import("../../../lib/days");
    const day = (await getDay(DAY, { tz: "Europe/London" }))!;
    assert.equal(day.line, "Highlights from The Wager and a few posts");
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE source LIKE 'life-log%'`))[0].n, 0, "no day note");
    const show = (e: { kind: string; title: string; subtitle?: string; count?: number; note?: string; url?: string }) => [e.kind, e.title, e.subtitle ?? null, e.count ?? 1, e.note ?? null, e.url ?? null];
    assert.deepEqual(show(day.entries.find((e) => e.title === "The Wager")!), ["highlight", "The Wager", "David Grann", 2, "Kindle", "https://readwise.io/bookreview/41"]);
    // The Kindle highlight made on the 5th reached Readwise on the 6th: it goes on the 5th.
    const late = (await getDay("2026-11-05", { tz: "Europe/London" }))!;
    assert.deepEqual(late.entries.map(show), [["highlight", "The Wager", "David Grann", 1, "Kindle", "https://readwise.io/bookreview/41"]]);
    assert.deepEqual(show(day.entries.find((e) => e.title === "How to Do Great Work")!), ["highlight", "How to Do Great Work", "Paul Graham", 1, "Reader", "https://paulgraham.com/greatwork.html"]);
    const posted = day.entries.filter((e) => e.kind === "posted").map((e) => `${e.source}: ${e.title} ${e.url}`);
    assert.ok(posted.includes("bluesky: Replied: this is so cool https://bsky.app/profile/jordan.bsky.social/post/3mznvxo7so22q"), posted.join("\n"));
    assert.ok(posted.includes("bluesky: Exactly this. https://bsky.app/profile/jordan.bsky.social/post/3mznquote22a"));
    assert.ok(posted.includes("mastodon: Late one. https://mastodon.social/@jordan/117470000000000005"));
    assert.ok(posted.some((p) => p.startsWith("mastodon: Replied: @alex agreed")));
    // Never a highlight, never a repost, boost or private mention.
    const all = JSON.stringify(day);
    for (const never of ["leveller", "Scurvy", "café", "Curiosity", "Capuchinbird", "Someone else", "Psst"]) assert.ok(!all.includes(never), never);
    assert.ok(!JSON.stringify(seen.results).includes("leveller"), "the run never even read the highlights' words");

    const metrics = await q<{ metric: string; value: number; day: string }>(
      `SELECT metric, value::int AS value, metadata->>'day' AS day FROM metrics WHERE metric LIKE 'posts_made_day%' OR metric LIKE 'highlights_made_day%' ORDER BY 1, 3`,
    );
    assert.deepEqual(metrics, [
      { metric: "highlights_made_day_personal", value: 1, day: "2026-11-05" },
      { metric: "highlights_made_day_personal", value: 3, day: DAY },
      { metric: "posts_made_day_personal", value: 4, day: DAY },
    ]);
    // Every request to the three services was a GET.
    assert.ok(F.calls.filter((c) => c.url.host !== "claude.test").every((c) => (c.init.method ?? "GET") === "GET"));

    // The next evening, nothing new anywhere: precheck sees that and Claude isn't started.
    quiet = true;
    const callsBefore = seen.calls;
    const second = await runOnce(new Date("2026-11-07T23:59:00Z"));
    assert.equal(second.status, "succeeded", `${second.error ?? ""}`);
    assert.equal(seen.calls, callsBefore, "no model call on a quiet day");
    assert.equal((second.stats as { claude_skipped?: number }).claude_skipped, 1, JSON.stringify(second.stats));
  } finally {
    F.unstub();
    mastodonNet.lookup = lookup;
  }
});
