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
 *    (each item an issue with pull_request.merged_at), or a bare list. No
 *    results may come back as items: null. The author may be user.login,
 *    author.login or a plain login, and the link html_url or url;
 *    pull_request_read get_reviews answers a list of reviews, each with
 *    user.login, state and submitted_at; get answers the PR with merged_by
 *    as a login (recorded 12 Nov) or, as the REST API has it, {login}.
 */
import type { WorkIssue, WorkPr } from "../../../lib/work";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** A key that reads as a field name ("total_count", "items"); anything else (a repo, a login) is only counted. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

function fieldList(o: Obj): string {
  const keys = Object.keys(o);
  const shown = keys.filter((k) => FIELD.test(k)).sort().slice(0, 15);
  const rest = keys.length - shown.length;
  if (!shown.length) return keys.length ? `${keys.length} unnamed fields` : "no fields";
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return isObj(v) ? "an object" : `a ${typeof v}`;
}

/**
 * What a reply looked like, by field names and kinds only, never a value: it
 * goes into the run's error, which the owner reads, and a log line. For
 * example "an object with fields: incomplete_results, items, total_count;
 * items is null".
 */
export function describeShape(body: unknown): string {
  if (Array.isArray(body)) {
    if (!body.length) return "an empty list";
    const first = body[0];
    return `a list of ${body.length}, the first ${isObj(first) ? `with fields: ${fieldList(first)}` : kindOf(first)}`;
  }
  if (!isObj(body)) return kindOf(body);
  const notes: string[] = [];
  for (const k of Object.keys(body).filter((k) => FIELD.test(k)).sort()) {
    const v = body[k];
    if (v === null) notes.push(`${k} is null`);
    else if (Array.isArray(v)) notes.push(`${k} is ${describeShape(v)}`);
    if (notes.length === 3) break;
  }
  return `an object with fields: ${fieldList(body)}${notes.length ? `; ${notes.join("; ")}` : ""}`;
}

/** A tool answered in a shape the sync doesn't know: the account fails with this, nothing is stored. */
export class ShapeUnknown extends Error {
  /** The reply's shape (describeShape), when there was a reply to describe. */
  readonly detail?: string;
  constructor(service: string, tool: string, detail?: string) {
    super(`${service} answered ${tool} in a way Athena doesn't recognise, so nothing was counted. Its server may have changed.${detail ? ` It sent ${detail}.` : ""}`);
    this.name = "ShapeUnknown";
    this.detail = detail;
  }
}
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
    throw new ShapeUnknown(service, tool, `text that isn't JSON (${text.length} characters)`);
  }
}

// ---------- Linear ----------

