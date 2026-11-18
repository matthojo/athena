// The work sync's parsers, its read plan and the Work page's numbers (work-parse.ts, work-sync.ts, lib/work-stats.ts),
// against the tools' own reply shapes (fixtures/work-tools.ts). The real path on Postgres is work-sync.db.test.ts.
// Run: npx tsx --test netlify/lib/connectors/work-sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as W from "./fixtures/work-tools";
import { describeShape, githubMe, githubMergedBy, githubPrs, githubReviews, linearIssues, linearMe, ShapeUnknown } from "./work-parse";
import { allowsWork, FIRST_DAYS, OVERLAP_MS, readPlan, workSyncLine, workSyncOn } from "./work-sync";
import { cycleTimes, heatYear, mergeTimes, noteKind, noteOpen, orderNotes, previousSpan, projectDetail, projectsIn, shippedByDay, workPage, workPeriods, type WorkNote } from "../../../lib/work-stats";
import { ownItem, workKey, type WorkItem } from "../../../lib/work";
import type { Collection } from "../../../lib/connectors";

const TZ = "Europe/London";
const me = { id: W.LINEAR_ME_ID };

// ---------- Linear ----------

test("Linear: get_user gives the owner's id; anything else is an unknown shape", () => {
  assert.deepEqual(linearMe(W.LINEAR_ME), { id: W.LINEAR_ME_ID });
  assert.deepEqual(linearMe(JSON.stringify({ user: { id: "u1" } })), { id: "u1" });
  assert.throws(() => linearMe("User: Sam"), ShapeUnknown);
  assert.throws(() => linearMe(JSON.stringify({ name: "Sam" })), ShapeUnknown);
});

test("Linear: list_issues keeps the owner's own issues, never a teammate's or an unassigned one", () => {
  const reply = W.linearReply(
    [
      W.linearIssue({ n: 1, title: "Card form validates postcodes", created: "2026-11-02T09:00:00.000Z", started: "2026-11-03T09:00:00.000Z", completed: "2026-11-05T16:00:00.000Z", estimate: 3 }),
      W.linearIssue({ n: 2, title: "Priya's refactor", assigneeId: W.TEAMMATE_ID, created: "2026-11-02T09:00:00.000Z", completed: "2026-11-06T10:00:00.000Z" }),
      W.linearIssue({ n: 3, title: "Nobody's yet", assigneeId: null, created: "2026-11-04T09:00:00.000Z" }),
      W.linearIssue({ n: 4, title: "Retry webhooks", project: "Billing", created: "2026-11-06T09:00:00.000Z", started: "2026-11-06T10:00:00.000Z", updated: "2026-11-07T08:00:00.000Z" }),
    ],
    "cursor-2",
  );
  const r = linearIssues(reply, me);
  assert.equal(r.read, 4);
  assert.equal(r.next, "cursor-2");
  assert.equal(r.newest, "2026-11-07T08:00:00.000Z");
  assert.deepEqual(r.issues.map((i) => i.identifier), ["ENG-1", "ENG-4"]);
  const [one] = r.issues;
  assert.deepEqual(one, {
    source: "linear",
    id: "0c1d2e3f-0000-4000-8000-000000000001",
    identifier: "ENG-1",
    title: "Card form validates postcodes",
    url: "https://linear.app/acme/issue/ENG-1/slug",
    project: "Checkout",
    project_id: "p-checkout",
    team: "Engineering",
    state: "Done",
    created: "2026-11-02T09:00:00.000Z",
    started: "2026-11-03T09:00:00.000Z",
    completed: "2026-11-05T16:00:00.000Z",
    updated: "2026-11-05T16:00:00.000Z",
    estimate: 3,
  });
  // Nothing of anyone else rides along: no description, creator or assignee name.
  const text = JSON.stringify(r.issues);
  for (const word of ["Priya", "teammate's own words", W.TEAMMATE_ID, "createdBy"]) assert.ok(!text.includes(word), word);
});

