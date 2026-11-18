// Real path for Your work, counted (work-sync.ts): Linear and GitHub accounts, a work-sync collection made
// through the real /api route, run by the real runner on the scheduler's claim, the tools stubbed at the MCP
// client (callTool and its rules still run). Two runs with no duplicates, a late close counted, a teammate's
// issue never stored, Claude never called, a 429 waits, an unknown shape fails plainly, and switched off
// means no reads. Postgres with every migration.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/work-sync.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties work_items and the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as W from "./fixtures/work-tools";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

type Call = { account: string; tool: string; args: Record<string, unknown> };

test("Your work, counted: two runs, the owner's own work only, no Claude, and off means off", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const C = await import("../../../lib/connectors");
  const { q, qRaw } = await import("../../../lib/db");
  const { handleConnectorRoutes } = await import("./routes");
  const { executeRun } = await import("./runner");
  const { syncWork, useWorkOpener, getWorkSync } = await import("./work-sync");
  const { readWorkItems } = await import("../../../lib/work");
  type Open = import("./mcp-client").OpenConnector;

  for (const t of ["work_items", "collected_items", "collection_runs", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key LIKE 'work\\_sync.%'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  // Anything that leaves Athena over HTTP is recorded: Claude must never be one of them.
  const http: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    http.push(new URL(String(input instanceof Request ? input.url : input)).host);
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  // ---- the world the tools answer from ----
  const world = {
    issues: [
      W.linearIssue({ n: 1, title: "Card form validates postcodes", created: "2026-11-02T09:00:00.000Z", started: "2026-11-03T09:00:00.000Z", completed: "2026-11-05T16:00:00.000Z", estimate: 3 }),
      W.linearIssue({ n: 2, title: "Priya's refactor", assigneeId: W.TEAMMATE_ID, created: "2026-11-02T09:00:00.000Z", completed: "2026-11-06T10:00:00.000Z" }),
      W.linearIssue({ n: 3, title: "Retry webhooks", project: "Billing", created: "2026-11-06T09:00:00.000Z", started: "2026-11-11T10:00:00.000Z", updated: "2026-11-11T10:00:00.000Z" }),
      W.linearIssue({ n: 4, title: "Archive old carts", created: "2026-10-01T09:00:00.000Z", started: "2026-10-02T09:00:00.000Z", completed: "2026-10-09T09:00:00.000Z" }),
    ],
    prs: [
      W.searchItem({ repo: "acme/app", number: 211, title: "Home's headline follows the day", author: W.ME, created: "2026-11-11T14:52:55Z", updated: "2026-11-11T15:55:06Z", merged: "2026-11-11T15:55:05Z", closed: "2026-11-11T15:55:06Z" }),
      W.searchItem({ repo: "acme/api", number: 40, title: "Someone else's change", author: "priya-teammate", created: "2026-11-10T09:00:00Z", updated: "2026-11-11T09:00:00Z" }),
      // Merged PRs involving the owner: one the owner merged for Priya, one Lee merged.
      W.searchItem({ repo: "acme/api", number: 41, title: "Priya's fix, merged by the owner", author: "priya-teammate", created: "2026-11-10T09:00:00Z", updated: "2026-11-11T12:00:00Z", merged: "2026-11-11T12:00:00Z", closed: "2026-11-11T12:00:00Z" }),
      W.searchItem({ repo: "acme/api", number: 42, title: "Priya's other fix, merged by Lee", author: "priya-teammate", created: "2026-11-10T09:00:00Z", updated: "2026-11-11T13:00:00Z", merged: "2026-11-11T13:00:00Z", closed: "2026-11-11T13:00:00Z" }),
    ],
    limited: false,
    garbled: false,
  };
  const calls: Call[] = [];
  /** An MCP client for one account: list_issues pages two at a time, search filters by the query's role. */
  const client = (account: "linear" | "github") => ({
    async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      calls.push({ account, tool: name, args });
      const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });
      if (world.limited) return text("API rate limit exceeded (429). Try again later.", true);
      if (account === "linear") {
        if (name === "get_user") return text(W.LINEAR_ME);
        if (name === "list_issues") {
          if (world.garbled) return text("Found 2 issues assigned to you: ENG-1, ENG-3");
          assert.equal(args.assignee, "me");
          const since = String(args.updatedAt);
          const kept = world.issues.filter((i) => i.updatedAt >= since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const start = Number(args.cursor ?? 0);
          const page = kept.slice(start, start + 2);
          return text(W.linearReply(page, start + 2 < kept.length ? String(start + 2) : undefined));
        }
      } else {
        if (name === "get_me") return text(W.GITHUB_ME);
        if (name === "search_pull_requests") {
          const qy = String(args.query);
          const day = /updated:>=(\S+)/.exec(qy)![1];
          const opened = qy.includes(`author:${W.ME}`) && !qy.includes(`-author:`);
          const merged = qy.includes("is:merged");
          const kept = world.prs.filter((p) => p.updated_at.slice(0, 10) >= day && (opened ? p.user.login === W.ME : p.user.login !== W.ME) && (merged ? !!p.pull_request.merged_at : ![41, 42].includes(p.number)));
          // GitHub's search would also return the owner's own PRs for reviewed-by if asked loosely: the parser must drop them.
          return text(W.searchReply(opened ? kept : [...kept, world.prs[0]]));
        }
        if (name === "pull_request_read" && args.method === "get") return text(W.prGet({ merged_by: args.pullNumber === 41 ? W.ME : "lee-teammate", merged_at: args.pullNumber === 41 ? "2026-11-11T12:00:00Z" : "2026-11-11T13:00:00Z" }));
        if (name === "pull_request_read") {
          assert.equal(args.method, "get_reviews");
          return text(args.pullNumber === 211 ? W.reviewsReply([{ login: "priya-teammate", state: "APPROVED", at: "2026-11-11T15:00:00Z" }]) : W.reviewsReply([{ login: W.ME, state: "APPROVED", at: "2026-11-11T09:30:00Z" }]));
        }
      }
      return text(`unknown tool ${name}`, true);
    },
    async listTools() {
      return { tools: [] };
    },
  });

  // ---- the accounts, with what Athena can read ----
  const linear = await C.createConnector({ name: "Linear", provider: "linear", url: "https://mcp.linear.app/mcp", auth_type: "token", secrets: { token: "lin_api_x" } });
  const github = await C.createConnector({ name: "GitHub", provider: "github", url: "https://api.githubcopilot.com/mcp/", auth_type: "token", secrets: { token: "github_pat_x" } });
  const tools = (names: string[]) => names.map((n) => ({ name: n, description: "", access: "read" as const }));
  await C.saveConnectorTools(linear.id, tools(["get_user", "list_issues", "list_projects"]));
  await C.saveConnectorTools(github.id, tools(["get_me", "search_pull_requests", "pull_request_read", "list_commits"]));
  for (const id of [linear.id, github.id]) await C.setConnectorStatus(id, "connected");
  assert.ok((await C.getConnector(linear.id))!.allowed_tools.includes("list_issues"), "the preset's reads start on");

  const opened: string[] = [];
  useWorkOpener(async (id) => {
    opened.push(id);
    const connector = (await C.getConnector(id))!;
    return { connector, client: client(connector.provider as "linear" | "github"), close: async () => undefined } as unknown as Open;
  });

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
  const made = await api("POST", "/collections", { recipe: "work-sync", name: "Your work, counted", label: "", connector_ids: [linear.id, github.id], schedule: "hourly", every_hours: 1 });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const colId = made.json.id as string;

  const scheduled = async (iso: string) => {
    await qRaw(`UPDATE collections SET next_run_at = $2 WHERE id = $1`, [colId, new Date(Date.parse(iso) - 60_000).toISOString()]);
    // As collect.ts claims them without AI Gateway: this recipe still runs.
    const claimed = await C.claimDueCollections(new Date(iso), { recipes: ["plays-watches", "work-sync"] });
    assert.deepEqual(claimed.map((r) => r.collection_id), [colId]);
    await executeRun(claimed[0].id, new Date(iso));
    return (await C.listRuns(colId)).find((r) => r.id === claimed[0].id)!;
  };
  const stored = async () => (await readWorkItems()).items;
  const rowCount = async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM work_items`))[0].n;

  try {
    // ---- first run: a year back, both accounts ----
    const r1 = await scheduled("2026-11-12T10:00:00Z");
    assert.equal(r1.status, "succeeded", r1.error);
    assert.equal(r1.summary, "3 issues, 3 pull requests", "one opened, one reviewed, one merged for a teammate");
    assert.deepEqual({ i: r1.stats.issues_new, p: r1.stats.prs_new, tokens: r1.stats.input_tokens }, { i: 3, p: 3, tokens: undefined });
    const first = calls.find((c) => c.tool === "list_issues")!;
    assert.equal(first.args.updatedAt, "2025-11-12T10:00:00.000Z", "a year back the first time");
    assert.equal(calls.filter((c) => c.tool === "list_issues").length, 2, "two pages, by cursor");
    const items = await stored();
    assert.deepEqual(items.filter((i) => i.source === "linear").map((i) => (i as { identifier: string }).identifier).sort(), ["ENG-1", "ENG-3", "ENG-4"]);
    const pr = items.find((i) => i.source === "github")!;
    assert.deepEqual({ id: pr.id, role: (pr as { role: string }).role, reviews: (pr as { reviews?: number }).reviews }, { id: "acme/app#211", role: "opened", reviews: 1 });
    const reviewed = items.find((i) => i.id === "acme/api#40") as { role: string; reviewed_at?: string } | undefined;
    assert.deepEqual(reviewed && { role: reviewed.role, at: reviewed.reviewed_at }, { role: "reviewed", at: "2026-11-11T09:30:00.000Z" });
    const mergedFor = items.find((i) => i.id === "acme/api#41:merged") as { role: string; merged?: string } | undefined;
    assert.deepEqual(mergedFor && { role: mergedFor.role, merged: mergedFor.merged }, { role: "merged", merged: "2026-11-11T12:00:00.000Z" });
    assert.ok(!items.some((i) => i.id.startsWith("acme/api#42")), "a merge by someone else isn't kept");
    assert.equal(await rowCount(), 6);

    // Nothing of anyone else, decrypted or not; the table holds ciphertext only.
    const all = JSON.stringify(items);
    for (const word of ["Priya's refactor", "merged by Lee", "priya-teammate", "lee-teammate", W.TEAMMATE_ID, "teammate's own words", "never keeps", "A long description"]) assert.ok(!all.includes(word), `stored: ${word}`);
    const raw = await qRaw<{ sealed: string; item_key: string }>(`SELECT sealed, item_key FROM work_items`);
    assert.ok(raw.every((r) => r.sealed.startsWith("enc:v1:") && !r.item_key.includes("ENG") && !r.item_key.includes("acme")));

    // ---- second run, an hour on: nothing new is nothing new; a late close is counted ----
    world.issues[2] = { ...world.issues[2], completedAt: "2026-11-11T18:00:00.000Z", status: "Done", updatedAt: "2026-11-11T18:00:00.000Z" };
    const before = calls.length;
    const r2 = await scheduled("2026-11-12T11:00:00Z");
    assert.equal(r2.status, "succeeded", r2.error);
    assert.equal(r2.summary, "Nothing new", "ENG-3 closing changes an issue, it doesn't add one");
    assert.equal(r2.stats.work_updated, 1);
    assert.equal(await rowCount(), 6, "no duplicates");
    const again = calls.slice(before).find((c) => c.tool === "list_issues")!;
    assert.equal(again.args.updatedAt, "2026-11-11T00:00:00.000Z", "from the start of yesterday: the late re-read");
    assert.ok(!calls.slice(before).some((c) => c.tool === "pull_request_read"), "reviews and merges aren't checked again for PRs that haven't changed");
    const ws = await getWorkSync(github.id);
    assert.equal(Object.keys(ws!.streams!.merged!.not_mine!).length, 1, "Lee's merge remembered by hash");
    assert.ok(!JSON.stringify(ws).includes("acme"), "no repo or id in the state");
    const eng3 = (await stored()).find((i) => (i as { identifier?: string }).identifier === "ENG-3") as { completed?: string };
    assert.equal(eng3.completed, "2026-11-11T18:00:00.000Z");

    // ---- Claude never called, and only read tools reached ----
    assert.deepEqual(http.filter((h) => h === "claude.test" || h.endsWith("anthropic.com")), [], "no request to Claude");
    assert.deepEqual([...new Set(calls.map((c) => c.tool))].sort(), ["get_me", "get_user", "list_issues", "pull_request_read", "search_pull_requests"]);

    // ---- a 429: waits an hour, and the next run doesn't call ----
    world.limited = true;
    const r3 = await scheduled("2026-11-12T12:00:00Z");
    assert.equal(r3.status, "succeeded");
    assert.match(r3.summary, /^Nothing new\. Linear asked Athena to wait · trying again at 13:00\. GitHub asked Athena to wait/);
    world.limited = false;
    const quiet = calls.length;
    const waited = await syncWork(linear.id, { budgetMs: 60_000, clock: () => Date.parse("2026-11-12T12:30:00Z") });
    assert.equal(waited.state, "waiting");
    assert.equal(calls.length, quiet, "waiting means no calls");
    assert.ok((await getWorkSync(linear.id))!.resume_at);

    // ---- a reply in a shape Athena doesn't know: the account fails plainly, nothing stored ----
    world.garbled = true;
    const garbled = await syncWork(linear.id, { budgetMs: 60_000, clock: () => Date.parse("2026-11-12T14:00:00Z") });
    assert.equal(garbled.state, "failed");
    assert.match(garbled.message!, /^Linear answered list_issues in a way Athena doesn't recognise/);
    assert.equal(await rowCount(), 6);
    world.garbled = false;

    // ---- switched off: no reads at all ----
    const off = await api("PATCH", `/collections/${colId}`, { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.deepEqual(await C.claimDueCollections(new Date("2026-11-13T10:00:00Z")), [], "a switched-off collection isn't claimed");
    const openedBefore = opened.length;
    const callsBefore = calls.length;
    assert.equal((await syncWork(linear.id, { budgetMs: 60_000, clock: () => Date.parse("2026-11-13T10:00:00Z") })).state, "off");
    assert.equal((await syncWork(github.id, { budgetMs: 60_000, clock: () => Date.parse("2026-11-13T10:00:00Z") })).state, "off");
    assert.equal(opened.length, openedBefore, "no account opened");
    assert.equal(calls.length, callsBefore, "no tool called");

    // A read the owner turns off under What Athena can read: off too, even with the collection on.
    await api("PATCH", `/collections/${colId}`, { enabled: true });
    await C.saveConnectorTools(linear.id, tools(["get_user", "list_issues"]));
    await qRaw(`UPDATE connectors SET allowed_tools = ARRAY['get_user'] WHERE id = $1`, [linear.id]);
    assert.equal((await syncWork(linear.id, { budgetMs: 60_000, clock: () => Date.parse("2026-11-13T11:00:00Z") })).state, "off");
    assert.equal(calls.length, callsBefore);
  } finally {
    useWorkOpener(null);
    globalThis.fetch = realFetch;
  }
});
