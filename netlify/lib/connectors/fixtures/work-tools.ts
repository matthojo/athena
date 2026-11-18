/**
 * Replies from the work accounts' own tools, for work-parse.ts and the work
 * sync's tests.
 *
 * GitHub: recorded 12 Nov 2026 from GitHub's hosted MCP server (get_me,
 * list_pull_requests with fields, pull_request_read get_reviews) and from the
 * REST search endpoint that its search_pull_requests marshals, trimmed to the
 * fields the sync reads plus a few it must ignore. Personal fields (email,
 * bio) are replaced. Logins, repos and titles are made up apart from their
 * shape.
 *
 * Linear: list_issues and get_user as Linear's hosted server (mcp.linear.app)
 * documents them: {issues, hasNextPage, cursor}, flat names beside ...Id
 * fields. Not recorded from a live account in this session; the parser
 * also takes the GraphQL-style nesting ({assignee: {id, name}}).
 */

export const ME = "sam-owner";

// ---------- GitHub ----------

export const GITHUB_ME = JSON.stringify({ login: ME, id: 367517, profile_url: `https://github.com/${ME}`, avatar_url: "https://avatars.githubusercontent.com/u/367517?v=4", details: { name: "Sam Owner", company: "", location: "", email: "sam@example.com", public_repos: 65, created_at: "2010-08-17T17:48:51Z" } });

