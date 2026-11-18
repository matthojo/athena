/**
 * Reading the work accounts' own tools for the work sync (work-sync.ts),
 * with no model in between. Each parser takes a tool's text as callTool gave
 * it and returns only the owner's own activity, in the shape lib/work.ts
 * stores. Anything about another person (an issue assigned to a teammate, a
 * PR someone else opened that the owner didn't review) is dropped here,
 * before it can reach storage.
 *
 * Defensive by design: a field that's missing is left out, never guessed. A
 * reply whose shape isn't one Athena knows throws ShapeUnknown, so the run
 * fails that account with a plain error rather than storing something wrong.
 *
 * Shapes (fixtures in fixtures/work-tools.ts):
 *  - Linear's hosted server: get_user {query: "me"} answers the user as an
 *    object; list_issues answers {issues: [...], hasNextPage, cursor}, each
 *    issue with assignee and assigneeId, project, team, status, createdAt,
 *    startedAt, completedAt and estimate ({value, name} or a number).
 *  - GitHub's hosted server: get_me answers {login, ...};
 *    search_pull_requests answers the search API's {total_count, items}
 *    (each item an issue with pull_request.merged_at), or a bare list;
 *    pull_request_read get_reviews answers a list of reviews, each with
 *    user.login, state and submitted_at; get answers the PR with merged_by
 *    as a login (recorded 12 Nov) or, as the REST API has it, {login}.
 */
import type { WorkIssue, WorkPr } from "../../../lib/work";

/** A tool answered in a shape the sync doesn't know: the account fails with this, nothing is stored. */
export class ShapeUnknown extends Error {
  constructor(service: string, tool: string) {
    super(`${service} answered ${tool} in a way Athena doesn't recognise, so nothing was counted. Its server may have changed.`);
    this.name = "ShapeUnknown";
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** An ISO time, normalised; anything that isn't one is left out. */
const time = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
/** A name from "Name" or {name: "Name"}. */
const nameOf = (v: unknown): string | undefined => str(v) ?? (isObj(v) ? str(v.name) ?? str(v.displayName) ?? str(v.key) : undefined);
/** An id from {id} beside a name, or a separate ...Id field. */
const idOf = (o: Obj, field: string): string | undefined => str(o[`${field}Id`]) ?? (isObj(o[field]) ? str((o[field] as Obj).id) : undefined);

function json(text: string, service: string, tool: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ShapeUnknown(service, tool);
  }
}

// ---------- Linear ----------

/** The owner's own Linear user id, from get_user {query: "me"}. */
export function linearMe(text: string): { id: string } {
  const body = json(text, "Linear", "get_user");
  const o = isObj(body) && isObj(body.user) ? body.user : body;
  const id = isObj(o) ? str(o.id) : undefined;
  if (!id) throw new ShapeUnknown("Linear", "get_user");
  return { id };
}

/**
 * One page of list_issues: the owner's issues only (assigned to them), and
 * where the next page starts. An issue assigned to someone else, or to no
 * one, is never returned, whatever the tool sent.
 */
export function linearIssues(text: string, me: { id: string }): { issues: WorkIssue[]; read: number; next?: string; newest?: string } {
  const body = json(text, "Linear", "list_issues");
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.issues) ? body.issues : isObj(body) && isObj(body.issues) && Array.isArray((body.issues as Obj).nodes) ? (body.issues as Obj).nodes : null;
  if (!Array.isArray(list)) throw new ShapeUnknown("Linear", "list_issues");
  const issues: WorkIssue[] = [];
  let newest: string | undefined;
  for (const raw of list) {
    if (!isObj(raw)) throw new ShapeUnknown("Linear", "list_issues");
    const id = str(raw.id);
    const title = str(raw.title);
    if (!id || !title) throw new ShapeUnknown("Linear", "list_issues");
    const updated = time(raw.updatedAt);
    if (updated && (!newest || updated > newest)) newest = updated;
    // Own activity only: the assignee must be the owner, by id.
    if (idOf(raw, "assignee") !== me.id) continue;
    const estimate = isObj(raw.estimate) ? num((raw.estimate as Obj).value) : num(raw.estimate);
    const status = isObj(raw.state) ? raw.state : raw.status;
    issues.push(
      clean({
        source: "linear",
        id,
        identifier: str(raw.identifier),
        title,
        url: str(raw.url),
        project: nameOf(raw.project),
        project_id: idOf(raw, "project"),
        team: nameOf(raw.team),
        state: nameOf(status),
        state_type: isObj(status) ? str((status as Obj).type) : str(raw.statusType),
        created: time(raw.createdAt),
        started: time(raw.startedAt),
        completed: time(raw.completedAt),
        canceled: time(raw.canceledAt),
        updated,
        estimate,
      }),
    );
  }
  const next = isObj(body) && body.hasNextPage !== false ? str(body.cursor) ?? str(body.nextCursor) ?? (isObj(body.pageInfo) && (body.pageInfo as Obj).hasNextPage ? str((body.pageInfo as Obj).endCursor) : undefined) : undefined;
  return { issues, read: list.length, ...(next ? { next } : {}), ...(newest ? { newest } : {}) };
}