/** The owner's own Linear user id, from get_user {query: "me"}. */
export function linearMe(text: string): { id: string } {
  const body = json(text, "Linear", "get_user");
  const o = isObj(body) && isObj(body.user) ? body.user : body;
  const id = isObj(o) ? str(o.id) : undefined;
  if (!id) throw new ShapeUnknown("Linear", "get_user", describeShape(body));
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
  if (!Array.isArray(list)) throw new ShapeUnknown("Linear", "list_issues", describeShape(body));
  const issues: WorkIssue[] = [];
  let newest: string | undefined;
  for (const raw of list) {
    if (!isObj(raw)) throw new ShapeUnknown("Linear", "list_issues", describeShape(body));
    const id = str(raw.id);
    const title = str(raw.title);
    if (!id || !title) throw new ShapeUnknown("Linear", "list_issues", `an issue with fields: ${fieldList(raw)}`);
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
  if (!login) throw new ShapeUnknown("GitHub", "get_me", describeShape(body));
  return { login };
}

/**
 * owner/repo and number from a PR's link ("https://github.com/o/r/pull/12"),
 * which GitHub's servers put in html_url, pull_request.html_url or url; else
 * from the API's own url (https://api.github.com/repos/o/r/issues/12), or a
 * repository ("o/r", or {full_name}) beside a number.
 */
function prPlace(o: Obj): { repo: string; number: number; url: string } | null {
  const links = [str(o.html_url), isObj(o.pull_request) ? str((o.pull_request as Obj).html_url) : undefined, str(o.url)];
  for (const url of links) {
    const m = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url) : null;
    if (m) return { repo: m[1], number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` };
  }
  const api = str(o.url) ?? str(o.repository_url);
  const a = api ? /repos\/([^/]+\/[^/]+?)(?:\/(?:issues|pulls)\/(\d+))?\/?$/.exec(api) : null;
  const named = str(o.repository) ?? (isObj(o.repository) ? str((o.repository as Obj).full_name) ?? str((o.repository as Obj).nameWithOwner) : undefined);
  const repo = a?.[1] ?? (named && /^[^/\s]+\/[^/\s]+$/.test(named) ? named : undefined);
  const n = num(o.number) ?? (a?.[2] ? Number(a[2]) : undefined);
  if (repo && n) return { repo, number: n, url: `https://github.com/${repo}/pull/${n}` };
  return null;
}

/** The PR author's login, lower-cased: user.login, author.login, or either as a plain login. */
function prAuthor(o: Obj): string | undefined {
  for (const who of [o.user, o.author]) {
    const login = str(who) ?? (isObj(who) ? str((who as Obj).login) : undefined);
    if (login) return login.toLowerCase();
  }
  return undefined;
}

/**
 * One page of search_pull_requests. As "opened", only PRs whose author is the
 * owner; as "reviewed", only PRs someone else opened (the owner's review is
 * the activity, and the author isn't kept). Returns what's kept and how many
 * the page held, for paging.
 */
export function githubPrs(text: string, me: { login: string }, role: WorkPr["role"]): { prs: WorkPr[]; read: number; total?: number } {
  const body = json(text, "GitHub", "search_pull_requests");
  // A search with no results can come back as items: null (how Go encodes an empty list) or with no items at all.
  const none = isObj(body) && (body.items === null || body.items === undefined) && (num(body.total_count) ?? 0) === 0 && ("total_count" in body || "items" in body);
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.items) ? body.items : none ? [] : null;
  if (!Array.isArray(list)) throw new ShapeUnknown("GitHub", "search_pull_requests", describeShape(body));
  const mine = me.login.toLowerCase();
  const prs: WorkPr[] = [];
  for (const raw of list) {
    if (!isObj(raw)) throw new ShapeUnknown("GitHub", "search_pull_requests", describeShape(body));
    const place = prPlace(raw);
    const title = str(raw.title);
    const author = prAuthor(raw);
    if (!place || !title || !author) {
      const missing = [!place && "a link or repository and number", !title && "a title", !author && "an author"].filter(Boolean).join(", ");
      throw new ShapeUnknown("GitHub", "search_pull_requests", `a pull request without ${missing}, with fields: ${fieldList(raw)}`);
    }
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
  if (!Array.isArray(list)) throw new ShapeUnknown("GitHub", "pull_request_read", describeShape(body));
  const mine = me.login.toLowerCase();
  let others = 0;
  let first: string | undefined;
  for (const r of list) {
    if (!isObj(r)) throw new ShapeUnknown("GitHub", "pull_request_read", describeShape(body));
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
  if (!isObj(body) || (!("merged_by" in body) && !("merged" in body) && !("merged_at" in body))) throw new ShapeUnknown("GitHub", "pull_request_read", describeShape(body));
  const by = str(body.merged_by) ?? (isObj(body.merged_by) ? str((body.merged_by as Obj).login) : undefined);
  const at = time(body.merged_at);
  return by && by.toLowerCase() === me.login.toLowerCase() && at ? { mine: true, at } : { mine: false };
}

/** Drop undefined fields, so the stored value (and its comparison) is stable. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