const user = (login: string, id: number) => ({ login, id, node_id: "MDQ6VXNlcjM2NzUxNw==", avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`, url: `https://api.github.com/users/${login}`, html_url: `https://github.com/${login}`, type: "User", site_admin: false });

/** One search item, as the search API (and search_pull_requests) gives it. */
export function searchItem(o: { repo: string; number: number; title: string; author: string; created: string; updated: string; merged?: string | null; closed?: string | null; draft?: boolean }) {
  return {
    url: `https://api.github.com/repos/${o.repo}/issues/${o.number}`,
    repository_url: `https://api.github.com/repos/${o.repo}`,
    html_url: `https://github.com/${o.repo}/pull/${o.number}`,
    id: 6352413000 + o.number,
    node_id: "PR_kwDOVjPwgM8AAAABOrBfaw",
    number: o.number,
    title: o.title,
    user: user(o.author, o.author === ME ? 367517 : 900000 + o.number),
    labels: [],
    state: o.closed ? "closed" : "open",
    locked: false,
    assignees: [],
    milestone: null,
    comments: 1,
    created_at: o.created,
    updated_at: o.updated,
    closed_at: o.closed ?? null,
    assignee: null,
    author_association: "OWNER",
    draft: o.draft ?? false,
    pull_request: { url: `https://api.github.com/repos/${o.repo}/pulls/${o.number}`, html_url: `https://github.com/${o.repo}/pull/${o.number}`, diff_url: `https://github.com/${o.repo}/pull/${o.number}.diff`, patch_url: `https://github.com/${o.repo}/pull/${o.number}.patch`, merged_at: o.merged ?? null },
    body: "A long description the sync never keeps.",
    reactions: { total_count: 0, "+1": 0, "-1": 0 },
    timeline_url: `https://api.github.com/repos/${o.repo}/issues/${o.number}/timeline`,
  };
}

export const searchReply = (items: ReturnType<typeof searchItem>[], total = items.length) => JSON.stringify({ total_count: total, incomplete_results: false, items });

/** list_pull_requests with fields, as GitHub's server answers it (minimal users). */
export const GITHUB_LIST_MINIMAL = JSON.stringify([
  { closed_at: "2026-11-12T14:55:06Z", created_at: "2026-11-12T14:52:55Z", html_url: "https://github.com/acme/app/pull/211", merged: true, merged_at: "2026-11-12T14:55:05Z", number: 211, state: "closed", title: "Home's headline follows the day", updated_at: "2026-11-12T14:55:06Z", user: { avatar_url: "https://avatars.githubusercontent.com/u/367517?v=4", id: 367517, login: ME, profile_url: `https://github.com/${ME}` } },
  { closed_at: null, created_at: "2026-11-11T09:00:00Z", html_url: "https://github.com/acme/app/pull/208", merged: false, merged_at: null, number: 208, state: "open", title: "A teammate's change", updated_at: "2026-11-12T10:00:00Z", user: { avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", id: 1, login: "priya-teammate", profile_url: "https://github.com/priya-teammate" } },
]);

/** pull_request_read get, as GitHub's server answered it on 12 Nov (merged_by a login), body cut. */
export const prGet = (o: { merged_by?: unknown; merged_at?: string | null; merged?: boolean }) =>
  JSON.stringify({ number: 211, title: "Home's headline follows the day", body: "A long description.", state: "closed", draft: false, merged: o.merged ?? true, mergeable_state: "unknown", html_url: "https://github.com/acme/app/pull/211", user: { login: ME, id: 367517, profile_url: `https://github.com/${ME}`, avatar_url: "https://avatars.githubusercontent.com/u/367517?v=4" }, merged_by: o.merged_by, head: { ref: "claude/home-headline", sha: "1d7c1ae6", repo: { full_name: "acme/app" } }, base: { ref: "main", sha: "176e4b74", repo: { full_name: "acme/app" } }, additions: 90, deletions: 3, changed_files: 3, commits: 1, comments: 1, created_at: "2026-11-12T14:52:55Z", updated_at: "2026-11-12T14:55:06Z", closed_at: "2026-11-12T14:55:06Z", merged_at: o.merged_at === undefined ? "2026-11-12T14:55:05Z" : o.merged_at });

/** pull_request_read get_reviews: a PR with none answers []. */
export const reviewsReply = (rs: Array<{ login: string; state: string; at?: string }>) =>
  JSON.stringify(rs.map((r, i) => ({ id: 2000 + i, node_id: "PRR_kwDO", user: user(r.login, r.login === ME ? 367517 : 1000 + i), body: "", state: r.state, html_url: `https://github.com/acme/app/pull/1#pullrequestreview-${2000 + i}`, ...(r.at ? { submitted_at: r.at } : {}), commit_id: "abc123", author_association: "MEMBER" })));

// ---------- Linear ----------

export const LINEAR_ME_ID = "5b0e4f3a-0000-4000-8000-00000000000a";
export const TEAMMATE_ID = "5b0e4f3a-0000-4000-8000-00000000000b";

export const LINEAR_ME = JSON.stringify({ id: LINEAR_ME_ID, name: "Sam Owner", email: "sam@example.com", displayName: "sam", isAdmin: false, isMe: true, active: true, createdAt: "2024-01-03T10:00:00.000Z", url: "https://linear.app/acme/profiles/sam" });

/** One issue as list_issues gives it. */
export function linearIssue(o: { n: number; title: string; assigneeId?: string | null; project?: string; team?: string; status?: string; created: string; started?: string; completed?: string; updated?: string; estimate?: number }) {
  const assignee = o.assigneeId === undefined ? LINEAR_ME_ID : o.assigneeId;
  return {
    id: `0c1d2e3f-0000-4000-8000-${String(o.n).padStart(12, "0")}`,
    identifier: `ENG-${o.n}`,
    title: o.title,
    description: "What needs doing, in the teammate's own words. Never stored.",
    priority: { value: 2, name: "High" },
    url: `https://linear.app/acme/issue/ENG-${o.n}/slug`,
    gitBranchName: `sam/eng-${o.n}`,
    createdAt: o.created,
    updatedAt: o.updated ?? o.completed ?? o.started ?? o.created,
    archivedAt: null,
    startedAt: o.started ?? null,
    completedAt: o.completed ?? null,
    canceledAt: null,
    dueDate: null,
    estimate: o.estimate === undefined ? null : { value: o.estimate, name: `${o.estimate} Points` },
    status: o.status ?? (o.completed ? "Done" : o.started ? "In Progress" : "Todo"),
    labels: ["Feature"],
    attachments: [],
    documents: [],
    createdBy: "Priya Teammate",
    createdById: TEAMMATE_ID,
    assignee: assignee === LINEAR_ME_ID ? "Sam Owner" : assignee ? "Priya Teammate" : null,
    assigneeId: assignee,
    project: o.project ?? "Checkout",
    projectId: `p-${(o.project ?? "Checkout").toLowerCase()}`,
    team: o.team ?? "Engineering",
    teamId: "t-eng",
  };
}

export const linearReply = (issues: ReturnType<typeof linearIssue>[], next?: string) => JSON.stringify({ issues, hasNextPage: !!next, ...(next ? { cursor: next } : {}) });