// ---------- GitHub ----------

/** The owner's GitHub login, from get_me. */
export function githubMe(text: string): { login: string } {
  const body = json(text, "GitHub", "get_me");
  const login = isObj(body) ? str(body.login) : undefined;
  if (!login) throw new ShapeUnknown("GitHub", "get_me");
  return { login };
}

/** owner/repo and number from a PR's html_url ("https://github.com/o/r/pull/12"). */
function prPlace(o: Obj): { repo: string; number: number; url: string } | null {
  const url = str(o.html_url) ?? (isObj(o.pull_request) ? str((o.pull_request as Obj).html_url) : undefined);
  const m = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url) : null;
  if (m) return { repo: m[1], number: Number(m[2]), url: url! };
  // The API's own url, as a fallback: https://api.github.com/repos/o/r/issues/12
  const api = str(o.url) ?? str(o.repository_url);
  const a = api ? /repos\/([^/]+\/[^/]+)(?:\/(?:issues|pulls)\/(\d+))?/.exec(api) : null;
  const n = num(o.number) ?? (a?.[2] ? Number(a[2]) : undefined);
  if (a && n) return { repo: a[1], number: n, url: `https://github.com/${a[1]}/pull/${n}` };
  return null;
}

/**
 * One page of search_pull_requests. As "opened", only PRs whose author is the
 * owner; as "reviewed", only PRs someone else opened (the owner's review is
 * the activity, and the author isn't kept). Returns what's kept and how many
 * the page held, for paging.
 */
export function githubPrs(text: string, me: { login: string }, role: WorkPr["role"]): { prs: WorkPr[]; read: number; total?: number } {
  const body = json(text, "GitHub", "search_pull_requests");
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.items) ? body.items : null;
  if (!Array.isArray(list)) throw new ShapeUnknown("GitHub", "search_pull_requests");
  const mine = me.login.toLowerCase();
  const prs: WorkPr[] = [];
  for (const raw of list) {
    if (!isObj(raw)) throw new ShapeUnknown("GitHub", "search_pull_requests");
    const place = prPlace(raw);
    const title = str(raw.title);
    const author = isObj(raw.user) ? str((raw.user as Obj).login)?.toLowerCase() : undefined;
    if (!place || !title || !author) throw new ShapeUnknown("GitHub", "search_pull_requests");
    // Opened: the owner's own. Reviewed and merged: someone else's PR, where the owner's review or merge is the activity.
    if (role === "opened" ? author !== mine : author === mine) continue;
    const merged = time(raw.merged_at) ?? (isObj(raw.pull_request) ? time((raw.pull_request as Obj).merged_at) : undefined);
    prs.push(
      clean({
        source: "github",
        // A PR the owner merged for someone else is its own item, beside a review of the same PR.
        id: role === "merged" ? `${place.repo}#${place.number}:merged` : `${place.repo}#${place.number}`,
        repo: place.repo,
        number: place.number,
        title,
        url: place.url,
        role,
        opened: time(raw.created_at),
        merged,
        closed: time(raw.closed_at),
        updated: time(raw.updated_at),
        draft: raw.draft === true ? true : undefined,
      }),
    );
  }
  return { prs, read: list.length, ...(isObj(body) && num(body.total_count) !== undefined ? { total: num(body.total_count) } : {}) };
}

/**
 * pull_request_read get_reviews, reduced to what the owner did or got: how
 * many reviews other people left (a count, no names) and when the owner
 * first reviewed it. Pending (unsubmitted) reviews don't count.
 */
export function githubReviews(text: string, me: { login: string }): { others: number; mine_first?: string } {
  const body = json(text, "GitHub", "pull_request_read");
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.reviews) ? body.reviews : null;
  if (!Array.isArray(list)) throw new ShapeUnknown("GitHub", "pull_request_read");
  const mine = me.login.toLowerCase();
  let others = 0;
  let first: string | undefined;
  for (const r of list) {
    if (!isObj(r)) throw new ShapeUnknown("GitHub", "pull_request_read");
    if (str(r.state)?.toUpperCase() === "PENDING") continue;
    const who = isObj(r.user) ? str((r.user as Obj).login)?.toLowerCase() : undefined;
    const at = time(r.submitted_at);
    if (who === mine) {
      if (at && (!first || at < first)) first = at;
    } else others++;
  }
  return { others, ...(first ? { mine_first: first } : {}) };
}

/** pull_request_read get: did the owner merge it, and when. Unknown shape fails; a PR not merged says so. */
export function githubMergedBy(text: string, me: { login: string }): { mine: boolean; at?: string } {
  const body = json(text, "GitHub", "pull_request_read");
  if (!isObj(body) || (!("merged_by" in body) && !("merged" in body) && !("merged_at" in body))) throw new ShapeUnknown("GitHub", "pull_request_read");
  const by = str(body.merged_by) ?? (isObj(body.merged_by) ? str((body.merged_by as Obj).login) : undefined);
  const at = time(body.merged_at);
  return by && by.toLowerCase() === me.login.toLowerCase() && at ? { mine: true, at } : { mine: false };
}

/** Drop undefined fields, so the stored value (and its comparison) is stable. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