test("Linear: the GraphQL-style nesting reads the same; the last page has no cursor", () => {
  const issue = { id: "i1", title: "Nested", assignee: { id: W.LINEAR_ME_ID, name: "Sam" }, project: { id: "p1", name: "Search" }, team: { name: "Eng" }, state: { name: "Done", type: "completed" }, completedAt: "2026-11-01T10:00:00Z", estimate: 2 };
  const r = linearIssues(JSON.stringify({ issues: { nodes: [issue] }, pageInfo: { hasNextPage: false } }), me);
  assert.equal(r.next, undefined);
  assert.equal(r.issues[0].project, "Search");
  assert.equal(r.issues[0].project_id, "p1");
  assert.equal(r.issues[0].state_type, "completed");
  assert.equal(r.issues[0].estimate, 2);
  assert.equal(linearIssues(W.linearReply([]), me).next, undefined);
});

test("Linear: a reply in an unknown shape fails rather than guessing", () => {
  assert.throws(() => linearIssues("Found 3 issues: ENG-1, ENG-2…", me), ShapeUnknown);
  assert.throws(() => linearIssues(JSON.stringify({ results: [] }), me), ShapeUnknown);
  assert.throws(() => linearIssues(JSON.stringify({ issues: [{ identifier: "ENG-1" }] }), me), ShapeUnknown);
  assert.throws(() => linearIssues(JSON.stringify({ issues: ["ENG-1"] }), me), ShapeUnknown);
});

// ---------- GitHub ----------

const gh = { login: W.ME };
const pr = (o: Partial<Parameters<typeof W.searchItem>[0]> & { number: number }) =>
  W.searchItem({ repo: "acme/app", title: `PR ${o.number}`, author: W.ME, created: "2026-11-02T09:00:00Z", updated: "2026-11-03T09:00:00Z", ...o });

test("GitHub: get_me gives the login", () => {
  assert.deepEqual(githubMe(W.GITHUB_ME), { login: W.ME });
  assert.throws(() => githubMe(JSON.stringify({ id: 1 })), ShapeUnknown);
});

test("GitHub: search as opened keeps the owner's PRs; as reviewed only other people's, without their author", () => {
  const reply = W.searchReply([
    pr({ number: 211, title: "Home's headline follows the day", merged: "2026-11-12T14:55:05Z", closed: "2026-11-12T14:55:06Z", created: "2026-11-12T14:52:55Z", updated: "2026-11-12T14:55:06Z" }),
    pr({ number: 208, title: "A teammate's change", author: "priya-teammate" }),
    pr({ number: 205, title: "Draft idea", draft: true }),
  ]);
  const opened = githubPrs(reply, gh, "opened");
  assert.equal(opened.read, 3);
  assert.equal(opened.total, 3);
  assert.deepEqual(opened.prs.map((p) => p.number), [211, 205]);
  assert.deepEqual(opened.prs[0], {
    source: "github",
    id: "acme/app#211",
    repo: "acme/app",
    number: 211,
    title: "Home's headline follows the day",
    url: "https://github.com/acme/app/pull/211",
    role: "opened",
    opened: "2026-11-12T14:52:55.000Z",
    merged: "2026-11-12T14:55:05.000Z",
    closed: "2026-11-12T14:55:06.000Z",
    updated: "2026-11-12T14:55:06.000Z",
  });
  assert.equal(opened.prs[1].draft, true);
  const reviewed = githubPrs(reply, gh, "reviewed");
  assert.deepEqual(reviewed.prs.map((p) => p.number), [208]);
  assert.ok(!JSON.stringify(reviewed.prs).includes("priya-teammate"), "the author isn't kept");
  assert.ok(!JSON.stringify(opened.prs).includes("never keeps"), "no body");
});

test("GitHub: the minimal list shape (merged_at at the top, a bare list) reads too", () => {
  const r = githubPrs(W.GITHUB_LIST_MINIMAL.replaceAll('"jordanreeve"', `"${W.ME}"`), gh, "opened");
  assert.deepEqual(r.prs.map((p) => [p.id, p.merged]), [["acme/app#211", "2026-11-12T14:55:05.000Z"]]);
});

test("GitHub: a search with no results reads as none, however the empty list comes back", () => {
  for (const reply of [{ total_count: 0, incomplete_results: false, items: null }, { total_count: 0, incomplete_results: false }, { total_count: 0, items: [] }, []]) {
    assert.deepEqual(githubPrs(JSON.stringify(reply), gh, "opened"), { prs: [], read: 0, ...(Array.isArray(reply) ? {} : { total: 0 }) }, JSON.stringify(reply));
  }
  // Results counted but no list is still a reply Athena doesn't know.
  assert.throws(() => githubPrs(JSON.stringify({ total_count: 4, items: null }), gh, "opened"), /items is null/);
});

test("GitHub: the author and the link read from the other names GitHub's servers use", () => {
  const base = { number: 7, title: "Tidy the sync", created_at: "2026-11-10T09:00:00Z", updated_at: "2026-11-10T10:00:00Z" };
  const variants = [
    { ...base, html_url: "https://github.com/acme/app/pull/7", author: { login: W.ME } },
    { ...base, html_url: "https://github.com/acme/app/pull/7", author: W.ME },
    { ...base, html_url: "https://github.com/acme/app/pull/7", user: W.ME },
    { ...base, url: "https://github.com/acme/app/pull/7", user: { login: W.ME } },
    { ...base, repository: "acme/app", user: { login: W.ME } },
    { ...base, repository: { full_name: "acme/app" }, author: { login: W.ME } },
    { ...base, repository_url: "https://api.github.com/repos/acme/app", user: { login: W.ME } },
  ];
  for (const item of variants) {
    const r = githubPrs(JSON.stringify({ total_count: 1, items: [item] }), gh, "opened");
    assert.deepEqual(r.prs.map((p) => [p.id, p.url]), [["acme/app#7", "https://github.com/acme/app/pull/7"]], JSON.stringify(item));
  }
});

test("GitHub: an unrecognised reply says which fields it had, never what was in them", () => {
  const item = { number: 7, title: "Private roadmap item", html_url: "https://github.com/acme/secret-repo/pull/7", assignee: { login: "priya-teammate" } };
  let message = "";
  try {
    githubPrs(JSON.stringify({ total_count: 1, items: [item] }), gh, "opened");
  } catch (error) {
    assert.ok(error instanceof ShapeUnknown);
    message = error.message;
  }
  assert.match(message, /without an author, with fields: assignee, html_url, number, title/);
  for (const value of ["Private roadmap", "secret-repo", "priya-teammate"]) assert.ok(!message.includes(value), `no ${value}`);
  assert.throws(() => githubPrs("3 pull requests found", gh, "opened"), /text that isn't JSON \(21 characters\)/);
});

test("describeShape: field names and kinds only", () => {
  assert.equal(describeShape(null), "null");
  assert.equal(describeShape([]), "an empty list");
  assert.equal(describeShape("hello"), "a string");
  assert.equal(describeShape([{ b: 1, a: "x" }, {}]), "a list of 2, the first with fields: a, b");
  assert.equal(describeShape({ total_count: 0, items: null, incomplete_results: false }), "an object with fields: incomplete_results, items, total_count; items is null");
  assert.equal(describeShape({ results: [{ id: 1 }] }), "an object with fields: results; results is a list of 1, the first with fields: id");
  // Keys that look like data (a repo, an email) are counted, not named.
  assert.equal(describeShape({ "acme/app": [], "sam@example.com": 1, page: 1 }), "an object with fields: page and 2 more");
});

test("GitHub: an unknown search shape fails", () => {
  assert.throws(() => githubPrs("3 pull requests found", gh, "opened"), ShapeUnknown);
  assert.throws(() => githubPrs(JSON.stringify({ items: [{ title: "No link or author" }] }), gh, "opened"), ShapeUnknown);
});

test("GitHub: reviews are a count of other people's, and when the owner first reviewed", () => {
  assert.deepEqual(githubReviews("[]", gh), { others: 0 });
  const r = githubReviews(
    W.reviewsReply([
      { login: "priya-teammate", state: "APPROVED", at: "2026-11-04T10:00:00Z" },
      { login: W.ME, state: "COMMENTED", at: "2026-11-04T12:00:00Z" },
      { login: W.ME, state: "APPROVED", at: "2026-11-03T12:00:00Z" },
      { login: "lee", state: "PENDING" },
    ]),
    gh,
  );
  assert.deepEqual(r, { others: 1, mine_first: "2026-11-03T12:00:00.000Z" });
  assert.throws(() => githubReviews(JSON.stringify({ message: "?" }), gh), ShapeUnknown);
});

test("GitHub: who merged it, from pull_request_read get (recorded shape: merged_by a login; REST: an object)", () => {
  assert.deepEqual(githubMergedBy(W.prGet({ merged_by: W.ME, merged_at: "2026-11-12T14:55:05Z" }), gh), { mine: true, at: "2026-11-12T14:55:05.000Z" });
  assert.deepEqual(githubMergedBy(W.prGet({ merged_by: { login: W.ME }, merged_at: "2026-11-12T14:55:05Z" }), gh), { mine: true, at: "2026-11-12T14:55:05.000Z" });
  assert.deepEqual(githubMergedBy(W.prGet({ merged_by: "priya-teammate", merged_at: "2026-11-12T14:55:05Z" }), gh), { mine: false });
  assert.deepEqual(githubMergedBy(W.prGet({ merged: false, merged_by: null, merged_at: null }), gh), { mine: false });
  assert.throws(() => githubMergedBy(JSON.stringify({ title: "no merge fields" }), gh), ShapeUnknown);
  // As merged, the owner's own PRs are dropped (they're "opened"), and the id is apart from a review of the same PR.
  const r = githubPrs(W.searchReply([pr({ number: 9, author: "priya-teammate", merged: "2026-11-05T09:00:00Z" }), pr({ number: 10 })]), gh, "merged");
  assert.deepEqual(r.prs.map((p) => [p.id, p.role]), [["acme/app#9:merged", "merged"]]);
  assert.ok(!JSON.stringify(r.prs).includes("priya"));
});

// ---------- Storage's last check ----------

test("Storage refuses what isn't the owner's, and keys hide the id", () => {
  assert.equal(ownItem({ source: "github", id: "a/b#1", repo: "a/b", number: 1, title: "t", role: "opened", author: "priya" } as unknown as WorkItem), null);
  assert.equal(ownItem({ source: "github", id: "a/b#1", repo: "a/b", number: 1, title: "t", role: "commented" } as unknown as WorkItem), null);
  assert.ok(ownItem({ source: "linear", id: "i", title: "t" }));
  const k = workKey("linear", "ENG-1");
  assert.match(k, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!k.includes("ENG"));
  assert.notEqual(workKey("github", "ENG-1"), k);
});

// ---------- The read plan: cursor, carry-on and the late re-read ----------

test("Read plan: a year back the first time; then yesterday's start or two hours before the newest change; a part-way read first", () => {
  const now = Date.parse("2026-11-12T15:00:00Z");
  const yesterday = Date.parse("2026-11-11T00:00:00Z");
  const [first] = readPlan({}, now, yesterday);
  assert.equal(Date.parse(first.since), now - FIRST_DAYS * 86_400_000);
  // Newest change this morning: still re-read from yesterday's start, so an issue closed late is counted.
  assert.deepEqual(readPlan({ last: "2026-11-12T09:00:00.000Z" }, now, yesterday), [{ since: "2026-11-11T00:00:00.000Z", carry: false }]);
  // Last seen a week ago: from two hours before it.
  assert.equal(readPlan({ last: "2026-11-05T09:00:00.000Z" }, now, yesterday)[0].since, new Date(Date.parse("2026-11-05T09:00:00Z") - OVERLAP_MS).toISOString());
  const carried = readPlan({ last: "2026-11-12T09:00:00.000Z", pending: { since: "2025-11-12T15:00:00.000Z", at: "cursor-9" } }, now, yesterday);
  assert.deepEqual(carried[0], { since: "2025-11-12T15:00:00.000Z", at: "cursor-9", carry: true });
  assert.equal(carried[1].carry, false);
});

test("It reads only what the owner allows, and only while a collection has it on", () => {
  assert.equal(allowsWork({ provider: "linear", allowed_tools: ["list_issues", "get_user"] }), true);
  assert.equal(allowsWork({ provider: "linear", allowed_tools: ["list_issues"] }), false);
  assert.equal(allowsWork({ provider: "github", allowed_tools: ["get_me", "search_pull_requests"] }), true);
  assert.equal(allowsWork({ provider: "slack", allowed_tools: ["list_issues", "get_user"] }), false);
  const col = (enabled: boolean) => ({ recipe: "work-sync", enabled, connector_ids: ["a"] }) as Collection;
  assert.equal(workSyncOn("a", [col(true)]), true);
  assert.equal(workSyncOn("a", [col(false)]), false);
  assert.equal(workSyncOn("a", [{ ...col(true), recipe: "work-activity" }]), false);
  assert.equal(workSyncLine({ issues: 3, prs: 1 }), "3 issues, 1 pull request");
  assert.equal(workSyncLine({ issues: 0, prs: 0 }), "Nothing new");
});

// ---------- The numbers ----------

const issue = (n: number, o: { started?: string; completed?: string; project?: string; estimate?: number; canceled?: string }): WorkItem => ({ source: "linear", id: `i${n}`, identifier: `ENG-${n}`, title: `Issue ${n}`, created: "2026-01-01T09:00:00Z", ...o });
const merged = (n: number, opened: string, mergedAt?: string, extra: Partial<WorkItem> = {}): WorkItem => ({ source: "github", id: `acme/app#${n}`, repo: "acme/app", number: n, title: `PR ${n}`, role: "opened", opened, ...(mergedAt ? { merged: mergedAt } : {}), ...extra }) as WorkItem;

const ITEMS: WorkItem[] = [
  issue(1, { started: "2026-11-02T09:00:00Z", completed: "2026-11-02T15:00:00Z", project: "Checkout", estimate: 1 }), // 0.25 days
  issue(2, { started: "2026-11-01T09:00:00Z", completed: "2026-11-04T09:00:00Z", project: "Checkout", estimate: 3 }), // 3 days
  issue(3, { started: "2026-10-20T09:00:00Z", completed: "2026-11-05T09:00:00Z", project: "Billing" }), // 16 days
  issue(4, { completed: "2026-11-05T23:30:00Z" }), // no start, no project; 23:30 UTC is still 5 Nov in London (GMT)
  issue(5, { completed: "2026-11-06T09:00:00Z", canceled: "2026-11-06T09:00:00Z" }), // cancelled: never counted
  issue(6, { started: "2026-10-01T09:00:00Z", completed: "2026-10-10T09:00:00Z", project: "Checkout" }), // October
  issue(7, { started: "2026-11-10T09:00:00Z", project: "Checkout" }), // open
  merged(10, "2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z"), // half an hour
  merged(11, "2026-11-03T09:00:00Z", "2026-11-05T09:00:00Z"), // 48 hours
  merged(12, "2026-11-11T09:00:00Z"), // still open
  { source: "github", id: "acme/api#3", repo: "acme/api", number: 3, title: "Someone's", role: "reviewed", reviewed_at: "2026-11-04T10:00:00Z", merged: "2026-11-04T11:00:00Z" } as WorkItem,
  // Someone else's that the owner merged: Code counts it, the headline doesn't.
  { source: "github", id: "acme/api#4:merged", repo: "acme/api", number: 4, title: "Theirs, merged by the owner", role: "merged", merged: "2026-11-06T11:00:00Z" } as WorkItem,
  issue(8, { started: "2025-03-01T09:00:00Z", completed: "2025-03-04T09:00:00Z", project: "Search" }),
];

test("Shipped by day: issues closed and own PRs merged, in the owner's day; cancelled and reviewed-only left out", () => {
  const by = shippedByDay(ITEMS, TZ);
  assert.equal(by.get("2026-11-02"), 2);
  assert.equal(by.get("2026-11-05"), 3);
  assert.equal(by.get("2026-11-04"), 1, "issue 2 only: the reviewed PR is someone else's merge");
  assert.equal(by.get("2026-11-06"), undefined);
  // Late evening in New York is the next day in London.
  assert.equal(shippedByDay([issue(9, { completed: "2026-11-06T03:00:00Z" })], "America/New_York").get("2026-11-05"), 1);
});

test("Cycle time and open to merge: a median and plain buckets", () => {
  const c = cycleTimes(ITEMS, "2026-11-01", "2026-11-12", TZ)!;
  assert.equal(c.n, 3, "issue 4 has no start; 5 is cancelled; 6 is October");
  assert.equal(c.median, 3);
  assert.deepEqual(c.buckets.map((b) => b.count), [1, 0, 1, 0, 1, 0]);
  const m = mergeTimes(ITEMS, "2026-11-01", "2026-11-12", TZ)!;
  assert.equal(m.n, 2);
  assert.equal(m.median, 24.3);
  assert.deepEqual(m.buckets.map((b) => b.count), [1, 0, 0, 1, 0, 0]);
  assert.equal(cycleTimes([], "2026-11-01", "2026-11-12", TZ), null);
});

test("Projects: ranked by issues closed, then points; no project has its own row", () => {
  assert.deepEqual(projectsIn(ITEMS, "2026-11-01", "2026-11-12", TZ), [
    { name: "Checkout", issues_closed: 2, points: 4 },
    { name: "Billing", issues_closed: 1, points: 0 },
    { name: "No project", issues_closed: 1, points: 0 },
  ]);
});

test("Periods and the span before: so far against as many days", () => {
  const periods = workPeriods(ITEMS, "2026-11-12", TZ);
  assert.deepEqual(periods.map((p) => p.id), ["month", "quarter", "year", "2025"]);
  assert.deepEqual(previousSpan(periods[0]), { from: "2026-10-01", to: "2026-10-12", label: "October" });
  assert.deepEqual(previousSpan(periods[1]), { from: "2026-07-01", to: "2026-08-12", label: "last quarter" });
  assert.deepEqual(previousSpan(periods[3]), { from: "2024-01-01", to: "2024-12-31", label: "2024" });
  // 31 March against February: cut at February's end.
  assert.deepEqual(previousSpan({ id: "month", kind: "month", label: "This month", from: "2026-03-01", to: "2026-03-31" }), { from: "2026-02-01", to: "2026-02-28", label: "February" });
});

test("The year of days: whole weeks to this one, today's later days empty", () => {
  const p = workPeriods(ITEMS, "2026-11-12", TZ)[0];
  const h = heatYear(ITEMS, p, "2026-11-12", TZ);
  assert.equal(h.days.length % 7, 0);
  assert.equal(new Date(`${h.days[0].date}T12:00:00Z`).getUTCDay(), 1, "starts on a Monday");
  assert.equal(h.days.at(-1)!.date, "2026-11-15");
  assert.deepEqual(h.days.filter((d) => d.ahead).map((d) => d.date), ["2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(h.max, 3);
  assert.equal(h.shipped_days, 4, "2, 4 and 5 Nov and 10 Oct; March 2025 is more than a year back");
  const past = heatYear(ITEMS, workPeriods(ITEMS, "2026-11-12", TZ)[3], "2026-11-12", TZ);
  assert.equal(past.days.find((d) => d.date === "2025-03-04")?.count, 1);
  assert.ok(past.days.filter((d) => d.date < "2025-01-01").every((d) => d.ahead));
});

test("The page: headline against the span before, Code only with GitHub, open blockers first", () => {
  const notes: WorkNote[] = [
    { id: "n1", title: "Shipped the card form", kind: "shipped", open: false, date: "2026-11-05" },
    { id: "n2", title: "Blocked on the payments sandbox", kind: "stuck", open: true, date: "2026-11-01" },
    { id: "n3", title: "Decided to drop IE", kind: "decided", open: false, date: "2026-11-07" },
    { id: "n4", title: "Blocked on review", kind: "stuck", open: false, date: "2026-11-08" },
  ];
  const d = workPage({ items: ITEMS, notes, today: "2026-11-12", tz: TZ });
  assert.deepEqual(d.count, { issues_closed: 4, prs_merged: 2 });
  assert.deepEqual(d.previous, { issues_closed: 1, prs_merged: 0, label: "October" });
  assert.equal(d.days, 3);
  assert.deepEqual(d.code, { opened: 3, merged: 2, merged_for_others: 1, reviewed: 1, open_now: 1, repos: [{ repo: "acme/app", merged: 2 }] });
  assert.deepEqual(d.notes.map((n) => n.id), ["n2", "n4", "n3", "n1"]);
  const linearOnly = workPage({ items: ITEMS.filter((i) => i.source === "linear"), notes: [], today: "2026-11-12", tz: TZ });
  assert.equal(linearOnly.code, null);
  assert.equal(workPage({ items: [], notes: [], today: "2026-11-12", tz: TZ, connected: { github: true } }).code?.merged, 0);
  assert.equal(workPage({ items: [], notes: [], today: "2026-11-12", tz: TZ }).has_work, false);
  // No history that far back: no comparison.
  assert.equal(workPage({ items: [ITEMS[0]], notes: [], today: "2026-11-12", tz: TZ }).previous, null);
});

test("A project's sheet: the last 12 months, open first, then the latest closed", () => {
  const p = projectDetail(ITEMS, "Checkout", "2026-11-12", TZ)!;
  assert.equal(p.issues_closed, 3);
  assert.equal(p.points, 4);
  assert.equal(p.first, "2026-10-10");
  assert.equal(p.last, "2026-11-04");
  assert.equal(p.months.length, 12);
  assert.deepEqual(p.months.slice(-2), [{ from: "2026-10-01", count: 1 }, { from: "2026-11-01", count: 2 }]);
  assert.deepEqual(p.issues.map((i) => i.identifier), ["ENG-7", "ENG-2", "ENG-1", "ENG-6"]);
  assert.equal(projectDetail(ITEMS, "Nope", "2026-11-12", TZ), null);
});

test("Work activity notes: shipped, decided or stuck, and a blocker stays open until it's cleared", () => {
  assert.equal(noteKind({ title: "Blocked on the payments sandbox" }), "stuck");
  assert.equal(noteKind({ title: "Sandbox access", tags: ["blocked", "Checkout"] }), "stuck");
  assert.equal(noteKind({ title: "We decided to drop IE" }), "decided");
  assert.equal(noteKind({ title: "Card form", tags: ["decision"] }), "decided");
  assert.equal(noteKind({ title: "Shipped the card form" }), "shipped");
  assert.equal(noteOpen({ title: "Blocked on sandbox" }), true);
  assert.equal(noteOpen({ title: "Blocked on sandbox", tags: ["resolved"] }), false);
  assert.equal(noteOpen({ title: "Sandbox", body: "Now unblocked: access came through." }), false);
  assert.deepEqual(orderNotes([]), []);
});
